"use client";

import { useCallback, type MutableRefObject, type ReactNode } from "react";

import { SIDE_LABELS } from "@/lib/demo/story";
import styles from "./Demo.module.css";

/**
 * Every element the live sync loop writes into. The demo page updates these
 * straight from the engine's `afterFrame` hook — exactly like WaitHud does in
 * the research tool — so playing at 8x never triggers a React render.
 */
export interface LiveHandles {
  /** The hero panel — carries `data-lead`, so the whole panel takes the colour. */
  heroBox: HTMLElement | null;
  /** The big saved-waiting counter, e.g. "2h 09m". */
  savedValue: HTMLElement | null;
  /** The sentence under it, which continues the number grammatically. */
  savedLine: HTMLElement | null;
  /** The supporting "31% faster" reading off mean speed. */
  fasterValue: HTMLElement | null;
  fasterLine: HTMLElement | null;
  /** Running-average wait readout, [fixed, responsive]. Deliberately small. */
  wait: [HTMLSpanElement | null, HTMLSpanElement | null];
  /** Cars-through readout, [fixed, responsive]. */
  cars: [HTMLElement | null, HTMLElement | null];
  /** Comparison bar fill, [fixed, responsive]. Width is the whole point. */
  bar: [HTMLDivElement | null, HTMLDivElement | null];
  /** "Faster" pill on each row; shown only on the side that is ahead. */
  pill: [HTMLElement | null, HTMLElement | null];
  /** "Faster" flag on each label over the 3D stage. */
  stageFlag: [HTMLElement | null, HTMLElement | null];
  /** One live line summarising the two settling averages. */
  gapLine: HTMLElement | null;
  caption: HTMLParagraphElement | null;
  elapsed: HTMLSpanElement | null;
  trackFill: HTMLDivElement | null;
}

export function emptyHandles(): LiveHandles {
  return {
    heroBox: null,
    savedValue: null,
    savedLine: null,
    fasterValue: null,
    fasterLine: null,
    wait: [null, null],
    cars: [null, null],
    bar: [null, null],
    pill: [null, null],
    stageFlag: [null, null],
    gapLine: null,
    caption: null,
    elapsed: null,
    trackFill: null,
  };
}

/**
 * One light's row: who it is, how long its drivers have waited on average drawn
 * as a bar, and the two numbers behind the bar.
 *
 * These are running averages since the clip started, so they climb towards a
 * settled value rather than falling — which is exactly why they are no longer
 * the headline, and why the unit under each one says so out loud. Two of these
 * stacked is still the side-by-side comparison: a visitor reads which bar is
 * shorter without reading a digit.
 */
function Row({
  name,
  where,
  tone,
  side,
  carsUnit,
  handles,
}: {
  name: string;
  where: string;
  tone: "fixed" | "responsive";
  side: 0 | 1;
  carsUnit: string;
  handles: MutableRefObject<LiveHandles>;
}) {
  const barRef = useCallback(
    (el: HTMLDivElement | null) => {
      handles.current.bar[side] = el;
    },
    [handles, side],
  );
  const waitRef = useCallback(
    (el: HTMLSpanElement | null) => {
      handles.current.wait[side] = el;
    },
    [handles, side],
  );
  const carsRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.cars[side] = el;
    },
    [handles, side],
  );
  const pillRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.pill[side] = el;
    },
    [handles, side],
  );

  return (
    <div className={`${styles.row} ${tone === "fixed" ? styles.rowFixed : styles.rowResponsive}`}>
      <div className={styles.rowWho}>
        <span className={styles.rowName}>
          <span className={styles.dot} />
          {name}
        </span>
        <span className={styles.rowWhere}>{where}</span>
      </div>

      <div className={styles.barTrack}>
        <div ref={barRef} className={styles.barFill} />
      </div>

      <div className={styles.rowWait}>
        <span ref={waitRef} className={styles.rowWaitValue}>
          –
        </span>
        <span ref={pillRef} className={styles.fasterPill} hidden>
          Faster
        </span>
        <span className={styles.rowWaitUnit}>
          average wait per driver <b>so far</b> (a running average — it settles as the clip runs)
        </span>
      </div>

      <div className={styles.rowCars}>
        <b ref={carsRef}>–</b>
        <span className={styles.rowCarsUnit}>{carsUnit}</span>
      </div>
    </div>
  );
}

/**
 * The focal point of the page.
 *
 * The hero is waiting that did not happen: the gap between the two runs'
 * accumulated delay, in driver-minutes and hours. It climbs, and climbing is
 * the point — it is a benefit adding up, and the words around it say so. Beside
 * it sits a reading that genuinely moves both ways, how much faster the traffic
 * is flowing on the responsive side over the last minute. Underneath, smaller,
 * the two settling averages and their bars.
 *
 * Nothing here holds state: the caller owns the elements and writes them from
 * the render loop. Both comparisons on the page use this component — the one
 * junction and the hundred — so a visitor who has learnt to read it once has
 * learnt to read it twice.
 */
export default function Scoreboard({
  handles,
  carsUnit = "cars through so far",
  foot,
}: {
  handles: MutableRefObject<LiveHandles>;
  carsUnit?: string;
  foot: ReactNode;
}) {
  const boxRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.heroBox = el;
    },
    [handles],
  );
  const savedValueRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.savedValue = el;
    },
    [handles],
  );
  const savedLineRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.savedLine = el;
    },
    [handles],
  );
  const fasterValueRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.fasterValue = el;
    },
    [handles],
  );
  const fasterLineRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.fasterLine = el;
    },
    [handles],
  );
  const gapLineRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.gapLine = el;
    },
    [handles],
  );

  return (
    <section className={styles.scoreboard} aria-label="How much waiting has been saved so far">
      <div ref={boxRef} className={styles.hero} data-lead="unknown">
        <div className={styles.heroMain}>
          <span className={styles.heroKicker}>Driver waiting saved so far</span>
          <strong ref={savedValueRef} className={styles.heroValue}>
            –
          </strong>
          <span ref={savedLineRef} className={styles.heroLine}>
            The count starts the moment traffic reaches both junctions.
          </span>
        </div>

        <div className={styles.heroAside}>
          <span className={styles.heroKicker}>And right now</span>
          <b ref={fasterValueRef} className={styles.heroAsideValue}>
            –
          </b>
          <span ref={fasterLineRef} className={styles.heroAsideLine}>
            Measuring how fast the traffic is moving on each side.
          </span>
        </div>
      </div>

      <div className={styles.rows}>
        <Row
          name={SIDE_LABELS.fixed}
          where="Left side"
          tone="fixed"
          side={0}
          carsUnit={carsUnit}
          handles={handles}
        />
        <Row
          name={SIDE_LABELS.responsive}
          where="Right side"
          tone="responsive"
          side={1}
          carsUnit={carsUnit}
          handles={handles}
        />
      </div>

      <p className={styles.rowFoot}>
        <b ref={gapLineRef} className={styles.gapLine}>
          Waiting for the first cars
        </b>
        {foot}
      </p>
    </section>
  );
}
