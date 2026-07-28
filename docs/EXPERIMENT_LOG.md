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

**Results.** First real movement. Value losses healthy (7–32), entropies now spread
(0.38–0.71) instead of frozen. Six of eight runs still ended at the ~107k "hold"
attractor, but pressure reward with decision_interval=10 (seed 0) broke away at the
final eval: **delay 90,661 / throughput 374** (vs 107k/340 attractor; fixed-time
70,574/618 on this setting). pressure+di=5 (seed 0) also improved late (99,606).
The queue reward never moved — its per-step signal barely distinguishes actions when
every approach is saturated, while pressure at di=10 gets clean, unmasked decisions
(min-green never forces a stay) and each action's consequence is integrated over a
full 10 s window.

**Conclusions.** (1) Learning works but is sample-starved at 30k steps — the
breakaway happened at the last eval. (2) di=10 + pressure is the recipe.
(3) queue reward is a dead end at rush saturation.

**Adjustment.** Iteration 4 = scale-up: 100k steps IPPO (entropy 0.02 for stronger
early exploration) and 60k steps double-DQN (epsilon-greedy explores the switch
space much harder early on), both single/rush, di=10, pressure, seeds {0, 1}.

## Iteration 4 — long-horizon single/rush, IPPO vs DQN

**Setup.** `configs/sweeps/iter4_long_single.json` (IPPO 100k, entropy 0.02) +
`configs/sweeps/iter4_dqn_single.json` (DQN 60k, warmup 2000, target sync 500).

**Results.** IPPO flat at the hold-attractor through 60k of 100k steps at every
eval (both seeds); run stopped early, DQN pair superseded by iteration 5.
Iteration 3's single breakaway did not reproduce with entropy 0.02 — treated as
seed luck.

**Analysis.** A falsification probe killed the leading theory. Suspected: rewards
are blind past the 100 m queue window, so saturation flattens the objective.
Measured (scripted hold vs 20 s-cycle policies, single/rush, di=10):

| reward | hold | cycle | separation |
|---|---|---|---|
| pressure | −75.0/step | −61.0/step | 14.0 |
| queue | −73.9/step | −47.9/step | **25.9** |
| throughput | +2.85/step | +5.63/step | 2.0× |
| wait | −735/step | −479/step | 256 |

Every variant separates cleanly — the signal exists (cycle: 85,591 delay / 667
departed vs hold: 110,466 / 337). The failure is *credit assignment noise*:
per-decision advantages are tiny against strongly autocorrelated queue dynamics,
and γ=0.97 at 10 s steps smears credit over ~33 decisions. Also queue separates
2× better than pressure (its earlier "dead end" verdict was confounded by the
broken value scale of iterations 1–2).

**Adjustment.** Iteration 5, full factorial: γ **0.9** (sharpen credit to ~10
decisions), rollout 512 (halve advantage variance), entropy 0.02, reward
{pressure, queue} × algo {IPPO, double-DQN} × seeds {0, 1}, 60k steps. DQN enters
because off-policy TD with per-action Q-values plus epsilon exploration is
structurally better suited to sparse-ish switching decisions (and dominates the
traffic-signal literature).

## Iteration 5 — γ 0.9 factorial: algo × reward

**Setup.** `configs/sweeps/iter5_factorial.json` (8 runs).

**Results.** The credit-assignment fixes worked — and DQN wins decisively.
Final-eval total delay / throughput on the shared eval seeds (baselines on the
same setting: fixed 70,574/618, actuated 68,049/658, max-pressure 73,947/614):

| run | 10k | 30k | 60k |
|---|---|---|---|
| IPPO pressure s0/s1 | 107k | 99k/101k | 92,010/90,654 (t 444/434) |
| IPPO queue s0/s1 | 107k | 98k/94k | 88,254/**85,507** (t 496/**612**) |
| DQN pressure s0/s1 | 94k/89k | 74k/73k | **63,957/63,499** (t 636/602) |
| DQN queue s0/s1 | 90k/88k | 69k/70k | **63,102**/68,996 (t **646**/621) |

Every run learns monotonically now. **DQN beats all classical baselines by 60k
steps** (−10% delay vs fixed, −7% vs actuated, +4% throughput vs fixed) and was
already past fixed by ~20k. IPPO improves steadily but trails badly at equal
steps — off-policy replay + per-action Q-values + ε-exploration simply suit this
sparse switching structure better; on-policy PPO pays the advantage-noise tax on
every rollout. Both rewards work; queue edges pressure.

**Adjustment.** Production runs (iteration 6): DQN/queue on single (150k, 3
seeds); on grid2x2, all three algos (DQN, IPPO, GAT-PPO) at 100k × 2 seeds for
the multi-agent comparison M6 evaluates.

## Iteration 6 — production training

