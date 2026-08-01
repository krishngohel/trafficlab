/**
 * The chart that carries the argument: a rolling wait against clip time, flat
 * and high while the fixed timer runs, then stepping down when the responsive
 * signal takes the junction over.
 *
 * Hand-drawn on a 2D canvas rather than pulled in from a charting library: the
 * whole thing is four lines, a marker and two labels, and the page already ships
 * a WebGL renderer without also shipping a chart runtime.
 *
 * The geometry is separated from the painting so the scales are unit tested —
 * `plot()` is pure arithmetic, `drawSpark()` is the only thing that touches a
 * canvas context. The palette mirrors Demo.module.css by hand because a canvas
 * cannot inherit CSS custom properties; the comment beside each colour names the
 * variable it must stay in step with.
 */

import { meanOverSeconds, type WaitAxis } from "./rolling";

export const SPARK_COLORS = {
  /** --edge */
  grid: "#232b38",
  /** --ink-faint */
  axisText: "#6d7683",
  /** --fixed */
  fixed: "#d9a24a",
  /** --responsive */
  responsive: "#5ac2a0",
  /** --surface-soft */
  panel: "#0e1218",
  /** --ink-dim */
  label: "#98a1ae",
} as const;

/** Room for the y-axis labels on the left and the level labels on the right. */
export const SPARK_PAD = { left: 40, right: 8, top: 12, bottom: 18 } as const;

export interface PlotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The drawable rectangle inside a canvas of this CSS size. */
export function plotBox(width: number, height: number): PlotBox {
  const x = SPARK_PAD.left;
  const y = SPARK_PAD.top;
  return {
    x,
    y,
    width: Math.max(1, width - SPARK_PAD.left - SPARK_PAD.right),
    height: Math.max(1, height - SPARK_PAD.top - SPARK_PAD.bottom),
  };
}

/** Clip seconds -> canvas x. */
export function plotX(seconds: number, duration: number, box: PlotBox): number {
  const span = duration > 0 ? duration : 1;
  const t = Math.min(Math.max(seconds / span, 0), 1);
  return box.x + t * box.width;
}

/** Wait seconds -> canvas y. Values outside the axis clamp to its edges. */
export function plotY(value: number, axis: WaitAxis, box: PlotBox): number {
  const span = axis.hi - axis.lo || 1;
  const t = Math.min(Math.max((value - axis.lo) / span, 0), 1);
  return box.y + (1 - t) * box.height;
}

export interface SparkSpec {
  /** CSS pixel size of the canvas. */
  width: number;
  height: number;
  /** The rolling series, one value per frame, NaN where undefined. */
  series: ArrayLike<number>;
  dt: number;
  duration: number;
  axis: WaitAxis;
  /** Clip second at which the responsive signal takes over. */
  switchAt: number;
  /** Length of the trailing window each point of the series covers. */
  windowSeconds: number;
  /** How far the clip has played, in seconds. Nothing later is drawn. */
  playhead: number;
  /** "3m 53s" for a level line's label. */
  formatValue: (seconds: number) => string;
}

/**
 * The two reference levels, computed from what has been PLAYED rather than
 * from the whole file.
 *
 * The clip loops, so a level revealed only at the final frame would never
 * actually be seen; and a level averaged over frames the visitor has not
 * reached yet would be the chart quietly reading ahead. Both are therefore
 * running means over the windows that lie entirely inside their own regime and
 * entirely behind the playhead. NaN means "not enough watched yet to say", and
 * the caller draws nothing.
 */
export function sparkLevels(spec: SparkSpec): { before: number; after: number } {
  const { series, dt, switchAt, windowSeconds, playhead } = spec;
  const before =
    playhead >= switchAt
      ? meanOverSeconds(series, dt, windowSeconds, switchAt)
      : NaN;
  // One window to fill and one to average: below that the "after" level is a
  // single noisy sample wearing the clothes of an average.
  const after =
    playhead >= switchAt + 2 * windowSeconds
      ? meanOverSeconds(series, dt, switchAt + windowSeconds, playhead)
      : NaN;
  return { before, after };
}

/**
 * Paint the chart. The caller owns the DPR transform: set the backing store to
 * `size * dpr`, `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`, then call this with
 * CSS pixel sizes.
 *
 * Only the part of the series behind the playhead is drawn, so the line grows
 * as the clip plays and a visitor watches the step happen rather than arriving
 * at a finished picture.
 */
