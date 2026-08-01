"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CAPTIONS,
  CLIP_RESULT,
  CLIP_SAVED,
  FIXTURES,
  SIDE_LABELS,
  STUDY_RESULT,
} from "@/lib/demo/story";
import { formatClock, formatCount } from "@/lib/demo/format";
import { formatSaved } from "@/lib/demo/savings";
import { fetchWithProgress, formatBytes, loadPercent } from "@/lib/demo/load";
import { VizEngine } from "@/lib/viz/engine";
import Scoreboard, { emptyHandles } from "./Scoreboard";
import { useLiveCompare } from "./useLiveCompare";
import styles from "./Demo.module.css";

/** Ten minutes of traffic is a long watch at 1x. */
const SPEEDS = [4, 8, 16] as const;
const DEFAULT_SPEED = 8;

/** Below this the split view is cramped and touch drags must scroll the page. */
const NARROW_PX = 860;

/** Both recordings together, bytes — the loading bar's fallback total. */
const PAIR_BYTES = 10_127_337;

type Stage = "idle" | "loading" | "ready" | "error";

/**
 * The controlled experiment: the same junction simulated twice over the same
 * ten minutes, one light each, on one shared clock.
 *
 * This used to be the page's opening act. It is the more rigorous of the two
 * junction sections — a genuine A/B with identical arrivals — but it answers
 * the question "which light is better" rather than the question a visitor
 * actually arrives with, which is "does this make me wait less". So it now sits
 * behind the section that shows the waiting falling, and its 10 MB of
 * recordings are fetched only when somebody asks for them, exactly as the city
 * pair below already was.
 */
