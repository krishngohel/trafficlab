"use client";

import { useCallback, useEffect, useRef } from "react";

import type { VizEngine } from "@/lib/viz/engine";
import {
  formatSignedPct,
  formatTrend,
  formatWait,
  hasWaitColumns,
  meanWaitTrend,
  relativeDelta,
} from "@/lib/wait";
import styles from "./Viewer.module.css";

interface Props {
  engine: VizEngine;
  /** True while a second file is loaded (split view). */
  compare: boolean;
}

/** Trailing window, in seconds of sim time, for the trend arrow. */
const TREND_WINDOW = 60;
/** HUD refresh cap (4 Hz) — the numbers change far slower than the frame rate. */
const REFRESH_MS = 250;

/** Every element the sync loop writes to, filled in by ref callbacks. */
interface Handles {
  groupB: HTMLDivElement | null;
  deltaBox: HTMLDivElement | null;
  delta: HTMLSpanElement | null;
  value: [HTMLSpanElement | null, HTMLSpanElement | null];
  trend: [HTMLSpanElement | null, HTMLSpanElement | null];
}

function StatChip({
  label,
  style,
  className,
  boxRef,
  valueRef,
  trendRef,
  title,
}: {
  label: string;
  style: React.CSSProperties;
  className?: string;
  boxRef?: (el: HTMLDivElement | null) => void;
  valueRef: (el: HTMLSpanElement | null) => void;
  trendRef?: (el: HTMLSpanElement | null) => void;
  title?: string;
}) {
  return (
    <div
      ref={boxRef}
      className={`${styles.waitChip} ${className ?? ""}`}
      style={style}
      title={title}
    >
      <span className={styles.waitLabel}>{label}</span>
      <span className={styles.waitRow}>
        <span ref={valueRef} className={styles.waitValue}>
          –
        </span>
        {trendRef && <span ref={trendRef} className={styles.waitTrend} />}
      </span>
    </div>
  );
}

/**
 * Mean-wait stat chips. Single view: one chip in the top-left corner. Compare:
 * one chip per side, anchored to its half, plus a "B vs A" verdict chip on the
 * left half's inner edge.
 *
 * Like the rest of the HUD these are written straight to the DOM from the
 * engine's afterFrame hook (throttled to 4 Hz) so playback and scrubbing never
 * trigger React renders.
 */
export default function WaitHud({ engine, compare }: Props) {
  const h = useRef<Handles>({
    groupB: null,
    deltaBox: null,
    delta: null,
    value: [null, null],
    trend: [null, null],
  });

  const setGroupB = useCallback((el: HTMLDivElement | null) => {
    h.current.groupB = el;
  }, []);
  const setDeltaBox = useCallback((el: HTMLDivElement | null) => {
    h.current.deltaBox = el;
  }, []);
  const setDelta = useCallback((el: HTMLSpanElement | null) => {
    h.current.delta = el;
  }, []);
  const setValueA = useCallback((el: HTMLSpanElement | null) => {
    h.current.value[0] = el;
  }, []);
  const setValueB = useCallback((el: HTMLSpanElement | null) => {
    h.current.value[1] = el;
  }, []);
  const setTrendA = useCallback((el: HTMLSpanElement | null) => {
    h.current.trend[0] = el;
  }, []);
  const setTrendB = useCallback((el: HTMLSpanElement | null) => {
    h.current.trend[1] = el;
  }, []);

  useEffect(() => {
    let last = 0;
    let lastSplit = -1;

    const write = (el: HTMLElement | null, text: string, tone: string) => {
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      if (el.dataset.tone !== tone) el.dataset.tone = tone;
    };
    const tone = (pct: number) =>
      !Number.isFinite(pct) || Math.abs(pct) < 0.05 ? "flat" : pct < 0 ? "good" : "bad";

    const sync = () => {
      const handles = h.current;
      // Keep the compare chips glued to the divider even mid-drag (cheap).
      if (compare && engine.split !== lastSplit) {
        lastSplit = engine.split;
        const pct = lastSplit * 100;
        if (handles.groupB) handles.groupB.style.left = `calc(${pct}% + 14px)`;
        if (handles.deltaBox) handles.deltaBox.style.right = `calc(${100 - pct}% + 14px)`;
      }

      const now = performance.now();
      if (now - last < REFRESH_MS) return;
      last = now;

      const values: number[] = [NaN, NaN];
      for (let side = 0 as 0 | 1; side < 2; side = (side + 1) as 0 | 1) {
        const valueEl = handles.value[side];
        if (!valueEl) continue;
        const view = engine.getView(side);
        if (!view || !hasWaitColumns(view.waitCols)) {
          write(valueEl, "–", "flat");
          write(handles.trend[side], "", "flat");
          continue;
        }
        const trend = meanWaitTrend(
          view.scan,
          view.waitCols,
          view.frameIndexAt(engine.clock),
          TREND_WINDOW,
        );
        values[side] = trend.value;
        write(valueEl, formatWait(trend.value), "flat");
        const arrow = formatTrend(trend.pct);
        write(
          handles.trend[side],
          Number.isFinite(trend.pct) ? `${arrow} / ${TREND_WINDOW}s` : arrow,
          tone(trend.pct),
        );
      }

      if (compare && handles.delta) {
        const pct = relativeDelta(values[0], values[1]);
        write(handles.delta, formatSignedPct(pct), tone(pct));
      }
    };

    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine, compare]);

  if (!compare) {
    return (
      <StatChip
        label="Mean wait"
        style={{ left: 12, top: 12 }}
        valueRef={setValueA}
        trendRef={setTrendA}
        title={`Cumulative delay per vehicle seen so far, and its change over the trailing ${TREND_WINDOW} s of sim time`}
      />
    );
  }

  const initial = engine.split * 100;
  return (
    <>
      <StatChip
        label="A · mean wait"
        style={{ left: 12, top: 60 }}
        valueRef={setValueA}
        trendRef={setTrendA}
      />
      <StatChip
        label="B · mean wait"
        style={{ left: `calc(${initial}% + 14px)`, top: 60 }}
        boxRef={setGroupB}
        valueRef={setValueB}
        trendRef={setTrendB}
      />
      <StatChip
        label="B vs A"
        className={styles.waitDelta}
        style={{ right: `calc(${100 - initial}% + 14px)`, top: 12 }}
        boxRef={setDeltaBox}
        valueRef={setDelta}
        title="Mean wait of B relative to A at the shared playhead (green = B waits less)"
      />
    </>
  );
}
