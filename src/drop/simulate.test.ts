import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BOARD_GEOMETRY,
  type BoardGeometry,
  type Bounds2D,
  withClosedLanes,
} from "./geometry.ts";
import { restingLaneForPosition, simulateDrop } from "./simulate.ts";

function expectPointInBounds(
  point: { readonly x: number; readonly y: number },
  bounds: Bounds2D,
): void {
  expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
  expect(point.x).toBeLessThanOrEqual(bounds.maxX);
  expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
  expect(point.y).toBeLessThanOrEqual(bounds.maxY);
}

function expectValidPath(seed: number, geometry: BoardGeometry): void {
  const result = simulateDrop(seed, geometry);

  expect(result.path.length).toBeGreaterThan(2);
  expect(result.collisions.some(({ kind }) => kind === "peg")).toBe(true);

  for (let index = 0; index < result.path.length; index += 1) {
    const sample = result.path[index];
    expect(Number.isFinite(sample?.time)).toBe(true);
    expect(Number.isFinite(sample?.x)).toBe(true);
    expect(Number.isFinite(sample?.y)).toBe(true);
    if (index > 0) expect(sample?.time).toBeGreaterThan(result.path[index - 1]?.time ?? 0);
  }

  for (const collision of result.collisions) {
    expect(Number.isFinite(collision.time)).toBe(true);
    expect(Number.isFinite(collision.point.x)).toBe(true);
    expect(Number.isFinite(collision.point.y)).toBe(true);

    switch (collision.kind) {
      case "peg": {
        const peg = geometry.pegs[collision.geometryIndex];
        expect(peg).toBeDefined();
        expect(Math.hypot(collision.point.x - (peg?.x ?? 0), collision.point.y - (peg?.y ?? 0)))
          .toBeCloseTo(geometry.pegRadius, 8);
        break;
      }
      case "wall": {
        const wall = geometry.bucketWalls[collision.geometryIndex];
        expect(wall).toBeDefined();
        if (wall !== undefined) expectPointInBounds(collision.point, wall.bounds);
        break;
      }
      case "cap": {
        const cap = geometry.caps[collision.geometryIndex];
        expect(cap).toBeDefined();
        if (cap !== undefined) expectPointInBounds(collision.point, cap.bounds);
        break;
      }
      case "floor": {
        expect(collision.point.x).toBeGreaterThanOrEqual(geometry.laneOriginX);
        expect(collision.point.x).toBeLessThanOrEqual(
          geometry.laneOriginX + geometry.boardWidth,
        );
        expect(collision.point.y).toBe(geometry.bucket.bottomY);
        break;
      }
    }
  }
}

function findDrop(
  geometry: BoardGeometry,
  predicate: (drop: ReturnType<typeof simulateDrop>) => boolean,
): ReturnType<typeof simulateDrop> {
  for (let seed = 0; seed < 2_000; seed += 1) {
    const drop = simulateDrop(seed, geometry);
    if (predicate(drop)) return drop;
  }

  throw new Error("The fixed seed search did not find a matching real drop.");
}

