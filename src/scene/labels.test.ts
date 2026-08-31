import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BOARD_GEOMETRY } from "../drop/geometry.ts";
import { configureOrthographicCamera, projectToScreen } from "./board.ts";
import { createLabelTexture, layoutLabel, type LabelBox } from "./labels.ts";
import labelsSource from "./labels.ts?raw";

// Every project TypeScript module's source, read at build time. The confinement
// check scans all of it, not just labels.ts, so a stray pretext import anywhere
// is caught. These patterns mirror the tsconfig "include" areas: src, server,
// scripts, and root TypeScript files.
const SOURCE_TREE = import.meta.glob(
  ["/src/**/*.ts", "/server/**/*.ts", "/scripts/**/*.ts", "/*.ts"],
  { query: "?raw", eager: true, import: "default" },
);

function filesImportingPretext(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, source]) => /from\s*["']@chenglou\/pretext["']/.test(source))
    .map(([path]) => path)
    .sort();
}

// These run in headless Chromium because pretext measures text through a real
// canvas context. They check that a name wraps to its lane on grapheme
// boundaries, that a short form is used verbatim, that the texture is sized for
// the device pixel ratio, and that no glyph spills outside the lane, at two TV
// resolutions and two device pixel ratios.

const RESOLUTIONS = [
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "3840x2160", width: 3840, height: 2160 },
] as const;
const DEVICE_PIXEL_RATIOS = [1, 2] as const;

const LONG = { name: "Ten Minute Hand-Pulled Noodle House" };
const ONE_LINE = { name: "Gyros" };
const CJK = { name: "十秒雲南米線" };
const EMOJI = { name: "\u{1F469}‍\u{1F469}‍\u{1F467}" }; // one ZWJ family grapheme
const WITH_SHORT = { name: "Ten Minute Hand-Pulled Noodle House", short: "Noodles" };

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}
function nonSpaceGraphemes(text: string): string[] {
  return graphemes(text).filter((g) => g.trim() !== "");
}

// The lane's label area on screen, in CSS pixels, using the board's own camera
// framing so the label box matches what the board actually shows.
function laneBoxPx(width: number, height: number): LabelBox {
  const camera = new THREE.OrthographicCamera();
  configureOrthographicCamera(camera, width, height, BOARD_GEOMETRY);
  const lane = BOARD_GEOMETRY.lanes[0];
  if (lane === undefined) throw new Error("The board has no lanes.");
  const topY = BOARD_GEOMETRY.bucket.topY;
  const bottomY = BOARD_GEOMETRY.bucket.bottomY;
  const left = projectToScreen(camera, width, height, { x: lane.opening.minX, y: topY });
  const right = projectToScreen(camera, width, height, { x: lane.opening.maxX, y: topY });
  const top = projectToScreen(camera, width, height, { x: lane.centerX, y: topY });
  const bottom = projectToScreen(camera, width, height, { x: lane.centerX, y: bottomY });
  return { widthPx: Math.abs(right.x - left.x), heightPx: Math.abs(bottom.y - top.y) };
}

