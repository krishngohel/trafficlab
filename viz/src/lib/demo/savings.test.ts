import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  fasterReadout,
  formatSaved,
  hasSpeedWindow,
  percentFaster,
  savedReadout,
  savedSeconds,
  speedColumn,
  trailingMean,
  windowFrames,
  SPEED_WARMUP_SECONDS,
  SPEED_WINDOW_SECONDS,
} from "./savings";
import { CITY_SAVED, CLIP_SAVED } from "./story";
import { parseTraj } from "../traj";

describe("formatSaved", () => {
  it("prints a small saving as bare seconds", () => {
    expect(formatSaved(0)).toBe("0s");
    expect(formatSaved(8.6)).toBe("9s");
    expect(formatSaved(59.4)).toBe("59s");
  });

  it("prints minutes and padded seconds below the hour", () => {
    expect(formatSaved(60)).toBe("1m 00s");
    expect(formatSaved(764.3)).toBe("12m 44s");
    expect(formatSaved(3599)).toBe("59m 59s");
  });

  it("prints hours and padded minutes above the hour", () => {
    expect(formatSaved(3600)).toBe("1h 00m");
    expect(formatSaved(CLIP_SAVED.savedSeconds)).toBe("2h 09m");
    expect(formatSaved(CITY_SAVED.savedSeconds)).toBe("10h 59m");
  });

  it("never rolls the minutes to sixty on the boundary", () => {
    // 3h 59m 59s would print "3h 60m" if the rounding happened after the split.
    expect(formatSaved(3 * 3600 + 3599)).toBe("4h 00m");
    expect(formatSaved(3599.6)).toBe("1h 00m");
  });

  it("marks a negative saving rather than hiding the sign", () => {
    expect(formatSaved(-90)).toBe("−1m 30s");
    expect(formatSaved(-7754)).toBe("−2h 09m");
  });

  it("renders an en dash rather than NaN", () => {
    expect(formatSaved(NaN)).toBe("–");
    expect(formatSaved(Infinity)).toBe("–");
  });

  it("keeps a stable width as it counts up, so the hero does not jitter", () => {
    for (const s of [61, 601, 3601, 36001]) {
      expect(formatSaved(s).length).toBe(formatSaved(s + 1).length);
    }
  });
});

describe("savedSeconds", () => {
  it("credits the responsive side when the fixed timer accumulated more delay", () => {
    expect(savedSeconds(84971, 77216)).toBeCloseTo(7755, 6);
  });

  it("goes negative when the fixed timer is the one saving time", () => {
    expect(savedSeconds(77216, 84971)).toBeLessThan(0);
  });

  it("is unknown rather than zero when a side has not reported", () => {
    expect(Number.isNaN(savedSeconds(NaN, 100))).toBe(true);
    expect(Number.isNaN(savedSeconds(100, NaN))).toBe(true);
  });
});

