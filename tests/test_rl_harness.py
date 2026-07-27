"""Harness + sweep tests with a tiny stub algo (no real learning).

Fresh-run artifacts, eval protocol (valid .traj dumps), resume exactness
(continues from the checkpointed step, no duplicate rows), grid expansion
with dotted keys, multiprocess sweep, and summarize().
"""
import json
import sqlite3
import sys
from dataclasses import replace
from pathlib import Path

import pytest

import stub_algo_for_harness

sys.modules["trafficlab.rl.stub"] = stub_algo_for_harness

from trafficlab.rl.harness import RunConfig, train
from trafficlab.rl.sweep import expand_grid, run_sweep, summarize
from trafficlab.trajectory import validate_file


def make_cfg(tmp_path, **overrides) -> RunConfig:
    kw = dict(algo="stub", network="single", demand="light", reward="pressure",
              seed=1, total_steps=40, episode_seconds=60.0, eval_every=20,
              eval_episodes=2, eval_seed_base=10_000, out_root=str(tmp_path))
    kw.update(overrides)
    return RunConfig(**kw)


def db_rows(db_path, sql, args=()):
    con = sqlite3.connect(db_path)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def test_fresh_run_creates_artifacts(tmp_path):
    cfg = make_cfg(tmp_path, run_name="fresh")
    summary = train(cfg)
    run_dir = tmp_path / "fresh"

    assert (run_dir / "config.json").exists()
    assert (run_dir / "metrics.sqlite").exists()
    assert (run_dir / "ckpt_latest.pt").exists()
    assert (run_dir / "ckpt_20.pt").exists() and (run_dir / "ckpt_40.pt").exists()
    saved = json.loads((run_dir / "config.json").read_text())
    assert saved["algo"] == "stub" and saved["total_steps"] == 40
    assert saved["run_name"] == "fresh"

    db = run_dir / "metrics.sqlite"
    evals = db_rows(db, "SELECT step, episode, seed, traj_path FROM evals"
                        " ORDER BY step, episode")
    assert [(s, e) for s, e, _, _ in evals] == [(20, 0), (20, 1), (40, 0), (40, 1)]
    for _s, ep, seed, traj in evals:
        assert seed == cfg.eval_seed_base + ep
        if ep == 0:     # only episode 0 of each round is recorded
            assert traj is not None and Path(traj).exists()
            assert validate_file(traj) == []
        else:
            assert traj is None

    # Stub emits a loss every 10 observes -> steps 10, 20, 30, 40.
    losses = db_rows(db, "SELECT step FROM metrics WHERE key='loss' ORDER BY step")
    assert [s for (s,) in losses] == [10, 20, 30, 40]

    (status,) = db_rows(db, "SELECT status FROM runs WHERE id=1")[0]
    assert status == "done"
    assert summary["run_name"] == "fresh"
    assert summary["final_step"] == 40
    assert summary["eval_step"] == 40
    for key in ("mean_reward", "total_delay", "throughput", "mean_queue"):
        assert isinstance(summary[key], float)


def test_resume_continues_exactly(tmp_path):
    cfg = make_cfg(tmp_path, run_name="res", seed=3, total_steps=20,
                   eval_every=10, eval_episodes=1)
    s1 = train(cfg)
    assert s1["final_step"] == 20
    db = tmp_path / "res" / "metrics.sqlite"
    assert [s for (s,) in db_rows(db, "SELECT step FROM evals ORDER BY step")] == [10, 20]

    s2 = train(replace(cfg, total_steps=40), resume=True)
    assert s2["final_step"] == 40

    # Eval rows continue past the checkpoint with no duplicates.
    evals = db_rows(db, "SELECT step, episode FROM evals ORDER BY step, episode")
    assert evals == [(10, 0), (20, 0), (30, 0), (40, 0)]
    assert db_rows(db, "SELECT step, episode, COUNT(*) FROM evals"
                       " GROUP BY step, episode HAVING COUNT(*) > 1") == []

    # Losses appear exactly once per emitting step; the values prove the
    # trainer's observe counter resumed at 20 instead of re-running steps.
    losses = dict(db_rows(db, "SELECT step, value FROM metrics WHERE key='loss'"))
    assert sorted(losses) == [10, 20, 30, 40]
    assert db_rows(db, "SELECT step FROM metrics WHERE key='loss'"
                       " GROUP BY step HAVING COUNT(*) > 1") == []
    assert losses[30] == pytest.approx(1.0 / 30.0)
    assert losses[40] == pytest.approx(1.0 / 40.0)

    ckpts = {p.name for p in (tmp_path / "res").glob("ckpt_*.pt")}
    assert {"ckpt_10.pt", "ckpt_20.pt", "ckpt_30.pt", "ckpt_40.pt",
            "ckpt_latest.pt"} <= ckpts


def test_resume_without_checkpoint_raises(tmp_path):
    cfg = make_cfg(tmp_path, run_name="nope")
    with pytest.raises(FileNotFoundError):
        train(cfg, resume=True)


def test_expand_grid_dotted_keys(tmp_path):
    base = make_cfg(tmp_path)
    grid = {"lr": [1e-3, 3e-4], "algo_kwargs.epsilon_final": [0.1, 0.05]}
    cfgs = expand_grid(base, grid)
    assert len(cfgs) == 4
    names = [c.run_name for c in cfgs]
    assert len(set(names)) == 4
    combos = {(c.lr, c.algo_kwargs["epsilon_final"]) for c in cfgs}
    assert combos == {(1e-3, 0.1), (1e-3, 0.05), (3e-4, 0.1), (3e-4, 0.05)}
    assert base.algo_kwargs == {}, "expand_grid must not mutate the base config"
    for c in cfgs:
        assert "lr=" in c.run_name and "epsilon_final=" in c.run_name


def test_run_sweep_two_processes(tmp_path):
    out_root = str(tmp_path / "runs")
    base = RunConfig(algo="_stub_test_algo", network="single", demand="light",
                     seed=0, total_steps=12, episode_seconds=60.0, eval_every=12,
                     eval_episodes=1, out_root=out_root)
    cfgs = expand_grid(base, {"seed": [0, 1]})
    assert len(cfgs) == 2
    df = run_sweep(cfgs, processes=2)
    assert len(df) == 2
    assert set(df["run_name"]) == {c.run_name for c in cfgs}
    assert df["error"].isna().all()
    assert (df["step"] == 12).all()
    for c in cfgs:
        run_dir = Path(out_root) / c.run_name
        assert (run_dir / "ckpt_latest.pt").exists()
        assert (run_dir / "metrics.sqlite").exists()


def test_summarize_aggregates_final_evals(tmp_path):
    out_root = str(tmp_path / "runs")
    for seed in (0, 1):
        train(make_cfg(tmp_path, out_root=out_root, seed=seed, total_steps=12,
                       eval_every=12, eval_episodes=2))
    df = summarize(out_root)
    assert len(df) == 2
    assert {"run_name", "algo", "seed", "step", "mean_reward", "total_delay",
            "throughput", "mean_queue"} <= set(df.columns)
    assert sorted(df["seed"]) == [0, 1]
    assert (df["step"] == 12).all()
    assert (df["episodes"] == 2).all()
    assert df["total_delay"].notna().all() and df["throughput"].notna().all()
