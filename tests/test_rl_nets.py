"""Tests for trafficlab.rl.nets and trafficlab.rl.buffers.

Covers: output shapes, action masking (masked action never argmax/sampled),
GAT permutation consistency, ReplayBuffer wraparound, hand-computed GAE with
mid-rollout truncation, and determinism of sampling under seeded rngs.
"""
import numpy as np
import pytest
import torch

from trafficlab.rl.buffers import ReplayBuffer, RolloutBuffer
from trafficlab.rl.nets import ActorCritic, GATActorCritic, QNet

OBS_DIM = 6
N_ACT = 4


@pytest.fixture(autouse=True)
def _torch_seed():
    torch.manual_seed(0)


# --------------------------------------------------------------------- shapes
def test_qnet_shapes():
    net = QNet(OBS_DIM, N_ACT)
    assert net(torch.zeros(5, OBS_DIM)).shape == (5, N_ACT)
    assert net(torch.zeros(OBS_DIM)).shape == (N_ACT,)


def test_actor_critic_shapes():
    net = ActorCritic(OBS_DIM, N_ACT)
    mask = torch.ones(5, N_ACT, dtype=torch.bool)
    logits, value = net.dist_value(torch.randn(5, OBS_DIM), mask)
    assert logits.shape == (5, N_ACT)
    assert value.shape == (5,)
    logits1, value1 = net.dist_value(torch.randn(OBS_DIM), torch.ones(N_ACT, dtype=torch.bool))
    assert logits1.shape == (N_ACT,)
    assert value1.shape == ()


def _ring_adj(n):
    adj = torch.eye(n, dtype=torch.bool)
    for i in range(n):
        adj[i, (i + 1) % n] = True
        adj[i, (i - 1) % n] = True
    return adj


def test_gat_shapes():
    n = 5
    net = GATActorCritic(OBS_DIM, N_ACT)
    obs = torch.randn(n, OBS_DIM)
    adj = _ring_adj(n)
    mask = torch.ones(n, N_ACT, dtype=torch.bool)
    logits, value = net(obs, adj, mask)
    assert logits.shape == (n, N_ACT)
    assert value.shape == (n,)


def test_gat_batched_matches_per_step():
    n, batch = 4, 3
    net = GATActorCritic(OBS_DIM, N_ACT)
    obs = torch.randn(batch, n, OBS_DIM)
    adj = _ring_adj(n)
    mask = torch.ones(batch, n, N_ACT, dtype=torch.bool)
    logits, value = net(obs, adj, mask)
    assert logits.shape == (batch, n, N_ACT)
    assert value.shape == (batch, n)
    for b in range(batch):
        lb, vb = net(obs[b], adj, mask[b])
        torch.testing.assert_close(logits[b], lb, atol=1e-6, rtol=1e-5)
        torch.testing.assert_close(value[b], vb, atol=1e-6, rtol=1e-5)


# -------------------------------------------------------------------- masking
def test_actor_critic_masked_action_never_argmax_or_sampled():
    net = ActorCritic(OBS_DIM, N_ACT)
    obs = torch.randn(1, OBS_DIM)
    mask = torch.tensor([[True, False, True, True]])
    logits, _ = net.dist_value(obs, mask)
    assert logits[0, 1].item() == -1e9
    assert logits.argmax(-1).item() != 1
    probs = torch.softmax(logits[0], dim=-1)
    assert probs[1].item() == 0.0
    gen = torch.Generator().manual_seed(123)
    draws = torch.multinomial(probs, 200, replacement=True, generator=gen)
    assert (draws != 1).all()


