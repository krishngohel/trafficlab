/**
 * The denominator invariants.
 *
 * The public page once printed two different "average wait per driver" figures
 * for the same fixed timer — 3m 53s in part one, 2m 47s in part two — because
 * the two sections divided the same waiting by different crowds. These tests
 * exist so that cannot come back, and so the flattering denominator the page
 * shows can never be quietly substituted for the strict one the study uses.
 *
 * Everything here is measured off the four recordings the build ships.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatClock } from "./format";
import { rollingWaitAt, meanOverSeconds, regimeSpan, rollingWaitSeries, waitPerFinisherAt } from "./rolling";
import { windowFrames } from "./savings";
import {
  CITY_PER_ENTRANT,
  CITY_RESULT,
  CLIP_PER_ENTRANT,
  CLIP_RESULT,
  STUDY_RESULT,
  SWITCH_CLIP,
  SWITCH_RESULT,
  WAIT_BASIS,
} from "./story";
import { parseTraj } from "../traj";

function scanOf(name: string) {
  const url = new URL(`../../../public/fixtures/${name}`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  const traj = parseTraj(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  return { scan: traj.scanMeta(), names: traj.meta.metrics };
}

/** The last frame of a recording, on both denominators, exactly as the page reads it. */
function endOf(name: string) {
  const { scan, names } = scanOf(name);
  const delayCol = names.indexOf("cumulative_delay");
  const thruCol = names.indexOf("throughput");
  const activeCol = names.indexOf("active_vehicles");
  expect(delayCol).toBeGreaterThanOrEqual(0);
  expect(thruCol).toBeGreaterThanOrEqual(0);
  expect(activeCol).toBeGreaterThanOrEqual(0);
  const last = scan.numFrames - 1;
  const base = last * scan.m;
  const delay = scan.metrics[base + delayCol];
  const finished = scan.metrics[base + thruCol];
  const active = scan.metrics[base + activeCol];
  return {
    scan,
    delayCol,
    thruCol,
    last,
    delay,
    finished,
    active,
    // What the live scoreboard writes into the DOM at the final frame.
    perFinisher: waitPerFinisherAt(scan.metrics, scan.m, delayCol, thruCol, last),
    // What the ten-run study would divide by: everybody who ever entered.
    perEntrant: delay / (finished + active),
  };
}

const cut = (a: number, b: number) => (1 - b / a) * 100;

const junction = {
  fixed: endOf("demo_fixed.traj"),
  responsive: endOf("demo_actuated.traj"),
};
const city = {
  fixed: endOf("metro_fixed.traj"),
  responsive: endOf("metro_actuated.traj"),
};

describe("one denominator, stated", () => {
  it("puts every figure the page shows on the per-finisher basis", () => {
    expect(CLIP_RESULT.basis).toBe(WAIT_BASIS.perFinisher);
    expect(CITY_RESULT.basis).toBe(WAIT_BASIS.perFinisher);
  });

  it("puts the multi-run study, and only it, on the stricter per-entrant basis", () => {
    expect(STUDY_RESULT.basis).toBe(WAIT_BASIS.perEntrant);
    expect(CLIP_PER_ENTRANT.basis).toBe(WAIT_BASIS.perEntrant);
    expect(CITY_PER_ENTRANT.basis).toBe(WAIT_BASIS.perEntrant);
    expect(WAIT_BASIS.perEntrant).not.toBe(WAIT_BASIS.perFinisher);
  });

  it("says which crowd it means in words a visitor can read", () => {
    for (const basis of Object.values(WAIT_BASIS)) {
      expect(basis).toMatch(/^per driver who /);
      expect(basis).not.toMatch(/throughput|delay|denominator/i);
    }
  });
});

describe("the junction pair is computed from the denominator it states", () => {
  it("divides the recorded delay by the recorded finishers, and prints that", () => {
    expect(junction.fixed.finished).toBe(CLIP_RESULT.fixedCars);
    expect(junction.responsive.finished).toBe(CLIP_RESULT.responsiveCars);
    expect(junction.fixed.perFinisher).toBeCloseTo(CLIP_RESULT.fixedWaitSeconds, 1);
    expect(junction.responsive.perFinisher).toBeCloseTo(CLIP_RESULT.responsiveWaitSeconds, 1);
    expect(Math.round(cut(junction.fixed.perFinisher, junction.responsive.perFinisher))).toBe(
      CLIP_RESULT.waitReductionPct,
    );
  });

  it("lands the live scoreboard on the same string the result card prints", () => {
    // The live rows call `waitPerFinisherAt` frame by frame; the card prints a
    // constant. At the final frame they must be the same words, or the page
    // disagrees with itself in the reader's eyeline.
    expect(formatClock(junction.fixed.perFinisher)).toBe(formatClock(CLIP_RESULT.fixedWaitSeconds));
    expect(formatClock(junction.responsive.perFinisher)).toBe(
      formatClock(CLIP_RESULT.responsiveWaitSeconds),
    );
  });

  it("computes the per-entrant note from the other denominator, off the same files", () => {
    expect(junction.fixed.perEntrant).toBeCloseTo(CLIP_PER_ENTRANT.fixedWaitSeconds, 1);
    expect(junction.responsive.perEntrant).toBeCloseTo(CLIP_PER_ENTRANT.responsiveWaitSeconds, 1);
    expect(Math.round(cut(junction.fixed.perEntrant, junction.responsive.perEntrant))).toBe(
      CLIP_PER_ENTRANT.waitReductionPct,
    );
    expect(junction.fixed.active + junction.responsive.active).toBe(
      CLIP_PER_ENTRANT.stillDrivingAtEnd,
    );
  });
});

