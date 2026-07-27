/**
 * Time-based playback clock, shared by every loaded replay (so split-screen
 * comparison files with different lengths — or even different dt — stay on
 * one clock). Pure logic, no three.js, no DOM.
 *
 * `time` is sim seconds; 1x playback = real time. Frame lookup for a specific
 * file is `time / dt`, clamped to that file's last frame.
 */
export class PlaybackClock {
  /** Current sim time in seconds. */
  time = 0;
  playing = true;
  speed = 1;
  /** Loop back to 0 at the end (disabled while recording). */
  loop = true;
  /** Total duration in seconds = max over loaded files of (numFrames-1)*dt. */
  duration = 0;

  /** Advance by dtReal wall-clock seconds. Returns the new time. */
  advance(dtReal: number): number {
    if (!this.playing || this.duration <= 0) return this.time;
    this.time += dtReal * this.speed;
    if (this.time >= this.duration) {
      if (this.loop) {
        this.time %= this.duration;
      } else {
        this.time = this.duration;
        this.playing = false;
      }
    }
    if (this.time < 0) this.time = 0;
    return this.time;
  }

  /** Clamp-seek to t seconds. */
  seek(t: number): void {
    this.time = Math.min(Math.max(t, 0), this.duration);
  }

  /**
   * Pause and move exactly `delta` frames (of a file with tick length `dt`),
   * quantizing to frame boundaries so repeated steps land on integers.
   */
  stepFrames(dt: number, delta: number): void {
    if (dt <= 0) return;
    this.playing = false;
    const frame = Math.round(this.time / dt) + delta;
    this.seek(frame * dt);
  }

  /** Fractional frame position for a file with tick length dt and n frames. */
  frameAt(dt: number, numFrames: number): number {
    if (dt <= 0 || numFrames <= 0) return 0;
    return Math.min(Math.max(this.time / dt, 0), numFrames - 1);
  }
}
