import { describe, expect, it } from "vitest";

// This is the smoke test for the browser runner itself. It does not test the
// board. It proves that the runner is a real browser and gives label code the
// two things it needs: a canvas 2D context for text measurement, and
// Intl.Segmenter for grapheme-aware wrapping. If this file runs in Node it
// fails, which is the point. A green run here means the label and scene tests
// added later have somewhere to execute.

describe("browser test runner", () => {
  it("runs in a real browser DOM", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
  });

  it("gives a canvas a real 2D context that measures text", () => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    // Node and jsdom return null here. A real browser returns a context.
    expect(context).not.toBeNull();
    if (context === null) return;

    context.font = "16px monospace";
    const metrics = context.measureText("Ten Minute Hand-Pulled Noodle House");

    expect(metrics.width).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.width)).toBe(true);
    // The wider string must measure wider than a short one at the same font.
    expect(metrics.width).toBeGreaterThan(context.measureText("Gyro Stop").width);
  });

  it("segments graphemes, not code units", () => {
    expect(typeof Intl.Segmenter).toBe("function");
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

    // A CJK name has no spaces, so a naive wrap would fail. Segmentation still
    // splits it into two graphemes.
    const noodles = [...segmenter.segment("面条")];
    expect(noodles).toHaveLength(2);

    // A ZWJ emoji family is one grapheme, not the several code points it holds.
    const family = "\u{1F469}‍\u{1F469}‍\u{1F467}";
    const familyGraphemes = [...segmenter.segment(family)];
    expect(familyGraphemes).toHaveLength(1);
  });
});
