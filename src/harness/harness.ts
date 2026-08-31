import { BOARD_GEOMETRY, createBoardGeometry } from "../drop/geometry.ts";
import { createBoardScene } from "../scene/board.ts";
import { createBoardPresentation, type BoardPresentationState } from "../scene/presentation.ts";
import type { Restaurant, RestaurantConfig } from "../config/restaurants.ts";
import {
  K2_THEME_TOKENS,
  applyDocumentTheme,
  createThemeController,
  type ThemePreference,
  type ThemeTokens,
} from "../scene/theme.ts";

// A development-only page that jumps the board straight to any visual state, so a
// person reviewing the look of the game reaches each state in one click rather
// than waiting out a whole run. It is a separate HTML entry that a production
// build never includes, so a scheduled kiosk run cannot reach it. It drives the
// same setState the real run drives, so what it shows is the real presenter, not
// a mock of it.

interface HarnessState {
  readonly label: string;
  readonly state: BoardPresentationState;
}

interface HarnessWindow {
  show(label: string): void;
  getState(): BoardPresentationState;
  readonly states: readonly string[];
}

declare global {
  interface Window {
    __HARNESS__?: HarnessWindow;
  }
}

// One representative payload per visual state named in the acceptance criteria.
// Each is reached by a single button, and spent and retired use distinct board
// treatments (a filled bucket versus a dark lid) so they can be told apart. The
// board is list-sized, exactly as the live page builds it, so the harness never
// shows a lane the real board would not have.
function makeStates(laneCount: number): readonly HarnessState[] {
  const tallyWith = (counts: Readonly<Record<number, number>>): number[] => {
    const tallies = new Array<number>(laneCount).fill(0);
    for (const [lane, value] of Object.entries(counts)) tallies[Number(lane)] = value;
    return tallies;
  };
  return [
  { label: "idle", state: { kind: "idle" } },
  { label: "countdown", state: { kind: "countdown", secondsRemaining: 42 } },
  {
    label: "partial tally",
    state: { kind: "drop", tallies: tallyWith({ 3: 2, 8: 1 }), ballNumber: 3, ballTotal: 5 },
  },
  {
    label: "tie 2-2-1",
    state: { kind: "tie", tallies: tallyWith({ 2: 2, 7: 2, 11: 1 }), tiedLaneIndices: [2, 7] },
  },
  {
    label: "tie 5-way",
    state: {
      kind: "tie",
      tallies: tallyWith({ 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }),
      tiedLaneIndices: [4, 5, 6, 7, 8],
    },
  },
  { label: "spent", state: { kind: "idle", spentLaneIndices: [0, 1, 9] } },
  {
    label: "retired",
    state: { kind: "tie", tallies: tallyWith({ 6: 3, 9: 3 }), tiedLaneIndices: [6, 9] },
  },
  { label: "too-few", state: { kind: "too-few" } },
  {
    label: "reveal",
    state: {
      kind: "winner",
      tallies: tallyWith({ 6: 3, 2: 2, 9: 1 }),
      winnerLaneIndex: 6,
      winnerName: "Ten Minute Hand-Pulled Noodle House",
      confirmKey: "Enter",
      redropKey: "r",
    },
  },
  {
    label: "confirmed",
    state: {
      kind: "winner",
      tallies: tallyWith({ 6: 3, 2: 2, 9: 1 }),
      winnerLaneIndex: 6,
      winnerName: "Ten Minute Hand-Pulled Noodle House",
      resolution: "settled",
    },
  },
  ];
}

function generatedRestaurants(): Restaurant[] {
  return Array.from({ length: BOARD_GEOMETRY.laneCount }, (_, index) => ({
    name: `Lane ${index + 1}`,
  }));
}

// Real labels when the dev API is up, a plain generated set otherwise, so the
// harness renders even with no server behind it.
interface HarnessConfig {
  readonly restaurants: Restaurant[];
  readonly mode: ThemePreference;
  readonly theme: ThemeTokens;
}

async function loadConfig(): Promise<HarnessConfig> {
  try {
    const response = await fetch("/api/restaurants");
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);
    const config = (await response.json()) as RestaurantConfig;
    return {
      restaurants: config.restaurants.slice(0, BOARD_GEOMETRY.laneCount),
      mode: config.settings.mode,
      theme: config.settings.theme,
    };
  } catch {
    return { restaurants: generatedRestaurants(), mode: "auto", theme: K2_THEME_TOKENS };
  }
}

async function boot(): Promise<void> {
  const mount = document.querySelector<HTMLElement>("#app");
  const controls = document.querySelector<HTMLElement>("#harness-controls");
  if (mount === null || controls === null) {
    throw new Error("The harness page is missing its mount or controls.");
  }

  const config = await loadConfig();
  const geometry = createBoardGeometry(config.restaurants.length);
  const states = makeStates(geometry.laneCount);
  const theme = createThemeController({ mode: config.mode, tokens: config.theme });
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
  const presentation = createBoardPresentation({ host: mount, board, geometry, theme: theme.current });
  presentation.setLaneNames(config.restaurants.map((restaurant) => restaurant.name));
  presentation.setWeekSummary([
    { label: "Mon", name: "Golden Bowl" },
    { label: "Tue", name: "Taco Cantina" },
    { label: "Wed", name: null, today: true },
    { label: "Thu", name: null },
    { label: "Fri", name: null },
  ]);
  applyDocumentTheme(theme.current);
  theme.subscribe((treatment) => {
    board.setTheme(treatment);
    presentation.setTheme(treatment);
    applyDocumentTheme(treatment);
    board.render();
  });
  const buttons = new Map<string, HTMLButtonElement>();

  function show(label: string): void {
    const entry = states.find((candidate) => candidate.label === label);
    if (entry === undefined) throw new Error(`No harness state named ${label}.`);
    presentation.setState(entry.state);
    for (const [name, button] of buttons) {
      button.setAttribute("aria-pressed", name === label ? "true" : "false");
    }
  }

  for (const entry of states) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => show(entry.label));
    controls.appendChild(button);
    buttons.set(entry.label, button);
  }

  window.addEventListener("resize", () => {
    board.resize(window.innerWidth, window.innerHeight);
    board.render();
    presentation.resize();
  });

  // A small hook so a review script can reach and inspect a state without a click.
  window.__HARNESS__ = {
    show,
    getState: () => presentation.getState(),
    states: states.map((entry) => entry.label),
  };

  show("idle");
}

void boot();
