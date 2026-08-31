import { describe, expect, it } from "vitest";
import { playTone } from "./cue.ts";
import { createTieCue, playTieTone, runTieRound, TIE_CUE_DENIED_EVENT } from "./tie.ts";

// These run in headless Chromium because they use the Web Audio API, which Node
// does not provide. Both cues are rendered offline, so the proof does not depend
// on autoplay permission and no sound plays at the test machine.
//
// "Distinct" is measured, not asserted by looking at the source: the two cues
// are compared by the frequencies they contain, by how many notes they sound,
// and by how long they last.

const SAMPLE_RATE = 44_100;
const SOUNDING = 0.01;

interface Logged {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

function collector(): { record: (name: string, data?: Record<string, unknown>) => void; events: Logged[] } {
  const events: Logged[] = [];
  return { events, record: (name, data = {}) => events.push({ name, data }) };
}

// One second exactly, so 440, 660, and 880 all land on whole frequency bins.
async function render(draw: (context: OfflineAudioContext) => void): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
  draw(context);
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

// The strength of one frequency in a buffer, by the Goertzel form of a single
// discrete Fourier bin.
function strengthAt(samples: Float32Array, frequency: number): number {
  const bin = Math.round((samples.length * frequency) / SAMPLE_RATE);
  const omega = (2 * Math.PI * bin) / samples.length;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let beforeThat = 0;

  for (const sample of samples) {
    const current = sample + coefficient * previous - beforeThat;
    beforeThat = previous;
    previous = current;
  }

  const power = previous * previous + beforeThat * beforeThat - coefficient * previous * beforeThat;
  return Math.sqrt(Math.max(0, power)) / samples.length;
}

function peak(samples: Float32Array): number {
  let highest = 0;
  for (const sample of samples) highest = Math.max(highest, Math.abs(sample));
  return highest;
}

// How many separate notes sound: a rise above the sounding level after silence.
function noteCount(samples: Float32Array): number {
  const window = 256;
  let notes = 0;
  let sounding = false;

  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let offset = 0; offset < window; offset += 1) {
      const sample = samples[start + offset] ?? 0;
      sum += sample * sample;
    }
    const level = Math.sqrt(sum / window);
    if (!sounding && level > SOUNDING) {
      notes += 1;
      sounding = true;
    } else if (sounding && level <= SOUNDING) {
      sounding = false;
    }
  }

  return notes;
}

function soundingSeconds(samples: Float32Array): number {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (Math.abs(samples[index] ?? 0) > SOUNDING) return (index + 1) / SAMPLE_RATE;
  }
  return 0;
}

describe("the tie cue in a browser", () => {
  it("sounds a real tone", async () => {
    const tie = await render((context) => playTieTone(context, 0));
    expect(peak(tie)).toBeGreaterThan(0.01);
  });

  it("carries frequencies the countdown cue does not", async () => {
    const countdown = await render((context) => playTone(context, 0));
    const tie = await render((context) => playTieTone(context, 0));

    // The countdown cue is one note at 880.
    expect(strengthAt(countdown, 880)).toBeGreaterThan(strengthAt(countdown, 440) * 10);
    expect(strengthAt(countdown, 880)).toBeGreaterThan(strengthAt(countdown, 660) * 10);

    // The tie cue is a rising pair at 440 and 660, and does not sound 880.
    expect(strengthAt(tie, 440)).toBeGreaterThan(strengthAt(tie, 880) * 10);
    expect(strengthAt(tie, 660)).toBeGreaterThan(strengthAt(tie, 880) * 10);
  });

  it("sounds two notes where the countdown cue sounds one, and lasts longer", async () => {
    const countdown = await render((context) => playTone(context, 0));
    const tie = await render((context) => playTieTone(context, 0));

    expect(noteCount(countdown)).toBe(1);
    expect(noteCount(tie)).toBe(2);
    expect(soundingSeconds(tie)).toBeGreaterThan(soundingSeconds(countdown));
  });

  it("reports itself unavailable instead of hanging when audio is blocked", async () => {
    const context = new AudioContext();
    if (context.state === "running") await context.suspend();
    expect(context.state).toBe("suspended");

    try {
      const { record, events } = collector();
      let paused = 0;

      await runTieRound({
        tiedLanes: [2, 7],
        tallies: new Array<number>(15).fill(0),
        cue: createTieCue(context),
        pause: (ms) => {
          paused += ms;
          return Promise.resolve();
        },
        record,
      });

      expect(events.map((event) => event.name)).toContain(TIE_CUE_DENIED_EVENT);
      expect(events.map((event) => event.name).at(-1)).toBe("tie-round-ready");
      expect(paused).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 5_000);
});
