import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Restaurant } from "../config/restaurants.ts";
import { drawDestination, drawTieDestination } from "./draw.ts";
import {
  resolveEligibility,
  type EligibilityResult,
  type ReadyEligibility,
  type RolledStateSnapshot,
} from "./week.ts";

const EMPTY_STATE: RolledStateSnapshot = {
  weeklyWinners: [],
  rejectedToday: null,
};

const PROPERTY_SEED = 0x4c554e43;
const DRAW_DENOMINATOR = 150_000;
const MAX_RELATIVE_COUNT_ERROR = 0.02;
const TIE_PROPERTY_SEED = 0x54494552;
const TIE_PROPERTY_DENOMINATOR = 50_000;

function restaurants(count: number): Restaurant[] {
  return Array.from({ length: count }, (_, index) => ({ name: `Place ${index}` }));
}

function namedRestaurants(...names: string[]): Restaurant[] {
  return names.map((name) => ({ name }));
}

function requireReady(result: EligibilityResult): ReadyEligibility {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("Expected at least two restaurants in play.");
  return result;
}

function laneNames(result: EligibilityResult): string[] {
  return result.inPlay.map(({ restaurant }) => restaurant.name);
}

function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function importedFiles(source: string): string[] {
  const staticImports = source.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
  );
  const dynamicImports = source.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  );
  return [...staticImports, ...dynamicImports]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined);
}

function forbiddenImports(source: string): string[] {
  return importedFiles(source).filter((path) => /(?:^|\/)(?:scene|drop)(?:\/|$)/.test(path));
}