def test_gat_masked_action_never_argmax_or_sampled():
    n = 3
    net = GATActorCritic(OBS_DIM, N_ACT)
    obs = torch.randn(n, OBS_DIM)
    adj = _ring_adj(n)
    mask = torch.ones(n, N_ACT, dtype=torch.bool)
    mask[0, 2] = False   # node 0 lacks phase 2
    mask[1, 0] = False   # node 1 lacks phase 0
    logits, _ = net(obs, adj, mask)
    assert (logits[~mask] == -1e9).all()
    assert logits[0].argmax().item() != 2
    assert logits[1].argmax().item() != 0
    gen = torch.Generator().manual_seed(7)
    probs = torch.softmax(logits, dim=-1)
    for node, banned in ((0, 2), (1, 0)):
        draws = torch.multinomial(probs[node], 200, replacement=True, generator=gen)
        assert (draws != banned).all()


# --------------------------------------------------- GAT permutation symmetry
def test_gat_permutation_consistency():
    n = 5
    net = GATActorCritic(OBS_DIM, N_ACT)
    obs = torch.randn(n, OBS_DIM)
    adj = torch.eye(n, dtype=torch.bool)   # path graph 0-1-2-3-4 + self-loops
    for i in range(n - 1):
        adj[i, i + 1] = adj[i + 1, i] = True
    mask = torch.ones(n, N_ACT, dtype=torch.bool)
    mask[2, 3] = False
    mask[4, 1] = False
    logits, value = net(obs, adj, mask)

    perm = torch.tensor([3, 0, 4, 1, 2])
    logits_p, value_p = net(obs[perm], adj[perm][:, perm], mask[perm])
    torch.testing.assert_close(logits_p, logits[perm], atol=1e-5, rtol=1e-5)
    torch.testing.assert_close(value_p, value[perm], atol=1e-5, rtol=1e-5)


# ------------------------------------------------------------- replay buffer
def _fill_replay(buf, count):
    for i in range(count):
        buf.add(
            np.full(3, i, dtype=np.float32), i, float(i) * 10.0,
            np.full(3, i + 0.5, dtype=np.float32),
            np.array([True, i % 2 == 0, True, False]), i == 3,
        )


def test_replay_wraparound_overwrite():
    buf = ReplayBuffer(capacity=4, obs_dim=3)
    _fill_replay(buf, 6)   # items 0..5; 4 and 5 overwrite slots 0 and 1
    assert len(buf) == 4
    np.testing.assert_array_equal(buf.actions, [4, 5, 2, 3])
    np.testing.assert_array_equal(buf.obs[:, 0], [4.0, 5.0, 2.0, 3.0])
    np.testing.assert_array_equal(buf.next_obs[:, 0], [4.5, 5.5, 2.5, 3.5])
    np.testing.assert_array_equal(buf.rewards, [40.0, 50.0, 20.0, 30.0])
    np.testing.assert_array_equal(buf.truncated, [False, False, False, True])
    # next_mask[1] tracks parity of the item stored in each slot: 4, 5, 2, 3.
    np.testing.assert_array_equal(buf.next_masks[:, 1], [True, False, True, False])


def test_replay_sample_deterministic_and_valid():
    buf = ReplayBuffer(capacity=4, obs_dim=3)
    _fill_replay(buf, 6)
    b1 = buf.sample(16, np.random.default_rng(42))
    b2 = buf.sample(16, np.random.default_rng(42))
    for key in ("obs", "action", "reward", "next_obs", "next_mask", "truncated"):
        assert torch.equal(b1[key], b2[key]), key
    assert b1["obs"].dtype == torch.float32
    assert b1["action"].dtype == torch.int64
    assert b1["next_mask"].dtype == torch.bool
    assert b1["truncated"].dtype == torch.bool
    # Only surviving items (2..5) can appear after the wraparound.
    assert set(b1["action"].tolist()) <= {2, 3, 4, 5}


