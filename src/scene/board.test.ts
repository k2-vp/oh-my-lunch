import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOARD_GEOMETRY, withClosedLanes } from "../drop/geometry.ts";
import { simulateDrop } from "../drop/simulate.ts";
import {
  createBoardScene,
  type BoardScene,
  type LaneVisualState,
} from "./board.ts";
import boardSource from "./board.ts?raw";

// These tests run in headless Chromium because the board needs a real WebGL
// context. They check that what the board draws sits exactly where the shared
// geometry says, at two TV resolutions, that a closed lane is a solid cap, and
// that the ball follows a real simulated path with its peg hits on the pegs.

const RESOLUTIONS = [
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "3840x2160", width: 3840, height: 2160 },
] as const;

// Positions are compared in board units. A tenth of a millimetre on a one-metre
// board is far tighter than any drift a wrong constant would cause.
const POSITION_TOLERANCE = 1e-4;

function close(actual: number, expected: number, tolerance = POSITION_TOLERANCE): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe("board scene", () => {
  let board: BoardScene;

  beforeAll(() => {
    board = createBoardScene({ width: 1920, height: 1080 });
  });

  afterAll(() => {
    board.dispose();
  });

  beforeEach(() => {
    board.setClosedLanes([]);
    board.resize(1920, 1080);
    board.render();
  });

  it("renders one peg per lattice peg and fifteen lane centers", () => {
    const pegs = board.getPegWorldPositions();
    expect(pegs).toHaveLength(BOARD_GEOMETRY.pegs.length);

    const laneCenters = board.getLaneCenterXs();
    expect(laneCenters).toHaveLength(BOARD_GEOMETRY.laneCount);
    expect(BOARD_GEOMETRY.laneCount).toBe(15);
  });

  for (const resolution of RESOLUTIONS) {
    it(`rendered pegs, walls, and lane centers match the geometry at ${resolution.label}`, () => {
      board.resize(resolution.width, resolution.height);
      board.render();

      const pegs = board.getPegWorldPositions();
      for (let index = 0; index < BOARD_GEOMETRY.pegs.length; index += 1) {
        const rendered = pegs[index];
        const expected = BOARD_GEOMETRY.pegs[index];
        expect(rendered).toBeDefined();
        expect(expected).toBeDefined();
        if (rendered === undefined || expected === undefined) continue;
        close(rendered.x, expected.x);
        close(rendered.y, expected.y);

        // Every peg projects inside the viewport, so nothing is clipped.
        const screen = board.worldToScreen(expected);
        expect(screen.x).toBeGreaterThanOrEqual(0);
        expect(screen.x).toBeLessThanOrEqual(resolution.width);
        expect(screen.y).toBeGreaterThanOrEqual(0);
        expect(screen.y).toBeLessThanOrEqual(resolution.height);
      }

      const walls = board.getBucketWallBounds();
      expect(walls).toHaveLength(BOARD_GEOMETRY.bucketWalls.length);
      for (let index = 0; index < BOARD_GEOMETRY.bucketWalls.length; index += 1) {
        const rendered = walls[index];
        const expected = BOARD_GEOMETRY.bucketWalls[index];
        expect(rendered).toBeDefined();
        expect(expected).toBeDefined();
        if (rendered === undefined || expected === undefined) continue;
        close(rendered.minX, expected.bounds.minX);
        close(rendered.maxX, expected.bounds.maxX);
        close(rendered.minY, expected.bounds.minY);
        close(rendered.maxY, expected.bounds.maxY);
      }

      const laneCenters = board.getLaneCenterXs();
      for (let index = 0; index < BOARD_GEOMETRY.laneCount; index += 1) {
        const rendered = laneCenters[index];
        const expected = BOARD_GEOMETRY.laneCenters[index];
        expect(rendered).toBeDefined();
        expect(expected).toBeDefined();
        if (rendered === undefined || expected === undefined) continue;
        close(rendered, expected);
      }
    });
  }

  it("projects the board on screen and scales projection with resolution", () => {
    board.resize(1920, 1080);
    board.render();
    const small = BOARD_GEOMETRY.pegs.map((peg) => board.worldToScreen(peg));

    board.resize(3840, 2160);
    board.render();
    const large = BOARD_GEOMETRY.pegs.map((peg) => board.worldToScreen(peg));

    // 3840x2160 is exactly twice 1920x1080, so every projected peg is at twice
    // the pixel coordinate. This proves resize recomputes the projection.
    for (let index = 0; index < small.length; index += 1) {
      const a = small[index];
      const b = large[index];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      close(b.x, a.x * 2, 1e-3);
      close(b.y, a.y * 2, 1e-3);
    }
  });

  it("closes a lane with the solid cap the geometry defines and opens it again", () => {
    const closed = [3, 7, 11];
    board.setClosedLanes(closed);
    board.render();

    expect([...board.getClosedLanes()]).toEqual(closed);
    for (const laneIndex of closed) {
      expect(board.getLaneVisuals()[laneIndex]?.state).toBe("retired");
    }

    const expected = withClosedLanes(closed);
    const renderedCaps = board.getCapBounds();
    expect(renderedCaps).toHaveLength(expected.caps.length);

    for (const cap of expected.caps) {
      const rendered = renderedCaps.find((entry) => entry.laneIndex === cap.laneIndex);
      expect(rendered).toBeDefined();
      if (rendered === undefined) continue;
      close(rendered.bounds.minX, cap.bounds.minX);
      close(rendered.bounds.maxX, cap.bounds.maxX);
      close(rendered.bounds.minY, cap.bounds.minY);
      close(rendered.bounds.maxY, cap.bounds.maxY);
    }

    board.setClosedLanes([]);
    board.render();
    expect(board.getCapBounds()).toHaveLength(0);
    expect([...board.getClosedLanes()]).toEqual([]);
  });

  it("gives spent, retired, and in-play lanes distinct non-text cues", () => {
    const states: LaneVisualState[] = Array.from(
      { length: BOARD_GEOMETRY.laneCount },
      () => "in-play",
    );
    states[2] = "spent";
    states[9] = "retired";
    board.setLaneStates(states);
    board.render();

    expect([...board.getClosedLanes()]).toEqual([2, 9]);
    const visuals = board.getLaneVisuals();
    expect(visuals).toHaveLength(BOARD_GEOMETRY.laneCount);

    const spent = visuals[2];
    const retired = visuals[9];
    const inPlay = visuals[5];
    expect(spent).toBeDefined();
    expect(retired).toBeDefined();
    expect(inPlay).toBeDefined();
    if (spent === undefined || retired === undefined || inPlay === undefined) return;

    expect(spent.state).toBe("spent");
    expect(spent.closed).toBe(true);
    expect(spent.closureCue).toBe("filled-bucket");
    expect(spent.capBounds).not.toBeNull();
    expect(spent.fillBounds).not.toBeNull();

    expect(retired.state).toBe("retired");
    expect(retired.closed).toBe(true);
    expect(retired.closureCue).toBe("dark-lid");
    expect(retired.capBounds).not.toBeNull();
    expect(retired.fillBounds).toBeNull();

    expect(inPlay.state).toBe("in-play");
    expect(inPlay.closed).toBe(false);
    expect(inPlay.closureCue).toBe("none");
    expect(inPlay.capBounds).toBeNull();
    expect(inPlay.fillBounds).toBeNull();
    expect(inPlay.materialColor).toBeNull();

    expect(spent.materialColor).not.toBe(retired.materialColor);
    expect(spent.materialRoughness).not.toBe(retired.materialRoughness);

    const expected = withClosedLanes([2, 9]);
    for (const laneIndex of [2, 9]) {
      const cap = expected.caps.find((entry) => entry.laneIndex === laneIndex);
      const rendered = visuals[laneIndex]?.capBounds;
      expect(cap).toBeDefined();
      expect(rendered).not.toBeNull();
      if (cap === undefined || rendered === undefined || rendered === null) continue;
      close(rendered.minX, cap.bounds.minX);
      close(rendered.maxX, cap.bounds.maxX);
      close(rendered.minY, cap.bounds.minY);
      close(rendered.maxY, cap.bounds.maxY);
    }

    const spentLane = BOARD_GEOMETRY.lanes[2];
    expect(spentLane).toBeDefined();
    if (spentLane !== undefined && spent.fillBounds !== null) {
      close(spent.fillBounds.minX, spentLane.opening.minX);
      close(spent.fillBounds.maxX, spentLane.opening.maxX);
      close(spent.fillBounds.minY, spentLane.opening.minY);
      close(spent.fillBounds.maxY, spentLane.opening.maxY);
    }
  });

  it("moves the ball along a given path by time", () => {
    const releaseY = BOARD_GEOMETRY.releasePoint.y;
    const path = [
      { time: 0, x: 0, y: releaseY },
      { time: 2, x: 4, y: BOARD_GEOMETRY.bucket.topY },
    ];

    const start = board.placeBallOnPath(path, 0);
    close(start.x, 0);
    close(start.y, releaseY);

    const middle = board.placeBallOnPath(path, 1);
    close(middle.x, 2);
    close(middle.y, (releaseY + BOARD_GEOMETRY.bucket.topY) / 2);
    const ballAtMiddle = board.getBallWorldPosition();
    close(ballAtMiddle.x, 2);
    close(ballAtMiddle.y, (releaseY + BOARD_GEOMETRY.bucket.topY) / 2);

    const end = board.placeBallOnPath(path, 5);
    close(end.x, 4);
    close(end.y, BOARD_GEOMETRY.bucket.topY);
  });

  it("follows a real simulated path and lands reported peg hits on rendered pegs", () => {
    // Find a seed whose drop rests in a lane and strikes at least one peg. This
    // is the real simulator, not a fixture. The board never sees the seed or the
    // target; it is handed the finished path.
    let chosen: ReturnType<typeof simulateDrop> | null = null;
    for (let seed = 1; seed <= 200; seed += 1) {
      const result = simulateDrop(seed);
      const hitsPeg = result.collisions.some((collision) => collision.kind === "peg");
      if (result.status === "rested" && result.restingLane !== null && hitsPeg) {
        chosen = result;
        break;
      }
    }
    expect(chosen).not.toBeNull();
    if (chosen === null) return;

    board.render();
    const pegs = board.getPegWorldPositions();

    // The rendered ball tracks the simulated path at every sample.
    for (const sample of chosen.path) {
      const placed = board.placeBallOnPath(chosen.path, sample.time);
      close(placed.x, sample.x);
      close(placed.y, sample.y);
    }

    // The first sample always uses the one shared release point.
    const first = chosen.path[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      close(first.x, BOARD_GEOMETRY.releasePoint.x);
      close(first.y, BOARD_GEOMETRY.releasePoint.y);
    }

    // Every reported peg collision sits on the surface of the rendered peg it
    // names, one ball-plus-peg radius from that peg's rendered center.
    const contactDistance = BOARD_GEOMETRY.ballRadius + BOARD_GEOMETRY.pegRadius;
    let pegHits = 0;
    for (const collision of chosen.collisions) {
      if (collision.kind !== "peg") continue;
      pegHits += 1;
      const peg = pegs[collision.geometryIndex];
      expect(peg).toBeDefined();
      if (peg === undefined) continue;
      const distanceFromCenter = Math.hypot(
        collision.point.x - peg.x,
        collision.point.y - peg.y,
      );
      // The contact point the simulator reports lies on the peg's surface.
      close(distanceFromCenter, BOARD_GEOMETRY.pegRadius, 1e-6);
      // And it is well within reach of the ball at that peg.
      expect(distanceFromCenter).toBeLessThanOrEqual(contactDistance + POSITION_TOLERANCE);
    }
    expect(pegHits).toBeGreaterThan(0);
  });
});

