"use client";

import type { RefCallback } from "react";

import { CLIP_RESULT } from "@/lib/demo/story";
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
  gapValue: HTMLSpanElement | null;
  gapNote: HTMLSpanElement | null;
  caption: HTMLParagraphElement | null;
  elapsed: HTMLSpanElement | null;
  trackFill: HTMLDivElement | null;
}

export function emptyHandles(): LiveHandles {
  return {
    wait: [null, null],
    cars: [null, null],
    gapValue: null,
    gapNote: null,
    caption: null,
    elapsed: null,
    trackFill: null,
  };
}

function SideCard({
  name,
  tone,
  waitRef,
  carsRef,
}: {
  name: string;
  tone: "fixed" | "responsive";
  waitRef: RefCallback<HTMLSpanElement>;
  carsRef: RefCallback<HTMLElement>;
}) {
  return (
    <div className={`${styles.card} ${tone === "fixed" ? styles.cardFixed : styles.cardResponsive}`}>
      <span className={styles.cardLabel}>
        <span className={styles.dot} />
        {name}
      </span>
      <span ref={waitRef} className={styles.cardValue}>
        –
      </span>
      <span className={styles.cardUnit}>average wait per driver, so far</span>
      <span className={styles.cardSecond}>
        <b ref={carsRef}>–</b> cars through the junction
      </span>
    </div>
  );
}

/**
 * The focal point of the page: what each light has cost its drivers so far, and
 * the gap between them right now. Nothing here holds state — the caller owns
 * the elements and writes their text from the render loop.
 */
export default function Scoreboard({
  fixedName,
  responsiveName,
  waitRefA,
  carsRefA,
  waitRefB,
  carsRefB,
  gapValueRef,
  gapNoteRef,
}: {
  fixedName: string;
  responsiveName: string;
  waitRefA: RefCallback<HTMLSpanElement>;
  carsRefA: RefCallback<HTMLElement>;
  waitRefB: RefCallback<HTMLSpanElement>;
  carsRefB: RefCallback<HTMLElement>;
  gapValueRef: RefCallback<HTMLSpanElement>;
  gapNoteRef: RefCallback<HTMLSpanElement>;
}) {
  return (
    <>
      <section className={styles.scoreboard} aria-label="Live comparison">
        <SideCard name={fixedName} tone="fixed" waitRef={waitRefA} carsRef={carsRefA} />
        <div className={styles.gapCard}>
          <span className={styles.gapLabel}>Difference right now</span>
          <span ref={gapValueRef} className={styles.gapValue}>
            –
          </span>
          <span ref={gapNoteRef} className={styles.gapNote}>
            Waiting for the first cars
          </span>
          <span className={styles.gapOutcome}>
            By the end of the clip:
            <br />
            responsive signal, {CLIP_RESULT.waitReductionPct}% less waiting
          </span>
        </div>
        <SideCard name={responsiveName} tone="responsive" waitRef={waitRefB} carsRef={carsRefB} />
      </section>
      <p className={styles.scoreFoot}>
        Both figures are running averages over everything that has happened since the clip started,
        so the two sides begin close together and pull apart as the queues build.
      </p>
    </>
  );
}
