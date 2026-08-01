import { describe, expect, it } from "vitest";

import {
  describeGap,
  formatClock,
  formatCount,
  formatElapsed,
  formatPercent,
  verdict,
  waitBars,
  waitGap,
} from "./format";
import { CAPTIONS, captionAt, captionIndexAt, CITY_RESULT, CLIP_RESULT } from "./story";

describe("formatClock", () => {
  it("prints sub-minute durations as bare seconds", () => {
    expect(formatClock(0)).toBe("0s");
    expect(formatClock(9.2)).toBe("9s");
    expect(formatClock(59.4)).toBe("59s");
  });

  it("prints minutes with zero-padded seconds", () => {
    expect(formatClock(107.4)).toBe("1m 47s");
    expect(formatClock(122.7)).toBe("2m 03s");
    expect(formatClock(60)).toBe("1m 00s");
    expect(formatClock(3599)).toBe("59m 59s");
  });

  it("rounds to the nearest second, carrying into the minute", () => {
    expect(formatClock(59.6)).toBe("1m 00s");
    expect(formatClock(119.5)).toBe("2m 00s");
  });

  it("keeps a sign on negative durations and dashes non-finite input", () => {
    expect(formatClock(-16.2)).toBe("−16s");
    expect(formatClock(NaN)).toBe("–");
    expect(formatClock(Infinity)).toBe("–");
  });
});

describe("formatCount", () => {
  it("rounds and groups thousands", () => {
    expect(formatCount(371)).toBe("371");
    expect(formatCount(336.6)).toBe("337");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(NaN)).toBe("–");
  });
});

describe("waitGap", () => {
  it("reports the responsive signal ahead when it waits less", () => {
    const gap = waitGap(122.7, 107.4);
    expect(gap.pct).toBeCloseTo(-12.47, 1);
    expect(gap.seconds).toBeCloseTo(-15.3, 5);
    expect(gap.leader).toBe("responsive");
  });

  it("reports the fixed timer ahead when the responsive side waits more", () => {
    const gap = waitGap(18.8, 23.6);
    expect(gap.pct).toBeCloseTo(25.5, 1);
    expect(gap.seconds).toBeCloseTo(4.8, 5);
    expect(gap.leader).toBe("fixed");
  });

  it("calls a sub-half-percent difference level", () => {
    expect(waitGap(100, 100).leader).toBe("even");
    expect(waitGap(100, 100.4).leader).toBe("even");
    expect(waitGap(100, 100.6).leader).toBe("fixed");
  });

  it("is unknown before either side has a usable baseline", () => {
    expect(waitGap(0, 0).leader).toBe("unknown");
    expect(waitGap(NaN, 12).leader).toBe("unknown");
    expect(Number.isNaN(waitGap(NaN, 12).seconds)).toBe(true);
  });
});