describe("the city pair is computed from the denominator it states", () => {
  it("divides the recorded delay by the recorded finishers, and prints that", () => {
    expect(city.fixed.finished).toBe(CITY_RESULT.fixedCars);
    expect(city.responsive.finished).toBe(CITY_RESULT.responsiveCars);
    expect(city.responsive.finished - city.fixed.finished).toBe(CITY_RESULT.extraCars);
    expect(city.fixed.perFinisher).toBeCloseTo(CITY_RESULT.fixedWaitSeconds, 1);
    expect(city.responsive.perFinisher).toBeCloseTo(CITY_RESULT.responsiveWaitSeconds, 1);
    expect(Math.round(cut(city.fixed.perFinisher, city.responsive.perFinisher))).toBe(
      CITY_RESULT.waitReductionPct,
    );
  });

  it("lands the live scoreboard on the same string the result card prints", () => {
    expect(formatClock(city.fixed.perFinisher)).toBe(formatClock(CITY_RESULT.fixedWaitSeconds));
    expect(formatClock(city.responsive.perFinisher)).toBe(
      formatClock(CITY_RESULT.responsiveWaitSeconds),
    );
  });

  it("computes the per-entrant note from the other denominator, off the same files", () => {
    expect(city.fixed.perEntrant).toBeCloseTo(CITY_PER_ENTRANT.fixedWaitSeconds, 1);
    expect(city.responsive.perEntrant).toBeCloseTo(CITY_PER_ENTRANT.responsiveWaitSeconds, 1);
    expect(Math.round(cut(city.fixed.perEntrant, city.responsive.perEntrant))).toBe(
      CITY_PER_ENTRANT.waitReductionPct,
    );
    expect(city.fixed.active + city.responsive.active).toBe(CITY_PER_ENTRANT.stillDrivingAtEnd);
  });
});

describe("parts one and two no longer contradict each other", () => {
  // Part one reads a trailing 60-second window of `switch.traj` while its light
  // is still the fixed timer; part two reads the whole of `demo_fixed.traj`,
  // which is that same simulation left on the timer for all ten minutes.
  const clip = scanOf("switch.traj");
  const dt = clip.scan.dt;
  const delayCol = clip.names.indexOf("cumulative_delay");
  const thruCol = clip.names.indexOf("throughput");
  const duration = (clip.scan.numFrames - 1) * dt;
  const series = rollingWaitSeries(
    clip.scan.metrics,
    clip.scan.m,
    delayCol,
    thruCol,
    windowFrames(dt, SWITCH_RESULT.windowSeconds),
  );
  const before = regimeSpan(
    "before",
    SWITCH_CLIP.switchAtSeconds,
    SWITCH_RESULT.windowSeconds,
    duration,
  );
  const partOneFixed = meanOverSeconds(series, dt, before.from, before.to);
  const partTwoFixed = junction.fixed.perFinisher;

  it("reads the same fixed timer within a few percent, not by half again", () => {
    // Before the fix these were 233 s and 167 s — a 40% disagreement about the
    // same light, on the same page, because of the denominator. They now differ
    // only by the stretch of clip each covers, which is a handful of percent.
    const disagreement = Math.abs(partOneFixed - partTwoFixed) / Math.min(partOneFixed, partTwoFixed);
    expect(disagreement).toBeLessThan(0.1);
    expect(partOneFixed).toBeCloseTo(SWITCH_RESULT.beforeWaitSeconds, -0.5);
  });

  it("explains the remaining difference by the timer's own worsening second half", () => {
    // The whole-clip figure sits ABOVE the five-minute one because the five
    // minutes part one does not show are the timer's worse ones — which is
    // what the copy between the two sections tells the reader.
    expect(partTwoFixed).toBeGreaterThan(partOneFixed);
    expect(SWITCH_RESULT.heldFixedWaitSeconds).toBeGreaterThan(partTwoFixed);
    expect(SWITCH_RESULT.firstHalfWaitSeconds).toBeLessThan(partTwoFixed);
  });

  it("is one statistic in two spans, not two statistics", () => {
    // Same columns, same arithmetic: open the rolling window up to the whole
    // file and it lands on the whole-clip reading. The two are not bit-identical
    // because the window subtracts frame 0, which carries the delay and the
    // finishers the five-minute warm-up handed over — half a second a driver out
    // of 244, far below anything the page prints.
    const wholeFile = rollingWaitAt(
      junction.fixed.scan.metrics,
      junction.fixed.scan.m,
      junction.fixed.delayCol,
      junction.fixed.thruCol,
      junction.fixed.last,
      junction.fixed.last,
    );
    expect(Math.abs(wholeFile - partTwoFixed)).toBeLessThan(1);
    // And the residue is exactly that opening frame, nothing else.
    const baseDelay = junction.fixed.scan.metrics[junction.fixed.delayCol];
    const baseFinished = junction.fixed.scan.metrics[junction.fixed.thruCol];
    expect(baseDelay + baseFinished).toBeGreaterThan(0);
    expect(wholeFile).toBeCloseTo(
      (junction.fixed.delay - baseDelay) / (junction.fixed.finished - baseFinished),
      6,
    );
  });
});

