/**
 * The words and the measured numbers behind the public demo page.
 *
 * Every figure here was measured — see `results/` in the repo root. Nothing on
 * the demo page invents a statistic, and the captions describe only how the two
 * lights work and what the clip contains, never a moment-by-moment reading the
 * page cannot actually compute.
 */

/** Public source link shown in the header and footer. */
export const REPO_URL = "https://github.com/krishngohel/trafficlab";

/**
 * Prefix for runtime asset URLs. Next rewrites `next/link` hrefs and bundled
 * imports for `basePath`, but NOT `fetch()` calls, so anything requested at
 * runtime has to carry the prefix itself. Empty for root-hosted builds.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Where the fixtures live under `public/`. */
export const FIXTURES = {
  /** The leading clip: ONE junction that changes light halfway through. */
  switch: `${BASE_PATH}/fixtures/switch.traj`,
  fixed: `${BASE_PATH}/fixtures/demo_fixed.traj`,
  responsive: `${BASE_PATH}/fixtures/demo_actuated.traj`,
  /** The city-scale pair. 35 MB together, fetched only when asked for. */
  cityFixed: `${BASE_PATH}/fixtures/metro_fixed.traj`,
  cityResponsive: `${BASE_PATH}/fixtures/metro_actuated.traj`,
} as const;

export const SIDE_LABELS = {
  fixed: "Fixed timer",
  responsive: "Responsive signal",
} as const;

/**
 * The recording the page now opens on: `public/fixtures/switch.traj`.
 *
 * ONE junction, ONE continuous ten-minute run, heavy traffic throughout, seed 0,
 * recorded after a five-minute warm-up so it opens on a junction already
 * carrying traffic. The light runs a fixed timer for the first five minutes;
 * at exactly 5:00 a responsive controller takes the same junction over
 * mid-flow, with the same drivers still arriving. Reproduce with
 *
 *   python scripts/simulate.py --network single --demand heavy \
 *     --controller fixed --switch-at 300 --switch-to actuated \
 *     --warmup 300 --duration 600 --seed 0 --out viz/public/fixtures/switch.traj
 *
 * This clip exists because a page about reducing waiting had nothing on it that
 * ever went down. A side-by-side of two runs is the stronger experiment, but it
 * asks a visitor to subtract one number from another; a single junction whose
 * waiting visibly falls when the light changes does not.
 *
 * The first five minutes of this file are not merely similar to
 * `demo_fixed.traj`, they are the same simulation: same network, same demand,
 * same seed, and identical metrics frame for frame up to the handover. A test
 * pins that, which is what licenses the counterfactual quoted below.
 */
export const SWITCH_CLIP = {
  minutes: 10,
  /** Seconds into the clip at which the responsive controller takes over. */
  switchAtSeconds: 300,
  /** On-disk size of the recording, bytes — the loading bar's fallback total. */
  bytes: 5_175_961,
  seed: 0,
} as const;

/**
 * What the leading clip measures, all of it read off `switch.traj` itself.
 *
 * The live reading is a trailing 60-second window: the waiting the junction
 * generated in that minute divided by the drivers who cleared it in that same
 * minute (see `lib/demo/rolling.ts` for why that is the one statistic here that
 * can fall). It is noisy by construction — a minute is roughly 35 finishing
 * drivers — so the page quotes averages over many windows and says so, and no
 * single window is ever presented as the result.
 *
 * WINDOW FAMILY. Averaged over every 60-second window lying entirely inside one
 * regime (windows ending 60 s–300 s for the timer, 360 s–600 s for the
 * responsive signal, so no window straddles the handover):
 *   before  232.85 s, ranging 187.4 – 289.0
 *   after   203.91 s, ranging 178.1 – 260.7
 * a fall of 12.4%. The ranges overlap: this is a noisy measure of a real step,
 * not a clean separation, and the page says so rather than cropping the chart.
 *
 * COUNTERFACTUAL FAMILY — the rigorous claim in this section. Because
 * `demo_fixed.traj` is the same run left on the timer, the second five minutes
 * can be compared directly, same arrivals against same arrivals. Over
 * 300 s–600 s: the responsive signal generated 42413 driver-seconds of delay and
 * cleared 207 drivers, 204.9 s each; the timer generated 44313 and cleared 171,
 * 259.1 s each. 20.9% less waiting and 21.1% more drivers through.
 *
 * That the second figure is the larger one is not an inconsistency, it is the
 * finding: left alone, this junction was getting WORSE over the second five
 * minutes (230.7 s in the first half, 259.1 s in the second), and the responsive
 * rule did not merely stop that, it pulled the wait below where it started.
 *
 * Cars cleared per 60-second window: 35.3 on average before (30–40), 41.8 after
 * (33–47).
 *
 * "Stays down" is a claim, so it is measured too: 95.4% of the windows after
 * the handover sit below the fixed timer's average, and the only excursions
 * above it are the settling minute right after the change (360–366 s) and one
 * five-second wobble at 562–566 s.
 */
