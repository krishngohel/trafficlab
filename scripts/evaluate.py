"""Evaluation suite: all policies x networks x demand profiles x seeds.

Baselines run the simulator directly; RL policies are loaded from runs/<name>/
(config.json + ckpt_latest.pt per docs/RL_DESIGN.md) and act greedily.

  python scripts/evaluate.py --networks single grid2x2 --demands light rush \
      --policies fixed webster actuated max_pressure --seeds 10 \
      --runs runs/ippo_single_rush_pressure_s0 --out results/eval.csv

Emits one CSV row per episode and prints a mean +/- 95% CI summary table.
Use --record-dir to also dump seed-0 trajectories per cell.
"""
import argparse
import csv
import importlib
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

EPISODE_SECONDS = 3600.0
BASELINES = ("fixed", "webster", "actuated", "max_pressure")


def eval_baseline(network: str, demand: str, policy: str, seed: int,
                  record: str | None) -> dict:
    from trafficlab import baselines
    from trafficlab.network import Network
    from trafficlab.simulator import Simulator
    net_cfg = json.loads((ROOT / "configs/networks" / f"{network}.json").read_text())
    dem_cfg = json.loads((ROOT / "configs/demand" / f"{demand}.json").read_text())
    sim = Simulator(Network.from_config(net_cfg), dem_cfg, seed=seed, network_name=network)
    if record:
        sim.attach_writer(record, policy=policy)
    controllers = baselines.build(policy, sim)
    ticks = int(EPISODE_SECONDS / sim.dt)
    queue_sum = 0.0
    samples = 0
    for tk in range(ticks):
        for c in controllers:
            c.step()
        sim.step()
        if tk % 10 == 0:
            queue_sum += float(sim.queues_by_approach().sum())
            samples += 1
    out = _row(network, demand, policy, seed, sim, queue_sum / max(samples, 1))
    sim.close()
    return out


def eval_rl(network: str, demand: str, run_dir: str, seed: int,
            record: str | None) -> dict:
    import torch
    from trafficlab.env import make_env
    run = Path(run_dir)
    cfg_dict = json.loads((run / "config.json").read_text())
    from trafficlab.rl.harness import RunConfig
    cfg = RunConfig(**{k: v for k, v in cfg_dict.items()
                       if k in RunConfig.__dataclass_fields__})
    policy_name = f"{cfg.algo}:{run.name}"
    env = make_env(network, demand, root=ROOT, reward=cfg.reward,
                   decision_interval=cfg.decision_interval,
                   episode_seconds=EPISODE_SECONDS)
    trainer = importlib.import_module(f"trafficlab.rl.{cfg.algo}").Trainer(cfg, env)
    ckpt = torch.load(run / "ckpt_latest.pt", map_location="cpu", weights_only=False)
    trainer.load_state_dict(ckpt["model"] if "model" in ckpt else ckpt)
    if record:
        env.record_next_episode(record, policy_label=policy_name)
    obs, infos = env.reset(seed=seed)
    queue_sum = 0.0
    samples = 0
    done = False
    while not done:
        actions = trainer.act(obs, infos, explore=False)
        obs, _rew, _term, trunc, infos = env.step(actions)
        queue_sum += float(env.sim.queues_by_approach().sum())
        samples += 1
        done = trunc["__all__"]
    out = _row(network, demand, policy_name, seed, env.sim, queue_sum / max(samples, 1))
    env.close()
    return out


def _row(network, demand, policy, seed, sim, mean_queue) -> dict:
    return {
        "network": network, "demand": demand, "policy": policy, "seed": seed,
        "spawned": sim.spawned, "throughput": sim.departed,
        "total_delay": round(sim.cum_delay, 1),
        "delay_per_vehicle": round(sim.cum_delay / max(sim.spawned, 1), 2),
        "mean_queue": round(mean_queue, 2),
    }


def _run_cell(args) -> dict:
    kind, network, demand, policy, seed, record = args
    if kind == "baseline":
        return eval_baseline(network, demand, policy, seed, record)
    return eval_rl(network, demand, policy, seed, record)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--networks", nargs="+", default=["single", "grid2x2", "grid4x4", "arterial6"])
    ap.add_argument("--demands", nargs="+", default=["light", "rush", "heavy"])
    ap.add_argument("--policies", nargs="+", default=list(BASELINES))
    ap.add_argument("--runs", nargs="*", default=[], help="RL run dirs to evaluate")
    ap.add_argument("--seeds", type=int, default=10)
    ap.add_argument("--processes", type=int, default=6)
    ap.add_argument("--out", default="results/eval.csv")
    ap.add_argument("--record-dir", default=None)
    args = ap.parse_args()

    jobs = []
    for network in args.networks:
        for demand in args.demands:
            for policy in args.policies:
                for seed in range(args.seeds):
                    rec = (f"{args.record_dir}/{network}_{demand}_{policy}_s{seed}.traj"
                           if args.record_dir and seed == 0 else None)
                    jobs.append(("baseline", network, demand, policy, seed, rec))
            for run_dir in args.runs:
                for seed in range(args.seeds):
                    rec = (f"{args.record_dir}/{network}_{demand}_{Path(run_dir).name}_s{seed}.traj"
                           if args.record_dir and seed == 0 else None)
                    jobs.append(("rl", network, demand, run_dir, seed, rec))

    print(f"{len(jobs)} evaluation episodes on {args.processes} processes...")
    rows = []
    with ProcessPoolExecutor(max_workers=args.processes) as pool:
        for i, row in enumerate(pool.map(_run_cell, jobs)):
            rows.append(row)
            if (i + 1) % 10 == 0:
                print(f"  {i + 1}/{len(jobs)}")

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {out}")

    # Summary with 95% CIs.
    import numpy as np
    cells: dict[tuple, list[dict]] = {}
    for r in rows:
        cells.setdefault((r["network"], r["demand"], r["policy"]), []).append(r)
    print(f"\n{'network':10s} {'demand':7s} {'policy':28s} {'delay/veh (s)':>16s} {'throughput':>14s}")
    for key in sorted(cells):
        rs = cells[key]
        d = np.array([r["delay_per_vehicle"] for r in rs], dtype=float)
        t = np.array([r["throughput"] for r in rs], dtype=float)
        ci_d = 1.96 * d.std(ddof=1) / max(len(d), 2) ** 0.5 if len(d) > 1 else 0.0
        ci_t = 1.96 * t.std(ddof=1) / max(len(t), 2) ** 0.5 if len(t) > 1 else 0.0
        print(f"{key[0]:10s} {key[1]:7s} {key[2]:28s} {d.mean():8.1f} ± {ci_d:5.1f} "
              f"{t.mean():9.0f} ± {ci_t:4.0f}")


if __name__ == "__main__":
    main()
