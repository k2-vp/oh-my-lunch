// The countdown phase. It lasts sixty seconds by default, opens with a short
// audible cue, and uses the wait to pick every ball's path before the first
// ball is visible. It never releases a ball; that is the drop phase. Its job is
// to summon the room and to have the whole run decided and ready to animate.
//
// Two rules from AGENTS.md live here and both break silently:
//   - The physics never decides. Each target is drawn first, then a real path
//     to that lane is selected. The draw picks the winner, never the drop.
//   - The release point never varies with the target. Selection uses a fixed
//     release, so every accepted path enters at the same point. This module
//     adds nothing that could vary release with the target: the seed streams it
//     uses depend on the ball index, never on the drawn lane.

import { drawDestination, drawTieDestination } from "../draw/draw.ts";
import type { InPlayRestaurant } from "../draw/week.ts";
import { BOARD_GEOMETRY, type BoardGeometry } from "../drop/geometry.ts";
import { selectPath } from "../drop/select.ts";
import type { DropResult } from "../drop/simulate.ts";
import { createTally, leadingLane } from "./tally.ts";
import type { AudioCue, RecordFn } from "./cue.ts";
import { runTieRound, tieGeometry, type TieRound } from "./tie.ts";

export const REGULAR_BALL_COUNT = 5;
const PATH_SELECTION_CHUNK_SIZE = 40;

export {
  CUE_DENIED_EVENT,
  createToneCue,
  playTone,
  requestCue,
  type AudioCue,
  type RecordFn,
} from "./cue.ts";
export {
  DEFAULT_COUNTDOWN_MS,
  runCountdown,
  type CountdownDeps,
  type CountdownResult,
} from "./countdown.ts";

export type BallKind = "regular" | "deciding";

export interface SelectedBall {
  readonly kind: BallKind;
  readonly targetLane: number;
  readonly targetName: string;
  readonly path: DropResult;
  readonly releaseX: number;
  readonly attemptCount: number;
}

export interface Preselection {
  /** Five regular balls, plus one deciding ball only when the five tie. */
  readonly balls: readonly SelectedBall[];
  /** The lanes that tie for the lead, or null when there is a clear leader. */
  readonly tiedLanes: readonly number[] | null;
  /** True when a selection ran out of seeds before finding its lane. */
  readonly exhausted: boolean;
}

export interface PreselectDeps {
  readonly inPlay: readonly InPlayRestaurant[];
  /** Returns the next random value in [0, 1). Injected so a run is repeatable. */
  readonly nextRandom: () => number;
  /** Candidate seed stream for the index-th selection. Never keyed on a lane. */
  readonly seedsFor: (index: number) => readonly number[];
  readonly record: RecordFn;
  readonly geometry?: BoardGeometry;
  /** Gives the countdown clock and renderer a turn between search chunks. */
  readonly yieldControl?: () => Promise<void>;
}

function yieldToNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

// Which lanes tie for the most balls. Returns null when one lane leads alone.
export function tiedLeadingLanes(lanes: readonly number[]): readonly number[] | null {
  const counts = new Map<number, number>();
  for (const lane of lanes) counts.set(lane, (counts.get(lane) ?? 0) + 1);

  let most = 0;
  for (const count of counts.values()) most = Math.max(most, count);

  const leaders: number[] = [];
  for (const [lane, count] of counts) {
    if (count === most) leaders.push(lane);
  }
  leaders.sort((a, b) => a - b);
  return leaders.length >= 2 ? Object.freeze(leaders) : null;
}

async function selectBall(
  kind: BallKind,
  index: number,
  target: InPlayRestaurant,
  deps: PreselectDeps,
  geometry: BoardGeometry,
): Promise<SelectedBall | null> {
  const seeds = deps.seedsFor(index);
  // The closed set goes in the log, so a run can be read back and shown to have
  // capped the other lanes before the deciding path was chosen rather than after.
  deps.record("simulation-started", {
    index,
    kind,
    budget: seeds.length,
    closedLanes: geometry.closedLaneIndices,
  });
  const yieldControl = deps.yieldControl ?? yieldToNextFrame;
  let attemptCount = 0;

  for (let start = 0; start < seeds.length; start += PATH_SELECTION_CHUNK_SIZE) {
    const chunk = seeds.slice(start, start + PATH_SELECTION_CHUNK_SIZE);
    const selection = selectPath(target.laneIndex, chunk, geometry);
    attemptCount += selection.attemptCount;

    if (selection.drop !== null) {
      const release = selection.drop.path[0];
      if (release === undefined) throw new Error("The selected path has no release point.");

      return {
        kind,
        targetLane: target.laneIndex,
        targetName: target.restaurant.name,
        path: selection.drop,
        releaseX: release.x,
        attemptCount,
      };
    }

    if (start + PATH_SELECTION_CHUNK_SIZE < seeds.length) {
      await yieldControl();
    }
  }

  deps.record("selection-exhausted", { index, kind, attempts: attemptCount });
  return null;
}

