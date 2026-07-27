/**
 * Pure helpers for time-series data derived from a `.traj` metrics scan:
 * column extraction, min-max downsampling for charts, signal phase strip
 * segmentation, and small formatting utilities. No three.js, no DOM.
 */

import type { TrajScan } from "./traj";

/** Extract column `col` from a frame-major strided array into a Float32Array. */
export function extractColumn(
  data: ArrayLike<number>,
  stride: number,
  col: number,
): Float32Array {
  if (stride <= 0 || col < 0 || col >= stride) {
    throw new RangeError(`extractColumn: col ${col} out of range for stride ${stride}`);
  }
  const n = Math.floor(data.length / stride);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data[i * stride + col];
  return out;
}

export interface Downsampled {
  /** Source indices (frame numbers), ascending. */
  idx: Float32Array;
  /** Values at those indices. */
  val: Float32Array;
}

/**
 * Downsample a series to at most `maxPoints` points using min-max binning:
 * each bin contributes its min and max in order of occurrence, so spikes
 * survive. Series with length <= maxPoints are returned as-is (copied view).
 */
export function downsampleMinMax(values: ArrayLike<number>, maxPoints: number): Downsampled {
  const n = values.length;
  if (maxPoints < 2) throw new RangeError("downsampleMinMax: maxPoints must be >= 2");
  if (n <= maxPoints) {
    const idx = new Float32Array(n);
    const val = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      idx[i] = i;
      val[i] = values[i];
    }
    return { idx, val };
  }

  const bins = Math.max(1, Math.floor(maxPoints / 2));
  const idx = new Float32Array(bins * 2);
  const val = new Float32Array(bins * 2);
  let out = 0;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * n) / bins);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / bins));
    let minI = start;
    let maxI = start;
    let minV = values[start];
    let maxV = values[start];
    for (let i = start + 1; i < end; i++) {
      const v = values[i];
      if (v < minV) {
        minV = v;
        minI = i;
      }
      if (v > maxV) {
        maxV = v;
        maxI = i;
      }
    }
    // Preserve temporal order within the bin.
    const firstI = Math.min(minI, maxI);
    const secondI = Math.max(minI, maxI);
    idx[out] = firstI;
    val[out] = values[firstI];
    out++;
    if (secondI !== firstI) {
      idx[out] = secondI;
      val[out] = values[secondI];
      out++;
    }
  }
  return { idx: idx.subarray(0, out), val: val.subarray(0, out) };
}

/** A run of frames during which one intersection's (phase, state) is constant. */
export interface PhaseSegment {
  /** First frame of the run (inclusive). */
  start: number;
  /** Last frame of the run (exclusive). */
  end: number;
  /** Phase index into that intersection's phases list. */
  phase: number;
  /** 0 green, 1 yellow, 2 all-red. */
  state: number;
}

/**
 * Collapse the per-frame signal record of intersection `kIndex` into runs of
 * constant (phase, state) — the data behind the timeline phase strip.
 */
export function phaseSegments(scan: TrajScan, kIndex: number): PhaseSegment[] {
  const { numFrames, k, signalPhase, signalState } = scan;
  if (kIndex < 0 || kIndex >= k) return [];
  const segments: PhaseSegment[] = [];
  let start = 0;
  let phase = -1;
  let state = -1;
  for (let i = 0; i < numFrames; i++) {
    const p = signalPhase[i * k + kIndex];
    const s = signalState[i * k + kIndex];
    if (p !== phase || s !== state) {
      if (phase >= 0) segments.push({ start, end: i, phase, state });
      start = i;
      phase = p;
      state = s;
    }
  }
  if (phase >= 0 && numFrames > 0) segments.push({ start, end: numFrames, phase, state });
  return segments;
}

/** Max value of a numeric array (0 for empty). */
export function seriesMax(values: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  return max;
}

/** Max absolute value of a numeric array (0 for empty). */
export function seriesMaxAbs(values: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > max) max = v;
  }
  return max;
}

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). Negative clamps to 0:00. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(min / 60);
  return `${h}:${String(min % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Compact number: 1234 -> "1.2k", 12345678 -> "12.3M". */
export function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
