import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import seedConfigSource from "../../data/restaurants.json?raw";
import { parseRestaurantConfig } from "../config/restaurants.ts";
import { createBoardGeometry } from "../drop/geometry.ts";
import { createBoardScene, type BoardScene } from "./board.ts";
import { createLaneLabelLayer, type LaneLabelLayer } from "./lane-labels.ts";
import {
  createBoardPresentation,
  type BoardPresentation,
  type BoardPresentationState,
  type ElementBounds,
} from "./presentation.ts";
import { createThemeTreatment, type ThemeMode } from "./theme.ts";

const RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
] as const;
const MODES: readonly ThemeMode[] = ["light", "dark"];

const parsed = parseRestaurantConfig(JSON.parse(seedConfigSource) as unknown);
if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.message}`);
const config = parsed.config;
const geometry = createBoardGeometry(config.restaurants.length);

function imageHash(image: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < image.length; index += 1) {
    hash ^= image.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${image.length}:${hash >>> 0}`;
}

function expectInside(bounds: ElementBounds | null, width: number, height: number): void {
  expect(bounds).not.toBeNull();
  if (bounds === null) return;
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.bottom).toBeLessThanOrEqual(height);
}

async function waitForBackgroundMark(board: BoardScene): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (board.getAppearance().backgroundMark?.loaded === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The background mark did not load.");
}

function tallies(entries: Readonly<Record<number, number>>): number[] {
  return Array.from({ length: geometry.laneCount }, (_, laneIndex) => entries[laneIndex] ?? 0);
}

const REQUIRED_STATES: readonly BoardPresentationState[] = [
    { kind: "countdown", secondsRemaining: 37, spentLaneIndices: [1] },
    {
      kind: "drop",
      tallies: tallies({ 2: 1, 6: 2, 12: 1 }),
      ballNumber: 4,
      ballTotal: 5,
      spentLaneIndices: [1],
    },
    {
      kind: "tie",
      tallies: tallies({ 2: 2, 13: 2, 6: 1 }),
      tiedLaneIndices: [2, 13],
      spentLaneIndices: [1],
    },
    {
      kind: "tie",
      tallies: tallies({ 0: 1, 2: 1, 5: 1, 9: 1, 13: 1 }),
      tiedLaneIndices: [0, 2, 5, 9, 13],
      spentLaneIndices: [1],
    },
    { kind: "idle", spentLaneIndices: [1] },
    { kind: "too-few" },
    {
      kind: "winner",
      tallies: tallies({ 2: 1, 6: 1, 13: 3 }),
      winnerLaneIndex: 13,
      winnerName: "Ten Minute Hand-Pulled Noodle House",
      confirmKey: "Enter",
      redropKey: "r",
      spentLaneIndices: [1],
    },
];

