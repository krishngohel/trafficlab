/**
 * Plain-language formatting for the public demo page.
 *
 * The research HUD prints "107.4 s"; a visitor reads "1m 47s". Everything here
 * is pure (no DOM, no three.js) so the numbers on the showcase page are unit
 * tested exactly like the ones in the instrument.
 *
 * The underlying statistics are NOT reimplemented here — mean wait comes from
 * `meanWaitAt` and the side-vs-side gap from `relativeDelta`, both in
 * `src/lib/wait.ts`.
 */

import { relativeDelta } from "../wait";

/**
 * A duration a person can read out loud: "47s", "1m 47s", "12m 04s".
 * Seconds are zero-padded above a minute so the value does not jitter in width
 * while it counts up. Non-finite renders as an en dash.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? "−" : "";
  if (total < 60) return `${sign}${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${sign}${m}m ${String(s).padStart(2, "0")}s`;
}

/** Whole-number count with thousands separators; en dash when unknown. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return Math.round(value).toLocaleString("en-US");
}

/** Which side is currently waiting less. */
export type Leader = "responsive" | "fixed" | "even" | "unknown";

export interface WaitGap {
  /** Responsive relative to fixed, in percent. Negative = responsive waits less. */
  pct: number;
  /** Responsive minus fixed, in seconds. Negative = responsive waits less. */
  seconds: number;
  leader: Leader;
}

/** Below this the two sides are called level rather than ahead/behind. */
const EVEN_PCT = 0.5;

/**
 * Compare the two sides' mean wait. `fixed` is the baseline, so a negative
 * result means the responsive signal is ahead — the same sign convention the
 * research HUD uses for "B vs A".
 */
export function waitGap(fixed: number, responsive: number): WaitGap {
  const pct = relativeDelta(fixed, responsive);
  const seconds = Number.isFinite(fixed) && Number.isFinite(responsive) ? responsive - fixed : NaN;
  let leader: Leader;
  if (!Number.isFinite(pct)) leader = "unknown";
  else if (Math.abs(pct) < EVEN_PCT) leader = "even";
  else if (pct < 0) leader = "responsive";
  else leader = "fixed";
  return { pct, seconds, leader };
}

/** Magnitude of a percentage as a whole number: "12%". En dash when unknown. */
export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return "–";
  return `${Math.round(Math.abs(pct))}%`;
}

/**
 * One line of everyday English describing the gap, e.g.
 * "Responsive signal is 12% ahead" — the sentence under the big number.
 */
export function describeGap(gap: WaitGap): string {
  switch (gap.leader) {
    case "unknown":
      return "Waiting for the first cars";
    case "even":
      return "Neck and neck so far";
    case "responsive":
      return `Responsive signal ahead by ${formatClock(Math.abs(gap.seconds))} a driver`;
    case "fixed":
      return `Fixed timer ahead by ${formatClock(Math.abs(gap.seconds))} a driver`;
  }
}

/** "3:20 of 10:00" — where the clip has got to, in minutes and seconds. */
export function formatElapsed(seconds: number, duration: number): string {
  const stamp = (v: number) => {
    const total = Math.max(0, Math.round(v));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return "–";
  return `${stamp(Math.min(seconds, duration))} of ${stamp(duration)}`;
}