describe("seeded drop simulation", () => {
  it("returns the same path and resting lane for the same seed", () => {
    expect(simulateDrop(20_260_824)).toEqual(simulateDrop(20_260_824));
  });

  it("releases every seed at one point and diverges after the first peg hit", () => {
    const drops = [11, 22, 33, 44].map((seed) => simulateDrop(seed));
    const topPeg = BOARD_GEOMETRY.pegRows[0]?.[0];
    expect(topPeg).toBeDefined();
    const topPegIndex = topPeg === undefined ? -1 : BOARD_GEOMETRY.pegs.indexOf(topPeg);
    expect(topPegIndex).toBeGreaterThanOrEqual(0);

    for (const drop of drops) {
      expect(drop.path[0]).toEqual({
        time: 0,
        x: BOARD_GEOMETRY.releasePoint.x,
        y: BOARD_GEOMETRY.releasePoint.y,
      });
      const firstPegHit = drop.collisions.find(
        (collision) => collision.kind === "peg" && collision.geometryIndex === topPegIndex,
      );
      expect(firstPegHit).toBeDefined();
    }

    expect(new Set(drops.map((drop) => JSON.stringify(drop.path))).size).toBe(drops.length);
    const firstHitTime = drops[0]?.collisions.find(
      (collision) => collision.kind === "peg" && collision.geometryIndex === topPegIndex,
    )?.time;
    expect(firstHitTime).toBeDefined();
    if (firstHitTime === undefined) return;

    const pathsThroughFirstHit = drops.map((drop) => (
      drop.path.filter(({ time }) => time <= firstHitTime)
    ));
    for (const path of pathsThroughFirstHit.slice(1)) {
      expect(path).toEqual(pathsThroughFirstHit[0]);
    }

    const firstSamplesAfterHit = drops.map(
      (drop) => drop.path.find(({ time }) => time > firstHitTime)?.x,
    );
    expect(new Set(firstSamplesAfterHit).size).toBeGreaterThan(1);
  });

  it("returns finite monotonic samples and contacts on shared geometry", () => {
    expectValidPath(2, BOARD_GEOMETRY);
  });

  it("returns the exact lane when a real drop settles in an open bucket", () => {
    const result = findDrop(BOARD_GEOMETRY, ({ restingLane }) => restingLane !== null);
    const finalPosition = result.path.at(-1);
    const lane = result.restingLane === null
      ? undefined
      : BOARD_GEOMETRY.lanes[result.restingLane];

    expect(result.status).toBe("rested");
    expect(result.restingSurface).toBe("floor");
    expect(result.restingLane).not.toBeNull();
    expect(finalPosition).toBeDefined();
    expect(lane).toBeDefined();
    if (finalPosition !== undefined && lane !== undefined) {
      expect(finalPosition.x - BOARD_GEOMETRY.ballRadius).toBeGreaterThanOrEqual(
        lane.opening.minX,
      );
      expect(finalPosition.x + BOARD_GEOMETRY.ballRadius).toBeLessThanOrEqual(
        lane.opening.maxX,
      );
      expect(restingLaneForPosition(finalPosition)).toBe(result.restingLane);
    }
  });

  it("returns no lane when the ball rests on a cap", () => {
    const capped = withClosedLanes(
      Array.from({ length: BOARD_GEOMETRY.laneCount }, (_, laneIndex) => laneIndex),
    );
    const result = findDrop(capped, ({ restingSurface }) => restingSurface === "cap");

    expect(result.status).toBe("rested");
    expect(result.restingSurface).toBe("cap");
    expect(result.restingLane).toBeNull();
    expectValidPath(result.seed, capped);
  });

  it("returns the exact open lane and never guesses across a wall", () => {
    const restingY = BOARD_GEOMETRY.bucket.bottomY + BOARD_GEOMETRY.ballRadius;

    for (const lane of BOARD_GEOMETRY.lanes) {
      expect(restingLaneForPosition({ x: lane.centerX, y: restingY })).toBe(lane.index);
    }

    const middleWall = BOARD_GEOMETRY.bucketWalls[Math.floor(
      BOARD_GEOMETRY.bucketWalls.length / 2,
    )];
    const wallX = ((middleWall?.bounds.minX ?? 0) + (middleWall?.bounds.maxX ?? 0)) / 2;
    expect(restingLaneForPosition({ x: wallX, y: restingY })).toBeNull();

    const capped = withClosedLanes([7]);
    const cap = capped.caps[0];
    expect(restingLaneForPosition(
      {
        x: capped.lanes[7]?.centerX ?? 0,
        y: (cap?.bounds.maxY ?? 0) + capped.ballRadius,
      },
      capped,
    )).toBeNull();
  });

  it("rejects seeds that cannot define a deterministic random stream", () => {
    expect(() => simulateDrop(Number.NaN)).toThrow("Seed must be a safe integer.");
    expect(() => simulateDrop(Number.POSITIVE_INFINITY)).toThrow("Seed must be a safe integer.");
    expect(() => simulateDrop(1.5)).toThrow("Seed must be a safe integer.");
  });

  it("has no target input, wall-clock randomness, or local lattice numbers", async () => {
    const source = await readFile(new URL("./simulate.ts", import.meta.url), "utf8");
    const localLatticeNumber = /\b(?:laneCount|rowCount|laneWidth|laneOriginX|boardWidth|boardCenterX|pegRadius|ballRadius|latticeTopY|bucketTopY|bucketBottomY|wallThickness|capThickness)\s*(?:\:\s*[^=;,\n]+)?(?:=|:)\s*[+-]?(?:\d|\.\d)/i;

    expect(simulateDrop).toHaveLength(1);
    expect(source).toMatch(/import\s*\{[\s\S]*BOARD_GEOMETRY[\s\S]*\}\s*from\s*"\.\/geometry\.ts"/);
    expect(source).not.toMatch(localLatticeNumber);
    expect(source).not.toMatch(/\b(?:target|targetLane)\b/);
    expect(source).not.toMatch(/Math\.random|Date\.|performance\.|crypto\./);
  });
});
