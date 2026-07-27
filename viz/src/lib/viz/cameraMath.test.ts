import { describe, expect, it } from "vitest";

import { fitOrtho, followOffset, smoothAlpha } from "./cameraMath";

describe("fitOrtho", () => {
  it("fits a square network in a wide viewport (height-limited)", () => {
    const f = fitOrtho(100, 100, 2, 1.1);
    expect(f.halfH).toBeCloseTo(55);
    expect(f.halfW).toBeCloseTo(110);
  });

  it("fits a wide network in a tall viewport (width-limited)", () => {
    const f = fitOrtho(400, 50, 0.5, 1.1);
    expect(f.halfW).toBeCloseTo(220);
    expect(f.halfH).toBeCloseTo(440);
  });

  it("always contains the bounds", () => {
    for (const [w, h, aspect] of [
      [300, 120, 1.77],
      [10, 900, 0.4],
      [55, 55, 1],
      [0, 0, 1.6],
    ]) {
      const f = fitOrtho(w, h, aspect);
      expect(f.halfW * 2).toBeGreaterThanOrEqual(w);
      expect(f.halfH * 2).toBeGreaterThanOrEqual(h);
      expect(f.halfW / f.halfH).toBeCloseTo(aspect);
    }
  });
});

describe("smoothAlpha", () => {
  it("is 0 at dt=0 and approaches 1 for large dt", () => {
    expect(smoothAlpha(0, 5)).toBe(0);
    expect(smoothAlpha(10, 5)).toBeCloseTo(1, 5);
  });

  it("is frame-rate independent: two half-steps equal one full step", () => {
    const one = smoothAlpha(0.2, 4);
    const half = smoothAlpha(0.1, 4);
    const twice = 1 - (1 - half) * (1 - half);
    expect(twice).toBeCloseTo(one, 10);
  });
});

describe("followOffset", () => {
  it("places the camera behind an eastbound vehicle (heading 0)", () => {
    const o = followOffset(0, 20, 8);
    expect(o.x).toBeCloseTo(-20);
    expect(o.y).toBe(8);
    expect(o.z).toBeCloseTo(0);
  });

  it("places the camera south of a northbound vehicle (heading pi/2)", () => {
    // Sim north = -z in scene, so behind = +z.
    const o = followOffset(Math.PI / 2, 20, 8);
    expect(o.x).toBeCloseTo(0);
    expect(o.z).toBeCloseTo(20);
  });
});
