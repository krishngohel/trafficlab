import { describe, expect, it } from "vitest";

import {
  formatSignedPct,
  formatTrend,
  formatWait,
  hasWaitColumns,
  meanWaitAt,
  meanWaitTrend,
  relativeDelta,
  waitColumns,
  type WaitColumns,
} from "./wait";

const NAMES = ["active_vehicles", "cumulative_delay", "throughput", "mean_speed"];
const COLS = waitColumns(NAMES);

/**
 * Synthetic metrics series, frame-major with the real column layout.
 * `spec[i] = [active, delay, throughput]`.
 */
function series(spec: readonly (readonly [number, number, number])[]) {
  const m = NAMES.length;
  const metrics = new Float32Array(spec.length * m);
  spec.forEach(([active, delay, thru], i) => {
    metrics[i * m + COLS.active] = active;
    metrics[i * m + COLS.delay] = delay;
    metrics[i * m + COLS.throughput] = thru;
    metrics[i * m + 3] = 9; // mean_speed, unused
  });
  return { metrics, m, dt: 0.5, numFrames: spec.length };
}

describe("waitColumns", () => {
  it("resolves the real metric layout", () => {
    expect(COLS).toEqual({ delay: 1, throughput: 2, active: 0 });
    expect(hasWaitColumns(COLS)).toBe(true);
  });

  it("reports missing columns as -1", () => {
    const cols = waitColumns(["mean_speed"]);
    expect(cols).toEqual({ delay: -1, throughput: -1, active: -1 });
    expect(hasWaitColumns(cols)).toBe(false);
  });
});

describe("meanWaitAt", () => {
  const s = series([
    [10, 0, 0], // no delay yet
    [10, 200, 10], // 200 / (10 + 10) = 10
    [30, 900, 30], // 900 / (30 + 30) = 15
  ]);

  it("divides cumulative delay by every vehicle seen so far", () => {
    expect(meanWaitAt(s.metrics, s.m, COLS, 0)).toBe(0);
    expect(meanWaitAt(s.metrics, s.m, COLS, 1)).toBeCloseTo(10);
    expect(meanWaitAt(s.metrics, s.m, COLS, 2)).toBeCloseTo(15);
  });

  it("clamps out-of-range frames instead of reading past the array", () => {
    expect(meanWaitAt(s.metrics, s.m, COLS, -5)).toBe(0);
    expect(meanWaitAt(s.metrics, s.m, COLS, 99)).toBeCloseTo(15);
    expect(meanWaitAt(s.metrics, s.m, COLS, 1.9)).toBeCloseTo(10); // floors
  });

  it("never divides by zero on an empty network", () => {
    const empty = series([[0, 42, 0]]);
    expect(meanWaitAt(empty.metrics, empty.m, COLS, 0)).toBe(42);
  });

  it("is NaN when the delay column is missing", () => {
    const cols: WaitColumns = { delay: -1, throughput: 2, active: 0 };
    expect(meanWaitAt(s.metrics, s.m, cols, 1)).toBeNaN();
  });

  it("tolerates a partial metric set (missing throughput)", () => {
    const cols: WaitColumns = { delay: 1, throughput: -1, active: 0 };
    expect(meanWaitAt(s.metrics, s.m, cols, 1)).toBeCloseTo(20); // 200 / 10
  });
});

describe("meanWaitTrend", () => {
  // 0.5 s per frame -> a 60 s window is 120 frames back.
  const rising = series(
    Array.from({ length: 200 }, (_, i) => [10, i * 10, 10] as const),
  );

  it("has no trend before a full window of history exists", () => {
    const t = meanWaitTrend(rising, COLS, 0, 60);
    expect(t.value).toBe(0);
    expect(t.delta).toBeNaN();
    expect(t.pct).toBeNaN();
  });

  it("compares against the frame one window of sim time earlier", () => {
    const t = meanWaitTrend(rising, COLS, 199, 60);
    // frame 199 -> 1990/20 = 99.5 ; frame 79 -> 790/20 = 39.5
    expect(t.value).toBeCloseTo(99.5);
    expect(t.previous).toBeCloseTo(39.5);
    expect(t.delta).toBeCloseTo(60);
    expect(t.pct).toBeCloseTo((60 / 39.5) * 100, 6);
  });

  it("clips the window at the start of the file", () => {
    const t = meanWaitTrend(rising, COLS, 30, 60);
    expect(t.previous).toBeCloseTo(0); // clipped to frame 0
    expect(t.delta).toBeCloseTo(meanWaitAt(rising.metrics, rising.m, COLS, 30));
    expect(t.pct).toBeNaN(); // no usable baseline (previous = 0)
  });

  it("reports a falling mean wait as a negative delta", () => {
    // Delay flat after frame 100 while vehicles keep arriving -> mean wait falls.
    const falling = series(
      Array.from({ length: 200 }, (_, i) => [10, Math.min(i, 100) * 10, i] as const),
    );
    const t = meanWaitTrend(falling, COLS, 199, 60);
    expect(t.delta).toBeLessThan(0);
    expect(t.pct).toBeLessThan(0);
  });

  it("honours the window length in seconds, not frames", () => {
    const wide = meanWaitTrend(rising, COLS, 199, 60);
    const narrow = meanWaitTrend(rising, COLS, 199, 10);
    expect(Math.abs(narrow.delta)).toBeLessThan(Math.abs(wide.delta));
  });

  it("survives a series with no frames", () => {
    const t = meanWaitTrend(series([]), COLS, 0, 60);
    expect(t.value).toBeNaN();
    expect(t.pct).toBeNaN();
  });
});

describe("relativeDelta", () => {
  it("is negative when b beats a", () => {
    expect(relativeDelta(100, 81.7)).toBeCloseTo(-18.3);
  });

  it("is positive when b is worse", () => {
    expect(relativeDelta(80, 100)).toBeCloseTo(25);
  });

  it("is NaN without a usable baseline", () => {
    expect(relativeDelta(0, 10)).toBeNaN();
    expect(relativeDelta(NaN, 10)).toBeNaN();
    expect(relativeDelta(10, NaN)).toBeNaN();
  });
});

describe("formatting", () => {
  it("formats seconds and kiloseconds", () => {
    expect(formatWait(96.44)).toBe("96.4 s");
    expect(formatWait(1740)).toBe("1.74 ks");
    expect(formatWait(NaN)).toBe("–");
  });

  it("puts a direction arrow on the trend", () => {
    expect(formatTrend(-3.21)).toBe("▼ 3.2%");
    expect(formatTrend(0.44)).toBe("▲ 0.4%");
    expect(formatTrend(0)).toBe("0.0%");
    expect(formatTrend(NaN)).toBe("–");
  });

  it("signs the compare delta", () => {
    expect(formatSignedPct(-18.32)).toBe("−18.3%");
    expect(formatSignedPct(4)).toBe("+4.0%");
    expect(formatSignedPct(NaN)).toBe("–");
  });
});
