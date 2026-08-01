import { describe, expect, it } from "vitest";

import { formatBytes, loadPercent } from "./load";
import { CAPTIONS, CITY_RESULT, CLIP_RESULT, FIXTURES, METRO, STUDY_RESULT } from "./story";

describe("loadPercent", () => {
  it("is a clamped percentage of the total", () => {
    expect(loadPercent(0, 100)).toBe(0);
    expect(loadPercent(25, 100)).toBe(25);
    expect(loadPercent(100, 100)).toBe(100);
  });

  it("never exceeds 100 or drops below 0", () => {
    expect(loadPercent(140, 100)).toBe(100);
    expect(loadPercent(-5, 100)).toBe(0);
  });

  it("returns 0 when there is nothing to divide by", () => {
    expect(loadPercent(10, 0)).toBe(0);
    expect(loadPercent(10, NaN)).toBe(0);
    expect(loadPercent(NaN, 100)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3_705_992)).toBe("3.5 MB");
    expect(formatBytes(-1)).toBe("–");
  });
});

describe("story constants", () => {
  it("points at the four fixtures that ship with the public build", () => {
    expect(FIXTURES.fixed).toBe("/fixtures/demo_fixed.traj");
    expect(FIXTURES.responsive).toBe("/fixtures/demo_actuated.traj");
    expect(FIXTURES.cityFixed).toBe("/fixtures/metro_fixed.traj");
    expect(FIXTURES.cityResponsive).toBe("/fixtures/metro_actuated.traj");
  });

  it("keeps every fixture URL under the base path so a subpath host resolves it", () => {
    for (const url of Object.values(FIXTURES)) {
      expect(url.startsWith("/fixtures/")).toBe(true);
    }
  });

  it("keeps the headline percentage consistent with the two wait figures", () => {
    // The measured means are 122.7 s and 107.4 s, a 12.5% cut. The page prints
    // them rounded to whole seconds, so recomputing from those gives 13% —
    // within one point of the quoted figure, which is all this can check.
    const { fixedWaitSeconds, responsiveWaitSeconds, waitReductionPct } = CLIP_RESULT;
    const derived = ((fixedWaitSeconds - responsiveWaitSeconds) / fixedWaitSeconds) * 100;
    expect(Math.abs(derived - waitReductionPct)).toBeLessThan(1.5);
  });

  it("has the responsive side clearing more cars with less waiting", () => {
    expect(CLIP_RESULT.responsiveCars).toBeGreaterThan(CLIP_RESULT.fixedCars);
    expect(CLIP_RESULT.responsiveWaitSeconds).toBeLessThan(CLIP_RESULT.fixedWaitSeconds);
  });

  it("never lets the on-screen clip claim more than the study supports", () => {
    // The clip is one seed under heavy demand, so it must not overstate the
    // ten-run result measured on the same demand. Equality is the ideal case:
    // it means the clip on screen is representative rather than cherry-picked.
    expect(STUDY_RESULT.runsPerSide).toBe(10);
    expect(CLIP_RESULT.waitReductionPct).toBeLessThanOrEqual(STUDY_RESULT.heavyReductionPct);
    expect(STUDY_RESULT.rushReductionPct).toBeGreaterThan(STUDY_RESULT.heavyReductionPct);
  });

  it("has the responsive city clearing more drivers with less waiting too", () => {
    expect(CITY_RESULT.responsiveCars).toBeGreaterThan(CITY_RESULT.fixedCars);
    expect(CITY_RESULT.responsiveWaitSeconds).toBeLessThan(CITY_RESULT.fixedWaitSeconds);
    expect(CITY_RESULT.responsiveCars - CITY_RESULT.fixedCars).toBe(CITY_RESULT.extraCars);
  });

  it("keeps the city percentage consistent with the two city wait figures", () => {
    // Measured: 202652/1981 = 102.3 s against 163129/1912 = 85.3 s, a 16.6%
    // cut. The page prints whole seconds, so recomputing from those lands
    // within a point of the quoted figure — all this can honestly check.
    const { fixedWaitSeconds, responsiveWaitSeconds, waitReductionPct } = CITY_RESULT;
    const derived = ((fixedWaitSeconds - responsiveWaitSeconds) / fixedWaitSeconds) * 100;
    expect(Math.abs(derived - waitReductionPct)).toBeLessThan(1.5);
  });

  it("describes the city clip as long as the recordings actually are", () => {
    expect(CITY_RESULT.minutes).toBe(METRO.minutes);
    expect(METRO.intersections).toBe(100);
    // Both files together, so the download promise on the button is not a lie.
    expect(METRO.megabytes).toBeGreaterThanOrEqual(30);
    expect(METRO.megabytes).toBeLessThanOrEqual(40);
  });

  it("never calls the responsive signal AI", () => {
    const banned = /\bAI\b|machine learning|neural|reinforcement/i;
    for (const c of CAPTIONS) expect(c.text).not.toMatch(banned);
  });
});