export default function Compare() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<VizEngine | null>(null);
  const live = useRef(emptyHandles());
  const loadBar = useRef<HTMLDivElement>(null);
  const loadHint = useRef<HTMLDivElement>(null);

  const [engine, setEngine] = useState<VizEngine | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);

  const ready = stage === "ready";
  useLiveCompare(engine, ready, live, { captions: true });

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const host = hostRef.current;
    if (!host || stage === "loading" || stage === "ready") return;
    setStage("loading");
    setFailure(null);

    const bytes = [0, 0];
    const totals = [0, 0];
    const showProgress = () => {
      const total = totals[0] + totals[1] || PAIR_BYTES;
      const loaded = bytes[0] + bytes[1];
      if (loadBar.current) loadBar.current.style.width = `${loadPercent(loaded, total).toFixed(1)}%`;
      if (loadHint.current) {
        loadHint.current.textContent = `${formatBytes(loaded)} of ${formatBytes(total)}`;
      }
    };

    void (async () => {
      try {
        const created = new VizEngine(host);
        engineRef.current = created;
        await created.ensureAssets();
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
        if (engineRef.current !== created) return; // unmounted mid-download
        created.loadPrimary(fixed, SIDE_LABELS.fixed);
        created.loadCompare(responsive, SIDE_LABELS.responsive);
        created.setSpeed(DEFAULT_SPEED);
        created.setPlaying(true);
        frameStage(created);
        setEngine(created);
        setStage("ready");
      } catch (err) {
        setFailure(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    })();
  }, [stage]);

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
    <section className={styles.compare} id="compare">
      <div className={styles.cityHead}>
        <div className={styles.sectionKicker}>Part two · the controlled experiment</div>
        <h2 className={styles.sectionTitle}>
          The same junction, run twice over, one light each
        </h2>
        <p className={styles.sectionLede}>
          Watching one junction improve is persuasive, but it is not a controlled comparison: a
          clip&rsquo;s second half is not its first half. So here is the control. The same busy
          junction, simulated twice over the same ten minutes, with the{" "}
          <b className={styles.inkFixed}>fixed timer</b> on the left and the{" "}
          <b className={styles.inkResponsive}>responsive signal</b> on the right, both getting the
          same cars arriving at the same second. Watch one car on the left and its twin is doing the
          identical trip on the right, until a light treats them differently. The left-hand run is
          the same recording the section above starts out as, carried on to the end.
        </p>
      </div>

      {ready && (
        <Scoreboard
          handles={live}
          foot={
            <>
              Longer bar means longer waiting. Both of these are running averages over everything
              since the clip started, so they climb towards a settled value as the queues build —
              that is the shape of a running average, not the waiting getting worse. The counter
              above is the thing that measures the improvement: the gap between the two, which
              reaches {formatSaved(CLIP_SAVED.savedSeconds)} by the end of these{" "}
              {CLIP_RESULT.minutes} minutes, with the responsive signal {CLIP_RESULT.waitReductionPct}%
              ahead on the average.
            </>
          }
        />
      )}

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
            {stage === "idle" && (
              <>
                <div className={styles.loadingLabel}>
                  Two more recordings, 10 MB together — they only start downloading when you ask.
                </div>
                <button className={`${styles.btn} ${styles.btnPlay}`} onClick={start}>
                  Run them side by side
                </button>
              </>
            )}
            {stage === "loading" && (
              <>
                <div className={styles.loadingLabel}>Loading the two simulations…</div>
                <div className={styles.loadingBar}>
                  <div ref={loadBar} className={styles.loadingFill} />
                </div>
                <div ref={loadHint} className={styles.loadingHint} />
              </>
            )}
            {stage === "error" && (
              <p className={styles.failure}>
                The simulations could not be loaded ({failure}). Try again in a moment.
              </p>
            )}
          </div>
        )}
      </div>

      {ready && (
        <>
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
              Playing at {speed}× real time: ten minutes takes about {Math.round(600 / speed)}{" "}
              seconds.
            </span>
          </div>

          <p ref={captionRef} className={styles.caption}>
            {CAPTIONS[0].text}
          </p>

          <div className={styles.controls}>
            <button className={`${styles.btn} ${styles.btnPlay}`} onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <button className={styles.btn} onClick={restart}>
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
        </>
      )}

      <section className={styles.explain} aria-label="How to read this">
        <h3 className={styles.explainTitle}>What you are looking at</h3>
        <div className={styles.explainGrid}>
          <div className={styles.explainItem}>
            <div className={styles.explainNum}>1</div>
            <h4>Two copies of one junction</h4>
            <p>
              Left and right are the same crossroads, the same map, the same drivers, replayed side
              by side. Watch one car on the left and its twin is doing the identical trip on the
              right, until a light treats them differently.
            </p>
          </div>
          <div className={styles.explainItem}>
            <div className={styles.explainNum}>2</div>
            <h4>Queues are the story</h4>
            <p>
              When a light gives green to an empty road, the cars stacked up on the other road keep
              waiting. So the side whose queues stay shorter is the side whose light is paying
              attention.
            </p>
          </div>
          <div className={styles.explainItem}>
            <div className={styles.explainNum}>3</div>
            <h4>What the numbers count</h4>
            <p>
              <b>Waiting saved</b> is the gap between the two runs&rsquo; total delay: every second
              a driver on the left spent stopped that their twin on the right did not, added across
              everybody. It climbs because the saving keeps accruing. <b>Average wait</b> is each
              side&rsquo;s own running average since the clip began — good for comparing the two,
              but it settles rather than falls, which is why the section above uses a rolling window
              instead. <b>Cars through</b> is how many have finished their trip.
            </p>
          </div>
        </div>
      </section>

      <div className={styles.results}>
        <div className={styles.resultCard}>
          <div className={styles.resultKicker}>The pair above</div>
          <div className={styles.resultBig}>{formatSaved(CLIP_SAVED.savedSeconds)} of waiting saved</div>
          <p className={styles.resultBody}>
            Over these {CLIP_RESULT.minutes} minutes the fixed timer cost its drivers{" "}
            {formatCount(CLIP_SAVED.fixedDelaySeconds)} driver-seconds of delay and the responsive
            signal {formatCount(CLIP_SAVED.responsiveDelaySeconds)} — a difference of{" "}
            {formatCount(CLIP_SAVED.savedSeconds)} seconds, which is exactly what the counter above
            counts up to. Average wait per driver fell from{" "}
            {formatClock(CLIP_RESULT.fixedWaitSeconds)} to{" "}
            {formatClock(CLIP_RESULT.responsiveWaitSeconds)}, {CLIP_RESULT.waitReductionPct}% less,
            while {CLIP_RESULT.responsiveCars} cars got through the junction instead of{" "}
            {CLIP_RESULT.fixedCars}. More traffic, less waiting.
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
            {STUDY_RESULT.runsPerSide} separate one-hour runs for each light:{" "}
            {STUDY_RESULT.heavyReductionPct}% less waiting under heavy traffic and{" "}
            {STUDY_RESULT.rushReductionPct}% under rush-hour traffic.
          </p>
        </div>
      </div>
    </section>
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
