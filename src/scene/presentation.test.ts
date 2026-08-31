import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import seedConfigSource from "../../data/restaurants.json?raw";
import { parseRestaurantConfig } from "../config/restaurants.ts";
import { BOARD_GEOMETRY, createBoardGeometry } from "../drop/geometry.ts";
import { createBoardScene, type BoardScene } from "./board.ts";
import { createLaneLabelLayer, type LaneLabelLayer } from "./lane-labels.ts";
import { layoutLabel, linesBreakWords } from "./labels.ts";
import {
  createBoardPresentation,
  TOO_FEW_MESSAGE,
  type BoardPresentation,
  type BoardPresentationState,
  type ElementBounds,
} from "./presentation.ts";

const RESOLUTIONS = [
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "3840x2160", width: 3840, height: 2160 },
] as const;

const TALLIES = [0, 1, 0, 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0] as const;
const TWO_WAY_TALLIES = [0, 1, 0, 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 2] as const;
const FIVE_WAY_TALLIES = [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
const FINAL_TALLIES = [0, 1, 0, 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 3] as const;
const LONGEST_NAME = "Ten Minute Hand-Pulled Noodle House";
const CSS_POSITION_TOLERANCE = 0.02;

const parsedSeedConfig = parseRestaurantConfig(JSON.parse(seedConfigSource) as unknown);
if (!parsedSeedConfig.ok) {
  throw new Error(`${parsedSeedConfig.field}: ${parsedSeedConfig.message}`);
}
const seedConfig = parsedSeedConfig.config;

function inside(bounds: ElementBounds, width: number, height: number): void {
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.bottom).toBeLessThanOrEqual(height);
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
}

function present(bounds: ElementBounds | null): ElementBounds {
  expect(bounds).not.toBeNull();
  if (bounds === null) throw new Error("Expected visible presentation bounds.");
  return bounds;
}

