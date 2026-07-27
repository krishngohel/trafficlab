/**
 * Parser for the trafficlab `.traj` binary trajectory format, v1.
 *
 * Source of truth: docs/TRAJECTORY_FORMAT.md (repo root). Any change to the
 * format requires a version bump there and matching updates here and in
 * src/trafficlab/trajectory.py.
 *
 * Layout:
 *   [ header (12 B) ][ meta JSON ][ frame 0 ] ... [ frame N-1 ][ index (8N B) ][ trailer (16 B) ]
 *
 * Everything is little-endian and packed (no alignment padding). Frames are
 * decoded lazily on demand and kept in a small LRU cache; vehicle blocks sit
 * at unaligned offsets, so each frame's block is copied into a fresh aligned
 * buffer before being split into per-field typed arrays.
 */

const HEADER_MAGIC = "TLTJ";
const TRAILER_MAGIC = "TLIX";
const FORMAT_VERSION = 1;

const HEADER_SIZE = 12;
const TRAILER_SIZE = 16;
const VEHICLE_RECORD_SIZE = 28;
const SIGNAL_RECORD_SIZE = 6;

const DEFAULT_CACHE_SIZE = 120;

// ---------------------------------------------------------------------------
// Meta JSON types
// ---------------------------------------------------------------------------

export interface TrajNode {
  id: number;
  x: number;
  y: number;
  type: "intersection" | "boundary";
}

export interface TrajLink {
  id: number;
  from_node: number;
  to_node: number;
  lanes: number[];
}

export interface TrajLane {
  id: number;
  link: number;
  index: number;
  width: number;
  speed_limit: number;
  polyline: [number, number][];
}

export interface TrajConnection {
  id: number;
  from_lane: number;
  to_lane: number;
  movement: "through" | "left" | "right";
  intersection: number;
}

export interface TrajPhase {
  name: string;
  connections: number[];
}

export interface TrajIntersection {
  id: number;
  node: number;
  yellow: number;
  all_red: number;
  min_green: number;
  phases: TrajPhase[];
}

export interface TrajNetwork {
  nodes: TrajNode[];
  links: TrajLink[];
  lanes: TrajLane[];
  connections: TrajConnection[];
  intersections: TrajIntersection[];
}

export interface TrajApproach {
  intersection: number;
  link: number;
  label: string;
}

export interface TrajMeta {
  format_version: number;
  dt: number;
  seed: number | null;
  policy: string;
  network_name: string;
  network: TrajNetwork;
  /** Defines K and the order of per-intersection frame data (signals, rewards). */
  intersections_order: number[];
  /** Defines A and the order of the per-frame queue array. */
  approaches: TrajApproach[];
  /** Defines M and the order of the per-frame global metrics array. */
  metrics: string[];
  /** Unknown extra keys are allowed and preserved. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

export interface SignalState {
  /** Index into that intersection's `phases` list (outgoing phase during yellow/all-red). */
  phase: number;
  /** 0 = green, 1 = yellow, 2 = all-red. */
  state: number;
  /** Seconds since the current phase (incl. transition) began. */
  timeInPhase: number;
}

export interface TrajFrame {
  /** 0-based tick; strictly +1 per frame. */
  tick: number;
  /** Number of vehicles in this frame. */
  count: number;
  id: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  accel: Float32Array;
  /** Lane id per vehicle; 0xFFFF = inside intersection (on a connection). */
  lane: Uint16Array;
  /** bit0 braking, bit1 left blinker, bit2 right blinker, bit3 queued. */
  flags: Uint8Array;
  /** One entry per intersection, ordered per meta.intersections_order. */
  signals: SignalState[];
  /** Vehicles queued per approach, ordered per meta.approaches. */
  queues: Uint16Array;
  /** Per-intersection instantaneous reward, ordered per meta.intersections_order. */
  rewards: Float32Array;
  /** Global metrics, ordered per meta.metrics. */
  metrics: Float32Array;
}

/**
 * Per-frame series of everything EXCEPT vehicles, produced by a single fast
 * pass over the file (`scanMeta`). All arrays are frame-major:
 * `signalState[i * K + k]`, `queues[i * A + a]`, `metrics[i * M + m]`.
 */
