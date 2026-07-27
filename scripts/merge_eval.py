"""Merge evaluation CSVs into results/eval_final.csv.

Deduplicates on (network, demand, policy, seed) keeping the FIRST occurrence
(baseline rows appear again in RL-eval runs because --policies requires at
least one entry), and shortens unwieldy run-dir policy labels.
"""
import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

LABEL_RULES = [
    (re.compile(r"^dqn:.*pressure_s(\d).*"), r"dqn-pressure (s\1)"),
    (re.compile(r"^dqn:.*queue_s(\d).*"), r"dqn-queue (s\1)"),
    (re.compile(r"^ippo:.*queue_s(\d).*"), r"ippo-queue (s\1)"),
    (re.compile(r"^gat:.*s(\d).*"), r"gat-queue (s\1)"),
    (re.compile(r"^dqn:.*grid2x2.*seed=(\d).*"), r"dqn-queue (s\1)"),
    (re.compile(r"^ippo:.*grid2x2.*seed=(\d).*"), r"ippo-queue (s\1)"),
]


def short_label(policy: str) -> str:
    for pat, repl in LABEL_RULES:
        if pat.match(policy):
            return pat.sub(repl, policy)
    return policy


def main() -> None:
    inputs = sys.argv[1:-1]
    out = ROOT / sys.argv[-1]
    seen: set[tuple] = set()
    rows: list[dict] = []
    fields: list[str] | None = None
    for path in inputs:
        with open(ROOT / path, newline="") as f:
            for row in csv.DictReader(f):
                row["policy"] = short_label(row["policy"])
                key = (row["network"], row["demand"], row["policy"], row["seed"])
                if key in seen:
                    continue
                seen.add(key)
                if fields is None:
                    fields = list(row.keys())
                rows.append(row)
    rows.sort(key=lambda r: (r["network"], r["demand"], r["policy"], int(r["seed"])))
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {out}: {len(rows)} rows from {len(inputs)} files")


if __name__ == "__main__":
    main()
