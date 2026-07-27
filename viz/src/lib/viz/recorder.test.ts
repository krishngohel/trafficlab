import { describe, expect, it } from "vitest";

import { CAPTURE_FPS, FrameGate, sanitizeFilePart } from "./recorder";

/** Feed a gate `count` ticks spaced `stepMs` apart, return how many passed. */
function admitted(gate: FrameGate, count: number, stepMs: number, t0 = 1000): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (gate.allow(t0 + i * stepMs)) n++;
  return n;
}

describe("FrameGate", () => {
  it("admits the first frame immediately", () => {
    expect(new FrameGate(30).allow(0)).toBe(true);
  });

  it("holds a 60 fps render loop down to the capture rate", () => {
    // One second of 60 Hz animation frames must not push 60 frames at the
    // encoder — that is exactly what emptied the recording.
    const n = admitted(new FrameGate(CAPTURE_FPS), 60, 1000 / 60);
    expect(n).toBeLessThanOrEqual(CAPTURE_FPS + 1);
    expect(n).toBeGreaterThanOrEqual(CAPTURE_FPS - 2);
  });

  it("passes every frame through when the loop is slower than the cap", () => {
    expect(admitted(new FrameGate(30), 10, 100)).toBe(10);
  });

  it("tolerates jitter that lands a tick a hair early", () => {
    const gate = new FrameGate(30); // 33.3 ms period
    expect(gate.allow(0)).toBe(true);
    expect(gate.allow(31)).toBe(true); // 2.3 ms early, still admitted
    expect(gate.allow(40)).toBe(false); // 9 ms early, dropped
  });

  it("setRate changes the admitted rate", () => {
    const gate = new FrameGate(30);
    gate.setRate(10);
    expect(gate.rate).toBe(10);
    expect(admitted(gate, 60, 1000 / 60)).toBeLessThanOrEqual(11);
  });

  it("never allows a rate below 1 fps", () => {
    const gate = new FrameGate(0);
    expect(gate.rate).toBe(1);
    gate.setRate(-5);
    expect(gate.rate).toBe(1);
  });
});

describe("sanitizeFilePart", () => {
  it("keeps word characters and collapses the rest", () => {
    expect(sanitizeFilePart("max_pressure stress/grid4x4")).toBe("max_pressure-stress-grid4x4");
  });

  it("falls back when nothing usable survives", () => {
    expect(sanitizeFilePart("///")).toBe("replay");
  });
});
