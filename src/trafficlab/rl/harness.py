"""Training harness: RunConfig, train() loop, eval, SQLite metrics, checkpoints.

The harness owns the entire env loop, evaluation, metrics DB, checkpointing,
and resume (docs/RL_DESIGN.md). Algo modules (``trafficlab.rl.<algo>``) expose
a ``Trainer`` class and never touch the DB or filesystem; dispatch is
``importlib.import_module(f"trafficlab.rl.{cfg.algo}").Trainer``.

Determinism: ``torch.manual_seed`` is set once per run from ``cfg.seed``; the
harness draws training-episode seeds from its own ``numpy`` generator whose
state is checkpointed, so a resumed run continues the same RNG streams.
"""
from __future__ import annotations

import dataclasses
import importlib
import json
import os
import re
import shutil
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from ..env import make_env

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY CHECK(id=1),
    config_json TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    status TEXT
);
CREATE TABLE IF NOT EXISTS metrics(step INTEGER, key TEXT, value REAL);
CREATE TABLE IF NOT EXISTS evals(
    step INTEGER, episode INTEGER, seed INTEGER,
    mean_reward REAL, total_delay REAL, throughput REAL, mean_queue REAL,
    traj_path TEXT
);
"""

_EVAL_INSERT = (
    "INSERT INTO evals(step, episode, seed, mean_reward, total_delay, throughput,"
    " mean_queue, traj_path) VALUES (:step, :episode, :seed, :mean_reward,"
    " :total_delay, :throughput, :mean_queue, :traj_path)"
)

_EVAL_METRIC_KEYS = ("mean_reward", "total_delay", "throughput", "mean_queue")


@dataclass
class RunConfig:
    algo: str                    # "dqn" | "ippo" | "gat"
    network: str = "single"     # configs/networks name
    demand: str = "rush"
    reward: str = "pressure"
    seed: int = 0
    total_steps: int = 20_000   # env decision steps (5 s each)
    episode_seconds: float = 1200.0
    decision_interval: float = 5.0
    gamma: float = 0.97
    lr: float = 3e-4
    eval_every: int = 2_000     # in decision steps
    eval_episodes: int = 2
    eval_seed_base: int = 10_000
    run_name: str = ""          # default: f"{algo}_{network}_{demand}_{reward}_s{seed}"
    out_root: str = "runs"
    algo_kwargs: dict = field(default_factory=dict)   # see per-algo defaults
    record_eval_traj: bool = True
    obs_version: int = 1        # 1 = original 13-dim; 2 = +signal state, presence
                                # detectors, episode progress, neighbor summary


def sanitize_name(name: str) -> str:
    """Filesystem-safe run/dir name (Windows-reserved chars included)."""
    return re.sub(r"[^-A-Za-z0-9_.+=]", "-", name)


def default_run_name(cfg: RunConfig) -> str:
    return sanitize_name(
        f"{cfg.algo}_{cfg.network}_{cfg.demand}_{cfg.reward}_s{cfg.seed}")


# ---------------------------------------------------------------------- helpers
def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _draw_seed(rng: np.random.Generator) -> int:
    return int(rng.integers(0, 2**31 - 1))


def _open_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _flush_metrics(db: sqlite3.Connection, pending: list[tuple[int, str, float]]) -> None:
    if not pending:
        return
    with db:
        db.executemany("INSERT INTO metrics(step, key, value) VALUES (?, ?, ?)", pending)
    pending.clear()


def _load_final_evals(db: sqlite3.Connection) -> list[dict]:
    (last,) = db.execute("SELECT MAX(step) FROM evals").fetchone()
    if last is None:
        return []
    cur = db.execute(
        "SELECT step, episode, seed, mean_reward, total_delay, throughput,"
        " mean_queue, traj_path FROM evals WHERE step=? ORDER BY episode", (last,))
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _save_checkpoint(run_dir: Path, step: int, episode_index: int,
                     trainer, rng: np.random.Generator) -> None:
    sd = trainer.state_dict()
    ckpt = {
        "step": step,
        "model": sd.get("model") if isinstance(sd, dict) else None,
        "optimizer": sd.get("optimizer") if isinstance(sd, dict) else None,
        "torch_rng": torch.get_rng_state(),
        "numpy_rng": rng.bit_generator.state,
        "extra": {"episode_index": episode_index, "trainer": sd},
    }
    # Atomic writes: a crash mid-write must never corrupt an existing
    # ckpt_latest.pt (resume reads only that file).
    step_path = run_dir / f"ckpt_{step}.pt"
    tmp = run_dir / f"ckpt_{step}.pt.tmp"
    torch.save(ckpt, tmp)
    os.replace(tmp, step_path)
    tmp_latest = run_dir / "ckpt_latest.pt.tmp"
    shutil.copyfile(step_path, tmp_latest)
    os.replace(tmp_latest, run_dir / "ckpt_latest.pt")


def _evaluate(cfg: RunConfig, trainer, eval_env, step: int, run_dir: Path,
              db: sqlite3.Connection) -> list[dict]:
    """Greedy episodes on eval_seed_base + i; returns the inserted eval rows."""
    n_agents = len(eval_env.agents)
    rows: list[dict] = []
    for ep in range(cfg.eval_episodes):
        seed = cfg.eval_seed_base + ep
        traj_path: Path | None = None
        if cfg.record_eval_traj and ep == 0:
            traj_path = run_dir / "trajs" / f"eval_s{step}_e{ep}.traj"
            eval_env.record_next_episode(traj_path, policy_label=cfg.algo)
        obs, infos = eval_env.reset(seed=seed)
        reward_sum = 0.0
        queue_sum = 0.0
        n_steps = 0
        truncated = False
        while not truncated:
            actions = trainer.act(obs, infos, explore=False)
            obs, rewards, _terms, truncs, infos = eval_env.step(actions)
            reward_sum += float(sum(rewards[a] for a in eval_env.agents))
            queue_sum += float(eval_env.sim.queues_by_approach().sum())
            n_steps += 1
            truncated = bool(truncs["__all__"])
        total_delay = float(eval_env.sim.cum_delay)
        throughput = float(eval_env.sim.departed)
        eval_env.close()        # finalizes the .traj writer if one was attached
        rows.append({
            "step": step, "episode": ep, "seed": seed,
            "mean_reward": reward_sum / max(n_steps * n_agents, 1),
            "total_delay": total_delay, "throughput": throughput,
            "mean_queue": queue_sum / max(n_steps, 1),
            "traj_path": str(traj_path) if traj_path is not None else None,
        })
    with db:
        db.executemany(_EVAL_INSERT, rows)
    return rows


# ---------------------------------------------------------------------- train
def train(cfg: RunConfig, resume: bool = False) -> dict:
    """Run (or resume) one training run; returns final summary metrics."""
    run_name = sanitize_name(cfg.run_name) if cfg.run_name else default_run_name(cfg)
    run_dir = Path(cfg.out_root) / run_name
    ckpt_latest = run_dir / "ckpt_latest.pt"
    if resume and not ckpt_latest.exists():
        raise FileNotFoundError(f"resume requested but no checkpoint at {ckpt_latest}")
    (run_dir / "trajs").mkdir(parents=True, exist_ok=True)
    cfg_dict = dataclasses.asdict(cfg)
    cfg_dict["run_name"] = run_name
    cfg_json = json.dumps(cfg_dict, indent=2, sort_keys=True)
    (run_dir / "config.json").write_text(cfg_json)

    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)       # harness stream: training episode seeds
    env = make_env(cfg.network, cfg.demand, reward=cfg.reward,
                   decision_interval=cfg.decision_interval,
                   episode_seconds=cfg.episode_seconds,
                   obs_version=cfg.obs_version)
    eval_env = make_env(cfg.network, cfg.demand, reward=cfg.reward,
                        decision_interval=cfg.decision_interval,
                        episode_seconds=cfg.episode_seconds,
                        obs_version=cfg.obs_version)
    trainer = importlib.import_module(f"trafficlab.rl.{cfg.algo}").Trainer(cfg, env)

    step = 0
    episode_index = 0
    if resume:
        ckpt = torch.load(ckpt_latest, weights_only=False)
        step = int(ckpt["step"])
        episode_index = int(ckpt["extra"]["episode_index"])
        trainer.load_state_dict(ckpt["extra"]["trainer"])
        torch.set_rng_state(ckpt["torch_rng"])
        rng.bit_generator.state = ckpt["numpy_rng"]

    db = _open_db(run_dir / "metrics.sqlite")
    pending: list[tuple[int, str, float]] = []
    last_eval: list[dict] = []
    try:
        with db:
            if db.execute("SELECT 1 FROM runs WHERE id=1").fetchone() is None:
                db.execute(
                    "INSERT INTO runs(id, config_json, started_at, finished_at, status)"
                    " VALUES (1, ?, ?, NULL, 'running')", (cfg_json, _utcnow()))
            else:
                db.execute("UPDATE runs SET config_json=?, finished_at=NULL,"
                           " status='running' WHERE id=1", (cfg_json,))
            # Drop rows past the checkpoint (a crash between checkpoint and
            # commit would otherwise duplicate them on resume).
            db.execute("DELETE FROM metrics WHERE step > ?", (step,))
            db.execute("DELETE FROM evals WHERE step > ?", (step,))

        try:
            if step < cfg.total_steps:
                obs, infos = env.reset(seed=_draw_seed(rng))
                episode_index += 1
            while step < cfg.total_steps:
                actions = trainer.act(obs, infos, explore=True)
                next_obs, rewards, _terms, truncs, next_infos = env.step(actions)
                truncated = bool(truncs["__all__"])
                metrics = trainer.observe(obs, actions, rewards, next_obs,
                                          next_infos, truncated)
                step += 1
                for key in sorted(metrics or {}):
                    pending.append((step, key, float(metrics[key])))
                if truncated and step < cfg.total_steps:
                    obs, infos = env.reset(seed=_draw_seed(rng))
                    episode_index += 1
                else:
                    obs, infos = next_obs, next_infos
                if step % cfg.eval_every == 0 or step == cfg.total_steps:
                    _flush_metrics(db, pending)
                    last_eval = _evaluate(cfg, trainer, eval_env, step, run_dir, db)
                    _save_checkpoint(run_dir, step, episode_index, trainer, rng)
            _flush_metrics(db, pending)
        except BaseException:
            with db:
                db.execute("UPDATE runs SET status='failed' WHERE id=1")
            raise
        if not last_eval:
            last_eval = _load_final_evals(db)
        with db:
            db.execute("UPDATE runs SET finished_at=?, status='done' WHERE id=1",
                       (_utcnow(),))
    finally:
        env.close()
        eval_env.close()
        db.close()

    summary = {"run_name": run_name, "run_dir": str(run_dir),
               "final_step": step, "status": "done"}
    if last_eval:
        summary["eval_step"] = int(last_eval[0]["step"])
        for key in _EVAL_METRIC_KEYS:
            summary[key] = float(np.mean([row[key] for row in last_eval]))
    return summary
