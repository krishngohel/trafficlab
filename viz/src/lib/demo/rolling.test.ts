import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  carsClearedAt,
  fallPercent,
  finiteRange,
  meanOverSeconds,
  regimeAt,
  regimeSpan,
  rollingWaitAt,
  rollingWaitSeries,
  waitAxis,
  WAIT_WINDOW_SECONDS,
} from "./rolling";
import { windowFrames } from "./savings";
import { SWITCH_CLIP, SWITCH_RESULT } from "./story";
import { formatClock } from "./format";
import { plotBox, plotX, plotY, sparkLevels, type SparkSpec } from "./spark";
import { parseTraj } from "../traj";

// Four metric columns in the shipped layout order — active, delay, throughput,
// speed — over six frames, so the tests exercise the same column indices the
// page resolves at runtime.
//                 act  delay  thru  speed
const METRICS = [
  /* f0 */ 10, 0, 0, 5,
  /* f1 */ 10, 100, 0, 5, // nobody finished yet
  /* f2 */ 10, 220, 2, 5,
  /* f3 */ 10, 400, 4, 5,
  /* f4 */ 10, 640, 4, 5, // nobody finished during this frame either
  /* f5 */ 10, 900, 10, 5,
];
const STRIDE = 4;
const DELAY = 1;
const THRU = 2;

describe("rollingWaitAt", () => {
  it("divides the window's waiting by the drivers who finished in it", () => {
    // Frames 1..3: delay 400-100 = 300 over throughput 4-0 = 4.
    expect(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 3, 2)).toBeCloseTo(75, 6);
    // Frames 3..5: delay 900-400 = 500 over throughput 10-4 = 6.
    expect(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 5, 2)).toBeCloseTo(500 / 6, 6);
  });

  it("has no answer when nobody finished inside the window", () => {
    // Frames 0..1 and 2..4 both hold the throughput count still.
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 1, 1))).toBe(true);
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 4, 1))).toBe(true);
  });

  it("refuses a partial window rather than calling it 'the last minute'", () => {
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 1, 4))).toBe(true);
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 0, 1))).toBe(true);
    // One frame later there is exactly enough history, and it answers.
    expect(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 4, 4)).toBeCloseTo(640 / 4, 6);
  });

  it("clamps a frame past the end instead of reading off the array", () => {
    expect(rollingWaitAt(METRICS, STRIDE, DELAY, THRU, 99, 2)).toBeCloseTo(500 / 6, 6);
  });

  it("has no answer without the columns it needs", () => {
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, -1, THRU, 3, 2))).toBe(true);
    expect(Number.isNaN(rollingWaitAt(METRICS, STRIDE, DELAY, -1, 3, 2))).toBe(true);
    expect(Number.isNaN(rollingWaitAt([], STRIDE, DELAY, THRU, 3, 2))).toBe(true);
    expect(Number.isNaN(rollingWaitAt(METRICS, 0, DELAY, THRU, 3, 2))).toBe(true);
  });
});

describe("carsClearedAt", () => {
  it("counts the drivers who finished inside the window", () => {
    expect(carsClearedAt(METRICS, STRIDE, THRU, 3, 2)).toBe(4);
    expect(carsClearedAt(METRICS, STRIDE, THRU, 5, 2)).toBe(6);
  });

  it("reports a genuine zero rather than hiding it", () => {
    // Unlike the wait, "nobody got through" is itself the answer here.
    expect(carsClearedAt(METRICS, STRIDE, THRU, 1, 1)).toBe(0);
  });

  it("withholds a partial window, exactly as the wait does", () => {
    expect(Number.isNaN(carsClearedAt(METRICS, STRIDE, THRU, 0, 2))).toBe(true);
  });
});

