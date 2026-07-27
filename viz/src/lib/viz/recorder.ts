/**
 * MediaRecorder wrapper for capturing the WebGL canvas to a .webm file.
 * VP9 preferred, VP8 fallback, then whatever plain video/webm gives us.
 *
 * Frames are pushed *manually*: `canvas.captureStream(0)` disables the
 * browser's implicit "capture whenever the compositor happens to paint"
 * behaviour, which is unreliable for a WebGL canvas driven by our own
 * requestAnimationFrame loop (it can silently deliver zero frames for the
 * whole recording, yielding an empty file). Instead the render loop calls
 * `captureFrame()` immediately after each draw, so one rendered frame is
 * exactly one recorded frame. Browsers without `requestFrame` fall back to
 * timed auto-capture.
 *
 * Capture rate is deliberately *decoupled* from the render rate. Every captured
 * frame costs a full-canvas GPU→CPU readback plus a VP9 encode at the canvas's
 * native resolution, so pushing one per animation frame (~60/s) saturates the
 * browser's capture pipeline on a dense scene. When that happens the encoder
 * does not merely drop frames — it produces *nothing at all*, MediaRecorder
 * hands back zero chunks, and the export silently yields no file. Capping the
 * rate keeps the pipeline inside its budget; 30 fps is plenty for a replay.
 */

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

/** Frames per second handed to the encoder, manual or auto-captured. */
export const CAPTURE_FPS = 30;

/** Rate floor when backing off from a starved encoder. */
const MIN_CAPTURE_FPS = 10;

/**
 * If the encoder has emitted no bytes after this long, assume it is drowning
 * and halve the capture rate. Well clear of normal VP9 start-up latency, which
 * measures ~3.5 s to the first chunk.
 */
const STARVE_MS = 6000;

/** Slack absorbing requestAnimationFrame jitter around the target period. */
const JITTER_MS = 4;

type FrameTrack = MediaStreamTrack & { requestFrame?: () => void };

/**
 * Wall-clock gate admitting at most `fps` events per second. Pure logic — the
 * caller supplies the timestamp, so it is deterministic under test.
 */
export class FrameGate {
  private last = Number.NEGATIVE_INFINITY;
  private fps: number;

  constructor(fps: number) {
    this.fps = Math.max(fps, 1);
  }

  get rate(): number {
    return this.fps;
  }

  /** Change the admitted rate, effective from the next `allow` call. */
  setRate(fps: number): void {
    this.fps = Math.max(fps, 1);
  }

  allow(nowMs: number): boolean {
    if (nowMs - this.last < 1000 / this.fps - JITTER_MS) return false;
    this.last = nowMs;
    return true;
  }
}

export function pickWebmMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

export function sanitizeFilePart(s: string): string {
  const cleaned = s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "replay";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // Some browsers ignore clicks on anchors that are not in the document.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}

/**
 * Open a capture stream on `canvas` in manual-frame mode when the browser
 * supports it, else in timed auto-capture mode. Returns the stream plus the
 * track to call `requestFrame()` on (null when auto-capturing).
 */
function openCaptureStream(
  canvas: HTMLCanvasElement,
): { stream: MediaStream; frameTrack: FrameTrack | null } | null {
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(0);
  } catch {
    return null;
  }
  const track = stream.getVideoTracks()[0] as FrameTrack | undefined;
  if (track && typeof track.requestFrame === "function") {
    return { stream, frameTrack: track };
  }
  // No manual control available — fall back to the browser's own capture timer,
  // held to the same rate so the encoder gets the same workload either way.
  for (const t of stream.getTracks()) t.stop();
  try {
    return { stream: canvas.captureStream(CAPTURE_FPS), frameTrack: null };
  } catch {
    return null;
  }
}

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private discard = false;
  private frameTrack: FrameTrack | null = null;
  private gate = new FrameGate(CAPTURE_FPS);
  /** Bytes the encoder has handed back so far — the only progress signal we get. */
  private bytesSeen = 0;
  /** Timestamp the current starvation window started at. */
  private starveSince = 0;

  get active(): boolean {
    return this.recorder !== null;
  }

  /** Current capture rate in fps (drops if the encoder falls behind). */
  get captureFps(): number {
    return this.gate.rate;
  }

  /**
   * Start capturing `canvas`. `onDone` fires with the final blob (or null when
   * cancelled or when no frames were captured). Returns false if the browser
   * cannot record webm. `now` is the wall clock the capture gate runs on and
   * must share an origin with the timestamps passed to `captureFrame`.
   */
  start(
    canvas: HTMLCanvasElement,
    onDone: (blob: Blob | null) => void,
    now: number = performance.now(),
  ): boolean {
    if (this.recorder) return false;
    const mime = pickWebmMime();
    if (!mime || typeof canvas.captureStream !== "function") return false;

    const opened = openCaptureStream(canvas);
    if (!opened) return false;
    const { stream, frameTrack } = opened;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 12_000_000,
      });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.chunks = [];
    this.discard = false;
    this.frameTrack = frameTrack;
    this.gate = new FrameGate(CAPTURE_FPS);
    this.bytesSeen = 0;
    this.starveSince = now;
    recorder.ondataavailable = (e) => {
      this.bytesSeen += e.data.size;
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob =
        !this.discard && this.chunks.length > 0 ? new Blob(this.chunks, { type: mime }) : null;
      this.chunks = [];
      this.recorder = null;
      this.frameTrack = null;
      for (const track of stream.getTracks()) track.stop();
      onDone(blob);
    };
    recorder.start(500); // gather chunks every 500 ms
    this.recorder = recorder;
    // Seed the stream with the currently displayed frame so the encoder has
    // something to work with even if the recording is stopped immediately.
    this.captureFrame(now);
    return true;
  }

  /**
   * Push the canvas's current contents into the recording. Must be called from
   * the render loop right after drawing, while the drawing buffer is still
   * intact — `now` is that frame's timestamp. Rate-limited to `CAPTURE_FPS`;
   * calls in between are dropped rather than queued. No-op when not recording
   * or when auto-capture is in use.
   */
  captureFrame(now: number = performance.now()): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    const track = this.frameTrack;
    if (!track) return; // auto-capture paces itself
    // No bytes back after a long while means the encoder is drowning in
    // readbacks and will otherwise deliver an empty recording. Shed load.
    if (this.bytesSeen === 0 && now - this.starveSince >= STARVE_MS) {
      this.starveSince = now;
      if (this.gate.rate > MIN_CAPTURE_FPS) {
        this.gate.setRate(Math.max(MIN_CAPTURE_FPS, this.gate.rate / 2));
      }
    }
    if (!this.gate.allow(now)) return;
    track.requestFrame?.();
  }

  /** Stop and emit the blob (unless `cancel`), via the onDone callback. */
  stop(cancel = false): void {
    if (!this.recorder) return;
    this.discard = cancel;
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }
}
