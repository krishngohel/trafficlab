import { describe, expect, it } from "vitest";

import {
  downsampleMinMax,
  extractColumn,
  formatCompact,
  formatTime,
  phaseSegments,
  seriesMax,
  seriesMaxAbs,
} from "./series";
import type { TrajScan } from "./traj";

describe("extractColumn", () => {
  it("pulls a strided column", () => {
    const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(extractColumn(data, 3, 0))).toEqual([1, 4, 7]);
    expect(Array.from(extractColumn(data, 3, 2))).toEqual([3, 6, 9]);
  });

  it("rejects out-of-range columns", () => {
    expect(() => extractColumn(new Float32Array(4), 2, 2)).toThrow(RangeError);
    expect(() => extractColumn(new Float32Array(4), 0, 0)).toThrow(RangeError);
  });
});

describe("downsampleMinMax", () => {
  it("returns the series unchanged when short enough", () => {
    const values = [5, 3, 8, 1];
    const ds = downsampleMinMax(values, 10);
    expect(Array.from(ds.idx)).toEqual([0, 1, 2, 3]);
    expect(Array.from(ds.val)).toEqual([5, 3, 8, 1]);
  });

  it("caps output length at maxPoints", () => {
    const values = new Float32Array(10000).map((_, i) => Math.sin(i * 0.01));
    const ds = downsampleMinMax(values, 500);
    expect(ds.val.length).toBeLessThanOrEqual(500);
    expect(ds.val.length).toBeGreaterThan(400);
  });

  it("preserves a single spike among 10k flat points", () => {
    const values = new Float32Array(10000);
    values[7321] = 42;
    const ds = downsampleMinMax(values, 200);
    expect(seriesMax(ds.val)).toBe(42);
  });

  it("preserves min and max and keeps indices sorted", () => {
    const values = new Float32Array(5000).map((_, i) => Math.cos(i * 0.37) * (i % 91));
    const ds = downsampleMinMax(values, 300);
    let trueMin = Infinity;
    let trueMax = -Infinity;
    for (const v of values) {
      trueMin = Math.min(trueMin, v);
      trueMax = Math.max(trueMax, v);
    }
    let dsMin = Infinity;
    let dsMax = -Infinity;
    for (const v of ds.val) {
      dsMin = Math.min(dsMin, v);
      dsMax = Math.max(dsMax, v);
    }
    expect(dsMin).toBe(trueMin);
    expect(dsMax).toBe(trueMax);
    for (let i = 1; i < ds.idx.length; i++) {
      expect(ds.idx[i]).toBeGreaterThan(ds.idx[i - 1]);
    }
  });

  it("rejects maxPoints < 2", () => {
    expect(() => downsampleMinMax([1, 2, 3], 1)).toThrow(RangeError);
  });
});

function fakeScan(k: number, phases: number[][], states: number[][]): TrajScan {
  const n = phases.length;
  const signalPhase = new Uint8Array(n * k);
  const signalState = new Uint8Array(n * k);
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < k; s++) {
      signalPhase[i * k + s] = phases[i][s];
      signalState[i * k + s] = states[i][s];
    }
  }
  return {
    numFrames: n,
    k,
    a: 0,
    m: 0,
    dt: 0.5,
    ticks: new Uint32Array(n),
    signalPhase,
    signalState,
    timeInPhase: new Float32Array(n * k),
    queues: new Uint16Array(0),
    rewards: new Float32Array(n * k),
    metrics: new Float32Array(0),
  };
}

describe("phaseSegments", () => {
  it("collapses runs of constant (phase, state)", () => {
    const scan = fakeScan(
      1,
      [[0], [0], [0], [0], [1], [1], [1], [1], [1]],
      [[0], [0], [1], [2], [0], [0], [0], [1], [1]],
    );
    expect(phaseSegments(scan, 0)).toEqual([
      { start: 0, end: 2, phase: 0, state: 0 },
      { start: 2, end: 3, phase: 0, state: 1 },
      { start: 3, end: 4, phase: 0, state: 2 },
      { start: 4, end: 7, phase: 1, state: 0 },
      { start: 7, end: 9, phase: 1, state: 1 },
    ]);
  });

  it("segments cover every frame exactly once", () => {
    const n = 200;
    const phases = Array.from({ length: n }, (_, i) => [(i >> 4) % 3, 0]);
    const states = Array.from({ length: n }, (_, i) => [i % 3, (i >> 2) % 3]);
    const scan = fakeScan(2, phases, states);
    for (const k of [0, 1]) {
      const segs = phaseSegments(scan, k);
      expect(segs[0].start).toBe(0);
      expect(segs[segs.length - 1].end).toBe(n);
      for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
    }
  });

  it("handles out-of-range intersection and empty scans", () => {
    const scan = fakeScan(1, [], []);
    expect(phaseSegments(scan, 0)).toEqual([]);
    expect(phaseSegments(scan, 5)).toEqual([]);
    expect(phaseSegments(scan, -1)).toEqual([]);
  });
});

describe("formatTime", () => {
  it("formats mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9.7)).toBe("0:09");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(600)).toBe("10:00");
    expect(formatTime(-3)).toBe("0:00");
  });

  it("formats hours past 60 minutes", () => {
    expect(formatTime(3661)).toBe("1:01:01");
  });
});

describe("formatCompact / seriesMaxAbs", () => {
  it("compacts magnitudes", () => {
    expect(formatCompact(3.14159)).toBe("3.14");
    expect(formatCompact(42.5)).toBe("42.5");
    expect(formatCompact(1234)).toBe("1234");
    expect(formatCompact(56789)).toBe("56.8k");
    expect(formatCompact(12345678)).toBe("12.3M");
  });

  it("seriesMaxAbs handles negatives", () => {
    expect(seriesMaxAbs([-5, 2, 3])).toBe(5);
    expect(seriesMaxAbs([])).toBe(0);
  });
});