describe("board scene source", () => {
  // The board must take every lattice dimension from geometry.ts and declare
  // none of its own, so the drawn board and the simulated board cannot drift.
  // This reads the module source and proves it, and proves the scan is not
  // vacuous by planting a lattice number and catching it.

  function stripCommentsAndHex(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/0x[0-9a-fA-F]+/g, " ");
  }

  function decimalLiteralPresent(source: string, value: number): boolean {
    const magnitude = String(Math.abs(value)).replace(/\./g, "\\.");
    const pattern = new RegExp(`(?<![\\d.])${magnitude}(?![\\d.])`);
    return pattern.test(source);
  }

  const g = BOARD_GEOMETRY;
  const latticeNumbers = [
    ...new Set([
      g.pegSpacing.y,
      g.pegRadius,
      g.ballRadius,
      g.bucket.wallThickness,
      g.bucket.capThickness,
      Math.abs(g.bucket.bottomY),
      Math.abs(g.laneOriginX),
      g.boardWidth,
      g.laneCount,
      g.rowCount,
    ]),
  ];

  it("imports the geometry and the cap builder from geometry.ts", () => {
    expect(boardSource).toMatch(
      /import\s*\{[^}]*\bBOARD_GEOMETRY\b[^}]*\}\s*from\s*["']\.\.\/drop\/geometry\.ts["']/,
    );
    expect(boardSource).toMatch(
      /import\s*\{[^}]*\bwithClosedLanes\b[^}]*\}\s*from\s*["']\.\.\/drop\/geometry\.ts["']/,
    );
  });

  it("declares no lattice number of its own", () => {
    const source = stripCommentsAndHex(boardSource);
    for (const value of latticeNumbers) {
      expect(
        decimalLiteralPresent(source, value),
        `board.ts must not hard-code the lattice number ${value}`,
      ).toBe(false);
    }
  });

  it("uses a scan that actually catches a planted lattice number", () => {
    const planted = stripCommentsAndHex(
      "const laneWidth = 0.82;\nconst rows = 14;\nconst radius = 0.18;",
    );
    expect(decimalLiteralPresent(planted, g.pegSpacing.y)).toBe(true);
    expect(decimalLiteralPresent(planted, g.rowCount)).toBe(true);
    expect(decimalLiteralPresent(planted, g.ballRadius)).toBe(true);
  });
});
