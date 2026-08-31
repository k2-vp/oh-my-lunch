import { describe, expect, it } from "vitest";
import { BOARD_GEOMETRY } from "../drop/geometry.ts";
import { selectPath } from "../drop/select.ts";
import { simulateDrop } from "../drop/simulate.ts";
import type { InPlayRestaurant } from "../draw/week.ts";
import { leadingLane } from "./tally.ts";
import {
  DEFAULT_INTER_BALL_PAUSE_MS,
  preselectPaths,
  runDropSequence,
  type SelectedBall,
} from "./sequence.ts";
import {
  closedLanesForTie,
  runTieRound,
  TIE_CUE_DENIED_EVENT,
  TIE_PAUSE_MS,
  tieGeometry,
} from "./tie.ts";

interface Logged {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

function collector(): { record: (name: string, data?: Record<string, unknown>) => void; events: Logged[] } {
  const events: Logged[] = [];
  return { events, record: (name, data = {}) => events.push({ name, data }) };
}

function makeInPlay(count = 15): InPlayRestaurant[] {
  return Array.from({ length: count }, (_, laneIndex) => ({
    laneIndex,
    restaurant: { name: `Restaurant ${laneIndex}` },
  }));
}

// A random value that maps to a chosen lane through the equal-interval draw.
function laneValue(lane: number, total: number): number {
  return (lane + 0.5) / total;
}

function randomsFrom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error(`Ran out of random values at ${index}.`);
    index += 1;
    return value;
  };
}

// Seed windows wide enough that a rare lane still has a real path inside its
// own window. Every window is keyed on the ball index, never on the lane.
function seedsFor(index: number): readonly number[] {
  const start = 1 + index * 1_000_000;
  return Array.from({ length: 6_000 }, (_, offset) => start + offset);
}

interface RunTrace {
  readonly events: Logged[];
  readonly pauses: number[];
  readonly released: SelectedBall[];
  readonly tieRounds: { tiedLanes: readonly number[]; closedLanes: readonly number[] }[];
  readonly winner: { laneIndex: number; name: string; tallies: readonly number[] };
  readonly preselection: Awaited<ReturnType<typeof preselectPaths>>;
}

/**
 * A whole run on the fake clock: the real draw picks every target, the real
 * selector finds every path, and the real tie round closes the board. Only the
 * animation and the clock are injected.
 */
async function runToWinner(regularLanes: readonly number[], decidingValue: number): Promise<RunTrace> {
  const { record, events } = collector();
  const inPlay = makeInPlay();
  const preselection = await preselectPaths({
    inPlay,
    nextRandom: randomsFrom([
      ...regularLanes.map((lane) => laneValue(lane, inPlay.length)),
      decidingValue,
    ]),
    seedsFor,
    record,
  });

  const pauses: number[] = [];
  const released: SelectedBall[] = [];
  const tieRounds: RunTrace["tieRounds"] = [];

  const result = await runDropSequence({
    preselection,
    record,
    animateBall: (ball) => {
      released.push(ball);
      return Promise.resolve();
    },
    pause: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    onTieRound: (round) => {
      tieRounds.push({ tiedLanes: round.tiedLanes, closedLanes: round.closedLanes });
    },
  });

  return { events, pauses, released, tieRounds, winner: result.winner, preselection };
}

function names(events: readonly Logged[]): string[] {
  return events.map((event) => event.name);
}

