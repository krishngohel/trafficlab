"""Tests for rl/dqn.py: independent double-DQN Trainer."""
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from trafficlab.env import make_env
from trafficlab.rl.dqn import Trainer, linear_epsilon


class FakeEnv:
    """Duck-typed stand-in exposing only the attrs Trainer reads."""

    def __init__(self, n_agents=2, n_phases=4, obs_dim=6):
        self.agents = [str(i) for i in range(n_agents)]
        self.n_phases = {a: n_phases for a in self.agents}
        self.max_phases = n_phases
        self.obs_dim = obs_dim


class TinyQ(torch.nn.Module):
    """Deterministic linear Q-net: Q(s) = s @ W.T, with a hand-set W."""

    def __init__(self, w):
        super().__init__()
        self.w = torch.nn.Parameter(torch.tensor(w, dtype=torch.float32))

    def forward(self, x):
        return x @ self.w.T


def make_cfg(**over):
    base = dict(seed=0, total_steps=100, gamma=0.97, lr=1e-3, algo_kwargs={})
    base.update(over)
    return SimpleNamespace(**base)


def random_infos(env, rng):
    """Random masks with at least one legal action per agent."""
    infos = {}
    for a in env.agents:
        n = env.n_phases[a]
        mask = rng.random(n) < 0.5
        mask[rng.integers(n)] = True
        infos[a] = {"action_mask": mask}
    return infos


def random_obs(env, rng):
    return {a: rng.normal(size=env.obs_dim).astype(np.float32) for a in env.agents}


def params_equal(net_a, net_b):
    pa, pb = list(net_a.parameters()), list(net_b.parameters())
    return len(pa) == len(pb) and all(torch.equal(p, q) for p, q in zip(pa, pb))


# --------------------------------------------------------------------- masking
def test_act_respects_masks():
    env = FakeEnv(n_agents=2, n_phases=4)
    trainer = Trainer(make_cfg(), env)          # epsilon = 1.0 at step 0
    rng = np.random.default_rng(7)
    for explore in (True, False):
        for _ in range(200):
            obs, infos = random_obs(env, rng), random_infos(env, rng)
            actions = trainer.act(obs, infos, explore=explore)
            for a in env.agents:
                assert infos[a]["action_mask"][actions[a]], \
                    f"agent {a} picked masked action {actions[a]} (explore={explore})"


def test_act_greedy_is_deterministic():
    env = FakeEnv()
    trainer = Trainer(make_cfg(), env)
    rng = np.random.default_rng(3)
    obs, infos = random_obs(env, rng), random_infos(env, rng)
    first = trainer.act(obs, infos, explore=False)
    for _ in range(5):
        assert trainer.act(obs, infos, explore=False) == first


# --------------------------------------------------------------------- epsilon
def test_epsilon_schedule_endpoints():
    env = FakeEnv()
    trainer = Trainer(make_cfg(total_steps=1000), env)
    assert trainer.epsilon() == pytest.approx(1.0)          # step 0
    trainer.env_steps = 400                                  # 40% of total
    assert trainer.epsilon() == pytest.approx(0.05)
    trainer.env_steps = 200                                  # halfway down
    assert trainer.epsilon() == pytest.approx(0.525)
    trainer.env_steps = 100_000                              # long after decay
    assert trainer.epsilon() == pytest.approx(0.05)
    assert linear_epsilon(0, 1000) == pytest.approx(1.0)
    assert linear_epsilon(400, 1000) == pytest.approx(0.05)


# ------------------------------------------------------------------ double DQN
def test_double_dqn_target_hand_check():
    """Target must be r + gamma * Q_target(s', argmax_legal Q_online(s', .))."""
    env = FakeEnv(n_agents=1, n_phases=3, obs_dim=2)
    trainer = Trainer(make_cfg(gamma=0.5), env)
    key = trainer._key_of["0"]
    trainer.nets[key] = TinyQ([[1.0, 4.0], [2.0, 1.0], [3.0, 2.0]])
    trainer.targets[key] = TinyQ([[10.0, 40.0], [20.0, 10.0], [30.0, 20.0]])

    next_obs = torch.tensor([[1.0, 0.0], [0.0, 1.0]])
    # online Q(s1')=[1,2,3] but action 2 masked -> a*=1; online Q(s2')=[4,1,2] -> a*=0
    next_mask = torch.tensor([[True, True, False], [True, True, True]])
    rewards = torch.tensor([1.0, -1.0])

    got = trainer._td_targets("0", rewards, next_obs, next_mask)
    # y1 = 1 + 0.5 * Q_target(s1', 1) = 1 + 0.5*20 = 11
    # y2 = -1 + 0.5 * Q_target(s2', 0) = -1 + 0.5*40 = 19
    expected = torch.tensor([11.0, 19.0])
    assert torch.allclose(got, expected, atol=1e-5)
    # distinguishes from vanilla DQN (max over target: 1 + 0.5*30 = 16) and from
    # unmasked online argmax (a*=2: 1 + 0.5*30 = 16): both would give y1 = 16.
    assert abs(got[0].item() - 16.0) > 1.0


