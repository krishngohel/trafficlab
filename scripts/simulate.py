"""Run a simulation with a signal controller and record a .traj file.

Usage:
  python scripts/simulate.py --network grid2x2 --demand rush --controller fixed \
      --duration 600 --seed 0 --out results/trajectories/demo.traj
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from trafficlab.network import Network                      # noqa: E402
from trafficlab.signals import FixedCycleController         # noqa: E402
from trafficlab.simulator import Simulator                  # noqa: E402


def load_json(kind: str, name: str) -> dict:
    p = Path(name)
    if not p.exists():
        p = ROOT / "configs" / kind / f"{name}.json"
    return json.loads(p.read_text())


def default_greens(ix) -> list[float]:
    return [8.0 if ph.name.endswith("L") else 20.0 for ph in ix.phases]


def build_controllers(sim: Simulator, kind: str):
    if kind == "fixed":
        return [FixedCycleController(sim.units[i], default_greens(sim.net.intersections[i]))
                for i in sorted(sim.units)]
    from trafficlab import baselines  # M3
    return baselines.build(kind, sim)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", default="single")
    ap.add_argument("--demand", default="rush")
    ap.add_argument("--controller", default="fixed")
    ap.add_argument("--duration", type=float, default=600.0, help="seconds of sim time")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    net = Network.from_config(load_json("networks", args.network))
    sim = Simulator(net, load_json("demand", args.demand), seed=args.seed,
                    network_name=args.network)
    if args.out:
        sim.attach_writer(args.out, policy=args.controller)
    controllers = build_controllers(sim, args.controller)
    ticks = int(round(args.duration / sim.dt))
    t0 = time.perf_counter()
    steps = 0
    for _ in range(ticks):
        for c in controllers:
            c.step()
        sim.step()
        steps += len(sim.vehicles)
    wall = time.perf_counter() - t0
    sim.close()
    print(f"{args.network}/{args.demand}/{args.controller} seed={args.seed}: "
          f"{ticks} ticks, {sim.spawned} spawned, {sim.departed} departed, "
          f"delay={sim.cum_delay:.0f} veh·s, {steps / max(wall, 1e-9):,.0f} veh-steps/s")
    if args.out:
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
