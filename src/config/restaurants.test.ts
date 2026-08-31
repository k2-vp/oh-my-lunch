import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_GEOMETRY } from "../drop/geometry.ts";
import { K2_THEME_TOKENS } from "../scene/theme.ts";
import {
  DEFAULT_REDROP_KEY,
  DEFAULT_REDROP_WINDOW_SECONDS,
  parseRestaurantConfig,
  type ParseResult,
} from "./restaurants.ts";

// A minimal config with two restaurants and no settings block. Callers spread
// in the piece they want to test.
function base(): unknown {
  return { restaurants: [{ name: "Alpha" }, { name: "Beta" }] };
}

function withSettings(settings: unknown): unknown {
  return { restaurants: [{ name: "Alpha" }, { name: "Beta" }], settings };
}

function expectField(result: ParseResult, field: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.field).toBe(field);
}

describe("the shipped seed file", () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../data/restaurants.json", import.meta.url), "utf8"),
  );
  const result = parseRestaurantConfig(raw);

  it("parses", () => {
    expect(result.ok).toBe(true);
  });

  it("holds the fourteen confirmed restaurants", () => {
    if (!result.ok) throw new Error("seed did not parse");
    expect(result.config.restaurants.map((r) => r.name)).toEqual([
      "Golden Bowl",
      "Taco Cantina",
      "Cluck-n-Go",
      "Sub Station",
      "Noodle Co-op",
      "Hero House",
      "Daily Bread",
      "Pizza by the Slice",
      "Casa Verde",
      "Corner Deli",
      "Burger Barn",
      "Gyro Stop",
      "Kitchen Table",
      "Ten Minute Hand-Pulled Noodle House",
    ]);
  });

  it("carries the documented default settings", () => {
    if (!result.ok) throw new Error("seed did not parse");
    expect(result.config.settings).toEqual({
      schedule: { time: "12:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
      mode: "auto",
      redropKey: "r",
      redropWindowSeconds: 90,
      theme: K2_THEME_TOKENS,
    });
  });
});

