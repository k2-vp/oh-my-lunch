// The running per-lane ball count, the thing the room watches build. It is a
// plain array of whole numbers, one slot per lane, so a presenter can read it
// straight into a drop state. The sequence counts a lane the moment its ball
// lands, before the next ball releases, so the number on screen never runs ahead
// of the balls that have actually come to rest.
//
// This module counts and reads a tally. It never draws a ball or picks a target,
// so a bug here can show a wrong number but cannot change which restaurant wins.

export interface Tally {
  /** Count one landed ball into its lane. */
  add(laneIndex: number): void;
  /** The per-lane counts so far, one slot per lane. A fresh copy each call. */
  snapshot(): number[];
  /** How many balls have been counted. */
  total(): number;
}

export function createTally(laneTotal: number): Tally {
  if (!Number.isInteger(laneTotal) || laneTotal < 1) {
    throw new RangeError("A tally needs at least one lane.");
  }

  const counts = new Array<number>(laneTotal).fill(0);

  return {
    add(laneIndex: number): void {
      if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= laneTotal) {
        throw new RangeError(`Lane ${laneIndex} is outside a ${laneTotal}-lane tally.`);
      }
      counts[laneIndex] = (counts[laneIndex] ?? 0) + 1;
    },
    snapshot(): number[] {
      return counts.slice();
    },
    total(): number {
      return counts.reduce((sum, count) => sum + count, 0);
    },
  };
}

export interface LeadingLane {
  readonly laneIndex: number;
  readonly count: number;
}

// The single lane with the most balls, or null when two or more share the lead
// or nothing has landed. A tie is not a winner, so this returns null rather than
// picking one of the tied lanes; naming a winner from a tie is exactly the
// unfairness the deciding ball exists to prevent.
export function leadingLane(tallies: readonly number[]): LeadingLane | null {
  let most = 0;
  let leader = -1;
  let shared = false;

  for (let laneIndex = 0; laneIndex < tallies.length; laneIndex += 1) {
    const count = tallies[laneIndex] ?? 0;
    if (count > most) {
      most = count;
      leader = laneIndex;
      shared = false;
    } else if (count === most && most > 0) {
      shared = true;
    }
  }

  if (leader === -1 || most === 0 || shared) return null;
  return { laneIndex: leader, count: most };
}
