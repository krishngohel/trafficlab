import { describe, expect, it } from "vitest";

import { evalRamp, pressureColor, queueColor, speedColor, type RGB } from "./ramps";

const rgb = (): RGB => ({ r: 0, g: 0, b: 0 });

describe("evalRamp", () => {
  const stops: [number, number, number][] = [
    [0, 0, 0],
    [1, 0.5, 0.25],
  ];

  it("hits endpoints and clamps", () => {
    expect(evalRamp(stops, 0, rgb())).toEqual({ r: 0, g: 0, b: 0 });
    expect(evalRamp(stops, 1, rgb())).toEqual({ r: 1, g: 0.5, b: 0.25 });
    expect(evalRamp(stops, -3, rgb())).toEqual({ r: 0, g: 0, b: 0 });
    expect(evalRamp(stops, 9, rgb())).toEqual({ r: 1, g: 0.5, b: 0.25 });
  });

  it("interpolates linearly between stops", () => {
    const out = evalRamp(stops, 0.5, rgb());
    expect(out.r).toBeCloseTo(0.5);
    expect(out.g).toBeCloseTo(0.25);
    expect(out.b).toBeCloseTo(0.125);
  });

  it("handles degenerate stop lists", () => {
    expect(evalRamp([], 0.5, rgb())).toEqual({ r: 0, g: 0, b: 0 });
    expect(evalRamp([[0.2, 0.4, 0.6]], 0.7, rgb())).toEqual({ r: 0.2, g: 0.4, b: 0.6 });
  });
});

describe("semantic ramps", () => {
  it("speedColor: stopped is red, at-limit is blue", () => {
    const slow = speedColor(0, rgb());
    expect(slow.r).toBeGreaterThan(slow.b);
    const fast = speedColor(1, rgb());
    expect(fast.b).toBeGreaterThan(fast.r);
    const mid = speedColor(0.5, rgb());
    expect(mid.r).toBeGreaterThan(0.85);
    expect(mid.g).toBeGreaterThan(0.85);
    expect(mid.b).toBeGreaterThan(0.85);
  });

  it("queueColor: empty is green, saturated is red", () => {
    const empty = queueColor(0, rgb());
    expect(empty.g).toBeGreaterThan(empty.r);
    const full = queueColor(1, rgb());
    expect(full.r).toBeGreaterThan(full.g);
  });

  it("pressureColor: symmetric around zero, red negative / blue positive", () => {
    const neg = pressureColor(-1, rgb());
    expect(neg.r).toBeGreaterThan(neg.b);
    const pos = pressureColor(1, rgb());
    expect(pos.b).toBeGreaterThan(pos.r);
    const zero = pressureColor(0, rgb());
    expect(Math.abs(zero.r - zero.b)).toBeLessThan(0.15);
    // Clamped outside [-1, 1].
    expect(pressureColor(-5, rgb())).toEqual(neg);
    expect(pressureColor(5, rgb())).toEqual(pos);
  });
});