describe("restaurant entries", () => {
  it("rejects a list larger than the board and names the limit", () => {
    const result = parseRestaurantConfig({
      restaurants: Array.from(
        { length: BOARD_GEOMETRY.laneCount + 1 },
        (_, index) => ({ name: `Place ${index + 1}` }),
      ),
    });

    expectField(result, "restaurants");
    if (!result.ok) {
      expect(result.message).toContain(String(BOARD_GEOMETRY.laneCount));
    }
  });

  it("accepts an entry with only a name", () => {
    const result = parseRestaurantConfig({ restaurants: [{ name: "Solo" }, { name: "Duo" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.restaurants[0]).toEqual({ name: "Solo" });
  });

  it("accepts an optional short label", () => {
    const result = parseRestaurantConfig({
      restaurants: [{ name: "Ten Minute Hand-Pulled Noodle House", short: "Ten Minute" }, { name: "Duo" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.restaurants[0]?.short).toBe("Ten Minute");
  });

  it("rejects a blank name and names the field", () => {
    expectField(parseRestaurantConfig({ restaurants: [{ name: "  " }] }), "restaurants[0].name");
  });

  it("rejects a non-string name", () => {
    expectField(parseRestaurantConfig({ restaurants: [{ name: 7 }] }), "restaurants[0].name");
  });

  it("rejects a duplicate name at the second occurrence", () => {
    expectField(
      parseRestaurantConfig({ restaurants: [{ name: "Twin" }, { name: "Twin" }] }),
      "restaurants[1].name",
    );
  });

  it("treats names that differ only in case as duplicates", () => {
    expectField(
      parseRestaurantConfig({ restaurants: [{ name: "Golden Bowl" }, { name: "golden bowl" }] }),
      "restaurants[1].name",
    );
  });

  it("rejects a blank short label", () => {
    expectField(
      parseRestaurantConfig({ restaurants: [{ name: "A", short: "" }] }),
      "restaurants[0].short",
    );
  });

  it("rejects an unknown field on an entry", () => {
    expectField(
      parseRestaurantConfig({ restaurants: [{ name: "A", nickname: "Al" }] }),
      "restaurants[0].nickname",
    );
  });
});

describe("the settings block", () => {
  it("fills every default when settings is absent", () => {
    const result = parseRestaurantConfig(base());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settings.redropKey).toBe(DEFAULT_REDROP_KEY);
      expect(result.config.settings.redropWindowSeconds).toBe(DEFAULT_REDROP_WINDOW_SECONDS);
      expect(result.config.settings.theme).toEqual(K2_THEME_TOKENS);
    }
  });

  it("fills the rest when only one setting is given", () => {
    const result = parseRestaurantConfig(withSettings({ mode: "dark" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settings.mode).toBe("dark");
      expect(result.config.settings.schedule).toEqual({
        time: "12:00",
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
      });
    }
  });

  it("rejects an invalid time", () => {
    expectField(withResult(withSettings({ schedule: { time: "25:00" } })), "settings.schedule.time");
    expectField(withResult(withSettings({ schedule: { time: "noon" } })), "settings.schedule.time");
    expectField(withResult(withSettings({ schedule: { time: "9:5" } })), "settings.schedule.time");
  });

  it("accepts a valid time at the edges", () => {
    expect(withResult(withSettings({ schedule: { time: "00:00" } })).ok).toBe(true);
    expect(withResult(withSettings({ schedule: { time: "23:59" } })).ok).toBe(true);
  });

  it("rejects an invalid weekday and names the index", () => {
    expectField(
      withResult(withSettings({ schedule: { weekdays: ["mon", "funday"] } })),
      "settings.schedule.weekdays[1]",
    );
  });

  it("rejects a duplicate weekday", () => {
    expectField(
      withResult(withSettings({ schedule: { weekdays: ["mon", "mon"] } })),
      "settings.schedule.weekdays[1]",
    );
  });

  it("rejects an empty weekday list", () => {
    expectField(withResult(withSettings({ schedule: { weekdays: [] } })), "settings.schedule.weekdays");
  });

  it("rejects an invalid mode", () => {
    expectField(withResult(withSettings({ mode: "blue" })), "settings.mode");
  });

  it("accepts a full theme and preserves its editable tokens", () => {
    const theme = {
      lightGround: "#f0f1f2",
      darkGround: "#101112",
      ball: "#202122",
      ink: "#303132",
      accent: "#405142",
      grey: "#b0b1b2",
      backgroundMark: {
        light: "/brand/light.png",
        dark: "/brand/dark.png",
        opacity: 0.04,
      },
    };
    const result = withResult(withSettings({ theme }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.settings.theme).toEqual(theme);
  });

  it("removes the background mark when its settings key is absent", () => {
    const result = withResult(withSettings({ theme: {} }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.settings.theme).toMatchObject({
      lightGround: "#f6f6fa",
      darkGround: "#100f24",
      ball: "#181737",
      ink: "#181737",
      accent: "#1f9c5b",
      grey: "#bfc0c9",
    });
    expect(result.config.settings.theme.backgroundMark).toBeUndefined();
  });

  it("rejects malformed colors, marks, opacity, and unknown theme fields", () => {
    expectField(
      withResult(withSettings({ theme: { accent: "green" } })),
      "settings.theme.accent",
    );
    expectField(
      withResult(withSettings({ theme: { backgroundMark: { opacity: 0.2 } } })),
      "settings.theme.backgroundMark.opacity",
    );
    expectField(
      withResult(withSettings({ theme: { backgroundMark: { opacity: null } } })),
      "settings.theme.backgroundMark.opacity",
    );
    expectField(
      withResult(withSettings({ theme: { backgroundMark: { light: " " } } })),
      "settings.theme.backgroundMark.light",
    );
    expectField(
      withResult(withSettings({ theme: { backgroundMark: { light: null } } })),
      "settings.theme.backgroundMark.light",
    );
    expectField(
      withResult(withSettings({ theme: { glow: "#ffffff" } })),
      "settings.theme.glow",
    );
  });

  it("rejects an invalid re-drop key", () => {
    expectField(withResult(withSettings({ redropKey: "" })), "settings.redropKey");
    expectField(withResult(withSettings({ redropKey: "  " })), "settings.redropKey");
    expectField(withResult(withSettings({ redropKey: "NotAKey" })), "settings.redropKey");
  });

  it("accepts a single character or a named key", () => {
    expect(withResult(withSettings({ redropKey: "R" })).ok).toBe(true);
    expect(withResult(withSettings({ redropKey: "Enter" })).ok).toBe(true);
  });

  it("rejects an invalid re-drop window", () => {
    expectField(withResult(withSettings({ redropWindowSeconds: 0 })), "settings.redropWindowSeconds");
    expectField(withResult(withSettings({ redropWindowSeconds: -5 })), "settings.redropWindowSeconds");
    expectField(withResult(withSettings({ redropWindowSeconds: 1.5 })), "settings.redropWindowSeconds");
    expectField(withResult(withSettings({ redropWindowSeconds: "90" })), "settings.redropWindowSeconds");
  });

  it("rejects an unknown setting", () => {
    expectField(withResult(withSettings({ volume: 11 })), "settings.volume");
  });
});

describe("the top-level shape", () => {
  it("rejects a non-object root", () => {
    expectField(parseRestaurantConfig([]), "(root)");
    expectField(parseRestaurantConfig(null), "(root)");
    expectField(parseRestaurantConfig("nope"), "(root)");
  });

  it("rejects a missing or non-array restaurants field", () => {
    expectField(parseRestaurantConfig({ settings: {} }), "restaurants");
    expectField(parseRestaurantConfig({ restaurants: "many" }), "restaurants");
  });

  it("rejects an unknown top-level field", () => {
    expectField(parseRestaurantConfig({ restaurants: [{ name: "A" }], history: [] }), "history");
  });
});

function withResult(raw: unknown): ParseResult {
  return parseRestaurantConfig(raw);
}
