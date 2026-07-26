import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { parseTraj, TrajParseError, type TrajFile } from "./traj";

const FIXTURE_URL = new URL("../../public/fixtures/synthetic.traj", import.meta.url);

function loadFixture(): ArrayBuffer {
  const buf = readFileSync(fileURLToPath(FIXTURE_URL));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("parseTraj on synthetic.traj", () => {
  let raw: ArrayBuffer;
  let traj: TrajFile;

  beforeAll(() => {
    raw = loadFixture();
    traj = parseTraj(raw);
  });

  it("parses header, meta, and trailer", () => {
    expect(traj.meta.format_version).toBe(1);
    expect(traj.meta.dt).toBeGreaterThan(0);
    expect(traj.meta.network.lanes.length).toBeGreaterThan(0);
    expect(traj.meta.intersections_order.length).toBe(1);
    expect(traj.meta.approaches.length).toBe(4);
    expect(traj.meta.metrics.length).toBe(4);
  });

  it("has 480 frames", () => {
    expect(traj.numFrames).toBe(480);
  });

  it("has monotonic ticks 0..479", () => {
    for (let i = 0; i < traj.numFrames; i++) {
      expect(traj.frame(i).tick).toBe(i);
    }
  });

  it("frame(0) has 24 vehicles", () => {
    const f0 = traj.frame(0);
    expect(f0.count).toBe(24);
    expect(f0.id.length).toBe(24);
    expect(f0.x.length).toBe(24);
    expect(f0.y.length).toBe(24);
    expect(f0.heading.length).toBe(24);
    expect(f0.speed.length).toBe(24);
    expect(f0.accel.length).toBe(24);
    expect(f0.lane.length).toBe(24);
    expect(f0.flags.length).toBe(24);
  });

  it("frame arrays match meta-defined K, A, M", () => {
    const f0 = traj.frame(0);
    expect(f0.signals.length).toBe(1);
    expect(f0.queues.length).toBe(4);
    expect(f0.rewards.length).toBe(1);
    expect(f0.metrics.length).toBe(4);
    for (const s of f0.signals) {
      expect([0, 1, 2]).toContain(s.state);
      expect(Number.isFinite(s.timeInPhase)).toBe(true);
    }
  });

  it("random access frame(300) equals a sequential read", () => {
    const sequential = parseTraj(loadFixture());
    for (let i = 0; i <= 300; i++) sequential.frame(i);
    const seq = sequential.frame(300);

    const random = parseTraj(loadFixture());
    const ra = random.frame(300);

    expect(ra.tick).toBe(seq.tick);
    expect(ra.count).toBe(seq.count);
    expect(Array.from(ra.id)).toEqual(Array.from(seq.id));
    expect(Array.from(ra.x)).toEqual(Array.from(seq.x));
    expect(Array.from(ra.y)).toEqual(Array.from(seq.y));
    expect(Array.from(ra.heading)).toEqual(Array.from(seq.heading));
    expect(Array.from(ra.speed)).toEqual(Array.from(seq.speed));
    expect(Array.from(ra.accel)).toEqual(Array.from(seq.accel));
    expect(Array.from(ra.lane)).toEqual(Array.from(seq.lane));
    expect(Array.from(ra.flags)).toEqual(Array.from(seq.flags));
    expect(ra.signals).toEqual(seq.signals);
    expect(Array.from(ra.queues)).toEqual(Array.from(seq.queues));
    expect(Array.from(ra.rewards)).toEqual(Array.from(seq.rewards));
    expect(Array.from(ra.metrics)).toEqual(Array.from(seq.metrics));
  });

  it("all speeds are finite and >= 0 in every frame", () => {
    for (let i = 0; i < traj.numFrames; i++) {
      const f = traj.frame(i);
      for (let v = 0; v < f.count; v++) {
        expect(Number.isFinite(f.speed[v])).toBe(true);
        expect(f.speed[v]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("throws out of range on bad frame indices", () => {
    expect(() => traj.frame(-1)).toThrow(TrajParseError);
    expect(() => traj.frame(480)).toThrow(TrajParseError);
    expect(() => traj.frame(1.5)).toThrow(TrajParseError);
  });

  it("rejects corrupted magics with descriptive errors", () => {
    const badHeader = loadFixture();
    new Uint8Array(badHeader)[0] = 0x58; // "XLTJ"
    expect(() => parseTraj(badHeader)).toThrow(/header magic/);

    const badTrailer = loadFixture();
    new Uint8Array(badTrailer)[badTrailer.byteLength - 4] = 0x58; // "TLIX" -> "XLIX"
    expect(() => parseTraj(badTrailer)).toThrow(/trailer magic/);
  });
});
