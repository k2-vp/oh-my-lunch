import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createLunchServer, listen } from "../server/index.ts";
import {
  BOARD_GEOMETRY,
  createBoardGeometry,
  type BoardGeometry,
} from "../src/drop/geometry.ts";
import { simulateDrop } from "../src/drop/simulate.ts";
import { tieGeometry } from "../src/run/tie.ts";
import type { RestaurantConfig } from "../src/config/restaurants.ts";

// The complete game, end to end, against the real server and a real browser.
// Nothing here stands in for the draw, the simulation, the selection, the
// renderer, or the sequence. It runs one unsteered production game, three fixed
// game shapes, and one forced selection failure. The fixed draw values and seed
// streams are calibrated against the real simulator, so each controlled case is
// repeatable on the current geometry rather than on stale numbers.
//
// Every check is an assertion against the run's own event stream, which carries a
// timestamp on each event. A failed assertion is counted and the process exits
// non-zero, with the full event log retained so the order and state can be read.

const HOST = "127.0.0.1";
const PORT = 4188;
const BASE = `http://${HOST}:${PORT}`;
const STRIDE = 1_000_000; // must match makeSeedsFor's default stride
const CALIBRATION_CAP = 20_000; // most lanes hit far sooner; this is a safety bound
const EXHAUSTION_SEED_COUNT = 8;
const PRODUCTION_RUN_TIMEOUT_MS = 150_000;

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

interface RunEvent {
  readonly name: string;
  readonly t: number;
  readonly data: Record<string, unknown>;
}
interface RunState {
  readonly events: RunEvent[];
  readonly done: boolean;
  readonly error: string | null;
  readonly target: { lane: number; name: string } | null;
  readonly revealed: string | null;
}

interface GameCase {
  readonly name: string;
  readonly regularLanes: readonly number[];
  readonly tiedLanes: readonly number[] | null;
  readonly decidingLane: number | null;
}

const CASES: readonly GameCase[] = [
  { name: "clear leader", regularLanes: [3, 3, 3, 8, 10], tiedLanes: null, decidingLane: null },
  { name: "AE1 two-two-one", regularLanes: [2, 2, 7, 7, 11], tiedLanes: [2, 7], decidingLane: 7 },
  { name: "AE2 five-way", regularLanes: [4, 5, 6, 7, 8], tiedLanes: [4, 5, 6, 7, 8], decidingLane: 6 },
];

function rvForLane(lane: number, laneCount: number): number {
  return (lane + 0.5) / laneCount;
}

function leadOf(lanes: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const lane of lanes) counts.set(lane, (counts.get(lane) ?? 0) + 1);
  let best = -1;
  let bestCount = -1;
  for (const [lane, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = lane;
    }
  }
  return best;
}

// The draw values that force this case, in the order the run consumes them: five
// regular draws over the live board, then, on a tie, one deciding draw over the
// tied set alone.
function drawValuesFor(testCase: GameCase, geometry: BoardGeometry): number[] {
  const values = testCase.regularLanes.map((lane) => rvForLane(lane, geometry.laneCount));
  if (testCase.tiedLanes !== null && testCase.decidingLane !== null) {
    const sorted = [...testCase.tiedLanes].sort((left, right) => left - right);
    const position = sorted.indexOf(testCase.decidingLane);
    values.push((position + 0.5) / sorted.length);
  }
  return values;
}

// The first offset in ball index's seed stream whose real drop rests in `lane`
// on `geometry`. Mirrors makeSeedsFor's index*STRIDE layout and selectPath's
// first-hit rule, so the browser run finds the same path this calibration did.
function firstHitOffset(index: number, lane: number, geometry: BoardGeometry): number | null {
  const baseSeed = 1 + index * STRIDE;
  for (let offset = 0; offset < CALIBRATION_CAP; offset += 1) {
    if (simulateDrop(baseSeed + offset, geometry).restingLane === lane) return offset;
  }
  return null;
}

// Pick a target lane that a short real seed stream never reaches. The browser
// then runs that stream through the real selector and exhausts it without a
// path, which proves the entry point surfaces the failure before any release.
function calibrateExhaustion(
  geometry: BoardGeometry,
): { lane: number; seedStart: number; seedCount: number } {
  const seedStart = 1;
  const reached = new Set<number>();
  for (let offset = 0; offset < EXHAUSTION_SEED_COUNT; offset += 1) {
    const lane = simulateDrop(seedStart + offset, geometry).restingLane;
    if (lane !== null) reached.add(lane);
  }

  for (let lane = 0; lane < geometry.laneCount; lane += 1) {
    if (!reached.has(lane)) {
      return { lane, seedStart, seedCount: EXHAUSTION_SEED_COUNT };
    }
  }
  throw new Error("The exhaustion seed stream reached every lane.");
}

