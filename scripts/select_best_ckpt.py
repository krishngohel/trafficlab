"""Best-checkpoint selection: point ckpt_latest.pt at the eval-best step.

Standard early-stopping-by-validation, applied uniformly to every run dir
given. The eval-best step is the one whose eval rows have the lowest mean
total_delay in the run's metrics DB.
"""
import shutil
import sqlite3
import sys
from pathlib import Path

for run_dir in sys.argv[1:]:
    run = Path(run_dir)
    db = sqlite3.connect(run / "metrics.sqlite")
    rows = db.execute(
        "SELECT step, AVG(total_delay) FROM evals GROUP BY step ORDER BY AVG(total_delay)"
    ).fetchall()
    db.close()
    if not rows:
        print(f"{run.name}: no evals, skipped")
        continue
    best_step = int(rows[0][0])
    src = run / f"ckpt_{best_step}.pt"
    if not src.exists():
        print(f"{run.name}: {src.name} missing, kept latest")
        continue
    shutil.copyfile(src, run / "ckpt_latest.pt")
    print(f"{run.name}: best step {best_step} (delay {rows[0][1]:.0f}) -> ckpt_latest")