describe("rollingWaitSeries", () => {
  it("is the same arithmetic as the point reading, frame for frame", () => {
    const series = rollingWaitSeries(METRICS, STRIDE, DELAY, THRU, 2);
    expect(series.length).toBe(6);
    for (let f = 0; f < series.length; f++) {
      const point = rollingWaitAt(METRICS, STRIDE, DELAY, THRU, f, 2);
      if (Number.isNaN(point)) expect(Number.isNaN(series[f])).toBe(true);
      else expect(series[f]).toBeCloseTo(point, 9);
    }
  });

  it("is empty when there is nothing to read", () => {
    expect(rollingWaitSeries([], STRIDE, DELAY, THRU, 2).length).toBe(0);
    expect(rollingWaitSeries(METRICS, 0, DELAY, THRU, 2).length).toBe(0);
  });
});

describe("regimeAt / regimeSpan", () => {
  it("names the light running at a given second", () => {
    expect(regimeAt(0, 300)).toBe("before");
    expect(regimeAt(299.9, 300)).toBe("before");
    expect(regimeAt(300, 300)).toBe("after");
    expect(regimeAt(NaN, 300)).toBe("before");
  });

  it("excludes every window that straddles the handover", () => {
    const before = regimeSpan("before", 300, 60, 600);
    const after = regimeSpan("after", 300, 60, 600);
    expect(before).toEqual({ from: 60, to: 300 });
    expect(after).toEqual({ from: 360, to: 600 });
    // A window ending at `before.to` opens at the switch minus a full window,
    // and one ending at `after.from` opens exactly at the switch.
    expect(before.to - 60).toBeLessThanOrEqual(300);
    expect(after.from - 60).toBeGreaterThanOrEqual(300);
  });

  it("never runs a span past the end of a short clip", () => {
    expect(regimeSpan("after", 300, 60, 320)).toEqual({ from: 320, to: 320 });
    expect(regimeSpan("before", 300, 60, 200)).toEqual({ from: 60, to: 200 });
  });
});

describe("meanOverSeconds", () => {
  const series = [0, 1, 2, 3, 4, 5, NaN, 7];

  it("averages the frames inside the range at the file's own timestep", () => {
    expect(meanOverSeconds(series, 0.5, 0, 1.5)).toBeCloseTo(1.5, 6);
    expect(meanOverSeconds(series, 1, 2, 4)).toBeCloseTo(3, 6);
  });

  it("skips the gaps rather than treating them as zero", () => {
    expect(meanOverSeconds(series, 0.5, 3, 3.5)).toBe(7);
  });

  it("has no answer for an empty or inverted range", () => {
    expect(Number.isNaN(meanOverSeconds(series, 0.5, 3.0, 3.0))).toBe(true);
    expect(Number.isNaN(meanOverSeconds(series, 0.5, 2, 1))).toBe(true);
    expect(Number.isNaN(meanOverSeconds([], 0.5, 0, 10))).toBe(true);
  });
});

describe("waitAxis", () => {
  it("snaps out to round values around the whole series", () => {
    const axis = waitAxis([178.1, 289.0, 204, NaN]);
    expect(axis.lo).toBe(150);
    expect(axis.hi).toBe(300);
    expect(axis.ticks).toEqual([180, 240, 300]);
  });

  it("never collapses to a zero-height range", () => {
    const axis = waitAxis([200, 200]);
    expect(axis.hi).toBeGreaterThan(axis.lo);
  });

  it("survives a series with nothing in it", () => {
    const axis = waitAxis([NaN, NaN]);
    expect(axis.hi).toBeGreaterThan(axis.lo);
    expect(axis.ticks).toEqual([]);
  });
});

describe("finiteRange / fallPercent", () => {
  it("ignores the gaps", () => {
    expect(finiteRange([NaN, 5, NaN, 9])).toEqual({ lo: 5, hi: 9 });
    const empty = finiteRange([NaN]);
    expect(Number.isNaN(empty.lo)).toBe(true);
  });

  it("reads a fall as positive and a rise as negative", () => {
    expect(fallPercent(233, 204)).toBeCloseTo(12.45, 1);
    expect(fallPercent(204, 233)).toBeLessThan(0);
    expect(Number.isNaN(fallPercent(0, 100))).toBe(true);
    expect(Number.isNaN(fallPercent(NaN, 100))).toBe(true);
  });
});

