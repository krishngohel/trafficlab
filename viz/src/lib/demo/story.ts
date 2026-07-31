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

/** Where the two fixtures live under `public/`. */
export const FIXTURES = {
  fixed: `${BASE_PATH}/fixtures/demo_fixed.traj`,
  responsive: `${BASE_PATH}/fixtures/demo_actuated.traj`,
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
    text: "By this point the responsive light has put more cars through the junction, and the average wait is tipping its way.",
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
