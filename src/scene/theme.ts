export type ThemePreference = "auto" | "light" | "dark";
export type ThemeMode = Exclude<ThemePreference, "auto">;

export interface BackgroundMarkTokens {
  readonly light: string;
  readonly dark: string;
  readonly opacity: number;
}

export interface ThemeTokens {
  readonly lightGround: string;
  readonly darkGround: string;
  readonly ball: string;
  readonly ink: string;
  readonly accent: string;
  readonly grey: string;
  readonly backgroundMark?: BackgroundMarkTokens;
}

export const K2_THEME_TOKENS: ThemeTokens = Object.freeze({
  lightGround: "#f6f6fa",
  darkGround: "#100f24",
  ball: "#181737",
  ink: "#181737",
  accent: "#1f9c5b",
  grey: "#bfc0c9",
  backgroundMark: Object.freeze({
    light: "/brand/k2-mark.png",
    dark: "/brand/k2-mark-knockout.png",
    opacity: 0.05,
  }),
});

export interface ThemeTreatment {
  readonly mode: ThemeMode;
  readonly ground: string;
  readonly surface: string;
  readonly ink: string;
  readonly mutedInk: string;
  readonly accent: string;
  readonly ball: string;
  readonly peg: string;
  readonly wall: string;
  readonly spentCap: string;
  readonly spentFill: string;
  readonly retiredCap: string;
  readonly shadow: string;
  readonly backgroundMark: { readonly url: string; readonly opacity: number } | null;
  readonly environmentIntensity: number;
  readonly ballEmissiveIntensity: number;
  readonly pegEmissiveIntensity: number;
  readonly shadowOpacity: number;
}

export interface HostAppearanceEvent {
  readonly matches: boolean;
}

export type HostAppearanceListener = (event: HostAppearanceEvent) => void;

export interface HostAppearanceQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: HostAppearanceListener): void;
  removeEventListener(type: "change", listener: HostAppearanceListener): void;
}

export interface ThemeController {
  readonly current: ThemeTreatment;
  subscribe(listener: (treatment: ThemeTreatment) => void): () => void;
  dispose(): void;
}

export interface ThemeControllerOptions {
  readonly mode: ThemePreference;
  readonly tokens: ThemeTokens;
  readonly hostAppearance?: () => HostAppearanceQuery;
}

export function resolveThemeMode(
  preference: ThemePreference,
  hostUsesDark: boolean,
): ThemeMode {
  if (preference === "light" || preference === "dark") return preference;
  return hostUsesDark ? "dark" : "light";
}

// Mix a hex color toward the ground color. Used to quiet structural elements
// without adding new tokens: the wall tone stays derived, so a retheme through
// settings carries it automatically.
function mixTowardGround(colorHex: string, groundHex: string, amount: number): string {
  const c = parseInt(colorHex.slice(1), 16);
  const g = parseInt(groundHex.slice(1), 16);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * amount);
  const r = mix((c >> 16) & 0xff, (g >> 16) & 0xff);
  const gr = mix((c >> 8) & 0xff, (g >> 8) & 0xff);
  const b = mix(c & 0xff, g & 0xff);
  return `#${((r << 16) | (gr << 8) | b).toString(16).padStart(6, "0")}`;
}

export function createThemeTreatment(
  mode: ThemeMode,
  tokens: ThemeTokens,
): ThemeTreatment {
  const ground = mode === "light" ? tokens.lightGround : tokens.darkGround;
  const backgroundMark = tokens.backgroundMark;
  return Object.freeze({
    mode,
    ground,
    // The modal card sits on a raised surface, not on the bare ground, so the
    // reveal reads as a layer above the board in both treatments.
    surface: mixTowardGround(ground, "#ffffff", mode === "light" ? 0.75 : 0.11),
    ink: mode === "light" ? tokens.ink : tokens.lightGround,
    mutedInk: tokens.grey,
    accent: tokens.accent,
    ball: tokens.ball,
    peg: tokens.grey,
    // Walls sit a step quieter than the pegs, but they have to hold their own
    // against the bucket panels behind them: washed all the way to the ground
    // they disappear, at full grey they turn into a fence. This mix keeps them
    // clearly drawn dividers.
    wall: mixTowardGround(tokens.grey, ground, mode === "light" ? 0.52 : 0.68),
    spentCap: tokens.ball,
    spentFill: tokens.grey,
    retiredCap: tokens.grey,
    shadow: tokens.ball,
    backgroundMark: backgroundMark === undefined
      ? null
      : Object.freeze({ url: backgroundMark[mode], opacity: backgroundMark.opacity }),
    environmentIntensity: mode === "light" ? 0.5 : 0.82,
    ballEmissiveIntensity: mode === "light" ? 0 : 0.9,
    pegEmissiveIntensity: mode === "light" ? 0 : 0.12,
    shadowOpacity: mode === "light" ? 0.18 : 0.1,
  });
}

export function applyDocumentTheme(
  treatment: ThemeTreatment,
  host: HTMLElement = document.documentElement,
): void {
  host.style.setProperty("--board-ground", treatment.ground);
  host.style.setProperty("--board-ink", treatment.ink);
  if (host !== document.documentElement) {
    document.documentElement.style.setProperty("--board-ground", treatment.ground);
    document.documentElement.style.setProperty("--board-ink", treatment.ink);
  }
  document.documentElement.style.backgroundColor = treatment.ground;
  document.body.style.backgroundColor = treatment.ground;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", treatment.ground);
}

function browserHostAppearance(): HostAppearanceQuery {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    get matches() {
      return query.matches;
    },
    addEventListener(_type, listener) {
      query.addEventListener("change", listener);
    },
    removeEventListener(_type, listener) {
      query.removeEventListener("change", listener);
    },
  };
}

export function createThemeController(options: ThemeControllerOptions): ThemeController {
  const listeners = new Set<(treatment: ThemeTreatment) => void>();
  const query = options.mode === "auto"
    ? (options.hostAppearance ?? browserHostAppearance)()
    : null;
  let current = createThemeTreatment(
    resolveThemeMode(options.mode, query?.matches ?? false),
    options.tokens,
  );
  let disposed = false;

  const handleAppearanceChange: HostAppearanceListener = ({ matches }) => {
    if (disposed) return;
    const nextMode = resolveThemeMode(options.mode, matches);
    if (nextMode === current.mode) return;
    current = createThemeTreatment(nextMode, options.tokens);
    for (const listener of listeners) listener(current);
  };
  query?.addEventListener("change", handleAppearanceChange);

  return {
    get current() {
      return current;
    },
    subscribe(listener) {
      if (disposed) throw new Error("The theme controller is disposed.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      query?.removeEventListener("change", handleAppearanceChange);
      listeners.clear();
    },
  };
}