describe("closing the lanes outside a tie", () => {
  it("closes every lane that is not tied and leaves the tied lanes open", () => {
    const tied = [2, 7];
    const closed = closedLanesForTie(tied, BOARD_GEOMETRY.laneCount);

    expect(closed).toHaveLength(BOARD_GEOMETRY.laneCount - tied.length);
    expect(closed).not.toContain(2);
    expect(closed).not.toContain(7);
    expect([...closed, ...tied].sort((left, right) => left - right)).toEqual(
      BOARD_GEOMETRY.lanes.map(({ index }) => index),
    );
  });

  it("gives every closed lane a solid cap over its whole opening", () => {
    const geometry = tieGeometry([4, 5, 6, 7, 8]);

    expect(geometry.closedLaneIndices).toEqual([0, 1, 2, 3, 9, 10, 11, 12, 13, 14]);
    expect(geometry.caps).toHaveLength(10);
    for (const cap of geometry.caps) {
      const lane = geometry.lanes[cap.laneIndex];
      expect(lane).toBeDefined();
      if (lane === undefined) continue;
      expect(cap.bounds.minX).toBe(lane.opening.minX);
      expect(cap.bounds.maxX).toBe(lane.opening.maxX);
    }
  });

  it("refuses a tied set that is too small, repeated, or off the board", () => {
    expect(() => closedLanesForTie([3], 15)).toThrow("A tie needs at least two lanes.");
    expect(() => closedLanesForTie([3, 3], 15)).toThrow("A tied lane cannot appear twice.");
    expect(() => closedLanesForTie([3, 15], 15)).toThrow("Tied lane 15 is outside the board.");
    expect(() => closedLanesForTie([3, -1], 15)).toThrow("Tied lane -1 is outside the board.");
  });

  it("makes every lane outside the tied set an impossible target", () => {
    const geometry = tieGeometry([2, 7]);
    for (const laneIndex of geometry.closedLaneIndices) {
      expect(() => selectPath(laneIndex, [1], geometry)).toThrow(
        `Target lane ${laneIndex} is closed.`,
      );
    }
  });

  // The defect this bead inherited. A path chosen on the open board can stop
  // resting in its lane once the tie caps exist, so selection has to run against
  // the capped board rather than be handed a path picked on the open one.
  it("rejects a path that only rests in the target while the other lanes are open", () => {
    const tied = [2, 7];
    const geometry = tieGeometry(tied);
    let fragileSeed: number | null = null;

    for (let seed = 0; seed < 2_000 && fragileSeed === null; seed += 1) {
      const open = simulateDrop(seed, BOARD_GEOMETRY);
      if (open.restingLane !== 2) continue;
      if (simulateDrop(seed, geometry).restingLane !== 2) fragileSeed = seed;
    }

    expect(fragileSeed).not.toBeNull();
    if (fragileSeed === null) return;

    expect(selectPath(2, [fragileSeed], BOARD_GEOMETRY).drop).not.toBeNull();
    expect(selectPath(2, [fragileSeed], geometry).drop).toBeNull();
  });
});

describe("the tie round beat", () => {
  it("holds longer than the gap between balls one through five", () => {
    expect(TIE_PAUSE_MS).toBeGreaterThan(DEFAULT_INTER_BALL_PAUSE_MS);
  });

  it("closes the lanes before it sounds the cue or holds the pause", async () => {
    const { record, events } = collector();
    const order: string[] = [];

    await runTieRound({
      tiedLanes: [2, 7],
      tallies: new Array<number>(15).fill(0),
      cue: {
        play: () => {
          order.push("cue");
          return Promise.resolve();
        },
      },
      pause: (ms) => {
        order.push(`pause:${ms}`);
        return Promise.resolve();
      },
      record,
      onTieRound: () => order.push("lanes-closed"),
    });

    expect(order).toEqual(["lanes-closed", "cue", `pause:${TIE_PAUSE_MS}`]);
    expect(names(events)).toEqual([
      "tie-round-opened",
      "tie-cue-requested",
      "tie-cue-played",
      "tie-round-ready",
    ]);
  });

  it("reports a denied cue under its own name and still holds the beat", async () => {
    const { record, events } = collector();
    let paused = 0;

    const round = await runTieRound({
      tiedLanes: [0, 14],
      tallies: new Array<number>(15).fill(0),
      cue: { play: () => Promise.reject(new Error("blocked")) },
      pause: (ms) => {
        paused += ms;
        return Promise.resolve();
      },
      record,
    });

    expect(names(events)).toContain(TIE_CUE_DENIED_EVENT);
    expect(names(events).at(-1)).toBe("tie-round-ready");
    expect(paused).toBe(TIE_PAUSE_MS);
    expect(round.closedLanes).toHaveLength(13);
  });
});

