/**
 * Color ramps for overlays. Pure math (no three.js) so they can be unit
 * tested; callers feed the {r,g,b} result into THREE.Color scratch objects.
 * All channels are 0..1.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type RampStop = [number, number, number];

/** Piecewise-linear interpolation over evenly spaced stops; u clamped to [0,1]. */
export function evalRamp(stops: readonly RampStop[], u: number, out: RGB): RGB {
  const n = stops.length;
  if (n === 0) {
    out.r = out.g = out.b = 0;
    return out;
  }
  const c = u <= 0 ? 0 : u >= 1 ? 1 : u;
  const scaled = c * (n - 1);
  const i = Math.min(Math.max(n - 2, 0), Math.floor(scaled));
  const t = scaled - i;
  const a = stops[i];
  const b = stops[Math.min(i + 1, n - 1)];
  out.r = a[0] + (b[0] - a[0]) * t;
  out.g = a[1] + (b[1] - a[1]) * t;
  out.b = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Vehicle speed ramp over u = speed / speed_limit. Congestion semantics:
 * stopped = red, half the limit = white, at/above the limit = blue.
 */
const SPEED_STOPS: readonly RampStop[] = [
  [0.92, 0.26, 0.21], // red — stopped
  [0.98, 0.62, 0.35], // orange
  [0.96, 0.96, 0.96], // white — cruising at half limit
  [0.55, 0.76, 0.98], // light blue
  [0.23, 0.49, 0.95], // blue — at the limit
];

export function speedColor(u: number, out: RGB): RGB {
  return evalRamp(SPEED_STOPS, u, out);
}

/** Queue heat: 0 = green, 0.5 = yellow, 1 = red. */
const QUEUE_STOPS: readonly RampStop[] = [
  [0.16, 0.72, 0.4], // green
  [0.95, 0.77, 0.25], // yellow
  [0.93, 0.26, 0.2], // red
];

export function queueColor(u: number, out: RGB): RGB {
  return evalRamp(QUEUE_STOPS, u, out);
}

/**
 * Diverging pressure ramp over u in [-1, 1], symmetric around 0:
 * -1 = red (very negative reward / high pressure), 0 = dim neutral,
 * +1 = blue (positive reward). u is clamped.
 */
export function pressureColor(u: number, out: RGB): RGB {
  const c = u < -1 ? -1 : u > 1 ? 1 : u;
  // Neutral midpoint kept dark so the discs read as translucent tints.
  const neutral: RampStop = [0.42, 0.44, 0.5];
  const red: RampStop = [0.93, 0.2, 0.16];
  const blue: RampStop = [0.2, 0.52, 0.96];
  const target = c < 0 ? red : blue;
  const t = Math.abs(c);
  out.r = neutral[0] + (target[0] - neutral[0]) * t;
  out.g = neutral[1] + (target[1] - neutral[1]) * t;
  out.b = neutral[2] + (target[2] - neutral[2]) * t;
  return out;
}

/** Stable, well-spread hue per vehicle id (matches VehicleLayer's id colors). */
export function idHue(id: number): number {
  return (id * 0.61803398875) % 1;
}
