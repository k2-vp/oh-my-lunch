import { describe, expect, it, vi } from "vitest";
import { BOARD_GEOMETRY } from "../drop/geometry.ts";
import type { InPlayRestaurant } from "../draw/week.ts";
import { simulateDrop, type DropResult } from "../drop/simulate.ts";
import { tieGeometry } from "./tie.ts";
import {
  CUE_DENIED_EVENT,
  DEFAULT_COUNTDOWN_MS,
  DEFAULT_INTER_BALL_PAUSE_MS,
  makeSeedsFor,
  preselectPaths,
  runCountdown,
  runDropSequence,
  tiedLeadingLanes,
  type BallKind,
  type Preselection,
  type PreselectDeps,
  type SelectedBall,
  type SequenceWinner,
} from "./sequence.ts";

interface Logged {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

function collector(): { record: PreselectDeps["record"]; events: Logged[] } {
  const events: Logged[] = [];
  return {
    events,
    record: (name, data = {}) => {
      events.push({ name, data });
    },
  };
}

// Random values that map to specific lanes through drawDestination, which
// splits [0, 1) into equal slices, one per in-play entry.
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

function makeInPlay(count = 15): InPlayRestaurant[] {
  return Array.from({ length: count }, (_, laneIndex) => ({
    laneIndex,
    restaurant: { name: `Restaurant ${laneIndex}` },
  }));
}

const okCue = { play: (): Promise<void> => Promise.resolve() };

function seedsAfterMisses(
  targetLane: number,
  missCount: number,
  geometry = BOARD_GEOMETRY,
): readonly number[] {
  const misses: number[] = [];

  for (let seed = 0; seed < 20_000; seed += 1) {
    if (simulateDrop(seed, geometry).restingLane === targetLane) {
      if (misses.length >= missCount) return [...misses, seed];
    } else if (misses.length < missCount) {
      misses.push(seed);
    }
  }

  throw new Error(`No path to lane ${targetLane} followed ${missCount} misses.`);
}

describe("tiedLeadingLanes", () => {
  it("returns null when one lane leads alone", () => {
    expect(tiedLeadingLanes([3, 3, 3, 8, 10])).toBeNull();
    expect(tiedLeadingLanes([5, 5, 5, 5, 5])).toBeNull();
  });

  it("returns the tied lanes when two share the lead", () => {
    expect(tiedLeadingLanes([2, 2, 7, 7, 11])).toEqual([2, 7]);
  });

  it("returns all five when every ball lands in its own lane", () => {
    expect(tiedLeadingLanes([4, 5, 6, 7, 8])).toEqual([4, 5, 6, 7, 8]);
  });
});

describe("preselectPaths", () => {
  it("makes exactly five draws and selections for a clear leader", async () => {
    const { record, events } = collector();
    const result = await preselectPaths({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([3, 3, 3, 8, 10].map((lane) => laneValue(lane, 15))),
      seedsFor: makeSeedsFor(1, 4000),
      record,
    });

    expect(result.exhausted).toBe(false);
    expect(result.tiedLanes).toBeNull();
    expect(result.balls).toHaveLength(5);
    expect(result.balls.every((ball) => ball.kind === "regular")).toBe(true);

    expect(events.filter((event) => event.name === "target-drawn")).toHaveLength(5);
    expect(events.filter((event) => event.name === "simulation-started")).toHaveLength(5);
  });

  it("adds one deciding ball drawn from the tied set on a tie", async () => {
    const { record, events } = collector();
    const regular = [2, 2, 7, 7, 11].map((lane) => laneValue(lane, 15));
    // Two lanes tie (2 and 7); the deciding value 0.75 lands on the second, lane 7.
    const result = await preselectPaths({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([...regular, 0.75]),
      seedsFor: makeSeedsFor(1, 4000),
      record,
    });

    expect(result.exhausted).toBe(false);
    expect(result.tiedLanes).toEqual([2, 7]);
    expect(result.balls).toHaveLength(6);

    const deciding = result.balls[5];
    expect(deciding?.kind).toBe("deciding");
    expect(result.tiedLanes).toContain(deciding?.targetLane);

    const decidingDraw = events.find(
      (event) => event.name === "target-drawn" && event.data.kind === "deciding",
    );
    expect(decidingDraw?.data.tiedLanes).toEqual([2, 7]);
    expect(events.filter((event) => event.name === "target-drawn")).toHaveLength(6);
  });

  it("draws each target before its own simulation", async () => {
    const { record, events } = collector();
    await preselectPaths({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([4, 5, 6, 7, 8].map((lane) => laneValue(lane, 15)).concat(0.1)),
      seedsFor: makeSeedsFor(1, 4000),
      record,
    });

    // For every index that has a simulation, its draw came first.
    const order = events.filter(
      (event) => event.name === "target-drawn" || event.name === "simulation-started",
    );
    const drawnBefore = new Set<number>();
    for (const event of order) {
      const index = event.data.index as number;
      if (event.name === "target-drawn") drawnBefore.add(index);
      else expect(drawnBefore.has(index)).toBe(true);
    }
  });

  it("gives every ball the same release point regardless of its target lane", async () => {
    // A clear leader (lane 3) so there is no deciding draw, but the balls still
    // target three different lanes: 3, 9, and 6.
    const result = await preselectPaths({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([3, 3, 3, 9, 6].map((lane) => laneValue(lane, 15))),
      seedsFor: makeSeedsFor(1, 4000),
      record: () => {},
    });

    expect(result.exhausted).toBe(false);
    const releaseValues = new Set(result.balls.map((ball) => ball.releaseX));
    expect(releaseValues.size).toBe(1);
    expect([...releaseValues][0]).toBeCloseTo(BOARD_GEOMETRY.releasePoint.x, 10);
  });
});

describe("runCountdown timing", () => {
  it("keeps one-second ticks moving through capped tie path selection", async () => {
    const regularLanes = [2, 2, 7, 7, 11];
    const tiedLanes = [2, 7];
    const regularSeeds = regularLanes.map((lane) => seedsAfterMisses(lane, 0));
    const decidingSeeds = seedsAfterMisses(7, 80, tieGeometry(tiedLanes));

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const tickTimes: number[] = [];
      let pathsSelectedAt: number | undefined;

      const countdown = runCountdown({
        inPlay: makeInPlay(),
        nextRandom: randomsFrom(
          regularLanes.map((lane) => laneValue(lane, 15)).concat(0.75),
        ),
        seedsFor: (index) => regularSeeds[index] ?? decidingSeeds,
        record: (name) => {
          if (name === "paths-selected") pathsSelectedAt = Date.now() - startedAt;
        },
        cue: okCue,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onTick: () => tickTimes.push(Date.now() - startedAt),
        yieldControl: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_COUNTDOWN_MS);
      const result = await countdown;

      expect(result.preselection.tiedLanes).toEqual(tiedLanes);
      expect(pathsSelectedAt).toBe(2_000);
      expect(tickTimes.slice(0, 3)).toEqual([0, 1_000, 2_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces selection exhaustion before the countdown clock finishes", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const ticks: number[] = [];
      let clockWaitCompleted = false;
      let result: Awaited<ReturnType<typeof runCountdown>> | undefined;

      void runCountdown({
        inPlay: makeInPlay(),
        nextRandom: randomsFrom([laneValue(3, 15)]),
        seedsFor: () => [],
        record: (name) => events.push(name),
        cue: okCue,
        delay: (ms) => new Promise((resolve) => {
          setTimeout(() => {
            clockWaitCompleted = true;
            resolve();
          }, ms);
        }),
        onTick: (secondsRemaining) => ticks.push(secondsRemaining),
      }).then((countdownResult) => {
        result = countdownResult;
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(result?.preselection.exhausted).toBe(true);
      expect(clockWaitCompleted).toBe(false);
      expect(ticks).toEqual([60]);
      expect(events).toContain("selection-exhausted");
      expect(events).not.toContain("countdown-complete");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("completes at sixty seconds when the cue takes five seconds", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const eventTimes = new Map<string, number>();
      let result: Awaited<ReturnType<typeof runCountdown>> | undefined;

      void runCountdown({
        inPlay: makeInPlay(),
        nextRandom: randomsFrom([3, 3, 3, 8, 10].map((lane) => laneValue(lane, 15))),
        seedsFor: makeSeedsFor(1, 4000),
        record: (name) => eventTimes.set(name, Date.now() - startedAt),
        cue: {
          play: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
        },
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        yieldControl: () => Promise.resolve(),
      }).then((countdownResult) => {
        result = countdownResult;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_COUNTDOWN_MS);

      expect(eventTimes.get("paths-selected")).toBe(5_000);
      expect(eventTimes.get("countdown-complete")).toBe(DEFAULT_COUNTDOWN_MS);
      expect(result?.preselection.balls).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds for exactly sixty seconds by default and completes after the wait", async () => {
    const { record, events } = collector();
    const waits: number[] = [];
    const ticks: number[] = [];

    const result = await runCountdown({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([3, 3, 3, 8, 10].map((lane) => laneValue(lane, 15))),
      seedsFor: makeSeedsFor(1, 4000),
      record,
      cue: okCue,
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      onTick: (secondsRemaining) => ticks.push(secondsRemaining),
    });

    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(DEFAULT_COUNTDOWN_MS);
    expect(ticks[0]).toBe(60);
    expect(ticks.at(-1)).toBe(0);
    expect(result.preselection.balls).toHaveLength(5);

    // The countdown completes only after every wait, so nothing drops early.
    const names = events.map((event) => event.name);
    expect(names.at(-1)).toBe("countdown-complete");
    expect(names.indexOf("paths-selected")).toBeLessThan(names.indexOf("countdown-complete"));
  });

  it("records the named diagnostic and keeps running when the cue is denied", async () => {
    const { record, events } = collector();
    const result = await runCountdown({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom([3, 3, 3, 8, 10].map((lane) => laneValue(lane, 15))),
      seedsFor: makeSeedsFor(1, 4000),
      record,
      cue: { play: () => Promise.reject(new Error("blocked")) },
      delay: () => Promise.resolve(),
    });

    expect(result.cuePlayed).toBe(false);
    expect(events.some((event) => event.name === CUE_DENIED_EVENT)).toBe(true);
    expect(events.some((event) => event.name === "countdown-complete")).toBe(true);
  });
});

// A pre-selected ball with a throwaway path. The drop sequence never reads the
// path itself; it hands it to the injected renderer, which these tests stub. So
// the path only has to satisfy the type.
function makeBall(lane: number, kind: BallKind = "regular"): SelectedBall {
  const drop: DropResult = {
    seed: lane,
    status: "rested",
    path: [
      { time: 0, x: 0, y: 5 },
      { time: 1, x: 0, y: 0 },
    ],
    collisions: [],
    restingSurface: "floor",
    restingLane: lane,
  };
  return {
    kind,
    targetLane: lane,
    targetName: `Restaurant ${lane}`,
    path: drop,
    releaseX: 0,
    attemptCount: 1,
  };
}

// Build a preselection from a list of landing lanes. When tiedLanes is given,
// the last lane is the deciding ball, matching what the countdown produces on a
// tie.
function preselectionOf(
  lanes: readonly number[],
  tiedLanes: readonly number[] | null = null,
): Preselection {
  const balls = lanes.map((lane, index) =>
    makeBall(lane, tiedLanes !== null && index === lanes.length - 1 ? "deciding" : "regular"),
  );
  return { balls, tiedLanes, exhausted: false };
}

describe("runDropSequence", () => {
  it("releases five balls one at a time, counting each as it lands", async () => {
    const { record } = collector();
    const log: string[] = [];
    let landed = 0;
    let inFlight = false;

    const result = await runDropSequence({
      preselection: preselectionOf([3, 3, 3, 8, 10]),
      pauseMs: 1_200,
      record,
      animateBall: async (_ball, index) => {
        // Before this ball flies, every earlier ball has landed and been counted.
        expect(landed).toBe(index);
        expect(inFlight).toBe(false);
        inFlight = true;
        log.push(`release ${index}`);
        // Yield a microtask; any second animation starting here would overlap.
        await Promise.resolve();
        inFlight = false;
      },
      pause: (ms) => {
        expect(inFlight).toBe(false);
        log.push(`pause ${ms}`);
        return Promise.resolve();
      },
      onBallLanded: (event) => {
        landed += 1;
        expect(event.ballNumber).toBe(landed);
        // The just-counted lane already shows the ball that landed.
        expect(event.tallies[event.laneIndex]).toBeGreaterThanOrEqual(1);
        log.push(`land ${event.ballNumber}`);
      },
      onReveal: (winner) => log.push(`reveal ${winner.laneIndex}`),
    });

    expect(log).toEqual([
      "release 0", "land 1", "pause 1200",
      "release 1", "land 2", "pause 1200",
      "release 2", "land 3", "pause 1200",
      "release 3", "land 4", "pause 1200",
      "release 4", "land 5",
      "reveal 3",
    ]);
    expect(log.filter((entry) => entry.startsWith("release"))).toHaveLength(5);
    expect(log.filter((entry) => entry.startsWith("pause"))).toHaveLength(4);
    expect(result.winner.laneIndex).toBe(3);
  });

  it("holds the configured pause between landings and never after the last", async () => {
    const pauses: number[] = [];
    await runDropSequence({
      preselection: preselectionOf([7, 7, 7, 2, 5]),
      pauseMs: 800,
      record: () => {},
      animateBall: () => Promise.resolve(),
      pause: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    expect(pauses).toEqual([800, 800, 800, 800]);
  });

  it("uses the default pause when the caller sets none", async () => {
    const pauses: number[] = [];
    await runDropSequence({
      preselection: preselectionOf([6, 6, 6, 1, 2]),
      record: () => {},
      animateBall: () => Promise.resolve(),
      pause: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    expect(pauses).toEqual([
      DEFAULT_INTER_BALL_PAUSE_MS,
      DEFAULT_INTER_BALL_PAUSE_MS,
      DEFAULT_INTER_BALL_PAUSE_MS,
      DEFAULT_INTER_BALL_PAUSE_MS,
    ]);
  });

  it("reveals and holds the restaurant the counted balls put ahead", async () => {
    const reveals: SequenceWinner[] = [];
    const result = await runDropSequence({
      preselection: preselectionOf([3, 3, 3, 8, 10]),
      record: () => {},
      animateBall: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      onReveal: (winner) => reveals.push(winner),
    });

    expect(reveals).toHaveLength(1);
    expect(reveals[0]?.laneIndex).toBe(3);
    expect(reveals[0]?.name).toBe("Restaurant 3");
    expect(result.winner).toEqual({ laneIndex: 3, name: "Restaurant 3", tallies: result.tallies });
    expect(result.tallies[3]).toBe(3);
  });

  it("drops the deciding ball last and lets it break the tie", async () => {
    const { record, events } = collector();
    const kinds: string[] = [];
    // Lanes 2 and 7 tie at two; the deciding ball lands in lane 7.
    const result = await runDropSequence({
      preselection: preselectionOf([2, 2, 7, 7, 11, 7], [2, 7]),
      record,
      animateBall: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      onBallLanded: (event) => kinds.push(event.kind),
    });

    expect(kinds).toEqual(["regular", "regular", "regular", "regular", "regular", "deciding"]);
    expect(result.winner.laneIndex).toBe(7);
    expect(result.tallies[7]).toBe(3);
    expect(result.tallies[2]).toBe(2);

    const decidingLanded = events.find(
      (event) => event.name === "ball-landed" && event.data.kind === "deciding",
    );
    expect(decidingLanded?.data.ballNumber).toBe(6);
    expect(decidingLanded?.data.ballTotal).toBe(6);
  });

  it("names the winner from the pre-selected targets, adding no draw of its own", async () => {
    // Same preselection twice gives the same winner: the coordinator holds no
    // random source and re-picks nothing.
    const preselection = preselectionOf([9, 9, 4, 9, 1]);
    const run = (): Promise<{ winner: SequenceWinner }> =>
      runDropSequence({
        preselection,
        record: () => {},
        animateBall: () => Promise.resolve(),
        pause: () => Promise.resolve(),
      });

    const first = await run();
    const second = await run();
    expect(first.winner).toEqual(second.winner);
    expect(first.winner.laneIndex).toBe(9);
  });

  it("refuses to drop when the countdown could not select every path", async () => {
    await expect(
      runDropSequence({
        preselection: { balls: [], tiedLanes: null, exhausted: true },
        record: () => {},
        animateBall: () => Promise.resolve(),
        pause: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/could not select/);
  });

  it("surfaces a run that ends tied rather than naming an arbitrary lane", async () => {
    // A malformed preselection: five balls two-two tied with no deciding ball.
    await expect(
      runDropSequence({
        preselection: {
          balls: [makeBall(2), makeBall(2), makeBall(7), makeBall(7), makeBall(11)],
          tiedLanes: null,
          exhausted: false,
        },
        record: () => {},
        animateBall: () => Promise.resolve(),
        pause: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/no single leader/);
  });
});