describe("resolving a tie in one ball", () => {
  it(
    "covers AE1: a two-two-one board closes the rest and resolves into a lit lane",
    async () => {
      const tied = [2, 7];
      const trace = await runToWinner([2, 2, 7, 7, 11], laneValue(0, tied.length));

      expect(trace.preselection.tiedLanes).toEqual(tied);
      expect(trace.released).toHaveLength(6);
      expect(trace.released.filter((ball) => ball.kind === "deciding")).toHaveLength(1);

      // Every other lane closes, and the deciding ball lands in a tied one.
      expect(trace.tieRounds).toHaveLength(1);
      expect(trace.tieRounds[0]?.tiedLanes).toEqual(tied);
      expect(trace.tieRounds[0]?.closedLanes).toEqual(closedLanesForTie(tied, 15));

      const deciding = trace.released[5];
      expect(deciding?.kind).toBe("deciding");
      expect(tied).toContain(deciding?.targetLane);
      expect(deciding?.path.restingLane).toBe(deciding?.targetLane);

      // One unique leader, and the tie is no wider than it started.
      expect(leadingLane(trace.winner.tallies)?.laneIndex).toBe(deciding?.targetLane);
      expect(trace.winner.laneIndex).toBe(deciding?.targetLane);
      expect(trace.winner.tallies.reduce((sum, count) => sum + count, 0)).toBe(6);
    },
    60_000,
  );

  it(
    "covers AE2: five balls in five lanes closes the other ten and one ball decides",
    async () => {
      const tied = [4, 5, 6, 7, 8];
      const trace = await runToWinner(tied, laneValue(3, tied.length));

      expect(trace.preselection.tiedLanes).toEqual(tied);
      expect(trace.released).toHaveLength(6);
      expect(trace.tieRounds[0]?.closedLanes).toHaveLength(10);

      const deciding = trace.released[5];
      expect(deciding?.kind).toBe("deciding");
      expect(tied).toContain(deciding?.targetLane);

      const leader = leadingLane(trace.winner.tallies);
      expect(leader?.laneIndex).toBe(deciding?.targetLane);
      expect(leader?.count).toBe(2);
      expect(trace.winner.laneIndex).toBe(deciding?.targetLane);
    },
    60_000,
  );

  it(
    "caps the other lanes before the deciding path is chosen, not after",
    async () => {
      const tied = [2, 7];
      const trace = await runToWinner([2, 2, 7, 7, 11], laneValue(1, tied.length));
      const closed = closedLanesForTie(tied, 15);

      // The five regular balls are chosen on the open board.
      const simulations = trace.events.filter((event) => event.name === "simulation-started");
      expect(simulations).toHaveLength(6);
      for (const simulation of simulations.slice(0, 5)) {
        expect(simulation.data.closedLanes).toEqual([]);
      }

      // The deciding ball is chosen on the capped one, and its path is the path
      // the capped board actually produces.
      const decidingSimulation = simulations[5];
      expect(decidingSimulation?.data.kind).toBe("deciding");
      expect(decidingSimulation?.data.closedLanes).toEqual(closed);

      const deciding = trace.released[5];
      expect(deciding).toBeDefined();
      if (deciding === undefined) return;
      // Bouncing off a lid on the way down is honest physics on a capped board.
      // What must hold is that the path is the one the capped board produces and
      // that it comes to rest on the floor of the drawn lane.
      expect(deciding.path).toEqual(simulateDrop(deciding.path.seed, tieGeometry(tied)));
      expect(deciding.path.restingSurface).toBe("floor");
      expect(deciding.path.restingLane).toBe(deciding.targetLane);
    },
    60_000,
  );

  it(
    "gives the deciding ball a longer beat than any ball before it",
    async () => {
      const trace = await runToWinner([2, 2, 7, 7, 11], laneValue(0, 2));

      // Four ordinary gaps between balls one through five, then the tie beat.
      expect(trace.pauses).toEqual([
        DEFAULT_INTER_BALL_PAUSE_MS,
        DEFAULT_INTER_BALL_PAUSE_MS,
        DEFAULT_INTER_BALL_PAUSE_MS,
        DEFAULT_INTER_BALL_PAUSE_MS,
        TIE_PAUSE_MS,
      ]);
      const beat = trace.pauses.at(-1) ?? 0;
      for (const pause of trace.pauses.slice(0, -1)) {
        expect(beat).toBeGreaterThan(pause);
      }

      // The beat lands after the fifth ball and before the deciding release.
      const order = names(trace.events);
      const opened = order.indexOf("tie-round-opened");
      const ready = order.indexOf("tie-round-ready");
      const releases = order.flatMap((name, index) => name === "ball-released" ? [index] : []);
      expect(opened).toBeGreaterThan(releases[4] ?? -1);
      expect(ready).toBeLessThan(releases[5] ?? -1);
    },
    60_000,
  );

  it(
    "runs no tie round and drops five balls when one lane leads alone",
    async () => {
      const trace = await runToWinner([3, 3, 3, 8, 10], 0.5);

      expect(trace.preselection.tiedLanes).toBeNull();
      expect(trace.released).toHaveLength(5);
      expect(trace.tieRounds).toEqual([]);
      expect(names(trace.events)).not.toContain("tie-round-opened");
      expect(trace.pauses).toEqual(new Array<number>(4).fill(DEFAULT_INTER_BALL_PAUSE_MS));
      expect(trace.winner.laneIndex).toBe(3);
    },
    60_000,
  );

  it("stops the run rather than drop a deciding ball aimed outside the tied set", async () => {
    const { record } = collector();
    const inPlay = makeInPlay();
    const preselection = await preselectPaths({
      inPlay,
      nextRandom: randomsFrom(
        [2, 2, 7, 7, 11].map((lane) => laneValue(lane, inPlay.length)).concat(0.25),
      ),
      seedsFor,
      record,
    });

    const deciding = preselection.balls[5];
    expect(deciding).toBeDefined();
    if (deciding === undefined) return;
    const strayed = {
      ...preselection,
      balls: [...preselection.balls.slice(0, 5), { ...deciding, targetLane: 11 }],
    };

    await expect(runDropSequence({
      preselection: strayed,
      record,
      animateBall: () => Promise.resolve(),
      pause: () => Promise.resolve(),
    })).rejects.toThrow("The deciding ball targets lane 11, which is not tied.");
  }, 60_000);
});
