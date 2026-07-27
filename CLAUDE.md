# trafficlab

Multi-agent traffic signal control RL research platform with a high-fidelity WebGL visualizer.

## Architecture

Three subsystems, decoupled by a binary trajectory file contract:

```
 src/trafficlab/          Python: simulator, env, baselines, RL
 ├── trajectory.py        .traj binary format writer/reader/validator (THE CONTRACT)
 ├── network.py           road network model built from declarative JSON configs
 ├── idm.py               IDM car-following + MOBIL lane changing (pure, vectorizable)
 ├── signals.py           SignalUnit phase state machine + FixedCycleController
 ├── demand.py            Poisson arrivals, rush profiles, turning-movement matrices
 ├── simulator.py         fixed-timestep deterministic engine (Vehicle lives here), emits .traj
 ├── env.py               PettingZoo-style parallel multi-agent env (1 agent/intersection)
 ├── baselines.py         fixed-time (Webster), actuated, max-pressure
 ├── synthetic.py         hand-built .traj fixture generator (no simulator involved)
 └── rl/                  nets.py, buffers.py, dqn.py (IDQN), ppo.py (IPPO),
                          ippo.py (alias -> ppo), gat.py (GAT-PPO), harness.py
                          (RunConfig/train/SQLite/checkpoints), sweep.py
 configs/networks/        single.json, grid2x2.json, grid4x4.json, arterial6.json
 configs/demand/          light.json, rush.json, heavy.json
 configs/sweeps/          iterN_*.json sweep specs consumed by scripts/sweep.py
 scripts/                 simulate.py, benchmark.py, train.py, sweep.py,
                          evaluate.py, tables.py, plots.py
 tests/                   pytest suite + tests/fixtures/
 viz/                     Next.js + TypeScript + three.js visualizer (reads .traj)
 viz/scripts/             headless playwright drivers: visual_check.mjs (screenshots +
                          FPS), export_gif.mjs (drives in-app export, ffmpeg -> GIF)
 docs/                    TRAJECTORY_FORMAT.md, SIM_DESIGN.md, RL_DESIGN.md, EXPERIMENT_LOG.md
 runs/                    live training output (one dir/run: config.json, metrics.sqlite,
                          ckpt_*.pt, trajs/); runs_iter5/ holds the iteration-5 factorial
 results/                 eval CSVs, TABLES.md + summary.json, plots, trajectories, gifs
```

The simulator writes `.traj` files; the visualizer consumes them. Neither imports the other.
`docs/TRAJECTORY_FORMAT.md` is the source of truth for the format. Change it only with a
version bump and matching updates to `trajectory.py` AND `viz/src/lib/traj.ts`.

## Conventions

- **Units**: meters, seconds, radians. m/s for speed, m/s² for accel.
- **Coordinates**: X east, Y north, heading CCW from +X. The visualizer maps (x, y) → (x, -z)
  on the three.js ground plane.
- **Determinism**: one `numpy.random.Generator` per simulation, seeded at construction.
  No `random`, no `time`-dependent logic, no dict-iteration-order dependence anywhere
  in the sim path. Same seed + same config ⇒ byte-identical .traj output.
- **Timestep**: sim dt = 0.5 s. Trajectory files record every tick. The RL decision
  interval defaults to 5 s (10 ticks); the tuned recipe uses 10 s (20 ticks) — see
  `docs/RL_DESIGN.md` and `docs/EXPERIMENT_LOG.md`.
- **IDs**: lanes, links, nodes, intersections all get stable integer ids assigned in
  config order. Array orderings in the .traj file are defined by the meta JSON.
- Python 3.14 (pyproject floor is 3.12), numpy-vectorized hot paths, torch CPU. No SUMO,
  no RL frameworks, no pettingzoo/gymnasium dependency — the parallel-env API is
  implemented locally. Runtime deps are numpy + torch; the analysis scripts
  (`sweep.py`, `tables.py`, `plots.py`) additionally need pandas / matplotlib.

## Commands

Run everything from the repo root unless stated otherwise.

- Tests: `python -m pytest tests/ -q` (171 tests, ~35 s; `-x` to stop on first failure)
- Benchmark: `python scripts/benchmark.py` — 4 cells, PASS at ≥ 10k veh-steps/s. Latest
  measured run: single/heavy 73.8k, grid2x2/rush 74.4k, grid4x4/heavy 77.3k,
  arterial6/rush 81.5k → **mean 76.8k veh-steps/s** (single core, machine simultaneously
  running training; expect higher on an idle box).
- Simulate a baseline: `python scripts/simulate.py --network grid2x2 --controller max_pressure --out results/trajectories/demo.traj`
  (`--controller` ∈ fixed | webster | actuated | max_pressure)
- Train one run (the tuned recipe — see `docs/RL_DESIGN.md`, the module defaults do NOT learn):
  `python scripts/train.py --algo dqn --network single --demand rush --reward queue --decision-interval 10 --gamma 0.9 --total-steps 150000 --eval-every 25000 --algo-kwargs '{"reward_scale":0.02,"warmup":2000}'`
- Sweep: `python scripts/sweep.py --spec configs/sweeps/iter6_grid.json --processes 6`
  (both train.py and sweep.py accept `--resume`)
- Evaluate: `python scripts/evaluate.py --networks single grid2x2 --policies fixed webster actuated max_pressure --seeds 10 --out results/eval.csv`
- Tables / plots: `python scripts/tables.py --csv results/eval_baselines.csv --out results/TABLES.md`
  then `python scripts/plots.py --csv results/eval_baselines.csv --out results/plots`
- Visualizer dev: `cd viz && npm run dev -- -p 3199` (port 3199 is the project convention —
  `viz/scripts/*.mjs` default to `http://localhost:3199`). `npm test` runs the 48 vitest specs.

## Milestone status

- [x] M1 contract: .traj format spec + writer/reader/validator + tests
- [x] M2 simulator: engine + property tests green, review findings applied, 76.8k veh-steps/s
- [x] M3 env + baselines: parallel multi-agent env (4 reward variants) + Webster/actuated/
      max-pressure, review findings applied
- [~] M4 learning: stack built + tested; iteration 5 landed (DQN beats every classical
      baseline on single/rush). **Iteration-6 production training is running right now** —
      `runs/` is being written by live subprocesses; do not touch `runs/` or `runs_iter5/`
      and do not kill python processes. Analysis lives in `docs/EXPERIMENT_LOG.md`.
- [x] M5 visualizer: playback, cameras, overlays, charts, split-screen compare, video
      export, headless screenshot/GIF pipeline (48 vitest specs)
- [~] M6 evaluation + writeup: baselines evaluated (`results/eval_baselines.csv` →
      `results/TABLES.md` + `summary.json`); the RL rows land when M4 training finishes
