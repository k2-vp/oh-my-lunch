import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLunchServer, listen } from "./index.ts";

// Each test gets a real server bound to a random loopback port and a real temp
// restaurants file. No mock stands in for the server, the file, or fetch.
type Running = {
  readonly port: number;
  readonly address: string;
  readonly file: string;
  write(config: unknown): Promise<void>;
  writeRaw(text: string): Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function start(options: { seed?: unknown; withFile?: boolean } = {}): Promise<Running> {
  const directory = await mkdtemp(join(tmpdir(), "lunch-plinko-list-"));
  const file = join(directory, "restaurants.json");

  const write = async (config: unknown): Promise<void> => {
    await writeFile(file, JSON.stringify(config), "utf8");
  };
  const writeRaw = async (text: string): Promise<void> => {
    await writeFile(file, text, "utf8");
  };

  if (options.withFile !== false) {
    await write(options.seed ?? { restaurants: [{ name: "Alpha" }, { name: "Beta" }] });
  }

  const server = createLunchServer({ restaurantsFile: file });
  await listen(server, 0);
  const info = server.address() as AddressInfo;

  cleanups.push(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    await rm(directory, { force: true, recursive: true });
  });

  return { port: info.port, address: info.address, file, write, writeRaw };
}

function get(running: Running, path = "/api/restaurants"): Promise<Response> {
  return fetch(`http://127.0.0.1:${running.port}${path}`);
}

function nonLoopbackIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function connects(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const settle = (result: boolean): void => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

describe("the restaurants endpoint", () => {
  it("returns the list and settings from the file", async () => {
    const running = await start({
      seed: {
        restaurants: [{ name: "Golden Bowl" }, { name: "Taco Cantina" }],
        settings: { mode: "dark" },
      },
    });

    const response = await get(running);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      restaurants: Array<{ name: string }>;
      settings: { mode: string; redropWindowSeconds: number };
    };
    expect(body.restaurants.map((r) => r.name)).toEqual(["Golden Bowl", "Taco Cantina"]);
    expect(body.settings.mode).toBe("dark");
    // Absent settings are filled with documented defaults.
    expect(body.settings.redropWindowSeconds).toBe(90);
  });

  it("reads the file on every request, so an edit needs no restart", async () => {
    const running = await start({ seed: { restaurants: [{ name: "Alpha" }, { name: "Beta" }] } });

    const first = (await (await get(running)).json()) as { restaurants: Array<{ name: string }> };
    expect(first.restaurants.map((r) => r.name)).toEqual(["Alpha", "Beta"]);

    await running.write({ restaurants: [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }] });

    const second = (await (await get(running)).json()) as { restaurants: Array<{ name: string }> };
    expect(second.restaurants.map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("reports a malformed field with a 500 and never an empty list", async () => {
    const running = await start({ seed: { restaurants: [{ name: "Twin" }, { name: "Twin" }] } });

    const response = await get(running);
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error?: { field: string }; restaurants?: unknown };
    expect(body.error?.field).toBe("restaurants[1].name");
    expect(body.restaurants).toBeUndefined();
  });

  it("reports invalid JSON with a 500 and never an empty list", async () => {
    const running = await start({ withFile: false });
    await running.writeRaw("{ not valid json");

    const response = await get(running);
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error?: { field: string }; restaurants?: unknown };
    expect(body.error?.field).toBe("(root)");
    expect(body.restaurants).toBeUndefined();
  });

  it("reports a missing file with a 500 and never an empty list", async () => {
    const running = await start({ withFile: false });

    const response = await get(running);
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error?: { field: string }; restaurants?: unknown };
    expect(body.error?.field).toBe("(file)");
    expect(body.restaurants).toBeUndefined();
  });

  it("answers a HEAD request with headers and no body", async () => {
    const running = await start();

    const response = await fetch(`http://127.0.0.1:${running.port}/api/restaurants`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.text()).toBe("");
  });
});

describe("the loopback binding", () => {
  it("listens on 127.0.0.1", async () => {
    const running = await start();
    expect(running.address).toBe("127.0.0.1");
    expect(await connects("127.0.0.1", running.port)).toBe(true);
  });

  it("refuses a connection through a non-loopback interface", async () => {
    const running = await start();
    const external = nonLoopbackIPv4();
    if (external === null) {
      // No external interface on this host, so binding to 127.0.0.1 already
      // means nothing else can reach it. The loopback assertion above stands.
      expect(running.address).toBe("127.0.0.1");
      return;
    }
    expect(await connects(external, running.port)).toBe(false);
  });
});
