"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

import { METRO, REPO_URL } from "@/lib/demo/story";
import CityScale from "./CityScale";
import Compare from "./Compare";
import IntroCard from "./IntroCard";
import WaitFalls from "./WaitFalls";
import styles from "./Demo.module.css";

/**
 * The public showcase, in three parts.
 *
 * ONE — the waiting comes down. A single junction, a single continuous
 * recording, the light changing hands halfway through, and a reading that
 * visibly falls when it does. This leads because it is the question a visitor
 * arrives with: does this make people wait less. The page used to lead with a
 * cumulative saved-waiting counter and two running averages, none of which
 * could ever move downwards, so nothing on screen demonstrated the claim.
 *
 * TWO — the controlled experiment. The same junction run twice, one light each,
 * side by side. Stronger evidence, weaker demonstration, so it comes second.
 *
 * THREE — the same test at a hundred junctions at once.
 *
 * Only part one loads on arrival (5 MB); the other two fetch their recordings
 * on a click, so the landing view is now lighter than it was before part one
 * existed. Each part owns its own engine and its own numbers, and every figure
 * on the page is read out of the file it is describing.
 */
export default function Demo() {
  const [intro, setIntro] = useState(true);
  const dismissIntro = useCallback(() => setIntro(false), []);

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <span className={styles.mark}>trafficlab</span>
          <nav className={styles.topLinks}>
            <a href="#compare">See the side-by-side</a>
            <a href="#city">See it at city scale</a>
            <Link href="/studio" prefetch={false}>
              Open the research tool
            </Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
          </nav>
        </header>

        <WaitFalls holdAtStart={intro} />
        <Compare />
        <CityScale />

        <p className={styles.smallprint}>
          The responsive light is not artificial intelligence and there is no machine learning in
          it. It is a piece of classical engineering that has been in the ground for decades: a
          detector at the stop line, and a rule about when to let the green run on. This project
          also built controllers that learn from experience, and they did not beat it. Everything
          you see is a simulation — real junctions bring pedestrians, buses, breakdowns and weather
          that this model does not. Every figure on this page, including the{" "}
          {METRO.intersections}-junction one, comes from recordings you can regenerate from the
          source with a seed and a command.
        </p>

        <footer className={styles.footer}>
          <Link href="/studio" prefetch={false}>
            Open the full research tool
          </Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </footer>
      </div>

      {intro && <IntroCard onDismiss={dismissIntro} />}
    </div>
  );
}
