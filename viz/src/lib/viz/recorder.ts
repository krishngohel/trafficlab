/**
 * MediaRecorder wrapper for capturing the WebGL canvas to a .webm file.
 * VP9 preferred, VP8 fallback, then whatever plain video/webm gives us.
 */

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

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
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private discard = false;

  get active(): boolean {
    return this.recorder !== null;
  }

  /**
   * Start capturing `canvas` at up to 60 fps. `onDone` fires with the final
   * blob (or null when cancelled or empty). Returns false if the browser
   * cannot record webm.
   */
  start(canvas: HTMLCanvasElement, onDone: (blob: Blob | null) => void): boolean {
    if (this.recorder) return false;
    const mime = pickWebmMime();
    if (!mime || typeof canvas.captureStream !== "function") return false;

    const stream = canvas.captureStream(60);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 12_000_000,
      });
    } catch {
      return false;
    }
    this.chunks = [];
    this.discard = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob =
        !this.discard && this.chunks.length > 0 ? new Blob(this.chunks, { type: mime }) : null;
      this.chunks = [];
      this.recorder = null;
      for (const track of stream.getTracks()) track.stop();
      onDone(blob);
    };
    recorder.start(500); // gather chunks every 500 ms
    this.recorder = recorder;
    return true;
  }

  /** Stop and emit the blob (unless `cancel`), via the onDone callback. */
  stop(cancel = false): void {
    if (!this.recorder) return;
    this.discard = cancel;
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }
}
