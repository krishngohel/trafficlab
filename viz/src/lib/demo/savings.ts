/**
 * The two live readings that move in the direction this project exists to move.
 *
 * The page used to lead with a running average of wait per driver. That is an
 * honest statistic but a dishonest *shape* for a headline: a running average
 * over a warmed-up junction starts near zero and climbs asymptotically towards
 * its settled value, so on a page whose whole claim is "this reduces waiting",
 * the biggest number on screen only ever went up — on both sides — and a
 * visitor had to subtract two rising numbers to find the point.
 *
 * What the recordings actually support instead:
 *
 *  - TIME SAVED. `cumulative_delay` is the total delay every driver in a run
 *    has accumulated. The two runs are the same network, the same demand and
 *    the same seed, so at any instant the difference between the two series is
 *    exactly the waiting one light spared its drivers that the other did not.
 *    It climbs — but climbing is unambiguously the good direction here, it is a
 *    benefit accumulating rather than a problem worsening, and it is the
 *    quantity the project is for.
 *  - SPEED. `mean_speed` is instantaneous and genuinely moves both ways, so a
 *    percentage read off it rises and falls while the clip plays. Averaged over
 *    a trailing window so it reads as traffic rather than as noise.
 *
 * Deliberately NOT used as a headline: the number of cars queued. On the
 * shipped junction clip the responsive side holds MORE cars queued on average
 * (84.7 against 81.4) precisely because it is putting more traffic through and
 * its queues turn over faster, so a "cars waiting right now" hero would hand
 * the win to the fixed timer — the opposite of what the data says.
 *
 * Pure functions only (no DOM, no three.js), so every number the showcase page
 * prints is unit tested.
 */

import { formatPercent, type Leader } from "./format";

/** Trailing sim seconds the live speed comparison averages over. */
export const SPEED_WINDOW_SECONDS = 60;

/**
 * Sim seconds of clip that must exist before a speed percentage is shown.
 *
 * The opening frame of each recording is a snapshot of a network that has just
 * been handed over from the warm-up, and on the junction pair it happens to
 * catch the responsive side mid-platoon at 2.5 m/s against the fixed side's
 * 1.2. Averaged over a window that is only a frame or two wide that reads as
 * "99% faster", which is true of those two frames and true of nothing else —
 * the figure settles into the twenties within a quarter of a minute. Fifteen
 * seconds of clip is enough to make the reading representative (it caps the
 * junction's whole-clip range at 75% instead of 115%) and costs under two
 * seconds of watching at the demo's default 8x.
 */
export const SPEED_WARMUP_SECONDS = 15;

/** True once enough of the clip has played for the speed reading to mean something. */
export function hasSpeedWindow(frame: number, dt: number): boolean {
  return Number.isFinite(frame) && frame >= windowFrames(dt, SPEED_WARMUP_SECONDS);
}

/** Under this many driver-seconds of difference the two runs are called level. */
const EVEN_SAVED_SECONDS = 1;

/** Under this percent the two sides are called level on speed. */
const EVEN_FASTER_PCT = 0.5;

/** Column index of `mean_speed` in a file's metric stride, or -1 if absent. */
export function speedColumn(metricNames: readonly string[]): number {
  return metricNames.indexOf("mean_speed");
}

/** How many recorded frames `seconds` of sim time spans, at least one. */
export function windowFrames(dt: number, seconds: number = SPEED_WINDOW_SECONDS): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0.5;
  return Math.max(1, Math.round(seconds / step));
}

/**
 * Waiting spared, in driver-seconds: the fixed timer's accumulated delay minus
 * the responsive signal's, at the same instant of the same traffic. Positive
 * means the responsive signal is the one that has saved time — the sign
 * convention every caller here relies on.
 */
export function savedSeconds(fixedDelay: number, responsiveDelay: number): number {
  if (!Number.isFinite(fixedDelay) || !Number.isFinite(responsiveDelay)) return NaN;
  return fixedDelay - responsiveDelay;
}

/**
 * A quantity of collective waiting a person can picture: "48s", "12m 44s",
 * "2h 09m". Minutes and seconds are zero padded so the counter does not jitter
 * in width as it ticks. Non-finite renders as an en dash.
 */
