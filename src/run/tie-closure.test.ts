import { describe, expect, it } from "vitest";
import { drawTieDestination } from "../draw/draw.ts";
import type { InPlayRestaurant } from "../draw/week.ts";
import { BOARD_GEOMETRY, withClosedLanes, type BoardGeometry } from "../drop/geometry.ts";
import { selectPath } from "../drop/select.ts";
import { simulateDrop } from "../drop/simulate.ts";
import { createTally, leadingLane } from "./tally.ts";
import { closedLanesForTie, tieGeometry } from "./tie.ts";

// Every legal tie on a fifteen-lane board: all 105 two-lane sets and all 3,003
// five-lane sets. For each one the draw is restricted to the set, every other
// bucket is capped before release, the selected path rests in the lane that was
// drawn, and the tally has one unique leader after exactly one more ball.
//
// The physics is real. Each selection runs the production selector against the
// production geometry and the resting lane is read from the simulated path, not
// asserted from the target that was asked for.
//
// One seed per lane rather than a full retry stream, for a reason that holds:
// the seed for lane L is found on the board where L is the only open lane and
// all fourteen others are capped, and it is kept only if its path touches no cap
// there. Caps are the sole difference between two boards, so a cap-free path on
// that board is bit-identical on every board whose caps are a subset of those
// fourteen. Every tie board containing L is such a board, because it caps only
// lanes outside its tied set and L is inside it. The identity is asserted below
// rather than assumed. Measuring how many attempts a real stream needs belongs
// to oh-my-lunch-zyy in slice 4.

const LANE_COUNT = BOARD_GEOMETRY.laneCount;
const LANES: readonly number[] = BOARD_GEOMETRY.lanes.map(({ index }) => index);
const SEED_SEARCH_LIMIT = 4_000;

function laneSetsOfSize(size: number): readonly (readonly number[])[] {
  const sets: number[][] = [];

  const appendSets = (start: number, current: readonly number[]): void => {
    if (current.length === size) {
      sets.push([...current]);
      return;
    }
    const remaining = size - current.length;
    for (let index = start; index <= LANES.length - remaining; index += 1) {
      const laneIndex = LANES[index];
      if (laneIndex !== undefined) appendSets(index + 1, [...current, laneIndex]);
    }
  };

  appendSets(0, []);
  return sets;
}

// The board with the most caps a lane can ever face: this lane open and all
// fourteen others closed. A path that rests here without touching a lid is a
// path no lid on any tie board can change. This is a reference board for the
// seed search, not a tie, which is why it is built from the closure helper
// directly rather than through tieGeometry.
function soleOpenLaneGeometry(laneIndex: number): BoardGeometry {
  return withClosedLanes(LANES.filter((lane) => lane !== laneIndex), BOARD_GEOMETRY);
}

function capFreeSeedFor(laneIndex: number): number {
  const geometry = soleOpenLaneGeometry(laneIndex);

  for (let seed = 0; seed < SEED_SEARCH_LIMIT; seed += 1) {
    const drop = simulateDrop(seed, geometry);
    if (drop.restingLane !== laneIndex) continue;
    if (drop.collisions.some(({ kind }) => kind === "cap")) continue;
    return seed;
  }

  throw new Error(`No cap-free seed rested in lane ${laneIndex}.`);
}

function inPlayFor(laneIndices: readonly number[]): readonly InPlayRestaurant[] {
  return laneIndices.map((laneIndex) => ({
    laneIndex,
    restaurant: { name: `Restaurant ${laneIndex}` },
  }));
}

// The value that lands on a chosen member of a tied set under the equal-interval
// draw, so every member of every set gets its turn as the drawn target.
function valueForMember(position: number, size: number): number {
  return (position + 0.5) / size;
}

// The five-ball counts that produce this tie. Two tied lanes come from a
// two-two-one board, which is AE1. Five tied lanes come from one ball each,
// which is AE2.
function talliesBeforeDeciding(tiedLanes: readonly number[]): readonly number[] {
  const tally = createTally(LANE_COUNT);
  if (tiedLanes.length === 5) {
    for (const laneIndex of tiedLanes) tally.add(laneIndex);
    return tally.snapshot();
  }

  for (const laneIndex of tiedLanes) {
    tally.add(laneIndex);
    tally.add(laneIndex);
  }
  const spare = LANES.find((laneIndex) => !tiedLanes.includes(laneIndex));
  if (spare === undefined) throw new Error("No lane is left outside the tied set.");
  tally.add(spare);
  return tally.snapshot();
}

interface Failure {
  readonly tiedLanes: readonly number[];
  readonly requested: number;
  readonly reason: string;
  readonly restingLane: number | null;
  readonly leader: number | null;
}

