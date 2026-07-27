"""Run a RunConfig sweep from a spec JSON: {"base": {...}, "grid": {...}}.

Usage:
  python scripts/sweep.py --spec configs/sweeps/lr.json [--processes 6] [--resume]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from trafficlab.rl.harness import RunConfig                 # noqa: E402
from trafficlab.rl.sweep import expand_grid, run_sweep      # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--spec", required=True,
                    help='JSON file: {"base": {...RunConfig fields...}, "grid": {...}}')
    ap.add_argument("--processes", type=int, default=6)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    spec = json.loads(Path(args.spec).read_text())
    base = RunConfig(**spec["base"])
    configs = expand_grid(base, spec.get("grid", {}))
    print(f"sweep: {len(configs)} runs, processes={args.processes}")
    df = run_sweep(configs, processes=args.processes, resume=args.resume)
    print(df.to_string(index=False))


if __name__ == "__main__":
    main()
