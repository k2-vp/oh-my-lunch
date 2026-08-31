import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createLunchServer, listen } from "../server/index.ts";
import { createBoardGeometry, type BoardGeometry } from "../src/drop/geometry.ts";
import { simulateDrop } from "../src/drop/simulate.ts";
import type { RestaurantConfig } from "../src/config/restaurants.ts";

// Two browser cases for the rerun guard (oh-my-lunch-tlg), against the real
// server and a real browser with nothing mocked. They live in their own script
// so they do not collide with the complete-game harness while the slice-2 fixups
// land in parallel.
//   1. A rerun fired mid-run must leave exactly one live board, write no stale
//      event onto the fresh run's state, and let the fresh run finish. Without
//      the token guard the superseded run keeps recording and flips state.done.
//   2. A rerun after a completed run must pick up an edited list without a
//      reload, restoring the coverage the retired one-ball script carried.
//
// The e2e bundle is built into a temporary directory, never dist, so this script
// never leaves a steerable bundle where `npm start` would serve it.

const HOST = "127.0.0.1";
const PORT = 4189;
const BASE = `http://${HOST}:${PORT}`;
const STRIDE = 1_000_000; // must match makeSeedsFor's default stride
const CALIBRATION_CAP = 20_000;
// Three balls to lane 3 lead outright, so the run has a clear winner and never
// enters a tie round: the guard, not the tie beat, is what these cases exercise.
const CLEAR_LEADER_LANES: readonly number[] = [3, 3, 3, 8, 10];
const EDITED_NAME = "E2E Rerun Diner";
// Must match src/main.ts DEFAULT_SEED_COUNT: the budget a malformed seed
// parameter falls back to. Observing this budget in the log proves the default
// was used rather than the malformed value or a clamp.
const DEFAULT_SEED_COUNT = 4000;

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  const stamp = new Date().toISOString();
  if (condition) {
    console.log(`ok   ${stamp} ${name}`);
  } else {
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

function rvForLane(lane: number, laneCount: number): number {
  return (lane + 0.5) / laneCount;
}

function firstHitOffset(index: number, lane: number, geometry: BoardGeometry): number | null {
  const baseSeed = 1 + index * STRIDE;
  for (let offset = 0; offset < CALIBRATION_CAP; offset += 1) {
    if (simulateDrop(baseSeed + offset, geometry).restingLane === lane) return offset;
  }
  return null;
}

// A seed count that contains a hit for every clear-leader ball, from seedStart 1,
// so the forced run completes rather than exhausting.
function calibrateSeedCount(lanes: readonly number[], geometry: BoardGeometry): number {
  let needed = 1;
  lanes.forEach((lane, index) => {
    const offset = firstHitOffset(index, lane, geometry);
    if (offset === null) throw new Error(`No seed in stream ${index} rests in lane ${lane}.`);
    needed = Math.max(needed, offset + 1);
  });
  return needed;
}

function clearLeaderUrl(seedCount: number, geometry: BoardGeometry): string {
  return urlWith({ seedStart: "1", seedCount: String(seedCount) }, geometry);
}

// A clear-leader URL with the seed parameters overridden, so the malformed-param
// cases can pass a bad seedStart or seedCount and leave the rest fixed.
function urlWith(overrides: Record<string, string>, geometry: BoardGeometry): string {
  const params = new URLSearchParams({
    randoms: CLEAR_LEADER_LANES
      .map((lane) => rvForLane(lane, geometry.laneCount).toFixed(6))
      .join(","),
    fast: "1",
    ...overrides,
  });
  return `${BASE}/?${params.toString()}`;
}

interface PlinkoWindow {
  events: { name: string; t: number; data: Record<string, unknown> }[];
  done: boolean;
  revealed: string | null;
  rerun: () => Promise<void>;
}

async function waitForDone(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );
}

