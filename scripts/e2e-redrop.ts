import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createLunchServer, listen } from "../server/index.ts";
import { BOARD_GEOMETRY } from "../src/drop/geometry.ts";
import type { RestaurantConfig } from "../src/config/restaurants.ts";

// The ending, end to end, against the real server and a real browser: ENTER
// confirms and writes one winner, R re-drops once per day and persists the
// rejection the instant it fires, a reload after that write excludes and caps
// the rejected lane and offers confirm only, and a reload after an accepted
// winner holds it and starts no drop. Nothing is mocked; the state writes hit
// the real endpoints against a temporary state file.

const HOST = "127.0.0.1";
const PORT = 4321;
const BASE = `http://${HOST}:${PORT}`;
const WINDOW_SECONDS = 4;
// Three balls to lane 3 lead, so the first result is deterministic. Lane 3's
// restaurant is the winner the cases press keys on.
const LEADER_LANES: readonly number[] = [3, 3, 3, 8, 10];
const WINNER_LANE = 3;
const SEED_COUNT = 8000;

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  const stamp = new Date().toISOString();
  if (condition) console.log(`ok   ${stamp} ${name}`);
  else {
    console.log(`FAIL ${stamp} ${name}${detail ? `: ${detail}` : ""}`);
    failures += 1;
  }
}

function runVite(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), ...args], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`vite ${args.join(" ")} exited ${code ?? "null"}`)),
    );
  });
}

function leaderUrl(): string {
  const params = new URLSearchParams({
    randoms: LEADER_LANES.map((lane) => ((lane + 0.5) / BOARD_GEOMETRY.laneCount).toFixed(6)).join(","),
    seedStart: "1",
    seedCount: String(SEED_COUNT),
    fast: "1",
  });
  return `${BASE}/?${params.toString()}`;
}

interface WeekState {
  week: string;
  date: string;
  winners: Record<string, string>;
  rejectedToday: string | null;
  redropUsed: boolean;
}

async function readState(): Promise<WeekState> {
  const response = await fetch(`${BASE}/api/state`);
  return (await response.json()) as WeekState;
}

async function resetState(): Promise<void> {
  await fetch(`${BASE}/api/state/reset`, { method: "POST" });
}

async function waitForReveal(page: Page): Promise<string | null> {
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { revealed: string | null } }).__PLINKO__?.revealed !== null,
    undefined,
    { timeout: 30_000 },
  );
  return page.evaluate(
    () => (window as unknown as { __PLINKO__?: { revealed: string | null } }).__PLINKO__?.revealed ?? null,
  );
}

async function waitForDone(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );
}

interface Snapshot {
  readonly events: { name: string; data: Record<string, unknown> }[];
  readonly revealed: string | null;
  readonly redropActionHidden: boolean;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const plinko = (window as unknown as {
      __PLINKO__?: { events: { name: string; data: Record<string, unknown> }[]; revealed: string | null };
    }).__PLINKO__;
    const actions = Array.from(document.querySelectorAll<HTMLElement>(".board-key-action"));
    const redrop = actions.find((action) => action.textContent?.toLowerCase().includes("re-drop"));
    return {
      events: plinko?.events ?? [],
      revealed: plinko?.revealed ?? null,
      redropActionHidden: redrop === undefined ? true : redrop.hidden !== false,
    };
  });
}

