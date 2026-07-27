"""Sweep runner: expand RunConfig grids, run them in parallel, summarize results.

``expand_grid`` accepts dotted keys ("lr", "algo_kwargs.epsilon_final", ...);
``run_sweep`` fans train() out over a spawn-based multiprocessing Pool (one
subprocess per run, each run owns its own run dir + SQLite DB) and collects
the final eval rows from each run DB into a DataFrame.
"""
from __future__ import annotations

import copy
import dataclasses
import itertools
import json
import re
import sqlite3
from multiprocessing import get_context
from pathlib import Path

import pandas as pd

from .harness import RunConfig, default_run_name, train


def _fmt_value(value) -> str:
    """Filesystem-safe rendering of a grid value for run_name suffixes."""
    return re.sub(r"[^-A-Za-z0-9_.+]", "-", str(value))


def _set_dotted(cfg: RunConfig, key: str, value) -> None:
    head, _, rest = key.partition(".")
    if not hasattr(cfg, head):
        raise KeyError(f"unknown RunConfig field {head!r}")
    if not rest:
        setattr(cfg, head, value)
        return
    target = getattr(cfg, head)
    if not isinstance(target, dict):
        raise TypeError(f"dotted key {key!r}: RunConfig.{head} is not a dict")
    parts = rest.split(".")
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value


def expand_grid(base: RunConfig, grid: dict[str, list]) -> list[RunConfig]:
    """Cartesian product over grid values; run_name auto-suffixed per combo."""
    keys = list(grid)
    configs: list[RunConfig] = []
    for values in itertools.product(*(grid[k] for k in keys)):
        cfg = copy.deepcopy(base)
        for key, value in zip(keys, values):
            _set_dotted(cfg, key, value)
        stem = _fmt_value(base.run_name) if base.run_name else default_run_name(cfg)
        suffix = "_".join(f"{k.rsplit('.', 1)[-1]}={_fmt_value(v)}"
                          for k, v in zip(keys, values))
        cfg.run_name = f"{stem}_{suffix}" if suffix else stem
        configs.append(cfg)
    names = [c.run_name for c in configs]
    if len(set(names)) != len(names):
        raise ValueError("expand_grid produced duplicate run_names; "
                         "grid values must render to distinct suffixes")
    return configs


def _train_entry(payload: tuple[dict, bool]) -> dict:
    """Pool worker: rebuild the RunConfig and run train(); never raises."""
    cfg_dict, resume = payload
    cfg = RunConfig(**cfg_dict)
    run_name = cfg.run_name or default_run_name(cfg)
    ckpt = Path(cfg.out_root) / run_name / "ckpt_latest.pt"
    try:
        summary = train(cfg, resume=resume and ckpt.exists())
        return {"ok": True, **summary}
    except Exception as exc:  # noqa: BLE001 - report per-run, don't kill the pool
        return {"ok": False, "run_name": run_name,
                "error": f"{type(exc).__name__}: {exc}"}


def _final_eval_rows(run_dir: Path, meta: dict) -> list[dict]:
    """Final-eval-round rows from one run DB, tagged with run metadata."""
    empty = dict(meta, step=None, episode=None, eval_seed=None, mean_reward=None,
                 total_delay=None, throughput=None, mean_queue=None, traj_path=None)
    db_path = run_dir / "metrics.sqlite"
    if not db_path.exists():
        return [empty]
    con = sqlite3.connect(db_path)
    try:
        (last,) = con.execute("SELECT MAX(step) FROM evals").fetchone()
        if last is None:
            return [empty]
        cur = con.execute(
            "SELECT step, episode, seed, mean_reward, total_delay, throughput,"
            " mean_queue, traj_path FROM evals WHERE step=? ORDER BY episode", (last,))
        return [dict(meta, step=s, episode=e, eval_seed=sd, mean_reward=mr,
                     total_delay=td, throughput=tp, mean_queue=mq, traj_path=tj)
                for s, e, sd, mr, td, tp, mq, tj in cur.fetchall()]
    finally:
        con.close()


def run_sweep(configs, processes: int = 6, resume: bool = False) -> "pd.DataFrame":
    """Train every config (spawned subprocesses); one row per final eval episode."""
    configs = list(configs)
    names = [c.run_name or default_run_name(c) for c in configs]
    if len(set(names)) != len(names):
        raise ValueError("duplicate run_names in sweep configs")
    payloads = [(dataclasses.asdict(c), resume) for c in configs]
    n_proc = max(1, min(processes, len(payloads)))
    if n_proc == 1:
        results = [_train_entry(p) for p in payloads]
    else:
        with get_context("spawn").Pool(processes=n_proc) as pool:
            results = pool.map(_train_entry, payloads)
    rows: list[dict] = []
    for cfg, name, res in zip(configs, names, results):
        meta = {
            "run_name": name, "algo": cfg.algo, "network": cfg.network,
            "demand": cfg.demand, "reward": cfg.reward, "seed": cfg.seed,
            "error": None if res.get("ok") else res.get("error", "unknown"),
        }
        rows.extend(_final_eval_rows(Path(cfg.out_root) / name, meta))
    return pd.DataFrame(rows)


def summarize(out_root: str | Path = "runs") -> "pd.DataFrame":
    """One row per run dir under out_root: final eval round averaged over episodes."""
    rows: list[dict] = []
    for db_path in sorted(Path(out_root).glob("*/metrics.sqlite")):
        con = sqlite3.connect(db_path)
        try:
            cfg_row = con.execute("SELECT config_json FROM runs WHERE id=1").fetchone()
            cfg = json.loads(cfg_row[0]) if cfg_row else {}
            (last,) = con.execute("SELECT MAX(step) FROM evals").fetchone()
            if last is None:
                continue
            agg = con.execute(
                "SELECT AVG(mean_reward), AVG(total_delay), AVG(throughput),"
                " AVG(mean_queue), COUNT(*) FROM evals WHERE step=?", (last,)).fetchone()
        except sqlite3.Error:
            continue
        finally:
            con.close()
        rows.append({
            "run_name": db_path.parent.name, "algo": cfg.get("algo"),
            "network": cfg.get("network"), "demand": cfg.get("demand"),
            "reward": cfg.get("reward"), "seed": cfg.get("seed"),
            "step": last, "episodes": agg[4], "mean_reward": agg[0],
            "total_delay": agg[1], "throughput": agg[2], "mean_queue": agg[3],
        })
    return pd.DataFrame(rows)