# ------------------------------------------------------------------ target sync
def test_target_sync_cadence():
    env = FakeEnv(n_agents=1, n_phases=3, obs_dim=4)
    cfg = make_cfg(lr=1e-2, algo_kwargs={"warmup": 1, "batch_size": 4, "target_sync": 5})
    trainer = Trainer(cfg, env)
    rng = np.random.default_rng(11)
    key = trainer._key_of["0"]

    equal_after = []
    obs, infos = random_obs(env, rng), random_infos(env, rng)
    for _ in range(12):
        actions = trainer.act(obs, infos, explore=True)
        next_obs, next_infos = random_obs(env, rng), random_infos(env, rng)
        rewards = {a: 1.0 + rng.random() for a in env.agents}
        metrics = trainer.observe(obs, actions, rewards, next_obs, next_infos, False)
        assert "loss" in metrics                    # warmup=1: update every step
        equal_after.append(params_equal(trainer.nets[key], trainer.targets[key]))
        obs, infos = next_obs, next_infos

    assert trainer.update_counts[key] == 12
    # target == online exactly on sync updates (5 and 10), and only there
    assert [i + 1 for i, eq in enumerate(equal_after) if eq] == [5, 10]


# ---------------------------------------------------------------- share_weights
def test_share_weights_identical_policies():
    env = FakeEnv(n_agents=3, n_phases=4, obs_dim=6)
    trainer = Trainer(make_cfg(algo_kwargs={"share_weights": True}), env)
    rng = np.random.default_rng(5)
    for _ in range(20):
        vec = rng.normal(size=env.obs_dim).astype(np.float32)
        obs = {a: vec.copy() for a in env.agents}
        mask = np.array([True, True, False, True])
        infos = {a: {"action_mask": mask.copy()} for a in env.agents}
        actions = trainer.act(obs, infos, explore=False)
        assert len(set(actions.values())) == 1, f"shared net gave {actions}"
        qs = [trainer._q_values(a, obs[a]) for a in env.agents]
        for q in qs[1:]:
            assert torch.equal(qs[0], q)


# ------------------------------------------------------------------- state dict
def test_state_dict_round_trip():
    env = FakeEnv(n_agents=2, n_phases=4)
    cfg = make_cfg(lr=1e-2, algo_kwargs={"warmup": 2, "batch_size": 4, "target_sync": 3})
    a = Trainer(cfg, env)
    rng = np.random.default_rng(9)
    obs, infos = random_obs(env, rng), random_infos(env, rng)
    for _ in range(6):                              # consume rng, do real updates
        actions = a.act(obs, infos, explore=True)
        next_obs, next_infos = random_obs(env, rng), random_infos(env, rng)
        rewards = {ag: rng.normal() for ag in env.agents}
        a.observe(obs, actions, rewards, next_obs, next_infos, False)
        obs, infos = next_obs, next_infos

    sd = a.state_dict()
    probe_obs, probe_infos = random_obs(env, rng), random_infos(env, rng)
    greedy_a = a.act(probe_obs, probe_infos, explore=False)
    explore_a = a.act(probe_obs, probe_infos, explore=True)   # consumes a's rng after sd

    b = Trainer(cfg, env)
    b.load_state_dict(sd)
    assert b.env_steps == a.env_steps
    assert b.epsilon() == pytest.approx(a.epsilon())
    assert b.update_counts == a.update_counts
    assert b.act(probe_obs, probe_infos, explore=False) == greedy_a
    assert b.act(probe_obs, probe_infos, explore=True) == explore_a  # same rng stream


# ------------------------------------------------------------------ smoke train
def test_smoke_train_single_light():
    env = make_env("single", "light", episode_seconds=600.0)
    cfg = make_cfg(total_steps=60,
                   algo_kwargs={"warmup": 20, "batch_size": 16, "target_sync": 25})
    trainer = Trainer(cfg, env)
    obs, infos = env.reset(seed=0)
    losses = []
    for _ in range(60):
        actions = trainer.act(obs, infos, explore=True)
        next_obs, rewards, _terms, truncs, next_infos = env.step(actions)
        metrics = trainer.observe(obs, actions, rewards, next_obs, next_infos,
                                  truncs["__all__"])
        if metrics:
            assert np.isfinite(metrics["loss"])
            assert 0.0 <= metrics["epsilon"] <= 1.0
            losses.append(metrics["loss"])
        obs, infos = next_obs, next_infos
        assert not truncs["__all__"]                # 600 s episode > 60 * 5 s
    env.close()
    assert len(losses) == 41                        # first update the step buffer hits 20
    assert trainer.env_steps == 60
