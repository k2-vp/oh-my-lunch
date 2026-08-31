import { BOARD_GEOMETRY, createBoardGeometry } from "./drop/geometry.ts";
import { createBoardScene, type BallPathSample, type BoardScene } from "./scene/board.ts";
import {
  createBoardPresentation,
  TOO_FEW_MESSAGE,
  type BoardPresentation,
  type WeekSummaryEntry,
} from "./scene/presentation.ts";
import {
  K2_THEME_TOKENS,
  applyDocumentTheme,
  createThemeController,
  type ThemeController,
} from "./scene/theme.ts";
import { resolveEligibility } from "./draw/week.ts";
import {
  createToneCue,
  DEFAULT_COUNTDOWN_MS,
  DEFAULT_INTER_BALL_PAUSE_MS,
  makeSeedsFor,
  REGULAR_BALL_COUNT,
  runCountdown,
  runDropSequence,
  type AudioCue,
  type RecordFn,
  type SelectedBall,
} from "./run/sequence.ts";
import { createTieCue, TIE_PAUSE_MS } from "./run/tie.ts";
import { resolveWindowMs, resolveWinner, spentLaneIndices } from "./run/redrop.ts";
import {
  fetchWeekState,
  postAcceptedWinner,
  postRejection,
  todaysWinner,
  weeklyWinnerNames,
  type WeekState,
} from "./run/state-client.ts";
import type { RestaurantConfig } from "./config/restaurants.ts";

// Replaced with a literal by Vite's define: true for the dev server and the
// e2e build, false for a plain `vite build`. A production build folds the
// test-control branch away, so the shipped bundle reads no URL parameters and a
// scheduled kiosk run cannot be steered from its address bar.
declare const __PLINKO_TEST_CONTROLS__: boolean;

// The whole slice-2 run, end to end. It reads the list from the real server,
// resolves who is in play, then hands off to the two run phases: the countdown
// draws every destination and selects a real path to each before the first ball
// is visible, and the drop sequence releases those balls one at a time, building
// the tally as each lands, and reveals the restaurant they put ahead.
//
// This entry decides nothing. Every target comes from the draw inside the
// countdown, every path from the selector, and the board only follows the paths
// it is handed. A bug here can mis-wire the animation; it cannot make the draw
// unfair.
//
// Test controls arrive as URL parameters. `fast=1` shrinks the countdown, the
// pause, and the animation so a run finishes quickly; `seedStart`/`seedCount`
// fix the seed streams and `randoms` fixes the draw values so a run repeats.
// They never stand in for the real draw, selection, scene, or sequence.

const DEFAULT_ANIMATION_MS = 2600;
const FAST_ANIMATION_MS = 60;
const FAST_COUNTDOWN_MS = 250;
const FAST_PAUSE_MS = 60;
const FAST_TIE_PAUSE_MS = 120;
const DEFAULT_SEED_COUNT = 4000;

interface RunEvent {
  readonly name: string;
  readonly t: number;
  readonly data: Record<string, unknown>;
}

interface PlinkoWindow {
  events: RunEvent[];
  done: boolean;
  error: string | null;
  target: { lane: number; name: string } | null;
  revealed: string | null;
  releaseX: number | null;
  rerun: () => Promise<void>;
}

