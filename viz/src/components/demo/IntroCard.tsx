"use client";

import { useEffect } from "react";

import { METRO, SIDE_LABELS, SWITCH_CLIP, SWITCH_RESULT } from "@/lib/demo/story";
import { formatClock } from "@/lib/demo/format";
import styles from "./Demo.module.css";

/**
 * The ten-second explainer. It sits over the page on arrival, says in ordinary
 * words what the visitor is about to watch, and gets out of the way. Loading
 * carries on behind it and the clip waits at its first frame, so dismissing it
 * starts the ten minutes from the beginning rather than dropping into the
 * middle of them.
 */
export default function IntroCard({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const switchClock = `${Math.floor(SWITCH_CLIP.switchAtSeconds / 60)}:00`;

  return (
    <div
      className={styles.introBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="What you are about to watch"
    >
      <div className={styles.intro}>
        <h2 className={styles.introTitle}>One junction, ten minutes, and a light that changes</h2>
        <div className={styles.introBody}>
          <p>
            You are about to watch a single busy junction for ten minutes. It is{" "}
            <strong>one continuous recording</strong> — the same map, the same drivers, the same
            heavy traffic throughout. Halfway through, the only thing that changes is the rule the
            traffic light follows.
          </p>
          <div className={styles.introSplit}>
            <div
              className={styles.introSide}
              style={{ "--tone": "var(--fixed)" } as React.CSSProperties}
            >
              <span className={styles.introSideName}>First five minutes · {SIDE_LABELS.fixed}</span>
              Green for a set time, then the next direction, over and over. Every driver here is
              stuck at a light that cannot see them.
            </div>
            <div
              className={styles.introSide}
              style={{ "--tone": "var(--responsive)" } as React.CSSProperties}
            >
              <span className={styles.introSideName}>
                From {switchClock} · {SIDE_LABELS.responsive}
              </span>
              It senses the traffic waiting: it holds the green while cars are still coming and ends
              it once the road is clear.
            </div>
          </div>
          <p>
            Watch the big number. It is the waiting this junction generates each minute, shared out
            between the drivers who get through it — and when the light changes hands it falls, from
            about <strong>{formatClock(SWITCH_RESULT.beforeWaitSeconds)}</strong> a driver to about{" "}
            <strong>{formatClock(SWITCH_RESULT.afterWaitSeconds)}</strong>, while{" "}
            <strong>more</strong> drivers get through each minute, not fewer.
          </p>
        </div>
        <button className={styles.introBtn} onClick={onDismiss} autoFocus>
          Watch it
        </button>
        <p className={styles.introFoot}>
          Every number on the page is read live out of the simulation as it plays. Further down, the
          same two lights run side by side as a controlled comparison, and then at{" "}
          {METRO.intersections} junctions at once.
        </p>
      </div>
    </div>
  );
}
