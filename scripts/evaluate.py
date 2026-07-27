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

# Two-sided 95% Student-t quantiles by degrees of freedom (df > 30 ~ normal).
T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
       8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160,
       14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
       20: 2.086, 25: 2.060, 30: 2.042}


def t95(df: int) -> float:
    if df <= 0:
        return 0.0
    if df in T95:
        return T95[df]
    if df >= 30:
        return 1.96
    # Value at the smallest tabulated df >= requested (monotone, conservative).
    return min(((k, v) for k, v in T95.items() if k >= df), default=(0, 1.96))[1]


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
        if (tk + 1) % 10 == 0:      # decision boundaries, matching the RL path
            queue_sum += float(sim.queues_by_approach().sum())
            samples += 1
    out = _row(network, demand, policy, seed, sim, queue_sum / max(samples, 1))
    sim.close()
    return out


def eval_rl(network: str, demand: str, run_dir: str, seed: int,
            record: str | None) -> dict | None:
    import torch
    from trafficlab.env import make_env
    run = Path(run_dir)
    cfg_dict = json.loads((run / "config.json").read_text())
    if cfg_dict.get("network") and cfg_dict["network"] != network:
        # Policies are shaped by their training network (agent count, obs dim);
        # cross-network evaluation would crash or silently mislead.
        return None
    from trafficlab.rl.harness import RunConfig
    cfg = RunConfig(**{k: v for k, v in cfg_dict.items()
                       if k in RunConfig.__dataclass_fields__})
    policy_name = f"{cfg.algo}:{run.name}"
    env = make_env(network, demand, root=ROOT, reward=cfg.reward,
                   decision_interval=cfg.decision_interval,
                   episode_seconds=EPISODE_SECONDS)
    trainer = importlib.import_module(f"trafficlab.rl.{cfg.algo}").Trainer(cfg, env)
    ckpt = torch.load(run / "ckpt_latest.pt", map_location="cpu", weights_only=False)
    # Harness checkpoints keep the full trainer state under extra.trainer
    # (the top-level "model" key is the bare net dict or None).
    trainer.load_state_dict(ckpt["extra"]["trainer"] if "extra" in ckpt else ckpt)
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
        # Arrivals still backlogged at entry at episode end: a controller that
        # dams its entrances would otherwise look good on delay/vehicle.
        "unserved": int(sum(sim._pending.values())),
    }


def _run_cell(args) -> dict | None:
    kind, network, demand, policy, seed, record = args
    try:
        if kind == "baseline":
            return eval_baseline(network, demand, policy, seed, record)
        return eval_rl(network, demand, policy, seed, record)
    except Exception as exc:  # isolate: one bad cell must not sink the matrix
        return {"network": network, "demand": demand, "policy": str(policy),
                "seed": seed, "error": f"{type(exc).__name__}: {exc}"}


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

    if not jobs:
        print("nothing to evaluate (empty policy/run selection)")
        return
    print(f"{len(jobs)} evaluation episodes on {args.processes} processes...")
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["network", "demand", "policy", "seed", "spawned", "throughput",
              "total_delay", "delay_per_vehicle", "mean_queue", "unserved"]
    rows = []
    errors = []
    # Incremental writes: a crash or bad cell never discards finished episodes.
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        with ProcessPoolExecutor(max_workers=args.processes) as pool:
            for i, row in enumerate(pool.map(_run_cell, jobs)):
                if row is not None and "error" in row:
                    errors.append(row)
                    print(f"  FAILED {row['network']}/{row['demand']}/"
                          f"{row['policy']} s{row['seed']}: {row['error']}")
                elif row is not None:   # None = RL run skipped, foreign network
                    rows.append(row)
                    w.writerow(row)
                    f.flush()
                if (i + 1) % 10 == 0:
                    print(f"  {i + 1}/{len(jobs)}")
    if errors:
        print(f"{len(errors)} cell(s) FAILED and were excluded")
    if not rows:
        print("no successful cells")
        return
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
        q = t95(len(d) - 1)
        ci_d = q * d.std(ddof=1) / len(d) ** 0.5 if len(d) > 1 else 0.0
        ci_t = q * t.std(ddof=1) / len(t) ** 0.5 if len(t) > 1 else 0.0
        print(f"{key[0]:10s} {key[1]:7s} {key[2]:28s} {d.mean():8.1f} ± {ci_d:5.1f} "
              f"{t.mean():9.0f} ± {ci_t:4.0f}")


if __name__ == "__main__":
    main()