describe("the chart's geometry", () => {
  const box = plotBox(400, 100);
  const axis = { lo: 150, hi: 300, ticks: [180, 240] };

  it("puts the start of the clip at the left edge and the end at the right", () => {
    expect(plotX(0, 600, box)).toBeCloseTo(box.x, 6);
    expect(plotX(600, 600, box)).toBeCloseTo(box.x + box.width, 6);
    expect(plotX(300, 600, box)).toBeCloseTo(box.x + box.width / 2, 6);
  });

  it("draws a smaller wait higher up the chart, which is the whole point", () => {
    expect(plotY(200, axis, box)).toBeGreaterThan(plotY(250, axis, box));
    expect(plotY(axis.hi, axis, box)).toBeCloseTo(box.y, 6);
    expect(plotY(axis.lo, axis, box)).toBeCloseTo(box.y + box.height, 6);
  });

  it("clamps rather than drawing outside its own box", () => {
    expect(plotY(1000, axis, box)).toBeCloseTo(box.y, 6);
    expect(plotY(-5, axis, box)).toBeCloseTo(box.y + box.height, 6);
    expect(plotX(-10, 600, box)).toBeCloseTo(box.x, 6);
    expect(plotX(9999, 600, box)).toBeCloseTo(box.x + box.width, 6);
  });

  it("stays inside a canvas too small to hold its own padding", () => {
    const tiny = plotBox(10, 10);
    expect(tiny.width).toBeGreaterThan(0);
    expect(tiny.height).toBeGreaterThan(0);
  });
});