async function rerunMidFlight(
  page: Page,
  seedCount: number,
  geometry: BoardGeometry,
): Promise<void> {
  console.log("\n=== rerun fired mid-run ===");
  await page.goto(clearLeaderUrl(seedCount, geometry));

  // Wait until a ball has released but the run is not done: it is genuinely in
  // flight, so the rerun supersedes a live run rather than a finished one.
  await page.waitForFunction(
    () => {
      const plinko = (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__;
      return plinko !== undefined
        && plinko.done === false
        && plinko.events.some((event) => event.name === "ball-released");
    },
    undefined,
    { timeout: 30_000 },
  );

  // rerun() returns the fresh run's promise, so this resolves when it completes.
  await page.evaluate(() => (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__?.rerun());

  // Give the superseded run time to unwind its remaining pauses. A broken guard
  // would record a second run-complete and flip state.done during this window.
  await page.waitForTimeout(1_500);

  const result = await page.evaluate(() => {
    const plinko = (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__;
    return {
      boards: document.querySelectorAll("#app > canvas").length,
      listFetched: plinko?.events.filter((event) => event.name === "list-fetched").length ?? -1,
      runComplete: plinko?.events.filter((event) => event.name === "run-complete").length ?? -1,
      done: plinko?.done ?? false,
      revealed: plinko?.revealed ?? null,
    };
  });

  check("mid-flight: exactly one live board", result.boards === 1, `boards=${result.boards}`);
  check("mid-flight: state holds a single fresh run", result.listFetched === 1, `list-fetched=${result.listFetched}`);
  check("mid-flight: no stale run-complete write", result.runComplete === 1, `run-complete=${result.runComplete}`);
  check(
    "mid-flight: the fresh run finished with a winner",
    result.done === true && result.revealed !== null,
    String(result.revealed),
  );
}

async function rerunAfterEdit(
  page: Page,
  seedCount: number,
  config: RestaurantConfig,
  restaurantsFile: string,
  geometry: BoardGeometry,
): Promise<void> {
  console.log("\n=== rerun after a completed run picks up an edited list ===");
  await page.goto(clearLeaderUrl(seedCount, geometry));
  await waitForDone(page);

  // Rename the last restaurant without changing the count, so this never trips
  // the sixteenth-restaurant crash owned by another bead.
  const edited: RestaurantConfig = {
    ...config,
    restaurants: config.restaurants.map((restaurant, index) =>
      index === config.restaurants.length - 1 ? { name: EDITED_NAME } : restaurant,
    ),
  };
  writeFileSync(restaurantsFile, JSON.stringify(edited, null, 2));

  // Rerun without a reload; the run reads the list fresh from the server.
  await page.evaluate(() => (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__?.rerun());
  await waitForDone(page);

  const labels = await page.evaluate(() => {
    const plinko = (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__;
    const event = plinko?.events.find((entry) => entry.name === "labels-placed");
    return event === undefined ? null : { count: event.data.count, names: event.data.names };
  });
  const names = (labels?.names as string[] | undefined) ?? [];
  check(
    "edit-rerun: the edited list appears on the next run without a reload",
    labels !== null && labels.count === edited.restaurants.length && names.includes(EDITED_NAME),
    JSON.stringify(labels),
  );
}

// A malformed seed parameter must fall back to the default rather than being
// used as-is. Both seedStart=-1 and seedCount=0 fail the safe-integer-of-at-
// least-one check. seedCount=0 is the airtight case: before the fix it clamped
// to a one-seed budget and the run exhausted with no winner; now it falls back
// to the full default budget and completes. seedStart=-1 exercises the same
// check for a negative and must leave the run healthy on the default budget.
async function malformedParamCase(
  page: Page,
  label: string,
  overrides: Record<string, string>,
  geometry: BoardGeometry,
): Promise<void> {
  console.log(`\n=== ${label} ===`);
  await page.goto(urlWith(overrides, geometry));
  await waitForDone(page);

  const result = await page.evaluate(() => {
    const plinko = (window as unknown as { __PLINKO__?: PlinkoWindow }).__PLINKO__;
    const budgets = (plinko?.events ?? [])
      .filter((event) => event.name === "simulation-started")
      .map((event) => event.data.budget);
    return { done: plinko?.done ?? false, revealed: plinko?.revealed ?? null, budgets };
  });

  check(
    `${label}: run completes on the default seeds`,
    result.done && result.revealed !== null,
    String(result.revealed),
  );
  check(
    `${label}: selection ran on the default seed budget`,
    result.budgets.length > 0 && result.budgets.every((budget) => budget === DEFAULT_SEED_COUNT),
    JSON.stringify(result.budgets),
  );
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(resolve("data/restaurants.json"), "utf8")) as RestaurantConfig;
  const geometry = createBoardGeometry(config.restaurants.length);
  const seedCount = calibrateSeedCount(CLEAR_LEADER_LANES, geometry);

  const buildDir = mkdtempSync(join(tmpdir(), "plinko-rerun-dist-"));
  console.log(`Building the e2e bundle into ${buildDir} ...`);
  await runVite(["build", "--mode", "e2e", "--outDir", buildDir, "--emptyOutDir"]);

  const dataDir = mkdtempSync(join(tmpdir(), "plinko-rerun-data-"));
  const restaurantsFile = join(dataDir, "restaurants.json");
  writeFileSync(restaurantsFile, JSON.stringify(config, null, 2));

  const server = createLunchServer({ distDirectory: buildDir, restaurantsFile });
  await listen(server, PORT, HOST);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[page] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

  try {
    await rerunMidFlight(page, seedCount, geometry);
    await rerunAfterEdit(page, seedCount, config, restaurantsFile, geometry);
    await malformedParamCase(page, "malformed seedStart (-1) falls back to the default", {
      seedStart: "-1",
    }, geometry);
    await malformedParamCase(page, "malformed seedCount (0) falls back to the default", {
      seedStart: "1",
      seedCount: "0",
    }, geometry);
  } finally {
    await browser.close();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nRERUN E2E PASSED" : `\nRERUN E2E FAILED (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Rerun E2E crashed:", error);
  process.exit(1);
});
