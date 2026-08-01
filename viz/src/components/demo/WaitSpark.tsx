"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { drawSpark } from "@/lib/demo/spark";
import type { WaitAxis } from "@/lib/demo/rolling";
import styles from "./Demo.module.css";

export interface SparkHandle {
  /** Repaint with the clip played up to `playhead` seconds. */
  draw(playhead: number): void;
}

/**
 * The canvas the rolling wait is drawn on.
 *
 * It holds no React state and never re-renders while the clip plays: the parent
 * takes a handle and calls `draw()` from the engine's frame hook, the same way
 * every other live number on this page is written straight to the DOM. Resizing
 * repaints at the last playhead it was given, so a rotated phone does not blank
 * the chart until the next frame.
 */
export default function WaitSpark({
  series,
  dt,
  duration,
  axis,
  switchAt,
  windowSeconds,
  formatValue,
  handleRef,
  label,
}: {
  series: Float64Array | null;
  dt: number;
  duration: number;
  axis: WaitAxis;
  switchAt: number;
  windowSeconds: number;
  formatValue: (seconds: number) => string;
  handleRef: MutableRefObject<SparkHandle | null>;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playhead = useRef(0);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !series) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    // Cap the device ratio the same way the WebGL renderer does: a 3x phone
    // gains nothing legible from a 3x backing store for ten-pixel type.
    const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
    const wantW = Math.round(width * dpr);
    const wantH = Math.round(height * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSpark(ctx, {
      width,
      height,
      series,
      dt,
      duration,
      axis,
      switchAt,
      windowSeconds,
      playhead: playhead.current,
      formatValue,
    });
  }, [series, dt, duration, axis, switchAt, windowSeconds, formatValue]);

  useEffect(() => {
    handleRef.current = {
      draw(t: number) {
        playhead.current = t;
        paint();
      },
    };
    paint();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      handleRef.current = null;
    };
  }, [handleRef, paint]);

  return (
    <canvas ref={canvasRef} className={styles.spark} role="img" aria-label={label} />
  );
}