describe("formatPercent", () => {
  it("prints the magnitude as a whole number", () => {
    expect(formatPercent(-12.47)).toBe("12%");
    expect(formatPercent(25.5)).toBe("26%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(NaN)).toBe("–");
  });
});

describe("describeGap", () => {
  it("names the leading side in seconds per driver", () => {
    expect(describeGap(waitGap(122.7, 107.4))).toBe("Responsive signal ahead by 15s a driver");
    expect(describeGap(waitGap(18.8, 23.6))).toBe("Fixed timer ahead by 5s a driver");
  });

  it("has a plain phrase for level and for no data", () => {
    expect(describeGap(waitGap(100, 100))).toBe("Neck and neck so far");
    expect(describeGap(waitGap(0, 0))).toBe("Waiting for the first cars");
  });
});

describe("formatElapsed", () => {
  it("prints position and length as minutes and seconds", () => {
    expect(formatElapsed(0, 599.5)).toBe("0:00 of 10:00");
    expect(formatElapsed(200, 599.5)).toBe("3:20 of 10:00");
    expect(formatElapsed(65, 599.5)).toBe("1:05 of 10:00");
  });

  it("clamps past the end and dashes an unloaded clip", () => {
    expect(formatElapsed(700, 599.5)).toBe("10:00 of 10:00");
    expect(formatElapsed(0, 0)).toBe("–");
  });
});

describe("captions", () => {
  it("starts on the first line and advances at each cue", () => {
    expect(captionIndexAt(0)).toBe(0);
    expect(captionIndexAt(89)).toBe(0);
    expect(captionIndexAt(90)).toBe(1);
    expect(captionIndexAt(480)).toBe(CAPTIONS.length - 1);
    expect(captionIndexAt(10_000)).toBe(CAPTIONS.length - 1);
  });

  it("is defined for every moment of the clip", () => {
    for (let t = 0; t <= 600; t += 5) {
      expect(captionAt(t).length).toBeGreaterThan(20);
    }
  });

  it("keeps the cues in ascending order", () => {
    for (let i = 1; i < CAPTIONS.length; i++) {
      expect(CAPTIONS[i].from).toBeGreaterThan(CAPTIONS[i - 1].from);
    }
  });

  it("uses no research jargon", () => {
    const banned = /actuated|max-pressure|throughput|delay per vehicle|policy|trajectory|reward/i;
    for (const c of CAPTIONS) expect(c.text).not.toMatch(banned);
  });
});

describe("verdict", () => {
  it("names the responsive signal when it is ahead, with the size of the lead", () => {
    const v = verdict(waitGap(167, 135));
    expect(v.leader).toBe("responsive");
    expect(v.headline).toBe("The responsive signal is winning");
    expect(v.detail).toContain("right");
    expect(v.detail).toContain("32s");
    expect(v.detail).toContain("19%");
  });

  it("names the fixed timer just as plainly when the roles are reversed", () => {
    const v = verdict(waitGap(135, 167));
    expect(v.leader).toBe("fixed");
    expect(v.headline).toBe("The fixed timer is winning");
    expect(v.detail).toContain("left");
    expect(v.detail).toContain("32s");
  });

  it("declines to pick a winner when the two are level or unknown", () => {
    expect(verdict(waitGap(100, 100)).leader).toBe("even");
    expect(verdict(waitGap(100, 100)).headline).toBe("Neck and neck");
    expect(verdict(waitGap(NaN, 12)).leader).toBe("unknown");
    expect(verdict(waitGap(0, 0)).leader).toBe("unknown");
  });

  it("always says something a visitor can read", () => {
    for (const g of [waitGap(167, 135), waitGap(135, 167), waitGap(1, 1), waitGap(NaN, NaN)]) {
      const v = verdict(g);
      expect(v.headline.length).toBeGreaterThan(8);
      expect(v.detail.length).toBeGreaterThan(20);
      expect(v.detail).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

describe("waitBars", () => {
  it("fills the track for the longer wait and scales the other against it", () => {
    const bars = waitBars(200, 100);
    expect(bars.fixed).toBe(100);
    expect(bars.responsive).toBe(50);
  });

  it("is symmetric — the bigger number always wins the full track", () => {
    const bars = waitBars(100, 200);
    expect(bars.responsive).toBe(100);
    expect(bars.fixed).toBe(50);
  });

  it("draws nothing rather than a full bar when a side is unknown", () => {
    expect(waitBars(NaN, NaN)).toEqual({ fixed: 0, responsive: 0 });
    expect(waitBars(NaN, 100)).toEqual({ fixed: 0, responsive: 100 });
  });

  it("keeps a tiny wait visible instead of collapsing it to nothing", () => {
    const bars = waitBars(1000, 0.01);
    expect(bars.responsive).toBeGreaterThan(0);
    expect(bars.responsive).toBeLessThan(5);
  });

  it("never exceeds the track", () => {
    for (const [a, b] of [
      [0, 0],
      [1, 1e9],
      [0.5, 167],
      [167, 135],
    ]) {
      const bars = waitBars(a, b);
      expect(bars.fixed).toBeLessThanOrEqual(100);
      expect(bars.responsive).toBeLessThanOrEqual(100);
      expect(bars.fixed).toBeGreaterThanOrEqual(0);
      expect(bars.responsive).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the measured figures behind the page", () => {
  it("keeps the headline percentage consistent with the two wait times", () => {
    const gap = waitGap(CLIP_RESULT.fixedWaitSeconds, CLIP_RESULT.responsiveWaitSeconds);
    expect(Math.round(Math.abs(gap.pct))).toBe(CLIP_RESULT.waitReductionPct);
    expect(gap.leader).toBe("responsive");
  });

  it("keeps the city percentage consistent with its two wait times", () => {
    const gap = waitGap(CITY_RESULT.fixedWaitSeconds, CITY_RESULT.responsiveWaitSeconds);
    expect(Math.round(Math.abs(gap.pct))).toBe(CITY_RESULT.waitReductionPct);
    expect(gap.leader).toBe("responsive");
  });
});
