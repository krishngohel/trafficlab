"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CLIP_RESULT,
  FIXTURES,
  SIDE_LABELS,
  SWITCH_CAPTIONS,
  SWITCH_CLIP,
  SWITCH_RESULT,
  captionIndexAt,
} from "@/lib/demo/story";
import { formatClock, formatCount, formatElapsed } from "@/lib/demo/format";
import { fetchWithProgress, formatBytes, loadPercent } from "@/lib/demo/load";
import { windowFrames } from "@/lib/demo/savings";
import {
  carsClearedAt,
  regimeAt,
  rollingWaitAt,
  rollingWaitSeries,
  waitAxis,
  type WaitAxis,
} from "@/lib/demo/rolling";
import { VizEngine } from "@/lib/viz/engine";
import WaitSpark, { type SparkHandle } from "./WaitSpark";
import styles from "./Demo.module.css";

/** Ten minutes of traffic is a long watch at 1x. */
const SPEEDS = [4, 8, 16] as const;
const DEFAULT_SPEED = 8;
const NARROW_PX = 860;

/** Sim seconds either side of the handover during which the banner is up. */
const BANNER_SECONDS = 30;

type Stage = "scene" | "clip" | "ready" | "error";

/** Everything the frame hook needs about the loaded recording, computed once. */
interface ClipFacts {
  series: Float64Array;
  axis: WaitAxis;
  dt: number;
  duration: number;
  span: number;
  delayCol: number;
  throughputCol: number;
}

/**
 * The section the page opens on: one junction whose waiting visibly comes down.
 *
 * The rest of the page compares two runs, which is the stronger experiment but
 * asks a visitor to subtract one number from another and trust that the
 * difference means something. This does not. It plays a single continuous
 * recording of a single junction — `switch.traj`, heavy traffic, seed 0 — in
 * which the light is a fixed timer for five minutes and a responsive signal for
 * the five after that, and puts the waiting on screen as it falls.
 *
 * The reading is a trailing 60-second window of the recording's own metrics
 * (see `lib/demo/rolling.ts`), noisy by construction, and the copy says so in
 * as many words. The settled figures are averages over many windows, and the
 * rigorous claim in this section is the counterfactual against `demo_fixed.traj`
 * — the same run left on the timer — not any single window on screen.
 */