export const SWITCH_RESULT = {
  /** Length of the trailing window the live reading and the chart both use. */
  windowSeconds: 60,
  beforeWaitSeconds: 233,
  beforeLowSeconds: 187,
  beforeHighSeconds: 289,
  afterWaitSeconds: 204,
  afterLowSeconds: 178,
  afterHighSeconds: 261,
  windowFallPct: 12,
  /** Share of post-handover windows sitting below the timer's own average. */
  belowBeforeAveragePct: 95,
  /** Second five minutes, responsive: per driver cleared, and how many. */
  secondHalfWaitSeconds: 205,
  secondHalfCars: 207,
  /** The same five minutes of the same run left on the timer. */
  heldFixedWaitSeconds: 259,
  heldFixedCars: 171,
  heldFixedFallPct: 21,
  heldFixedMoreCarsPct: 21,
  /** First five minutes, under the timer, as one block. */
  firstHalfWaitSeconds: 231,
  firstHalfCars: 176,
  carsPerMinuteBefore: 35,
  carsPerMinuteAfter: 42,
} as const;

/**
 * Headline results for the ten-minute clip on screen.
 *
 * The clip opens on a junction that is ALREADY carrying traffic (the simulation
 * is warmed up for five minutes before recording starts — see
 * `scripts/simulate.py --warmup`). That matters for honesty as much as for
 * looks: starting from an empty network, a fixed timer looks good for the first
 * several minutes simply because there is no queue yet for a smarter light to
 * do anything about, and a visitor watching only the opening would draw the
 * opposite conclusion to the one the data supports.
 */
export const CLIP_RESULT = {
  minutes: 10,
  fixedWaitSeconds: 167,
  responsiveWaitSeconds: 135,
  waitReductionPct: 19,
  fixedCars: 348,
  responsiveCars: 418,
} as const;

/**
 * What the same clip is worth in the unit the page now leads with: waiting that
 * did not happen.
 *
 * Read straight off the last frame of the two recordings the browser plays, so
 * the live counter and this figure are the same arithmetic on the same bytes
 * and land on the same number at the end of the clip — no reconciliation
 * needed. `cumulative_delay` at frame 1199 of `demo_fixed.traj` is 84970.6
 * driver-seconds and of `demo_actuated.traj` is 77216.2, a difference of 7754.4
 * — a little over two hours of collective standing still, removed from ten
 * minutes at one junction. Each figure below is its own value rounded to the
 * second and the three agree with each other, so a reader who subtracts the two
 * totals gets the saving the page prints; a test holds them to that.
 *
 * `fasterPct` is the whole-clip mean of `mean_speed`: 1.14 m/s under the fixed
 * timer against 1.47 m/s under the responsive signal. The live reading on the
 * page is a trailing 60-second mean of the same series, so it moves around this
 * figure rather than sitting on it.
 */
export const CLIP_SAVED = {
  fixedDelaySeconds: 84971,
  responsiveDelaySeconds: 77216,
  savedSeconds: 7755,
  fixedSpeedMps: 1.14,
  responsiveSpeedMps: 1.47,
  fasterPct: 29,
} as const;

/**
 * The city-scale pair, `public/fixtures/metro_{fixed,actuated}.traj`.
 *
 * Same network, same demand, same seed (3), same five recorded minutes after
 * the same five-minute warm-up — the single-junction comparison repeated at a
 * hundred signalised crossings at once. Shape facts are read off the files:
 * 100 entries in `intersections_order`, 600 frames at dt 0.5 s, 18.0 MB and
 * 16.1 MB on disk.
 */
export const METRO = {
  intersections: 100,
  minutes: 5,
  /** Download size of both files together, MiB. */
  megabytes: 33,
  /** Grid spacing in metres, from `configs/networks/metro.json`. */
  spacingMeters: 220,
} as const;

/**
 * What the two city runs cost their drivers. Measured, and reproducible with
 *
 *   python scripts/simulate.py --network metro --demand metro \
 *     --controller {fixed,actuated} --duration 300 --seed 3 --warmup 300
 *
 * which prints, for fixed: 1981 spawned, delay 202652 veh·s, 1154 still on the
 * map at the end; for actuated: 1912 spawned, delay 163129 veh·s, 983 still on
 * the map. So `waitSeconds` is total delay over EVERY driver the run created
 * (202652/1981 = 102.3, 163129/1912 = 85.3) and `carsCleared` is every driver
 * who finished (1981-1154 = 827, 1912-983 = 929).
 *
 * IMPORTANT — the live counter on the page is not computing this number. A
 * .traj file records how many drivers are on the map and how many finished at
 * the roadside, but not how many finished by parking off-street, so the
 * browser divides the same total delay by a smaller count and reads a little
 * high (1m 55s against 1m 37s at the end of the clip, a 16% gap rather than
 * this 17% one). The page says so rather than hiding it.
 */