function imageHash(image: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < image.length; index += 1) {
    hash ^= image.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${image.length}:${hash >>> 0}`;
}

describe("board presentation", () => {
  let host: HTMLElement;
  let board: BoardScene;
  let labels: LaneLabelLayer;
  let presentation: BoardPresentation;

  function useResolution(width: number, height: number): void {
    labels.dispose();
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    board.resize(width, height);
    labels = createLaneLabelLayer(board, seedConfig.restaurants, BOARD_GEOMETRY);
    presentation.resize();
    board.render();
  }

  beforeAll(() => {
    document.body.style.margin = "0";
    host = document.createElement("main");
    host.style.cssText = [
      "position:relative",
      "width:1920px",
      "height:1080px",
      "overflow:hidden",
      "background:#f6f6fa",
    ].join(";");
    document.body.appendChild(host);
    board = createBoardScene({ width: 1920, height: 1080 });
    board.canvas.style.cssText = "display:block;width:100%;height:100%";
    board.setBallVisible(false);
    host.appendChild(board.canvas);
    labels = createLaneLabelLayer(board, seedConfig.restaurants, BOARD_GEOMETRY);
    presentation = createBoardPresentation({ host, board });
    board.render();
  });

  afterAll(() => {
    presentation.dispose();
    labels.dispose();
    board.dispose();
    host.remove();
    document.body.style.margin = "";
  });

  it("keeps every state inside both TV resolutions at a fixed board scale", async () => {
    for (const resolution of RESOLUTIONS) {
      await page.viewport(resolution.width, resolution.height);
      useResolution(resolution.width, resolution.height);
      const factor = resolution.height / 1080;

      presentation.setState({
        kind: "countdown",
        secondsRemaining: 60,
        spentLaneIndices: [1],
      });
      let layout = presentation.getLayout();
      inside(present(layout.countdown), resolution.width, resolution.height);
      expect(layout.countdown?.left ?? Infinity).toBeLessThan(resolution.width * 0.2);
      expect(layout.typeScale.countdown).toBeCloseTo(164.35 * factor, 0);
      expect(layout.typeScale.tally).toBeCloseTo(28.76 * factor, 0);
      expect(layout.typeScale.reveal).toBeCloseTo(49.3 * factor, 0);

      presentation.setState({
        kind: "drop",
        tallies: TALLIES,
        ballNumber: 4,
        ballTotal: 5,
        spentLaneIndices: [1],
      });
      layout = presentation.getLayout();
      expect(layout.tallies).toHaveLength(BOARD_GEOMETRY.laneCount);
      for (let laneIndex = 0; laneIndex < layout.tallies.length; laneIndex += 1) {
        const bounds = layout.tallies[laneIndex];
        const lane = BOARD_GEOMETRY.lanes[laneIndex];
        expect(bounds).toBeDefined();
        expect(lane).toBeDefined();
        if (bounds === undefined || lane === undefined) continue;
        inside(bounds, resolution.width, resolution.height);
        const expected = board.worldToScreen({
          x: lane.centerX,
          y: BOARD_GEOMETRY.bucket.topY + 0.46,
        });
        // Chromium lays CSS on a 1/64-pixel grid. The center stays within two
        // grid steps of the board projection.
        expect(Math.abs(bounds.left + bounds.width / 2 - expected.x))
          .toBeLessThan(CSS_POSITION_TOLERANCE);
        expect(Math.abs(bounds.top + bounds.height / 2 - expected.y))
          .toBeLessThan(CSS_POSITION_TOLERANCE);
      }
      inside(present(layout.phase), resolution.width, resolution.height);

      presentation.setState({
        kind: "tie",
        tallies: TWO_WAY_TALLIES,
        tiedLaneIndices: [3, 14],
        spentLaneIndices: [1],
      });
      layout = presentation.getLayout();
      inside(present(layout.phase), resolution.width, resolution.height);
      const laneVisuals = board.getLaneVisuals();
      expect(laneVisuals[1]?.state).toBe("spent");
      expect(laneVisuals[3]?.state).toBe("in-play");
      expect(laneVisuals[14]?.state).toBe("in-play");
      expect(laneVisuals[8]?.state).toBe("retired");
      expect([...board.getClosedLanes()]).toEqual([
        0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);

      const fiveTiedLanes = [0, 2, 6, 10, 14];
      presentation.setState({
        kind: "tie",
        tallies: FIVE_WAY_TALLIES,
        tiedLaneIndices: fiveTiedLanes,
        spentLaneIndices: [1],
      });
      const fiveWayVisuals = board.getLaneVisuals();
      for (const laneIndex of fiveTiedLanes) {
        expect(fiveWayVisuals[laneIndex]?.state).toBe("in-play");
      }
      expect(fiveWayVisuals[1]?.state).toBe("spent");
      expect(fiveWayVisuals[8]?.state).toBe("retired");

      presentation.setState({
        kind: "winner",
        tallies: FINAL_TALLIES,
        winnerLaneIndex: 14,
        winnerName: LONGEST_NAME,
        confirmKey: "Enter",
        redropKey: "r",
        spentLaneIndices: [1],
      });
      layout = presentation.getLayout();
      const modal = present(layout.winnerModal);
      const name = present(layout.winnerName);
      inside(modal, resolution.width, resolution.height);
      inside(name, resolution.width, resolution.height);
      expect(name.left).toBeGreaterThan(modal.left);
      expect(name.right).toBeLessThan(modal.right);
      expect(presentation.root.querySelector(".board-winner-name")?.textContent)
        .toBe(LONGEST_NAME);
      expect(presentation.root.textContent).toContain("Confirm");
      expect(presentation.root.textContent).toContain("Re-drop");
      const celebration = presentation.getCelebrationSnapshot();
      const burstSource = board.worldToScreen({
        x: BOARD_GEOMETRY.lanes[14]?.centerX ?? 0,
        y: BOARD_GEOMETRY.bucket.topY,
      });
      expect(celebration.active).toBe(true);
      expect(celebration.durationMs).toBe(1_800);
      expect(celebration.origin?.x).toBeCloseTo(burstSource.x, 5);
      expect(celebration.origin?.y).toBeCloseTo(burstSource.y, 5);

      presentation.setState({ kind: "too-few" });
      layout = presentation.getLayout();
      inside(present(layout.message), resolution.width, resolution.height);
      expect(presentation.root.querySelector(".board-message")?.textContent)
        .toBe(TOO_FEW_MESSAGE);
      const messageSize = Number.parseFloat(
        getComputedStyle(presentation.root.querySelector(".board-message") as HTMLElement).fontSize,
      );
      const revealSize = Number.parseFloat(
        getComputedStyle(presentation.root.querySelector(".board-winner-name") as HTMLElement).fontSize,
      );
      expect(messageSize).toBe(revealSize);
      expect(presentation.getCelebrationSnapshot().active).toBe(false);
    }
  });

  it("draws all fourteen configured names and keeps each label inside its lane", () => {
    expect(seedConfig.restaurants).toHaveLength(14);
    for (const resolution of RESOLUTIONS) {
      useResolution(resolution.width, resolution.height);
      expect(labels.entries.map((entry) => entry.name))
        .toEqual(seedConfig.restaurants.map((restaurant) => restaurant.name));
      expect(labels.entries).toHaveLength(14);
      for (const entry of labels.entries) {
        expect(entry.layout.fitsWidth, entry.name).toBe(true);
        expect(entry.layout.fitsHeight, entry.name).toBe(true);
      }
      expect(new Set(labels.entries.map((entry) => entry.layout.fontSizePx)).size)
        .toBeLessThanOrEqual(2);
    }
  });

  it("uses one safe type size across the row at the live narrow viewport", async () => {
    await page.viewport(900, 600);
    useResolution(900, 600);

    const lane = BOARD_GEOMETRY.lanes[0];
    expect(lane).toBeDefined();
    if (lane === undefined) return;
    const left = board.worldToScreen({ x: lane.opening.minX, y: lane.opening.minY });
    const right = board.worldToScreen({ x: lane.opening.maxX, y: lane.opening.minY });
    const top = board.worldToScreen({ x: lane.centerX, y: BOARD_GEOMETRY.bucket.topY });
    const bottom = board.worldToScreen({ x: lane.centerX, y: BOARD_GEOMETRY.bucket.bottomY });
    const box = {
      widthPx: Math.abs(right.x - left.x),
      heightPx: Math.abs(bottom.y - top.y),
    };
    const expectedBase = Math.min(...seedConfig.restaurants.map((restaurant) =>
      layoutLabel(restaurant, box, { minFontSizePx: 1 }).fontSizePx
    ));

    expect(labels.entries).toHaveLength(14);
    expect(new Set(labels.entries.map((entry) => entry.layout.fontSizePx)))
      .toEqual(new Set([expectedBase]));
    for (const entry of labels.entries) {
      expect(entry.layout.fitsWidth, entry.name).toBe(true);
      expect(entry.layout.fitsHeight, entry.name).toBe(true);
      // Words stay whole, except that a hyphenated word may continue across
      // lines at its own hyphens.
      expect(
        linesBreakWords(entry.layout.lines, entry.displayedText),
        `${entry.name} split a word`,
      ).toBe(false);
    }
  });

  it("renders fourteen centered buckets for the fourteen-entry list", () => {
    const geometry = createBoardGeometry(seedConfig.restaurants.length);
    const localHost = document.createElement("main");
    localHost.style.cssText = "position:relative;width:1920px;height:1080px;overflow:hidden";
    document.body.appendChild(localHost);
    const localBoard = createBoardScene({ width: 1920, height: 1080, geometry });
    localBoard.canvas.style.cssText = "display:block;width:100%;height:100%";
    localHost.appendChild(localBoard.canvas);
    const localLabels = createLaneLabelLayer(localBoard, seedConfig.restaurants, geometry);

    try {
      const centers = localBoard.getLaneCenterXs();
      expect(centers).toHaveLength(14);
      expect(localBoard.getBucketWallBounds()).toHaveLength(15);
      expect((centers[0] ?? Infinity) + (centers.at(-1) ?? Infinity)).toBeCloseTo(0, 10);
      expect(localLabels.entries.map(({ laneIndex }) => laneIndex))
        .toEqual(Array.from({ length: 14 }, (_, laneIndex) => laneIndex));
    } finally {
      localLabels.dispose();
      localBoard.dispose();
      localHost.remove();
    }
  });

  it("captures each restrained light state without writing golden files", async () => {
    await page.viewport(1920, 1080);
    useResolution(1920, 1080);
    const states: readonly BoardPresentationState[] = [
      { kind: "idle", spentLaneIndices: [1] },
      { kind: "countdown", secondsRemaining: 37, spentLaneIndices: [1] },
      {
        kind: "drop",
        tallies: TALLIES,
        ballNumber: 4,
        ballTotal: 5,
        spentLaneIndices: [1],
      },
      {
        kind: "tie",
        tallies: TWO_WAY_TALLIES,
        tiedLaneIndices: [3, 14],
        spentLaneIndices: [1],
      },
      {
        kind: "winner",
        tallies: FINAL_TALLIES,
        winnerLaneIndex: 14,
        winnerName: LONGEST_NAME,
        confirmKey: "Enter",
        redropKey: "r",
        spentLaneIndices: [1],
      },
      { kind: "too-few" },
    ];
    const hashes: string[] = [];
    for (const state of states) {
      presentation.setState(state);
      const image = await page.screenshot({ element: host, save: false });
      expect(image.length, state.kind).toBeGreaterThan(1_000);
      hashes.push(imageHash(image));
    }
    expect(new Set(hashes).size).toBe(states.length);
  });

  it("renders no clickable or focusable controls", () => {
    presentation.setState({
      kind: "winner",
      tallies: FINAL_TALLIES,
      winnerLaneIndex: 14,
      winnerName: LONGEST_NAME,
      confirmKey: "Enter",
      redropKey: "r",
    });
    const interactive = presentation.root.querySelectorAll(
      // The footer's repository and site links are the one deliberate anchor
      // pair; the game surface itself stays free of controls.
      ":not(.board-footer) > a, button, input, select, textarea, [tabindex], [contenteditable]",
    );
    expect(interactive).toHaveLength(0);
    expect(getComputedStyle(presentation.root).pointerEvents).toBe("none");
  });

  it("rejects a bad state before changing the visible state", () => {
    presentation.setState({
      kind: "countdown",
      secondsRemaining: 20,
      spentLaneIndices: [1],
    });
    expect(() => presentation.setState({
      kind: "countdown",
      secondsRemaining: 61,
      spentLaneIndices: [2],
    })).toThrow("Countdown seconds must be a whole number from 0 to 60.");
    expect(presentation.getState()).toEqual({
      kind: "countdown",
      secondsRemaining: 20,
      spentLaneIndices: [1],
    });
    expect(presentation.root.dataset.state).toBe("countdown");
    expect(board.getLaneVisuals()[1]?.state).toBe("spent");
    expect(board.getLaneVisuals()[2]?.state).toBe("in-play");

    expect(() => presentation.setState({
      kind: "tie",
      tallies: TWO_WAY_TALLIES,
      tiedLaneIndices: [1, 14],
      spentLaneIndices: [1],
    })).toThrow("A tied lane cannot already be spent.");
    expect(presentation.root.dataset.state).toBe("countdown");
  });
});
