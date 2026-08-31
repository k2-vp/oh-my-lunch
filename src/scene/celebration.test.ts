import { afterEach, describe, expect, it } from "vitest";
import {
  CELEBRATION_PALETTE,
  createCelebrationLayer,
  type CelebrationRuntime,
} from "./celebration.ts";

class TestRuntime implements CelebrationRuntime {
  time = 0;
  reducedMotion = false;
  private nextHandle = 1;
  private callbacks = new Map<number, FrameRequestCallback>();

  now(): number {
    return this.time;
  }

  requestFrame(callback: FrameRequestCallback): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle);
  }

  prefersReducedMotion(): boolean {
    return this.reducedMotion;
  }

  step(time: number): void {
    this.time = time;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(time);
  }

  pendingCount(): number {
    return this.callbacks.size;
  }
}

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function makeHost(): HTMLElement {
  const element = document.createElement("div");
  element.style.cssText = "position:relative;width:400px;height:300px";
  document.body.appendChild(element);
  host = element;
  return element;
}

describe("winner celebration", () => {
  it("runs one palette-bound burst and leaves no frame when it ends", () => {
    const runtime = new TestRuntime();
    const layer = createCelebrationLayer(makeHost(), {
      durationMs: 1_800,
      particleCount: 12,
      random: () => 0.5,
      runtime,
    });

    layer.burst({ x: 200, y: 260 });
    let snapshot = layer.getSnapshot();
    expect(snapshot.active).toBe(true);
    expect(snapshot.particleCount).toBe(12);
    expect(snapshot.origin).toEqual({ x: 200, y: 260 });
    expect(snapshot.palette).toEqual(CELEBRATION_PALETTE);
    expect(snapshot.pendingFrame).toBe(true);
    expect(runtime.pendingCount()).toBe(1);
    expect(layer.canvas.hidden).toBe(false);

    runtime.step(900);
    snapshot = layer.getSnapshot();
    expect(snapshot.active).toBe(true);
    expect(snapshot.frameCount).toBe(2);
    expect(runtime.pendingCount()).toBe(1);

    runtime.step(1_801);
    snapshot = layer.getSnapshot();
    expect(snapshot.active).toBe(false);
    expect(snapshot.pendingFrame).toBe(false);
    expect(runtime.pendingCount()).toBe(0);
    expect(layer.canvas.hidden).toBe(true);

    runtime.step(3_600);
    expect(layer.getSnapshot().frameCount).toBe(2);
    expect(runtime.pendingCount()).toBe(0);
    layer.dispose();
  });

  it("restarts without leaving the first burst scheduled", () => {
    const runtime = new TestRuntime();
    const layer = createCelebrationLayer(makeHost(), { runtime, random: () => 0.25 });
    layer.burst({ x: 10, y: 20 });
    expect(runtime.pendingCount()).toBe(1);

    runtime.time = 100;
    layer.burst({ x: 30, y: 40 });
    expect(runtime.pendingCount()).toBe(1);
    expect(layer.getSnapshot().origin).toEqual({ x: 30, y: 40 });
    layer.dispose();
    expect(runtime.pendingCount()).toBe(0);
  });

  it("stays still when reduced motion is requested", () => {
    const runtime = new TestRuntime();
    runtime.reducedMotion = true;
    const layer = createCelebrationLayer(makeHost(), { runtime });
    layer.burst({ x: 200, y: 260 });

    expect(layer.getSnapshot().active).toBe(false);
    expect(layer.getSnapshot().pendingFrame).toBe(false);
    expect(runtime.pendingCount()).toBe(0);
    expect(layer.canvas.hidden).toBe(true);
    layer.dispose();
  });
});