export const CITY_RESULT = {
  minutes: 5,
  fixedWaitSeconds: 102,
  responsiveWaitSeconds: 85,
  waitReductionPct: 17,
  fixedCars: 827,
  responsiveCars: 929,
  extraCars: 102,
} as const;

/**
 * The city pair in the same saved-waiting unit, read off the last frame of the
 * two recordings exactly as `CLIP_SAVED` is.
 *
 * `cumulative_delay` at frame 599 is 202651.5 driver-seconds under fixed timers
 * and 163128.6 under the responsive ones, a difference of 39522.9 — very nearly
 * eleven hours of collective waiting, out of five minutes across a hundred
 * junctions. These are the same totals the `simulate.py` runs quoted in
 * `CITY_RESULT` print (202652 and 163129), so unlike the average-wait figures
 * there is nothing to reconcile: the browser's live counter converges on this
 * exact number because it is reading the exact same series.
 *
 * `fasterPct` is the whole-clip mean of `mean_speed`, 4.82 m/s against 5.64.
 */
export const CITY_SAVED = {
  fixedDelaySeconds: 202652,
  responsiveDelaySeconds: 163129,
  savedSeconds: 39523,
  fixedSpeedMps: 4.82,
  responsiveSpeedMps: 5.64,
  fasterPct: 17,
} as const;

/** The rigorous figures: ten full one-hour runs per light. */
export const STUDY_RESULT = {
  runsPerSide: 10,
  hoursPerRun: 1,
  heavyReductionPct: 19,
  rushReductionPct: 35,
} as const;

export interface Caption {
  /** Seconds into the clip at which this line takes over. */
  from: number;
  text: string;
}

/**
 * Commentary for the leading clip, keyed to its own timeline. The handover is
 * at 300 s, so the line that lands there is a fact about the file rather than a
 * live inference — and the two lines after it exist to stop a visitor reading a
 * verdict into the first noisy minute following the change.
 */
export const SWITCH_CAPTIONS: readonly Caption[] = [
  {
    from: 0,
    text: "One junction, ten minutes, heavy traffic the whole way through. Right now the light is on a fixed timer: each direction gets its turn for a set length of time, whether or not anybody is there to use it.",
  },
  {
    from: 110,
    text: "The big number is the waiting this junction generated over the last minute, shared out between the drivers who actually got through it in that minute. It needs a full minute of clip before it will say anything, and it jumps around — the trend is the reading, not the last digit.",
  },
  {
    from: 215,
    text: "Queues are building on both roads. A fixed timer cannot do anything about that: every second of green it hands to an empty lane is a second the queue on the other road keeps growing.",
  },
  {
    from: 300,
    text: "The light has just changed hands. Same junction, same recording, same drivers still arriving on the same seconds — from here the signal senses the traffic waiting, holds a green while cars are still coming, and ends it early once the road is clear.",
  },
  {
    from: 362,
    text: "Give it a minute. The first window after the handover still carries the queue the timer left behind, so it reads high; what happens after that is the thing worth watching.",
  },
  {
    from: 430,
    text: "Below the fixed timer's average and staying there: 95% of the windows after the handover sit under it, and the two that do not are the settling minute and one brief wobble. More cars are finishing each minute as well, so this is not waiting traded away for throughput.",
  },
  {
    from: 540,
    text: "Nothing about the traffic changed at the five-minute mark. The demand, the routes and the drivers are identical either side of it. The only thing that changed is the rule the light follows.",
  },
] as const;

/**
 * Rotating explanation of what is on screen, keyed to the clip's own timeline
 * (a fact about the file, not a live inference). Plain words only.
 */
export const CAPTIONS: readonly Caption[] = [
  {
    from: 0,
    text: "Same junction, same drivers, arriving at exactly the same moments on both sides. The only thing that differs is how the light decides.",
  },
  {
    from: 90,
    text: "On the left, the light runs to a fixed schedule. Each direction gets its turn for a set time, whether or not anyone is there to use it.",
  },
  {
    from: 210,
    text: "On the right, the light senses the traffic waiting. It keeps a green going while cars are still coming, and ends it early once the road is clear.",
  },
  {
    from: 340,
    text: "Traffic is heavy now. Every second of green handed to an empty lane is a second the queue on the other road keeps growing.",
  },
  {
    from: 480,
    text: "By this point the responsive light has put more cars through the junction, and the waiting it has spared those drivers is already well over an hour of collective time.",
  },
] as const;

/** The caption that applies `seconds` into the clip. */
export function captionIndexAt(seconds: number, lines: readonly Caption[] = CAPTIONS): number {
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    if (seconds >= lines[i].from) index = i;
  }
  return index;
}

/** The caption text that applies `seconds` into the clip. */
export function captionAt(seconds: number, lines: readonly Caption[] = CAPTIONS): string {
  return lines[captionIndexAt(seconds, lines)].text;
}
