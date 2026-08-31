import { K2_THEME_TOKENS } from "./theme.ts";

// The winner celebration is a short particle burst in the board's palette. It
// owns one animation frame at a time and stops after a fixed
// duration. No timer or frame remains once the burst ends.

export const CELEBRATION_PALETTE = Object.freeze([
  K2_THEME_TOKENS.accent,
  K2_THEME_TOKENS.ball,
  K2_THEME_TOKENS.grey,
] as const);

const DEFAULT_DURATION_MS = 1_800;
const DEFAULT_PARTICLE_COUNT = 72;
const MAX_DEVICE_PIXEL_RATIO = 2;

export interface CelebrationPoint {
  readonly x: number;
  readonly y: number;
}

export interface CelebrationRuntime {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  prefersReducedMotion(): boolean;
}

export interface CelebrationSnapshot {
  readonly active: boolean;
  readonly durationMs: number;
  readonly particleCount: number;
  readonly frameCount: number;
  readonly origin: CelebrationPoint | null;
  readonly pendingFrame: boolean;
  readonly palette: readonly string[];
}

export interface CelebrationLayer {
  readonly canvas: HTMLCanvasElement;
  burst(origin: CelebrationPoint): void;
  setPalette(palette: readonly string[]): void;
  stop(): void;
  resize(): void;
  getSnapshot(): CelebrationSnapshot;
  dispose(): void;
}

export interface CelebrationOptions {
  readonly durationMs?: number;
  readonly particleCount?: number;
  readonly random?: () => number;
  readonly runtime?: CelebrationRuntime;
  readonly palette?: readonly string[];
}

interface Particle {
  readonly color: string;
  readonly width: number;
  readonly height: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly rotation: number;
  readonly spin: number;
}

function browserRuntime(): CelebrationRuntime {
  return {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a whole number above zero.`);
  }
  return value;
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

type NonEmptyPalette = readonly [string, ...string[]];

function validPalette(palette: readonly string[]): NonEmptyPalette {
  if (palette.length === 0 || palette.some((color) => color.trim().length === 0)) {
    throw new RangeError("The celebration palette needs at least one color.");
  }
  return Object.freeze([...palette]) as NonEmptyPalette;
}

export function createCelebrationLayer(
  host: HTMLElement,
  options: CelebrationOptions = {},
): CelebrationLayer {
  const durationMs = positiveInteger(options.durationMs ?? DEFAULT_DURATION_MS, "Duration");
  const particleCount = positiveInteger(
    options.particleCount ?? DEFAULT_PARTICLE_COUNT,
    "Particle count",
  );
  const random = options.random ?? Math.random;
  const runtime = options.runtime ?? browserRuntime();
  let palette = validPalette(options.palette ?? CELEBRATION_PALETTE);

  const canvas = document.createElement("canvas");
  canvas.className = "board-celebration";
  canvas.hidden = true;
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const candidateContext = canvas.getContext("2d");
  if (candidateContext === null) {
    throw new Error("The celebration needs a 2D canvas context.");
  }
  const context: CanvasRenderingContext2D = candidateContext;

  let cssWidth = 1;
  let cssHeight = 1;
  let startedAt = 0;
  let frameHandle: number | null = null;
  let origin: CelebrationPoint | null = null;
  let particles: readonly Particle[] = [];
  let active = false;
  let frameCount = 0;
  let lastParticleCount = 0;

  function resize(): void {
    const bounds = host.getBoundingClientRect();
    cssWidth = Math.max(1, bounds.width || host.clientWidth);
    cssHeight = Math.max(1, bounds.height || host.clientHeight);
    const dpr = Math.min(
      MAX_DEVICE_PIXEL_RATIO,
      Math.max(1, window.devicePixelRatio || 1),
    );
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear(): void {
    context.clearRect(0, 0, cssWidth, cssHeight);
  }

  function stop(): void {
    if (frameHandle !== null) runtime.cancelFrame(frameHandle);
    frameHandle = null;
    active = false;
    particles = [];
    clear();
    canvas.hidden = true;
    canvas.dataset.active = "false";
  }

  function draw(): void {
    frameHandle = null;
    if (!active || origin === null) return;

    const elapsedMs = runtime.now() - startedAt;
    if (elapsedMs >= durationMs) {
      stop();
      return;
    }

    clear();
    frameCount += 1;
    const elapsedSeconds = Math.max(0, elapsedMs) / 1_000;
    const progress = Math.max(0, Math.min(1, elapsedMs / durationMs));
    const gravity = cssHeight * 1.05;
    context.globalAlpha = 1 - progress * progress;

    for (const particle of particles) {
      const x = origin.x + particle.velocityX * elapsedSeconds;
      const y = origin.y
        + particle.velocityY * elapsedSeconds
        + gravity * elapsedSeconds * elapsedSeconds / 2;
      const angle = particle.rotation + particle.spin * elapsedSeconds;
      context.save();
      context.translate(x, y);
      context.rotate(angle);
      context.fillStyle = particle.color;
      context.fillRect(
        -particle.width / 2,
        -particle.height / 2,
        particle.width,
        particle.height,
      );
      context.restore();
    }
    context.globalAlpha = 1;
    frameHandle = runtime.requestFrame(draw);
  }

  function burst(nextOrigin: CelebrationPoint): void {
    stop();
    resize();
    origin = {
      x: Math.max(0, Math.min(cssWidth, nextOrigin.x)),
      y: Math.max(0, Math.min(cssHeight, nextOrigin.y)),
    };
    lastParticleCount = particleCount;
    frameCount = 0;

    if (runtime.prefersReducedMotion()) return;

    const speedScale = cssHeight;
    particles = Array.from({ length: particleCount }, (): Particle => {
      const direction = -Math.PI + boundedRandom(random) * Math.PI;
      const speed = speedScale * (0.56 + boundedRandom(random) * 0.5);
      const width = speedScale * (0.004 + boundedRandom(random) * 0.005);
      const height = width * (1.5 + boundedRandom(random));
      const paletteIndex = Math.min(
        palette.length - 1,
        Math.floor(boundedRandom(random) * palette.length),
      );
      return {
        color: palette[paletteIndex] ?? palette[0],
        width,
        height,
        velocityX: Math.cos(direction) * speed,
        velocityY: Math.sin(direction) * speed - speedScale * 0.16,
        rotation: boundedRandom(random) * Math.PI,
        spin: (boundedRandom(random) - 0.5) * Math.PI * 5,
      };
    });
    active = true;
    startedAt = runtime.now();
    canvas.hidden = false;
    canvas.dataset.active = "true";
    draw();
  }

  resize();

  return {
    canvas,
    burst,
    setPalette(nextPalette) {
      palette = validPalette(nextPalette);
    },
    stop,
    resize,
    getSnapshot() {
      return {
        active,
        durationMs,
        particleCount: lastParticleCount,
        frameCount,
        origin,
        pendingFrame: frameHandle !== null,
        palette,
      };
    },
    dispose() {
      stop();
      canvas.remove();
    },
  };
}
