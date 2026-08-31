import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BOARD_GEOMETRY,
  type BoardGeometry,
  withClosedLanes,
} from "./geometry.ts";
import {
  selectPath,
  type PathSelectionResult,
} from "./select.ts";
import { simulateDrop } from "./simulate.ts";

const OPEN_BOARD_CANDIDATE_SEEDS = Object.freeze(
  Array.from({ length: 400 }, (_, seed) => seed),
);
const ACCEPTED_RELEASE_SAMPLE_COUNT = 128;
const CANDIDATE_SEEDS_PER_SAMPLE = 512;
const RELEASE_TEST_FAMILYWISE_ALPHA = 0.01;

function closedExcept(openLaneIndices: readonly number[]): BoardGeometry {
  const openLanes = new Set(openLaneIndices);
  return withClosedLanes(
    BOARD_GEOMETRY.lanes
      .map(({ index }) => index)
      .filter((laneIndex) => !openLanes.has(laneIndex)),
  );
}

function expectGenuineSelection(
  selection: PathSelectionResult,
  targetLane: number,
  geometry: BoardGeometry,
): void {
  const drop = selection.drop;

  expect(drop).not.toBeNull();
  if (drop === null) return;

  expect(drop.status).toBe("rested");
  expect(drop.restingSurface).toBe("floor");
  expect(drop.restingLane).toBe(targetLane);
  expect(geometry.closedLaneIndices).not.toContain(targetLane);
  expect(drop.path.length).toBeGreaterThan(2);
  expect(drop.collisions.some(({ kind }) => kind === "peg")).toBe(true);
  expect(drop).toEqual(simulateDrop(drop.seed, geometry));
  expect(selection.attemptCount).toBeGreaterThan(0);
  expect(selection.releaseXCoordinates).toHaveLength(selection.attemptCount);
  expect(selection.releaseXCoordinates.at(-1)).toBe(drop.path[0]?.x);
}

function findSeed(
  geometry: BoardGeometry,
  predicate: (drop: ReturnType<typeof simulateDrop>) => boolean,
): number {
  for (let seed = 0; seed < 2_000; seed += 1) {
    if (predicate(simulateDrop(seed, geometry))) return seed;
  }

  throw new Error("The fixed seed search did not find a matching real drop.");
}

