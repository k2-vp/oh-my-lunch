import { BOARD_GEOMETRY, type BoardGeometry } from "../drop/geometry.ts";
import { layoutLabel } from "./labels.ts";
import {
  createCelebrationLayer,
  type CelebrationOptions,
  type CelebrationSnapshot,
} from "./celebration.ts";
import type { BoardScene, LaneVisualState } from "./board.ts";
import {
  K2_THEME_TOKENS,
  createThemeTreatment,
  type ThemeTreatment,
} from "./theme.ts";
import "./presentation.css";

export const TOO_FEW_MESSAGE =
  "Not enough places on the list. Add a few more before the next run.";

const COUNTDOWN_SCALE = 2.4;
const TALLY_SCALE = 0.42;
const REVEAL_SCALE = 0.72;
const SMALL_TYPE_SCALE = 0.2;
const TALLY_OFFSET_Y = 0.46;
// Lane names are measured with the same stack the CSS renders them in, so the
// fitted wrap matches what the browser draws.
const LANE_NAME_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

interface WithSpentLanes {
  readonly spentLaneIndices?: readonly number[];
}

export type BoardPresentationState =
  | ({ readonly kind: "idle" } & WithSpentLanes)
  | ({ readonly kind: "countdown"; readonly secondsRemaining: number } & WithSpentLanes)
  | ({
    readonly kind: "drop";
    readonly tallies: readonly number[];
    readonly ballNumber?: number;
    readonly ballTotal?: number;
  } & WithSpentLanes)
  | ({
    readonly kind: "tie";
    readonly tallies: readonly number[];
    readonly tiedLaneIndices: readonly number[];
  } & WithSpentLanes)
  | ({
    readonly kind: "winner";
    readonly tallies: readonly number[];
    readonly winnerLaneIndex: number;
    readonly winnerName: string;
    readonly confirmKey?: string;
    // Absent on the second result of the day, whose re-drop is already spent, so
    // its modal offers confirm only.
    readonly redropKey?: string;
    // "settled" replaces the key actions with a locked-in mark: the winner is
    // recorded and no key does anything. Reopening a decided day uses it too.
    readonly resolution?: "open" | "settled";
  } & WithSpentLanes)
  | { readonly kind: "too-few" };

export interface ElementBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationLayout {
  readonly state: BoardPresentationState["kind"];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly typeScale: {
    readonly pixelsPerWorldUnit: number;
    readonly countdown: number;
    readonly tally: number;
    readonly reveal: number;
  };
  readonly countdown: ElementBounds | null;
  readonly tallies: readonly ElementBounds[];
  readonly phase: ElementBounds | null;
  readonly winnerModal: ElementBounds | null;
  readonly winnerName: ElementBounds | null;
  readonly message: ElementBounds | null;
}

export interface WeekSummaryEntry {
  readonly label: string;
  readonly name: string | null;
  readonly today?: boolean;
}

export interface BoardPresentation {
  readonly root: HTMLElement;
  setTheme(treatment: ThemeTreatment): void;
  setLaneNames(names: readonly string[]): void;
  setWeekSummary(entries: readonly WeekSummaryEntry[]): void;
  getTheme(): ThemeTreatment;
  setState(state: BoardPresentationState): void;
  resize(): void;
  getState(): BoardPresentationState;
  getLayout(): PresentationLayout;
  getCelebrationSnapshot(): CelebrationSnapshot;
  dispose(): void;
}

export interface BoardPresentationOptions {
  readonly host: HTMLElement;
  readonly board: BoardScene;
  readonly geometry?: BoardGeometry;
  readonly celebration?: CelebrationOptions;
  readonly theme?: ThemeTreatment;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function validateLaneIndices(
  indices: readonly number[],
  laneCount: number,
  name: string,
): readonly number[] {
  const unique = new Set(indices);
  if (unique.size !== indices.length) throw new RangeError(`${name} cannot contain duplicates.`);
  const sorted = [...unique].sort((left, right) => left - right);
  for (const laneIndex of sorted) {
    if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= laneCount) {
      throw new RangeError(`${name} contains lane ${laneIndex}, which is outside the board.`);
    }
  }
  return sorted;
}