export function formatSaved(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const sign = seconds < 0 ? "−" : "";
  const total = Math.round(Math.abs(seconds));
  if (total < 60) return `${sign}${total}s`;
  if (total < 3600) {
    return `${sign}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }
  // Round to the minute before splitting, so 3h 59m 59s never prints "3h 60m".
  const minutes = Math.round(total / 60);
  return `${sign}${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The headline reading: how much waiting has been saved, and by which light. */
export interface SavedReadout {
  /** Which light has spared its drivers time so far. */
  leader: Leader;
  /** The magnitude, ready to print big: "2h 09m". */
  value: string;
  /** The sentence under it, which continues the number grammatically. */
  line: string;
}

/**
 * Turn the live gap between the two delay series into the hero.
 *
 * Symmetric on purpose: if the fixed timer were the one saving time the page
 * would say so in the same words, because this is read off the simulation
 * rather than asserted. On both shipped clips the responsive signal leads at
 * every frame, and a test pins that.
 */
export function savedReadout(saved: number): SavedReadout {
  if (!Number.isFinite(saved)) {
    return {
      leader: "unknown",
      value: "–",
      line: "The count starts the moment traffic reaches both junctions.",
    };
  }
  if (Math.abs(saved) < EVEN_SAVED_SECONDS) {
    return {
      leader: "even",
      value: formatSaved(0),
      line: "Neither light has spared its drivers any time yet.",
    };
  }
  const responsive = saved > 0;
  const who = responsive ? "the responsive signal on the right" : "the fixed timer on the left";
  return {
    leader: responsive ? "responsive" : "fixed",
    value: formatSaved(Math.abs(saved)),
    line: `of standing still that ${who} has spared its drivers so far — and counting.`,
  };
}

/** The supporting reading: how much faster traffic is moving, right now. */
export interface FasterReadout {
  leader: Leader;
  /** "31%", "Level", or an en dash. */
  value: string;
  /** The caption under it. */
  line: string;
}

/**
 * How much quicker traffic is flowing on the responsive side, in percent.
 * Positive means the responsive signal is the faster one. NaN when there is no
 * usable baseline.
 */
export function percentFaster(fixedSpeed: number, responsiveSpeed: number): number {
  if (!Number.isFinite(fixedSpeed) || !Number.isFinite(responsiveSpeed)) return NaN;
  if (fixedSpeed <= 0) return NaN;
  return (responsiveSpeed / fixedSpeed - 1) * 100;
}

/** The words for that percentage — again symmetric, again read off the file. */
export function fasterReadout(pct: number): FasterReadout {
  if (!Number.isFinite(pct)) {
    return {
      leader: "unknown",
      value: "–",
      line: "Measuring how fast the traffic is moving on each side.",
    };
  }
  if (Math.abs(pct) < EVEN_FASTER_PCT) {
    return {
      leader: "even",
      value: "Level",
      line: `Traffic is moving at about the same speed on both sides, over the last ${SPEED_WINDOW_SECONDS} seconds.`,
    };
  }
  const responsive = pct > 0;
  return {
    leader: responsive ? "responsive" : "fixed",
    value: formatPercent(pct),
    line: `faster traffic on the ${responsive ? "right" : "left"} right now, averaged over the last ${SPEED_WINDOW_SECONDS} seconds.`,
  };
}

/**
 * Mean of one metric column over the `span` frames ending at `frame`.
 *
 * Instantaneous `mean_speed` swings hard from second to second (a green ending
 * drops it, a platoon released lifts it), so the page reads it over a window:
 * a number that flickers between "18% faster" and "70% faster" five times a
 * second is not information a visitor can use. Frames before the start of the
 * file are simply not in the window, so the early clip averages what exists.
 */
export function trailingMean(
  metrics: ArrayLike<number>,
  stride: number,
  col: number,
  frame: number,
  span: number,
): number {
  if (stride <= 0 || col < 0) return NaN;
  const numFrames = Math.floor(metrics.length / stride);
  if (numFrames === 0) return NaN;
  const end = Math.min(Math.max(Math.floor(frame), 0), numFrames - 1);
  const width = Math.max(1, Math.floor(span));
  const start = Math.max(0, end - width + 1);
  let sum = 0;
  let seen = 0;
  for (let i = start; i <= end; i++) {
    const v = metrics[i * stride + col];
    if (Number.isFinite(v)) {
      sum += v;
      seen++;
    }
  }
  return seen === 0 ? NaN : sum / seen;
}
