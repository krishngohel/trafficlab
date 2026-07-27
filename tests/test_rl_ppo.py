"""Tests for IPPO (rl/ppo.py) and GAT-PPO (rl/gat.py).

Covers: action masking under both greedy and sampled acting, the clipped-PPO
loss against a hand-computed value, GAE wiring (compute_gae bootstraps from
the value of the last observed next_obs), the entropy bonus sign, state_dict
round-trips preserving act(), GAT adjacency construction, and short smoke
training runs with finite losses.
"""
import io
import math

import numpy as np
import pytest
import torch

from trafficlab.env import make_env
from trafficlab.rl import gat, ppo


class Cfg:
    """Duck-typed stand-in for harness.RunConfig (only the fields Trainers read)."""

    def __init__(self, seed=0, gamma=0.97, lr=3e-4, algo_kwargs=None, total_steps=1000):
        self.seed = seed
        self.gamma = gamma
        self.lr = lr
        self.algo_kwargs = algo_kwargs or {}
        self.total_steps = total_steps


def single_env(**kwargs):
    return make_env("single", "light", **kwargs)


def full_mask_infos(agents, n_actions):
    return {a: {"action_mask": np.ones(n_actions, dtype=bool)} for a in agents}


# ---------------------------------------------------------------- masking
@pytest.mark.parametrize("mod", [ppo, gat], ids=["ppo", "gat"])
def test_masked_actions_never_chosen(mod):
    env = single_env()
    tr = mod.Trainer(Cfg(), env)
    rng = np.random.default_rng(7)
    for _ in range(40):
        obs = {"0": (rng.normal(size=env.obs_dim) * 5).astype(np.float32)}
        legal = np.zeros(env.max_phases, dtype=bool)
        k = int(rng.integers(1, env.max_phases))
        legal[rng.choice(env.max_phases, size=k, replace=False)] = True
        infos = {"0": {"action_mask": legal}}
        for explore in (False, True):
            a = tr.act(obs, infos, explore)["0"]
            assert legal[a], f"illegal action {a}, mask {legal}, explore={explore}"


# ---------------------------------------------------------------- PPO math
def test_ppo_loss_matches_hand_computation():
    """Single crafted minibatch, fixed old/new logprobs and advantages."""
    old_logp = [-1.0, -0.5, -2.0, -1.5]
    new_logp = [-0.8, -0.9, -1.2, -1.5]
    adv = [1.0, -1.0, 2.0, 0.5]
    values = [0.3, -0.2, 1.0, 0.0]
    returns = [0.5, 0.0, 0.5, 0.25]
    entropy = [1.0, 1.2, 0.8, 1.1]
    clip, value_coef, entropy_coef = 0.2, 0.5, 0.01

    t = lambda x: torch.tensor(x, dtype=torch.float64)
    loss, metrics = ppo.ppo_loss(t(new_logp), t(old_logp), t(adv), t(values),
                                 t(returns), t(entropy), clip=clip,
                                 value_coef=value_coef, entropy_coef=entropy_coef)

    # Hand computation in plain Python.
    surr = []
    n_clipped = 0
    for nl, ol, a in zip(new_logp, old_logp, adv):
        r = math.exp(nl - ol)
        surr.append(min(r * a, min(max(r, 1 - clip), 1 + clip) * a))
        n_clipped += abs(r - 1.0) > clip
    policy_loss = -sum(surr) / 4
    value_loss = sum((v - r) ** 2 for v, r in zip(values, returns)) / 4
    ent = sum(entropy) / 4
    expected = policy_loss + value_coef * value_loss - entropy_coef * ent

    assert float(loss) == pytest.approx(expected, abs=1e-5)
    assert float(loss) == pytest.approx(-0.7861875, abs=1e-5)   # independent check
    assert metrics["policy_loss"] == pytest.approx(-0.825, abs=1e-5)
    assert metrics["value_loss"] == pytest.approx(0.098125, abs=1e-5)
    assert metrics["entropy"] == pytest.approx(1.025, abs=1e-5)
    assert metrics["clip_frac"] == pytest.approx(n_clipped / 4)


def test_higher_entropy_lowers_loss():
    """More uniform policy -> larger entropy -> strictly smaller loss."""
    uniform = torch.distributions.Categorical(logits=torch.zeros(2, 4)).entropy()
    peaked = torch.distributions.Categorical(
        logits=torch.tensor([[8.0, 0.0, 0.0, 0.0]] * 2)).entropy()
    args = dict(new_logp=torch.tensor([-1.0, -1.0]), old_logp=torch.tensor([-1.0, -1.0]),
                advantages=torch.tensor([1.0, -1.0]), values=torch.zeros(2),
                returns=torch.zeros(2))
    loss_uniform, m_uniform = ppo.ppo_loss(entropy=uniform, **args)
    loss_peaked, m_peaked = ppo.ppo_loss(entropy=peaked, **args)
    assert m_uniform["entropy"] > m_peaked["entropy"]
    assert float(loss_uniform) < float(loss_peaked)


