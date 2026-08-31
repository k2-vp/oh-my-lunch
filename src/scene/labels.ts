import * as THREE from "three";
import { layoutWithLines, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { K2_THEME_TOKENS } from "./theme.ts";

// Restaurant labels for the board. A name is measured and wrapped to the width
// of its lane and drawn to a canvas texture sized for the display's device pixel
// ratio, so the text stays crisp on a large screen.
//
// All measurement goes through pretext, which reads glyph metrics from a real
// canvas and segments text with Intl.Segmenter. That is why a name in a script
// with no spaces, or an emoji built from several code points, wraps on grapheme
// boundaries instead of splitting a character. A hand-rolled space wrap would
// break on both. pretext is used only inside measureText below, so a breaking
// change in that pre-1.0 library touches one function.

// A single monospace family. It matches the flat treatment in the references
// and its even advance widths make a wrapped name read cleanly down a lane.
const DEFAULT_FONT_FAMILY = "monospace";
const DEFAULT_LINE_HEIGHT = 1.25; // multiple of the font size
const DEFAULT_MAX_FONT_PX = 48;
const DEFAULT_MIN_FONT_PX = 8;
const DEFAULT_LABEL_COLOR = K2_THEME_TOKENS.ink;
const FIT_EPS = 0.5; // a half pixel of slack so rounding does not fail a fit

// Scripts that allow a line break between characters rather than only at spaces:
// CJK, kana, and Hangul. A name in one of these wraps grapheme by grapheme. A
// space-delimited name breaks only at its spaces, and a single word is kept
// whole, shrunk to fit rather than split down the middle.
const BREAKS_BETWEEN_CHARACTERS =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function toGraphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((entry) => entry.segment);
}

export interface LabelSpec {
  readonly name: string;
  // An optional hand-written short form. When present it is used verbatim on the
  // lane and is never re-wrapped. The full name still appears at the reveal.
  readonly short?: string;
}

