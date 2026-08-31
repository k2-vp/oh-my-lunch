import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLunchServer, listen } from "./index.ts";
import {
  CORRUPT_STATE_DIAGNOSTIC,
  StateConflictError,
  createStateStore,
  type StateDiagnostic,
  type StateSnapshot,
} from "./state.ts";

const stateModuleUrl = pathToFileURL(resolve("server/state.ts")).href;
const serverModuleUrl = pathToFileURL(resolve("server/index.ts")).href;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function localNoon(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12);
}

async function stateFixture(now: Date): Promise<{
  readonly directory: string;
  readonly file: string;
  readonly setNow: (next: Date) => void;
  readonly store: ReturnType<typeof createStateStore>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "lunch-plinko-state-"));
  const file = join(directory, "state.json");
  let clock = now;
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  return {
    directory,
    file,
    setNow(next) {
      clock = next;
    },
    store: createStateStore({ file, now: () => clock }),
  };
}

function emptyState(week: string, date: string): StateSnapshot {
  return {
    week,
    date,
    winners: {},
    rejectedToday: null,
    redropUsed: false,
  };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function startServerProcess(stateFile: string): Promise<{
  readonly child: ChildProcess;
  readonly port: number;
}> {
  const script = `
    const { createLunchServer, listen } = await import(process.argv[1]);
    const server = createLunchServer({ stateFile: process.argv[2] });
    await listen(server, 0);
    process.send?.({ port: server.address().port });
    process.on("message", (message) => {
      if (message === "close") {
        server.close((error) => process.exit(error ? 1 : 0));
      }
    });
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script, serverModuleUrl, stateFile],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  cleanups.push(() => killChild(child));
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. ${stderr}`)), 5_000);
    child.once("message", (message: unknown) => {
      if (
        typeof message === "object"
        && message !== null
        && "port" in message
        && typeof message.port === "number"
      ) {
        clearTimeout(timeout);
        resolvePort(message.port);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before listening (${code ?? signal}). ${stderr}`));
    });
  });
  return { child, port };
}

async function stopServerProcess(child: ChildProcess): Promise<void> {
  const exited = once(child, "exit");
  child.send("close");
  const [code, signal] = await exited;
  if (code !== 0) {
    throw new Error(`Server did not stop cleanly (${String(code ?? signal)}).`);
  }
}

describe("the weekly state store", () => {
  it("creates an empty record on a fresh install", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));

    await expect(fixture.store.read()).resolves.toEqual(emptyState("2026-W35", "2026-08-24"));
    await expect(readFile(fixture.file, "utf8").then(JSON.parse)).resolves.toEqual(
      emptyState("2026-W35", "2026-08-24"),
    );
  });

  it("preserves the record and today's fields during the same local day", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));

    await fixture.store.acceptWinner("Alpha");
    await fixture.store.recordRedrop("Alpha");

    await expect(fixture.store.read()).resolves.toEqual({
      week: "2026-W35",
      date: "2026-08-24",
      winners: { "2026-08-24": "Alpha" },
      rejectedToday: "Alpha",
      redropUsed: true,
    });
  });

  it("clears daily fields but keeps winners on the next local day", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    await fixture.store.acceptWinner("Alpha");
    await fixture.store.recordRedrop("Alpha");

    fixture.setNow(localNoon(2026, 8, 25));

    await expect(fixture.store.read()).resolves.toEqual({
      week: "2026-W35",
      date: "2026-08-25",
      winners: { "2026-08-24": "Alpha" },
      rejectedToday: null,
      redropUsed: false,
    });
  });

  it("clears weekly and daily fields when the ISO week changes", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    await fixture.store.acceptWinner("Alpha");
    await fixture.store.recordRedrop("Alpha");

    fixture.setNow(localNoon(2026, 8, 31));

    await expect(fixture.store.read()).resolves.toEqual(emptyState("2026-W36", "2026-08-31"));
  });

  it("starts a new week on Tuesday after a Monday holiday", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 28));
    await fixture.store.acceptWinner("Friday Place");

    fixture.setNow(localNoon(2026, 9, 1));

    await expect(fixture.store.read()).resolves.toEqual(emptyState("2026-W36", "2026-09-01"));
  });

  it("keeps the record across the ISO year boundary in 2026-W53", async () => {
    const fixture = await stateFixture(localNoon(2026, 12, 28));
    await fixture.store.acceptWinner("Monday Place");

    fixture.setNow(localNoon(2027, 1, 1));

    await expect(fixture.store.read()).resolves.toEqual({
      week: "2026-W53",
      date: "2027-01-01",
      winners: { "2026-12-28": "Monday Place" },
      rejectedToday: null,
      redropUsed: false,
    });
  });

  it("makes repeated winner writes idempotent and rejects unrelated winners", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));

    const first = await fixture.store.acceptWinner("Alpha");
    await expect(fixture.store.acceptWinner("Alpha")).resolves.toEqual(first);
    await expect(fixture.store.acceptWinner("Beta")).rejects.toBeInstanceOf(StateConflictError);
    await expect(fixture.store.read()).resolves.toEqual(first);
  });

  it("allows a recorded re-drop to replace today's accepted winner once", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    await fixture.store.acceptWinner("Alpha");
    await fixture.store.recordRedrop("Alpha");

    await expect(
      fixture.store.acceptWinner("Beta", { completesRedrop: true }),
    ).resolves.toEqual({
      week: "2026-W35",
      date: "2026-08-24",
      winners: { "2026-08-24": "Beta" },
      rejectedToday: "Alpha",
      redropUsed: true,
    });
    await expect(
      fixture.store.acceptWinner("Gamma", { completesRedrop: true }),
    ).rejects.toBeInstanceOf(StateConflictError);
  });

  it("persists the release-valve reset before the next read", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    await fixture.store.acceptWinner("Alpha");
    await fixture.store.recordRedrop("Alpha");

    await expect(fixture.store.resetWeek()).resolves.toEqual(
      emptyState("2026-W35", "2026-08-24"),
    );
    await expect(createStateStore({ file: fixture.file, now: () => localNoon(2026, 8, 24) }).read())
      .resolves.toEqual(emptyState("2026-W35", "2026-08-24"));
  });

  it("preserves corrupt bytes once, names the recovery, and returns fresh state", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    const corruptBytes = "{ this was interrupted\n";
    const diagnostics: StateDiagnostic[] = [];
    await writeFile(fixture.file, corruptBytes, "utf8");
    const store = createStateStore({
      file: fixture.file,
      now: () => localNoon(2026, 8, 24),
      diagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(store.read()).resolves.toEqual(emptyState("2026-W35", "2026-08-24"));

    const recoveryFiles = (await readdir(fixture.directory)).filter((name) =>
      name.startsWith("state.json.corrupt-"),
    );
    expect(recoveryFiles).toHaveLength(1);
    await expect(readFile(join(fixture.directory, recoveryFiles[0] ?? ""), "utf8"))
      .resolves.toBe(corruptBytes);
    expect(diagnostics).toMatchObject([
      {
        name: CORRUPT_STATE_DIAGNOSTIC,
        stateFile: fixture.file,
        recoveryFile: join(fixture.directory, recoveryFiles[0] ?? ""),
      },
    ]);

    await store.read();
    expect((await readdir(fixture.directory)).filter((name) => name.startsWith("state.json.corrupt-")))
      .toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
  });

  it("survives replacement by a new server process", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    const first = await startServerProcess(fixture.file);
    const accepted = await fetch(`http://127.0.0.1:${first.port}/api/state/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winner: "Alpha" }),
    });
    expect(accepted.status).toBe(200);
    await stopServerProcess(first.child);

    const second = await startServerProcess(fixture.file);
    const response = await fetch(`http://127.0.0.1:${second.port}/api/state`);
    const state = (await response.json()) as StateSnapshot;
    expect(response.status).toBe(200);
    expect(Object.values(state.winners)).toEqual(["Alpha"]);
    await stopServerProcess(second.child);
  });

  it("leaves complete JSON when killed after temp-file flush and before rename", async () => {
    const fixture = await stateFixture(localNoon(2026, 8, 24));
    const before = await fixture.store.acceptWinner("Alpha");
    const after: StateSnapshot = {
      ...before,
      rejectedToday: "Alpha",
      redropUsed: true,
    };
    const childScript = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      fs.promises.rename = async () => {
        process.send?.("before-rename");
        await new Promise(() => {});
      };
      syncBuiltinESMExports();
      const { createStateStore } = await import(process.argv[1]);
      const store = createStateStore({
        file: process.argv[2],
        now: () => new Date(2026, 7, 24, 12),
      });
      await store.recordRedrop("Alpha");
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childScript, stateModuleUrl, fixture.file],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    cleanups.push(() => killChild(child));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const message = await new Promise<unknown>((resolveMessage, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out before rename. ${stderr}`)), 5_000);
      child.once("message", (value) => {
        clearTimeout(timeout);
        resolveMessage(value);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (code !== null || signal !== null) {
          clearTimeout(timeout);
          reject(new Error(`Writer exited before rename (${code ?? signal}). ${stderr}`));
        }
      });
    });
    expect(message).toBe("before-rename");
    const temporaryFiles = (await readdir(fixture.directory)).filter((name) =>
      name.startsWith(".state.json.") && name.endsWith(".tmp"),
    );
    expect(temporaryFiles).toHaveLength(1);
    await expect(
      readFile(join(fixture.directory, temporaryFiles[0] ?? ""), "utf8").then(JSON.parse),
    ).resolves.toEqual(after);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const persisted = JSON.parse(await readFile(fixture.file, "utf8")) as StateSnapshot;
    expect([before, after]).toContainEqual(persisted);
  });
});

describe("the state HTTP routes", () => {
  it("read, re-drop, accept, conflict, and reset use the persisted record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lunch-plinko-state-api-"));
    const file = join(directory, "state.json");
    const server = createLunchServer({ stateFile: file });
    await listen(server, 0);
    const address = server.address() as AddressInfo;
    const url = (path: string): string => `http://127.0.0.1:${address.port}${path}`;
    const post = (path: string, body: unknown): Promise<Response> => fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    cleanups.push(async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
      await rm(directory, { force: true, recursive: true });
    });

    const initialResponse = await fetch(url("/api/state"));
    expect(initialResponse.status).toBe(200);
    const initial = (await initialResponse.json()) as StateSnapshot;
    expect(initial.winners).toEqual({});

    expect((await post("/api/state/accept", { winner: "Alpha" })).status).toBe(200);
    expect((await post("/api/state/accept", { winner: "Beta" })).status).toBe(409);
    expect((await post("/api/state/redrop", { rejected: "Alpha" })).status).toBe(200);
    expect((await post("/api/state/accept", {
      winner: "Beta",
      completesRedrop: true,
    })).status).toBe(200);

    const accepted = (await (await fetch(url("/api/state"))).json()) as StateSnapshot;
    expect(accepted.winners[accepted.date]).toBe("Beta");
    expect(accepted.rejectedToday).toBe("Alpha");
    expect(accepted.redropUsed).toBe(true);

    const headResponse = await fetch(url("/api/state"), { method: "HEAD" });
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe("");

    expect((await post("/api/state/reset", {})).status).toBe(200);
    const reset = (await (await fetch(url("/api/state"))).json()) as StateSnapshot;
    expect(reset.winners).toEqual({});
    expect(reset.rejectedToday).toBeNull();
    expect(reset.redropUsed).toBe(false);
  });
});
