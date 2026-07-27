/**
 * Mean-wait statistics derived from the per-frame global metrics series.
 *
 * `cumulative_delay` is the total delay accumulated by every vehicle so far;
 * `throughput` counts vehicles that have already left the network and
 * `active_vehicles` those still in it. So the mean wait *per vehicle seen so
 * far* at frame f is
 *
 *     cumulative_delay[f] / max(1, throughput[f] + active_vehicles[f])
 *
 * Pure math — no three.js, no DOM — so the HUD's numbers are unit tested.
 */

import type { TrajScan } from "./traj";

export interface WaitColumns {
  /** Column index of `cumulative_delay` in the metrics stride, or -1. */
  delay: number;
  /** Column index of `throughput`, or -1. */
  throughput: number;
  /** Column index of `active_vehicles`, or -1. */
  active: number;
}

/** Resolve the metric columns the mean-wait HUD needs (-1 when absent). */
export function waitColumns(metricNames: readonly string[]): WaitColumns {
  return {
    delay: metricNames.indexOf("cumulative_delay"),
    throughput: metricNames.indexOf("throughput"),
    active: metricNames.indexOf("active_vehicles"),
  };
}

/** True when the series carries everything the mean wait needs. */
export function hasWaitColumns(cols: WaitColumns): boolean {
  return cols.delay >= 0 && (cols.throughput >= 0 || cols.active >= 0);
}

/**
 * Mean wait (seconds per vehicle) accumulated up to `frame`. Returns NaN when
 * the file does not carry the required metrics or the frame is out of range.
 * A missing throughput/active column contributes 0 rather than failing, so
 * partial metric sets still produce a usable (if pessimistic) number.
 */
export function meanWaitAt(
  metrics: ArrayLike<number>,
  stride: number,
  cols: WaitColumns,
  frame: number,
): number {
  if (stride <= 0 || cols.delay < 0) return NaN;
  const numFrames = Math.floor(metrics.length / stride);
  if (numFrames === 0) return NaN;
  const f = frame < 0 ? 0 : frame >= numFrames ? numFrames - 1 : Math.floor(frame);
  const base = f * stride;
  const delay = metrics[base + cols.delay];
  const thru = cols.throughput >= 0 ? metrics[base + cols.throughput] : 0;
  const active = cols.active >= 0 ? metrics[base + cols.active] : 0;
  if (!Number.isFinite(delay)) return NaN;
  return delay / Math.max(1, thru + active);
}

export interface WaitTrend {
  /** Mean wait at the playhead (seconds), NaN when unavailable. */
  value: number;
  /** Mean wait `windowSeconds` of sim time earlier, NaN when unavailable. */
  previous: number;
  /** value - previous, in seconds. NaN when there is no history yet. */
  delta: number;
  /** Percent change over the window. NaN when there is no usable baseline. */
  pct: number;
}

/**
 * Mean wait at `frame` plus how it moved over the trailing `windowSeconds` of
 * sim time. Near the start of the file the window is clipped to frame 0; when
 * that leaves no history at all, `delta`/`pct` are NaN (the HUD then shows no
 * arrow rather than a fake "0%").
 */
export function meanWaitTrend(
  scan: Pick<TrajScan, "metrics" | "m" | "dt" | "numFrames">,
  cols: WaitColumns,
  frame: number,
  windowSeconds = 60,
): WaitTrend {
  const value = meanWaitAt(scan.metrics, scan.m, cols, frame);
  const dt = scan.dt > 0 ? scan.dt : 0.5;
  const span = Math.max(1, Math.round(windowSeconds / dt));
  const clamped = Math.min(Math.max(Math.floor(frame), 0), Math.max(scan.numFrames - 1, 0));
  const back = Math.max(0, clamped - span);
  if (back === clamped || !Number.isFinite(value)) {
    return { value, previous: NaN, delta: NaN, pct: NaN };
  }
  const previous = meanWaitAt(scan.metrics, scan.m, cols, back);
  if (!Number.isFinite(previous)) return { value, previous: NaN, delta: NaN, pct: NaN };
  const delta = value - previous;
  return { value, previous, delta, pct: previous > 0 ? (delta / previous) * 100 : NaN };
}

/**
 * Relative difference of `b` against baseline `a`, in percent. Negative means
 * b is smaller (for waiting time: better). NaN when `a` is not a usable base.
 */
export function relativeDelta(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return NaN;
  return ((b - a) / a) * 100;
}

/** "96.4 s" / "1.7 ks" for the HUD value. Non-finite renders as an en dash. */
export function formatWait(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  if (Math.abs(seconds) >= 1000) return `${(seconds / 1000).toFixed(2)} ks`;
  return `${seconds.toFixed(1)} s`;
}

/** "▼ 3.2%" / "▲ 0.4%" / "–" for a percentage change. */
export function formatTrend(pct: number): string {
  if (!Number.isFinite(pct)) return "–";
  if (Math.abs(pct) < 0.05) return "0.0%";
  return `${pct < 0 ? "▼" : "▲"} ${Math.abs(pct).toFixed(1)}%`;
}

/** Signed percentage with an explicit sign, e.g. "-18.3%". */
export function formatSignedPct(pct: number): string {
  if (!Number.isFinite(pct)) return "–";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
