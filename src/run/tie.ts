// The tie round. When the five balls leave two or more lanes level at the top,
// every lane outside the tied set is capped, one more ball drawn from the tied
// set alone drops, and it decides the day.
//
// Closure here is geometry, not lighting. A capped lane cannot receive a ball,
// so the deciding ball has to land inside the tied set and the tie always
// resolves in one ball. If the caps were only a change of colour the deciding
// ball could land in a dark lane and widen the tie instead of settling it: a
// two-two-one board becomes two-two-two, and the run stalls on screen in front
// of the whole group with nothing defined to do next.
//
// The round also gets its own beat, a longer pause and a cue of its own. Some
// tie ends roughly half of all real days, so pacing the deciding ball like balls
// one through five would make the common ending read as an afterthought.
//
// This module closes lanes and keeps time. It draws no target and picks no
// winner, so a bug here can mis-pace the board but cannot change which
// restaurant wins.

import { BOARD_GEOMETRY, withClosedLanes, type BoardGeometry } from "../drop/geometry.ts";
import { CUE_DENIED_EVENT, requestCue, type AudioCue, type RecordFn } from "./cue.ts";

// The beat before the deciding ball. Longer than the gap between balls one
// through five, which is what marks this ball as the ending rather than a sixth
// of the same. src/run/tie.test.ts holds that relationship to the inter-ball
// pause so neither can drift past the other unnoticed.
export const TIE_PAUSE_MS = 3_600;

// The tie cue's events are the ordinary cue events under a prefix, so a log can
// tell the deciding ball's cue from the one that opened the countdown.
export const TIE_CUE_DENIED_EVENT = `tie-${CUE_DENIED_EVENT}`;

// Two rising notes, where the countdown cue is one. The pair is what makes it
// audibly a different signal rather than the same bell again.
const TIE_NOTE_SECONDS = 0.28;
const TIE_NOTES: readonly { readonly frequency: number; readonly startOffset: number }[] =
  Object.freeze([
    Object.freeze({ frequency: 440, startOffset: 0 }),
    Object.freeze({ frequency: 660, startOffset: 0.34 }),
  ]);

export interface TieRound {
  /** The lanes level at the top. They stay lit and stay open. */
  readonly tiedLanes: readonly number[];
  /** Every other lane. These are capped before the deciding ball releases. */
  readonly closedLanes: readonly number[];
  /** The per-lane counts the five balls left behind, one slot per lane. */
  readonly tallies: readonly number[];
}

function validateTiedLanes(
  tiedLanes: readonly number[],
  laneCount: number,
): readonly number[] {
  const unique = new Set(tiedLanes);
  if (unique.size !== tiedLanes.length) {
    throw new RangeError("A tied lane cannot appear twice.");
  }
  if (unique.size < 2) {
    throw new RangeError("A tie needs at least two lanes.");
  }
  for (const laneIndex of unique) {
    if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= laneCount) {
      throw new RangeError(`Tied lane ${laneIndex} is outside the board.`);
    }
  }
  return Object.freeze([...unique].sort((left, right) => left - right));
}

/**
 * Every lane that is not tied, which is every lane the tie round closes. The
 * complement is taken from the whole board, so a lane can only stay open by
 * being in the tied set.
 */
export function closedLanesForTie(
  tiedLanes: readonly number[],
  laneCount: number = BOARD_GEOMETRY.laneCount,
): readonly number[] {
  const tied = new Set(validateTiedLanes(tiedLanes, laneCount));
  return Object.freeze(
    Array.from({ length: laneCount }, (_, laneIndex) => laneIndex)
      .filter((laneIndex) => !tied.has(laneIndex)),
  );
}

/**
 * The board the deciding ball actually falls through: the shared geometry with a
 * solid cap over every lane outside the tied set. Selection runs against this,
 * not against the open board, so a path that would have slipped past a lid is
 * never chosen in the first place.
 */
export function tieGeometry(
  tiedLanes: readonly number[],
  geometry: BoardGeometry = BOARD_GEOMETRY,
): BoardGeometry {
  return withClosedLanes(closedLanesForTie(tiedLanes, geometry.laneCount), geometry);
}

// The tie cue: two short sine notes, rising. Kept separate from the cue itself
// so it can render through any audio context, including an offline one in a
// test, without depending on autoplay permission.
export function playTieTone(audio: BaseAudioContext, startTime?: number): void {
  const start = startTime ?? audio.currentTime;

  for (const note of TIE_NOTES) {
    const noteStart = start + note.startOffset;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;

    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.2, noteStart + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + TIE_NOTE_SECONDS - 0.02);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + TIE_NOTE_SECONDS);
  }
}

/**
 * The default tie cue: the two notes above through a real-time audio context.
 * By the time a tie round runs, the countdown has already resolved whether audio
 * is allowed, so this plays into a context that is running or reports itself
 * unavailable and lets the round carry on.
 */
export function createTieCue(context?: AudioContext): AudioCue {
  return {
    async play(): Promise<void> {
      const audio = context ?? new AudioContext();
      if (audio.state !== "running") throw new Error("Audio playback was blocked.");
      playTieTone(audio);
    },
  };
}

export interface TieRoundDeps {
  /** The lanes level at the top, from the tally the five balls built. */
  readonly tiedLanes: readonly number[];
  /** The per-lane counts at the moment the fifth ball came to rest. */
  readonly tallies: readonly number[];
  // The three optional fields below accept an explicit undefined, because the
  // drop sequence forwards its own optional deps straight through rather than
  // rebuilding them key by key.
  /** The distinct cue. Optional, because a denied cue never stops a run. */
  readonly cue?: AudioCue | undefined;
  /** Milliseconds held before the deciding ball releases. */
  readonly pauseMs?: number | undefined;
  /** Resolves after ms. Injected so a test drives the clock. */
  readonly pause: (ms: number) => Promise<void>;
  readonly record: RecordFn;
  /** Called once the closed set is known, before the cue and the pause, so the
   *  board can darken and cap those lanes while the room watches. */
  readonly onTieRound?: ((round: TieRound) => void) | undefined;
  readonly geometry?: BoardGeometry;
}

/**
 * Open the tie round: work out which lanes close, hand them to the board, sound
 * the distinct cue, and hold the longer beat. The deciding ball releases after
 * this resolves, never before, so the lanes are shut for the whole of its fall.
 */
export async function runTieRound(deps: TieRoundDeps): Promise<TieRound> {
  const geometry = deps.geometry ?? BOARD_GEOMETRY;
  const tiedLanes = validateTiedLanes(deps.tiedLanes, geometry.laneCount);
  const closedLanes = closedLanesForTie(tiedLanes, geometry.laneCount);
  const pauseMs = deps.pauseMs ?? TIE_PAUSE_MS;
  const round: TieRound = Object.freeze({
    tiedLanes,
    closedLanes,
    tallies: Object.freeze([...deps.tallies]),
  });

  deps.record("tie-round-opened", { tiedLanes, closedLanes, pauseMs });

  // Close the lanes first. The board the room is looking at then matches the
  // board the deciding path was selected against.
  deps.onTieRound?.(round);

  if (deps.cue !== undefined) {
    await requestCue(deps.cue, (name, data) => deps.record(`tie-${name}`, data));
  }

  await deps.pause(pauseMs);
  deps.record("tie-round-ready", { tiedLanes });

  return round;
}
