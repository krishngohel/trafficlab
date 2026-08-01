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
export function captionIndexAt(seconds: number): number {
  let index = 0;
  for (let i = 0; i < CAPTIONS.length; i++) {
    if (seconds >= CAPTIONS[i].from) index = i;
  }
  return index;
}

/** The caption text that applies `seconds` into the clip. */
export function captionAt(seconds: number): string {
  return CAPTIONS[captionIndexAt(seconds)].text;
}
