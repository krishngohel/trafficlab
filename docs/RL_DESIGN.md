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
  ippo.py       alias module: `algo="ippo"` imports ppo.Trainer (no logic of its own)
  gat.py        GAT-PPO: graph-attention encoder over intersection neighbors
  harness.py    RunConfig, train(), checkpoint/resume, SQLite metrics, eval + traj dump
  sweep.py      sweep runner over RunConfig grids with multiprocessing
  _stub_test_algo.py   trivial Trainer used by the harness tests (not a real algo)
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
  "extra"}`. The authoritative trainer state (nets, optimizers, counters) lives in
  `extra["trainer"]` — the top-level model/optimizer fields are best-effort views and
  may be None for some algos; loaders must use `extra["trainer"]`. Writes are atomic
  (temp + os.replace). `train(cfg, resume=True)` resumes from `ckpt_latest.pt`
  DETERMINISTICALLY (RNG streams restored; two resumes are byte-identical) but not as
  an exact continuation of an uninterrupted run: the in-progress episode is restarted
  with a fresh seed draw and replay/rollout buffer contents are rebuilt from live
  experience. Comparisons across runs should therefore compare uninterrupted runs.
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
single shared QNet for all agents (still independent decisions). Cadence note: with
shared weights the one net receives one Adam step per agent per env step, so target
syncs happen every `target_sync / n_agents` env steps and the effective learning rate
scales with agent count relative to the per-agent path. Defaults:
buffer 50k per agent, batch 64, target sync every 500 updates, 1 update/env step per agent
once that agent's buffer holds `warmup` (500) transitions,
epsilon 1.0→0.05 linear over 40% of total_steps, gradient clip 10, Huber loss.
`algo_kwargs` keys: `share_weights`, `buffer_size`, `batch_size`, `target_sync`, `warmup`,
`grad_clip`, `eps_start`, `eps_final`, `eps_decay_frac`, `reward_scale`.
Replay stores (obs, action, reward, next_obs, next_mask, truncated) per agent; standard
bootstrap on truncation (bootstrap from next state — continuing task).

## ppo.py (IPPO, parameter sharing)

One shared ActorCritic; every agent's transition is a row in the shared rollout, kept as
one GAE chain per agent so advantages never mix agents' reward streams.
Defaults: rollout 2048 agent-steps, 4 epochs, minibatch 256, clip 0.2, GAE lambda 0.95,
entropy coef 0.01, value coef 0.5, grad clip 0.5, advantages normalized **per minibatch**
(minibatches shuffle rows from all agents together). Value bootstraps across episode
truncation. `algo_kwargs` keys: `rollout_steps`, `epochs`, `minibatch`, `clip`,
`gae_lambda`, `entropy_coef`, `value_coef`, `grad_clip`, `reward_scale`.

## gat.py (GAT-PPO)

`gat.Trainer` subclasses `ppo.Trainer`: the PPO loop is identical, but the policy is a
GATActorCritic evaluated over every intersection at once (batch dimension = time, so a
minibatch element is a whole graph-step). Node order is `sorted(env.agents)`; adjacency
from `env.neighbors` + self loops. Same defaults and `algo_kwargs` as ppo.py, except
rollout 1024 graph-steps.

## reward_scale (all three algos)

`algo_kwargs["reward_scale"]` (default 1.0) multiplies rewards at buffer insertion. It is
not cosmetic: raw pressure/queue rewards are O(−30..−80) per step, and against a
zero-initialized value head the resulting value loss bulldozes the shared PPO trunk. See
iteration 1 in `docs/EXPERIMENT_LOG.md`.

## Tuned recipe (what the defaults above are NOT)

The per-algo defaults in this file are the *library* defaults. They are deliberately left
alone; the settings that actually learn were found empirically and live in the sweep specs
(`configs/sweeps/iter*.json`), with the reasoning in `docs/EXPERIMENT_LOG.md`. As of
iteration 5/6 the working recipe is:

| knob | library default | tuned value | why (EXPERIMENT_LOG) |
|---|---|---|---|
| `decision_interval` | 5.0 s | **10.0 s** | at 5 s the min-green mask forces ~half of all actions; 10 s gives clean unmasked decisions (iter 3) |
| `gamma` | 0.97 | **0.9** | sharpens credit to ~10 decisions instead of ~33 (iter 4) |
| `algo_kwargs.reward_scale` | 1.0 | **0.02** | fixes the value-loss pathology (iter 1–2) |
| `rollout_steps` (PPO/GAT) | 2048 / 1024 | **512** | 2048 with one agent = 9 updates per 20k-step run (iter 2–5) |
| `minibatch` (PPO/GAT) | 256 | **128** | pairs with the smaller rollout |
| `entropy_coef` (PPO/GAT) | 0.01 | **0.02** | early exploration insurance (iter 4) |
| `warmup` (DQN) | 500 | **2000** | steadier early TD targets (iter 4–6) |
| `reward` | `pressure` | **`queue`** | separates hold-vs-cycle ~2× better (iter 4–5) |
| algo | — | **`dqn`** | DQN beat IPPO and every classical baseline by 60k steps (iter 5) |

Do not change the module defaults to match this table without re-running the sweeps —
`docs/EXPERIMENT_LOG.md` compares runs against the defaults as written here.

## sweep.py

```python
def expand_grid(base: RunConfig, grid: dict[str, list]) -> list[RunConfig]
    # dotted keys allowed: "lr", "algo_kwargs.entropy_coef", ...; run_name auto-suffixed
    # with the varied key=value pairs (see runs/ dir names)
def run_sweep(configs, processes: int = 6, resume: bool = False) -> "pd.DataFrame"
    # multiprocessing Pool over train(); collects final eval rows from each run DB
def summarize(out_root="runs") -> DataFrame   # all runs: final eval mean_delay/throughput
python scripts/sweep.py --spec configs/sweeps/<name>.json   # {"base": {...}, "grid": {...}}
```

`sweep.py` imports pandas at module level; it is not a declared project dependency
(pyproject lists only numpy + torch), so sweeps and the analysis scripts need it installed.

## scripts

- `scripts/train.py --algo ippo --network single --demand rush --seed 0 ...` → harness.train
  (also `--reward`, `--total-steps`, `--decision-interval`, `--gamma`, `--lr`,
  `--eval-every`, `--eval-episodes`, `--eval-seed-base`, `--run-name`, `--out-root`,
  `--algo-kwargs '<json>'`, `--no-record-eval-traj`)
- `scripts/sweep.py --spec <json> [--processes 6]`
- Both accept `--resume`.
- `scripts/evaluate.py --runs runs/<name> ...` loads a trained policy from that run dir
  (`config.json` + `ckpt_latest.pt`) and evaluates it greedily alongside the baselines;
  `scripts/tables.py` / `scripts/plots.py` turn its CSV into `results/TABLES.md`,
  `results/summary.json`, and `results/plots/*.png`.

Shipped sweep specs live in `configs/sweeps/`; each iteration's spec is referenced from
the matching section of `docs/EXPERIMENT_LOG.md`.