/**
 * Draw five regular targets and select a real path for each. The five decide
 * whether there is a tied lead. Only then is a deciding target drawn from the
 * tied set and its path selected. There is never an unconditional sixth draw.
 */
export async function preselectPaths(deps: PreselectDeps): Promise<Preselection> {
  const geometry = deps.geometry ?? BOARD_GEOMETRY;
  const balls: SelectedBall[] = [];
  const targetLanes: number[] = [];

  for (let index = 0; index < REGULAR_BALL_COUNT; index += 1) {
    const target = drawDestination(deps.inPlay, deps.nextRandom());
    deps.record("target-drawn", {
      index,
      kind: "regular",
      lane: target.laneIndex,
      name: target.restaurant.name,
    });
    targetLanes.push(target.laneIndex);

    const ball = await selectBall("regular", index, target, deps, geometry);
    if (ball === null) return { balls, tiedLanes: null, exhausted: true };
    balls.push(ball);
  }

  const tiedLanes = tiedLeadingLanes(targetLanes);
  if (tiedLanes === null) {
    return { balls, tiedLanes: null, exhausted: false };
  }

  const tiedInPlay = deps.inPlay.filter((entry) => tiedLanes.includes(entry.laneIndex));
  const deciding = drawTieDestination(tiedInPlay, deps.nextRandom());
  deps.record("target-drawn", {
    index: REGULAR_BALL_COUNT,
    kind: "deciding",
    lane: deciding.laneIndex,
    name: deciding.restaurant.name,
    tiedLanes,
  });

  // The deciding ball is selected against the capped board, not the open one.
  // Roughly one in twenty paths that rest in a lane on an open board stops
  // resting there once the tie round caps the rest, and some of those bounce off
  // a lid on the way. Choosing the path on the board the ball will actually fall
  // through is what keeps the animation honest and the tie one ball wide.
  const decidingGeometry = tieGeometry(tiedLanes, geometry);
  const ball = await selectBall(
    "deciding",
    REGULAR_BALL_COUNT,
    deciding,
    deps,
    decidingGeometry,
  );
  if (ball === null) return { balls, tiedLanes, exhausted: true };
  balls.push(ball);

  return { balls, tiedLanes, exhausted: false };
}

/**
 * Build the index-keyed seed streams a run needs. The stream depends on the
 * ball index and a base seed, never on the target lane, which is what keeps the
 * release point free of any information about the winner.
 */
export function makeSeedsFor(
  baseSeed: number,
  countPerBall: number,
  stride = 1_000_000,
): (index: number) => readonly number[] {
  return (index: number): readonly number[] => {
    const start = baseSeed + index * stride;
    return Array.from({ length: countPerBall }, (_, offset) => start + offset);
  };
}

// The drop phase. The countdown has already drawn every target and selected a
// real path to each; this releases those balls one at a time, counts each into
// its lane as it lands, and holds a pause before the next. Sequential is the
// point: the tally builds where the room can watch it and the result arrives
// with suspense instead of all at once.
//
// This coordinator decides nothing. It draws no target and holds no random
// source. It reads the pre-selected balls in order, hands each path to an
// injected renderer, and names the winner as whichever lane the counted balls
// already put ahead. A bug here can mis-animate a ball; it cannot change which
// restaurant wins.

// A default gap between one ball landing and the next releasing. The caller can
// override it; the tie round gives the deciding ball a longer beat of its own.
export const DEFAULT_INTER_BALL_PAUSE_MS = 1_200;

export interface BallLanded {
  /** Position in the release order, counting from one. */
  readonly ballNumber: number;
  /** How many balls this run drops in total: five, or six when the five tie. */
  readonly ballTotal: number;
  readonly kind: BallKind;
  readonly laneIndex: number;
  readonly name: string;
  /** The per-lane counts after this ball, one slot per lane. */
  readonly tallies: readonly number[];
}

export interface SequenceWinner {
  readonly laneIndex: number;
  readonly name: string;
  /** The final per-lane counts, one slot per lane. */
  readonly tallies: readonly number[];
}

export interface DropSequenceResult {
  readonly winner: SequenceWinner;
  readonly tallies: readonly number[];
}

export interface DropSequenceDeps {
  /** Every path chosen during the countdown, in release order. */
  readonly preselection: Preselection;
  /** Milliseconds held after a ball lands, before the next releases. */
  readonly pauseMs?: number;
  /** Animate one ball to rest. Resolves once it has landed. Injected so a test
   *  drives it without a renderer. */
  readonly animateBall: (ball: SelectedBall, index: number) => Promise<void>;
  /** Resolves after ms. Injected so a test drives the clock. */
  readonly pause: (ms: number) => Promise<void>;
  readonly record: RecordFn;
  /** Called after each ball lands, before the next releases, with the built
   *  tally, so the presenter can update the count on screen. */
  readonly onBallLanded?: (event: BallLanded) => void;
  /** Called once, after the last ball, with the single winning lane. */
  readonly onReveal?: (winner: SequenceWinner) => void;
  /** Milliseconds held before the deciding ball, in place of the inter-ball
   *  pause. Longer, because this is the ending on roughly half of all days. */
  readonly tiePauseMs?: number;
  /** The distinct cue for the deciding ball. Omitted, the round runs silent. */
  readonly tieCue?: AudioCue;
  /** Called when the tie round opens, before the deciding ball releases, with
   *  the lanes that stay open and the lanes that close. */
  readonly onTieRound?: (round: TieRound) => void;
  readonly geometry?: BoardGeometry;
}

