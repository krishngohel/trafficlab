"""Train one RL run: maps CLI flags onto trafficlab.rl.harness.RunConfig.

Usage:
  python scripts/train.py --algo ippo --network single --demand rush --seed 0 \
      --total-steps 20000 --algo-kwargs '{"rollout_steps": 1024}' [--resume]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from trafficlab.rl.harness import RunConfig, train          # noqa: E402


def main() -> None:
    d = RunConfig(algo="")      # field defaults, shown in --help
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--algo", required=True, help="dqn | ippo | gat")
    ap.add_argument("--network", default=d.network)
    ap.add_argument("--demand", default=d.demand)
    ap.add_argument("--reward", default=d.reward)
    ap.add_argument("--seed", type=int, default=d.seed)
    ap.add_argument("--total-steps", type=int, default=d.total_steps)
    ap.add_argument("--episode-seconds", type=float, default=d.episode_seconds)
    ap.add_argument("--decision-interval", type=float, default=d.decision_interval)
    ap.add_argument("--gamma", type=float, default=d.gamma)
    ap.add_argument("--lr", type=float, default=d.lr)
    ap.add_argument("--eval-every", type=int, default=d.eval_every)
    ap.add_argument("--eval-episodes", type=int, default=d.eval_episodes)
    ap.add_argument("--eval-seed-base", type=int, default=d.eval_seed_base)
    ap.add_argument("--run-name", default=d.run_name)
    ap.add_argument("--out-root", default=d.out_root)
    ap.add_argument("--algo-kwargs", default="{}",
                    help='JSON object, e.g. \'{"share_weights": true}\'')
    ap.add_argument("--no-record-eval-traj", action="store_true")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    algo_kwargs = json.loads(args.algo_kwargs)
    if not isinstance(algo_kwargs, dict):
        ap.error("--algo-kwargs must be a JSON object")
    cfg = RunConfig(
        algo=args.algo, network=args.network, demand=args.demand, reward=args.reward,
        seed=args.seed, total_steps=args.total_steps,
        episode_seconds=args.episode_seconds, decision_interval=args.decision_interval,
        gamma=args.gamma, lr=args.lr, eval_every=args.eval_every,
        eval_episodes=args.eval_episodes, eval_seed_base=args.eval_seed_base,
        run_name=args.run_name, out_root=args.out_root, algo_kwargs=algo_kwargs,
        record_eval_traj=not args.no_record_eval_traj,
    )
    summary = train(cfg, resume=args.resume)
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