function validateTallies(tallies: readonly number[], laneCount: number): void {
  if (tallies.length !== laneCount) {
    throw new RangeError(`The tally needs ${laneCount} lane values.`);
  }
  for (const tally of tallies) {
    if (!Number.isInteger(tally) || tally < 0) {
      throw new RangeError("Every tally must be a whole number at or above zero.");
    }
  }
}

function elementBounds(element: HTMLElement, root: HTMLElement): ElementBounds | null {
  if (element.hidden) return null;
  const rootBounds = root.getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  return {
    left: bounds.left - rootBounds.left,
    top: bounds.top - rootBounds.top,
    right: bounds.right - rootBounds.left,
    bottom: bounds.bottom - rootBounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

function displayKey(key: string): string {
  if (key === " ") return "SPACE";
  return key.toLocaleUpperCase();
}

function spentLanes(state: BoardPresentationState): readonly number[] {
  return "spentLaneIndices" in state ? (state.spentLaneIndices ?? []) : [];
}

export function createBoardPresentation(options: BoardPresentationOptions): BoardPresentation {
  const { host, board } = options;
  const geometry = options.geometry ?? BOARD_GEOMETRY;
  let treatment = options.theme ?? createThemeTreatment("light", K2_THEME_TOKENS);
  const previousHostPosition = host.style.position;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  const root = createElement("div", "board-presentation");
  root.setAttribute("aria-live", "polite");
  root.dataset.state = "idle";
  host.appendChild(root);

  const countdown = createElement("div", "board-countdown");
  countdown.setAttribute("role", "timer");
  const countdownLabel = createElement("span", "board-countdown-label");
  countdownLabel.textContent = "Lunch in";
  const countdownValue = createElement("span", "board-countdown-value");
  const countdownUnit = createElement("span", "board-countdown-unit");
  countdownUnit.textContent = "seconds";
  countdown.append(countdownLabel, countdownValue, countdownUnit);
  root.appendChild(countdown);

  const phase = createElement("div", "board-phase");
  root.appendChild(phase);

  const tallyList = createElement("ol", "board-tallies");
  tallyList.setAttribute("aria-label", "Ball tally by lane");
  const tallyElements = Array.from({ length: geometry.laneCount }, (_, laneIndex) => {
    const tally = createElement("li", "board-tally");
    tally.dataset.lane = String(laneIndex);
    tally.textContent = "0";
    tallyList.appendChild(tally);
    return tally;
  });
  root.appendChild(tallyList);

  const laneNameList = createElement("ol", "board-lane-names");
  laneNameList.setAttribute("aria-label", "Restaurants by lane");
  const laneNameElements = Array.from({ length: geometry.laneCount }, (_, laneIndex) => {
    const name = createElement("li", "board-lane-name");
    name.dataset.lane = String(laneIndex);
    laneNameList.appendChild(name);
    return name;
  });
  root.appendChild(laneNameList);

  const baseline = createElement("div", "board-baseline");
  root.appendChild(baseline);

  const title = createElement("header", "board-title");
  const titleName = createElement("p", "board-title-name");
  titleName.textContent = "Lunch Plinko";
  const titleSub = createElement("p", "board-title-sub");
  titleSub.textContent = "K2 Venture Partners";
  title.append(titleSub, titleName);
  root.appendChild(title);

  const week = createElement("aside", "board-week");
  const weekHeading = createElement("p", "board-week-heading");
  weekHeading.textContent = "This week";
  const weekList = createElement("ol", "board-week-list");
  week.append(weekHeading, weekList);
  week.hidden = true;
  root.appendChild(week);

  const footer = createElement("footer", "board-footer");
  footer.innerHTML =
    '<a class="board-footer-link" href="https://github.com/k2-vp/oh-my-lunch" rel="noreferrer">'
    + '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>'
    + "<span>github.com/k2-vp/oh-my-lunch</span></a>"
    + '<a class="board-footer-link" href="https://k2vp.com" rel="noreferrer"><span>k2vp.com</span></a>';
  root.appendChild(footer);

  const winnerBackdrop = createElement("div", "board-winner-backdrop");
  winnerBackdrop.hidden = true;
  root.appendChild(winnerBackdrop);

  const winnerModal = createElement("section", "board-winner-modal");
  winnerModal.setAttribute("role", "dialog");
  winnerModal.setAttribute("aria-modal", "true");
  winnerModal.setAttribute("aria-labelledby", "board-winner-name");
  const winnerKicker = createElement("p", "board-winner-kicker");
  winnerKicker.textContent = "Today's lunch";
  const winnerName = createElement("h1", "board-winner-name");
  winnerName.id = "board-winner-name";
  const winnerActions = createElement("p", "board-winner-actions");
  const confirmAction = createElement("span", "board-key-action");
  confirmAction.classList.add("is-confirm");
  const confirmKey = document.createElement("kbd");
  const confirmLabel = document.createElement("span");
  confirmLabel.textContent = "Confirm";
  confirmAction.append(confirmKey, confirmLabel);
  const redropAction = createElement("span", "board-key-action");
  const redropKey = document.createElement("kbd");
  const redropLabel = document.createElement("span");
  redropLabel.textContent = "Re-drop";
  redropAction.append(redropKey, redropLabel);
  winnerActions.append(confirmAction, redropAction);
  const winnerSettled = createElement("p", "board-winner-settled");
  winnerSettled.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + "<span>Locked in</span>";
  winnerSettled.hidden = true;
  winnerModal.append(winnerKicker, winnerName, winnerActions, winnerSettled);
  root.appendChild(winnerModal);

  const message = createElement("p", "board-message");
  root.appendChild(message);

  const celebration = createCelebrationLayer(root, {
    ...options.celebration,
    palette: [treatment.accent, treatment.ball, treatment.peg],
  });
  let currentState: BoardPresentationState = { kind: "idle" };
  let winnerBurstKey: string | null = null;

  function setTheme(nextTreatment: ThemeTreatment): void {
    treatment = nextTreatment;
    root.dataset.theme = treatment.mode;
    root.style.setProperty("--board-ground", treatment.ground);
    root.style.setProperty("--board-surface", treatment.surface);
    root.style.setProperty("--board-ink", treatment.ink);
    root.style.setProperty("--board-muted-ink", treatment.mutedInk);
    root.style.setProperty("--board-frame", treatment.retiredCap);
    root.style.setProperty("--board-accent", treatment.accent);
    celebration.setPalette([treatment.accent, treatment.ball, treatment.peg]);
  }

  function pixelsPerWorldUnit(): number {
    const origin = board.worldToScreen({ x: 0, y: 0 });
    const oneUnit = board.worldToScreen({ x: 1, y: 0 });
    return Math.abs(oneUnit.x - origin.x);
  }

  function resize(): void {
    const hostBounds = host.getBoundingClientRect();
    const viewportWidth = hostBounds.width || host.clientWidth;
    const viewportHeight = hostBounds.height || host.clientHeight;
    const scale = pixelsPerWorldUnit();
    root.style.setProperty("--countdown-type", `${scale * COUNTDOWN_SCALE}px`);
    root.style.setProperty("--tally-type", `${scale * TALLY_SCALE}px`);
    root.style.setProperty("--reveal-type", `${scale * REVEAL_SCALE}px`);
    root.style.setProperty("--small-type", `${scale * SMALL_TYPE_SCALE}px`);
    root.style.setProperty("--lane-name-type", `${Math.max(10, scale * 0.23)}px`);
    root.style.setProperty("--frame-line", `${Math.max(2, scale * 0.035)}px`);
    root.style.setProperty("--action-gap", `${scale * 0.55}px`);

    countdown.style.left = `${Math.max(viewportWidth * 0.045, scale * 0.8)}px`;
    countdown.style.top = "50%";

    phase.style.top = `${viewportHeight * 0.075}px`;
    phase.style.right = `${Math.max(viewportWidth * 0.045, scale * 0.8)}px`;

    for (let laneIndex = 0; laneIndex < tallyElements.length; laneIndex += 1) {
      const lane = geometry.lanes[laneIndex];
      const tally = tallyElements[laneIndex];
      if (lane === undefined || tally === undefined) continue;
      const point = board.worldToScreen({
        x: lane.centerX,
        y: geometry.bucket.topY + TALLY_OFFSET_Y,
      });
      tally.style.left = `${point.x}px`;
      tally.style.top = `${point.y}px`;
    }

    for (let laneIndex = 0; laneIndex < laneNameElements.length; laneIndex += 1) {
      const lane = geometry.lanes[laneIndex];
      const name = laneNameElements[laneIndex];
      if (lane === undefined || name === undefined) continue;
      const anchor = board.worldToScreen({
        x: lane.centerX,
        y: (geometry.bucket.topY + geometry.bucket.bottomY) / 2,
      });
      const left = board.worldToScreen({ x: lane.opening.minX, y: geometry.bucket.topY });
      const right = board.worldToScreen({ x: lane.opening.maxX, y: geometry.bucket.topY });
      name.style.left = `${anchor.x}px`;
      name.style.top = `${anchor.y}px`;
      name.style.width = `${Math.max(0, right.x - left.x - scale * 0.12)}px`;
    }
    fitLaneNames();

    const laneRowLeft = board.worldToScreen({ x: geometry.laneOriginX, y: geometry.bucket.bottomY });
    const laneRowRight = board.worldToScreen({
      x: geometry.laneOriginX + geometry.boardWidth,
      y: geometry.bucket.bottomY,
    });
    baseline.style.left = `${laneRowLeft.x}px`;
    baseline.style.top = `${laneRowLeft.y}px`;
    baseline.style.width = `${laneRowRight.x - laneRowLeft.x}px`;

    const edge = Math.max(viewportWidth * 0.045, scale * 0.8);
    title.style.left = `${edge}px`;
    title.style.top = `${viewportHeight * 0.075}px`;

    week.style.right = `${edge}px`;
    week.style.top = "50%";
    // The card's padding sits inside this width (border-box), so it is wider
    // than the bare list was.
    week.style.width = `${Math.max(scale * 3.95, 216)}px`;

    // The footer spans the blank band under the lane row: repository link in
    // the left corner, the site in the right.
    footer.style.left = `${edge}px`;
    footer.style.right = `${edge}px`;
    footer.style.bottom = `${Math.max(10, viewportHeight * 0.022)}px`;

    const modalWidth = Math.min(viewportWidth * 0.62, scale * 18);
    winnerModal.style.left = `${(viewportWidth - modalWidth) / 2}px`;
    winnerModal.style.top = "50%";
    winnerModal.style.width = `${modalWidth}px`;
    winnerModal.style.minHeight = `${scale * 3.25}px`;
    winnerModal.style.padding = `${scale * 0.58}px ${scale * 0.7}px`;
    winnerModal.style.gap = `${scale * 0.38}px`;

    const boardLeft = board.worldToScreen({
      x: geometry.laneOriginX,
      y: geometry.bucket.topY,
    });
    const boardRight = board.worldToScreen({
      x: geometry.laneOriginX + geometry.boardWidth,
      y: geometry.bucket.topY,
    });
    const bucketTop = board.worldToScreen({ x: geometry.boardCenterX, y: geometry.bucket.topY });
    const bucketBottom = board.worldToScreen({
      x: geometry.boardCenterX,
      y: geometry.bucket.bottomY,
    });
    message.style.left = `${Math.min(boardLeft.x, boardRight.x)}px`;
    message.style.top = `${Math.min(bucketTop.y, bucketBottom.y) - scale * 0.5}px`;
    message.style.width = `${Math.abs(boardRight.x - boardLeft.x)}px`;
    message.style.height = `${Math.abs(bucketBottom.y - bucketTop.y) + scale}px`;
    celebration.resize();
  }

  function setLaneVisuals(state: BoardPresentationState): void {
    const spent = validateLaneIndices(
      spentLanes(state),
      geometry.laneCount,
      "Spent lanes",
    );
    const spentSet = new Set(spent);
    const laneStates: LaneVisualState[] = Array.from(
      { length: geometry.laneCount },
      (_, laneIndex) => spentSet.has(laneIndex) ? "spent" : "in-play",
    );

    if (state.kind === "tie") {
      const tied = validateLaneIndices(
        state.tiedLaneIndices,
        geometry.laneCount,
        "Tied lanes",
      );
      if (tied.length < 2) throw new RangeError("A tie needs at least two lanes.");
      const tiedSet = new Set(tied);
      for (let laneIndex = 0; laneIndex < laneStates.length; laneIndex += 1) {
        if (!spentSet.has(laneIndex) && !tiedSet.has(laneIndex)) laneStates[laneIndex] = "retired";
      }
    }

    if (state.kind === "winner") {
      validateLaneIndices([state.winnerLaneIndex], geometry.laneCount, "Winner lane");
      if (spentSet.has(state.winnerLaneIndex)) {
        throw new RangeError("The winner lane cannot already be spent.");
      }
      for (let laneIndex = 0; laneIndex < laneStates.length; laneIndex += 1) {
        if (!spentSet.has(laneIndex) && laneIndex !== state.winnerLaneIndex) {
          laneStates[laneIndex] = "retired";
        }
      }
    }

    board.setLaneStates(laneStates);
    laneNameElements.forEach((element, laneIndex) => {
      const laneState = laneStates[laneIndex] ?? "in-play";
      element.classList.toggle("is-spent", laneState === "spent");
      element.classList.toggle("is-retired", laneState === "retired");
    });
  }

  function hideStateElements(): void {
    countdown.hidden = true;
    phase.hidden = true;
    tallyList.hidden = true;
    winnerModal.hidden = true;
    winnerBackdrop.hidden = true;
    message.hidden = true;
  }

  function validateState(state: BoardPresentationState): void {
    const spent = new Set(validateLaneIndices(
      spentLanes(state),
      geometry.laneCount,
      "Spent lanes",
    ));
    switch (state.kind) {
      case "idle":
      case "too-few":
        return;
      case "countdown":
        if (
          !Number.isInteger(state.secondsRemaining)
          || state.secondsRemaining < 0
          || state.secondsRemaining > 60
        ) {
          throw new RangeError("Countdown seconds must be a whole number from 0 to 60.");
        }
        return;
      case "drop": {
        validateTallies(state.tallies, geometry.laneCount);
        if (state.ballNumber === undefined) {
          if (state.ballTotal !== undefined) {
            throw new RangeError("A total needs a current ball number.");
          }
          return;
        }
        const total = state.ballTotal ?? 5;
        if (
          !Number.isInteger(state.ballNumber)
          || !Number.isInteger(total)
          || state.ballNumber < 1
          || state.ballNumber > total
        ) {
          throw new RangeError("The ball number must be inside the round.");
        }
        return;
      }
      case "tie": {
        validateTallies(state.tallies, geometry.laneCount);
        const tied = validateLaneIndices(
          state.tiedLaneIndices,
          geometry.laneCount,
          "Tied lanes",
        );
        if (tied.length < 2) throw new RangeError("A tie needs at least two lanes.");
        if (tied.some((laneIndex) => spent.has(laneIndex))) {
          throw new RangeError("A tied lane cannot already be spent.");
        }
        return;
      }
      case "winner":
        validateTallies(state.tallies, geometry.laneCount);
        validateLaneIndices([state.winnerLaneIndex], geometry.laneCount, "Winner lane");
        if (spent.has(state.winnerLaneIndex)) {
          throw new RangeError("The winner lane cannot already be spent.");
        }
        if (state.winnerName.trim().length === 0) {
          throw new RangeError("The winner name cannot be blank.");
        }
        if (state.redropKey !== undefined && state.redropKey.trim().length === 0) {
          throw new RangeError("The re-drop key cannot be blank.");
        }
        if (state.confirmKey !== undefined && state.confirmKey.trim().length === 0) {
          throw new RangeError("The confirm key cannot be blank.");
        }
        return;
    }
  }

  function showTallies(tallies: readonly number[], tiedLaneIndices: readonly number[] = []): void {
    validateTallies(tallies, geometry.laneCount);
    const tied = new Set(tiedLaneIndices);
    for (let laneIndex = 0; laneIndex < tallyElements.length; laneIndex += 1) {
      const tally = tallyElements[laneIndex];
      const value = tallies[laneIndex];
      if (tally === undefined || value === undefined) continue;
      tally.textContent = String(value);
      tally.classList.toggle("is-tied", tied.has(laneIndex));
      tally.setAttribute("aria-label", `Lane ${laneIndex + 1}: ${value}`);
    }
    tallyList.hidden = false;
  }

  let laneNames: readonly string[] = [];

  // Fit every visible name into its lane: measure with the real font, keep
  // words whole, and shrink only as far as the longest word demands. The line
  // breaks the measurement chose are the line breaks the browser renders.
  function fitLaneNames(): void {
    const scale = pixelsPerWorldUnit();
    const bucketHeightPx = (geometry.bucket.topY - geometry.bucket.bottomY) * scale;
    laneNameElements.forEach((element, laneIndex) => {
      const name = laneNames[laneIndex] ?? "";
      if (name === "") {
        element.textContent = "";
        return;
      }
      const lane = geometry.lanes[laneIndex];
      if (lane === undefined) return;
      // Measured at regular weight but rendered at medium, so a 6% margin keeps
      // the browser from re-breaking a line the measurement said fits.
      const innerWidthPx = Math.max(
        8,
        ((lane.opening.maxX - lane.opening.minX) * scale - scale * 0.1) * 0.96,
      );
      const layout = layoutLabel(
        { name },
        { widthPx: innerWidthPx, heightPx: bucketHeightPx * 0.82 },
        {
          fontFamily: LANE_NAME_FONT_STACK,
          minFontSizePx: 8,
          maxFontSizePx: Math.max(11, scale * 0.19),
          lineHeight: 1.32,
        },
      );
      element.textContent = layout.lines.join("\n");
      element.style.fontSize = `${layout.fontSizePx}px`;
      element.style.lineHeight = `${layout.lineHeightPx}px`;
    });
  }

  function setLaneNames(names: readonly string[]): void {
    if (names.length > geometry.laneCount) {
      throw new RangeError(`The board has room for ${geometry.laneCount} lane names.`);
    }
    laneNames = [...names];
    fitLaneNames();
    // The first fit can run before the canvas has its layout size, so refit on
    // the next frame once the numbers have settled.
    requestAnimationFrame(() => fitLaneNames());
  }

  function setWeekSummary(entries: readonly WeekSummaryEntry[]): void {
    while (weekList.firstChild) weekList.removeChild(weekList.firstChild);
    for (const entry of entries) {
      const item = createElement("li", "board-week-day");
      if (entry.today === true) item.classList.add("is-today");
      const label = createElement("span", "board-week-day-label");
      label.textContent = entry.label;
      const name = createElement("span", "board-week-day-name");
      name.textContent = entry.name ?? "\u2014";
      if (entry.name === null) name.classList.add("is-empty");
      item.append(label, name);
      weekList.appendChild(item);
    }
    week.hidden = entries.length === 0;
  }

  function setState(state: BoardPresentationState): void {
    // Reject the whole state before changing DOM or scene geometry. A caller
    // never sees half of an invalid state.
    validateState(state);
    hideStateElements();
    setLaneVisuals(state);
    currentState = state;
    root.dataset.state = state.kind;

    if (state.kind !== "winner") {
      celebration.stop();
      winnerBurstKey = null;
    }

    switch (state.kind) {
      case "idle":
        break;
      case "countdown": {
        if (
          !Number.isInteger(state.secondsRemaining)
          || state.secondsRemaining < 0
          || state.secondsRemaining > 60
        ) {
          throw new RangeError("Countdown seconds must be a whole number from 0 to 60.");
        }
        countdownValue.textContent = String(state.secondsRemaining);
        countdown.setAttribute("aria-label", `${state.secondsRemaining} seconds until lunch draw`);
        countdown.hidden = false;
        break;
      }
      case "drop": {
        showTallies(state.tallies);
        if (state.ballNumber !== undefined) {
          const total = state.ballTotal ?? 5;
          if (
            !Number.isInteger(state.ballNumber)
            || !Number.isInteger(total)
            || state.ballNumber < 1
            || state.ballNumber > total
          ) {
            throw new RangeError("The ball number must be inside the round.");
          }
          phase.textContent = `Ball ${state.ballNumber} / ${total}`;
          phase.hidden = false;
        }
        break;
      }
      case "tie":
        showTallies(state.tallies, state.tiedLaneIndices);
        phase.textContent = "Tie / one deciding ball";
        phase.hidden = false;
        break;
      case "winner": {
        validateTallies(state.tallies, geometry.laneCount);
        if (state.winnerName.trim().length === 0) {
          throw new RangeError("The winner name cannot be blank.");
        }
        if (state.redropKey !== undefined && state.redropKey.trim().length === 0) {
          throw new RangeError("The re-drop key cannot be blank.");
        }
        showTallies(state.tallies);
        winnerName.textContent = state.winnerName;
        confirmKey.textContent = displayKey(state.confirmKey ?? "Enter");
        if (state.redropKey === undefined) {
          redropAction.hidden = true;
        } else {
          redropKey.textContent = displayKey(state.redropKey);
          redropAction.hidden = false;
        }
        const settled = state.resolution === "settled";
        winnerActions.hidden = settled;
        winnerSettled.hidden = !settled;
        winnerBackdrop.hidden = false;
        winnerModal.hidden = false;
        const nextBurstKey = `${state.winnerLaneIndex}\u0000${state.winnerName}`;
        // A winner arriving already settled is a reopened day, not a reveal, so
        // it gets no celebration burst.
        if (settled) {
          winnerBurstKey = nextBurstKey;
        } else if (winnerBurstKey !== nextBurstKey) {
          const lane = geometry.lanes[state.winnerLaneIndex];
          if (lane === undefined) throw new RangeError("The winner lane is outside the board.");
          const source = board.worldToScreen({ x: lane.centerX, y: geometry.bucket.topY });
          celebration.burst(source);
          winnerBurstKey = nextBurstKey;
        }
        break;
      }
      case "too-few":
        message.textContent = TOO_FEW_MESSAGE;
        message.hidden = false;
        break;
    }
    board.render();
  }

  function getLayout(): PresentationLayout {
    const scale = pixelsPerWorldUnit();
    const rootBounds = root.getBoundingClientRect();
    return {
      state: currentState.kind,
      viewport: { width: rootBounds.width, height: rootBounds.height },
      typeScale: {
        pixelsPerWorldUnit: scale,
        countdown: scale * COUNTDOWN_SCALE,
        tally: scale * TALLY_SCALE,
        reveal: scale * REVEAL_SCALE,
      },
      countdown: elementBounds(countdown, root),
      tallies: tallyList.hidden
        ? []
        : tallyElements.flatMap((tally) => {
          const bounds = elementBounds(tally, root);
          return bounds === null ? [] : [bounds];
        }),
      phase: elementBounds(phase, root),
      winnerModal: elementBounds(winnerModal, root),
      winnerName: elementBounds(winnerName, root),
      message: elementBounds(message, root),
    };
  }

  countdown.hidden = true;
  phase.hidden = true;
  tallyList.hidden = true;
  winnerModal.hidden = true;
  message.hidden = true;
  setTheme(treatment);
  resize();
  setState(currentState);

  return {
    root,
    setTheme,
    setLaneNames,
    setWeekSummary,
    getTheme: () => treatment,
    setState,
    resize,
    getState: () => currentState,
    getLayout,
    getCelebrationSnapshot: () => celebration.getSnapshot(),
    dispose() {
      celebration.dispose();
      root.remove();
      host.style.position = previousHostPosition;
    },
  };
}
