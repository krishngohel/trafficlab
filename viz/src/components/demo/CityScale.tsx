"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CITY_RESULT, CITY_SAVED, FIXTURES, METRO, SIDE_LABELS } from "@/lib/demo/story";
import { formatClock, formatCount } from "@/lib/demo/format";
import { formatSaved } from "@/lib/demo/savings";
import { fetchWithProgress, formatBytes, loadPercent } from "@/lib/demo/load";
import { VizEngine } from "@/lib/viz/engine";
import { DEFAULT_TOGGLES } from "@/lib/viz/view";
import Scoreboard, { emptyHandles } from "./Scoreboard";
import { useLiveCompare } from "./useLiveCompare";
import styles from "./Demo.module.css";

/** Slow enough to watch a platoon move between junctions, quick enough to finish. */
const SPEEDS = [4, 8, 16] as const;
const DEFAULT_SPEED = 8;

type Stage = "idle" | "loading" | "ready" | "error";

/**
 * The second half of the demo: the same two lights, the same measurement, run
 * again at a hundred junctions at once.
 *
 * The pair is 33 MB, so nothing here touches the network until the visitor
 * clicks — the landing view stays exactly as light as it was before this
 * section existed. The engine is created on the same click for the same
 * reason: a second WebGL context on first paint would cost every visitor for a
 * section most of them never scroll to.
 */