describe("the study's figures are never dressed up as the clip's", () => {
  it("keeps the two headline percentages distinct, and the study's the lower one", () => {
    expect(CLIP_RESULT.waitReductionPct).not.toBe(STUDY_RESULT.heavyReductionPct);
    expect(CITY_RESULT.waitReductionPct).not.toBe(STUDY_RESULT.heavyReductionPct);
    expect(CITY_RESULT.waitReductionPct).not.toBe(STUDY_RESULT.rushReductionPct);
    expect(STUDY_RESULT.heavyReductionPct).toBeLessThan(CLIP_RESULT.waitReductionPct);
  });

  it("lets no per-finisher constant carry a study percentage", () => {
    // A constant may equal 19% or 35% only if it declares the study's own
    // denominator. That is what stops somebody restating the clip's flattering
    // figure as the study result, or the other way round.
    const claims = [CLIP_RESULT, CITY_RESULT, CLIP_PER_ENTRANT, CITY_PER_ENTRANT];
    const studyPcts = [STUDY_RESULT.heavyReductionPct, STUDY_RESULT.rushReductionPct];
    for (const claim of claims) {
      if (studyPcts.includes(claim.waitReductionPct)) {
        expect(claim.basis).toBe(STUDY_RESULT.basis);
      }
    }
  });

  it("shows the stricter denominator really is the stricter one, on these very files", () => {
    // Not asserted from the copy — measured. On both pairs, dividing by
    // everybody who entered gives a smaller cut than dividing by the finishers,
    // which is the whole reason the study's percentage sits below the clip's.
    expect(cut(junction.fixed.perEntrant, junction.responsive.perEntrant)).toBeLessThan(
      cut(junction.fixed.perFinisher, junction.responsive.perFinisher),
    );
    expect(cut(city.fixed.perEntrant, city.responsive.perEntrant)).toBeLessThan(
      cut(city.fixed.perFinisher, city.responsive.perFinisher),
    );
    // And that it is stricter in the literal sense: a bigger crowd.
    for (const side of [junction.fixed, junction.responsive, city.fixed, city.responsive]) {
      expect(side.finished + side.active).toBeGreaterThan(side.finished);
      expect(side.perEntrant).toBeLessThan(side.perFinisher);
    }
  });
});

describe("waitPerFinisherAt", () => {
  //                 act  delay  thru
  const metrics = [10, 0, 0, 10, 200, 0, 10, 600, 4, 10, 900, 10];
  const stride = 3;

  it("divides everything so far by the drivers who have got through so far", () => {
    expect(waitPerFinisherAt(metrics, stride, 1, 2, 2)).toBeCloseTo(150, 6);
    expect(waitPerFinisherAt(metrics, stride, 1, 2, 3)).toBeCloseTo(90, 6);
  });

  it("has no answer before anybody has finished, rather than dividing by nobody", () => {
    expect(Number.isNaN(waitPerFinisherAt(metrics, stride, 1, 2, 0))).toBe(true);
    expect(Number.isNaN(waitPerFinisherAt(metrics, stride, 1, 2, 1))).toBe(true);
  });

  it("clamps out-of-range frames and refuses missing columns", () => {
    expect(waitPerFinisherAt(metrics, stride, 1, 2, 99)).toBeCloseTo(90, 6);
    expect(waitPerFinisherAt(metrics, stride, 1, 2, -4)).toBeNaN();
    expect(waitPerFinisherAt(metrics, stride, -1, 2, 3)).toBeNaN();
    expect(waitPerFinisherAt(metrics, stride, 1, -1, 3)).toBeNaN();
    expect(waitPerFinisherAt([], stride, 1, 2, 0)).toBeNaN();
    expect(waitPerFinisherAt(metrics, 0, 1, 2, 0)).toBeNaN();
  });
});
