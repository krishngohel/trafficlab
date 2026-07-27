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

**Results.** _(pending — sweep running)_