describe("savedReadout", () => {
  it("names the responsive signal, and the right-hand side, when it is saving time", () => {
    const r = savedReadout(7754);
    expect(r.leader).toBe("responsive");
    expect(r.value).toBe("2h 09m");
    expect(r.line).toContain("responsive signal on the right");
    expect(r.line).toContain("counting");
  });

  it("names the fixed timer just as plainly when the roles are reversed", () => {
    const r = savedReadout(-7754);
    expect(r.leader).toBe("fixed");
    // The magnitude, never a minus sign in the hero — the words carry the sign.
    expect(r.value).toBe("2h 09m");
    expect(r.line).toContain("fixed timer on the left");
  });

  it("declines to pick a winner when the two are level or unknown", () => {
    expect(savedReadout(0).leader).toBe("even");
    expect(savedReadout(0.4).leader).toBe("even");
    expect(savedReadout(NaN).leader).toBe("unknown");
    expect(savedReadout(NaN).value).toBe("–");
  });

  it("always says something a visitor can read", () => {
    for (const s of [7754, -7754, 0, NaN, 3, 39523]) {
      const r = savedReadout(s);
      expect(r.line.length).toBeGreaterThan(20);
      expect(r.line).not.toMatch(/NaN|undefined|Infinity/);
      expect(r.value).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

describe("the measured saved-waiting figures", () => {
  it("adds up, so a reader who subtracts the two totals gets the saving printed", () => {
    expect(CLIP_SAVED.fixedDelaySeconds - CLIP_SAVED.responsiveDelaySeconds).toBe(
      CLIP_SAVED.savedSeconds,
    );
    expect(CITY_SAVED.fixedDelaySeconds - CITY_SAVED.responsiveDelaySeconds).toBe(
      CITY_SAVED.savedSeconds,
    );
  });

  it("credits the responsive signal on both clips", () => {
    expect(savedReadout(CLIP_SAVED.savedSeconds).leader).toBe("responsive");
    expect(savedReadout(CITY_SAVED.savedSeconds).leader).toBe("responsive");
  });

  it("quotes a percentage consistent with its own two mean speeds", () => {
    expect(
      Math.round(percentFaster(CLIP_SAVED.fixedSpeedMps, CLIP_SAVED.responsiveSpeedMps)),
    ).toBe(CLIP_SAVED.fasterPct);
    expect(
      Math.round(percentFaster(CITY_SAVED.fixedSpeedMps, CITY_SAVED.responsiveSpeedMps)),
    ).toBe(CITY_SAVED.fasterPct);
  });
});

describe("percentFaster", () => {
  it("measures the responsive side against the fixed one", () => {
    expect(percentFaster(1.137, 1.466)).toBeCloseTo(28.94, 1);
    expect(percentFaster(4.822, 5.639)).toBeCloseTo(16.94, 1);
  });

  it("is negative when the fixed side is the quicker one", () => {
    expect(percentFaster(2, 1)).toBeCloseTo(-50, 6);
  });

  it("has no answer without a usable baseline", () => {
    expect(Number.isNaN(percentFaster(0, 1.5))).toBe(true);
    expect(Number.isNaN(percentFaster(-1, 1.5))).toBe(true);
    expect(Number.isNaN(percentFaster(NaN, 1.5))).toBe(true);
    expect(Number.isNaN(percentFaster(1.5, NaN))).toBe(true);
  });
});

describe("fasterReadout", () => {
  it("points at the right-hand side when the responsive signal is flowing quicker", () => {
    const r = fasterReadout(28.9);
    expect(r.leader).toBe("responsive");
    expect(r.value).toBe("29%");
    expect(r.line).toContain("on the right");
  });

  it("points at the left-hand side just as readily", () => {
    const r = fasterReadout(-12);
    expect(r.leader).toBe("fixed");
    expect(r.value).toBe("12%");
    expect(r.line).toContain("on the left");
  });

  it("calls a small difference level instead of inventing a winner", () => {
    expect(fasterReadout(0.2).leader).toBe("even");
    expect(fasterReadout(0.2).value).toBe("Level");
    expect(fasterReadout(NaN).leader).toBe("unknown");
    expect(fasterReadout(NaN).value).toBe("–");
  });

  it("says how long a window it is averaging, so the reading is not mistaken for an instant", () => {
    expect(fasterReadout(28.9).line).toContain(String(SPEED_WINDOW_SECONDS));
  });
});

describe("windowFrames", () => {
  it("converts the trailing window into frames at the file's own timestep", () => {
    expect(windowFrames(0.5)).toBe(120);
    expect(windowFrames(1)).toBe(60);
    expect(windowFrames(0.5, 30)).toBe(60);
  });

  it("falls back to the standard timestep rather than dividing by zero", () => {
    expect(windowFrames(0)).toBe(120);
    expect(windowFrames(NaN)).toBe(120);
  });
});

describe("hasSpeedWindow", () => {
  it("withholds the reading until enough clip has played", () => {
    expect(hasSpeedWindow(0, 0.5)).toBe(false);
    expect(hasSpeedWindow(29, 0.5)).toBe(false);
    expect(hasSpeedWindow(30, 0.5)).toBe(true);
    expect(hasSpeedWindow(1199, 0.5)).toBe(true);
  });

  it("counts in the file's own timestep", () => {
    expect(hasSpeedWindow(SPEED_WARMUP_SECONDS - 1, 1)).toBe(false);
    expect(hasSpeedWindow(SPEED_WARMUP_SECONDS, 1)).toBe(true);
  });
});

describe("trailingMean", () => {
  // Two columns, four frames: col 0 counts up, col 1 is the one under test.
  const metrics = [0, 10, 1, 20, 2, 30, 3, 40];

  it("averages the window ending at the frame", () => {
    expect(trailingMean(metrics, 2, 1, 3, 2)).toBe(35);
    expect(trailingMean(metrics, 2, 1, 3, 4)).toBe(25);
  });

  it("clips the window to the start of the file rather than reading garbage", () => {
    expect(trailingMean(metrics, 2, 1, 1, 100)).toBe(15);
    expect(trailingMean(metrics, 2, 1, 0, 100)).toBe(10);
  });

  it("clamps a frame beyond the end to the last one", () => {
    expect(trailingMean(metrics, 2, 1, 99, 1)).toBe(40);
    expect(trailingMean(metrics, 2, 1, -5, 1)).toBe(10);
  });

  it("has no answer when the column is absent", () => {
    expect(Number.isNaN(trailingMean(metrics, 2, -1, 0, 1))).toBe(true);
    expect(Number.isNaN(trailingMean([], 2, 1, 0, 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The invariant that matters: on the recordings the page actually ships, the
// side credited with saving time is the responsive one — at every single frame,
// not just at the end. If a re-recording ever flipped that, the page would
// truthfully say the fixed timer was winning, and this test would fail first.
// ---------------------------------------------------------------------------

function scanOf(name: string) {
  const url = new URL(`../../../public/fixtures/${name}`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  const traj = parseTraj(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  return { scan: traj.scanMeta(), names: traj.meta.metrics };
}

interface PairFacts {
  savedAtEnd: number;
  minSaved: number;
  leadersSeen: Set<string>;
  minFasterPct: number;
  maxFasterPct: number;
  meanSpeeds: [number, number];
  finalDelays: [number, number];
}

function comparePair(fixedFile: string, responsiveFile: string): PairFacts {
  const a = scanOf(fixedFile);
  const b = scanOf(responsiveFile);
  const delayCol = [a.names.indexOf("cumulative_delay"), b.names.indexOf("cumulative_delay")];
  const speedCol = [speedColumn(a.names), speedColumn(b.names)];
  expect(delayCol[0]).toBeGreaterThanOrEqual(0);
  expect(speedCol[0]).toBeGreaterThanOrEqual(0);

  const frames = Math.min(a.scan.numFrames, b.scan.numFrames);
  const span = windowFrames(a.scan.dt);
  const leadersSeen = new Set<string>();
  let minSaved = Infinity;
  let minFasterPct = Infinity;
  let maxFasterPct = -Infinity;
  let sumA = 0;
  let sumB = 0;
  let savedAtEnd = NaN;

  for (let f = 0; f < frames; f++) {
    const da = a.scan.metrics[f * a.scan.m + delayCol[0]];
    const db = b.scan.metrics[f * b.scan.m + delayCol[1]];
    const saved = savedSeconds(da, db);
    minSaved = Math.min(minSaved, saved);
    leadersSeen.add(savedReadout(saved).leader);
    savedAtEnd = saved;

    sumA += a.scan.metrics[f * a.scan.m + speedCol[0]];
    sumB += b.scan.metrics[f * b.scan.m + speedCol[1]];

    // Exactly what the page shows: withheld during the warm-up, then a
    // trailing-window mean.
    if (hasSpeedWindow(f, a.scan.dt)) {
      const pct = percentFaster(
        trailingMean(a.scan.metrics, a.scan.m, speedCol[0], f, span),
        trailingMean(b.scan.metrics, b.scan.m, speedCol[1], f, span),
      );
      minFasterPct = Math.min(minFasterPct, pct);
      maxFasterPct = Math.max(maxFasterPct, pct);
    }
  }

  return {
    savedAtEnd,
    minSaved,
    leadersSeen,
    minFasterPct,
    maxFasterPct,
    meanSpeeds: [sumA / frames, sumB / frames],
    finalDelays: [
      a.scan.metrics[(frames - 1) * a.scan.m + delayCol[0]],
      b.scan.metrics[(frames - 1) * b.scan.m + delayCol[1]],
    ],
  };
}

describe("the shipped junction recordings", () => {
  const facts = comparePair("demo_fixed.traj", "demo_actuated.traj");

  it("credits the responsive signal, and only the responsive signal, at every frame", () => {
    expect(facts.minSaved).toBeGreaterThan(0);
    expect([...facts.leadersSeen]).toEqual(["responsive"]);
  });

  it("ends on the figure the page prints", () => {
    expect(facts.savedAtEnd).toBeCloseTo(CLIP_SAVED.savedSeconds, -1);
    expect(facts.finalDelays[0]).toBeCloseTo(CLIP_SAVED.fixedDelaySeconds, -1);
    expect(facts.finalDelays[1]).toBeCloseTo(CLIP_SAVED.responsiveDelaySeconds, -1);
    expect(formatSaved(facts.savedAtEnd)).toBe(formatSaved(CLIP_SAVED.savedSeconds));
  });

  it("keeps the live speed reading on the responsive side's own terms", () => {
    // The trailing window is chosen so this holds: a raw per-frame comparison
    // dips the other way on 13% of frames and would flicker the wrong answer.
    expect(facts.minFasterPct).toBeGreaterThan(0);
    // And the warm-up guard is what keeps the first thing a visitor sees from
    // being a one-off "99% faster" off the opening frames.
    expect(facts.maxFasterPct).toBeLessThan(80);
  });

  it("matches the mean speeds quoted in the story", () => {
    expect(facts.meanSpeeds[0]).toBeCloseTo(CLIP_SAVED.fixedSpeedMps, 1);
    expect(facts.meanSpeeds[1]).toBeCloseTo(CLIP_SAVED.responsiveSpeedMps, 1);
    expect(Math.round(percentFaster(facts.meanSpeeds[0], facts.meanSpeeds[1]))).toBe(
      CLIP_SAVED.fasterPct,
    );
  });
});

describe("the shipped city recordings", () => {
  const facts = comparePair("metro_fixed.traj", "metro_actuated.traj");

  it("credits the responsive signals, and only them, at every frame", () => {
    expect(facts.minSaved).toBeGreaterThan(0);
    expect([...facts.leadersSeen]).toEqual(["responsive"]);
  });

  it("ends on the figure the page prints", () => {
    expect(facts.savedAtEnd).toBeCloseTo(CITY_SAVED.savedSeconds, -1);
    expect(facts.finalDelays[0]).toBeCloseTo(CITY_SAVED.fixedDelaySeconds, -1);
    expect(facts.finalDelays[1]).toBeCloseTo(CITY_SAVED.responsiveDelaySeconds, -1);
    expect(formatSaved(facts.savedAtEnd)).toBe(formatSaved(CITY_SAVED.savedSeconds));
  });

  it("keeps the live speed reading on the responsive side's own terms", () => {
    expect(facts.minFasterPct).toBeGreaterThan(0);
    expect(facts.maxFasterPct).toBeLessThan(80);
  });

  it("matches the mean speeds quoted in the story", () => {
    expect(facts.meanSpeeds[0]).toBeCloseTo(CITY_SAVED.fixedSpeedMps, 1);
    expect(facts.meanSpeeds[1]).toBeCloseTo(CITY_SAVED.responsiveSpeedMps, 1);
    expect(Math.round(percentFaster(facts.meanSpeeds[0], facts.meanSpeeds[1]))).toBe(
      CITY_SAVED.fasterPct,
    );
  });
});
