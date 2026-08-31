export const CUE_DENIED_EVENT = "cue-unavailable";

const AUDIO_RESUME_TIMEOUT_MS = 250;

export type RecordFn = (name: string, data?: Record<string, unknown>) => void;

export interface AudioCue {
  /** Resolves when the cue is playing, rejects when playback is denied. */
  play(): Promise<void>;
}

/**
 * Play the cue and report the outcome. Returns true when it played, false when
 * playback was denied. It never throws, so a denied cue does not stop the run.
 */
export async function requestCue(cue: AudioCue, record: RecordFn): Promise<boolean> {
  record("cue-requested", {});
  try {
    await cue.play();
    record("cue-played", {});
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(CUE_DENIED_EVENT, { message });
    return false;
  }
}

// A short, quiet tone: a single sine with a fast attack and decay. Kept separate
// from the cue so it can render through any audio context, including an offline
// one in a test, without depending on autoplay permission.
export function playTone(audio: BaseAudioContext, startTime?: number): void {
  const start = startTime ?? audio.currentTime;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.2, start + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);

  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.42);
}

async function resumeAudio(audio: AudioContext): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      audio.resume(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, AUDIO_RESUME_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * The default cue: the tone above through a real-time audio context. play()
 * resolves once the context is running and rejects when the browser blocks
 * playback, which lets the run report the cue as unavailable without hanging.
 */
export function createToneCue(context?: AudioContext): AudioCue {
  return {
    async play(): Promise<void> {
      const audio = context ?? new AudioContext();
      if (audio.state === "suspended") await resumeAudio(audio);
      if (audio.state !== "running") throw new Error("Audio playback was blocked.");
      playTone(audio);
    },
  };
}