declare global {
  interface Window {
    __PLINKO__?: PlinkoWindow;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function now(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame((time) => resolve(time));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The week panel shows one row per weekday with the recorded winner, so the
// room can see why lanes are spent. Dates in the record are local ISO days.
function weekSummaryEntries(state: WeekState): WeekSummaryEntry[] {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const monday = new Date(`${state.date}T12:00:00`);
  const offsetToMonday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - offsetToMonday);
  return labels.map((label, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${
      String(day.getDate()).padStart(2, "0")
    }`;
    return {
      label,
      name: state.winners[iso] ?? null,
      ...(iso === state.date ? { today: true } : {}),
    };
  });
}

// Subscribe to host key presses. Returns an unsubscribe. Nothing on screen is
// clickable; the host confirms or re-drops with a key.
function subscribeKeys(handler: (key: string) => void): () => void {
  const listener = (event: KeyboardEvent): void => handler(event.key);
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

async function fetchConfig(): Promise<RestaurantConfig> {
  const response = await fetch("/api/restaurants");
  if (!response.ok) {
    let message = `The server returned ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { field?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  return (await response.json()) as RestaurantConfig;
}

async function animateBall(
  board: BoardScene,
  path: readonly BallPathSample[],
  durationMs: number,
  isStale: () => boolean,
): Promise<void> {
  const last = path[path.length - 1];
  const totalTime = last ? last.time : 0;
  board.setBallVisible(true);
  const startReal = await now();
  for (;;) {
    // A rerun that superseded this run must not keep rendering onto a board the
    // fresh run is about to dispose and whose context it will force-lose.
    if (isStale()) return;
    const elapsed = (await now()) - startReal;
    const fraction = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1;
    board.placeBallOnPath(path, fraction * totalTime);
    board.render();
    if (fraction >= 1) return;
    await nextFrame();
  }
}

interface RunControls {
  readonly nextRandom: () => number;
  readonly seedsFor: (index: number) => readonly number[];
  readonly countdownMs: number;
  readonly pauseMs: number;
  readonly tiePauseMs: number;
  readonly animationMs: number;
}

// A repeatable draw stream from a `randoms` list, or the real one when none is
// given. Values outside [0, 1) are dropped so a bad parameter cannot smuggle in
// a target the draw would never produce.
function readRandom(params: URLSearchParams): () => number {
  const raw = params.get("randoms");
  if (raw === null) return () => Math.random();
  const values = raw
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0 && value < 1);
  if (values.length === 0) return () => Math.random();
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value ?? Math.random();
  };
}

// The real run: real draws, real seeds, real timers, no URL overrides. This is
// the only path a production build keeps.
function productionControls(): RunControls {
  return {
    nextRandom: () => Math.random(),
    seedsFor: makeSeedsFor(1 + Math.floor(Math.random() * 1_000_000), DEFAULT_SEED_COUNT),
    countdownMs: DEFAULT_COUNTDOWN_MS,
    pauseMs: DEFAULT_INTER_BALL_PAUSE_MS,
    tiePauseMs: TIE_PAUSE_MS,
    animationMs: DEFAULT_ANIMATION_MS,
  };
}

// A URL integer must parse to a safe integer of at least one to be used. A
// malformed parameter, including zero or a negative, falls back to the default
// rather than feeding a bad or empty seed stream into the selector.
function safeIntParam(params: URLSearchParams, key: string, fallback: number): number {
  if (!params.has(key)) return fallback;
  const value = Number(params.get(key));
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

// The dev and e2e path: honor the URL controls that make a run repeatable and
// fast. A production build never reaches this, so its parameter names never ship.
function readTestControls(params: URLSearchParams): RunControls {
  const fast = params.get("fast") === "1";
  const seedStart = safeIntParam(params, "seedStart", 1 + Math.floor(Math.random() * 1_000_000));
  const seedCount = safeIntParam(params, "seedCount", DEFAULT_SEED_COUNT);
  return {
    nextRandom: readRandom(params),
    seedsFor: makeSeedsFor(seedStart, seedCount),
    countdownMs: fast ? FAST_COUNTDOWN_MS : DEFAULT_COUNTDOWN_MS,
    pauseMs: fast ? FAST_PAUSE_MS : DEFAULT_INTER_BALL_PAUSE_MS,
    // Shortened together, so the tie beat stays the longer one in a fast run.
    tiePauseMs: fast ? FAST_TIE_PAUSE_MS : TIE_PAUSE_MS,
    animationMs: fast ? FAST_ANIMATION_MS : DEFAULT_ANIMATION_MS,
  };
}

function readControls(params: URLSearchParams): RunControls {
  if (!__PLINKO_TEST_CONTROLS__) return productionControls();
  return readTestControls(params);
}

function clearChildren(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function showMessage(mount: HTMLElement, message: string): void {
  clearChildren(mount);
  const panel = document.createElement("p");
  panel.className = "board-message";
  panel.textContent = message;
  panel.style.cssText = [
    "position:absolute", "inset:0", "margin:auto", "max-width:60%", "height:fit-content",
    "text-align:center", "font-family:monospace", "font-size:2vw", "line-height:1.5",
    `letter-spacing:0.02em;color:var(--board-ink,${K2_THEME_TOKENS.ink})`,
  ].join(";");
  mount.appendChild(panel);
}

interface ActiveRun {
  readonly board: BoardScene;
  readonly presentation: BoardPresentation;
  readonly theme: ThemeController;
}

let state: PlinkoWindow;
// The one run whose board and presentation are on screen. A run disposes the
// previous one before building its own, so only ever one exists.
let currentRun: ActiveRun | null = null;
// Bumped at the start of every run. A run whose token is no longer current has
// been superseded by a rerun and must stop touching the board, the presentation,
// or the shared state.
let runToken = 0;

function disposeRun(activeRun: ActiveRun): void {
  activeRun.theme.dispose();
  activeRun.presentation.dispose();
  activeRun.board.dispose();
}

function resetState(): void {
  state.events = [];
  state.done = false;
  state.error = null;
  state.target = null;
  state.revealed = null;
  state.releaseX = null;
}

function record(name: string, data: Record<string, unknown> = {}): void {
  const event: RunEvent = { name, t: performance.now(), data };
  state.events.push(event);
  console.log(`[plinko] ${event.t.toFixed(1)}ms ${name}`, data);
}

async function run(mount: HTMLElement): Promise<void> {
  // This run's token. A rerun bumps it, which supersedes any run still in
  // flight. stale() is checked after every await and at the top of every
  // callback so a superseded run stops before it touches the disposed board or
  // presentation. runRecord routes every event through the same check so a
  // superseded run cannot push events onto or flip the state the fresh run reset.
  const token = ++runToken;
  const stale = (): boolean => token !== runToken;
  const runRecord: RecordFn = (name, data) => {
    if (!stale()) record(name, data);
  };

  resetState();
  const params = new URLSearchParams(window.location.search);
  const controls = readControls(params);

  try {
    const config = await fetchConfig();
    if (stale()) return;
    runRecord("list-fetched", { count: config.restaurants.length });

    const weekState = await fetchWeekState();
    if (stale()) return;
    const spentNames = weeklyWinnerNames(weekState);
    // The lanes shown out and capped: this week's winners plus today's rejection.
    const cappedNames = weekState.rejectedToday === null
      ? spentNames
      : [...spentNames, weekState.rejectedToday];
    runRecord("state-fetched", {
      week: weekState.week,
      date: weekState.date,
      redropUsed: weekState.redropUsed,
      rejectedToday: weekState.rejectedToday,
    });

    const eligibility = resolveEligibility(config.restaurants, {
      weeklyWinners: spentNames,
      rejectedToday: weekState.rejectedToday,
    });
    const geometry = eligibility.kind === "no-drop"
      ? BOARD_GEOMETRY
      : createBoardGeometry(config.restaurants.length);

    if (currentRun !== null) {
      disposeRun(currentRun);
      currentRun = null;
    }
    clearChildren(mount);

    const theme = createThemeController({
      mode: config.settings.mode,
      tokens: config.settings.theme,
    });
    const board = createBoardScene({
      width: window.innerWidth,
      height: window.innerHeight,
      geometry,
      theme: theme.current,
    });
    board.canvas.style.display = "block";
    board.canvas.style.width = "100%";
    board.canvas.style.height = "100%";
    mount.appendChild(board.canvas);

    const presentation = createBoardPresentation({
      host: mount,
      board,
      geometry,
      theme: theme.current,
    });
    presentation.setLaneNames(config.restaurants.map((restaurant) => restaurant.name));
    presentation.setWeekSummary(weekSummaryEntries(weekState));
    runRecord("labels-placed", {
      count: config.restaurants.length,
      names: config.restaurants.map((restaurant) => restaurant.name),
    });
    applyDocumentTheme(theme.current, mount);
    theme.subscribe((treatment) => {
      board.setTheme(treatment);
      presentation.setTheme(treatment);
      applyDocumentTheme(treatment, mount);
      board.render();
    });
    currentRun = { board, presentation, theme };
    board.setBallVisible(false);

    if (eligibility.kind === "no-drop") {
      presentation.setState({ kind: "too-few" });
      runRecord("no-drop", { message: TOO_FEW_MESSAGE });
      state.done = true;
      return;
    }

    const alreadyDecided = todaysWinner(weekState);
    if (alreadyDecided !== null) {
      // Today's winner is already recorded, so hold it and start no new drop.
      // The modal offers confirm only; the day is settled.
      const laneIndex = config.restaurants.findIndex(
        (restaurant) => restaurant.name === alreadyDecided,
      );
      presentation.setState({
        kind: "winner",
        tallies: new Array<number>(geometry.laneCount).fill(0),
        winnerLaneIndex: laneIndex >= 0 ? laneIndex : 0,
        winnerName: alreadyDecided,
        resolution: "settled",
        spentLaneIndices: spentLaneIndices(
          config.restaurants.map((restaurant) => restaurant.name),
          cappedNames,
          alreadyDecided,
        ),
      });
      state.target = { lane: laneIndex, name: alreadyDecided };
      state.revealed = alreadyDecided;
      runRecord("winner-reopened", { winner: alreadyDecided, lane: laneIndex });
      state.done = true;
      return;
    }

    presentation.setState({ kind: "idle" });

    const cue: AudioCue = createToneCue();
    const countdown = await runCountdown({
      inPlay: eligibility.inPlay,
      nextRandom: controls.nextRandom,
      seedsFor: controls.seedsFor,
      record: runRecord,
      cue,
      delay,
      durationMs: controls.countdownMs,
      geometry,
      onTick: (secondsRemaining) => {
        if (stale()) return;
        runRecord("countdown-tick", { secondsRemaining });
        presentation.setState({ kind: "countdown", secondsRemaining });
      },
    });
    if (stale()) return;

    if (countdown.preselection.exhausted) {
      showMessage(mount, "The drop could not find a fair path. Nothing was recorded.");
      runRecord("selection-exhausted", {});
      state.error = "selection-exhausted";
      state.done = true;
      return;
    }

    const firstBall = countdown.preselection.balls[0];
    state.releaseX = firstBall ? firstBall.releaseX : null;

    // The count the presenter last showed, so a ball in flight keeps the tally
    // it landed with until the next lands.
    let latestTallies: readonly number[] = new Array<number>(geometry.laneCount).fill(0);
    // The tied lanes, once a tie round has opened. While this is set the board
    // holds the tie state, which is what keeps the other lanes dark and capped
    // for the whole of the deciding ball's fall rather than reopening under it.
    let tiedLaneIndices: readonly number[] | null = null;

    function showTieOrDrop(tallies: readonly number[]): void {
      if (tiedLaneIndices === null) {
        presentation.setState({ kind: "drop", tallies });
        return;
      }
      presentation.setState({ kind: "tie", tallies, tiedLaneIndices });
    }

    // Held in an object so the flow analysis keeps the closure assignment.
    const reveal: {
      current: {
        tallies: readonly number[];
        winnerLaneIndex: number;
        winnerName: string;
        spentLaneIndices: readonly number[];
      } | null;
    } = { current: null };
    const result = await runDropSequence({
      preselection: countdown.preselection,
      pauseMs: controls.pauseMs,
      tiePauseMs: controls.tiePauseMs,
      tieCue: createTieCue(),
      record: runRecord,
      geometry,
      onTieRound: (round) => {
        if (stale()) return;
        // The presenter retires every lane outside the tied set, which caps it
        // with the same geometry the deciding path was selected against.
        tiedLaneIndices = round.tiedLanes;
        presentation.setState({
          kind: "tie",
          tallies: round.tallies,
          tiedLaneIndices: round.tiedLanes,
        });
      },
      animateBall: async (ball: SelectedBall, index: number) => {
        if (stale()) return;
        // Regular balls carry the "Ball N / 5" counter. The deciding ball drops
        // under the tie state, with no counter, so it never announces a tie
        // before one happens and never falls past a lane that has reopened.
        if (ball.kind === "regular") {
          presentation.setState({
            kind: "drop",
            tallies: latestTallies,
            ballNumber: index + 1,
            ballTotal: REGULAR_BALL_COUNT,
          });
        } else {
          showTieOrDrop(latestTallies);
        }
        await animateBall(board, ball.path.path, controls.animationMs, stale);
      },
      pause: delay,
      onBallLanded: (event) => {
        if (stale()) return;
        latestTallies = event.tallies;
        if (event.kind === "regular") {
          presentation.setState({
            kind: "drop",
            tallies: event.tallies,
            ballNumber: event.ballNumber,
            ballTotal: REGULAR_BALL_COUNT,
          });
        } else {
          showTieOrDrop(event.tallies);
        }
      },
      onReveal: (winner) => {
        if (stale()) return;
        reveal.current = {
          tallies: winner.tallies,
          winnerLaneIndex: winner.laneIndex,
          winnerName: winner.name,
          spentLaneIndices: spentLaneIndices(
            config.restaurants.map((restaurant) => restaurant.name),
            cappedNames,
            winner.name,
          ),
        };
        presentation.setState({
          kind: "winner",
          ...reveal.current,
          confirmKey: "Enter",
          // The re-drop hint is hidden on the second result, whose re-drop is spent.
          ...(weekState.redropUsed ? {} : { redropKey: config.settings.redropKey }),
        });
        state.target = { lane: winner.laneIndex, name: winner.name };
        state.revealed = winner.name;
      },
    });
    if (stale()) return;
    runRecord("run-complete", { winner: result.winner.name, lane: result.winner.laneIndex });

    // Resolve the winner: the first result of the day holds the settings window
    // in which the host confirms (Enter) or re-drops (the settings key), and the
    // second result is written at once. A re-drop persists the rejection and the
    // spent flag before the next countdown starts, so a reload cannot re-arm it.
    const outcome = await resolveWinner({
      winnerName: result.winner.name,
      redropUsed: weekState.redropUsed,
      windowMs: resolveWindowMs(config.settings.redropWindowSeconds),
      confirmKey: "Enter",
      redropKey: config.settings.redropKey,
      acceptWinner: async (completesRedrop) => {
        await postAcceptedWinner(result.winner.name, completesRedrop);
      },
      redrop: async () => {
        await postRejection(result.winner.name);
        void state.rerun();
      },
      delay,
      subscribeKeys,
      record: runRecord,
      isStale: stale,
    });
    if (stale()) return;
    runRecord("run-resolved", { winner: result.winner.name, outcome });
    // Show the acceptance: the key actions give way to the locked-in mark, so a
    // confirm (or a lapsed window) is visible from across the room.
    const shown = reveal.current;
    if (outcome === "accepted" && shown !== null) {
      presentation.setState({
        kind: "winner",
        tallies: shown.tallies,
        winnerLaneIndex: shown.winnerLaneIndex,
        winnerName: shown.winnerName,
        spentLaneIndices: shown.spentLaneIndices,
        resolution: "settled",
      });
    }
    state.done = true;
  } catch (error) {
    if (stale()) return;
    const message = error instanceof Error ? error.message : String(error);
    showMessage(mount, message);
    runRecord("error", { message });
    state.error = message;
    state.done = true;
  }
}

function mountElement(): HTMLElement {
  const mount = document.querySelector<HTMLElement>("#app");
  if (mount === null) throw new Error("The page is missing the #app element.");
  return mount;
}

function boot(): void {
  const mount = mountElement();
  mount.style.position = "relative";
  state = {
    events: [],
    done: false,
    error: null,
    target: null,
    revealed: null,
    releaseX: null,
    rerun: () => run(mount),
  };
  window.__PLINKO__ = state;

  window.addEventListener("resize", () => {
    if (currentRun === null) return;
    currentRun.board.resize(window.innerWidth, window.innerHeight);
    currentRun.board.render();
    currentRun.presentation.resize();
  });

  void run(mount);
}

boot();