async function main(): Promise<void> {
  const realConfig = JSON.parse(readFileSync(resolve("data/restaurants.json"), "utf8")) as RestaurantConfig;
  const winnerName = realConfig.restaurants[WINNER_LANE]?.name ?? "";
  const config: RestaurantConfig = {
    ...realConfig,
    settings: { ...realConfig.settings, redropKey: "r", redropWindowSeconds: WINDOW_SECONDS },
  };

  const buildDir = mkdtempSync(join(tmpdir(), "plinko-redrop-dist-"));
  console.log(`Building the e2e bundle into ${buildDir} ...`);
  await runVite(["build", "--mode", "e2e", "--outDir", buildDir, "--emptyOutDir"]);

  const dataDir = mkdtempSync(join(tmpdir(), "plinko-redrop-data-"));
  const restaurantsFile = join(dataDir, "restaurants.json");
  const stateFile = join(dataDir, "state.json");
  writeFileSync(restaurantsFile, JSON.stringify(config, null, 2));

  const server = createLunchServer({ distDirectory: buildDir, restaurantsFile, stateFile });
  await listen(server, PORT, HOST);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[page] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

  try {
    // 1. ENTER confirms and writes exactly one winner.
    console.log("\n=== ENTER confirms and writes the winner ===");
    await resetState();
    await page.goto(leaderUrl());
    check("confirm: first result reveals the leader", (await waitForReveal(page)) === winnerName, winnerName);
    await page.keyboard.press("Enter");
    await waitForDone(page);
    const afterConfirm = await readState();
    check("confirm: the winner is written for today", afterConfirm.winners[afterConfirm.date] === winnerName);
    check("confirm: no re-drop was recorded", afterConfirm.redropUsed === false && afterConfirm.rejectedToday === null);

    // 2. Reopening: after an accepted winner, hold it and start no drop.
    console.log("\n=== reopening holds the accepted winner ===");
    await page.goto(leaderUrl());
    await waitForDone(page);
    const reopened = await snapshot(page);
    check("reopen: shows the recorded winner", reopened.revealed === winnerName);
    check("reopen: records a reopen and no run", reopened.events.some((e) => e.name === "winner-reopened")
      && !reopened.events.some((e) => e.name === "run-complete"));

    // 3. R re-drops once per day and persists the rejection at once.
    console.log("\n=== R re-drops and persists the rejection ===");
    await resetState();
    await page.goto(leaderUrl());
    check("redrop: first result reveals the leader", (await waitForReveal(page)) === winnerName);
    await page.keyboard.press("r");
    await page.waitForFunction(
      () => fetch("/api/state").then((r) => r.json()).then((s: { redropUsed: boolean }) => s.redropUsed === true),
      undefined,
      { timeout: 10_000 },
    );
    const afterRedrop = await readState();
    check("redrop: the rejection and the used flag are persisted", afterRedrop.rejectedToday === winnerName && afterRedrop.redropUsed === true);
    await waitForDone(page);
    const second = await readState();
    check("redrop: the second result writes a different winner at once",
      second.winners[second.date] !== undefined && second.winners[second.date] !== winnerName,
      second.winners[second.date]);

    // 4. A reload after the re-drop write excludes and caps the rejected lane,
    //    offers confirm only, and ignores the key. State is pre-set via the API
    //    so the reload lands in exactly that moment without racing.
    console.log("\n=== reload after re-drop excludes the rejected lane and hides the hint ===");
    await resetState();
    await fetch(`${BASE}/api/state/redrop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rejected: winnerName }),
    });
    await page.goto(leaderUrl());
    await waitForReveal(page);
    const reload = await snapshot(page);
    const stateFetched = reload.events.find((e) => e.name === "state-fetched");
    check("reload: the run reads the recorded re-drop", stateFetched?.data.redropUsed === true
      && stateFetched?.data.rejectedToday === winnerName);
    check("reload: no ball targets the rejected lane",
      !reload.events.some((e) => e.name === "target-drawn" && e.data.lane === WINNER_LANE));
    check("reload: the modal offers confirm only", reload.redropActionHidden === true);
    await page.keyboard.press("r");
    await page.waitForTimeout(500);
    const afterIgnoredKey = await readState();
    check("reload: a second re-drop key is ignored", afterIgnoredKey.rejectedToday === winnerName && afterIgnoredKey.redropUsed === true);
    await waitForDone(page);
    const afterSecond = await readState();
    check("reload: the second result is written for today", afterSecond.winners[afterSecond.date] !== undefined
      && afterSecond.winners[afterSecond.date] !== winnerName);
  } finally {
    await browser.close();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nREDROP E2E PASSED" : `\nREDROP E2E FAILED (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Re-drop E2E crashed:", error);
  process.exit(1);
});
