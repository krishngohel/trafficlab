/**
 * THE ONE DEFINITION OF WAITING THE PUBLIC PAGE USES.
 *
 * Every wait figure on the demo page — the rolling reading that falls in part
 * one, the two scoreboards in parts two and three, and every result card under
 * them — is the same arithmetic on the same two series:
 *
 *     waiting the network generated ÷ drivers who actually got through it
 *
 * A recording carries both as cumulative series: `cumulative_delay`, the total
 * delay every driver has piled up so far, and `throughput`, how many drivers
 * have finished their trip. The only thing that varies between the readings on
 * the page is the STRETCH of clip they cover, and that is stated next to each:
 *
 *  - `rollingWaitAt` takes differences over a trailing window, so nothing from
 *    earlier in the clip is carried forward. That is precisely why it can FALL
 *    when the light improves, which is what part one exists to show.
 *  - `waitPerFinisherAt` takes the whole clip so far, so it settles towards a
 *    value rather than falling. That is the scoreboard reading in parts two and
 *    three, where the comparison is between two runs rather than between two
 *    halves of one.
 *
 * The page used to divide the scoreboard's delay by everybody who had ever
 * entered the network instead (finishers plus everyone still driving). That is
 * a defensible statistic — it is the one the repo's ten-run study uses, and it
 * is the stricter of the two — but printing it beside a per-finisher reading
 * made the page contradict itself: the same fixed timer read 3m 53s in part one
 * and 2m 47s in part two. One denominator, stated in the copy, everywhere.
 *
 * HONESTY, twice over. The window is strict: until a full `span` frames exist
 * behind the playhead the answer is NaN, not a partial window dressed up as
 * "the last minute". And when nobody has finished their trip the denominator is
 * zero and the answer is NaN — the page shows a dash rather than a number built
 * by dividing by nothing. Separately, and said out loud in the copy: dividing
 * by finishers is the FLATTERING choice, because it leaves out the drivers
 * still queuing when the recording stops. The study's per-entrant percentages
 * are lower, and the page prints them unchanged.
 *
 * Pure functions only (no DOM, no canvas, no three.js), so every figure the
 * page prints is unit tested.
 */

/** Trailing sim seconds the live wait reading covers. */
export const WAIT_WINDOW_SECONDS = 60;

/** Clamp to a valid frame index. */
function clampFrame(frame: number, numFrames: number): number {
  if (!Number.isFinite(frame)) return -1;
  const f = Math.floor(frame);
  if (f < 0) return 0;
  return f >= numFrames ? numFrames - 1 : f;
}

/**
 * Waiting generated per driver served, over the `span` frames ending at
 * `frame`. NaN when the window is not yet full, when the columns are missing,
 * or when nobody finished their trip inside the window.
 */
export function rollingWaitAt(
  metrics: ArrayLike<number>,
  stride: number,
  delayCol: number,
  throughputCol: number,
  frame: number,
  span: number,
): number {
  if (stride <= 0 || delayCol < 0 || throughputCol < 0) return NaN;
  const numFrames = Math.floor(metrics.length / stride);
  if (numFrames === 0) return NaN;
  const end = clampFrame(frame, numFrames);
  if (end < 0) return NaN;
  const width = Math.max(1, Math.floor(span));
  const start = end - width;
  // A partial window is not "the last minute", so it does not get to pretend.
  if (start < 0) return NaN;
  const delay = metrics[end * stride + delayCol] - metrics[start * stride + delayCol];
  const served = metrics[end * stride + throughputCol] - metrics[start * stride + throughputCol];
  if (!Number.isFinite(delay) || !Number.isFinite(served)) return NaN;
  // Nobody finished inside the window: there is no per-driver figure to give.
  if (served <= 0) return NaN;
  return delay / served;
}

/**
 * The same statistic over the whole clip so far: all the waiting the network
 * has generated up to `frame`, divided by every driver who has got through it
 * by then. This is what the two scoreboards print.
 *
 * Identical in definition to `rollingWaitAt` — same numerator series, same
 * denominator series, same "drivers who got through" meaning — and different
 * only in span, so the two readings on the page can be compared without a
 * reader having to hold two definitions in their head.
 *
 * NaN until somebody has finished, rather than a number divided by nobody.
 */
export function waitPerFinisherAt(
  metrics: ArrayLike<number>,
  stride: number,
  delayCol: number,
  throughputCol: number,
  frame: number,
): number {
  if (stride <= 0 || delayCol < 0 || throughputCol < 0) return NaN;
  const numFrames = Math.floor(metrics.length / stride);
  if (numFrames === 0) return NaN;
  const f = clampFrame(frame, numFrames);
  if (f < 0) return NaN;
  const delay = metrics[f * stride + delayCol];
  const finished = metrics[f * stride + throughputCol];
  if (!Number.isFinite(delay) || !Number.isFinite(finished) || finished <= 0) return NaN;
  return delay / finished;
}