export function drawSpark(ctx: CanvasRenderingContext2D, spec: SparkSpec): void {
  const { width, height, series, dt, duration, axis, switchAt, playhead } = spec;
  const box = plotBox(width, height);
  const step = dt > 0 ? dt : 0.5;

  ctx.clearRect(0, 0, width, height);

  // --- gridlines and the y scale ------------------------------------------
  ctx.lineWidth = 1;
  ctx.strokeStyle = SPARK_COLORS.grid;
  ctx.fillStyle = SPARK_COLORS.axisText;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const tick of axis.ticks) {
    const y = Math.round(plotY(tick, axis, box)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.width, y);
    ctx.stroke();
    ctx.fillText(spec.formatValue(tick), box.x - 6, y);
  }

  // --- the moment the light changes ----------------------------------------
  const switchX = Math.round(plotX(switchAt, duration, box)) + 0.5;
  const reached = playhead >= switchAt;
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = reached ? SPARK_COLORS.responsive : SPARK_COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(switchX, box.y);
  ctx.lineTo(switchX, box.y + box.height);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = reached ? SPARK_COLORS.responsive : SPARK_COLORS.axisText;
  ctx.fillText("light changes", switchX + 5, box.y + 1);

  // --- the two averages, each carried across the rest of the chart ---------
  // The fixed timer's line runs the full width on purpose: once the responsive
  // signal has the junction, the thing worth seeing is its line sitting under
  // the level the timer used to hold.
  const levels = sparkLevels(spec);
  const level = (value: number, colour: string, from: number) => {
    if (!Number.isFinite(value)) return;
    const y = Math.round(plotY(value, axis, box)) + 0.5;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX(from, duration, box), y);
    ctx.lineTo(box.x + box.width, y);
    ctx.stroke();
    ctx.restore();
  };
  level(levels.before, SPARK_COLORS.fixed, 0);
  level(levels.after, SPARK_COLORS.responsive, switchAt + spec.windowSeconds);

  // --- the series itself, in two colours -----------------------------------
  const lastFrame = Math.min(series.length - 1, Math.floor(playhead / step));
  const stroke = (fromFrame: number, toFrame: number, colour: string) => {
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let open = false;
    for (let f = fromFrame; f <= toFrame; f++) {
      const v = series[f];
      if (!Number.isFinite(v)) {
        open = false;
        continue;
      }
      const x = plotX(f * step, duration, box);
      const y = plotY(v, axis, box);
      if (open) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      open = true;
    }
    ctx.stroke();
  };
  const switchFrame = Math.round(switchAt / step);
  stroke(0, Math.min(lastFrame, switchFrame), SPARK_COLORS.fixed);
  if (lastFrame > switchFrame) {
    // Start one frame early so the two colours meet instead of leaving a gap.
    stroke(Math.max(0, switchFrame - 1), lastFrame, SPARK_COLORS.responsive);
  }

  // --- level captions, last so nothing draws over them ---------------------
  // Each sits on a chip of the panel colour, because the live line runs right
  // through where they land and unbacked text on top of it is unreadable.
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const caption = (value: number, colour: string, text: string, dy: number) => {
    if (!Number.isFinite(value)) return;
    const y = plotY(value, axis, box) + dy;
    const right = box.x + box.width;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = SPARK_COLORS.panel;
    ctx.fillRect(right - w - 5, y - 7, w + 6, 14);
    ctx.fillStyle = colour;
    ctx.fillText(text, right - 2, y);
  };
  caption(
    levels.before,
    SPARK_COLORS.fixed,
    `fixed timer, average ${spec.formatValue(levels.before)}`,
    -9,
  );
  caption(
    levels.after,
    SPARK_COLORS.responsive,
    `responsive, average ${spec.formatValue(levels.after)}`,
    10,
  );

  // --- x scale --------------------------------------------------------------
  ctx.fillStyle = SPARK_COLORS.axisText;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("0:00", box.x, box.y + box.height + 4);
  ctx.textAlign = "right";
  const mins = Math.round(duration / 60);
  ctx.fillText(`${mins}:00`, box.x + box.width, box.y + box.height + 4);
}
