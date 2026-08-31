import { BOARD_GEOMETRY } from "../drop/geometry.ts";
import {
  K2_THEME_TOKENS,
  type ThemePreference,
  type ThemeTokens,
} from "../scene/theme.ts";

// The restaurant list and the board's settings live in one human-owned file,
// data/restaurants.json. People edit it by hand, from a shell, or through
// anything with file access, so a bad edit must fail loudly and name the field
// that is wrong. Silently dropping a mistyped value would hide the mistake.
//
// This module is pure. It takes already-parsed JSON and returns either a
// normalized config or the first field that is wrong. It does not read the
// file or parse JSON text; the server does that and reports a syntax error on
// its own.

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Mode = ThemePreference;

export interface Restaurant {
  readonly name: string;
  readonly short?: string;
}

export interface Schedule {
  /** 24-hour local time, "HH:MM". */
  readonly time: string;
  readonly weekdays: readonly Weekday[];
}

export interface Settings {
  readonly schedule: Schedule;
  /** "auto" follows the host appearance; "light" or "dark" force one. */
  readonly mode: Mode;
  /** The key that triggers a re-drop, as a KeyboardEvent.key value. */
  readonly redropKey: string;
  readonly redropWindowSeconds: number;
  readonly theme: ThemeTokens;
}

export interface RestaurantConfig {
  readonly restaurants: readonly Restaurant[];
  readonly settings: Settings;
}

/** A wrong field, named by its path. */
export interface ConfigError {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
}

export type ParseResult = { readonly ok: true; readonly config: RestaurantConfig } | ConfigError;

type Parsed<T> = { readonly ok: true; readonly value: T } | ConfigError;

export const WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

export const MODES: readonly Mode[] = ["auto", "light", "dark"];

// Keys that name themselves rather than printing a character. Any single
// printable character is also allowed, so "r" works without listing it here.
export const NAMED_KEYS: readonly string[] = [
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

export const DEFAULT_TIME = "12:00";
export const DEFAULT_WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
];
export const DEFAULT_MODE: Mode = "auto";
export const DEFAULT_REDROP_KEY = "r";
export const DEFAULT_REDROP_WINDOW_SECONDS = 90;

const DEFAULT_SETTINGS: Settings = {
  schedule: { time: DEFAULT_TIME, weekdays: DEFAULT_WEEKDAYS },
  mode: DEFAULT_MODE,
  redropKey: DEFAULT_REDROP_KEY,
  redropWindowSeconds: DEFAULT_REDROP_WINDOW_SECONDS,
  theme: K2_THEME_TOKENS,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const RESTAURANT_KEYS: readonly string[] = ["name", "short"];
const SETTINGS_KEYS: readonly string[] = [
  "schedule",
  "mode",
  "redropKey",
  "redropWindowSeconds",
  "theme",
];
const SCHEDULE_KEYS: readonly string[] = ["time", "weekdays"];
const THEME_KEYS: readonly string[] = [
  "lightGround",
  "darkGround",
  "ball",
  "ink",
  "accent",
  "grey",
  "backgroundMark",
];
const BACKGROUND_MARK_KEYS: readonly string[] = ["light", "dark", "opacity"];

function fail(field: string, message: string): ConfigError {
  return { ok: false, field, message };
}

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function unknownKey(
  object: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function parseRestaurant(value: unknown, index: number): Parsed<Restaurant> {
  const at = `restaurants[${index}]`;
  if (!isObject(value)) return fail(at, "must be an object");

  const stray = unknownKey(value, RESTAURANT_KEYS);
  if (stray !== null) return fail(`${at}.${stray}`, "is not a known field");

  if (typeof value.name !== "string") return fail(`${at}.name`, "must be a string");
  if (isBlank(value.name)) return fail(`${at}.name`, "must not be blank");

  if (value.short === undefined) return ok({ name: value.name });

  if (typeof value.short !== "string") return fail(`${at}.short`, "must be a string");
  if (isBlank(value.short)) return fail(`${at}.short`, "must not be blank");
  return ok({ name: value.name, short: value.short });
}

function parseSchedule(value: unknown): Parsed<Schedule> {
  if (value === undefined) return ok(DEFAULT_SETTINGS.schedule);
  if (!isObject(value)) return fail("settings.schedule", "must be an object");

  const stray = unknownKey(value, SCHEDULE_KEYS);
  if (stray !== null) return fail(`settings.schedule.${stray}`, "is not a known field");

  let time = DEFAULT_TIME;
  if (value.time !== undefined) {
    if (typeof value.time !== "string" || !TIME_PATTERN.test(value.time)) {
      return fail("settings.schedule.time", "must be a 24-hour time, HH:MM");
    }
    time = value.time;
  }

  if (value.weekdays === undefined) return ok({ time, weekdays: DEFAULT_WEEKDAYS });

  if (!Array.isArray(value.weekdays) || value.weekdays.length === 0) {
    return fail("settings.schedule.weekdays", "must be a non-empty array");
  }
  const seen = new Set<string>();
  const weekdays: Weekday[] = [];
  for (let i = 0; i < value.weekdays.length; i += 1) {
    const day = value.weekdays[i];
    if (typeof day !== "string" || !WEEKDAYS.includes(day as Weekday)) {
      return fail(
        `settings.schedule.weekdays[${i}]`,
        "must be one of mon, tue, wed, thu, fri, sat, sun",
      );
    }
    if (seen.has(day)) return fail(`settings.schedule.weekdays[${i}]`, "is a duplicate weekday");
    seen.add(day);
    weekdays.push(day as Weekday);
  }
  return ok({ time, weekdays });
}

function isValidKey(key: string): boolean {
  if (NAMED_KEYS.includes(key)) return true;
  return [...key].length === 1 && !isBlank(key);
}

function parseThemeColor(
  value: unknown,
  field: keyof Omit<ThemeTokens, "backgroundMark">,
): Parsed<string> {
  if (value === undefined) return ok(K2_THEME_TOKENS[field]);
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    return fail(`settings.theme.${field}`, "must be a six-digit hex color");
  }
  return ok(value);
}

function parseTheme(value: unknown): Parsed<ThemeTokens> {
  if (value === undefined) return ok(K2_THEME_TOKENS);
  if (!isObject(value)) return fail("settings.theme", "must be an object");

  const stray = unknownKey(value, THEME_KEYS);
  if (stray !== null) return fail(`settings.theme.${stray}`, "is not a known field");

  const lightGround = parseThemeColor(value.lightGround, "lightGround");
  if (!lightGround.ok) return lightGround;
  const darkGround = parseThemeColor(value.darkGround, "darkGround");
  if (!darkGround.ok) return darkGround;
  const ball = parseThemeColor(value.ball, "ball");
  if (!ball.ok) return ball;
  const ink = parseThemeColor(value.ink, "ink");
  if (!ink.ok) return ink;
  const accent = parseThemeColor(value.accent, "accent");
  if (!accent.ok) return accent;
  const grey = parseThemeColor(value.grey, "grey");
  if (!grey.ok) return grey;

  const colors = {
    lightGround: lightGround.value,
    darkGround: darkGround.value,
    ball: ball.value,
    ink: ink.value,
    accent: accent.value,
    grey: grey.value,
  };
  if (value.backgroundMark === undefined) return ok(colors);
  if (!isObject(value.backgroundMark)) {
    return fail("settings.theme.backgroundMark", "must be an object");
  }

  const mark = value.backgroundMark;
  const markStray = unknownKey(mark, BACKGROUND_MARK_KEYS);
  if (markStray !== null) {
    return fail(`settings.theme.backgroundMark.${markStray}`, "is not a known field");
  }
  const defaultMark = K2_THEME_TOKENS.backgroundMark;
  if (defaultMark === undefined) throw new Error("The shipped theme needs background marks.");
  const light = mark.light === undefined ? defaultMark.light : mark.light;
  if (typeof light !== "string" || isBlank(light)) {
    return fail("settings.theme.backgroundMark.light", "must be a non-blank path");
  }
  const dark = mark.dark === undefined ? defaultMark.dark : mark.dark;
  if (typeof dark !== "string" || isBlank(dark)) {
    return fail("settings.theme.backgroundMark.dark", "must be a non-blank path");
  }
  const opacity = mark.opacity === undefined ? defaultMark.opacity : mark.opacity;
  if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.04 || opacity > 0.06) {
    return fail("settings.theme.backgroundMark.opacity", "must be from 0.04 to 0.06");
  }

  return ok({ ...colors, backgroundMark: { light, dark, opacity } });
}

