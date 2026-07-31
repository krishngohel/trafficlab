"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  captionIndexAt,
  CAPTIONS,
  CLIP_RESULT,
  FIXTURES,
  REPO_URL,
  SIDE_LABELS,
  STUDY_RESULT,
} from "@/lib/demo/story";
import {
  describeGap,
  formatClock,
  formatCount,
  formatElapsed,
  formatPercent,
  waitGap,
} from "@/lib/demo/format";
import { fetchWithProgress, formatBytes, loadPercent } from "@/lib/demo/load";
import { VizEngine } from "@/lib/viz/engine";
import { hasWaitColumns, meanWaitAt } from "@/lib/wait";
import IntroCard from "./IntroCard";
import Scoreboard, { emptyHandles } from "./Scoreboard";
import styles from "./Demo.module.css";

/** Ten minutes of traffic is a long watch at 1x. */
const SPEEDS = [4, 8, 16] as const;
const DEFAULT_SPEED = 8;

/** Scoreboard refresh cap (5 Hz) — the numbers move far slower than the frame rate. */
const REFRESH_MS = 200;

/** Below this the split view is cramped and touch drags must scroll the page. */
const NARROW_PX = 860;

type Stage = "scene" | "clips" | "ready" | "error";

/**
 * The public showcase. It reuses the research tool's engine unchanged: both
 * fixtures go into the same split-screen compare mode on one shared clock, and
 * every live number is written straight to the DOM from `engine.afterFrame`.
 */