# ------------------------------------------------------------ rollout + GAE
def test_gae_hand_computed_with_mid_truncation():
    values = [1.0, 2.0, 0.5, 1.5]
    rewards = [1.0, 2.0, 3.0, 4.0]
    trunc = [False, True, False, False]
    gamma, lam, last_value = 0.9, 0.8, 2.0

    buf = RolloutBuffer(4, obs_dim=2, n_actions=3)
    for t in range(4):
        buf.add(np.zeros(2, np.float32), np.ones(3, bool), t, -0.1,
                values[t], rewards[t], trunc[t])
    buf.compute_gae(last_value, gamma, lam)

    d3 = rewards[3] + gamma * last_value - values[3]        # 4.3
    a3 = d3
    d2 = rewards[2] + gamma * values[3] - values[2]         # 3.85
    a2 = d2 + gamma * lam * a3                              # 6.946
    # Step 1 is truncated: bootstrap from stored values[2] (no termination
    # zeroing), but the lambda-trace is cut at the episode boundary.
    d1 = rewards[1] + gamma * values[2] - values[1]         # 0.45
    a1 = d1
    d0 = rewards[0] + gamma * values[1] - values[0]         # 1.8
    a0 = d0 + gamma * lam * a1                              # 2.124

    np.testing.assert_allclose(buf.advantages, [a0, a1, a2, a3], atol=1e-6)
    np.testing.assert_allclose(buf.returns, np.add([a0, a1, a2, a3], values), atol=1e-6)

    # Without truncation the trace crosses step 1, so a1 and a0 change.
    buf2 = RolloutBuffer(4, obs_dim=2, n_actions=3)
    for t in range(4):
        buf2.add(np.zeros(2, np.float32), np.ones(3, bool), t, -0.1,
                 values[t], rewards[t], False)
    buf2.compute_gae(last_value, gamma, lam)
    b1 = d1 + gamma * lam * a2
    b0 = d0 + gamma * lam * b1
    np.testing.assert_allclose(buf2.advantages, [b0, b1, a2, a3], atol=1e-6)
    assert abs(buf2.advantages[1] - buf.advantages[1]) > 1e-3


def test_rollout_minibatches_cover_rows_and_are_deterministic():
    size, mb, epochs = 8, 4, 2
    buf = RolloutBuffer(size, obs_dim=2, n_actions=3)
    for t in range(size):
        buf.add(np.full(2, t, np.float32), np.ones(3, bool), t, 0.5 * t,
                float(t), 2.0 * t, False)
    assert buf.full
    buf.compute_gae(0.0, 0.9, 0.95)

    batches = list(buf.minibatches(mb, epochs, np.random.default_rng(7)))
    assert len(batches) == epochs * size // mb
    for b in batches:
        assert b["obs"].shape == (mb, 2)
        assert b["mask"].shape == (mb, 3)
        assert b["advantage"].dtype == torch.float32
    # Each epoch is a full pass: every row exactly once.
    for e in range(epochs):
        epoch_actions = torch.cat([b["action"] for b in batches[e * 2:(e + 1) * 2]])
        assert sorted(epoch_actions.tolist()) == list(range(size))
    # Rows are raw (unnormalized): each row matches the stored arrays.
    for b in batches:
        for j, act in enumerate(b["action"].tolist()):
            assert b["advantage"][j].item() == pytest.approx(buf.advantages[act])
            assert b["return"][j].item() == pytest.approx(buf.returns[act])
            assert b["logprob"][j].item() == pytest.approx(0.5 * act)

    again = list(buf.minibatches(mb, epochs, np.random.default_rng(7)))
    for b1, b2 in zip(batches, again, strict=True):
        for key in b1:
            assert torch.equal(b1[key], b2[key]), key


def test_rollout_add_past_capacity_raises_and_reset_clears():
    buf = RolloutBuffer(2, obs_dim=1, n_actions=2)
    row = (np.zeros(1, np.float32), np.ones(2, bool), 0, 0.0, 0.0, 0.0, False)
    buf.add(*row)
    buf.add(*row)
    with pytest.raises(ValueError):
        buf.add(*row)
    buf.reset()
    assert len(buf) == 0
    buf.add(*row)
    assert len(buf) == 1