function parseSettings(value: unknown): Parsed<Settings> {
  if (value === undefined) return ok(DEFAULT_SETTINGS);
  if (!isObject(value)) return fail("settings", "must be an object");

  const stray = unknownKey(value, SETTINGS_KEYS);
  if (stray !== null) return fail(`settings.${stray}`, "is not a known field");

  const schedule = parseSchedule(value.schedule);
  if (!schedule.ok) return schedule;

  let mode: Mode = DEFAULT_MODE;
  if (value.mode !== undefined) {
    if (typeof value.mode !== "string" || !MODES.includes(value.mode as Mode)) {
      return fail("settings.mode", "must be auto, light, or dark");
    }
    mode = value.mode as Mode;
  }

  let redropKey = DEFAULT_REDROP_KEY;
  if (value.redropKey !== undefined) {
    if (typeof value.redropKey !== "string" || !isValidKey(value.redropKey)) {
      return fail("settings.redropKey", "must be a single character or a named key");
    }
    redropKey = value.redropKey;
  }

  let redropWindowSeconds = DEFAULT_REDROP_WINDOW_SECONDS;
  if (value.redropWindowSeconds !== undefined) {
    const seconds = value.redropWindowSeconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
      return fail(
        "settings.redropWindowSeconds",
        "must be a whole number of seconds above zero",
      );
    }
    redropWindowSeconds = seconds;
  }

  const theme = parseTheme(value.theme);
  if (!theme.ok) return theme;

  return ok({
    schedule: schedule.value,
    mode,
    redropKey,
    redropWindowSeconds,
    theme: theme.value,
  });
}

/**
 * Validate parsed JSON as a restaurant config. Returns the normalized config
 * with defaults filled in, or the first field that is wrong.
 */
export function parseRestaurantConfig(raw: unknown): ParseResult {
  if (!isObject(raw)) return fail("(root)", "must be an object");

  const stray = unknownKey(raw, ["restaurants", "settings"]);
  if (stray !== null) return fail(stray, "is not a known field");

  if (!Array.isArray(raw.restaurants)) return fail("restaurants", "must be an array");
  if (raw.restaurants.length > BOARD_GEOMETRY.laneCount) {
    return fail(
      "restaurants",
      `The board supports at most ${BOARD_GEOMETRY.laneCount} restaurants.`,
    );
  }

  const restaurants: Restaurant[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.restaurants.length; i += 1) {
    const result = parseRestaurant(raw.restaurants[i], i);
    if (!result.ok) return result;

    const key = result.value.name.trim().toLowerCase();
    if (seenNames.has(key)) return fail(`restaurants[${i}].name`, "is a duplicate name");
    seenNames.add(key);
    restaurants.push(result.value);
  }

  const settings = parseSettings(raw.settings);
  if (!settings.ok) return settings;

  return { ok: true, config: { restaurants, settings: settings.value } };
}
