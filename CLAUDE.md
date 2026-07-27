# trafficlab

Multi-agent traffic signal control RL research platform with a high-fidelity WebGL visualizer.

## Architecture

Three subsystems, decoupled by a binary trajectory file contract:

```
 src/trafficlab/          Python: simulator, env, baselines, RL
 ├── trajectory.py        .traj binary format writer/reader/validator (THE CONTRACT)
 ├── network.py           road network model built from declarative JSON configs
 ├── vehicle.py           IDM car-following + MOBIL lane changing
 ├── signals.py           signal controllers: phases, yellow/all-red, min-green
 ├── demand.py            Poisson arrivals, rush profiles, turning-movement matrices
 ├── simulator.py         fixed-timestep deterministic engine, emits .traj
 ├── env.py               PettingZoo-style parallel multi-agent env (1 agent/intersection)
 ├── baselines.py         fixed-time (Webster), actuated, max-pressure
 └── rl/                  IDQN, IPPO (param sharing), GAT-PPO; harness, sweeps, SQLite metrics
 configs/networks/        single.json, grid2x2.json, grid4x4.json, arterial6.json
 configs/demand/          light.json, rush.json, heavy.json
 viz/                     Next.js + TypeScript + three.js visualizer (reads .traj)
 docs/                    TRAJECTORY_FORMAT.md, EXPERIMENT_LOG.md
 results/                 eval tables, plots, trajectories
 scripts/                 CLI entry points (simulate, train, sweep, evaluate, benchmark)
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
- **Timestep**: sim dt = 0.5 s. RL decision interval = 10 ticks (5 s). Trajectory files
  record every tick.
- **IDs**: lanes, links, nodes, intersections all get stable integer ids assigned in
  config order. Array orderings in the .traj file are defined by the meta JSON.
- Python 3.14, numpy-vectorized hot paths, torch CPU. No SUMO, no RL frameworks,
  no pettingzoo/gymnasium dependency — the parallel-env API is implemented locally.

## Commands

- Tests: `python -m pytest tests/ -x -q` (from repo root)
- Benchmark: `python scripts/benchmark.py`
- Simulate a baseline: `python scripts/simulate.py --network grid2x2 --controller max_pressure --out results/demo.traj`
- Visualizer dev: `cd viz && npm run dev`

## Milestone status

- [x] M1 contract: .traj format spec + writer/reader/validator + tests
- [x] M2 simulator (built + property tests green + 64k veh-steps/s; review findings being applied)
- [x] M3 env + baselines (110-test suite green; review pending)
- [~] M4 learning (stack built + tested; sweep iterations in progress, see docs/EXPERIMENT_LOG.md)
- [~] M5 visualizer (scaffold + parser + playback done; feature build in progress)
- [ ] M6 evaluation + writeup (scripts/evaluate.py + plots.py ready)