/**
 * Drivers who finished their trip inside the same window. Shown beside the wait
 * because the pair is the whole point: a light can always cut waiting by
 * letting fewer people through, and this says whether that is what happened.
 */
export function carsClearedAt(
  metrics: ArrayLike<number>,
  stride: number,
  throughputCol: number,
  frame: number,
  span: number,
): number {
  if (stride <= 0 || throughputCol < 0) return NaN;
  const numFrames = Math.floor(metrics.length / stride);
  if (numFrames === 0) return NaN;
  const end = clampFrame(frame, numFrames);
  if (end < 0) return NaN;
  const start = end - Math.max(1, Math.floor(span));
  if (start < 0) return NaN;
  const served = metrics[end * stride + throughputCol] - metrics[start * stride + throughputCol];
  return Number.isFinite(served) ? served : NaN;
}

/**
 * The whole rolling series, one value per frame, NaN where undefined. Computed
 * once when the recording lands so the chart and the readout are literally the
 * same numbers rather than two implementations that agree by inspection.
 */
export function rollingWaitSeries(
  metrics: ArrayLike<number>,
  stride: number,
  delayCol: number,
  throughputCol: number,
  span: number,
): Float64Array {
  const numFrames = stride > 0 ? Math.floor(metrics.length / stride) : 0;
  const out = new Float64Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    out[f] = rollingWaitAt(metrics, stride, delayCol, throughputCol, f, span);
  }
  return out;
}

/** Which light is running the junction at `seconds` into the clip. */
export type Regime = "before" | "after";

export function regimeAt(seconds: number, switchAt: number): Regime {
  return Number.isFinite(seconds) && seconds >= switchAt ? "after" : "before";
}

/**
 * The stretch of clip whose trailing windows lie ENTIRELY inside one regime.
 *
 * A window ending a few seconds after the handover still has most of the fixed
 * timer's traffic in it, so it belongs to neither light. Excluding those is what
 * makes "before" and "after" a fair comparison instead of a smear across the
 * moment the page is trying to show.
 */
export function regimeSpan(
  regime: Regime,
  switchAt: number,
  windowSeconds: number,
  duration: number,
): { from: number; to: number } {
  return regime === "before"
    ? { from: windowSeconds, to: Math.min(switchAt, duration) }
    : { from: Math.min(switchAt + windowSeconds, duration), to: duration };
}

/**
 * Mean of the finite values of `series` over the clip seconds `[from, to]`
 * inclusive. NaN when the range holds nothing usable.
 */
export function meanOverSeconds(
  series: ArrayLike<number>,
  dt: number,
  from: number,
  to: number,
): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0.5;
  const last = series.length - 1;
  if (last < 0 || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return NaN;
  const a = Math.max(0, Math.ceil(from / step));
  const b = Math.min(last, Math.floor(to / step));
  let sum = 0;
  let seen = 0;
  for (let f = a; f <= b; f++) {
    const v = series[f];
    if (Number.isFinite(v)) {
      sum += v;
      seen++;
    }
  }
  return seen === 0 ? NaN : sum / seen;
}

/** Smallest and largest finite value in a series, or NaN/NaN when there is none. */
export function finiteRange(series: ArrayLike<number>): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? { lo, hi } : { lo: NaN, hi: NaN };
}

export interface WaitAxis {
  /** Bottom of the drawn range, seconds. */
  lo: number;
  /** Top of the drawn range, seconds. */
  hi: number;
  /** Gridline positions inside the range, seconds. */
  ticks: number[];
}

/**
 * A fixed vertical scale for the chart, snapped out to round values.
 *
 * Fixed, not auto-fitting as the clip plays: a chart whose axis rescales while
 * it draws can make a falling line look flat, and the fall is the point. The
 * whole series is in memory the moment the file lands, so the range is known
 * before the first pixel.
 */
export function waitAxis(series: ArrayLike<number>, step = 30, tickStep = 60): WaitAxis {
  const { lo, hi } = finiteRange(series);
  if (!Number.isFinite(lo)) return { lo: 0, hi: step, ticks: [] };
  const bottom = Math.floor(lo / step) * step;
  const top = Math.max(Math.ceil(hi / step) * step, bottom + step);
  const ticks: number[] = [];
  for (let v = Math.ceil(bottom / tickStep) * tickStep; v <= top; v += tickStep) {
    if (v > bottom) ticks.push(v);
  }
  return { lo: bottom, hi: top, ticks };
}

/**
 * Percent by which `after` is below `before`. Positive means the waiting fell.
 * NaN when there is no usable baseline.
 */
export function fallPercent(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return NaN;
  return (1 - after / before) * 100;
}