function laneSetsOfSize(size: number): readonly (readonly number[])[] {
  const laneIndices = BOARD_GEOMETRY.lanes.map(({ index }) => index);
  const sets: number[][] = [];

  const appendSets = (start: number, current: readonly number[]): void => {
    if (current.length === size) {
      sets.push([...current]);
      return;
    }

    const remaining = size - current.length;
    for (let index = start; index <= laneIndices.length - remaining; index += 1) {
      const laneIndex = laneIndices[index];
      if (laneIndex !== undefined) appendSets(index + 1, [...current, laneIndex]);
    }
  };

  appendSets(0, []);
  return sets;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function twoSampleKsDistance(left: readonly number[], right: readonly number[]): number {
  const values = [...new Set([...left, ...right])].sort((first, second) => first - second);
  let distance = 0;

  for (const value of values) {
    const leftCdf = left.filter((sample) => sample <= value).length / left.length;
    const rightCdf = right.filter((sample) => sample <= value).length / right.length;
    distance = Math.max(distance, Math.abs(leftCdf - rightCdf));
  }

  return distance;
}

function twoSampleKsThreshold(sampleCount: number, comparisonCount: number): number {
  const correctedAlpha = RELEASE_TEST_FAMILYWISE_ALPHA / comparisonCount;
  const criticalValue = Math.sqrt(-0.5 * Math.log(correctedAlpha / 2));
  return criticalValue * Math.sqrt((sampleCount * 2) / (sampleCount * sampleCount));
}

describe("path selection", () => {
  it("returns a genuine simulated path for every target on the open board", () => {
    for (const lane of BOARD_GEOMETRY.lanes) {
      expectGenuineSelection(
        selectPath(lane.index, OPEN_BOARD_CANDIDATE_SEEDS),
        lane.index,
        BOARD_GEOMETRY,
      );
    }
  });

  it("is deterministic and preserves different real paths for the same target", () => {
    const targetLane = BOARD_GEOMETRY.lanes.at(-1)?.index;
    expect(targetLane).toBeDefined();
    if (targetLane === undefined) return;

    const matchingSeeds: number[] = [];
    for (const seed of OPEN_BOARD_CANDIDATE_SEEDS) {
      if (simulateDrop(seed).restingLane === targetLane) matchingSeeds.push(seed);
      if (matchingSeeds.length === 2) break;
    }
    expect(matchingSeeds).toHaveLength(2);

    const first = selectPath(targetLane, [matchingSeeds[0] ?? 0]);
    const repeated = selectPath(targetLane, [matchingSeeds[0] ?? 0]);
    const second = selectPath(targetLane, [matchingSeeds[1] ?? 0]);

    expect(first).toEqual(repeated);
    expect(first.drop?.path).not.toEqual(second.drop?.path);
    expectGenuineSelection(first, targetLane, BOARD_GEOMETRY);
    expectGenuineSelection(second, targetLane, BOARD_GEOMETRY);
  });

  it("does not reveal the target through accepted release coordinates", () => {
    const targetLanes = [
      BOARD_GEOMETRY.lanes[0]?.index,
      BOARD_GEOMETRY.lanes[Math.floor(BOARD_GEOMETRY.laneCount / 2)]?.index,
      BOARD_GEOMETRY.lanes.at(-1)?.index,
    ];
    expect(targetLanes.every((lane): lane is number => lane !== undefined)).toBe(true);
    const samples = new Map<number, number[]>(
      targetLanes.map((targetLane) => [targetLane ?? -1, []]),
    );
    const exhausted: { readonly sample: number; readonly targetLane: number }[] = [];

    for (let sample = 0; sample < ACCEPTED_RELEASE_SAMPLE_COUNT; sample += 1) {
      const candidateSeeds = Array.from(
        { length: CANDIDATE_SEEDS_PER_SAMPLE },
        (_, offset) => sample * CANDIDATE_SEEDS_PER_SAMPLE + offset,
      );

      for (const targetLane of targetLanes) {
        if (targetLane === undefined) continue;
        const selection = selectPath(targetLane, candidateSeeds);
        const releaseX = selection.drop?.path[0]?.x;
        if (releaseX === undefined) {
          exhausted.push({ sample, targetLane });
        } else {
          samples.get(targetLane)?.push(releaseX);
        }
      }
    }

    const validTargetLanes = targetLanes.filter(
      (lane): lane is number => lane !== undefined,
    );
    const comparisons = validTargetLanes.flatMap((leftTarget, leftIndex) => (
      validTargetLanes.slice(leftIndex + 1).map((rightTarget) => ({ leftTarget, rightTarget }))
    ));
    const threshold = twoSampleKsThreshold(
      ACCEPTED_RELEASE_SAMPLE_COUNT,
      comparisons.length,
    );
    const means = Object.fromEntries(
      validTargetLanes.map((targetLane) => [targetLane, mean(samples.get(targetLane) ?? [])]),
    );
    const distances = comparisons.map(({ leftTarget, rightTarget }) => ({
      leftTarget,
      rightTarget,
      distance: twoSampleKsDistance(
        samples.get(leftTarget) ?? [],
        samples.get(rightTarget) ?? [],
      ),
    }));
    const detail = JSON.stringify({ means, distances, threshold, exhausted });

    expect(exhausted, detail).toEqual([]);
    for (const targetLane of validTargetLanes) {
      expect(samples.get(targetLane), detail).toHaveLength(ACCEPTED_RELEASE_SAMPLE_COUNT);
    }
    for (const { distance } of distances) {
      expect(distance, detail).toBeLessThanOrEqual(threshold);
    }
  }, 60_000);

  it("rejects cap rests and wrong lanes until the requested open lane lands", () => {
    const firstLane = BOARD_GEOMETRY.lanes[0]?.index;
    const lastLane = BOARD_GEOMETRY.lanes.at(-1)?.index;
    expect(firstLane).toBeDefined();
    expect(lastLane).toBeDefined();
    if (firstLane === undefined || lastLane === undefined) return;

    const geometry = closedExcept([firstLane, lastLane]);
    const capSeed = findSeed(
      geometry,
      ({ restingSurface }) => restingSurface === "cap",
    );
    const wrongLaneSeed = findSeed(
      geometry,
      ({ restingLane }) => restingLane === lastLane,
    );
    const targetSeed = findSeed(
      geometry,
      ({ restingLane }) => restingLane === firstLane,
    );
    const selection = selectPath(
      firstLane,
      [capSeed, wrongLaneSeed, targetSeed],
      geometry,
    );

    expect(selection.attemptCount).toBe(3);
    expect(selection.drop?.seed).toBe(targetSeed);
    expectGenuineSelection(selection, firstLane, geometry);
  });

  it("returns null with the full attempt count when the budget is exhausted", () => {
    const firstLane = BOARD_GEOMETRY.lanes[0]?.index;
    const lastLane = BOARD_GEOMETRY.lanes.at(-1)?.index;
    expect(firstLane).toBeDefined();
    expect(lastLane).toBeDefined();
    if (firstLane === undefined || lastLane === undefined) return;

    const geometry = closedExcept([firstLane, lastLane]);
    const capSeed = findSeed(
      geometry,
      ({ restingSurface }) => restingSurface === "cap",
    );
    const wrongLaneSeed = findSeed(
      geometry,
      ({ restingLane }) => restingLane === lastLane,
    );
    const selection = selectPath(firstLane, [capSeed, wrongLaneSeed], geometry);

    expect(selection).toEqual({
      drop: null,
      attemptCount: 2,
      releaseXCoordinates: [
        simulateDrop(capSeed, geometry).path[0]?.x,
        simulateDrop(wrongLaneSeed, geometry).path[0]?.x,
      ],
    });
  });

  it("lands only in requested open lanes on representative tie boards", () => {
    const lastLane = BOARD_GEOMETRY.lanes.at(-1)?.index ?? 0;
    const middleLane = Math.floor(lastLane / 2);
    const tieLaneSets = [
      [0, lastLane],
      [middleLane - 1, middleLane + 1],
      [0, Math.floor(lastLane / 4), middleLane, Math.ceil(lastLane * 3 / 4), lastLane],
      Array.from({ length: 5 }, (_, offset) => middleLane - 2 + offset),
    ];

    for (const openLaneIndices of tieLaneSets) {
      const geometry = closedExcept(openLaneIndices);
      for (const targetLane of openLaneIndices) {
        expectGenuineSelection(
          selectPath(targetLane, OPEN_BOARD_CANDIDATE_SEEDS, geometry),
          targetLane,
          geometry,
        );
      }
    }
  });

  it("rejects every closed target on every legal two-lane and five-lane board", () => {
    let checkedTargets = 0;

    for (const openLaneCount of [2, 5]) {
      for (const openLaneIndices of laneSetsOfSize(openLaneCount)) {
        const geometry = closedExcept(openLaneIndices);
        for (const closedLaneIndex of geometry.closedLaneIndices) {
          expect(() => selectPath(closedLaneIndex, [], geometry)).toThrow(
            `Target lane ${closedLaneIndex} is closed.`,
          );
          checkedTargets += 1;
        }
      }
    }

    expect(checkedTargets).toBeGreaterThan(0);
  });

  it("returns real target paths across every legal two-lane and five-lane board", () => {
    const directSeedByTarget = new Map<number, number>();

    for (const lane of BOARD_GEOMETRY.lanes) {
      const oneLaneGeometry = closedExcept([lane.index]);
      const seed = findSeed(
        oneLaneGeometry,
        (drop) => drop.restingLane === lane.index
          && !drop.collisions.some(({ kind }) => kind === "cap"),
      );
      directSeedByTarget.set(lane.index, seed);
    }

    const failures: {
      readonly openLaneIndices: readonly number[];
      readonly targetLane: number;
      readonly seed: number | undefined;
      readonly status: ReturnType<typeof simulateDrop>["status"] | null;
      readonly restingSurface: ReturnType<typeof simulateDrop>["restingSurface"];
      readonly restingLane: number | null;
      readonly hitCap: boolean;
    }[] = [];
    let selectionCount = 0;

    for (const openLaneCount of [2, 5]) {
      for (const openLaneIndices of laneSetsOfSize(openLaneCount)) {
        const geometry = closedExcept(openLaneIndices);
        for (const targetLane of openLaneIndices) {
          const seed = directSeedByTarget.get(targetLane);
          const drop = seed === undefined ? null : selectPath(targetLane, [seed], geometry).drop;
          selectionCount += 1;
          if (
            drop === null
            || drop.restingLane !== targetLane
            || drop.status !== "rested"
            || drop.restingSurface !== "floor"
            || drop.collisions.some(({ kind }) => kind === "cap")
          ) {
            failures.push({
              openLaneIndices,
              targetLane,
              seed,
              status: drop?.status ?? null,
              restingSurface: drop?.restingSurface ?? null,
              restingLane: drop?.restingLane ?? null,
              hitCap: drop?.collisions.some(({ kind }) => kind === "cap") ?? false,
            });
          }
        }
      }
    }

    expect(selectionCount).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 180_000);

  it("rejects invalid targets and candidate seeds before attempting a drop", () => {
    expect(() => selectPath(-1, [])).toThrow("Target lane -1 is outside the board.");
    expect(() => selectPath(0.5, [])).toThrow("Target lane 0.5 is outside the board.");
    expect(() => selectPath(0, [Number.NaN])).toThrow(
      "Every candidate seed must be a safe integer.",
    );
    expect(selectPath(0, [])).toEqual({
      drop: null,
      attemptCount: 0,
      releaseXCoordinates: [],
    });
  });

  it("passes only the candidate seed and shared geometry into the simulator", async () => {
    const source = await readFile(new URL("./select.ts", import.meta.url), "utf8");

    expect(source).toMatch(/simulateDrop\(\s*candidateSeed,\s*geometry\s*\)/);
    expect(source).not.toMatch(/simulateDrop\([^)]*targetLane/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:draw|scene)\//);
    expect(source).not.toMatch(/Math\.random|Date\.|performance\.|crypto\./);
    expect(source).not.toMatch(/withClosedLanes|releasePoint\s*:/);
  });
});