export default function Demo() {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef(emptyHandles());
  const loadBar = useRef<HTMLDivElement>(null);
  const loadHint = useRef<HTMLDivElement>(null);

  const [engine, setEngine] = useState<VizEngine | null>(null);
  const [stage, setStage] = useState<Stage>("scene");
  const [failure, setFailure] = useState<string | null>(null);
  const [intro, setIntro] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);

  // --- engine + fixture loading ------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = new VizEngine(host);
    setEngine(created);
    let cancelled = false;

    const bytes = [0, 0];
    const totals = [0, 0];
    const showProgress = () => {
      // Before Content-Length is known for both files, fall back to the
      // fixtures' real on-disk size so the bar never sits at zero.
      const total = totals[0] + totals[1] || 7_600_000;
      const loaded = bytes[0] + bytes[1];
      if (loadBar.current) loadBar.current.style.width = `${loadPercent(loaded, total).toFixed(1)}%`;
      if (loadHint.current) {
        loadHint.current.textContent = `${formatBytes(loaded)} of ${formatBytes(total)}`;
      }
    };

    void (async () => {
      try {
        await created.ensureAssets();
        if (cancelled) return;
        setStage("clips");
        const [fixed, responsive] = await Promise.all([
          fetchWithProgress(FIXTURES.fixed, (l, t) => {
            bytes[0] = l;
            totals[0] = t;
            showProgress();
          }),
          fetchWithProgress(FIXTURES.responsive, (l, t) => {
            bytes[1] = l;
            totals[1] = t;
            showProgress();
          }),
        ]);
        if (cancelled) return;
        created.loadPrimary(fixed, SIDE_LABELS.fixed);
        created.loadCompare(responsive, SIDE_LABELS.responsive);
        created.setSpeed(DEFAULT_SPEED);
        created.setPlaying(true);
        frameStage(created);
        setStage("ready");
      } catch (err) {
        if (cancelled) return;
        setFailure(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    })();

    return () => {
      cancelled = true;
      created.dispose();
      setEngine(null);
    };
  }, []);

  // --- live readout (no React renders while playing) ------------------------------
  useEffect(() => {
    if (!engine || stage !== "ready") return;
    let last = 0;
    let captionIndex = -1;

    const write = (el: HTMLElement | null, text: string) => {
      if (el && el.textContent !== text) el.textContent = text;
    };

    const sync = () => {
      const now = performance.now();
      if (now - last < REFRESH_MS) return;
      last = now;

      const h = live.current;
      const clock = engine.clock;
      const views = [engine.getView(0), engine.getView(1)];
      const wait: [number, number] = [NaN, NaN];

      for (let side = 0; side < 2; side++) {
        const view = views[side];
        if (!view) continue;
        if (hasWaitColumns(view.waitCols)) {
          wait[side] = meanWaitAt(
            view.scan.metrics,
            view.scan.m,
            view.waitCols,
            view.frameIndexAt(clock),
          );
        }
        write(h.wait[side], formatClock(wait[side]));
        write(h.cars[side], formatCount(view.metricAt(clock, view.throughputCol)));
      }

      const gap = waitGap(wait[0], wait[1]);
      write(h.gapValue, formatPercent(gap.pct));
      if (h.gapValue && h.gapValue.dataset.lead !== gap.leader) h.gapValue.dataset.lead = gap.leader;
      write(h.gapNote, describeGap(gap));

      const index = captionIndexAt(clock.time);
      if (index !== captionIndex) {
        captionIndex = index;
        write(h.caption, CAPTIONS[index].text);
      }

      write(h.elapsed, formatElapsed(clock.time, clock.duration));
      if (h.trackFill) {
        h.trackFill.style.width = `${loadPercent(clock.time, clock.duration).toFixed(2)}%`;
      }
    };

    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine, stage]);

  // --- controls -------------------------------------------------------------------
  const togglePlay = useCallback(() => {
    if (!engine) return;
    const next = !engine.clock.playing;
    engine.setPlaying(next);
    setPlaying(next);
  }, [engine]);

  const restart = useCallback(() => {
    if (!engine) return;
    engine.seek(0);
    engine.setPlaying(true);
    setPlaying(true);
  }, [engine]);

  const changeSpeed = useCallback(
    (value: number) => {
      setSpeed(value);
      engine?.setSpeed(value);
    },
    [engine],
  );

  const dismissIntro = useCallback(() => {
    setIntro(false);
    engine?.seek(0);
  }, [engine]);

  // --- element plumbing ---------------------------------------------------------------
  const waitRefA = useCallback((el: HTMLSpanElement | null) => {
    live.current.wait[0] = el;
  }, []);
  const waitRefB = useCallback((el: HTMLSpanElement | null) => {
    live.current.wait[1] = el;
  }, []);
  const carsRefA = useCallback((el: HTMLElement | null) => {
    live.current.cars[0] = el;
  }, []);
  const carsRefB = useCallback((el: HTMLElement | null) => {
    live.current.cars[1] = el;
  }, []);
  const gapValueRef = useCallback((el: HTMLSpanElement | null) => {
    live.current.gapValue = el;
  }, []);
  const gapNoteRef = useCallback((el: HTMLSpanElement | null) => {
    live.current.gapNote = el;
  }, []);
  const captionRef = useCallback((el: HTMLParagraphElement | null) => {
    live.current.caption = el;
  }, []);
  const elapsedRef = useCallback((el: HTMLSpanElement | null) => {
    live.current.elapsed = el;
  }, []);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    live.current.trackFill = el;
  }, []);

  const ready = stage === "ready";

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <span className={styles.mark}>trafficlab</span>
          <nav className={styles.topLinks}>
            <Link href="/">Open the research tool</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
          </nav>
        </header>

        <div className={styles.head}>
          <h1 className={styles.title}>
            One junction. Two traffic lights. The same ten minutes.
          </h1>
          <p className={styles.lede}>
            Both sides below get identical traffic: the same cars, arriving at the same second. On
            the left the light runs to a fixed schedule. On the right it senses the cars waiting and
            changes when they need it to. Everything else is the same.
          </p>
        </div>

        <Scoreboard
          fixedName={SIDE_LABELS.fixed}
          responsiveName={SIDE_LABELS.responsive}
          waitRefA={waitRefA}
          carsRefA={carsRefA}
          waitRefB={waitRefB}
          carsRefB={carsRefB}
          gapValueRef={gapValueRef}
          gapNoteRef={gapNoteRef}
        />

        <div className={styles.stage}>
          <div ref={hostRef} className={styles.canvasHost} />
          <div className={styles.touchGuard} />
          {ready && (
            <>
              <span className={`${styles.sideTag} ${styles.sideTagLeft}`}>
                <span className={styles.dot} />
                {SIDE_LABELS.fixed}
              </span>
              <span className={`${styles.sideTag} ${styles.sideTagRight}`}>
                <span className={styles.dot} />
                {SIDE_LABELS.responsive}
              </span>
            </>
          )}
          {!ready && (
            <div className={styles.loading}>
              {stage === "error" ? (
                <p className={styles.failure}>
                  The simulations could not be loaded ({failure}). Try reloading the page.
                </p>
              ) : (
                <>
                  <div className={styles.loadingLabel}>
                    {stage === "scene" ? "Building the street…" : "Loading the two simulations…"}
                  </div>
                  <div className={styles.loadingBar}>
                    <div ref={loadBar} className={styles.loadingFill} />
                  </div>
                  <div ref={loadHint} className={styles.loadingHint} />
                </>
              )}
            </div>
          )}
        </div>

        <p ref={captionRef} className={styles.caption}>
          {CAPTIONS[0].text}
        </p>

        <div className={styles.controls}>
          <button className={`${styles.btn} ${styles.btnPlay}`} onClick={togglePlay} disabled={!ready}>
            {playing ? "Pause" : "Play"}
          </button>
          <button className={styles.btn} onClick={restart} disabled={!ready}>
            Start over
          </button>
          <div className={styles.speedGroup}>
            <span className={styles.speedLabel}>Speed</span>
            <div className={styles.speedPills}>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`${styles.pill} ${s === speed ? styles.pillOn : ""}`}
                  onClick={() => changeSpeed(s)}
                  disabled={!ready}
                  aria-pressed={s === speed}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <span ref={elapsedRef} className={styles.elapsed}>
            0:00 of 10:00
          </span>
          <div className={styles.track}>
            <div ref={trackRef} className={styles.trackFill} />
          </div>
        </div>

        <section className={styles.results}>
          <div className={styles.resultCard}>
            <div className={styles.resultKicker}>The clip above</div>
            <div className={styles.resultBig}>{CLIP_RESULT.waitReductionPct}% less waiting</div>
            <p className={styles.resultBody}>
              Average wait per driver fell from {formatClock(CLIP_RESULT.fixedWaitSeconds)} to{" "}
              {formatClock(CLIP_RESULT.responsiveWaitSeconds)} across these{" "}
              {CLIP_RESULT.minutes} minutes, while {CLIP_RESULT.responsiveCars} cars got through the
              junction instead of {CLIP_RESULT.fixedCars}. More traffic, less waiting.
            </p>
          </div>
          <div className={styles.resultCard}>
            <div className={styles.resultKicker}>
              The rigorous figure · {STUDY_RESULT.runsPerSide} full one-hour runs per light
            </div>
            <div className={styles.resultBig}>
              {STUDY_RESULT.heavyReductionPct}% and {STUDY_RESULT.rushReductionPct}% less waiting
            </div>
            <p className={styles.resultBody}>
              A single ten-minute clip is a demonstration, not evidence. Measured properly, over{" "}
              {STUDY_RESULT.runsPerSide} separate one-hour runs for each light: {STUDY_RESULT.heavyReductionPct}%
              less waiting under heavy traffic and {STUDY_RESULT.rushReductionPct}% under rush-hour
              traffic.
            </p>
          </div>
        </section>

        <p className={styles.smallprint}>
          The responsive light is not artificial intelligence and there is no machine learning in
          it. It is a piece of classical engineering that has been in the ground for decades: a
          detector at the stop line, and a rule about when to let the green run on. This project
          also built controllers that learn from experience, and they did not beat it. Everything
          you see is a simulation — real junctions bring pedestrians, buses, breakdowns and weather
          that this model does not.
        </p>

        <footer className={styles.footer}>
          <Link href="/">Open the full research tool</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </footer>
      </div>

      {intro && <IntroCard onDismiss={dismissIntro} />}
    </div>
  );
}

/**
 * Frame the junction so it fills the stage. Narrow screens get a viewport half
 * as wide per side, so the camera pulls back to keep the whole junction in it.
 */
function frameStage(engine: VizEngine): void {
  const view = engine.getView(0);
  if (!view) return;
  const b = view.bounds;
  const narrow = typeof window !== "undefined" && window.innerWidth < NARROW_PX;
  // Each side of the split is roughly half as wide as the stage, so the view
  // has to be framed on its height: this puts the whole of every approach road
  // in shot without shrinking the cars to specks.
  const d = Math.max(b.extent, 60) * (narrow ? 0.78 : 0.5);
  engine.setCameraPose(
    { x: b.centerX, z: -b.centerY },
    { x: b.centerX + d * 0.26, y: d * 0.85, z: -b.centerY + d * 0.45 },
  );
}
