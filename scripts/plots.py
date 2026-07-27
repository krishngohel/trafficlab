"""Generate results plots from results/eval.csv -> results/plots/*.png."""
import argparse
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from evaluate import t95  # noqa: E402  (shared Student-t quantiles)

PALETTE = {
    "fixed": "#9e9e9e", "webster": "#607d8b", "actuated": "#42a5f5",
    "max_pressure": "#7e57c2",
}
FALLBACK = ["#ef5350", "#ffa726", "#66bb6a", "#26c6da", "#ec407a"]


def color_for(policy: str, i: int) -> str:
    for key, c in PALETTE.items():
        if policy == key:
            return c
    return FALLBACK[i % len(FALLBACK)]


def bar_ci(ax, df: pd.DataFrame, metric: str, title: str) -> None:
    policies = list(df["policy"].unique())
    xs = np.arange(len(policies))
    means, cis, colors = [], [], []
    for i, p in enumerate(policies):
        vals = df[df["policy"] == p][metric].astype(float)
        means.append(vals.mean())
        cis.append(t95(len(vals) - 1) * vals.std(ddof=1) / len(vals) ** 0.5
                   if len(vals) > 1 else 0)
        colors.append(color_for(p, i))
    ax.bar(xs, means, yerr=cis, capsize=4, color=colors, edgecolor="none")
    ax.set_xticks(xs, [p.replace("_", "\n").replace(":", "\n") for p in policies], fontsize=8)
    ax.set_title(title, fontsize=10)
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="results/eval.csv")
    ap.add_argument("--out", default="results/plots")
    args = ap.parse_args()
    df = pd.read_csv(ROOT / args.csv)
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)

    metrics = [("delay_per_vehicle", "delay per vehicle (s)"),
               ("throughput", "throughput (veh/h eq.)"),
               ("mean_queue", "mean total queue (veh)")]
    if "spawned" in df.columns:     # demand actually served — exposes entry damming
        metrics.append(("spawned", "vehicles spawned"))
    for metric, label in metrics:
        nets = sorted(df["network"].unique())
        dems = sorted(df["demand"].unique())
        fig, axes = plt.subplots(len(dems), len(nets),
                                 figsize=(3.2 * len(nets), 2.6 * len(dems)),
                                 squeeze=False, constrained_layout=True)
        for r, dem in enumerate(dems):
            for c, net in enumerate(nets):
                cell = df[(df["network"] == net) & (df["demand"] == dem)]
                if len(cell):
                    bar_ci(axes[r][c], cell, metric, f"{net} / {dem}")
                else:
                    axes[r][c].axis("off")
        fig.suptitle(label, fontsize=12)
        fig.savefig(out / f"{metric}.png", dpi=160)
        plt.close(fig)
        print(f"wrote {out / (metric + '.png')}")


if __name__ == "__main__":
    main()
