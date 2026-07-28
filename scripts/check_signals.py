"""Audit a .traj: is every intersection actually being controlled?

A recording can look busy while an intersection sits frozen on one phase (a
controller that never fires, a phase set the policy never selects, an approach
that never gets a green). This walks the signal channel and reports, per
intersection, how many distinct phases it served, how many green onsets it had,
and whether any approach was starved — then exits non-zero if any intersection
failed the check.

  python scripts/check_signals.py results/trajectories/city.traj
"""
import argparse
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from trafficlab.trajectory import SIGNAL_GREEN, TrajectoryReader  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--min-phases", type=int, default=2,
                    help="distinct phases each intersection must serve")
    ap.add_argument("--min-changes", type=int, default=3,
                    help="green onsets each intersection must have")
    args = ap.parse_args()

    reader = TrajectoryReader(args.path)
    order = reader.meta["intersections_order"]
    ix_by_id = {ix["id"]: ix for ix in reader.meta["network"]["intersections"]}

    phases_seen: dict[int, set[int]] = defaultdict(set)
    green_onsets: dict[int, int] = defaultdict(int)
    green_ticks: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    prev: dict[int, tuple[int, int]] = {}

    for frame in reader:
        sig = frame.signals
        for j, ix_id in enumerate(order):
            phase = int(sig["phase"][j])
            state = int(sig["state"][j])
            if state == SIGNAL_GREEN:
                phases_seen[ix_id].add(phase)
                green_ticks[ix_id][phase] += 1
            was = prev.get(ix_id)
            if was is not None and (phase, state) != was and state == SIGNAL_GREEN:
                if was[0] != phase or was[1] != SIGNAL_GREEN:
                    green_onsets[ix_id] += 1
            prev[ix_id] = (phase, state)

    dt = reader.meta["dt"]
    print(f"{reader.meta['network_name']} · {reader.meta['policy']} · "
          f"{reader.num_frames} frames · {len(order)} intersections")
    print(f"{'ix':>4}  {'phases':>12}  {'served':>6}  {'onsets':>6}  "
          f"{'green share of each phase':<34}  status")

    failures = []
    for ix_id in order:
        defined = len(ix_by_id[ix_id]["phases"])
        names = [p["name"] for p in ix_by_id[ix_id]["phases"]]
        served = len(phases_seen[ix_id])
        onsets = green_onsets[ix_id]
        total = sum(green_ticks[ix_id].values()) or 1
        share = "  ".join(
            f"{names[p]}:{100 * green_ticks[ix_id][p] / total:.0f}%"
            for p in range(defined)
        )
        bad = []
        if served < min(args.min_phases, defined):
            bad.append(f"only {served}/{defined} phases served")
        if onsets < args.min_changes:
            bad.append(f"{onsets} green onsets")
        starved = [names[p] for p in range(defined) if green_ticks[ix_id][p] == 0]
        if starved:
            bad.append("never green: " + ",".join(starved))
        status = "ok" if not bad else "FAIL " + "; ".join(bad)
        if bad:
            failures.append(ix_id)
        print(f"{ix_id:>4}  {served:>4}/{defined:<7}  {total * dt:>5.0f}s  "
              f"{onsets:>6}  {share:<34}  {status}")

    if failures:
        print(f"\n{len(failures)} intersection(s) not actively controlled: {failures}")
        sys.exit(1)
    print(f"\nall {len(order)} intersections actively controlled")


if __name__ == "__main__":
    main()