describe("eligibility", () => {
  it("starts with the full list and keeps every original lane index", () => {
    const result = requireReady(resolveEligibility(restaurants(15), EMPTY_STATE));

    expect(result.inPlay.map(({ laneIndex }) => laneIndex)).toEqual(
      Array.from({ length: 15 }, (_, index) => index),
    );
    expect(result.recordDirective).toEqual({ kind: "keep-record" });
  });

  it("covers AE6 by removing this week's winners", () => {
    const result = requireReady(resolveEligibility(
      namedRestaurants("Golden Bowl", "Taco Cantina", "Daily Bread", "Burger Barn"),
      { weeklyWinners: ["Golden Bowl", "Daily Bread"], rejectedToday: null },
    ));

    expect(laneNames(result)).toEqual(["Taco Cantina", "Burger Barn"]);
    expect(result.inPlay.map(({ laneIndex }) => laneIndex)).toEqual([1, 3]);
    expect(drawDestination(result.inPlay, 0).restaurant.name).toBe("Taco Cantina");
    expect(drawDestination(result.inPlay, nextDown(1)).restaurant.name).toBe("Burger Barn");
  });

  it("removes today's rejected restaurant after the weekly winners", () => {
    const result = requireReady(resolveEligibility(
      namedRestaurants("Golden Bowl", "Taco Cantina", "Daily Bread", "Burger Barn"),
      { weeklyWinners: ["Golden Bowl"], rejectedToday: "Taco Cantina" },
    ));

    expect(laneNames(result)).toEqual(["Daily Bread", "Burger Barn"]);
    expect(result.inPlay.map(({ laneIndex }) => laneIndex)).toEqual([2, 3]);
  });

  it("covers AE7 by restoring the full list and requiring a persisted reset", () => {
    const fullList = namedRestaurants("Alpha", "Bravo", "Charlie", "Delta", "Echo");
    const result = requireReady(resolveEligibility(fullList, {
      weeklyWinners: ["Alpha", "Bravo", "Charlie", "Delta"],
      rejectedToday: null,
    }));

    expect(laneNames(result)).toEqual(fullList.map(({ name }) => name));
    expect(result.recordDirective).toEqual({
      kind: "clear-record",
      persistBeforeDraw: true,
    });
  });

  it("covers AE8 by including a restaurant added before the next call", () => {
    const before = requireReady(resolveEligibility(
      namedRestaurants("Alpha", "Bravo"),
      EMPTY_STATE,
    ));
    const after = requireReady(resolveEligibility(
      namedRestaurants("Alpha", "Bravo", "Charlie"),
      EMPTY_STATE,
    ));

    expect(laneNames(before)).toEqual(["Alpha", "Bravo"]);
    expect(laneNames(after)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("covers AE9 with a no-drop result when the full list has one entry", () => {
    const result = resolveEligibility(namedRestaurants("Only Place"), EMPTY_STATE);

    expect(result).toEqual({
      kind: "no-drop",
      inPlay: [{ laneIndex: 0, restaurant: { name: "Only Place" } }],
      recordDirective: { kind: "clear-record", persistBeforeDraw: true },
    });
  });

  it("does not change the supplied list or state", () => {
    const fullList = Object.freeze(namedRestaurants("Alpha", "Bravo", "Charlie"));
    const state = Object.freeze({
      weeklyWinners: Object.freeze(["Alpha"]),
      rejectedToday: null,
    });

    const result = requireReady(resolveEligibility(fullList, state));

    expect(fullList.map(({ name }) => name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(state.weeklyWinners).toEqual(["Alpha"]);
    expect(Object.isFrozen(result.inPlay)).toBe(true);
  });
});

describe("uniform destination mapping", () => {
  it("covers every interval boundary for list sizes 2 through 15", () => {
    for (let size = 2; size <= 15; size += 1) {
      const inPlay = requireReady(resolveEligibility(restaurants(size), EMPTY_STATE)).inPlay;
      expect(drawDestination(inPlay, 0).laneIndex, `size=${size} value=0`).toBe(0);

      for (let index = 1; index < size; index += 1) {
        const boundary = index / size;
        expect(
          drawDestination(inPlay, nextDown(boundary)).laneIndex,
          `size=${size} value=nextDown(${index}/${size})`,
        ).toBe(index - 1);
        expect(
          drawDestination(inPlay, boundary).laneIndex,
          `size=${size} value=${index}/${size}`,
        ).toBe(index);
      }

      expect(
        drawDestination(inPlay, nextDown(1)).laneIndex,
        `size=${size} value=nextDown(1)`,
      ).toBe(size - 1);
    }
  });

  it("draws only in-play lanes and keeps every count within 2 percent", () => {
    const inPlay = requireReady(resolveEligibility(restaurants(15), EMPTY_STATE)).inPlay;
    const allowed = new Set(inPlay);
    const counts = Array.from({ length: inPlay.length }, () => 0);
    const outside: string[] = [];
    const random = seededRandom(PROPERTY_SEED);
    const evidence = [
      `seed=0x${PROPERTY_SEED.toString(16)}`,
      `denominator=${DRAW_DENOMINATOR}`,
      `countermetric=${MAX_RELATIVE_COUNT_ERROR * 100}%`,
    ].join(" ");

    for (let draw = 0; draw < DRAW_DENOMINATOR; draw += 1) {
      const target = drawDestination(inPlay, random());
      if (!allowed.has(target)) outside.push(target.restaurant.name);
      counts[target.laneIndex] = (counts[target.laneIndex] ?? 0) + 1;
    }

    expect(outside, evidence).toEqual([]);
    const expected = DRAW_DENOMINATOR / inPlay.length;
    for (let laneIndex = 0; laneIndex < counts.length; laneIndex += 1) {
      const count = counts[laneIndex] ?? 0;
      const relativeError = Math.abs(count - expected) / expected;
      expect(
        relativeError,
        `${evidence} lane=${laneIndex} count=${count} expected=${expected}`,
      ).toBeLessThanOrEqual(MAX_RELATIVE_COUNT_ERROR);
    }
  });

  it("rejects a draw with too few lanes or a value outside [0, 1)", () => {
    const noDrop = resolveEligibility(namedRestaurants("Only Place"), EMPTY_STATE);
    const ready = requireReady(resolveEligibility(namedRestaurants("Alpha", "Bravo"), EMPTY_STATE));

    expect(() => drawDestination(noDrop.inPlay, 0)).toThrow(
      "A draw needs at least two restaurants in play.",
    );
    expect(() => drawDestination(ready.inPlay, -Number.MIN_VALUE)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
    expect(() => drawDestination(ready.inPlay, 1)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
    expect(() => drawDestination(ready.inPlay, Number.NaN)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
  });
});

describe("tie destination mapping", () => {
  it("gives every tied member an equal interval for set sizes 2 through 15", () => {
    const inPlay = requireReady(resolveEligibility(restaurants(15), EMPTY_STATE)).inPlay;
    const laneOrder = [14, 1, 12, 3, 10, 5, 8, 7, 6, 9, 4, 11, 2, 13, 0];

    for (let size = 2; size <= 15; size += 1) {
      const tied = laneOrder.slice(0, size).map((laneIndex) => {
        const candidate = inPlay[laneIndex];
        if (candidate === undefined) throw new Error(`Missing lane ${laneIndex}.`);
        return candidate;
      });
      const allowed = new Set(tied);

      for (let index = 0; index < size; index += 1) {
        const expected = tied[index];
        const intervalStart = index / size;
        const intervalEnd = nextDown((index + 1) / size);
        const startTarget = drawTieDestination(tied, intervalStart);
        const endTarget = drawTieDestination(tied, intervalEnd);
        const evidence = `size=${size} member=${index} interval=[${index}/${size},${index + 1}/${size})`;

        expect(startTarget, `${evidence} start`).toBe(expected);
        expect(endTarget, `${evidence} end`).toBe(expected);
        expect(allowed.has(startTarget), `${evidence} start outside tied set`).toBe(true);
        expect(allowed.has(endTarget), `${evidence} end outside tied set`).toBe(true);
      }
    }
  });

  it("returns only a joint-highest lane across fixed-seed tallies", () => {
    const inPlay = requireReady(resolveEligibility(restaurants(15), EMPTY_STATE)).inPlay;
    const random = seededRandom(TIE_PROPERTY_SEED);
    const coprimeSteps = [1, 2, 4, 7, 8, 11, 13, 14];
    const observedTieSizes = new Set<number>();
    const outsideLeaders: string[] = [];
    const evidence = [
      `seed=0x${TIE_PROPERTY_SEED.toString(16)}`,
      `denominator=${TIE_PROPERTY_DENOMINATOR}`,
      "countermetric=outside-joint-highest",
    ].join(" ");

    for (let trial = 0; trial < TIE_PROPERTY_DENOMINATOR; trial += 1) {
      const tieSize = 2 + Math.floor(random() * 14);
      const firstLane = Math.floor(random() * inPlay.length);
      const step = coprimeSteps[Math.floor(random() * coprimeSteps.length)];
      if (step === undefined) throw new Error("Missing lane step.");

      const tiedLaneIndices = new Set(
        Array.from(
          { length: tieSize },
          (_, index) => (firstLane + index * step) % inPlay.length,
        ),
      );
      const highestCount = 1 + Math.floor(random() * 5);
      const tallies = inPlay.map(({ laneIndex }) => (
        tiedLaneIndices.has(laneIndex)
          ? highestCount
          : Math.floor(random() * highestCount)
      ));
      const jointHighest = Math.max(...tallies);
      const tied = inPlay.filter(({ laneIndex }) => tallies[laneIndex] === jointHighest);
      const target = drawTieDestination(tied, random());

      observedTieSizes.add(tied.length);
      if (tallies[target.laneIndex] !== jointHighest || !tied.includes(target)) {
        outsideLeaders.push(
          `trial=${trial} lane=${target.laneIndex} leaders=${tied.map(({ laneIndex }) => laneIndex).join(",")}`,
        );
      }
    }

    expect(outsideLeaders, evidence).toEqual([]);
    expect([...observedTieSizes].sort((left, right) => left - right), evidence).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 2),
    );
  });

  it("rejects too few tied lanes or a value outside [0, 1)", () => {
    const inPlay = requireReady(resolveEligibility(restaurants(2), EMPTY_STATE)).inPlay;

    expect(() => drawTieDestination([], 0)).toThrow(
      "A tie draw needs at least two restaurants.",
    );
    expect(() => drawTieDestination(inPlay.slice(0, 1), 0)).toThrow(
      "A tie draw needs at least two restaurants.",
    );
    expect(() => drawTieDestination(inPlay, -Number.MIN_VALUE)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
    expect(() => drawTieDestination(inPlay, 1)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
    expect(() => drawTieDestination(inPlay, Number.NaN)).toThrow(
      "Random value must be at least 0 and below 1.",
    );
  });
});

describe("source boundary", () => {
  it("detects planted scene and drop imports", () => {
    const source = [
      'import type { Board } from "../scene/board.ts";',
      'import { simulate } from "../drop/simulate.ts";',
      'import type { Restaurant } from "../config/restaurants.ts";',
    ].join("\n");

    expect(forbiddenImports(source)).toEqual([
      "../scene/board.ts",
      "../drop/simulate.ts",
    ]);
  });

  it("keeps the draw modules independent from scene and drop code", () => {
    const files = ["draw.ts", "week.ts"];
    const violations = files.flatMap((file) => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      return forbiddenImports(source).map((path) => `${file}: ${path}`);
    });

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