export default function WaitFalls({ holdAtStart }: { holdAtStart: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadBar = useRef<HTMLDivElement>(null);
  const loadHint = useRef<HTMLDivElement>(null);
  const spark = useRef<SparkHandle | null>(null);
  const facts = useRef<ClipFacts | null>(null);

  // Live DOM targets, written from the frame hook rather than through state.
  const panel = useRef<HTMLDivElement | null>(null);
  const waitValue = useRef<HTMLElement | null>(null);
  const waitLine = useRef<HTMLElement | null>(null);
  const clearedValue = useRef<HTMLElement | null>(null);
  const lightName = useRef<HTMLElement | null>(null);
  const lightLine = useRef<HTMLElement | null>(null);
  const benchLine = useRef<HTMLElement | null>(null);
  const stageTag = useRef<HTMLElement | null>(null);
  const stageTagBox = useRef<HTMLElement | null>(null);
  const banner = useRef<HTMLElement | null>(null);
  const caption = useRef<HTMLParagraphElement | null>(null);
  const elapsed = useRef<HTMLSpanElement | null>(null);
  const trackFill = useRef<HTMLDivElement | null>(null);
  const playBtn = useRef<HTMLButtonElement | null>(null);

  const [engine, setEngine] = useState<VizEngine | null>(null);
  const [stage, setStage] = useState<Stage>("scene");
  const [failure, setFailure] = useState<string | null>(null);
  const [clip, setClip] = useState<ClipFacts | null>(null);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);

  const ready = stage === "ready";

  // --- engine + fixture -------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = new VizEngine(host);
    setEngine(created);
    let cancelled = false;

    void (async () => {
      try {
        await created.ensureAssets();
        if (cancelled) return;
        setStage("clip");
        const buffer = await fetchWithProgress(FIXTURES.switch, (loaded, total) => {
          const size = total || SWITCH_CLIP.bytes;
          if (loadBar.current) {
            loadBar.current.style.width = `${loadPercent(loaded, size).toFixed(1)}%`;
          }
          if (loadHint.current) {
            loadHint.current.textContent = `${formatBytes(loaded)} of ${formatBytes(size)}`;
          }
        });
        if (cancelled) return;
        created.loadPrimary(buffer, SIDE_LABELS.responsive);
        const view = created.getView(0);
        if (!view) throw new Error("the recording carried no frames");

        const dt = view.scan.dt > 0 ? view.scan.dt : 0.5;
        const span = windowFrames(dt, SWITCH_RESULT.windowSeconds);
        const series = rollingWaitSeries(
          view.scan.metrics,
          view.scan.m,
          view.delayCol,
          view.throughputCol,
          span,
        );
        const built: ClipFacts = {
          series,
          axis: waitAxis(series),
          dt,
          duration: view.duration,
          span,
          delayCol: view.delayCol,
          throughputCol: view.throughputCol,
        };
        facts.current = built;
        setClip(built);

        created.setSpeed(DEFAULT_SPEED);
        created.setPlaying(true);
        frameJunction(created);
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

  // The clip waits at its first frame behind the intro card, so a visitor who
  // reads the card does not come back to a clip already past the handover.
  useEffect(() => {
    if (!engine || !ready) return;
    if (holdAtStart) {
      engine.setPlaying(false);
    } else {
      engine.seek(0);
      engine.setPlaying(true);
    }
  }, [engine, ready, holdAtStart]);

  // --- the live readout ---------------------------------------------------------
  useEffect(() => {
    if (!engine || !ready) return;
    let last = 0;
    let shownRegime = "";
    let captionIndex = -1;

    const write = (el: HTMLElement | null, text: string) => {
      if (el && el.textContent !== text) el.textContent = text;
    };

    const sync = () => {
      const now = performance.now();
      if (now - last < 200) return;
      last = now;
      const f = facts.current;
      const view = engine.getView(0);
      if (!f || !view) return;

      const clock = engine.clock;
      const frame = view.frameIndexAt(clock);
      const wait = rollingWaitAt(view.scan.metrics, view.scan.m, f.delayCol, f.throughputCol, frame, f.span);
      const cleared = carsClearedAt(view.scan.metrics, view.scan.m, f.throughputCol, frame, f.span);
      const regime = regimeAt(clock.time, SWITCH_CLIP.switchAtSeconds);
      const after = regime === "after";

      write(waitValue.current, Number.isFinite(wait) ? formatClock(wait) : "–");
      write(
        waitLine.current,
        Number.isFinite(wait)
          ? `of waiting per driver who got through, over the last ${SWITCH_RESULT.windowSeconds} seconds of the clip.`
          : `The reading needs a full ${SWITCH_RESULT.windowSeconds} seconds of clip behind it before it means anything.`,
      );
      write(
        clearedValue.current,
        Number.isFinite(cleared) ? formatCount(cleared) : "–",
      );

      if (regime !== shownRegime) {
        shownRegime = regime;
        const tone = after ? "responsive" : "fixed";
        if (panel.current) panel.current.dataset.light = tone;
        // The label over the picture has to change colour with it, or the dot
        // beside "Responsive signal" would still be the fixed timer's amber.
        if (stageTagBox.current) stageTagBox.current.dataset.light = tone;
        const name = after ? SIDE_LABELS.responsive : SIDE_LABELS.fixed;
        write(lightName.current, name);
        write(stageTag.current, name);
        if (benchLine.current) benchLine.current.hidden = !after;
      }

      write(
        lightLine.current,
        after
          ? "Took the junction over at 5:00, mid-flow. It holds a green while cars are still coming and ends it once the road is clear."
          : `Green for a set time, then the next direction, whether or not anyone is there. Hands the junction over in ${formatClock(
              Math.max(0, SWITCH_CLIP.switchAtSeconds - clock.time),
            )} of clip.`,
      );

      if (banner.current) {
        const since = clock.time - SWITCH_CLIP.switchAtSeconds;
        banner.current.hidden = !(since >= 0 && since < BANNER_SECONDS);
      }

      const index = captionIndexAt(clock.time, SWITCH_CAPTIONS);
      if (index !== captionIndex) {
        captionIndex = index;
        write(caption.current, SWITCH_CAPTIONS[index].text);
      }

      // The play button's label is written here too rather than held in state:
      // the clock can stop on its own at the end of the clip, and a React flag
      // would then disagree with the engine until somebody clicked something.
      write(playBtn.current, clock.playing ? "Pause" : "Play");
      write(elapsed.current, formatElapsed(clock.time, clock.duration));
      if (trackFill.current) {
        trackFill.current.style.width = `${loadPercent(clock.time, clock.duration).toFixed(2)}%`;
      }
      spark.current?.draw(clock.time);
    };

    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine, ready]);

  // --- controls -------------------------------------------------------------------
  const togglePlay = useCallback(() => {
    if (!engine) return;
    engine.setPlaying(!engine.clock.playing);
  }, [engine]);

  const restart = useCallback(() => {
    if (!engine) return;
    engine.seek(0);
    engine.setPlaying(true);
  }, [engine]);

  const jumpToSwitch = useCallback(() => {
    if (!engine) return;
    // Twenty seconds of run-up, so the change is watched rather than arrived at.
    engine.seek(Math.max(0, SWITCH_CLIP.switchAtSeconds - 20));
    engine.setPlaying(true);
  }, [engine]);

  const changeSpeed = useCallback(
    (value: number) => {
      setSpeed(value);
      engine?.setSpeed(value);
    },
    [engine],
  );

  const switchClock = formatElapsed(SWITCH_CLIP.switchAtSeconds, SWITCH_CLIP.minutes * 60).split(" of ")[0];

  return (
    <section className={styles.falls} aria-label="Watch the wait come down">
      <div className={styles.head}>
        <div className={styles.sectionKicker}>Part one · one junction, watch the wait come down</div>
        <h1 className={styles.title}>
          Five minutes in, the light starts watching the traffic. The waiting{" "}
          <em>comes down and stays down</em>.
        </h1>
        <p className={styles.lede}>
          One junction, one continuous ten-minute recording, heavy traffic from the first second to
          the last. For the first five minutes the light runs a{" "}
          <b className={styles.inkFixed}>fixed timer</b>. At exactly {switchClock} a{" "}
          <b className={styles.inkResponsive}>responsive signal</b> takes the same junction over
          mid-flow, with the same drivers still arriving on the same seconds. Nothing else changes —
          not the demand, not the routes, not the map. The number below is read live out of the
          recording as it plays.
        </p>
      </div>

      <div ref={panel} className={styles.waitPanel} data-light="fixed">
        <div className={styles.waitMain}>
          <span className={styles.heroKicker}>
            Waiting per driver who got through · last {SWITCH_RESULT.windowSeconds} seconds
          </span>
          <strong ref={waitValue} className={styles.waitValue}>
            –
          </strong>
          <span ref={waitLine} className={styles.heroLine}>
            The reading needs a full {SWITCH_RESULT.windowSeconds} seconds of clip behind it before
            it means anything.
          </span>
          <span ref={benchLine} className={styles.waitBench} hidden>
            While the fixed timer ran, this sat at {formatClock(SWITCH_RESULT.beforeWaitSeconds)} on
            average — the dashed line across the chart.
          </span>
        </div>

        <div className={styles.waitAside}>
          <span className={styles.heroKicker}>Running the junction</span>
          <b ref={lightName} className={styles.waitAsideValue}>
            {SIDE_LABELS.fixed}
          </b>
          <span ref={lightLine} className={styles.heroAsideLine}>
            Green for a set time, then the next direction, whether or not anyone is there.
          </span>
          <span className={styles.waitCleared}>
            <b ref={clearedValue}>–</b> drivers finished their trip in that same minute
          </span>
        </div>
      </div>

      <figure className={styles.sparkWrap}>
        {clip && (
          <WaitSpark
            series={clip.series}
            dt={clip.dt}
            duration={clip.duration}
            axis={clip.axis}
            switchAt={SWITCH_CLIP.switchAtSeconds}
            windowSeconds={SWITCH_RESULT.windowSeconds}
            formatValue={formatClock}
            handleRef={spark}
            label={`Waiting per driver who got through the junction, over a rolling ${SWITCH_RESULT.windowSeconds}-second window, against clip time. It runs at about ${formatClock(SWITCH_RESULT.beforeWaitSeconds)} under the fixed timer and steps down to about ${formatClock(SWITCH_RESULT.afterWaitSeconds)} after the responsive signal takes over at ${switchClock}.`}
          />
        )}
        <figcaption className={styles.sparkFoot}>
          The same reading, drawn as the clip plays. Each point averages the{" "}
          {SWITCH_RESULT.windowSeconds} seconds behind it, which is roughly{" "}
          {SWITCH_RESULT.carsPerMinuteBefore} finishing drivers — so the line is genuinely jumpy and
          the two stretches overlap. The step, not any one point, is the result.
        </figcaption>
      </figure>

      <div className={styles.stage}>
        <div ref={hostRef} className={styles.canvasHost} />
        <div className={styles.touchGuard} />
        {ready && (
          <>
            <span
              ref={stageTagBox}
              className={`${styles.sideTag} ${styles.sideTagLeft} ${styles.sideTagSolo}`}
              data-light="fixed"
            >
              <span className={styles.dot} />
              <b ref={stageTag}>{SIDE_LABELS.fixed}</b>
            </span>
            <span ref={banner} className={styles.switchBanner} hidden>
              {switchClock} · the responsive signal has the junction
            </span>
          </>
        )}
        {!ready && (
          <div className={styles.loading}>
            {stage === "error" ? (
              <p className={styles.failure}>
                The recording could not be loaded ({failure}). Try reloading the page.
              </p>
            ) : (
              <>
                <div className={styles.loadingLabel}>
                  {stage === "scene" ? "Building the street…" : "Loading the ten-minute recording…"}
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

      <p ref={caption} className={styles.caption}>
        {SWITCH_CAPTIONS[0].text}
      </p>

      <div className={styles.controls}>
        <button
          ref={playBtn}
          className={`${styles.btn} ${styles.btnPlay}`}
          onClick={togglePlay}
          disabled={!ready}
        >
          Pause
        </button>
        <button className={styles.btn} onClick={restart} disabled={!ready}>
          Start over
        </button>
        <button className={styles.btn} onClick={jumpToSwitch} disabled={!ready}>
          Jump to the change
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
        <span ref={elapsed} className={styles.elapsed}>
          0:00 of {SWITCH_CLIP.minutes}:00
        </span>
        <div className={styles.track}>
          <div ref={trackFill} className={styles.trackFill} />
        </div>
      </div>

      <div className={styles.results}>
        <div className={styles.resultCard}>
          <div className={styles.resultKicker}>The clip above · the noisy reading, averaged</div>
          <div className={styles.resultBig}>
            {formatClock(SWITCH_RESULT.beforeWaitSeconds)} → {formatClock(SWITCH_RESULT.afterWaitSeconds)}
          </div>
          <p className={styles.resultBody}>
            Averaged over every {SWITCH_RESULT.windowSeconds}-second window that sits entirely under
            one light — so no window straddles the handover — the reading runs at{" "}
            {formatClock(SWITCH_RESULT.beforeWaitSeconds)} per driver who got through under the
            fixed timer and{" "}
            {formatClock(SWITCH_RESULT.afterWaitSeconds)} under the responsive signal,{" "}
            {SWITCH_RESULT.windowFallPct}% less. Those are averages of a jumpy measure and their
            ranges overlap ({formatClock(SWITCH_RESULT.beforeLowSeconds)}–
            {formatClock(SWITCH_RESULT.beforeHighSeconds)} against{" "}
            {formatClock(SWITCH_RESULT.afterLowSeconds)}–{formatClock(SWITCH_RESULT.afterHighSeconds)}
            ), which is why the page shows you the whole line rather than two numbers. Even so the
            step is not subtle: {SWITCH_RESULT.belowBeforeAveragePct}% of the windows after the
            handover sit below the timer&rsquo;s own average. Drivers finishing per minute went the
            other way: {SWITCH_RESULT.carsPerMinuteBefore} before, {SWITCH_RESULT.carsPerMinuteAfter}{" "}
            after.
          </p>
        </div>
        <div className={styles.resultCard}>
          <div className={styles.resultKicker}>
            The controlled version of the same five minutes
          </div>
          <div className={styles.resultBig}>{SWITCH_RESULT.heldFixedFallPct}% less waiting</div>
          <p className={styles.resultBody}>
            Comparing a clip&rsquo;s second half against its own first half is weak evidence,
            because traffic changes as well as lights do. So here is the same second five minutes
            against the identical run left on the timer — the recording in part two, which is the
            same simulation, seed and arrivals as this one right up to the handover. Over{" "}
            {switchClock} to {SWITCH_CLIP.minutes}:00 the responsive signal cost{" "}
            {formatClock(SWITCH_RESULT.secondHalfWaitSeconds)} per driver who got through and put{" "}
            {SWITCH_RESULT.secondHalfCars} drivers through; the timer would have cost{" "}
            {formatClock(SWITCH_RESULT.heldFixedWaitSeconds)} and put {SWITCH_RESULT.heldFixedCars}{" "}
            through. Left alone this junction was getting worse — from{" "}
            {formatClock(SWITCH_RESULT.firstHalfWaitSeconds)} in the first half to{" "}
            {formatClock(SWITCH_RESULT.heldFixedWaitSeconds)} in the second. The responsive rule did
            not just stop that, it pulled the waiting below where it started, with{" "}
            {SWITCH_RESULT.heldFixedMoreCarsPct}% more drivers getting through.
          </p>
        </div>
      </div>

      <p className={styles.fallsNote}>
        A note on what this number is, because the sections below print it too. Every wait figure on
        this page is the same arithmetic: the waiting a junction generated, divided by the drivers
        who actually got through it. The only thing that changes is the stretch of clip. Here it is
        the last minute, which is why it can come down; below it is a whole run, which is why it
        settles instead. The two agree — this timer averages{" "}
        {formatClock(SWITCH_RESULT.beforeWaitSeconds)} a driver over its five minutes, and the same
        timer left running for the full ten minutes in part two comes out at{" "}
        {formatClock(CLIP_RESULT.fixedWaitSeconds)}, because the five minutes it does not get to run
        here are its worse half ({formatClock(SWITCH_RESULT.firstHalfWaitSeconds)} then{" "}
        {formatClock(SWITCH_RESULT.heldFixedWaitSeconds)}). Dividing by the drivers who got through
        is the generous choice, not the strict one: it leaves out everybody still queuing when the
        recording stops. The ten-run study in part two divides by every driver who entered instead,
        and its percentages are the lower ones.
      </p>
    </section>
  );
}

/** Frame the single junction so it fills a full-width stage. */
function frameJunction(engine: VizEngine): void {
  const view = engine.getView(0);
  if (!view) return;
  const b = view.bounds;
  const narrow = typeof window !== "undefined" && window.innerWidth < NARROW_PX;
  // One view across the whole stage, not half of a split, so the camera sits
  // closer than the comparison's and still holds every approach road in shot —
  // on a phone too, where the split had to pull right back.
  const d = Math.max(b.extent, 60) * (narrow ? 0.54 : 0.42);
  engine.setCameraPose(
    { x: b.centerX, z: -b.centerY },
    { x: b.centerX + d * 0.26, y: d * 0.85, z: -b.centerY + d * 0.45 },
  );
}
