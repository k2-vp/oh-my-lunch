import { describe, expect, it } from "vitest";
import { createTally, leadingLane } from "./tally.ts";

describe("createTally", () => {
  it("starts every lane at zero", () => {
    const tally = createTally(15);
    expect(tally.snapshot()).toEqual(new Array<number>(15).fill(0));
    expect(tally.total()).toBe(0);
  });

  it("counts a ball into its lane", () => {
    const tally = createTally(4);
    tally.add(2);
    tally.add(2);
    tally.add(0);
    expect(tally.snapshot()).toEqual([1, 0, 2, 0]);
    expect(tally.total()).toBe(3);
  });

  it("returns a fresh copy each snapshot, so a caller cannot mutate the count", () => {
    const tally = createTally(3);
    tally.add(1);
    const first = tally.snapshot();
    first[1] = 99;
    expect(tally.snapshot()).toEqual([0, 1, 0]);
  });

  it("rejects a lane outside the board", () => {
    const tally = createTally(3);
    expect(() => tally.add(3)).toThrow(RangeError);
    expect(() => tally.add(-1)).toThrow(RangeError);
    expect(() => tally.add(1.5)).toThrow(RangeError);
  });

  it("rejects a lane count below one", () => {
    expect(() => createTally(0)).toThrow(RangeError);
    expect(() => createTally(-2)).toThrow(RangeError);
  });
});

describe("leadingLane", () => {
  it("names the single lane with the most balls", () => {
    expect(leadingLane([1, 3, 2])).toEqual({ laneIndex: 1, count: 3 });
  });

  it("finds the leader when it is not the last lane", () => {
    expect(leadingLane([3, 1, 2])).toEqual({ laneIndex: 0, count: 3 });
  });

  it("returns null when two or more lanes share the lead", () => {
    expect(leadingLane([2, 2, 1])).toBeNull();
    expect(leadingLane([1, 1, 1, 1, 1])).toBeNull();
  });

  it("returns null when nothing has landed", () => {
    expect(leadingLane([0, 0, 0])).toBeNull();
    expect(leadingLane([])).toBeNull();
  });

  it("still sees the leader when an earlier pair tied before one pulled ahead", () => {
    // Lanes 0 and 1 tie at two until lane 2 reaches three.
    expect(leadingLane([2, 2, 3])).toEqual({ laneIndex: 2, count: 3 });
  });
});
