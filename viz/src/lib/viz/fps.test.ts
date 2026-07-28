import { describe, expect, it } from "vitest";

import { FpsMeter } from "./fps";

const feed = (m: FpsMeter, ms: number, frames: number, from = 0): number => {
  let now = from;
  for (let i = 0; i < frames; i++) {
    now += ms;
    m.sample(ms / 1000, now);
  }
  return now;
};

describe("FpsMeter", () => {
  it("reads zero before any sample", () => {
    const m = new FpsMeter();
    expect(m.fps).toBe(0);
    expect(m.frameMs).toBe(0);
    expect(m.worstFrameMs).toBe(0);
  });

  it("converges on the true rate for steady frames", () => {
    const m = new FpsMeter();
    feed(m, 1000 / 60, 200);
    expect(m.fps).toBeCloseTo(60, 1);
    expect(m.frameMs).toBeCloseTo(1000 / 60, 2);

    const slow = new FpsMeter();
    feed(slow, 1000 / 30, 200);
    expect(slow.fps).toBeCloseTo(30, 1);
  });

  it("takes the first sample as-is rather than easing up from zero", () => {
    const m = new FpsMeter();
    m.sample(1 / 60, 16.7);
    expect(m.fps).toBeCloseTo(60, 4);
  });

  it("smooths rather than tracking a single frame", () => {
    const m = new FpsMeter();
    feed(m, 1000 / 60, 100);
    m.sample(0.05, 2000); // one 50 ms hitch
    // A raw 1/dt readout would drop to 20; the EMA barely moves.
    expect(m.fps).toBeGreaterThan(45);
  });

  it("reports the worst frame of the last completed second", () => {
    const m = new FpsMeter();
    let now = feed(m, 16, 30); // 480 ms in, window still open
    expect(m.worstFrameMs).toBe(0);
    now += 40;
    m.sample(0.04, now); // 40 ms spike inside the first window
    now = feed(m, 16, 40, now); // pushes past 1 s, closing the window
    expect(m.worstFrameMs).toBeCloseTo(40, 5);
  });

  it("ignores pathological deltas from tab switches", () => {
    const m = new FpsMeter();
    feed(m, 1000 / 60, 100);
    const before = m.fps;
    m.sample(30, 40000); // 30 s: backgrounded tab
    expect(m.fps).toBeCloseTo(before, 6);
  });

  it("ignores non-positive deltas", () => {
    const m = new FpsMeter();
    feed(m, 1000 / 60, 50);
    const before = m.fps;
    m.sample(0, 1000);
    m.sample(-1 / 60, 1001);
    expect(m.fps).toBeCloseTo(before, 6);
  });

  it("resets", () => {
    const m = new FpsMeter();
    feed(m, 1000 / 60, 100);
    m.reset();
    expect(m.fps).toBe(0);
    expect(m.worstFrameMs).toBe(0);
  });
});