export default function CityScale() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<VizEngine | null>(null);
  const live = useRef(emptyHandles());
  const loadBar = useRef<HTMLDivElement>(null);
  const loadHint = useRef<HTMLDivElement>(null);
  const onMap = useRef<HTMLElement | null>(null);

  const [engine, setEngine] = useState<VizEngine | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  // Queues on by default up here: from a mile up the cars are specks, and the
  // coloured stop lines are the only thing that makes the difference between
  // the two cities visible at all.
  const [queues, setQueues] = useState(true);
  const [viewMode, setViewMode] = useState<"city" | "street">("city");
  // Seeded with the measured count so the copy reads correctly before the
  // files land, then replaced by what the files themselves declare.
  const [junctions, setJunctions] = useState<number>(METRO.intersections);

  const ready = stage === "ready";
  useLiveCompare(engine, ready, live);

  // Tear the engine down with the section, whatever stage it reached.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Cars still on the map is a city-only readout, so it lives here rather than
  // in the shared compare loop.
  useEffect(() => {
    if (!engine || !ready) return;
    let last = 0;
    const sync = () => {
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      const el = onMap.current;
      if (!el) return;
      let total = 0;
      for (const side of [0, 1] as const) {
        const view = engine.getView(side);
        if (view) total += view.metricAt(engine.clock, view.waitCols.active);
      }
      const text = formatCount(total);
      if (el.textContent !== text) el.textContent = text;
    };
    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine, ready]);

  const start = useCallback(() => {
    const host = hostRef.current;
    if (!host || stage === "loading" || stage === "ready") return;
    setStage("loading");
    setFailure(null);

    const bytes = [0, 0];
    const totals = [0, 0];
    const showProgress = () => {
      const total = totals[0] + totals[1] || METRO.megabytes * 1024 * 1024;
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
          fetchWithProgress(FIXTURES.cityFixed, (l, t) => {
            bytes[0] = l;
            totals[0] = t;
            showProgress();
          }),
          fetchWithProgress(FIXTURES.cityResponsive, (l, t) => {
            bytes[1] = l;
            totals[1] = t;
            showProgress();
          }),
        ]);
        if (engineRef.current !== created) return; // unmounted mid-download
        const info = created.loadPrimary(fixed, SIDE_LABELS.fixed);
        created.loadCompare(responsive, SIDE_LABELS.responsive);
        setJunctions(info.intersectionIds.length);
        created.setToggles({ ...DEFAULT_TOGGLES, queues: true });
        created.setSpeed(DEFAULT_SPEED);
        created.setPlaying(true);
        frameCity(created, "city");
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

  const changeView = useCallback(
    (mode: "city" | "street") => {
      setViewMode(mode);
      if (engine) frameCity(engine, mode);
    },
    [engine],
  );

  const toggleQueues = useCallback(() => {
    setQueues((was) => {
      const next = !was;
      engine?.setToggles({ ...DEFAULT_TOGGLES, queues: next });
      return next;
    });
  }, [engine]);

  const flagRefA = useCallback((el: HTMLElement | null) => {
    live.current.stageFlag[0] = el;
  }, []);
  const flagRefB = useCallback((el: HTMLElement | null) => {
    live.current.stageFlag[1] = el;
  }, []);
  const elapsedRef = useCallback((el: HTMLSpanElement | null) => {
    live.current.elapsed = el;
  }, []);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    live.current.trackFill = el;
  }, []);

  return (
    <section className={styles.city} id="city">
      <div className={styles.cityHead}>
        <div className={styles.sectionKicker}>Part two · a hundred junctions at once</div>
        <h2 className={styles.sectionTitle}>
          The same test, run across a whole city
        </h2>
        <p className={styles.sectionLede}>
          One junction is the easy case. A city is where signal control gets hard, because every
          green you hand out sends a platoon of cars straight into somebody else&rsquo;s junction.
          So here is the identical experiment on a {METRO.spacingMeters}-metre street grid with{" "}
          {METRO.intersections} signalised crossings: fixed timers on the left, the responsive rule
          on the right, running at <strong>every single one of the {METRO.intersections}</strong>{" "}
          — no central controller, no junction talking to its neighbours, just the same small rule
          repeated a hundred times.
        </p>
      </div>

      {ready && (
        <Scoreboard
          handles={live}
          carsUnit="trips finished so far"
          foot={
            <>
              Read exactly as above: the counter above is waiting that never happened, and the two
              averages here are running averages that settle upward as the clip goes on rather than
              getting worse. Every number is the whole city added together, all{" "}
              {junctions}
              {" junctions’ worth, on each side."}
            </>
          }
        />
      )}

      <div className={`${styles.stage} ${styles.stageTall}`}>
        <div ref={hostRef} className={styles.canvasHost} />
        <div className={styles.touchGuard} />
        {ready && (
          <>
            <span className={`${styles.sideTag} ${styles.sideTagLeft}`}>
              <span className={styles.dot} />
              {SIDE_LABELS.fixed}              <span className={styles.tagExtra}> · {junctions} junctions</span>
              <b ref={flagRefA} className={styles.stageFlag} hidden>
                Faster
              </b>
            </span>
            <span className={`${styles.sideTag} ${styles.sideTagRight}`}>
              <span className={styles.dot} />
              {SIDE_LABELS.responsive}              <span className={styles.tagExtra}> · {junctions} junctions</span>
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
                  Two more recordings, {METRO.megabytes} MB together — they only start downloading
                  when you ask.
                </div>
                <button className={`${styles.btn} ${styles.btnPlay}`} onClick={start}>
                  Load the city
                </button>
              </>
            )}
            {stage === "loading" && (
              <>
                <div className={styles.loadingLabel}>Loading both cities…</div>
                <div className={styles.loadingBar}>
                  <div ref={loadBar} className={styles.loadingFill} />
                </div>
                <div ref={loadHint} className={styles.loadingHint} />
              </>
            )}
            {stage === "error" && (
              <p className={styles.failure}>
                The city recordings could not be loaded ({failure}). Try again in a moment.
              </p>
            )}
          </div>
        )}
      </div>

      {ready && (
        <>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={`${styles.legendMark} ${styles.legendQueue}`} />
              Each coloured mark is a queue at a stop line: green is short, red is long.
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendMark} ${styles.legendCar}`} />
              <b ref={(el) => void (onMap.current = el)} className={styles.legendCount}>
                –
              </b>
              cars on the two maps right now, driving the same trips on both sides.
            </span>
          </div>

          <div className={styles.controls}>
            <button className={`${styles.btn} ${styles.btnPlay}`} onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <button className={styles.btn} onClick={restart}>
              Start over
            </button>
            <button
              className={`${styles.btn} ${queues ? styles.btnOn : ""}`}
              onClick={toggleQueues}
              aria-pressed={queues}
            >
              {queues ? "Hide the queues" : "Show the queues"}
            </button>
            <div className={styles.speedGroup}>
              <span className={styles.speedLabel}>View</span>
              <div className={styles.speedPills}>
                {(["city", "street"] as const).map((m) => (
                  <button
                    key={m}
                    className={`${styles.pill} ${m === viewMode ? styles.pillOn : ""}`}
                    onClick={() => changeView(m)}
                    aria-pressed={m === viewMode}
                  >
                    {m === "city" ? "Whole city" : "Street level"}
                  </button>
                ))}
              </div>
            </div>
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
              0:00 of 5:00
            </span>
            <div className={styles.track}>
              <div ref={trackRef} className={styles.trackFill} />
            </div>
          </div>

          <p className={styles.cityHint}>
            {viewMode === "city"
              ? "You are looking at both cities from about a mile up, so the cars themselves are specks and the coloured marks are where people are waiting. Drop to street level to watch a handful of these junctions close enough to see the cars."
              : "Now you are down among four or five of the hundred junctions, close enough to watch the queues form and clear. The little number beside each stop line is how many cars are waiting there. The figures above still cover all one hundred, not just the ones in shot."}
            {!queues && " The queue colours are currently off."}
          </p>
        </>
      )}

      <div className={styles.results}>
        <div className={styles.resultCard}>
          <div className={styles.resultKicker}>
            The city clip · {CITY_RESULT.minutes} minutes, {METRO.intersections} junctions
          </div>
          <div className={styles.resultBig}>
            {formatSaved(CITY_SAVED.savedSeconds)} of waiting saved
          </div>
          <p className={styles.resultBody}>
            Across the whole city the fixed timers cost their drivers{" "}
            {formatCount(CITY_SAVED.fixedDelaySeconds)} driver-seconds of delay in five minutes and
            the responsive signals {formatCount(CITY_SAVED.responsiveDelaySeconds)} — very nearly
            eleven hours of collective standing still, gone, from five minutes of one city. Average
            wait per driver was {formatClock(CITY_RESULT.fixedWaitSeconds)} against{" "}
            {formatClock(CITY_RESULT.responsiveWaitSeconds)}, {CITY_RESULT.waitReductionPct}% less,
            and {formatCount(CITY_RESULT.responsiveCars)} drivers finished their trip instead of{" "}
            {formatCount(CITY_RESULT.fixedCars)}, {CITY_RESULT.extraCars} more. The single-junction
            result holds when you repeat it a hundred times over.
          </p>
        </div>
        <div className={styles.resultCard}>
          <div className={styles.resultKicker}>What agrees with what</div>
          <p className={styles.resultBody}>
            The saved-waiting counter needs no caveat: total delay is written into both recordings
            directly, so the number ticking over the picture lands on exactly the{" "}
            {formatCount(CITY_SAVED.savedSeconds)} seconds quoted here. The average-wait figures do
            need one. They divide that delay by every driver the simulation created, whereas the
            browser can only count drivers still on the map plus those who finished at the
            roadside — and in this city a good number of trips end in an off-street parking space
            the recording does not tally. So the live averages read a little high, 1m 55s against
            1m 37s, a 16% gap rather than this {CITY_RESULT.waitReductionPct}% one. Both are
            measured; the {CITY_RESULT.waitReductionPct}% is the one that counts everybody.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Two ways of looking at the same city, because neither one alone is honest.
 *
 * From the top the hundred junctions read as a city, but the cars are specks
 * and a visitor has to take the "every junction" claim on trust. Down at the
 * street it is obvious what the lights are doing to real queues, but only a
 * few junctions are in shot. The page offers both and says which is which.
 */
function frameCity(engine: VizEngine, mode: "city" | "street"): void {
  const view = engine.getView(0);
  if (!view) return;
  const b = view.bounds;
  const narrow = typeof window !== "undefined" && window.innerWidth < 860;
  // Each half of the split is about half as wide as the stage, so the framing
  // works off the height — the same reasoning as the junction view above.
  const d =
    mode === "city"
      ? Math.max(b.extent, 60) * (narrow ? 1.18 : 0.86)
      : // ~900 m of street in shot, about four of the 220 m blocks, which is
        // the closest you can get and still see a queue empty into the next
        // junction. A narrow screen sees half the width, so it pulls back.
        (narrow ? 1400 : 900);
  engine.setCameraPose(
    { x: b.centerX, z: -b.centerY },
    { x: b.centerX + d * 0.22, y: d * 0.74, z: -b.centerY + d * 0.4 },
  );
}