describe("labels", () => {
  it("fits every seed-scale name inside its lane at both resolutions and pixel ratios", () => {
    for (const resolution of RESOLUTIONS) {
      const box = laneBoxPx(resolution.width, resolution.height);
      expect(box.widthPx).toBeGreaterThan(0);
      expect(box.heightPx).toBeGreaterThan(0);
      for (const dpr of DEVICE_PIXEL_RATIOS) {
        for (const spec of [LONG, ONE_LINE, CJK, EMOJI, WITH_SHORT]) {
          const layout = layoutLabel(spec, box, { devicePixelRatio: dpr });
          const where = `${spec.name} at ${resolution.label} dpr ${dpr}`;
          expect(layout.fitsWidth, `width ${where}`).toBe(true);
          expect(layout.fitsHeight, `height ${where}`).toBe(true);
          expect(layout.widthPx).toBeLessThanOrEqual(box.widthPx + 0.5);
          expect(layout.heightPx).toBeLessThanOrEqual(box.heightPx + 0.5);
        }
      }
    }
  });

  it("puts a short single name on one line", () => {
    const box = laneBoxPx(1920, 1080);
    const layout = layoutLabel(ONE_LINE, box);
    expect(layout.lineCount).toBe(1);
    expect(layout.lines).toEqual([ONE_LINE.name]);
  });

  it("wraps a long name to more than one line without losing or splitting graphemes", () => {
    const box = laneBoxPx(1920, 1080);
    const layout = layoutLabel(LONG, box);
    expect(layout.lineCount).toBeGreaterThan(1);
    expect(nonSpaceGraphemes(layout.lines.join(""))).toEqual(nonSpaceGraphemes(LONG.name));
  });

  it("wraps a space-free CJK name on grapheme boundaries", () => {
    // A box only wide enough for a few characters forces a wrap. A naive space
    // wrap would put it all on one overflowing line; pretext breaks between
    // graphemes.
    const box = laneBoxPx(1920, 1080);
    const layout = layoutLabel(CJK, box);
    expect(layout.lineCount).toBeGreaterThan(1);
    // No grapheme is lost or split: the graphemes across the lines are the
    // original ones, in order.
    expect(layout.lines.join("")).toBe(CJK.name);
    expect(nonSpaceGraphemes(layout.lines.join(""))).toEqual(graphemes(CJK.name));
    // Every line is made of whole graphemes from the name.
    const original = new Set(graphemes(CJK.name));
    for (const line of layout.lines) {
      for (const g of graphemes(line)) expect(original.has(g)).toBe(true);
    }
  });

  it("keeps a zero-width-joiner emoji as one grapheme on one line", () => {
    expect(graphemes(EMOJI.name)).toHaveLength(1);
    const box = laneBoxPx(1920, 1080);
    const layout = layoutLabel(EMOJI, box);
    expect(layout.lineCount).toBe(1);
    expect(layout.lines[0]).toBe(EMOJI.name);
    expect(graphemes(layout.lines[0] ?? "")).toHaveLength(1);
  });

  it("uses an explicit short value verbatim and never re-wraps it", () => {
    const box = laneBoxPx(1920, 1080);
    const laneLabel = layoutLabel(WITH_SHORT, box);
    expect(laneLabel.usedShort).toBe(true);
    expect(laneLabel.text).toBe(WITH_SHORT.short);
    expect(laneLabel.lineCount).toBe(1);
    expect(laneLabel.lines).toEqual([WITH_SHORT.short]);

    // The reveal ignores the short form and uses the full name.
    const revealBox: LabelBox = { widthPx: 1600, heightPx: 400 };
    const reveal = layoutLabel(WITH_SHORT, revealBox, { preferShort: false });
    expect(reveal.usedShort).toBe(false);
    expect(reveal.text).toBe(WITH_SHORT.name);
  });

  it("sizes the texture to the box times the device pixel ratio", () => {
    for (const resolution of RESOLUTIONS) {
      const box = laneBoxPx(resolution.width, resolution.height);
      for (const dpr of DEVICE_PIXEL_RATIOS) {
        const { texture, canvas, textureWidth, textureHeight } = createLabelTexture(
          LONG,
          box,
          { devicePixelRatio: dpr },
        );
        expect(textureWidth).toBe(Math.round(box.widthPx * dpr));
        expect(textureHeight).toBe(Math.round(box.heightPx * dpr));
        expect(canvas.width).toBe(textureWidth);
        expect(canvas.height).toBe(textureHeight);
        expect(texture.image).toBe(canvas);
      }
    }
  });

  it("draws every glyph inside the lane box", () => {
    const box = laneBoxPx(1920, 1080);
    const { layout } = createLabelTexture(LONG, box, { devicePixelRatio: 2 });

    // Re-measure the drawn lines with a matching context and confirm none spills
    // past the lane width or the stacked height past the lane height.
    const probe = document.createElement("canvas").getContext("2d");
    expect(probe).not.toBeNull();
    if (probe === null) return;
    probe.font = `${layout.fontSizePx}px monospace`;
    for (const line of layout.lines) {
      const metrics = probe.measureText(line);
      expect(metrics.width).toBeLessThanOrEqual(box.widthPx + 0.5);
    }
    expect(layout.lineCount * layout.lineHeightPx).toBeLessThanOrEqual(box.heightPx + 0.5);
  });

  it("scans every project source area, so no directory is left unguarded", () => {
    // The scan only guards what it actually reads. Prove SOURCE_TREE loaded a
    // file from each tsconfig include area, not just src and server.
    const keys = Object.keys(SOURCE_TREE);
    expect(keys.some((key) => key.startsWith("/src/"))).toBe(true);
    expect(keys.some((key) => key.startsWith("/server/"))).toBe(true);
    expect(keys.some((key) => key.startsWith("/scripts/"))).toBe(true);
    expect(keys.some((key) => /^\/[^/]+\.ts$/.test(key))).toBe(true); // a root file
  });

  it("imports pretext in labels.ts only, across the whole source tree", () => {
    // The board experiment that caught the earlier gap: pretext must appear in
    // exactly one file, and that file is labels.ts.
    expect(filesImportingPretext(SOURCE_TREE)).toEqual(["/src/scene/labels.ts"]);
  });

  it("catches a pretext import planted in any source area", () => {
    // Prove the scan is not vacuous and reaches every area, including the ones a
    // previous version missed: scripts and root files.
    for (const planted of ["/src/scene/board.ts", "/scripts/dev.ts", "/vite.config.ts", "/server/index.ts"]) {
      const tree = { ...SOURCE_TREE, [planted]: 'import { prepare } from "@chenglou/pretext";\n' };
      const importers = filesImportingPretext(tree);
      expect(importers, `planted in ${planted}`).toContain(planted);
      expect(importers.length).toBeGreaterThan(1);
    }
  });

  it("keeps pretext behind one narrow import inside labels.ts", () => {
    const importsInLabels = labelsSource.match(/from\s*["']@chenglou\/pretext["']/g) ?? [];
    expect(importsInLabels).toHaveLength(1);
    expect(labelsSource).toMatch(/import\s*\{[^}]*\}\s*from\s*["']@chenglou\/pretext["']/);
  });
});