// A seed count that contains a hit for every ball, from the fixed seedStart of 1.
// Regular balls select on the open board; the deciding ball selects on the
// capped board the tie round produces, exactly as the countdown does.
function calibrateSeedCount(testCase: GameCase, geometry: BoardGeometry): number {
  const decidingGeometry = testCase.tiedLanes !== null
    ? tieGeometry(testCase.tiedLanes, geometry)
    : null;
  const lanes = [...testCase.regularLanes];
  if (testCase.decidingLane !== null) lanes.push(testCase.decidingLane);

  let needed = 1;
  lanes.forEach((lane, index) => {
    const isDeciding = decidingGeometry !== null && index === lanes.length - 1;
    const selectionGeometry = isDeciding ? decidingGeometry : geometry;
    const offset = firstHitOffset(index, lane, selectionGeometry);
    if (offset === null) {
      throw new Error(`${testCase.name}: no seed in stream ${index} rests in lane ${lane}.`);
    }
    needed = Math.max(needed, offset + 1);
  });
  return needed;
}

function buildUrl(testCase: GameCase, seedCount: number, geometry: BoardGeometry): string {
  const params = new URLSearchParams({
    randoms: drawValuesFor(testCase, geometry).map((value) => value.toFixed(6)).join(","),
    seedStart: "1",
    seedCount: String(seedCount),
    fast: "1",
  });
  return `${BASE}/?${params.toString()}`;
}

function buildExhaustionUrl(geometry: BoardGeometry): string {
  const exhaustion = calibrateExhaustion(geometry);
  const params = new URLSearchParams({
    randoms: rvForLane(exhaustion.lane, geometry.laneCount).toFixed(6),
    seedStart: String(exhaustion.seedStart),
    seedCount: String(exhaustion.seedCount),
    fast: "1",
  });
  return `${BASE}/?${params.toString()}`;
}

async function readRun(page: Page): Promise<RunState> {
  const state = await page.evaluate(() => {
    const plinko = (
      window as unknown as {
        __PLINKO__?: {
          events: { name: string; t: number; data: Record<string, unknown> }[];
          done: boolean;
          error: string | null;
          target: { lane: number; name: string } | null;
          revealed: string | null;
        };
      }
    ).__PLINKO__;
    if (plinko === undefined) return null;
    return {
      events: plinko.events,
      done: plinko.done,
      error: plinko.error,
      target: plinko.target,
      revealed: plinko.revealed,
    };
  });
  if (state === null) throw new Error("The page never created its run state.");
  return state;
}

const LOG_KEYS = [
  "kind", "lane", "index", "name", "releaseX", "attemptCount", "tallies",
  "tiedLanes", "closedLanes", "pauseMs", "secondsRemaining", "count", "budget",
];

function logEvents(caseName: string, events: readonly RunEvent[]): void {
  console.log(`\n--- ${caseName}: run event stream ---`);
  for (const event of events) {
    const shown: Record<string, unknown> = {};
    for (const key of LOG_KEYS) if (key in event.data) shown[key] = event.data[key];
    console.log(`${event.t.toFixed(1).padStart(9)}ms  ${event.name.padEnd(20)} ${JSON.stringify(shown)}`);
  }
}

async function runProductionCase(page: Page): Promise<void> {
  console.log("\n=== plain production bundle ===");
  await page.goto(`${BASE}/`);
  check("production: loaded without URL parameters", new URL(page.url()).search === "");
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: PRODUCTION_RUN_TIMEOUT_MS },
  );

  const run = await readRun(page);
  logEvents("plain production bundle", run.events);
  const countdownStarted = run.events.find((event) => event.name === "countdown-started");
  const countdownComplete = run.events.find((event) => event.name === "countdown-complete");
  const runComplete = run.events.find((event) => event.name === "run-complete");

  check("production: full run reached done", run.done && run.error === null, String(run.error));
  check(
    "production: default sixty-second countdown completed",
    countdownStarted?.data.durationMs === 60_000 &&
      countdownComplete !== undefined &&
      countdownComplete.t - countdownStarted.t >= 60_000,
  );
  check("production: run completed with a winner", runComplete !== undefined && run.revealed !== null);
  const shownName = await page.textContent(".board-winner-name");
  check("production: winner is shown on the board", shownName === run.revealed, String(shownName));
}