describe("K2 treatments in a real browser", () => {
  let host: HTMLElement;
  let board: BoardScene | null = null;
  let labels: LaneLabelLayer | null = null;
  let presentation: BoardPresentation | null = null;

  function disposeScene(): void {
    presentation?.dispose();
    labels?.dispose();
    board?.dispose();
    presentation = null;
    labels = null;
    board = null;
    host.replaceChildren();
  }

  beforeAll(() => {
    document.body.style.margin = "0";
    host = document.createElement("main");
    host.style.position = "relative";
    host.style.overflow = "hidden";
    document.body.appendChild(host);
  });

  afterAll(() => {
    disposeScene();
    host.remove();
    document.body.style.margin = "";
  });

  it("serves both mark files and removes the mark when its key is absent", async () => {
    for (const url of ["/brand/k2-mark.png", "/brand/k2-mark-knockout.png"]) {
      const response = await fetch(url);
      expect(response.ok, url).toBe(true);
      expect(response.headers.get("content-type"), url).toContain("image/png");
      expect((await response.arrayBuffer()).byteLength, url).toBeGreaterThan(10_000);
    }

    const light = createThemeTreatment("light", config.settings.theme);
    board = createBoardScene({ width: 1920, height: 1080, geometry, theme: light });
    await waitForBackgroundMark(board);
    const mark = board.scene.getObjectByName("background-mark");
    expect(mark).toBeDefined();
    expect(mark?.position.z).toBeLessThan(0);
    expect(board.getAppearance().backgroundMark).toMatchObject({
      url: "/brand/k2-mark.png",
      opacity: 0.05,
      loaded: true,
    });

    const { backgroundMark: _removed, ...withoutMark } = config.settings.theme;
    board.setTheme(createThemeTreatment("light", withoutMark));
    expect(board.getAppearance().backgroundMark).toBeNull();
    expect(board.scene.getObjectByName("background-mark")).toBeUndefined();
    disposeScene();
  });

  it("keeps geometry fixed and renders every required state in both modes and resolutions", async () => {
    const geometrySnapshots = new Map<string, unknown>();
    const imageHashes = new Map<string, string>();

    for (const resolution of RESOLUTIONS) {
      await page.viewport(resolution.width, resolution.height);
      host.style.width = `${resolution.width}px`;
      host.style.height = `${resolution.height}px`;

      for (const mode of MODES) {
        disposeScene();
        const treatment = createThemeTreatment(mode, config.settings.theme);
        board = createBoardScene({ ...resolution, geometry, theme: treatment });
        board.canvas.style.cssText = "display:block;width:100%;height:100%";
        host.appendChild(board.canvas);
        labels = createLaneLabelLayer(board, config.restaurants, geometry, {
          color: treatment.ink,
        });
        presentation = createBoardPresentation({ host, board, geometry, theme: treatment });
        board.setBallVisible(false);
        board.render();
        await waitForBackgroundMark(board);

        const appearance = board.getAppearance();
        expect(appearance.mode).toBe(mode);
        expect(appearance.ground).toBe(Number.parseInt(treatment.ground.slice(1), 16));
        expect(appearance.ball).toBe(Number.parseInt(treatment.ball.slice(1), 16));
        expect(appearance.peg).toBe(Number.parseInt(treatment.peg.slice(1), 16));
        expect(appearance.retiredCap).toBe(Number.parseInt(treatment.retiredCap.slice(1), 16));
        expect(appearance.backgroundMark?.opacity).toBeGreaterThanOrEqual(0.04);
        expect(appearance.backgroundMark?.opacity).toBeLessThanOrEqual(0.06);
        expect(labels.getColor()).toBe(treatment.ink);
        expect(presentation.root.dataset.theme).toBe(mode);
        expect(presentation.getTheme()).toBe(treatment);
        expect(presentation.getCelebrationSnapshot().palette).toEqual([
          treatment.accent,
          treatment.ball,
          treatment.peg,
        ]);

        const snapshot = {
          pegs: board.getPegWorldPositions(),
          walls: board.getBucketWallBounds(),
          lanes: board.getLaneCenterXs(),
          camera: {
            left: board.camera.left,
            right: board.camera.right,
            top: board.camera.top,
            bottom: board.camera.bottom,
            x: board.camera.position.x,
            y: board.camera.position.y,
          },
        };
        const resolutionKey = `${resolution.width}x${resolution.height}`;
        const firstSnapshot = geometrySnapshots.get(resolutionKey);
        if (firstSnapshot === undefined) geometrySnapshots.set(resolutionKey, snapshot);
        else expect(snapshot).toEqual(firstSnapshot);

        for (const [stateIndex, state] of REQUIRED_STATES.entries()) {
          presentation.setState(state);
          const layout = presentation.getLayout();
          if (state.kind === "countdown") {
            expectInside(layout.countdown, resolution.width, resolution.height);
            expect(layout.typeScale.countdown).toBeGreaterThanOrEqual(160 * resolution.height / 1080);
          } else if (state.kind === "drop" || state.kind === "tie") {
            expect(layout.tallies).toHaveLength(geometry.laneCount);
            for (const bounds of layout.tallies) {
              expectInside(bounds, resolution.width, resolution.height);
            }
            expect(layout.typeScale.tally).toBeGreaterThanOrEqual(28 * resolution.height / 1080);
          } else if (state.kind === "winner") {
            expectInside(layout.winnerModal, resolution.width, resolution.height);
            expectInside(layout.winnerName, resolution.width, resolution.height);
            const confirm = presentation.root.querySelector<HTMLElement>(".is-confirm kbd");
            expect(confirm).not.toBeNull();
            if (confirm !== null) {
              expect(getComputedStyle(confirm).color).toBe("rgb(31, 156, 91)");
            }
          } else if (state.kind === "too-few") {
            expectInside(layout.message, resolution.width, resolution.height);
          }

          const image = await page.screenshot({ element: host, save: false });
          expect(image.length, `${resolutionKey} ${mode} ${state.kind}`).toBeGreaterThan(1_000);
          const stateKey = `${resolutionKey}:${stateIndex}:${state.kind}`;
          const hash = imageHash(image);
          if (mode === "light") imageHashes.set(stateKey, hash);
          else expect(hash).not.toBe(imageHashes.get(stateKey));
        }

        expect(presentation.root.querySelectorAll(
          // The footer's two links are deliberate; the game surface itself
          // stays free of controls.
          ":not(.board-footer) > a, button, input, select, textarea, [tabindex], [contenteditable]",
        )).toHaveLength(0);
        expect(getComputedStyle(presentation.root).pointerEvents).toBe("none");
      }
    }
  }, 60_000);
});
