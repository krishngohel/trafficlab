"""Regenerate the visualizer's demo fixtures.

`viz/public/fixtures/*.traj` are gitignored — they are tens of MB of binary and
the simulator is byte-deterministic, so a seed plus this script reproduces them
exactly rather than storing them. Run once after cloning:

  python scripts/make_fixtures.py

Each fixture is validated, and every signalised network is checked to confirm
all of its intersections are actively controlled before it ships as a demo.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "viz" / "public" / "fixtures"

# (fixture name, network, demand, controller, seconds, seed, warmup)
FIXTURES = [
    # The headline demo: 25 intersections, mixed 1/2/3-lane streets, and
    # off-street trip ends — cars pull out of garages and park in them rather
    # than appearing and vanishing at the map edge. `city` demand carries the
    # parking block; `light` on the same network is the opt-in control.
    ("city.traj", "city", "city", "actuated", 900.0, 3, 0.0),
    # The simulator at scale: 100 signalised intersections, all actively
    # controlled, recorded after a warm-up so it opens already busy.
    ("metro.traj", "metro", "metro", "actuated", 600.0, 3, 300.0),
    # The public demo's second half: the same city under both lights, same
    # seed, same warm-up, so the split-screen comparison at one junction can be
    # repeated at a hundred. Five minutes rather than ten keeps the pair to the
    # same download as the solo recording above.
    ("metro_fixed.traj", "metro", "metro", "fixed", 300.0, 3, 300.0),
    ("metro_actuated.traj", "metro", "metro", "actuated", 300.0, 3, 300.0),
    # One intersection, close enough to watch individual car behaviour, and the
    # same seed under two policies so split-screen comparison has something to
    # compare.
    ("single_actuated.traj", "single", "rush", "actuated", 900.0, 0, 0.0),
    ("single_fixed.traj", "single", "rush", "fixed", 900.0, 0, 0.0),
]


def run(args: list[str]) -> None:
    result = subprocess.run([sys.executable, *args], cwd=ROOT, text=True,
                            capture_output=True)
    if result.returncode != 0:
        print(result.stdout, result.stderr, sep="\n")
        raise SystemExit(f"failed: {' '.join(args)}")
    print("  " + result.stdout.strip().splitlines()[-1])


def main() -> None:
    from trafficlab.trajectory import validate_file

    OUT.mkdir(parents=True, exist_ok=True)
    if not (ROOT / "configs/networks/city.json").exists():
        run(["scripts/make_city.py"])

    for name, network, demand, controller, seconds, seed, warmup in FIXTURES:
        target = OUT / name
        print(f"{name}: {network}/{demand}/{controller} seed={seed}")
        run([
            "scripts/simulate.py", "--network", network, "--demand", demand,
            "--controller", controller, "--duration", str(seconds),
            "--seed", str(seed), "--warmup", str(warmup), "--out", str(target),
        ])
        errors = validate_file(target)
        if errors:
            raise SystemExit(f"{name} failed validation: {errors[:3]}")
        # Synthetic single-intersection files aside, a demo should never ship
        # with an intersection nothing is controlling.
        check = subprocess.run(
            [sys.executable, "scripts/check_signals.py", str(target)],
            cwd=ROOT, text=True, capture_output=True,
        )
        if check.returncode != 0:
            print(check.stdout)
            raise SystemExit(f"{name}: not every intersection is actively controlled")
        print("  " + check.stdout.strip().splitlines()[-1])

    # NOT a demo: a hand-built, format-valid file with no simulator behind it
    # (24 recycled vehicles, through-movements only, zero acceleration). It
    # exists so the TypeScript parser/scan tests have a fixture to run against,
    # and it is deliberately absent from the viewer's demo buttons.
    for kind in ("fixed", "actuated"):
        target = OUT / f"demo_{kind}.traj"
        print(f"demo_{kind}.traj: single/heavy/{kind} warmup=300 seed=0")
        run(["scripts/simulate.py", "--network", "single", "--demand", "heavy",
             "--controller", kind, "--warmup", "300", "--duration", "600",
             "--seed", "0", "--out", str(target)])

    from trafficlab.synthetic import write_synthetic
    write_synthetic(OUT / "synthetic.traj", num_frames=480, seed=42)
    print("synthetic.traj: written (parser test fixture, not a demo)")

    total = sum(p.stat().st_size for p in OUT.glob("*.traj"))
    print(f"\n{len(list(OUT.glob('*.traj')))} fixtures, {total / 1e6:.0f} MB in {OUT}")


if __name__ == "__main__":
    main()
