"use client";

import { useEffect, useRef } from "react";

import type { VizEngine } from "@/lib/viz/engine";
import styles from "./Viewer.module.css";

interface Props {
  engine: VizEngine;
  /** Anchored under the mean-wait chip in compare mode, top-left otherwise. */
  compare: boolean;
}

/** DOM writes per second. The meter is smoothed; 4 Hz is plenty to read. */
const HZ = 4;

/** Below this the scene no longer feels smooth; below half, it stutters. */
const GOOD_FPS = 55;
const BAD_FPS = 28;

function tone(fps: number): "good" | "bad" | "flat" {
  if (fps >= GOOD_FPS) return "good";
  if (fps < BAD_FPS) return "bad";
  return "flat";
}

/**
 * Frame-rate chip: smoothed fps, frame time, the worst frame of the last
 * second, and the renderer's draw-call count — the four numbers this project
 * actually tunes against (the scene budgets are in draw calls).
 *
 * Like the rest of the HUD it is written straight to the DOM from the engine's
 * afterFrame hook, so a running counter never re-renders React.
 */
export default function FpsHud({ engine, compare }: Props) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let last = 0;
    const sync = () => {
      const now = performance.now();
      if (now - last < 1000 / HZ) return;
      last = now;

      const { fpsMeter } = engine;
      const fps = fpsMeter.fps;
      const value = valueRef.current;
      if (value) {
        const text = fps > 0 ? `${Math.round(fps)} fps` : "–";
        if (value.textContent !== text) value.textContent = text;
        const t = tone(fps);
        if (value.dataset.tone !== t) value.dataset.tone = t;
      }

      const meta = metaRef.current;
      if (meta) {
        const worst = fpsMeter.worstFrameMs;
        const text =
          fps > 0
            ? `${fpsMeter.frameMs.toFixed(1)} ms · ${worst.toFixed(0)} peak · ` +
              `${engine.renderStats().calls} draws`
            : "";
        if (meta.textContent !== text) meta.textContent = text;
      }
    };

    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine]);

  return (
    <div
      className={`${styles.waitChip} ${styles.fpsChip}`}
      style={{ left: 12, top: compare ? 114 : 66 }}
      title="Smoothed frame rate, mean frame time, worst frame of the last second, and draw calls"
    >
      <span className={styles.waitLabel}>Render</span>
      <span className={styles.waitRow}>
        <span ref={valueRef} className={styles.waitValue}>
          –
        </span>
      </span>
      <span ref={metaRef} className={styles.fpsMeta} />
    </div>
  );
}
