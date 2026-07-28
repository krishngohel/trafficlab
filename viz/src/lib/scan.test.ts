import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseTraj, scanMeta } from "./traj";

function loadFixture(name: string): ArrayBuffer {
  const url = new URL(`../../public/fixtures/${name}`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Minimal valid v1 .traj built in memory, for scan perf + correctness tests. */
function buildSynthetic(
  numFrames: number,
  K: number,
  A: number,
  M: number,
  nVeh: number,
): ArrayBuffer {
  const meta = {
    format_version: 1,
    dt: 0.5,
    seed: 7,
    policy: "test",
    network_name: "synthetic-big",
    network: { nodes: [], links: [], lanes: [], connections: [], intersections: [] },
    intersections_order: Array.from({ length: K }, (_, i) => i),
    approaches: Array.from({ length: A }, (_, i) => ({
      intersection: i % Math.max(K, 1),
      link: i,
      label: `A${i}`,
    })),
    metrics: Array.from({ length: M }, (_, i) => `m${i}`),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const frameLen = 8 + 28 * nVeh + 6 * K + 2 * A + 4 * K + 4 * M;
  const framesSize = numFrames * (4 + frameLen);
  const indexOffset = 12 + metaBytes.length + framesSize;
  const total = indexOffset + 8 * numFrames + 16;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Header.
  bytes.set([0x54, 0x4c, 0x54, 0x4a], 0); // "TLTJ"
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, metaBytes.length, true);
  bytes.set(metaBytes, 12);

  let p = 12 + metaBytes.length;
  for (let f = 0; f < numFrames; f++) {
    view.setBigUint64(indexOffset + 8 * f, BigInt(p), true);
    view.setUint32(p, frameLen, true);
    view.setUint32(p + 4, f, true);
    view.setUint32(p + 8, nVeh, true);
    let q = p + 12;
    for (let v = 0; v < nVeh; v++) {
      view.setUint32(q, f * 1000 + v, true); // id
      view.setFloat32(q + 4, v * 3.5, true); // x
      view.setFloat32(q + 8, f * 0.1, true); // y
      view.setFloat32(q + 12, 0.3, true); // heading
      view.setFloat32(q + 16, 8.2, true); // speed
      view.setFloat32(q + 20, 0.1, true); // accel
      view.setUint16(q + 24, 0xffff, true); // lane
      view.setUint8(q + 26, 0); // flags
      view.setUint8(q + 27, 0); // vclass
      q += 28;
    }
    for (let k = 0; k < K; k++) {
      view.setUint8(q, (f >> 5) % 4); // phase
      view.setUint8(q + 1, f % 3); // state
      view.setFloat32(q + 2, (f % 40) * 0.5, true);
      q += 6;
    }
    for (let a = 0; a < A; a++) {
      view.setUint16(q, (f + a) % 17, true);
      q += 2;
    }
    for (let k = 0; k < K; k++) {
      view.setFloat32(q, -((f + k) % 9) * 0.25, true);
      q += 4;
    }
    for (let m = 0; m < M; m++) {
      view.setFloat32(q, f * 0.5 + m, true);
      q += 4;
    }
    p = q;
  }

  // Trailer.
  view.setUint32(indexOffset + 8 * numFrames, numFrames, true);
  view.setBigUint64(indexOffset + 8 * numFrames + 4, BigInt(indexOffset), true);
  bytes.set([0x54, 0x4c, 0x49, 0x58], total - 4); // "TLIX"
  return buf;
}

function expectScanMatchesFrames(buffer: ArrayBuffer, sampleFrames: number[]) {
  const traj = parseTraj(buffer);
  const scan = scanMeta(traj);
  const { k, a, m } = scan;

  expect(scan.numFrames).toBe(traj.numFrames);
  expect(scan.dt).toBe(traj.meta.dt);
  expect(scan.ticks.length).toBe(traj.numFrames);
  expect(scan.signalPhase.length).toBe(traj.numFrames * k);
  expect(scan.signalState.length).toBe(traj.numFrames * k);
  expect(scan.timeInPhase.length).toBe(traj.numFrames * k);
  expect(scan.queues.length).toBe(traj.numFrames * a);
  expect(scan.rewards.length).toBe(traj.numFrames * k);
  expect(scan.metrics.length).toBe(traj.numFrames * m);

  for (const i of sampleFrames) {
    const f = traj.frame(i);
    expect(scan.ticks[i]).toBe(f.tick);
    for (let s = 0; s < k; s++) {
      expect(scan.signalPhase[i * k + s]).toBe(f.signals[s].phase);
      expect(scan.signalState[i * k + s]).toBe(f.signals[s].state);
      expect(scan.timeInPhase[i * k + s]).toBeCloseTo(f.signals[s].timeInPhase, 5);
    }
    for (let q = 0; q < a; q++) expect(scan.queues[i * a + q]).toBe(f.queues[q]);
    for (let r = 0; r < k; r++) expect(scan.rewards[i * k + r]).toBeCloseTo(f.rewards[r], 5);
    for (let g = 0; g < m; g++) expect(scan.metrics[i * m + g]).toBeCloseTo(f.metrics[g], 5);
  }
}

describe("scanMeta", () => {
  it("matches full frame decodes on synthetic.traj", () => {
    expectScanMatchesFrames(loadFixture("synthetic.traj"), [0, 1, 137, 240, 479]);
  });

  it("matches full frame decodes on city.traj", () => {
    expectScanMatchesFrames(loadFixture("city.traj"), [0, 1, 450, 900, 1350, 1799]);
  });

  it("has monotonic ticks on city.traj", () => {
    const scan = scanMeta(parseTraj(loadFixture("city.traj")));
    for (let i = 0; i < scan.numFrames; i++) expect(scan.ticks[i]).toBe(i);
  });

  it("is cached: repeated calls return the same object", () => {
    const traj = parseTraj(loadFixture("synthetic.traj"));
    expect(scanMeta(traj)).toBe(scanMeta(traj));
  });

  it("scans 6000 frames (with vehicle blocks to skip) in under 200 ms", () => {
    const buffer = buildSynthetic(6000, 4, 16, 4, 40);
    const traj = parseTraj(buffer);
    const t0 = performance.now();
    const scan = scanMeta(traj);
    const elapsed = performance.now() - t0;
    expect(scan.numFrames).toBe(6000);
    expect(elapsed).toBeLessThan(200);
    // Spot-check values against the generator formulas.
    expect(scan.queues[123 * 16 + 5]).toBe((123 + 5) % 17);
    expect(scan.rewards[777 * 4 + 2]).toBeCloseTo(-((777 + 2) % 9) * 0.25, 6);
    expect(scan.metrics[4321 * 4 + 3]).toBeCloseTo(4321 * 0.5 + 3, 5);
    expect(scan.signalState[999 * 4 + 1]).toBe(999 % 3);
  });

  it("decodes correctly on a file with zero vehicles everywhere", () => {
    const buffer = buildSynthetic(50, 2, 4, 3, 0);
    expectScanMatchesFrames(buffer, [0, 25, 49]);
  });
});
