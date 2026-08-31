import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REDROP_WINDOW_SECONDS,
  resolveWindowMs,
  resolveWinner,
  spentLaneIndices,
  type ResolveWinnerDeps,
} from "./redrop.ts";

interface Harness {
  readonly deps: ResolveWinnerDeps;
  readonly accepts: boolean[];
  readonly events: { name: string; data: Record<string, unknown> }[];
  fireKey(key: string): void;
  setStale(value: boolean): void;
}

function harness(overrides: Partial<ResolveWinnerDeps> = {}): Harness {
  const accepts: boolean[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  let keyHandler: ((key: string) => void) | null = null;
  let stale = false;

  const deps: ResolveWinnerDeps = {
    winnerName: "Taco Cantina",
    redropUsed: false,
    windowMs: 90_000,
    confirmKey: "Enter",
    redropKey: "r",
    acceptWinner: (completesRedrop) => {
      accepts.push(completesRedrop);
      return Promise.resolve();
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    subscribeKeys: (handler) => {
      keyHandler = handler;
      return () => {
        keyHandler = null;
      };
    },
    record: (name, data = {}) => {
      events.push({ name, data });
    },
    isStale: () => stale,
    ...overrides,
  };

  return {
    deps,
    accepts,
    events,
    fireKey: (key) => keyHandler?.(key),
    setStale: (value) => {
      stale = value;
    },
  };
}

describe("resolveWinner", () => {
  it("writes the second result at once and completes the re-drop", async () => {
    const h = harness({ redropUsed: true });
    const outcome = await resolveWinner(h.deps);

    expect(outcome).toBe("accepted");
    expect(h.accepts).toEqual([true]);
    expect(h.events.some((event) => event.name === "redrop-window-opened")).toBe(false);
  });

  it("writes nothing before the deadline and one winner at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ windowMs: 90_000 });
      const promise = resolveWinner(h.deps);

      await vi.advanceTimersByTimeAsync(89_999);
      expect(h.accepts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(await promise).toBe("accepted");
      expect(h.accepts).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts early when the confirm key is pressed inside the window", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = resolveWinner(h.deps);

      await vi.advanceTimersByTimeAsync(1_000);
      h.fireKey("Enter");
      expect(await promise).toBe("accepted");
      expect(h.accepts).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the winner unwritten if the process dies before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ windowMs: 90_000 });
      void resolveWinner(h.deps);

      // Time stops short of the deadline and no key fires: a kill here writes
      // nothing, so the restaurant stays eligible.
      await vi.advanceTimersByTimeAsync(89_999);
      expect(h.accepts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes exactly once when a confirm and the lapse would both fire", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = resolveWinner(h.deps);

      h.fireKey("Enter");
      expect(await promise).toBe("accepted");

      // The lapse timer still fires later, but the window is already settled.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.accepts).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores keys other than the configured ones", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = resolveWinner(h.deps);

      h.fireKey("x");
      h.fireKey("Enter ");
      await vi.advanceTimersByTimeAsync(50_000);
      expect(h.accepts).toEqual([]);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(await promise).toBe("accepted");
      expect(h.accepts).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing for a second result a later run superseded", async () => {
    const h = harness({ redropUsed: true });
    h.setStale(true);

    expect(await resolveWinner(h.deps)).toBe("superseded");
    expect(h.accepts).toEqual([]);
  });

  it("writes no winner when a later run supersedes the open window", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = resolveWinner(h.deps);

      h.setStale(true);
      await vi.advanceTimersByTimeAsync(90_000);

      expect(await promise).toBe("superseded");
      expect(h.accepts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveWinner re-drop", () => {
  it("records the rejection and writes no winner when the re-drop key fires", async () => {
    vi.useFakeTimers();
    try {
      let redrops = 0;
      const h = harness({ redrop: () => { redrops += 1; return Promise.resolve(); } });
      const promise = resolveWinner(h.deps);

      h.fireKey("r");
      expect(await promise).toBe("redropped");
      expect(redrops).toBe(1);
      expect(h.accepts).toEqual([]);

      // The window would have lapsed later, but the round is already settled.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.accepts).toEqual([]);
      expect(redrops).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the rejection once for a repeated re-drop keydown", async () => {
    vi.useFakeTimers();
    try {
      let redrops = 0;
      const h = harness({ redrop: () => { redrops += 1; return Promise.resolve(); } });
      const promise = resolveWinner(h.deps);

      h.fireKey("r");
      h.fireKey("r");
      expect(await promise).toBe("redropped");
      expect(redrops).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a wrong key, then re-drops on the configured key", async () => {
    vi.useFakeTimers();
    try {
      let redrops = 0;
      const h = harness({ redrop: () => { redrops += 1; return Promise.resolve(); } });
      const promise = resolveWinner(h.deps);

      h.fireKey("x");
      h.fireKey("Enter ");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(redrops).toBe(0);
      expect(h.accepts).toEqual([]);

      h.fireKey("r");
      expect(await promise).toBe("redropped");
      expect(redrops).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-drops at the last instant before the window closes", async () => {
    vi.useFakeTimers();
    try {
      let redrops = 0;
      const h = harness({ redrop: () => { redrops += 1; return Promise.resolve(); } });
      const promise = resolveWinner(h.deps);

      await vi.advanceTimersByTimeAsync(89_999);
      h.fireKey("r");
      expect(await promise).toBe("redropped");
      expect(redrops).toBe(1);
      expect(h.accepts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a re-drop key after the window has lapsed", async () => {
    vi.useFakeTimers();
    try {
      let redrops = 0;
      const h = harness({ redrop: () => { redrops += 1; return Promise.resolve(); } });
      const promise = resolveWinner(h.deps);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(await promise).toBe("accepted");

      h.fireKey("r");
      expect(redrops).toBe(0);
      expect(h.accepts).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores the re-drop key on a second result that is already spent", async () => {
    let redrops = 0;
    const h = harness({ redropUsed: true, redrop: () => { redrops += 1; return Promise.resolve(); } });

    expect(await resolveWinner(h.deps)).toBe("accepted");
    expect(h.accepts).toEqual([true]);
    h.fireKey("r");
    expect(redrops).toBe(0);
  });
});

describe("resolveWindowMs", () => {
  it("converts whole seconds to milliseconds", () => {
    expect(resolveWindowMs(90)).toBe(90_000);
    expect(resolveWindowMs(1)).toBe(1_000);
  });

  it("falls back to the default for a missing or invalid value", () => {
    const fallbackMs = DEFAULT_REDROP_WINDOW_SECONDS * 1_000;
    expect(resolveWindowMs(undefined)).toBe(fallbackMs);
    expect(resolveWindowMs(0)).toBe(fallbackMs);
    expect(resolveWindowMs(-5)).toBe(fallbackMs);
    expect(resolveWindowMs(1.5)).toBe(fallbackMs);
  });
});

describe("spentLaneIndices", () => {
  const names = ["Taco Cantina", "Daily Bread", "Burger Barn", "Sub Station"];

  it("returns the lanes of the spent restaurants", () => {
    expect(spentLaneIndices(names, ["Burger Barn", "Taco Cantina"])).toEqual([0, 2]);
  });

  it("keeps the shown winner's own lane open", () => {
    expect(spentLaneIndices(names, ["Taco Cantina", "Daily Bread"], "Daily Bread")).toEqual([0]);
  });

  it("returns nothing when no lane is spent", () => {
    expect(spentLaneIndices(names, [])).toEqual([]);
  });
});
