"""Results tables: turn an evaluate.py CSV into results/TABLES.md + summary.json.

  python scripts/tables.py --csv results/eval_baselines.csv --out results/TABLES.md

One markdown table per network x demand cell (policy rows; delay per vehicle and
throughput as mean +/- 95% CI over seeds; best-delay row bolded), then an overall
table of each policy's mean rank across cells. The same numbers are written to
summary.json next to the markdown for downstream tooling.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from evaluate import t95            # noqa: E402  one Student-t lookup for both scripts

# csv column, table header, decimals, higher-is-better
METRICS = (
    ("delay_per_vehicle", "delay/veh (s)", 1, False),
    ("throughput", "throughput (veh)", 0, True),
)


def _path(p: str) -> Path:
    q = Path(p)
    return q if q.is_absolute() else ROOT / q


def load_rows(csv_path: Path) -> list[dict]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for col, *_ in METRICS:
            r[col] = float(r[col])
    return rows


def mean_ci(values) -> tuple[float, float]:
    """Sample mean and the half-width of its 95% Student-t CI (ddof=1)."""
    a = np.asarray(values, dtype=float)
    if a.size < 2:
        return float(a.mean()), 0.0
    return float(a.mean()), float(t95(a.size - 1) * a.std(ddof=1) / a.size ** 0.5)


def fmt(mean: float, ci: float, decimals: int) -> str:
    return f"{mean:.{decimals}f} ± {ci:.{decimals}f}"


def ranks(scores: dict[str, float], higher_is_better: bool) -> dict[str, float]:
    """1 = best. Tied policies share the average of the positions they span."""
    items = sorted(scores.items(), key=lambda kv: -kv[1] if higher_is_better else kv[1])
    out: dict[str, float] = {}
    i = 0
    while i < len(items):
        j = i
        while j + 1 < len(items) and items[j + 1][1] == items[i][1]:
            j += 1
        for k in range(i, j + 1):
            out[items[k][0]] = (i + j) / 2 + 1
        i = j + 1
    return out


def summarize(rows: list[dict]) -> dict:
    grouped: dict[tuple, dict[str, list]] = {}
    for r in rows:
        cell = grouped.setdefault((r["network"], r["demand"]), {})
        cell.setdefault(r["policy"], []).append(r)

    cells = []
    for net, dem in sorted(grouped):
        stats: dict[str, dict] = {}
        for policy, rs in grouped[(net, dem)].items():
            entry = {"seeds": len(rs)}
            for col, _h, _d, _hb in METRICS:
                m, ci = mean_ci([r[col] for r in rs])
                entry[col] = {"mean": round(m, 4), "ci95": round(ci, 4)}
            stats[policy] = entry
        for col, _h, _d, higher in METRICS:
            means = {p: s[col]["mean"] for p, s in stats.items()}
            for policy, rank in ranks(means, higher).items():
                stats[policy][col]["rank"] = rank
        # Best delay first, so the bolded row leads each table.
        order = sorted(stats, key=lambda p: (stats[p]["delay_per_vehicle"]["mean"], p))
        cells.append({"network": net, "demand": dem, "order": order,
                      "best_delay_policy": order[0], "policies": stats})

    acc: dict[str, dict[str, list]] = {}
    for cell in cells:
        for policy, s in cell["policies"].items():
            a = acc.setdefault(policy, {"delay": [], "throughput": []})
            a["delay"].append(s["delay_per_vehicle"]["rank"])
            a["throughput"].append(s["throughput"]["rank"])
    overall = [{"policy": p,
                "cells": len(acc[p]["delay"]),
                "mean_rank_delay": round(sum(acc[p]["delay"]) / len(acc[p]["delay"]), 3),
                "mean_rank_throughput": round(
                    sum(acc[p]["throughput"]) / len(acc[p]["throughput"]), 3)}
               for p in sorted(acc)]
    overall.sort(key=lambda o: (o["mean_rank_delay"], o["policy"]))
    return {"cells": cells, "overall": overall}


def render(summary: dict, source: str, episodes: int) -> str:
    cells = summary["cells"]
    lines = [
        "# Results tables",
        "",
        f"Source: `{source}` ({episodes} episodes over {len(cells)} network x demand cells).",
        "Values are the mean across seeds ± the half-width of a 95% Student-t confidence "
        "interval (ddof=1). **Bold** marks the best delay per vehicle in each cell.",
        "",
    ]
    for cell in cells:
        headers = " | ".join(h for _c, h, _d, _hb in METRICS)
        rules = " | ".join("---:" for _ in METRICS)
        lines += [f"## {cell['network']} / {cell['demand']}", "",
                  f"| policy | {headers} | seeds |",
                  f"| --- | {rules} | ---: |"]
        for policy in cell["order"]:
            s = cell["policies"][policy]
            cols = [policy] + [fmt(s[c]["mean"], s[c]["ci95"], d) for c, _h, d, _hb in METRICS]
            if policy == cell["best_delay_policy"]:
                cols = [f"**{c}**" for c in cols]
            lines.append("| " + " | ".join(cols + [str(s["seeds"])]) + " |")
        lines.append("")
    lines += ["## Overall", "",
              "Mean rank across cells (1 = best; tied policies share the average rank).", "",
              "| policy | mean rank by delay | mean rank by throughput | cells |",
              "| --- | ---: | ---: | ---: |"]
    for o in summary["overall"]:
        lines.append(f"| {o['policy']} | {o['mean_rank_delay']:.2f} | "
                     f"{o['mean_rank_throughput']:.2f} | {o['cells']} |")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="results/eval.csv")
    ap.add_argument("--out", default="results/TABLES.md")
    ap.add_argument("--json", default=None, help="default: summary.json beside --out")
    args = ap.parse_args()

    csv_path = _path(args.csv)
    rows = load_rows(csv_path)
    if not rows:
        print(f"{csv_path} has no rows")
        return
    try:
        source = csv_path.relative_to(ROOT).as_posix()
    except ValueError:
        source = csv_path.name

    summary = summarize(rows)
    out = _path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(summary, source, len(rows)), encoding="utf-8")
    print(f"wrote {out}")

    js = _path(args.json) if args.json else out.parent / "summary.json"
    js.parent.mkdir(parents=True, exist_ok=True)
    doc = {"source": source, "episodes": len(rows), **summary}
    js.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {js}")


if __name__ == "__main__":
    main()
