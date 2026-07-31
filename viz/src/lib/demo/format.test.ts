import { describe, expect, it } from "vitest";

import {
  describeGap,
  formatClock,
  formatCount,
  formatElapsed,
  formatPercent,
  waitGap,
} from "./format";
import { CAPTIONS, captionAt, captionIndexAt } from "./story";

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
