/**
 * Frame-rate meter.
 *
 * The displayed rate is an EMA over real frame deltas — a raw 1/dt readout
 * flickers far too much to read while the scene is moving. The average alone
 * hides the thing that actually looks bad, though (one 60 ms hitch inside a
 * second of 60 fps still reads as a stutter), so the worst frame of each
 * completed second is tracked alongside it.
 */

/** Weight of the newest frame in the EMA. ~0.6 s to settle at 60 Hz. */
const EMA_ALPHA = 0.1;
const WINDOW_MS = 1000;
/** Deltas above this are a tab-switch or a breakpoint, not a slow frame. */
const OUTLIER_MS = 500;

export class FpsMeter {
  private emaMs = 0;
  private windowStart = 0;
  private windowWorstMs = 0;
  private lastWorstMs = 0;

  /**
   * Feed one frame. `dtSeconds` is the real (unscaled) delta, `now` a
   * `performance.now()` timestamp.
   */
  sample(dtSeconds: number, now: number): void {
    const ms = dtSeconds * 1000;
    if (!(ms > 0) || ms > OUTLIER_MS) return;
    this.emaMs = this.emaMs === 0 ? ms : this.emaMs + (ms - this.emaMs) * EMA_ALPHA;
    if (this.windowStart === 0) this.windowStart = now;
    if (ms > this.windowWorstMs) this.windowWorstMs = ms;
    if (now - this.windowStart >= WINDOW_MS) {
      this.lastWorstMs = this.windowWorstMs;
      this.windowWorstMs = 0;
      this.windowStart = now;
    }
  }

  /** Smoothed frames per second; 0 before the first sample. */
  get fps(): number {
    return this.emaMs > 0 ? 1000 / this.emaMs : 0;
  }

  /** Smoothed frame time in ms; 0 before the first sample. */
  get frameMs(): number {
    return this.emaMs;
  }

  /** Longest frame of the last completed second — the spikes the EMA hides. */
  get worstFrameMs(): number {
    return this.lastWorstMs;
  }

  reset(): void {
    this.emaMs = 0;
    this.windowStart = 0;
    this.windowWorstMs = 0;
    this.lastWorstMs = 0;
  }
}
