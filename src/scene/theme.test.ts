import { describe, expect, it } from "vitest";
import {
  K2_THEME_TOKENS,
  createThemeController,
  createThemeTreatment,
  resolveThemeMode,
  type HostAppearanceListener,
  type HostAppearanceQuery,
} from "./theme.ts";

class TestAppearanceQuery implements HostAppearanceQuery {
  matches: boolean;
  private readonly listeners = new Set<HostAppearanceListener>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: HostAppearanceListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: HostAppearanceListener): void {
    this.listeners.delete(listener);
  }

  setDark(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

describe("K2 theme tokens", () => {
  it("ships the approved palette and removable background marks", () => {
    expect(K2_THEME_TOKENS).toEqual({
      lightGround: "#f6f6fa",
      darkGround: "#100f24",
      ball: "#181737",
      ink: "#181737",
      accent: "#1f9c5b",
      grey: "#bfc0c9",
      backgroundMark: {
        light: "/brand/k2-mark.png",
        dark: "/brand/k2-mark-knockout.png",
        opacity: 0.05,
      },
    });
  });

  it("uses the same tokens and geometry-neutral values in both treatments", () => {
    const light = createThemeTreatment("light", K2_THEME_TOKENS);
    const dark = createThemeTreatment("dark", K2_THEME_TOKENS);

    expect(light.mode).toBe("light");
    expect(light.ground).toBe("#f6f6fa");
    expect(light.ink).toBe("#181737");
    expect(light.ball).toBe("#181737");
    expect(light.peg).toBe("#bfc0c9");
    expect(light.retiredCap).toBe("#bfc0c9");
    expect(light.accent).toBe("#1f9c5b");
    expect(light.backgroundMark).toEqual({
      url: "/brand/k2-mark.png",
      opacity: 0.05,
    });

    expect(dark.mode).toBe("dark");
    expect(dark.ground).toBe("#100f24");
    expect(dark.ink).toBe("#f6f6fa");
    expect(dark.ball).toBe(light.ball);
    expect(dark.peg).toBe(light.peg);
    expect(dark.retiredCap).toBe(light.retiredCap);
    expect(dark.accent).toBe(light.accent);
    expect(dark.backgroundMark).toEqual({
      url: "/brand/k2-mark-knockout.png",
      opacity: 0.05,
    });
    expect(dark.ballEmissiveIntensity).toBeGreaterThan(light.ballEmissiveIntensity);
    expect(dark.pegEmissiveIntensity).toBeGreaterThan(light.pegEmissiveIntensity);
  });

  it("renders no mark when the settings omit its key", () => {
    const { backgroundMark: _removed, ...withoutMark } = K2_THEME_TOKENS;

    expect(createThemeTreatment("light", withoutMark).backgroundMark).toBeNull();
    expect(createThemeTreatment("dark", withoutMark).backgroundMark).toBeNull();
  });
});

describe("mode resolution", () => {
  it("honors both overrides and otherwise follows the host", () => {
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
    expect(resolveThemeMode("auto", false)).toBe("light");
    expect(resolveThemeMode("auto", true)).toBe("dark");
  });

  it("follows live host changes while mode is automatic", () => {
    const query = new TestAppearanceQuery(false);
    const controller = createThemeController({
      mode: "auto",
      tokens: K2_THEME_TOKENS,
      hostAppearance: () => query,
    });
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((treatment) => seen.push(treatment.mode));

    expect(controller.current.mode).toBe("light");
    expect(query.listenerCount()).toBe(1);
    query.setDark(true);
    expect(controller.current.mode).toBe("dark");
    query.setDark(false);
    expect(controller.current.mode).toBe("light");
    expect(seen).toEqual(["dark", "light"]);

    unsubscribe();
    controller.dispose();
    expect(query.listenerCount()).toBe(0);
  });

  it("does not listen to host changes when settings force a mode", () => {
    const query = new TestAppearanceQuery(false);
    let queryCalls = 0;
    const controller = createThemeController({
      mode: "dark",
      tokens: K2_THEME_TOKENS,
      hostAppearance: () => {
        queryCalls += 1;
        return query;
      },
    });

    expect(controller.current.mode).toBe("dark");
    expect(queryCalls).toBe(0);
    expect(query.listenerCount()).toBe(0);
    query.setDark(false);
    expect(controller.current.mode).toBe("dark");
    controller.dispose();
  });
});
