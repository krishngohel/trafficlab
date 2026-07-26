"""Single-core throughput benchmark. Target: >= 10k vehicle-steps/s."""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from trafficlab.network import Network                      # noqa: E402
from trafficlab.signals import FixedCycleController         # noqa: E402
from trafficlab.simulator import Simulator                  # noqa: E402


def bench(network: str, demand: str, duration: float = 300.0, seed: int = 0) -> tuple[float, int]:
    net = Network.from_config(json.loads((ROOT / "configs/networks" / f"{network}.json").read_text()))
    sim = Simulator(net, json.loads((ROOT / "configs/demand" / f"{demand}.json").read_text()),
                    seed=seed, network_name=network)
    controllers = [FixedCycleController(sim.units[i],
                   [8.0 if ph.name.endswith("L") else 20.0 for ph in sim.net.intersections[i].phases])
                   for i in sorted(sim.units)]
    ticks = int(duration / sim.dt)
    steps = 0
    peak = 0
    t0 = time.perf_counter()
    for _ in range(ticks):
        for c in controllers:
            c.step()
        sim.step()
        steps += len(sim.vehicles)
        peak = max(peak, len(sim.vehicles))
    wall = time.perf_counter() - t0
    return steps / wall, peak


if __name__ == "__main__":
    total_rate = 0.0
    for network, demand in [("single", "heavy"), ("grid2x2", "rush"),
                            ("grid4x4", "heavy"), ("arterial6", "rush")]:
        rate, peak = bench(network, demand)
        total_rate += rate
        status = "PASS" if rate >= 10_000 else "FAIL"
        print(f"{status}  {network:10s} {demand:6s}  {rate:>10,.0f} veh-steps/s  (peak {peak} vehicles)")
    print(f"mean: {total_rate / 4:,.0f} veh-steps/s")
