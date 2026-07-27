# Experiment log

Chronological record of the sweep → analyze → adjust loop. Every claim links to a
sweep spec in `configs/sweeps/` or a script snippet; metrics come from run SQLite DBs
(`runs/<name>/metrics.sqlite`) or `scripts/evaluate.py` output.

## Iteration 0 — baseline sanity: max-pressure switching period

**Observation.** First recordings showed max-pressure *losing* to naive fixed-time on
grid2x2/rush (135k vs 130k veh·s total delay) — theoretically suspicious, since
max-pressure is throughput-optimal in the store-and-forward abstraction.

**Hypothesis.** The abstraction ignores clearance intervals. With min_green = 6 s,
yellow = 3 s, all-red = 2 s, a controller re-deciding every 5 s can spend ~45% of its
time in transitions, and each switch costs 5 s of dead capacity.

**Experiment.** MaxPressureController period ∈ {5, 10, 15} s × seeds {0,1,2} on
grid2x2/rush, 1800 s episodes, vs fixed-time.

| controller | delay/veh (s), seeds 0-2 |
|---|---|
| max-pressure, period 5 | 205.4, 211.1, 213.8 |
| max-pressure, period 10 | 205.9, 197.3, 191.0 |
| max-pressure, period 15 | 190.7, 195.7, 191.6 |
| fixed (20 s / 8 s greens) | 179.5, 194.3, 195.7 |

**Conclusion & adjustment.** Switching cost dominates at short periods; period 15 s
adopted as the default (`baselines.py`). Max-pressure now ties fixed on rush and wins
on light demand (27.3 vs 30.3 s/veh, single). Fixed-time's 20 s greens happen to be
near-Webster-optimal for the rush profile on a symmetric grid, so parity there is
expected; the RL agents' opportunity is the *asymmetric/time-varying* part of the
profile. This also sets the RL decision interval question: acting every 5 s is fine
(actions are phase *requests*; min-green shields capacity), but reward shaping must
not reward frantic switching.

## Iteration 1 — IPPO calibration on single/rush

**Question.** Does hand-rolled IPPO learn at all; which (lr, reward) region works?

**Setup.** `configs/sweeps/iter1_ippo_single.json`: lr {1e-4, 3e-4} × reward
{pressure, queue} × seeds {0, 1}, 20k decision steps (~83 episodes of 1200 s),
γ = 0.97, evals every 4k steps (greedy, 2 episodes, seeds 10000+).

**Results.** Uniform catastrophic collapse. Every config — both lrs, both rewards,
both seeds — converged to a *byte-identical* greedy policy (evals literally equal:
total_delay 116,916, throughput 304 on the shared eval seeds), i.e. "hold phase 0
forever". Baselines on the same eval episodes: fixed 70,574 / max-pressure 73,947 /
actuated 68,049 total delay with ~620–660 departed. The learned policy was ~65%
worse than never thinking at all.

**Analysis.** Training metrics told the story precisely:

| metric | value over updates 1→7 |
|---|---|
| value_loss | ~456,000 → ~425,000 (barely moving) |
| policy_loss | ≈ −0.001 (nothing) |
| clip_frac | 0–5% |
| entropy | 0.56 → 0.49 (already collapsed at first update; ln 4 ≈ 1.39 at init) |

Unscaled pressure rewards are O(−30..−80) per step; discounted returns are O(−10³).
Against a zero-initialized value head, value_loss ≈ 4.5·10⁵, and since ActorCritic
shares its [128,128] trunk, the value-loss gradients bulldoze the policy features
before the (tiny) policy gradient does anything. The policy collapses to a constant
within the first rollout and never recovers. A separate confound: this sweep
straddled the M2 engine-fix commits, so its absolute numbers are not comparable
with anything later — treated strictly as calibration.

**Adjustment.** Added `algo_kwargs.reward_scale` to ppo/gat/dqn (multiply rewards
at buffer insertion). Iteration 2 trains on the frozen engine with rewards scaled
to O(1) (scale 0.02 ≈ 1/50th) and probes entropy_coef {0.01, 0.03} as insurance
against renewed collapse.

## Iteration 2 — reward scaling on the frozen engine

**Setup.** `configs/sweeps/iter2_ippo_scaled.json`: IPPO single/rush,
reward_scale 0.02, entropy_coef {0.01, 0.03} × reward {pressure, queue} ×
seeds {0, 1}, lr 3e-4, 20k steps, evals every 4k.

**Results.** Reward scaling fixed the value pathology (value_loss 450,000 → 25–50)
— and evals were *still* frozen at the init policy (~107k delay / 352 throughput,
identical across steps and configs). Live probes then separated the remaining
hypotheses cleanly:

- Fresh nets with `explore=True` sample all four phases and the env responds
  (34–36 phase changes / 120 steps) → exploration and env wiring are fine.
- The trained checkpoint's greedy rollout is **bit-identical to the untrained
  net's** → the update never moved the argmax.
- Arithmetic: rollout 2048 with a single agent ⇒ 20k steps = **9 PPO updates
  total**. Nine small steps move nothing.
- Trainability probe (rollout 256, minibatch 128): after only 5 updates the
  greedy policy changed at 57/60 decision points → the gradient path works; the
  cadence was the bottleneck. (Note: entropy ≈ 0.55 is NOT evidence of collapse
  here — ~half of all decisions are min-green-masked to a single action, which
  drags the masked-entropy average down from ln 4 ≈ 1.39.)

**Adjustment.** Iteration 3 uses rollout 256 / minibatch 128 (≈117 updates over
30k steps) and probes decision_interval {5, 10} s — at 10 s the min-green mask
stops forcing every other action, which should clean up credit assignment.

## Iteration 3 — update cadence + decision interval

**Setup.** `configs/sweeps/iter3_ippo_cadence.json`: IPPO single/rush, rollout 256,
minibatch 128, reward_scale 0.02, entropy 0.01, lr 3e-4, 30k steps: reward
{pressure, queue} × decision_interval {5, 10} × seeds {0, 1}.

**Results.** _(pending — sweep running)_
