"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  CAPTIONS,
  CLIP_RESULT,
  FIXTURES,
  METRO,
  REPO_URL,
  SIDE_LABELS,
  STUDY_RESULT,
} from "@/lib/demo/story";
import { formatClock } from "@/lib/demo/format";
import { fetchWithProgress, formatBytes, loadPercent } from "@/lib/demo/load";
import { VizEngine } from "@/lib/viz/engine";
import CityScale from "./CityScale";
import IntroCard from "./IntroCard";
import Scoreboard, { emptyHandles } from "./Scoreboard";
import { useLiveCompare } from "./useLiveCompare";
import styles from "./Demo.module.css";

/** Ten minutes of traffic is a long watch at 1x. */
const SPEEDS = [4, 8, 16] as const;
const DEFAULT_SPEED = 8;

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

  const ready = stage === "ready";
  useLiveCompare(engine, ready, live, { captions: true });

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
      const total = totals[0] + totals[1] || 10_100_000;
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
  const captionRef = useCallback((el: HTMLParagraphElement | null) => {
    live.current.caption = el;
  }, []);
  const elapsedRef = useCallback((el: HTMLSpanElement | null) => {
    live.current.elapsed = el;
  }, []);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    live.current.trackFill = el;
  }, []);
  const flagRefA = useCallback((el: HTMLElement | null) => {
    live.current.stageFlag[0] = el;
  }, []);
  const flagRefB = useCallback((el: HTMLElement | null) => {
    live.current.stageFlag[1] = el;
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <span className={styles.mark}>trafficlab</span>
          <nav className={styles.topLinks}>
            <a href="#city">See it at city scale</a>
            <Link href="/studio" prefetch={false}>Open the research tool</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
          </nav>
        </header>

        <div className={styles.head}>
          <div className={styles.sectionKicker}>Part one · one junction, two lights</div>
          <h1 className={styles.title}>
            A traffic light that watches the traffic clears the same junction{" "}
            <em>{CLIP_RESULT.waitReductionPct}% faster</em>.
          </h1>
          <p className={styles.lede}>
            Below is one busy junction, simulated twice over the same ten minutes. Both runs get the
            same cars arriving at the same second. On the <b className={styles.inkFixed}>left</b> the
            light runs to a fixed schedule; on the <b className={styles.inkResponsive}>right</b> it
            senses the cars waiting and changes when they need it to. Nothing else differs.
          </p>
        </div>

        <Scoreboard
          handles={live}
          foot={
            <>
              Longer bar means longer waiting. Both figures are running averages over everything
              since the clip started, so they climb as the queues build. By the end of these{" "}
              {CLIP_RESULT.minutes} minutes the responsive signal finishes{" "}
              {CLIP_RESULT.waitReductionPct}% ahead.
            </>
          }
        />

        <div className={styles.stage}>
          <div ref={hostRef} className={styles.canvasHost} />
          <div className={styles.touchGuard} />
          {ready && (
            <>
              <span className={`${styles.sideTag} ${styles.sideTagLeft}`}>
                <span className={styles.dot} />
                {SIDE_LABELS.fixed}
                <b ref={flagRefA} className={styles.stageFlag} hidden>
                  Faster
                </b>
              </span>
              <span className={`${styles.sideTag} ${styles.sideTagRight}`}>
                <span className={styles.dot} />
                {SIDE_LABELS.responsive}
                <b ref={flagRefB} className={styles.stageFlag} hidden>
                  Faster
                </b>
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

        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.legendMark} ${styles.legendCar}`} />
            Every little box is one car, driving the route it was given.
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendMark} ${styles.legendStop}`} />
            A line of stopped cars is a queue — that is people waiting.
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendMark} ${styles.legendClock}`} />
            Playing at {speed}× real time: ten minutes takes about {Math.round(600 / speed)} seconds.
          </span>
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

        <section className={styles.explain} aria-label="How to read this">
          <h2 className={styles.explainTitle}>What you are looking at</h2>
          <div className={styles.explainGrid}>
            <div className={styles.explainItem}>
              <div className={styles.explainNum}>1</div>
              <h3>Two copies of one junction</h3>
              <p>
                Left and right are the same crossroads, the same map, the same drivers, replayed
                side by side. Watch one car on the left and its twin is doing the identical trip on
                the right, until a light treats them differently.
              </p>
            </div>
            <div className={styles.explainItem}>
              <div className={styles.explainNum}>2</div>
              <h3>Queues are the story</h3>
              <p>
                When a light gives green to an empty road, the cars stacked up on the other road
                keep waiting. So the side whose queues stay shorter is the side whose light is
                paying attention.
              </p>
            </div>
            <div className={styles.explainItem}>
              <div className={styles.explainNum}>3</div>
              <h3>What the numbers count</h3>
              <p>
                <b>Average wait</b> is the time an average driver has lost sitting still, added up
                since the clip began. <b>Cars through</b> is how many have finished their trip.
                Lower wait and more cars through at the same time is the whole prize.
              </p>
            </div>
          </div>
        </section>

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

        <CityScale />

        <p className={styles.smallprint}>
          The responsive light is not artificial intelligence and there is no machine learning in
          it. It is a piece of classical engineering that has been in the ground for decades: a
          detector at the stop line, and a rule about when to let the green run on. This project
          also built controllers that learn from experience, and they did not beat it. Everything
          you see is a simulation — real junctions bring pedestrians, buses, breakdowns and weather
          that this model does not. Every figure on this page, including the{" "}
          {METRO.intersections}-junction one, comes from recordings you can regenerate from the
          source with a seed and a command.
        </p>

        <footer className={styles.footer}>
          <Link href="/studio" prefetch={false}>Open the full research tool</Link>
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
