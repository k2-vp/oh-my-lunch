import { requestCue, type AudioCue } from "./cue.ts";
import {
  preselectPaths,
  type PreselectDeps,
  type Preselection,
} from "./sequence.ts";

export const DEFAULT_COUNTDOWN_MS = 60_000;

export interface CountdownDeps extends PreselectDeps {
  readonly cue: AudioCue;
  /** Resolves after ms. Injected so tests drive the clock. */
  readonly delay: (ms: number) => Promise<void>;
  /** Called once a second with the seconds left, from the total down to zero. */
  readonly onTick?: (secondsRemaining: number) => void;
  readonly durationMs?: number;
}

export interface CountdownResult {
  readonly preselection: Preselection;
  readonly cuePlayed: boolean;
}

interface CountdownClock {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

function startClock(
  durationMs: number,
  delay: (ms: number) => Promise<void>,
  onTick: ((secondsRemaining: number) => void) | undefined,
): CountdownClock {
  let stopped = false;
  let signalStop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    signalStop = resolve;
  });

  const done = (async (): Promise<void> => {
    const steps = Math.ceil(durationMs / 1000);
    let elapsed = 0;
    for (let step = 0; step < steps; step += 1) {
      if (stopped) return;
      onTick?.(steps - step);
      const stepMs = Math.min(1000, durationMs - elapsed);
      const waitResult = await Promise.race([
        delay(stepMs).then(() => "elapsed" as const),
        stopSignal.then(() => "stopped" as const),
      ]);
      if (waitResult === "stopped") return;
      elapsed += stepMs;
    }
    if (!stopped) onTick?.(0);
  })();

  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      signalStop();
    },
  };
}

/**
 * Run the countdown. Its clock starts before the cue and path selection, so
 * that work fits inside the duration. No ball is released here.
 */
export async function runCountdown(deps: CountdownDeps): Promise<CountdownResult> {
  const durationMs = deps.durationMs ?? DEFAULT_COUNTDOWN_MS;
  deps.record("countdown-started", { durationMs });
  const clock = startClock(durationMs, deps.delay, deps.onTick);

  let cuePlayed: boolean;
  let preselection: Preselection;
  try {
    cuePlayed = await requestCue(deps.cue, deps.record);
    preselection = await preselectPaths(deps);
  } catch (error) {
    clock.stop();
    await Promise.allSettled([clock.done]);
    throw error;
  }

  deps.record("paths-selected", {
    balls: preselection.balls.length,
    tie: preselection.tiedLanes !== null,
    exhausted: preselection.exhausted,
  });

  if (preselection.exhausted) {
    clock.stop();
    await clock.done;
    return { preselection, cuePlayed };
  }

  await clock.done;
  deps.record("countdown-complete", {});

  return { preselection, cuePlayed };
}