async function runCase(
  page: Page,
  testCase: GameCase,
  config: RestaurantConfig,
  geometry: BoardGeometry,
): Promise<void> {
  const seedCount = calibrateSeedCount(testCase, geometry);
  const url = buildUrl(testCase, seedCount, geometry);
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`calibrated seedStart=1 seedCount=${seedCount}`);
  console.log(url);

  await page.goto(url);
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );
  const run = await readRun(page);
  logEvents(testCase.name, run.events);

  const names = run.events.map((event) => event.name);
  const idx = (name: string, predicate?: (data: Record<string, unknown>) => boolean): number =>
    run.events.findIndex((event) => event.name === name && (predicate ? predicate(event.data) : true));
  const tag = testCase.name;

  check(`${tag}: run finished without error`, run.done && run.error === null, String(run.error));

  // The cue opens the countdown, and the countdown runs from start to complete.
  check(`${tag}: countdown cue requested`, names.includes("cue-requested"));
  const started = idx("countdown-started");
  const completed = idx("countdown-complete");
  check(`${tag}: countdown ran start to complete`, started >= 0 && completed > started);
  const countdownTicks = run.events.filter((event) => event.name === "countdown-tick");
  check(
    `${tag}: countdown ticks carry seconds remaining`,
    countdownTicks.length >= 2
      && countdownTicks.every((event) => Number.isInteger(event.data.secondsRemaining))
      && countdownTicks.at(-1)?.data.secondsRemaining === 0,
    JSON.stringify(countdownTicks.map((event) => event.data.secondsRemaining)),
  );

  const regularCount = testCase.regularLanes.length;
  const ballCount = regularCount + (testCase.tiedLanes !== null ? 1 : 0);

  // Every target is drawn before its own simulation: the draw picks the lane,
  // never the drop.
  let targetsBeforeSims = true;
  for (let ball = 0; ball < ballCount; ball += 1) {
    const drawn = idx("target-drawn", (data) => data.index === ball);
    const simmed = idx("simulation-started", (data) => data.index === ball);
    if (drawn < 0 || simmed < 0 || drawn > simmed) targetsBeforeSims = false;
  }
  check(`${tag}: each target drawn before its simulation`, targetsBeforeSims);

  // Every ball enters from the shared centre band; no release encodes the target.
  const releases = run.events.filter((event) => event.name === "ball-released");
  check(
    `${tag}: every ball released from the centre band`,
    releases.length === ballCount &&
      releases.every(
        (event) =>
          typeof event.data.releaseX === "number" &&
          Math.abs((event.data.releaseX as number) - geometry.releasePoint.x) < 1e-9,
      ),
  );

  // Five regular balls drop one at a time, each landing before the next releases.
  let sequential = true;
  for (let ballNumber = 1; ballNumber <= regularCount; ballNumber += 1) {
    const released = idx("ball-released", (data) => data.ballNumber === ballNumber);
    const landed = idx("ball-landed", (data) => data.ballNumber === ballNumber);
    if (released < 0 || landed < 0 || released > landed) sequential = false;
    if (ballNumber < regularCount) {
      const nextReleased = idx("ball-released", (data) => data.ballNumber === ballNumber + 1);
      if (nextReleased <= landed) sequential = false;
    }
  }
  check(`${tag}: five balls drop in sequence without overlap`, sequential);

  // The tally builds one landing at a time, and the count on screen never runs
  // ahead of the balls at rest.
  const landings = run.events.filter((event) => event.name === "ball-landed");
  let tallyBuilds = landings.length === ballCount;
  landings.forEach((event, order) => {
    const tallies = event.data.tallies;
    if (!Array.isArray(tallies) || tallies.reduce((sum: number, value) => sum + Number(value), 0) !== order + 1) {
      tallyBuilds = false;
    }
  });
  check(`${tag}: tally builds one landing at a time`, tallyBuilds);

  if (testCase.tiedLanes !== null && testCase.decidingLane !== null) {
    const decidingLane = testCase.decidingLane;
    const sortedTied = [...testCase.tiedLanes].sort((left, right) => left - right);
    const complement = Array.from({ length: geometry.laneCount }, (_, lane) => lane).filter(
      (lane) => !sortedTied.includes(lane),
    );

    const tieOpened = idx("tie-round-opened");
    check(`${tag}: tie round opened`, tieOpened >= 0);
    const tieData = tieOpened >= 0 ? run.events[tieOpened]?.data ?? {} : {};
    check(`${tag}: tie round names the tied set`, JSON.stringify(tieData.tiedLanes) === JSON.stringify(sortedTied));
    check(
      `${tag}: tie round closes every other lane`,
      JSON.stringify(tieData.closedLanes) === JSON.stringify(complement),
    );

    // Closure is geometry, and it happens before the deciding ball is released.
    const decidingRelease = idx("ball-released", (data) => data.kind === "deciding");
    check(`${tag}: lanes closed before the deciding ball releases`, tieOpened >= 0 && decidingRelease > tieOpened);

    // The deciding path was selected against the capped board, not the open one.
    const decidingSim = idx("simulation-started", (data) => data.kind === "deciding");
    const decidingSimClosed = decidingSim >= 0 ? run.events[decidingSim]?.data.closedLanes : undefined;
    check(
      `${tag}: deciding path selected against the capped board`,
      JSON.stringify(decidingSimClosed) === JSON.stringify(complement),
    );

    // Its own beat: a distinct cue and a longer pause than any between balls one
    // through five.
    check(`${tag}: deciding ball has its own cue`, names.includes("tie-cue-requested"));
    const gapBefore = (ballNumber: number): number => {
      const released = run.events.find(
        (event) => event.name === "ball-released" && event.data.ballNumber === ballNumber,
      );
      const priorLanding = run.events.find(
        (event) => event.name === "ball-landed" && event.data.ballNumber === ballNumber - 1,
      );
      return released !== undefined && priorLanding !== undefined ? released.t - priorLanding.t : NaN;
    };
    const tieGap = gapBefore(regularCount + 1);
    let maxRegularGap = 0;
    for (let ballNumber = 2; ballNumber <= regularCount; ballNumber += 1) {
      maxRegularGap = Math.max(maxRegularGap, gapBefore(ballNumber));
    }
    check(
      `${tag}: the deciding ball waits a longer beat`,
      Number.isFinite(tieGap) && tieGap > maxRegularGap,
      `tie ${tieGap.toFixed(1)}ms vs longest inter-ball ${maxRegularGap.toFixed(1)}ms`,
    );

    // One ball resolves the tie, inside the tied set, with no widening.
    const decidingLandings = landings.filter((event) => event.data.kind === "deciding");
    check(`${tag}: exactly one deciding ball`, decidingLandings.length === 1);
    check(
      `${tag}: the deciding ball lands inside the tied set`,
      decidingLandings.length === 1 && sortedTied.includes(decidingLandings[0]?.data.lane as number),
    );
    const finalTallies = landings[landings.length - 1]?.data.tallies;
    if (Array.isArray(finalTallies)) {
      const winnerCount = Number(finalTallies[decidingLane] ?? -1);
      const oneLeader = finalTallies.every((count, lane) => lane === decidingLane || Number(count) < winnerCount);
      check(`${tag}: one lane leads after one deciding ball`, oneLeader);
    } else {
      check(`${tag}: final tally present`, false);
    }
  } else {
    check(`${tag}: no tie round`, !names.includes("tie-round-opened"));
    check(
      `${tag}: no deciding ball`,
      !run.events.some((event) => event.name === "ball-landed" && event.data.kind === "deciding"),
    );
  }

  // The winner is revealed and held on screen.
  const expectedLane = testCase.decidingLane ?? leadOf(testCase.regularLanes);
  const expectedName = config.restaurants[expectedLane]?.name;
  check(
    `${tag}: winner revealed and held`,
    names.includes("winner-revealed") && run.revealed === expectedName && run.target?.lane === expectedLane,
    `${String(run.revealed)} @ lane ${String(run.target?.lane)}`,
  );
  const shownName = await page.textContent(".board-winner-name");
  check(`${tag}: winner name shown on the board`, shownName === expectedName, String(shownName));
}

