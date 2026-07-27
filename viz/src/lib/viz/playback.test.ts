import { describe, expect, it } from "vitest";

import { PlaybackClock } from "./playback";

function clock(duration = 100): PlaybackClock {
  const c = new PlaybackClock();
  c.duration = duration;
  return c;
}

describe("PlaybackClock", () => {
  it("advances at speed x real time", () => {
    const c = clock();
    c.speed = 4;
    c.advance(0.5);
    expect(c.time).toBeCloseTo(2);
  });

  it("does not advance while paused or with no file", () => {
    const c = clock();
    c.playing = false;
    c.advance(1);
    expect(c.time).toBe(0);
    const empty = clock(0);
    empty.advance(1);
    expect(empty.time).toBe(0);
  });

  it("loops by default and clamps+pauses when loop is off", () => {
    const c = clock(10);
    c.time = 9.5;
    c.advance(1);
    expect(c.time).toBeCloseTo(0.5);
    expect(c.playing).toBe(true);

    const r = clock(10);
    r.loop = false;
    r.time = 9.5;
    r.advance(1);
    expect(r.time).toBe(10);
    expect(r.playing).toBe(false);
  });

  it("seek clamps to [0, duration]", () => {
    const c = clock(10);
    c.seek(-5);
    expect(c.time).toBe(0);
    c.seek(50);
    expect(c.time).toBe(10);
  });

  it("stepFrames pauses and quantizes to frame boundaries", () => {
    const c = clock(100);
    c.time = 5.2; // dt=0.5 -> frame 10.4
    c.stepFrames(0.5, 1);
    expect(c.playing).toBe(false);
    expect(c.time).toBeCloseTo(5.5); // frame 11
    c.stepFrames(0.5, -1);
    expect(c.time).toBeCloseTo(5.0);
    c.time = 0;
    c.stepFrames(0.5, -1);
    expect(c.time).toBe(0);
  });

  it("frameAt maps time to a clamped fractional frame", () => {
    const c = clock(100);
    c.time = 3.25;
    expect(c.frameAt(0.5, 1000)).toBeCloseTo(6.5);
    c.time = 99999;
    c.seek(c.time);
    expect(c.frameAt(0.5, 21)).toBe(20);
    expect(c.frameAt(0, 21)).toBe(0);
  });
});
