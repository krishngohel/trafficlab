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
  /** Mean wait readout, [fixed, responsive]. */
  wait: [HTMLSpanElement | null, HTMLSpanElement | null];
  /** Cars-through readout, [fixed, responsive]. */
  cars: [HTMLElement | null, HTMLElement | null];
  /** Comparison bar fill, [fixed, responsive]. Width is the whole point. */
  bar: [HTMLDivElement | null, HTMLDivElement | null];
  /** "Faster" pill on each row; shown only on the side that is ahead. */
  pill: [HTMLElement | null, HTMLElement | null];
  /** "Faster" flag on each label over the 3D stage. */
  stageFlag: [HTMLElement | null, HTMLElement | null];
  /** The banner box — carries `data-lead` so the whole panel takes the colour. */
  verdictBox: HTMLElement | null;
  verdictHead: HTMLElement | null;
  verdictDetail: HTMLElement | null;
  caption: HTMLParagraphElement | null;
  elapsed: HTMLSpanElement | null;
  trackFill: HTMLDivElement | null;
}

export function emptyHandles(): LiveHandles {
  return {
    wait: [null, null],
    cars: [null, null],
    bar: [null, null],
    pill: [null, null],
    stageFlag: [null, null],
    verdictBox: null,
    verdictHead: null,
    verdictDetail: null,
    caption: null,
    elapsed: null,
    trackFill: null,
  };
}

/**
 * One light's row: who it is, how long its drivers have waited drawn as a bar,
 * and the two numbers behind the bar. Two of these stacked is the comparison —
 * a visitor reads which bar is shorter without reading a single digit.
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
        <span className={styles.rowWaitUnit}>average wait per driver</span>
      </div>

      <div className={styles.rowCars}>
        <b ref={carsRef}>–</b>
        <span className={styles.rowCarsUnit}>{carsUnit}</span>
      </div>
    </div>
  );
}

/**
 * The focal point of the page: a one-line verdict on which light is currently
 * ahead, and two bars whose lengths say the same thing without words. Nothing
 * here holds state — the caller owns the elements and writes them from the
 * render loop.
 *
 * Both comparisons on the page use this, the one junction and the hundred, so
 * a visitor who has learnt to read it once has learnt to read it twice.
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
      handles.current.verdictBox = el;
    },
    [handles],
  );
  const headRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.verdictHead = el;
    },
    [handles],
  );
  const detailRef = useCallback(
    (el: HTMLElement | null) => {
      handles.current.verdictDetail = el;
    },
    [handles],
  );

  return (
    <section className={styles.scoreboard} aria-label="Which light is faster right now">
      <div ref={boxRef} className={styles.verdict} data-lead="unknown">
        <span className={styles.verdictKicker}>Right now</span>
        <strong ref={headRef} className={styles.verdictHead}>
          Waiting for the first cars
        </strong>
        <span ref={detailRef} className={styles.verdictDetail}>
          The comparison starts the moment traffic reaches the junction.
        </span>
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

      <p className={styles.rowFoot}>{foot}</p>
    </section>
  );
}
