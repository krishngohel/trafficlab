# RL stack design — module interfaces (M4)

Binding contract for `src/trafficlab/rl/`. Pure PyTorch (CPU), no RL frameworks.
All randomness through explicitly seeded generators (`torch.Generator` + numpy);
`torch.manual_seed` is set once per run from the config seed.

## Package layout

```
src/trafficlab/rl/
  __init__.py
  nets.py       MLP Q-network, MLP actor-critic, GAT actor-critic
  buffers.py    ReplayBuffer (DQN), RolloutBuffer (PPO, GAE)
  dqn.py        IDQN: independent double-DQN per agent (optional weight sharing)
  ppo.py        IPPO: one shared actor-critic over all agents, clipped PPO, GAE
  gat.py        GAT-PPO: graph-attention encoder over intersection neighbors
  harness.py    RunConfig, train(), checkpoint/resume, SQLite metrics, eval + traj dump
  sweep.py      sweep runner over RunConfig grids with multiprocessing
```

## harness.py

```python
@dataclass
class RunConfig:
    algo: str                    # "dqn" | "ippo" | "gat"
    network: str = "single"      # configs/networks name
    demand: str = "rush"
    reward: str = "pressure"
    seed: int = 0
    total_steps: int = 20_000    # env decision steps (5 s each)
    episode_seconds: float = 1200.0
    decision_interval: float = 5.0
    gamma: float = 0.97
    lr: float = 3e-4
    eval_every: int = 2_000      # in decision steps
    eval_episodes: int = 2
    eval_seed_base: int = 10_000
    run_name: str = ""           # default: f"{algo}_{network}_{demand}_{reward}_s{seed}"
    out_root: str = "runs"
    algo_kwargs: dict = field(default_factory=dict)   # see per-algo defaults
    record_eval_traj: bool = True

def train(cfg: RunConfig, resume: bool = False) -> dict   # final summary metrics
```

### Trainer protocol (the harness/algo seam — binding)

Each algo module (`dqn.py`, `ppo.py`, `gat.py`) exposes a class named `Trainer`:

```python
class Trainer:
    def __init__(self, cfg: RunConfig, env: TrafficEnv): ...
    def act(self, obs: dict[str, np.ndarray], infos: dict, explore: bool) -> dict[str, int]
        # explore=False must be deterministic (greedy/argmax); masks from infos["action_mask"]
    def observe(self, obs, actions, rewards, next_obs, next_infos,
                truncated: bool) -> dict[str, float]
        # called once per env step with the transition; performs any updates that are
        # due; returns {} or {"loss": ..., "epsilon": ...} metrics to log at this step
    def state_dict(self) -> dict
    def load_state_dict(self, sd: dict) -> None
```

`harness.train` owns the entire env loop, eval, SQLite, checkpointing, and resume;
algo modules never touch the DB or filesystem. `importlib.import_module(
f"trafficlab.rl.{cfg.algo}").Trainer` is the dispatch. Algo modules read their
hyperparameters from `cfg.algo_kwargs` with the defaults listed below.

- Run dir: `runs/<run_name>/` with `config.json`, `metrics.sqlite`, `ckpt_latest.pt`,
  `ckpt_<step>.pt` every eval, `trajs/eval_s<step>_e<ep>.traj`.
- SQLite (one DB per run, WAL): tables
  `runs(id INTEGER PRIMARY KEY CHECK(id=1), config_json, started_at, finished_at, status)`
  `metrics(step INTEGER, key TEXT, value REAL)` — training losses, epsilon, entropy, etc.
  `evals(step, episode, seed, mean_reward, total_delay, throughput, mean_queue, traj_path)`
- Checkpoints: torch.save of `{"step", "model", "optimizer", "torch_rng", "numpy_rng",
  "extra"}`; `train(cfg, resume=True)` continues from `ckpt_latest.pt` exactly
  (same RNG streams; a resumed run's metrics continue the same DB).
- Eval: greedy/deterministic policy, seeds `eval_seed_base + episode`, env truncation at
  `episode_seconds`; log per-episode `total_delay = sim.cum_delay`, `throughput = sim.departed`,
  `mean_queue` (time-average of summed queues sampled per decision step); dump .traj for
  episode 0 of each eval round when `record_eval_traj`.

## nets.py

```python
class QNet(nn.Module):            # obs_dim -> [128,128] ReLU -> n_actions
class ActorCritic(nn.Module):     # obs_dim -> shared [128,128] -> policy logits + value head
    def dist_value(obs, mask) -> (Categorical-logits masked to -1e9, value)
class GATActorCritic(nn.Module):
    """One shared node encoder MLP [128], one multi-head attention layer over the
    neighbor graph (2 heads, 64 per head, LeakyReLU attention like GATv1),
    concat(own_embedding, attended) -> [128] -> per-node logits + value.
    forward(node_obs [N, obs_dim], adj [N, N] bool incl. self-loops, mask [N, A])."""
```

Action masking everywhere: masked logits = -1e9 before softmax/argmax; DQN argmax over
masked Q. (The env's mask marks phases reachable NOW; current phase is always legal.)

## dqn.py (IDQN)

Independent double-DQN, one QNet per agent; `algo_kwargs["share_weights"]=True` uses a
single shared QNet for all agents (still independent decisions). Defaults:
buffer 50k per agent, batch 64, target sync every 500 updates, 1 update/env step per agent,
epsilon 1.0→0.05 linear over 40% of total_steps, gradient clip 10, Huber loss.
Replay stores (obs, action, reward, next_obs, next_mask, truncated) per agent; standard
bootstrap on truncation (bootstrap from next state — continuing task).

## ppo.py (IPPO, parameter sharing)

One shared ActorCritic; every agent's transition is a row in the shared rollout.
Defaults: rollout 2048 agent-steps, 4 epochs, minibatch 256, clip 0.2, GAE lambda 0.95,
entropy coef 0.01, value coef 0.5, grad clip 0.5, advantage normalization per batch.
Value bootstraps across episode truncation.

## gat.py (GAT-PPO)

PPO loop identical to ppo.py but the policy is GATActorCritic over the whole network
graph at once (batch dimension = time); adjacency from `env.neighbors` + self loops.
Same defaults as ppo.py, rollout 1024 graph-steps.

## sweep.py

```python
def expand_grid(base: RunConfig, grid: dict[str, list]) -> list[RunConfig]
    # dotted keys allowed: "lr", "algo_kwargs.epsilon_final", ...; run_name auto-suffixed
def run_sweep(configs, processes: int = 6) -> "pandas.DataFrame"
    # multiprocessing Pool over train(); collects final eval rows from each run DB
def summarize(out_root="runs") -> DataFrame   # all runs: final eval mean_delay/throughput
python scripts/sweep.py --spec configs/sweeps/<name>.json   # {"base": {...}, "grid": {...}}
```

## scripts

- `scripts/train.py --algo ippo --network single --demand rush --seed 0 ...` → harness.train
- `scripts/sweep.py --spec <json> [--processes 6]`
- Both accept `--resume`.
