import { describe, expect, it } from "vitest";
import type { InPlayRestaurant } from "../draw/week.ts";
import {
  CUE_DENIED_EVENT,
  createToneCue,
  makeSeedsFor,
  playTone,
  requestCue,
  runCountdown,
} from "./sequence.ts";

// These run in headless Chromium because they use the Web Audio API, which Node
// does not provide. The audio proof renders the tone offline, so it does not
// depend on autoplay permission and never plays a sound at the test machine.

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

function randomsFrom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Ran out of random values.");
    index += 1;
    return value;
  };
}

const clearLeaderRandoms = [3, 3, 3, 8, 10].map((lane) => (lane + 0.5) / 15);

describe("the audible cue in a browser", () => {
  it("produces a non-silent tone when it plays", async () => {
    const sampleRate = 44_100;
    const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
    playTone(context, 0);
    const rendered = await context.startRendering();

    let peak = 0;
    for (const sample of rendered.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.01);
  });

  it("records cue-played when playback is allowed", async () => {
    const { record, events } = collector();
    const played = await requestCue({ play: () => Promise.resolve() }, record);

    expect(played).toBe(true);
    expect(events.map((event) => event.name)).toContain("cue-played");
    expect(events.some((event) => event.name === CUE_DENIED_EVENT)).toBe(false);
  });

  it("records the named diagnostic when playback is denied, without throwing", async () => {
    const { record, events } = collector();
    const played = await requestCue(
      { play: () => Promise.reject(new Error("NotAllowedError")) },
      record,
    );

    expect(played).toBe(false);
    expect(events.map((event) => event.name)).toContain(CUE_DENIED_EVENT);
  });

  it(
    "reports a real suspended context whose resume stays blocked",
    async () => {
      const context = new AudioContext();
      if (context.state === "running") await context.suspend();
      expect(context.state).toBe("suspended");

      Object.defineProperty(context, "resume", {
        configurable: true,
        value: () => new Promise<void>(() => {}),
      });

      try {
        const { record, events } = collector();
        const played = await requestCue(createToneCue(context), record);

        expect(played).toBe(false);
        expect(events.map((event) => event.name)).toEqual([
          "cue-requested",
          CUE_DENIED_EVENT,
        ]);
      } finally {
        await context.close();
      }
    },
    1_000,
  );

  it("requests the cue at countdown start and keeps running when it is denied", async () => {
    const { record, events } = collector();
    let played = 0;

    const result = await runCountdown({
      inPlay: makeInPlay(),
      nextRandom: randomsFrom(clearLeaderRandoms),
      seedsFor: makeSeedsFor(1, 4000),
      record,
      cue: {
        play: () => {
          played += 1;
          return Promise.reject(new Error("blocked"));
        },
      },
      delay: () => Promise.resolve(),
    });

    expect(played).toBe(1);
    const names = events.map((event) => event.name);
    // The cue is requested right after the countdown starts.
    expect(names.indexOf("cue-requested")).toBe(names.indexOf("countdown-started") + 1);
    expect(names).toContain(CUE_DENIED_EVENT);
    expect(names).toContain("countdown-complete");
    expect(result.cuePlayed).toBe(false);
    expect(result.preselection.balls).toHaveLength(5);
  });
});