// The space a label may occupy on screen, in CSS pixels, before the device
// pixel ratio is applied.
export interface LabelBox {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface LabelOptions {
  readonly fontFamily?: string;
  readonly maxFontSizePx?: number;
  readonly minFontSizePx?: number;
  readonly lineHeight?: number; // multiple of the font size
  readonly devicePixelRatio?: number;
  // Lane labels prefer the short form; the reveal passes false to force the full
  // name.
  readonly preferShort?: boolean;
  readonly color?: string;
}

export interface LabelLayout {
  readonly text: string;
  readonly usedShort: boolean;
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly fontSizePx: number;
  readonly lineHeightPx: number;
  readonly widthPx: number; // widest line
  readonly heightPx: number; // all lines stacked
  readonly fitsWidth: boolean;
  readonly fitsHeight: boolean;
}

export interface LabelTexture {
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  readonly layout: LabelLayout;
  readonly textureWidth: number; // device pixels
  readonly textureHeight: number;
}

interface Measured {
  readonly lines: string[];
  readonly widths: number[];
}

// The only place pretext is called. Measures a name at a font, either on one
// line at its natural width or wrapped to a maximum width, and returns the line
// strings and their widths. Wrapping falls on grapheme boundaries.
function measureText(
  text: string,
  font: string,
  maxWidthPx: number,
  lineHeightPx: number,
  wrap: boolean,
): Measured {
  const prepared = prepareWithSegments(text, font);
  if (!wrap) {
    return { lines: [text], widths: [measureNaturalWidth(prepared)] };
  }
  const result = layoutWithLines(prepared, maxWidthPx, lineHeightPx);
  return {
    // pretext keeps the space it broke on at the end of a line but reports the
    // line width without it. Drop that trailing space so the drawn text matches
    // the reported width and does not push past the lane.
    lines: result.lines.map((line) => line.text.trimEnd()),
    widths: result.lines.map((line) => line.width),
  };
}

// Whether the wrapped lines broke inside a word. The fit check and the wrapper
// measure with the same canvas but compare with different slack, so a word that
// sits within FIT_EPS of the box edge can pass the unit check and still be
// split by the wrap. Walking the lines against the source words catches that
// band exactly, whatever the metrics say.
export function linesBreakWords(lines: readonly string[], text: string): boolean {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const parts = lines
    .flatMap((line) => line.trim().split(/\s+/))
    .filter((part) => part.length > 0);
  let wordIndex = 0;
  let partIndex = 0;
  while (wordIndex < words.length) {
    const word = words[wordIndex];
    if (word === undefined) break;
    if (parts[partIndex] === word) {
      wordIndex += 1;
      partIndex += 1;
      continue;
    }
    // A word may continue across lines only at its own hyphens, the one break
    // the wrapper is allowed to make inside a word.
    let assembled = parts[partIndex] ?? "";
    if (!assembled.endsWith("-") || !word.startsWith(assembled)) return true;
    partIndex += 1;
    while (partIndex < parts.length && assembled !== word) {
      assembled += parts[partIndex];
      if (!word.startsWith(assembled)) return true;
      if (assembled !== word && !assembled.endsWith("-")) return true;
      partIndex += 1;
    }
    if (assembled !== word) return true;
    wordIndex += 1;
  }
  return partIndex !== parts.length;
}

// The widest run of text that must stay on one line: a word for a space-delimited
// name, a single grapheme for a name that breaks between characters. If this is
// wider than the box, the font is too big and a word would be split down the
// middle, so the caller shrinks instead.
function widestUnitPx(source: string, font: string): number {
  const tokens = source.split(/\s+/).filter((token) => token.length > 0);
  let widest = 0;
  for (const token of tokens) {
    // A hyphenated token may break after each hyphen, so its mandatory unit is
    // its widest fragment, not the whole token.
    const units = BREAKS_BETWEEN_CHARACTERS.test(token)
      ? toGraphemes(token)
      : token.split(/(?<=-)/).filter((fragment) => fragment.length > 0);
    for (const unit of units) {
      const width = measureText(unit, font, 0, 0, false).widths[0] ?? 0;
      if (width > widest) widest = width;
    }
  }
  return widest;
}

// Measure a name and wrap it so it fits its box, choosing the largest font size
// between the minimum and maximum at which every line stays inside the box. The
// fit predicate is monotonic in the font size, so a binary search finds the
// largest fitting size. A short form is kept on one line and only shrunk.
export function layoutLabel(
  spec: LabelSpec,
  box: LabelBox,
  options: LabelOptions = {},
): LabelLayout {
  const family = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const lineHeightMultiple = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const maxFont = options.maxFontSizePx ?? DEFAULT_MAX_FONT_PX;
  const minFont = options.minFontSizePx ?? DEFAULT_MIN_FONT_PX;
  const preferShort = options.preferShort ?? true;
  const usedShort = preferShort && spec.short !== undefined;
  const text = usedShort ? (spec.short ?? spec.name) : spec.name;

  const layoutAt = (fontSize: number): LabelLayout => {
    const font = `${fontSize}px ${family}`;
    const lineHeightPx = fontSize * lineHeightMultiple;
    const measured = measureText(text, font, box.widthPx, lineHeightPx, !usedShort);
    const widthPx = measured.widths.length > 0 ? Math.max(...measured.widths) : 0;
    const heightPx = measured.lines.length * lineHeightPx;
    // A wrapped name must also keep every word whole. If the widest word is
    // wider than the box at this size, wrapping would split it, so this size
    // does not fit even if the wrapped lines happen to.
    const keepsWordsWhole = usedShort
      || BREAKS_BETWEEN_CHARACTERS.test(text)
      || !linesBreakWords(measured.lines, text);
    const widthOk = usedShort
      ? widthPx <= box.widthPx + FIT_EPS
      : widthPx <= box.widthPx + FIT_EPS
        && widestUnitPx(text, font) <= box.widthPx + FIT_EPS
        && keepsWordsWhole;
    return {
      text,
      usedShort,
      lines: measured.lines,
      lineCount: measured.lines.length,
      fontSizePx: fontSize,
      lineHeightPx,
      widthPx,
      heightPx,
      fitsWidth: widthOk,
      fitsHeight: heightPx <= box.heightPx + FIT_EPS,
    };
  };

  let low = minFont;
  let high = maxFont;
  let best: LabelLayout | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = layoutAt(mid);
    if (candidate.fitsWidth && candidate.fitsHeight) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Fall back to the smallest size if even that overflows, so the caller always
  // gets a layout and can see it did not fit.
  return best ?? layoutAt(minFont);
}

// Draw a label to a canvas texture. The canvas is sized to the box times the
// device pixel ratio, and the text is drawn in CSS pixels under a matching
// scale, so the glyphs are crisp on a high-density display.
export function createLabelTexture(
  spec: LabelSpec,
  box: LabelBox,
  options: LabelOptions = {},
): LabelTexture {
  const layout = layoutLabel(spec, box, options);
  const family = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const color = options.color ?? DEFAULT_LABEL_COLOR;
  const dpr = options.devicePixelRatio ?? 1;

  const canvas = document.createElement("canvas");
  const textureWidth = Math.max(1, Math.round(box.widthPx * dpr));
  const textureHeight = Math.max(1, Math.round(box.heightPx * dpr));
  canvas.width = textureWidth;
  canvas.height = textureHeight;

  const context = canvas.getContext("2d");
  if (context === null) throw new Error("A label needs a 2D canvas context.");

  context.scale(dpr, dpr);
  context.font = `${layout.fontSizePx}px ${family}`;
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const blockTop = (box.heightPx - layout.heightPx) / 2;
  const centerX = box.widthPx / 2;
  for (let index = 0; index < layout.lines.length; index += 1) {
    const line = layout.lines[index];
    if (line === undefined) continue;
    const centerY = blockTop + index * layout.lineHeightPx + layout.lineHeightPx / 2;
    context.fillText(line, centerX, centerY);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return { texture, canvas, layout, textureWidth, textureHeight };
}
