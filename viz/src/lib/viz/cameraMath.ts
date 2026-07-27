/**
 * Pure camera math helpers (no three.js) so they can be unit tested.
 */

export interface OrthoFrustum {
  halfW: number;
  halfH: number;
}

/**
 * Fit an orthographic frustum around a bounds box of size (w, h) world units
 * at the given viewport aspect ratio (width / height), with a relative
 * margin (1.1 = 10% padding). Both dimensions are guaranteed to fit.
 */
export function fitOrtho(w: number, h: number, aspect: number, margin = 1.12): OrthoFrustum {
  const safeW = Math.max(w, 1) * margin;
  const safeH = Math.max(h, 1) * margin;
  const safeAspect = Math.max(aspect, 1e-6);
  const halfH = Math.max(safeH / 2, safeW / 2 / safeAspect);
  return { halfW: halfH * safeAspect, halfH };
}

/**
 * Exponential smoothing factor for frame-rate-independent lerping:
 * `pos += (target - pos) * smoothAlpha(dt, rate)`. Higher rate = snappier.
 */
export function smoothAlpha(dt: number, rate: number): number {
  return 1 - Math.exp(-Math.max(dt, 0) * rate);
}

/**
 * Initial chase-camera offset for a vehicle heading (sim CCW-from-+X), in
 * scene space (x, y-up, z). Places the camera `back` meters behind the
 * vehicle and `up` meters above it. Sim (x, y) maps to scene (x, -z).
 */
export function followOffset(
  heading: number,
  back: number,
  up: number,
): { x: number; y: number; z: number } {
  return {
    x: -Math.cos(heading) * back,
    y: up,
    z: Math.sin(heading) * back,
  };
}
