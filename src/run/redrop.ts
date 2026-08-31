// What happens after a ball reveals a winner. The winner modal is display only;
// this layer decides when the winner is written to the week and, on the first
// result of the day, holds the window in which the host can confirm or re-drop.
//
// It touches no DOM, opens no socket, and starts no real timer. The clock, the
// key source, and the state writes are all injected, so the whole layer runs
// under a fake clock in a unit test and against the real server and keyboard in
// the app. It is where the record write lives, so a bug here can lose or double
// a winner; the server keeps the write idempotent, and this calls it once.

import type { RecordFn } from "./cue.ts";

export type ResolveOutcome = "accepted" | "redropped" | "superseded";

export interface ResolveWinnerDeps {
  /** The winning restaurant's name, which is what gets written. */
  readonly winnerName: string;
  /** True when today's one re-drop is already spent. Then this is the second
   *  result: write it at once, hold no window, and offer no re-drop. */
  readonly redropUsed: boolean;
  /** How long the confirm-or-re-drop window stays open, in milliseconds. */
  readonly windowMs: number;
  /** The key that confirms the winner, a KeyboardEvent.key value. */
  readonly confirmKey: string;
  /** The key that re-drops. Ignored until a re-drop handler is supplied. */
  readonly redropKey: string;
  /** Write the accepted winner. completesRedrop is true when the write follows
   *  a recorded re-drop, which the server needs to accept a second winner for
   *  the day. The server keeps the write idempotent. */
  readonly acceptWinner: (completesRedrop: boolean) => Promise<void>;
  /** Persist today's rejection and start the next countdown. Absent until the
   *  re-drop key is wired, so on the first result the window simply lapses to an
   *  accepted winner. */
  readonly redrop?: () => Promise<void>;
  /** Resolves after ms. Injected so a test drives the clock. */
  readonly delay: (ms: number) => Promise<void>;
  /** Subscribe to host key presses; returns an unsubscribe. Injected so a test
   *  fires keys and the DOM stays out of this module. */
  readonly subscribeKeys: (handler: (key: string) => void) => () => void;
  readonly record: RecordFn;
  /** True once a later run has superseded this reveal. A superseded resolution
   *  writes nothing, so a scheduled run that replaces the reveal cannot also
   *  record its winner. */
  readonly isStale: () => boolean;
}

type Decision = "confirm" | "redrop" | "lapse";

// Hold the window: resolve on the confirm key, on the re-drop key when one is
// wired, or when the window lapses, whichever comes first. Later keys and every
// other key are ignored, so a repeated press cannot settle it twice.
function awaitDecision(deps: ResolveWinnerDeps): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (decision: Decision): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(decision);
    };

    unsubscribe = deps.subscribeKeys((key) => {
      if (key === deps.confirmKey) finish("confirm");
      else if (deps.redrop !== undefined && key === deps.redropKey) finish("redrop");
    });

    void deps.delay(deps.windowMs).then(() => finish("lapse"));
  });
}

/**
 * Resolve a revealed winner. The second result of the day is written at once and
 * completes the re-drop the first result started. The first result opens a
 * window: confirming, or letting the window lapse, writes the winner; pressing
 * the re-drop key, when it is wired, records the rejection and starts the next
 * run instead and writes no winner. A run that a later run has superseded writes
 * nothing.
 */
export async function resolveWinner(deps: ResolveWinnerDeps): Promise<ResolveOutcome> {
  if (deps.redropUsed) {
    if (deps.isStale()) return "superseded";
    await deps.acceptWinner(true);
    if (deps.isStale()) return "superseded";
    deps.record("winner-accepted", { winner: deps.winnerName, immediate: true });
    return "accepted";
  }

  deps.record("redrop-window-opened", { winner: deps.winnerName, windowMs: deps.windowMs });
  const decision = await awaitDecision(deps);
  if (deps.isStale()) return "superseded";

  if (decision === "redrop" && deps.redrop !== undefined) {
    await deps.redrop();
    deps.record("redrop-recorded", { rejected: deps.winnerName });
    return "redropped";
  }

  await deps.acceptWinner(false);
  if (deps.isStale()) return "superseded";
  deps.record("winner-accepted", {
    winner: deps.winnerName,
    immediate: false,
    confirmed: decision === "confirm",
  });
  return "accepted";
}

// The default window length when the settings value is missing or invalid. The
// server validates redropWindowSeconds as a whole number above zero, so this is
// only a belt-and-braces fallback matching the documented default.
export const DEFAULT_REDROP_WINDOW_SECONDS = 90;

// The window length in milliseconds from the settings value, falling back to the
// default when the value is missing or not a whole number of at least one.
export function resolveWindowMs(
  seconds: number | undefined,
  fallbackSeconds = DEFAULT_REDROP_WINDOW_SECONDS,
): number {
  const value = seconds ?? fallbackSeconds;
  const safe = Number.isSafeInteger(value) && value >= 1 ? value : fallbackSeconds;
  return safe * 1000;
}

/**
 * The lane indices to cap and dim: every lane whose restaurant is spent this
 * week, plus the re-drop's rejection, minus the lane whose winner is being
 * shown. A capped lane cannot receive a ball on the next run, so passing these
 * as spent lanes to the presenter makes the closure geometric rather than a
 * lighting change, and keeps the shown winner's own lane open.
 */
export function spentLaneIndices(
  restaurantNames: readonly string[],
  spentNames: readonly string[],
  shownWinner?: string,
): number[] {
  const spent = new Set(spentNames);
  return restaurantNames.flatMap((name, laneIndex) =>
    spent.has(name) && name !== shownWinner ? [laneIndex] : [],
  );
}
