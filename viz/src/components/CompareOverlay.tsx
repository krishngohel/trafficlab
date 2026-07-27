"use client";

import { useEffect, useRef } from "react";

import { formatCompact } from "@/lib/series";
import type { SideInfo, VizEngine } from "@/lib/viz/engine";
import styles from "./Viewer.module.css";

interface Props {
  engine: VizEngine;
  infoA: SideInfo;
  infoB: SideInfo;
}

/**
 * Split-screen chrome: per-side policy chips with live delay/throughput
 * numbers, and the draggable divider. Chip stats and positions are written
 * to the DOM directly (afterFrame + pointer events), never through state.
 */
export default function CompareOverlay({ engine, infoA, infoB }: Props) {
  const dividerRef = useRef<HTMLDivElement>(null);
  const chipBRef = useRef<HTMLDivElement>(null);
  const statsARef = useRef<HTMLSpanElement>(null);
  const statsBRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const sides = [
      { side: 0 as const, ref: statsARef },
      { side: 1 as const, ref: statsBRef },
    ];
    const sync = () => {
      for (const { side, ref } of sides) {
        const view = engine.getView(side);
        const el = ref.current;
        if (!view || !el) continue;
        const delay = view.metricAt(engine.clock, view.delayCol);
        const thru = view.metricAt(engine.clock, view.throughputCol);
        const text = `delay ${Number.isNaN(delay) ? "–" : formatCompact(delay)} · thru ${
          Number.isNaN(thru) ? "–" : formatCompact(thru)
        }`;
        if (el.textContent !== text) el.textContent = text;
      }
    };
    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine]);

  const applySplit = () => {
    const pct = engine.split * 100;
    if (dividerRef.current) dividerRef.current.style.left = `${pct}%`;
    if (chipBRef.current) chipBRef.current.style.left = `calc(${pct}% + 14px)`;
  };

  const initialPct = engine.split * 100;
  return (
    <>
      <div className={styles.chip} style={{ left: 12 }}>
        <span className={styles.chipName}>
          A · {infoA.policy} · {infoA.networkName}
        </span>
        <span ref={statsARef} className={styles.chipStats} />
      </div>
      <div ref={chipBRef} className={styles.chip} style={{ left: `calc(${initialPct}% + 14px)` }}>
        <span className={styles.chipName}>
          B · {infoB.policy} · {infoB.networkName}
        </span>
        <span ref={statsBRef} className={styles.chipStats} />
      </div>
      <div
        ref={dividerRef}
        className={styles.divider}
        style={{ left: `${initialPct}%` }}
        title="Drag to resize the split"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const parent = e.currentTarget.parentElement;
          if (!parent) return;
          const rect = parent.getBoundingClientRect();
          engine.setSplit((e.clientX - rect.left) / Math.max(rect.width, 1));
          applySplit();
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      />
    </>
  );
}