/**
 * Release the pre-selected balls in order and build the tally as they land.
 * Each ball animates to rest before the next releases, so no two are ever in the
 * air together and the pause between them is visible. The winner is the lane the
 * counted balls put ahead; the deciding ball, when the five tie, is already in
 * the preselection and breaks the tie the moment it lands.
 */
export async function runDropSequence(deps: DropSequenceDeps): Promise<DropSequenceResult> {
  const geometry = deps.geometry ?? BOARD_GEOMETRY;
  const pauseMs = deps.pauseMs ?? DEFAULT_INTER_BALL_PAUSE_MS;
  const { balls } = deps.preselection;

  if (deps.preselection.exhausted) {
    throw new Error("The countdown could not select every path, so no ball can drop.");
  }
  if (balls.length === 0) {
    throw new Error("The countdown selected no balls to drop.");
  }

  const tally = createTally(geometry.laneCount);
  const total = balls.length;

  for (let index = 0; index < total; index += 1) {
    const ball = balls[index];
    if (ball === undefined) throw new Error(`The preselection is missing ball ${index}.`);
    const ballNumber = index + 1;

    deps.record("ball-released", {
      ballNumber,
      ballTotal: total,
      kind: ball.kind,
      lane: ball.targetLane,
      // Every ball enters from the same centre band; a run log can prove no
      // release coordinate encodes the target. The attempt count is what the
      // selector spent finding this path, recorded so a run can be read back.
      releaseX: ball.releaseX,
      attemptCount: ball.attemptCount,
    });

    // One ball is fully in flight and at rest before the next is released.
    await deps.animateBall(ball, index);

    // Count the ball only once it has landed, so the number on screen never runs
    // ahead of the balls that have come to rest.
    tally.add(ball.targetLane);
    const tallies = tally.snapshot();
    deps.record("ball-landed", {
      ballNumber,
      ballTotal: total,
      kind: ball.kind,
      lane: ball.targetLane,
      // The tally after this ball, so a run log shows the count building one
      // landing at a time rather than only the final total.
      tallies,
    });
    deps.onBallLanded?.({
      ballNumber,
      ballTotal: total,
      kind: ball.kind,
      laneIndex: ball.targetLane,
      name: ball.targetName,
      tallies,
    });

    // Hold a beat before the next ball, but not after the last one. When the
    // next ball is the deciding one, the tie round takes that beat instead: it
    // closes every lane outside the tied set, sounds its own cue, and holds
    // longer, so the ending does not arrive paced like a sixth of the same.
    if (index < total - 1) {
      const next = balls[index + 1];
      if (next !== undefined && next.kind === "deciding") {
        const tiedLanes = deps.preselection.tiedLanes;
        if (tiedLanes === null) {
          throw new Error("A deciding ball was selected without a tied set.");
        }
        // A deciding ball aimed outside the tied set would widen the tie rather
        // than settle it. Selection cannot produce one, because the lanes it
        // could reach are capped, so reaching this means the preselection and
        // the tied set disagree and the run must stop rather than drop.
        if (!tiedLanes.includes(next.targetLane)) {
          throw new Error(
            `The deciding ball targets lane ${next.targetLane}, which is not tied.`,
          );
        }
        await runTieRound({
          tiedLanes,
          tallies,
          cue: deps.tieCue,
          pauseMs: deps.tiePauseMs,
          pause: deps.pause,
          record: deps.record,
          onTieRound: deps.onTieRound,
          geometry,
        });
      } else {
        await deps.pause(pauseMs);
      }
    }
  }

  const tallies = tally.snapshot();
  const leader = leadingLane(tallies);
  if (leader === null) {
    // A run that ends still tied is a real defect in preselection, not a state to
    // paper over by naming an arbitrary lane. Surface it.
    throw new Error("The run ended with no single leader.");
  }

  const winnerBall = balls.find((entry) => entry.targetLane === leader.laneIndex);
  if (winnerBall === undefined) {
    throw new Error(`No ball targeted the leading lane ${leader.laneIndex}.`);
  }

  const winner: SequenceWinner = {
    laneIndex: leader.laneIndex,
    name: winnerBall.targetName,
    tallies,
  };
  deps.record("winner-revealed", {
    lane: winner.laneIndex,
    name: winner.name,
    count: leader.count,
  });
  deps.onReveal?.(winner);

  return { winner, tallies };
}