describe("the chart's reference levels", () => {
  // A clip where the answer is obvious: 100 before the switch, 50 after it.
  const dt = 1;
  const switchAt = 10;
  // Each point is the window ENDING at its own frame, so the frame at the
  // switch is still entirely the timer's — exactly as regimeSpan defines it.
  const series = Array.from({ length: 41 }, (_, f) => (f <= switchAt ? 100 : 50));
  const spec = (playhead: number): SparkSpec => ({
    width: 400,
    height: 100,
    series,
    dt,
    duration: 40,
    axis: waitAxis(series),
    switchAt,
    windowSeconds: 5,
    playhead,
    formatValue: formatClock,
  });

  it("says nothing about the fixed timer until its stretch is over", () => {
    expect(Number.isNaN(sparkLevels(spec(9)).before)).toBe(true);
    expect(sparkLevels(spec(10)).before).toBe(100);
  });

  it("waits for a window to fill and a window to average before drawing the second level", () => {
    expect(Number.isNaN(sparkLevels(spec(19)).after)).toBe(true);
    expect(sparkLevels(spec(20)).after).toBe(50);
  });

  it("never averages clip the visitor has not reached", () => {
    // Everything after frame 30 is 999; a level read at 25 must not see it.
    const peeking = series.slice();
    for (let f = 31; f < peeking.length; f++) peeking[f] = 999;
    const at25 = sparkLevels({ ...spec(25), series: peeking });
    expect(at25.after).toBe(50);
    const atEnd = sparkLevels({ ...spec(40), series: peeking });
    expect(atEnd.after).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// The invariants that matter, measured off the file the page actually ships.
// If a re-recording ever stopped showing the waiting come down, the page would
// be making a claim its own fixture contradicts, and this fails first.
// ---------------------------------------------------------------------------

function scanOf(name: string) {
  const url = new URL(`../../../public/fixtures/${name}`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  const traj = parseTraj(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  return { scan: traj.scanMeta(), names: traj.meta.metrics };
}

const clip = scanOf("switch.traj");
const DT = clip.scan.dt;
const SPAN = windowFrames(DT, SWITCH_RESULT.windowSeconds);
const DELAY_COL = clip.names.indexOf("cumulative_delay");
const THRU_COL = clip.names.indexOf("throughput");
const DURATION = (clip.scan.numFrames - 1) * DT;
const SERIES = rollingWaitSeries(clip.scan.metrics, clip.scan.m, DELAY_COL, THRU_COL, SPAN);

const BEFORE = regimeSpan("before", SWITCH_CLIP.switchAtSeconds, SWITCH_RESULT.windowSeconds, DURATION);
const AFTER = regimeSpan("after", SWITCH_CLIP.switchAtSeconds, SWITCH_RESULT.windowSeconds, DURATION);
const beforeMean = meanOverSeconds(SERIES, DT, BEFORE.from, BEFORE.to);
const afterMean = meanOverSeconds(SERIES, DT, AFTER.from, AFTER.to);

describe("the shipped switch recording", () => {
  it("is the ten minutes at half a second the page says it is", () => {
    expect(DT).toBe(0.5);
    expect(clip.scan.numFrames).toBe(1200);
    // 1200 frames at half a second is 599.5 s of playable clip, one timestep
    // short of the ten minutes the copy calls it.
    expect(SWITCH_CLIP.minutes * 60 - DURATION).toBeCloseTo(DT, 6);
    expect(DELAY_COL).toBeGreaterThanOrEqual(0);
    expect(THRU_COL).toBeGreaterThanOrEqual(0);
    expect(SWITCH_CLIP.switchAtSeconds).toBeLessThan(DURATION);
    expect(WAIT_WINDOW_SECONDS).toBe(SWITCH_RESULT.windowSeconds);
  });

  // THE INVARIANT. The page's entire claim in one line.
  it("waits less after the light changes hands than before it", () => {
    expect(afterMean).toBeLessThan(beforeMean);
    expect(fallPercent(beforeMean, afterMean)).toBeGreaterThan(5);
  });

  it("prints the averages the story quotes", () => {
    expect(beforeMean).toBeCloseTo(SWITCH_RESULT.beforeWaitSeconds, -0.5);
    expect(afterMean).toBeCloseTo(SWITCH_RESULT.afterWaitSeconds, -0.5);
    expect(Math.round(fallPercent(beforeMean, afterMean))).toBe(SWITCH_RESULT.windowFallPct);
    expect(formatClock(Math.round(beforeMean))).toBe(formatClock(SWITCH_RESULT.beforeWaitSeconds));
    expect(formatClock(Math.round(afterMean))).toBe(formatClock(SWITCH_RESULT.afterWaitSeconds));
  });

  it("quotes the ranges honestly, overlap and all", () => {
    const before = { lo: Infinity, hi: -Infinity };
    const after = { lo: Infinity, hi: -Infinity };
    for (let f = 0; f < SERIES.length; f++) {
      const v = SERIES[f];
      if (!Number.isFinite(v)) continue;
      const t = f * DT;
      const into = t >= BEFORE.from && t <= BEFORE.to ? before : t >= AFTER.from ? after : null;
      if (!into) continue;
      into.lo = Math.min(into.lo, v);
      into.hi = Math.max(into.hi, v);
    }
    expect(Math.round(before.lo)).toBe(SWITCH_RESULT.beforeLowSeconds);
    expect(Math.round(before.hi)).toBe(SWITCH_RESULT.beforeHighSeconds);
    expect(Math.round(after.lo)).toBe(SWITCH_RESULT.afterLowSeconds);
    expect(Math.round(after.hi)).toBe(SWITCH_RESULT.afterHighSeconds);
    // The page says these two stretches overlap. They do, and it must keep
    // saying so rather than presenting a clean separation that is not there.
    expect(after.hi).toBeGreaterThan(before.lo);
  });

  it("stays down, in the sense the page claims and no stronger", () => {
    let below = 0;
    let total = 0;
    for (let f = Math.ceil(AFTER.from / DT); f < SERIES.length; f++) {
      if (!Number.isFinite(SERIES[f])) continue;
      total++;
      if (SERIES[f] < beforeMean) below++;
    }
    const pct = (below / total) * 100;
    expect(Math.round(pct)).toBe(SWITCH_RESULT.belowBeforeAveragePct);
    // The copy says "95%", not "always" — so it had better not be always.
    expect(pct).toBeLessThan(100);
  });

  it("withholds the reading until a full window exists, then never stops", () => {
    for (let f = 0; f < SPAN; f++) expect(Number.isNaN(SERIES[f])).toBe(true);
    let gaps = 0;
    for (let f = SPAN; f < SERIES.length; f++) if (!Number.isFinite(SERIES[f])) gaps++;
    expect(gaps).toBe(0);
  });

  it("puts more drivers through after the change, not fewer", () => {
    const perWindow = (from: number, to: number) => {
      let sum = 0;
      let seen = 0;
      for (let f = Math.ceil(from / DT); f <= Math.floor(to / DT); f++) {
        const n = carsClearedAt(clip.scan.metrics, clip.scan.m, THRU_COL, f, SPAN);
        if (Number.isFinite(n)) {
          sum += n;
          seen++;
        }
      }
      return sum / seen;
    };
    const before = perWindow(BEFORE.from, BEFORE.to);
    const after = perWindow(AFTER.from, AFTER.to);
    expect(after).toBeGreaterThan(before);
    expect(Math.round(before)).toBe(SWITCH_RESULT.carsPerMinuteBefore);
    expect(Math.round(after)).toBe(SWITCH_RESULT.carsPerMinuteAfter);
  });
});

describe("the counterfactual the story leans on", () => {
  const held = scanOf("demo_fixed.traj");
  const switchFrame = Math.round(SWITCH_CLIP.switchAtSeconds / DT);
  const lastFrame = clip.scan.numFrames - 1;

  it("is the same simulation as the side-by-side's fixed run, up to the handover", () => {
    // Not "similar": identical, frame for frame. Without this the comparison
    // below would be two different runs wearing the same label.
    expect(held.scan.numFrames).toBe(clip.scan.numFrames);
    expect(held.scan.m).toBe(clip.scan.m);
    for (let f = 0; f <= switchFrame; f++) {
      for (let c = 0; c < clip.scan.m; c++) {
        expect(clip.scan.metrics[f * clip.scan.m + c]).toBe(held.scan.metrics[f * held.scan.m + c]);
      }
    }
  });

  const block = (s: { metrics: ArrayLike<number>; m: number }) => {
    const delay = s.metrics[lastFrame * s.m + DELAY_COL] - s.metrics[switchFrame * s.m + DELAY_COL];
    const cars = s.metrics[lastFrame * s.m + THRU_COL] - s.metrics[switchFrame * s.m + THRU_COL];
    return { wait: delay / cars, cars };
  };

  it("shows the second five minutes going the other way when the timer is left on", () => {
    const responsive = block(clip.scan);
    const fixed = block(held.scan);
    expect(responsive.wait).toBeLessThan(fixed.wait);
    expect(responsive.cars).toBeGreaterThan(fixed.cars);
    expect(Math.round(responsive.wait)).toBe(SWITCH_RESULT.secondHalfWaitSeconds);
    expect(Math.round(fixed.wait)).toBe(SWITCH_RESULT.heldFixedWaitSeconds);
    expect(responsive.cars).toBe(SWITCH_RESULT.secondHalfCars);
    expect(fixed.cars).toBe(SWITCH_RESULT.heldFixedCars);
    expect(Math.round(fallPercent(fixed.wait, responsive.wait))).toBe(SWITCH_RESULT.heldFixedFallPct);
    expect(Math.round((responsive.cars / fixed.cars - 1) * 100)).toBe(
      SWITCH_RESULT.heldFixedMoreCarsPct,
    );
  });

  it("matches the first-half figures the story quotes", () => {
    const delay =
      clip.scan.metrics[switchFrame * clip.scan.m + DELAY_COL] - clip.scan.metrics[DELAY_COL];
    const cars =
      clip.scan.metrics[switchFrame * clip.scan.m + THRU_COL] - clip.scan.metrics[THRU_COL];
    expect(Math.round(delay / cars)).toBe(SWITCH_RESULT.firstHalfWaitSeconds);
    expect(cars).toBe(SWITCH_RESULT.firstHalfCars);
    // And the point of the whole section: the junction was getting WORSE.
    expect(SWITCH_RESULT.heldFixedWaitSeconds).toBeGreaterThan(SWITCH_RESULT.firstHalfWaitSeconds);
  });
});
