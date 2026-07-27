"""Tests for env.py: the PettingZoo-style parallel multi-agent TrafficEnv.

Covers API shapes/types, observation vector structure, action masking,
truncation timing, all four reward kinds, determinism, episode recording,
and the static neighbor graph.
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from trafficlab.env import MAX_APPROACHES, REWARDS, make_env
from trafficlab.signals import GREEN
from trafficlab.trajectory import validate_file

ROOT = Path(__file__).resolve().parents[1]
PHASE_OFF = 2 * MAX_APPROACHES          # start of the phase one-hot block


def load(kind, name):
    return json.loads((ROOT / "configs" / kind / f"{name}.json").read_text())


def make(network="grid2x2", demand="light", **kwargs):
    return make_env(network, demand, root=ROOT, **kwargs)


def scripted(env, k):
    """Deterministic per-step action script (varies per agent and per step)."""
    return {a: (k + i) % env.n_phases[a] for i, a in enumerate(env.agents)}


# ---------------------------------------------------------------- shapes/types
def test_reset_and_step_shapes_and_types():
    env = make()
    try:
        assert env.agents == ["0", "1", "2", "3"]
        assert env.obs_dim == 13
        obs, infos = env.reset(seed=0)
        assert set(obs) == set(env.agents)
        assert set(infos) == set(env.agents)
        for a in env.agents:
            assert isinstance(obs[a], np.ndarray)
            assert obs[a].dtype == np.float32
            assert obs[a].shape == (13,)
            assert env.observation_space(a).shape == (13,)
            assert env.action_space(a).n == 4
            mask = infos[a]["action_mask"]
            assert isinstance(mask, np.ndarray)
            assert mask.dtype == np.bool_
            assert mask.shape == (env.n_phases[a],)
        obs2, rewards, terms, truncs, infos2 = env.step({a: 0 for a in env.agents})
        assert set(obs2) == set(env.agents)
        assert set(rewards) == set(env.agents)
        assert set(terms) == set(env.agents) | {"__all__"}
        assert set(truncs) == set(env.agents) | {"__all__"}
        assert set(infos2) == set(env.agents)
        for a in env.agents:
            assert obs2[a].dtype == np.float32 and obs2[a].shape == (13,)
            assert isinstance(rewards[a], float)
            assert terms[a] is False
            assert "action_mask" in infos2[a]
        assert terms["__all__"] is False
        assert truncs["__all__"] is False
    finally:
        env.close()


# ---------------------------------------------------------------- obs structure
def test_observation_vector_structure():
    env = make(demand="rush")
    try:
        obs, _ = env.reset(seed=1)
        frames = [obs]
        for k in range(6):
            obs, *_ = env.step(scripted(env, k))
            frames.append(obs)
        for frame in frames:
            for a, vec in frame.items():
                assert np.all(np.isfinite(vec))
                # queue (0..3) and density (4..7) slots are non-negative.
                assert np.all(vec[:PHASE_OFF] >= 0.0)
                onehot = vec[PHASE_OFF:PHASE_OFF + env.max_phases]
                assert np.count_nonzero(onehot) == 1
                assert float(onehot.max()) == 1.0
                assert int(np.argmax(onehot)) < env.n_phases[a]
                assert 0.0 <= float(vec[-1]) <= 1.0
    finally:
        env.close()


# ---------------------------------------------------------------- action mask
def test_action_mask_and_masked_request_is_safe():
    env = make()
    try:
        _, infos = env.reset(seed=0)
        # Precondition for the timing argument below: min_green outlasts one
        # decision interval (grid2x2 defaults: 6 s vs 5 s).
        for a in env.agents:
            assert env.sim.net.intersections[int(a)].min_green > env.decision_ticks * env.dt
        start_phase = {}
        for a in env.agents:
            unit = env.sim.units[int(a)]
            start_phase[a] = unit.phase
            assert not unit.can_switch()        # fresh green, min-green pending
            expected = [i == unit.phase for i in range(env.n_phases[a])]
            assert infos[a]["action_mask"].tolist() == expected
        # Request a masked-out phase: must not crash, and the phase cannot
        # change within this decision step (min_green has not elapsed).
        actions = {a: (start_phase[a] + 1) % env.n_phases[a] for a in env.agents}
        obs, _, _, _, _ = env.step(actions)
        for a in env.agents:
            unit = env.sim.units[int(a)]
            assert unit.phase == start_phase[a]
            assert unit.state == GREEN
            onehot = obs[a][PHASE_OFF:PHASE_OFF + env.max_phases]
            assert int(np.argmax(onehot)) == start_phase[a]
        # Arbitrary in-range (frequently masked) actions never raise.
        for k in range(8):
            env.step(scripted(env, k))
    finally:
        env.close()


# ---------------------------------------------------------------- truncation
def test_truncates_after_exact_step_count():
    episode_seconds, decision_interval = 50.0, 5.0
    env = make(episode_seconds=episode_seconds, decision_interval=decision_interval)
    try:
        env.reset(seed=0)
        n_steps = int(episode_seconds / decision_interval)
        for _ in range(n_steps - 1):
            _, _, terms, truncs, _ = env.step({a: 0 for a in env.agents})
            assert not truncs["__all__"]
            assert all(not truncs[a] for a in env.agents)
        _, _, terms, truncs, _ = env.step({a: 0 for a in env.agents})
        assert truncs["__all__"]
        assert all(truncs[a] for a in env.agents)
        assert not terms["__all__"]             # truncated, never terminated
    finally:
        env.close()


# ---------------------------------------------------------------- rewards
@pytest.mark.parametrize("kind", REWARDS)
def test_reward_kinds_finite_and_correctly_signed(kind):
    env = make(demand="rush", reward=kind)
    try:
        env.reset(seed=1)
        collected = []
        for k in range(8):
            _, rewards, *_ = env.step(scripted(env, k))
            collected.append(rewards)
        for rewards in collected:
            for a, r in rewards.items():
                assert isinstance(r, float)
                assert math.isfinite(r)
                if kind == "queue":
                    assert r <= 0.0
                if kind == "throughput":
                    assert r >= 0.0
        # Non-degenerate: after 40 s of rush demand something happened.
        if kind == "queue":
            assert any(r < 0.0 for rew in collected for r in rew.values())
        if kind == "throughput":
            assert any(r > 0.0 for rew in collected for r in rew.values())
        if kind == "queue":
            # Reward equals minus the sum of that intersection's approach queues.
            q = env.sim.queues_by_approach()
            last = collected[-1]
            for a in env.agents:
                expected = -float(sum(q[ai] for ai in env._approach_idx[a]))
                assert last[a] == expected
    finally:
        env.close()


def test_invalid_reward_kind_rejected():
    with pytest.raises(ValueError):
        make(reward="happiness")


# ---------------------------------------------------------------- determinism
def _rollout(seed, steps=8):
    env = make(demand="rush")
    try:
        obs, _ = env.reset(seed=seed)
        frames, rews = [obs], []
        for k in range(steps):
            obs, rewards, *_ = env.step(scripted(env, k))
            frames.append(obs)
            rews.append(rewards)
        return frames, rews
    finally:
        env.close()


def test_same_seed_same_actions_identical_observations():
    f1, r1 = _rollout(seed=7)
    f2, r2 = _rollout(seed=7)
    for frame1, frame2 in zip(f1, f2):
        for a in frame1:
            assert np.array_equal(frame1[a], frame2[a])
    assert r1 == r2
    # And a different seed diverges somewhere.
    f3, _ = _rollout(seed=8)
    assert any(not np.array_equal(f1[i][a], f3[i][a])
               for i in range(len(f1)) for a in f1[i])


def test_recorded_episodes_byte_identical_and_valid(tmp_path):
    paths = []
    for run in range(2):
        p = tmp_path / f"ep{run}.traj"
        env = make()
        env.record_next_episode(p, policy_label="test")
        env.reset(seed=3)
        for k in range(12):
            env.step(scripted(env, k))
        env.close()                             # flushes the writer
        paths.append(p)
    blob0, blob1 = paths[0].read_bytes(), paths[1].read_bytes()
    assert blob0 == blob1, "same seed + actions produced different recordings"
    assert validate_file(paths[0]) == []


# ---------------------------------------------------------------- neighbors
def test_neighbor_graph_symmetric_grid2x2():
    env = make()
    assert set(env.neighbors) == set(env.agents)
    for a, nbrs in env.neighbors.items():
        assert len(nbrs) == 2                   # 2x2 grid: every corner has 2
        assert len(set(nbrs)) == 2
        assert a not in nbrs
        for b in nbrs:
            assert b in env.agents
            assert a in env.neighbors[b]