**Setup.** Scope decision: the 150k-step single runs were cut at 25k after their
first eval tracked iteration 5's curve exactly (78–84k at 25k) — iteration 5's
60k-step checkpoints are already at the convergence plateau (63–69k, flat-ish
after ~40k) and were trained on dynamics identical to the frozen engine (split
phasing does not alter 2-lane networks), so they are adopted as the production
single-intersection policies. All compute went to the multi-agent comparison:
`configs/sweeps/iter6_grid_fast.json` — grid2x2/rush, queue reward, γ 0.9,
di 10 s, 60k steps × {DQN, IPPO, GAT-PPO} × seeds {0, 1}. Mid-run, the final
audit found GAT interpreted rollout/minibatch in graph-steps (4× fewer updates
than IPPO from the same config) — fixed, and the GAT pair re-trained
(`iter6_gat_rerun.json`).

**Results.** Grid2x2/rush training-eval bests (best checkpoint per run, mean of
2 eval episodes; ~293k = hold-forever floor):

| algo | seed 0 | seed 1 | best step |
|---|---|---|---|
| DQN | **223,776** | **223,749** | 45k both |
| IPPO | 229,312 | 236,516 | 45k both |
| GAT-PPO (units fixed) | 255,872 | 261,345 | 60k, still falling |

Notes: (1) DQN and IPPO both peaked at 45k and regressed mildly by 60k —
best-checkpoint selection (`scripts/select_best_ckpt.py`) applied uniformly to
every run. (2) The GAT rerun validates the audit finding: at IPPO-equal update
cadence, GAT finally left its plateau, dropping 37k in the last 15k steps and
still improving at budget exhaustion — it lags IPPO at equal updates but looks
under-trained rather than broken; a 150k+ run is the obvious follow-up.
(3) IPPO is far more competitive with 4 agents than on the single intersection
(parameter sharing amortizes experience across agents), but plain independent
DQN still wins at this budget. Final cross-policy numbers with 10 eval seeds
and 95% CIs on the frozen engine: `results/TABLES.md`.

## Final evaluation — the horizon-mismatch reversal

The 1-hour, 10-seed final matrix (vs the 20-minute training evals) reordered
the grid bracket: DQN, best in training evals (223.7k), degraded to 266.6 ±
11.2 s/veh — behind fixed (247.4) — while IPPO held up (227.9 ± 9.7, −8% vs
fixed) and became the best learned grid policy. Training episodes were 1200 s;
evaluation runs 3600 s, whose tail sits in a demand regime the policies never
saw. The off-policy, per-agent Q-functions overfitted the trained horizon; the
shared stochastic IPPO policy generalized. On the single intersection the
picture was stable across horizons: dqn-pressure (s0) ties actuated (112.5 ±
7.2 vs 111.7 ± 6.8) and the queue-trained DQN transfers to light demand at
baseline level. Lessons recorded for any follow-up: (a) train at (or across)
the evaluation horizon; (b) evaluate on the full horizon from iteration 1 —
short-horizon validation curves actively misled checkpoint selection here;
(c) GAT deserves a 150k+ budget before a verdict.

## Iterations 7–8 — the actuated-parity ceiling (post-release campaign)

**Goal.** Beat fully-actuated control everywhere, not just fixed-schedule
control. Added observation v2 (signal-state one-hot, actuated-style presence
detectors, episode-progress, neighbor phase+queue summaries; 13 → 29 dims,
opt-in via `RunConfig.obs_version`) and trained at the full 3600 s evaluation
horizon.

**Iteration 7 (single/rush, DQN, 100k steps).** Best run 114.5 ± 6.5 s/veh —
a third consecutive statistical tie with actuated (111.7 ± 6.8) across two
observation designs and two horizons. Conclusion: gap-out actuation is
effectively at the ceiling for an isolated intersection; there is no
meaningful wait time left to reclaim there.

**Iteration 8 (grid2x2/rush; DQN-pressure ×2 100k, IPPO-queue ×2 100k,
GAT 150k — DQN and GAT stopped externally at 75k/120k).** Ten-seed evals of
every best checkpoint: 240.8–254.6 s/veh — indistinguishable from fixed
(247.4 ± 10.7), *worse* than iteration 6's v1 IPPO (227.9 ± 9.7), far from
actuated (189.3 ± 7.2). The obs-v2 + full-horizon recipe did not transfer its
single-intersection parity to the grid at these budgets, and two-episode
training evals over-promised yet again (893–922k total delay ≈ 220–230 s/veh
equivalents that evaporated under 10 seeds).

**Standing verdict.** Learned control: −20–35% vs fixed/Webster/max-pressure
everywhere; parity with actuated at isolated intersections; −20% behind
actuated on grids after six distinct recipes. Beating actuated on networks is
an open research problem here, not a tuning problem. Ranked next levers:
(1) action-space redesign — green-extension/gap-out actions so the policy
refines actuated behavior instead of re-deriving it from phase requests;
(2) reward directly on waiting time; (3) n-step returns + prioritized replay
for DQN's sparse credit; (4) 5–10× training budgets with ≥5-seed validation
evals (2-episode evals repeatedly misled); (5) curriculum from light to rush.