export interface TrajScan {
  numFrames: number;
  /** meta.intersections_order.length */
  k: number;
  /** meta.approaches.length */
  a: number;
  /** meta.metrics.length */
  m: number;
  /** Seconds of sim time per tick (copied from meta for convenience). */
  dt: number;
  ticks: Uint32Array;
  /** N*K — phase index per intersection per frame. */
  signalPhase: Uint8Array;
  /** N*K — 0 green, 1 yellow, 2 all-red. */
  signalState: Uint8Array;
  /** N*K — seconds in the current phase. */
  timeInPhase: Float32Array;
  /** N*A — vehicles queued per approach. */
  queues: Uint16Array;
  /** N*K — per-intersection instantaneous reward. */
  rewards: Float32Array;
  /** N*M — global metrics per frame. */
  metrics: Float32Array;
}

export interface TrajFile {
  meta: TrajMeta;
  numFrames: number;
  /** Decode frame i (lazily, LRU-cached). Throws on out-of-range i. */
  frame(i: number): TrajFrame;
  /**
   * Decode tick + signals + queues + rewards + metrics of EVERY frame in one
   * pass, seeking over the vehicle blocks. Cached after the first call.
   * Fast: a few thousand frames scan in single-digit milliseconds.
   */
  scanMeta(): TrajScan;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class TrajParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrajParseError";
  }
}

