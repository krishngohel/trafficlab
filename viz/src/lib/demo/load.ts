/**
 * Fixture fetching with honest progress for the demo page.
 *
 * The two clips are ~3.5 MB each and the 3D art bundle is another few MB, so a
 * visitor on a slow line stares at the page for several seconds. Rather than a
 * blank canvas they get a real byte counter: `fetchWithProgress` streams the
 * response and reports every chunk.
 */

/** Percentage complete, clamped to 0..100. Returns 0 with no size to divide by. */
export function loadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (loaded / total) * 100));
}

/** "3.5 MB" / "812 KB" — a size a person can read. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Fetch a binary file, calling `onChunk` with the bytes received so far and the
 * declared total (0 when the server sends no Content-Length). Falls back to a
 * plain buffered read where response streaming is unavailable.
 */
export async function fetchWithProgress(
  url: string,
  onChunk: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);

  if (!res.body) {
    const buffer = await res.arrayBuffer();
    onChunk(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onChunk(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}