async function runExhaustionCase(page: Page, geometry: BoardGeometry): Promise<void> {
  console.log("\n=== forced selection exhaustion ===");
  const url = buildExhaustionUrl(geometry);
  console.log(url);
  await page.goto(url);
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );

  const run = await readRun(page);
  logEvents("forced selection exhaustion", run.events);
  const names = run.events.map((event) => event.name);
  const shownMessage = await page.textContent(".board-message");

  check("exhaustion: run reached done", run.done);
  check("exhaustion: error reported", run.error === "selection-exhausted", String(run.error));
  check(
    "exhaustion: error shown on the board",
    shownMessage === "The drop could not find a fair path. Nothing was recorded.",
    String(shownMessage),
  );
  check("exhaustion: nothing revealed", run.revealed === null && !names.includes("winner-revealed"));
  check("exhaustion: destination was drawn once", names.filter((name) => name === "target-drawn").length === 1);
  check("exhaustion: no ball released", !names.includes("ball-released"));
}

async function runTooFewCase(
  page: Page,
  config: RestaurantConfig,
  restaurantsFile: string,
): Promise<void> {
  console.log("\n=== designed too-few state ===");
  writeFileSync(restaurantsFile, JSON.stringify({
    ...config,
    restaurants: config.restaurants.slice(0, 1),
  }, null, 2));

  await page.goto(`${BASE}/?fast=1`);
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );

  const run = await readRun(page);
  const view = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll("#app > canvas").length,
    presentationState: document.querySelector<HTMLElement>(".board-presentation")?.dataset.state,
    message: document.querySelector<HTMLElement>(".board-presentation .board-message")?.textContent,
  }));
  const names = run.events.map((event) => event.name);

  check("too-few: run reached done without error", run.done && run.error === null, String(run.error));
  check(
    "too-few: designed presentation state is mounted",
    view.canvasCount === 1 && view.presentationState === "too-few",
    JSON.stringify(view),
  );
  check(
    "too-few: designed message is shown",
    view.message === "Not enough places on the list. Add a few more before the next run.",
    String(view.message),
  );
  check("too-few: no ball released", !names.includes("ball-released"));
}