describe("every legal tie closes and resolves in one ball", () => {
  it("keeps a cap-free path identical once the other lanes are capped", () => {
    // The claim the exhaustive sweep rests on, checked directly.
    for (const laneIndex of LANES) {
      const seed = capFreeSeedFor(laneIndex);
      const sole = simulateDrop(seed, soleOpenLaneGeometry(laneIndex));
      const wider = simulateDrop(
        seed,
        tieGeometry(LANES.filter((lane) => lane % 3 === 0 || lane === laneIndex), BOARD_GEOMETRY),
      );

      expect(sole.restingLane).toBe(laneIndex);
      expect(wider.restingLane).toBe(laneIndex);
      expect(wider.path).toEqual(sole.path);
    }
  }, 120_000);

  for (const size of [2, 5]) {
    const expectedSets = size === 2 ? 105 : 3_003;

    it(
      `covers all ${expectedSets} ${size}-lane tied sets`,
      () => {
        const capFreeSeeds = new Map(LANES.map((laneIndex) => [laneIndex, capFreeSeedFor(laneIndex)]));
        const tiedSets = laneSetsOfSize(size);
        expect(tiedSets).toHaveLength(expectedSets);

        const failures: Failure[] = [];
        let checked = 0;

        for (const tiedLanes of tiedSets) {
          const geometry = tieGeometry(tiedLanes, BOARD_GEOMETRY);
          const closed = closedLanesForTie(tiedLanes, LANE_COUNT);
          const candidates = inPlayFor(tiedLanes);
          const before = talliesBeforeDeciding(tiedLanes);

          // Every bucket outside the tied set is capped before any release.
          if (
            geometry.closedLaneIndices.length !== LANE_COUNT - size
            || geometry.caps.length !== LANE_COUNT - size
            || closed.some((laneIndex) => tiedLanes.includes(laneIndex))
          ) {
            failures.push({
              tiedLanes,
              requested: -1,
              reason: "the closed set does not cover every lane outside the tie",
              restingLane: null,
              leader: null,
            });
            continue;
          }

          for (let position = 0; position < tiedLanes.length; position += 1) {
            checked += 1;

            // The draw is restricted to the tied set.
            const drawn = drawTieDestination(candidates, valueForMember(position, size));
            const requested = drawn.laneIndex;
            if (!tiedLanes.includes(requested)) {
              failures.push({
                tiedLanes,
                requested,
                reason: "the draw returned a lane outside the tied set",
                restingLane: null,
                leader: null,
              });
              continue;
            }

            const seed = capFreeSeeds.get(requested);
            const selection = selectPath(requested, seed === undefined ? [] : [seed], geometry);
            const drop = selection.drop;
            if (
              drop === null
              || drop.status !== "rested"
              || drop.restingSurface !== "floor"
              || drop.restingLane !== requested
            ) {
              failures.push({
                tiedLanes,
                requested,
                reason: "the selected path did not rest in the requested open lane",
                restingLane: drop?.restingLane ?? null,
                leader: null,
              });
              continue;
            }

            // One more ball, counted where it actually landed, leaves one leader.
            const tally = createTally(LANE_COUNT);
            before.forEach((count, laneIndex) => {
              for (let ball = 0; ball < count; ball += 1) tally.add(laneIndex);
            });
            tally.add(drop.restingLane);
            const after = tally.snapshot();
            const leader = leadingLane(after);

            if (leader === null || leader.laneIndex !== requested || tally.total() !== 6) {
              failures.push({
                tiedLanes,
                requested,
                reason: "the tie did not resolve into a single leader",
                restingLane: drop.restingLane,
                leader: leader?.laneIndex ?? null,
              });
            }
          }
        }

        expect(checked).toBe(expectedSets * size);
        expect(failures.slice(0, 5)).toEqual([]);
        expect(failures).toHaveLength(0);
      },
      600_000,
    );
  }

  it(
    "finds a real path under caps when the first seeds miss",
    () => {
      // The sweep above hands selection a seed that hits first time. This case
      // leaves the retry loop to do its own work on the hardest board there is,
      // two open lanes, so the loop is not left unproven.
      const tiedLanes = [0, 14];
      const geometry = tieGeometry(tiedLanes, BOARD_GEOMETRY);

      for (const targetLane of tiedLanes) {
        const seeds = Array.from({ length: 4_000 }, (_, offset) => 500_000 + offset);
        const selection = selectPath(targetLane, seeds, geometry);

        expect(selection.drop).not.toBeNull();
        expect(selection.attemptCount).toBeGreaterThan(1);
        expect(selection.drop?.restingLane).toBe(targetLane);
        expect(selection.drop?.restingSurface).toBe("floor");
        // Every attempt entered the board at the same point, whatever it hit.
        expect(new Set(selection.releaseXCoordinates).size).toBe(1);
        expect(selection.releaseXCoordinates[0]).toBeCloseTo(BOARD_GEOMETRY.releasePoint.x, 10);
      }
    },
    300_000,
  );
});