# ---------------------------------------------------------------- GAE wiring
@pytest.mark.parametrize("mod", [ppo, gat], ids=["ppo", "gat"])
def test_compute_gae_bootstraps_from_last_next_obs(mod, monkeypatch):
    env = single_env()
    steps = 6
    tr = mod.Trainer(Cfg(algo_kwargs={"rollout_steps": steps, "minibatch": steps,
                                      "epochs": 1}), env)
    buf = tr.buffers["0"]
    calls = []
    orig = buf.compute_gae

    def spy(last_values, gamma, lam):
        calls.append((last_values, gamma, lam))
        return orig(last_values, gamma, lam)

    monkeypatch.setattr(buf, "compute_gae", spy)
    monkeypatch.setattr(tr, "_update", lambda: {"loss": 0.0})   # keep weights frozen

    obs, infos = env.reset(seed=0)
    fill_transition = None
    for _ in range(steps):
        acts = tr.act(obs, infos, explore=True)
        next_obs, rewards, _term, trunc, next_infos = env.step(acts)
        out = tr.observe(obs, acts, rewards, next_obs, next_infos, trunc["__all__"])
        if out and fill_transition is None:
            fill_transition = (next_obs, next_infos)
        obs, infos = next_obs, next_infos
    env.close()

    assert len(calls) == 1, "compute_gae must run exactly once per filled rollout"
    exp_obs, exp_infos = fill_transition
    with torch.no_grad():
        _, v = tr._forward(torch.from_numpy(tr._stack_obs(exp_obs)),
                           tr._stack_masks(exp_infos))
    assert calls[0][0] == pytest.approx(float(v.flatten()[0]), abs=1e-6)
    assert calls[0][1] == pytest.approx(0.97)    # cfg.gamma
    assert calls[0][2] == pytest.approx(0.95)    # GAE lambda default


# ---------------------------------------------------------------- state_dict
@pytest.mark.parametrize("mod", [ppo, gat], ids=["ppo", "gat"])
def test_state_dict_roundtrip_preserves_act(mod):
    env = single_env()
    tr1 = mod.Trainer(Cfg(seed=3), env)
    with torch.no_grad():                       # move tr1 away from the fresh init
        for p in tr1.net.parameters():
            p.add_(torch.linspace(-0.5, 0.5, p.numel()).view_as(p))
    tr2 = mod.Trainer(Cfg(seed=3), env)

    rng = np.random.default_rng(11)
    probes = [{"0": (rng.normal(size=env.obs_dim) * 3).astype(np.float32)}
              for _ in range(12)]
    infos = full_mask_infos(env.agents, env.max_phases)

    before = [tr2.act(o, infos, explore=False) for o in probes]
    target = [tr1.act(o, infos, explore=False) for o in probes]
    assert any(b != t for b, t in zip(before, target)), "perturbation had no effect"

    f = io.BytesIO()                            # round-trip through serialization
    torch.save(tr1.state_dict(), f)
    f.seek(0)
    tr2.load_state_dict(torch.load(f, weights_only=False))
    after = [tr2.act(o, infos, explore=False) for o in probes]
    assert after == target


# ---------------------------------------------------------------- adjacency
def test_gat_adjacency_grid2x2():
    env = make_env("grid2x2", "light")
    tr = gat.Trainer(Cfg(), env)
    adj = tr.adj
    assert tr.agents == sorted(env.agents)
    assert adj.shape == (4, 4) and adj.dtype == torch.bool
    assert torch.equal(adj, adj.T), "adjacency must be symmetric"
    assert bool(adj.diagonal().all()), "every node needs a self-loop"
    assert (adj.sum(dim=1) == 3).all(), "each grid2x2 node: 2 neighbors + self"
    idx = {a: i for i, a in enumerate(tr.agents)}
    for a in env.agents:
        for b in env.agents:
            expected = (a == b) or (b in env.neighbors[a])
            assert bool(adj[idx[a], idx[b]]) == expected, (a, b)


# ---------------------------------------------------------------- smoke train
@pytest.mark.parametrize("mod", [ppo, gat], ids=["ppo", "gat"])
def test_multi_agent_update_grid2x2(mod):
    """Shared update combining rows from all 4 agents/nodes runs and is finite."""
    env = make_env("grid2x2", "light")
    rollout = 16 if mod is ppo else 4           # 16 agent-steps == 4 graph-steps
    tr = mod.Trainer(Cfg(algo_kwargs={"rollout_steps": rollout, "minibatch": 8,
                                      "epochs": 1}), env)
    obs, infos = env.reset(seed=0)
    updates = []
    for _ in range(4):
        acts = tr.act(obs, infos, explore=True)
        next_obs, rewards, _term, trunc, next_infos = env.step(acts)
        out = tr.observe(obs, acts, rewards, next_obs, next_infos, trunc["__all__"])
        if out:
            updates.append(out)
        obs, infos = next_obs, next_infos
    env.close()
    assert len(updates) == 1
    assert all(np.isfinite(v) for v in updates[0].values())


@pytest.mark.parametrize("mod", [ppo, gat], ids=["ppo", "gat"])
def test_smoke_train_60_decision_steps(mod):
    env = single_env()
    tr = mod.Trainer(Cfg(algo_kwargs={"rollout_steps": 20, "minibatch": 20,
                                      "epochs": 2}), env)
    obs, infos = env.reset(seed=0)
    updates = []
    for _ in range(60):
        acts = tr.act(obs, infos, explore=True)
        assert infos["0"]["action_mask"][acts["0"]]
        next_obs, rewards, _term, trunc, next_infos = env.step(acts)
        out = tr.observe(obs, acts, rewards, next_obs, next_infos, trunc["__all__"])
        if out:
            updates.append(out)
        obs, infos = next_obs, next_infos
    env.close()
    assert len(updates) == 3                    # rollout of 20 fills at 20/40/60
    for m in updates:
        assert set(m) >= {"loss", "policy_loss", "value_loss", "entropy"}
        for key, val in m.items():
            assert np.isfinite(val), f"{key} not finite: {val}"
