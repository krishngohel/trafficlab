"use client";

import { useEffect } from "react";

import { CLIP_RESULT, CLIP_SAVED, METRO, SIDE_LABELS } from "@/lib/demo/story";
import { formatClock } from "@/lib/demo/format";
import { formatSaved } from "@/lib/demo/savings";
import styles from "./Demo.module.css";

/**
 * The ten-second explainer. It sits over the page on arrival, says in ordinary
 * words what the visitor is about to watch, and gets out of the way. Loading
 * carries on behind it, so dismissing it lands straight on a playing clip.
 */
export default function IntroCard({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className={styles.introBackdrop} role="dialog" aria-modal="true" aria-label="What you are about to watch">
      <div className={styles.intro}>
        <h2 className={styles.introTitle}>The same ten minutes, twice</h2>
        <div className={styles.introBody}>
          <p>
            You are about to watch one busy junction, simulated twice, side by side. Both runs get
            the <strong>same cars, the same drivers and the same arrivals, to the second</strong>.
            The only thing that differs is how the traffic light makes up its mind.
          </p>
          <div className={styles.introSplit}>
            <div
              className={styles.introSide}
              style={{ "--tone": "var(--fixed)" } as React.CSSProperties}
            >
              <span className={styles.introSideName}>Left · {SIDE_LABELS.fixed}</span>
              Green for a set time, then the next direction, over and over. Every driver on this
              side is stuck at a light that cannot see them.
            </div>
            <div
              className={styles.introSide}
              style={{ "--tone": "var(--responsive)" } as React.CSSProperties}
            >
              <span className={styles.introSideName}>Right · {SIDE_LABELS.responsive}</span>
              It senses the traffic waiting: it holds the green while cars are still coming and ends
              it once the road is clear.
            </div>
          </div>
          <p>
            Over these ten minutes the responsive light spares its drivers{" "}
            <strong>{formatSaved(CLIP_SAVED.savedSeconds)}</strong> of waiting between them —
            average wait down from <strong>{formatClock(CLIP_RESULT.fixedWaitSeconds)}</strong> to{" "}
            <strong>{formatClock(CLIP_RESULT.responsiveWaitSeconds)}</strong> a driver, and still{" "}
            <strong>{CLIP_RESULT.responsiveCars} cars</strong> through the junction instead of{" "}
            <strong>{CLIP_RESULT.fixedCars}</strong>. More traffic, less waiting.
          </p>
        </div>
        <button className={styles.introBtn} onClick={onDismiss} autoFocus>
          Watch it
        </button>
        <p className={styles.introFoot}>
          The numbers on the page are read live out of the simulation as it plays. Further down,
          the same responsive light runs at {METRO.intersections} junctions at once.
        </p>
      </div>
    </div>
  );
}