function readMagic(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

const REQUIRED_META_KEYS = [
  "format_version",
  "dt",
  "network",
  "intersections_order",
  "approaches",
  "metrics",
] as const;

class TrajFileImpl implements TrajFile {
  readonly meta: TrajMeta;
  readonly numFrames: number;

  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  /** Absolute file offset of each frame's frame_len field. */
  private readonly index: Float64Array;
  private readonly indexOffset: number;
  private readonly k: number;
  private readonly a: number;
  private readonly m: number;

  private readonly cache = new Map<number, TrajFrame>();
  private readonly cacheSize: number;
  private scan: TrajScan | null = null;

  constructor(buffer: ArrayBuffer, cacheSize: number) {
    this.cacheSize = Math.max(1, cacheSize);
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    const size = buffer.byteLength;

    if (size < HEADER_SIZE + TRAILER_SIZE) {
      throw new TrajParseError(
        `traj: file too small (${size} B); need at least ${HEADER_SIZE + TRAILER_SIZE} B for header + trailer`,
      );
    }

    // --- Header ---
    const magic = readMagic(this.bytes, 0);
    if (magic !== HEADER_MAGIC) {
      throw new TrajParseError(
        `traj: bad header magic ${JSON.stringify(magic)}; expected "${HEADER_MAGIC}" — not a .traj file?`,
      );
    }
    const version = this.view.getUint16(4, true);
    if (version !== FORMAT_VERSION) {
      throw new TrajParseError(
        `traj: unsupported format version ${version}; this parser implements v${FORMAT_VERSION}`,
      );
    }
    const metaLen = this.view.getUint32(8, true);
    if (HEADER_SIZE + metaLen > size - TRAILER_SIZE) {
      throw new TrajParseError(
        `traj: meta_len ${metaLen} overruns file (size ${size} B)`,
      );
    }

    // --- Meta JSON ---
    const metaBytes = this.bytes.subarray(HEADER_SIZE, HEADER_SIZE + metaLen);
    let meta: unknown;
    try {
      meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaBytes));
    } catch (err) {
      throw new TrajParseError(
        `traj: meta block is not valid UTF-8 JSON: ${(err as Error).message}`,
      );
    }
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new TrajParseError("traj: meta JSON must be an object");
    }
    const missing = REQUIRED_META_KEYS.filter((k) => !(k in (meta as object)));
    if (missing.length > 0) {
      throw new TrajParseError(
        `traj: meta JSON missing required key(s): ${missing.join(", ")}`,
      );
    }
    this.meta = meta as TrajMeta;
    if (this.meta.format_version !== FORMAT_VERSION) {
      throw new TrajParseError(
        `traj: meta.format_version ${this.meta.format_version} does not match header version ${FORMAT_VERSION}`,
      );
    }
    this.k = this.meta.intersections_order.length;
    this.a = this.meta.approaches.length;
    this.m = this.meta.metrics.length;

    // --- Trailer (last 16 bytes) ---
    const trailerAt = size - TRAILER_SIZE;
    const trailerMagic = readMagic(this.bytes, size - 4);
    if (trailerMagic !== TRAILER_MAGIC) {
      throw new TrajParseError(
        `traj: bad trailer magic ${JSON.stringify(trailerMagic)}; expected "${TRAILER_MAGIC}" — truncated file?`,
      );
    }
    this.numFrames = this.view.getUint32(trailerAt, true);
    const indexOffsetBig = this.view.getBigUint64(trailerAt + 4, true);
    const indexOffset = Number(indexOffsetBig);
    if (!Number.isSafeInteger(indexOffset)) {
      throw new TrajParseError(`traj: index_offset ${indexOffsetBig} is not a safe integer`);
    }
    this.indexOffset = indexOffset;

    const expectedSize = indexOffset + 8 * this.numFrames + TRAILER_SIZE;
    if (expectedSize !== size) {
      throw new TrajParseError(
        `traj: file size mismatch: index_offset(${indexOffset}) + 8*num_frames(${this.numFrames}) + 16 = ${expectedSize}, but file is ${size} B`,
      );
    }
    if (indexOffset < HEADER_SIZE + metaLen) {
      throw new TrajParseError(
        `traj: index_offset ${indexOffset} lies inside the header/meta region`,
      );
    }

    // --- Frame index ---
    this.index = new Float64Array(this.numFrames);
    let prev = -1;
    for (let i = 0; i < this.numFrames; i++) {
      const off = Number(this.view.getBigUint64(indexOffset + 8 * i, true));
      if (!Number.isSafeInteger(off)) {
        throw new TrajParseError(`traj: frame ${i} offset is not a safe integer`);
      }
      if (off <= prev) {
        throw new TrajParseError(
          `traj: frame index not strictly increasing at frame ${i} (offset ${off} after ${prev})`,
        );
      }
      if (off < HEADER_SIZE + metaLen || off + 12 > indexOffset) {
        throw new TrajParseError(
          `traj: frame ${i} offset ${off} out of bounds [${HEADER_SIZE + metaLen}, ${indexOffset})`,
        );
      }
      this.index[i] = off;
      prev = off;
    }
    if (this.numFrames > 0 && this.index[0] !== HEADER_SIZE + metaLen) {
      throw new TrajParseError(
        `traj: frame 0 offset ${this.index[0]} does not start right after meta (expected ${HEADER_SIZE + metaLen})`,
      );
    }
  }

  frame(i: number): TrajFrame {
    if (!Number.isInteger(i) || i < 0 || i >= this.numFrames) {
      throw new TrajParseError(
        `traj: frame index ${i} out of range [0, ${this.numFrames})`,
      );
    }
    const cached = this.cache.get(i);
    if (cached !== undefined) {
      // Refresh LRU recency.
      this.cache.delete(i);
      this.cache.set(i, cached);
      return cached;
    }
    const frame = this.decodeFrame(i);
    this.cache.set(i, frame);
    if (this.cache.size > this.cacheSize) {
      // Map preserves insertion order; the first key is the least recently used.
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
    return frame;
  }

  scanMeta(): TrajScan {
    if (this.scan !== null) return this.scan;
    const { view, k, a, m } = this;
    const n = this.numFrames;

    const ticks = new Uint32Array(n);
    const signalPhase = new Uint8Array(n * k);
    const signalState = new Uint8Array(n * k);
    const timeInPhase = new Float32Array(n * k);
    const queues = new Uint16Array(n * a);
    const rewards = new Float32Array(n * k);
    const metrics = new Float32Array(n * m);

    for (let i = 0; i < n; i++) {
      const base = this.index[i];
      ticks[i] = view.getUint32(base + 4, true);
      const nVeh = view.getUint32(base + 8, true);
      // Seek past the vehicle block; everything after it is what we want.
      let p = base + 12 + VEHICLE_RECORD_SIZE * nVeh;
      const kBase = i * k;
      for (let s = 0; s < k; s++) {
        signalPhase[kBase + s] = view.getUint8(p);
        signalState[kBase + s] = view.getUint8(p + 1);
        timeInPhase[kBase + s] = view.getFloat32(p + 2, true);
        p += SIGNAL_RECORD_SIZE;
      }
      const aBase = i * a;
      for (let q = 0; q < a; q++) {
        queues[aBase + q] = view.getUint16(p, true);
        p += 2;
      }
      for (let r = 0; r < k; r++) {
        rewards[kBase + r] = view.getFloat32(p, true);
        p += 4;
      }
      const mBase = i * m;
      for (let g = 0; g < m; g++) {
        metrics[mBase + g] = view.getFloat32(p, true);
        p += 4;
      }
      if (p !== (i + 1 < n ? this.index[i + 1] : this.indexOffset)) {
        throw new TrajParseError(`traj: scan of frame ${i} did not land on the next frame boundary`);
      }
    }

    this.scan = {
      numFrames: n,
      k,
      a,
      m,
      dt: this.meta.dt,
      ticks,
      signalPhase,
      signalState,
      timeInPhase,
      queues,
      rewards,
      metrics,
    };
    return this.scan;
  }

  private decodeFrame(i: number): TrajFrame {
    const { view, bytes, k, a, m } = this;
    const base = this.index[i];
    const end = i + 1 < this.numFrames ? this.index[i + 1] : this.indexOffset;

    const frameLen = view.getUint32(base, true);
    if (base + 4 + frameLen !== end) {
      throw new TrajParseError(
        `traj: frame ${i} frame_len ${frameLen} is inconsistent with the frame index (expected ${end - base - 4})`,
      );
    }
    const tick = view.getUint32(base + 4, true);
    const n = view.getUint32(base + 8, true);
    const expectedLen =
      8 + VEHICLE_RECORD_SIZE * n + SIGNAL_RECORD_SIZE * k + 2 * a + 4 * k + 4 * m;
    if (frameLen !== expectedLen) {
      throw new TrajParseError(
        `traj: frame ${i} frame_len ${frameLen} != 8 + 28*${n} + 6*${k} + 2*${a} + 4*${k} + 4*${m} = ${expectedLen}`,
      );
    }

    // --- Vehicle block: unaligned in the file, so copy into a fresh aligned
    // buffer, then reinterpret it per field by stride (28 B = 7 u32 slots). ---
    let p = base + 12;
    const vehBytes = new Uint8Array(VEHICLE_RECORD_SIZE * n);
    vehBytes.set(bytes.subarray(p, p + VEHICLE_RECORD_SIZE * n));
    p += VEHICLE_RECORD_SIZE * n;
    const vu32 = new Uint32Array(vehBytes.buffer);
    const vf32 = new Float32Array(vehBytes.buffer);
    const vu16 = new Uint16Array(vehBytes.buffer);

    const id = new Uint32Array(n);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const heading = new Float32Array(n);
    const speed = new Float32Array(n);
    const accel = new Float32Array(n);
    const lane = new Uint16Array(n);
    const flags = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      const w = 7 * v; // 28-byte record = 7 four-byte words
      id[v] = vu32[w];
      x[v] = vf32[w + 1];
      y[v] = vf32[w + 2];
      heading[v] = vf32[w + 3];
      speed[v] = vf32[w + 4];
      accel[v] = vf32[w + 5];
      lane[v] = vu16[14 * v + 12];
      flags[v] = vehBytes[VEHICLE_RECORD_SIZE * v + 26];
    }

    // --- Signals (6 B each, unaligned f32 -> DataView) ---
    const signals: SignalState[] = new Array(k);
    for (let s = 0; s < k; s++) {
      signals[s] = {
        phase: view.getUint8(p),
        state: view.getUint8(p + 1),
        timeInPhase: view.getFloat32(p + 2, true),
      };
      p += SIGNAL_RECORD_SIZE;
    }

    // --- Queues, rewards, metrics ---
    const queues = new Uint16Array(a);
    for (let q = 0; q < a; q++) {
      queues[q] = view.getUint16(p, true);
      p += 2;
    }
    const rewards = new Float32Array(k);
    for (let r = 0; r < k; r++) {
      rewards[r] = view.getFloat32(p, true);
      p += 4;
    }
    const metrics = new Float32Array(m);
    for (let g = 0; g < m; g++) {
      metrics[g] = view.getFloat32(p, true);
      p += 4;
    }

    return { tick, count: n, id, x, y, heading, speed, accel, lane, flags, signals, queues, rewards, metrics };
  }
}

/**
 * Parse a `.traj` file from an ArrayBuffer.
 *
 * Header, meta, trailer, and frame index are parsed eagerly (and validated);
 * frames are decoded lazily via `TrajFile.frame(i)` with an LRU cache.
 */
export function parseTraj(
  buffer: ArrayBuffer,
  options?: { cacheSize?: number },
): TrajFile {
  return new TrajFileImpl(buffer, options?.cacheSize ?? DEFAULT_CACHE_SIZE);
}

/**
 * One fast pass over `file` decoding ONLY tick + signals + queues + rewards +
 * metrics of every frame (vehicle blocks are skipped by seeking). The result
 * is cached on the file, so repeated calls are free.
 */
export function scanMeta(file: TrajFile): TrajScan {
  return file.scanMeta();
}