async function runTooManyCase(
  page: Page,
  config: RestaurantConfig,
  restaurantsFile: string,
): Promise<void> {
  console.log("\n=== restaurant limit ===");
  const restaurants = Array.from(
    { length: BOARD_GEOMETRY.laneCount + 1 },
    (_, index) => config.restaurants[index] ?? { name: `Overflow Place ${index + 1}` },
  );
  writeFileSync(restaurantsFile, JSON.stringify({ ...config, restaurants }, null, 2));

  await page.goto(`${BASE}/?fast=1`);
  await page.waitForFunction(
    () => (window as unknown as { __PLINKO__?: { done: boolean } }).__PLINKO__?.done === true,
    undefined,
    { timeout: 30_000 },
  );

  const run = await readRun(page);
  const message = await page.textContent(".board-message");
  const names = run.events.map((event) => event.name);
  const expected = `The board supports at most ${BOARD_GEOMETRY.laneCount} restaurants.`;

  check("limit: run reached done", run.done);
  check("limit: message names the board limit", run.error === expected && message === expected, String(message));
  check("limit: nothing was drawn or released", !names.includes("target-drawn") && !names.includes("ball-released"));
}

// A plain `vite build` runs in production mode. The harness page and the URL
// test controls must be gone from what it produced.
function assertProductionExclusion(): void {
  const distDir = resolve("dist");
  check("dist: harness page absent", !existsSync(join(distDir, "harness.html")));
  const assetsDir = join(distDir, "assets");
  const bundle = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(assetsDir, file), "utf8"))
    .join("\n");
  for (const token of ["randoms", "seedStart", "seedCount", "__HARNESS__"]) {
    check(`dist: no test-only token "${token}"`, !bundle.includes(token));
  }
}

async function withServer(
  distDirectory: string,
  restaurantsFile: string,
  run: () => Promise<void>,
): Promise<void> {
  const server = createLunchServer({ distDirectory, restaurantsFile });
  await listen(server, PORT, HOST);
  try {
    await run();
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(resolve("data/restaurants.json"), "utf8")) as RestaurantConfig;
  const geometry = createBoardGeometry(config.restaurants.length);
  const tempDir = mkdtempSync(join(tmpdir(), "plinko-e2e-"));
  const tempFile = join(tempDir, "restaurants.json");
  const e2eDistDirectory = join(tempDir, "dist-e2e");
  writeFileSync(tempFile, JSON.stringify(config, null, 2));
  let productionBuilt = false;

  try {
    console.log("Building the production bundle for the exclusion check and live run...");
    await runVite(["build"]);
    productionBuilt = true;
    assertProductionExclusion();

    console.log("\nBuilding the e2e bundle in a temporary directory...");
    await runVite(["build", "--mode", "e2e", "--outDir", e2eDistDirectory]);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("console", (message) => console.log(`[page] ${message.text()}`));
    page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

    try {
      await withServer(resolve("dist"), tempFile, () => runProductionCase(page));
      await withServer(e2eDistDirectory, tempFile, async () => {
        for (const testCase of CASES) {
          await runCase(page, testCase, config, geometry);
        }
        await runExhaustionCase(page, geometry);
        await runTooFewCase(page, config, tempFile);
        await runTooManyCase(page, config, tempFile);
      });
    } finally {
      await browser.close();
    }
  } finally {
    if (productionBuilt) {
      console.log("\nChecking the production bundle left in dist...");
      assertProductionExclusion();
    }
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} check(s))`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("E2E crashed:", error);
  process.exitCode = 1;
});
