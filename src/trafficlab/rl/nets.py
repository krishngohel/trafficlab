"""Neural networks for the RL stack (see docs/RL_DESIGN.md).

QNet            MLP Q-network: obs_dim -> [128, 128] ReLU -> n_actions.
ActorCritic     Shared MLP body [128, 128] with policy-logit and value heads.
GATActorCritic  Graph-attention actor-critic over the intersection neighbor graph.

Action masking is uniform everywhere: masked-out logits are set to -1e9
before softmax/argmax. All modules take explicit dimensions at construction
and hold no global state; determinism follows from `torch.manual_seed` set
once per run from the config seed.
"""
from __future__ import annotations

import torch
from torch import nn

HIDDEN = 128
MASK_FILL = -1e9
LEAKY_SLOPE = 0.2


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Set logits of masked-out actions to -1e9. mask: bool, True = legal."""
    return logits.masked_fill(~torch.as_tensor(mask).bool(), MASK_FILL)


class QNet(nn.Module):
    """obs_dim -> [128, 128] ReLU -> n_actions raw Q-values.

    Masking is the consumer's job: DQN takes the argmax over masked Q.
    """

    def __init__(self, obs_dim: int, n_actions: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, HIDDEN), nn.ReLU(),
            nn.Linear(HIDDEN, HIDDEN), nn.ReLU(),
            nn.Linear(HIDDEN, n_actions),
        )

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net(obs)


class ActorCritic(nn.Module):
    """obs_dim -> shared [128, 128] ReLU body -> policy logits + state value.

    Heads use orthogonal init: policy gain 0.01, value gain 1.0.
    """

    def __init__(self, obs_dim: int, n_actions: int):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(obs_dim, HIDDEN), nn.ReLU(),
            nn.Linear(HIDDEN, HIDDEN), nn.ReLU(),
        )
        self.policy_head = nn.Linear(HIDDEN, n_actions)
        self.value_head = nn.Linear(HIDDEN, 1)
        nn.init.orthogonal_(self.policy_head.weight, gain=0.01)
        nn.init.zeros_(self.policy_head.bias)
        nn.init.orthogonal_(self.value_head.weight, gain=1.0)
        nn.init.zeros_(self.value_head.bias)

    def dist_value(self, obs: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """(Categorical logits masked to -1e9, value). Shapes [..., A], [...]."""
        h = self.body(obs)
        logits = masked_logits(self.policy_head(h), mask)
        value = self.value_head(h).squeeze(-1)
        return logits, value

    def forward(self, obs: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.dist_value(obs, mask)


class GATActorCritic(nn.Module):
    """One shared node encoder MLP [128], one multi-head attention layer over the
    neighbor graph (2 heads, 64 per head, LeakyReLU attention like GATv1),
    concat(own_embedding, attended) -> [128] -> per-node logits + value.
    forward(node_obs [N, obs_dim], adj [N, N] bool incl. self-loops, mask [N, A]).

    `n_actions` is the max phase count over all intersections; per-node masks
    disable the phases a node does not have. A leading batch dimension is
    also accepted: node_obs [B, N, obs_dim] with adj [N, N] or [B, N, N].
    """

    def __init__(self, obs_dim: int, n_actions: int, heads: int = 2, head_dim: int = 64):
        super().__init__()
        self.heads = heads
        self.head_dim = head_dim
        self.encoder = nn.Sequential(nn.Linear(obs_dim, HIDDEN), nn.ReLU())
        self.attn_w = nn.Linear(HIDDEN, heads * head_dim, bias=False)
        self.attn_src = nn.Parameter(torch.empty(heads, head_dim))
        self.attn_dst = nn.Parameter(torch.empty(heads, head_dim))
        nn.init.xavier_uniform_(self.attn_src)
        nn.init.xavier_uniform_(self.attn_dst)
        self.post = nn.Sequential(nn.Linear(HIDDEN + heads * head_dim, HIDDEN), nn.ReLU())
        self.policy_head = nn.Linear(HIDDEN, n_actions)
        self.value_head = nn.Linear(HIDDEN, 1)
        nn.init.orthogonal_(self.policy_head.weight, gain=0.01)
        nn.init.zeros_(self.policy_head.bias)
        nn.init.orthogonal_(self.value_head.weight, gain=1.0)
        nn.init.zeros_(self.value_head.bias)

    def forward(self, node_obs: torch.Tensor, adj: torch.Tensor,
                mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Returns (masked logits [..., N, A], values [..., N])."""
        h = self.encoder(node_obs)                                    # [..., N, 128]
        w = self.attn_w(h).unflatten(-1, (self.heads, self.head_dim))  # [..., N, H, Dh]
        # GATv1 scoring: e_ij = LeakyReLU(a_src . Wh_i + a_dst . Wh_j)
        src = (w * self.attn_src).sum(-1).transpose(-2, -1)           # [..., H, N]
        dst = (w * self.attn_dst).sum(-1).transpose(-2, -1)           # [..., H, N]
        scores = nn.functional.leaky_relu(
            src.unsqueeze(-1) + dst.unsqueeze(-2), LEAKY_SLOPE)       # [..., H, N, N]
        adj_b = torch.as_tensor(adj).bool()
        if adj_b.dim() == scores.dim() - 1:                           # add head dim
            adj_b = adj_b.unsqueeze(-3)
        scores = scores.masked_fill(~adj_b, MASK_FILL)
        alpha = torch.softmax(scores, dim=-1)                         # [..., H, N, N]
        attended = alpha @ w.transpose(-3, -2)                        # [..., H, N, Dh]
        attended = attended.transpose(-3, -2).flatten(-2)             # [..., N, H*Dh]
        z = self.post(torch.cat([h, attended], dim=-1))               # [..., N, 128]
        logits = masked_logits(self.policy_head(z), mask)
        value = self.value_head(z).squeeze(-1)
        return logits, value
