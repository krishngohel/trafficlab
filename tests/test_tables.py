"""Tests for scripts/tables.py: per-cell CI tables, best-delay bolding, mean
ranks, the summary.json mirror, plus a smoke run over the real baseline sweep.

The synthetic fixture uses seed values shaped (m-1, m-1, m+2): mean m, variance
exactly 3, so std(ddof=1) = sqrt(3) and the CI half-width is exactly
t95(df=2) = 4.303 for every policy in every cell.
"""
import csv
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import tables                                       # noqa: E402

FIELDS = ["network", "demand", "policy", "seed", "spawned", "throughput",
          "total_delay", "delay_per_vehicle", "mean_queue"]
OFFSETS = (-1, -1, 2)
CI = 4.303

# (network, demand) -> policy -> (mean delay/veh, mean throughput)
SYNTHETIC = {
    ("single", "light"): {"alpha": (20.0, 1000), "beta": (30.0, 900),
                          "gamma": (25.0, 1100)},
    ("grid2x2", "rush"): {"alpha": (50.0, 2000), "beta": (40.0, 2100),
                          "gamma": (60.0, 2200)},
}
REAL_CSV = ROOT / "results/eval_baselines.csv"


def write_synthetic(path: Path) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for (net, dem), policies in SYNTHETIC.items():
            for policy, (delay, thru) in policies.items():
                for seed, off in enumerate(OFFSETS):
                    w.writerow({
                        "network": net, "demand": dem, "policy": policy, "seed": seed,
                        "spawned": 1200, "throughput": thru + off,
                        "total_delay": round((delay + off) * 1200, 1),
                        "delay_per_vehicle": delay + off, "mean_queue": 5.0,
                    })


def run_cli(csv_path: Path, out_dir: Path) -> tuple[str, dict]:
    md = out_dir / "TABLES.md"
    argv = sys.argv
    sys.argv = ["tables.py", "--csv", str(csv_path), "--out", str(md)]
    try:
        tables.main()
    finally:
        sys.argv = argv
    return (md.read_text(encoding="utf-8"),
            json.loads((out_dir / "summary.json").read_text(encoding="utf-8")))


def section(md: str, heading: str) -> str:
    body = md.split(f"\n## {heading}\n", 1)[1]
    return body.split("\n## ", 1)[0]


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory):
    d = tmp_path_factory.mktemp("tables_synth")
    csv_path = d / "eval.csv"
    write_synthetic(csv_path)
    return run_cli(csv_path, d)


# ---------------------------------------------------------------- cell tables
@pytest.mark.parametrize("heading,rows", [
    # Sections are sorted by (network, demand); rows by mean delay, best first.
    ("grid2x2 / rush", [
        "| **beta** | **40.0 ± 4.3** | **2100 ± 4** | 3 |",
        "| alpha | 50.0 ± 4.3 | 2000 ± 4 | 3 |",
        "| gamma | 60.0 ± 4.3 | 2200 ± 4 | 3 |",
    ]),
    ("single / light", [
        "| **alpha** | **20.0 ± 4.3** | **1000 ± 4** | 3 |",
        "| gamma | 25.0 ± 4.3 | 1100 ± 4 | 3 |",
        "| beta | 30.0 ± 4.3 | 900 ± 4 | 3 |",
    ]),
])
def test_cell_table_rows(synthetic, heading, rows):
    md, _ = synthetic
    body = section(md, heading)
    assert [ln for ln in body.splitlines() if ln.startswith("| ") and "---" not in ln
            and not ln.startswith("| policy")] == rows


def test_exactly_one_bold_row_per_cell(synthetic):
    md, js = synthetic
    for cell in js["cells"]:
        body = section(md, f"{cell['network']} / {cell['demand']}")
        bolded = [ln.split("**")[1] for ln in body.splitlines() if ln.startswith("| **")]
        assert len(bolded) == 1
        assert bolded[0] == cell["best_delay_policy"]
    assert [c["best_delay_policy"] for c in js["cells"]] == ["beta", "alpha"]


def test_all_cells_and_policies_present(synthetic):
    md, js = synthetic
    assert len(js["cells"]) == 2
    assert js["episodes"] == 18
    for (net, dem), policies in SYNTHETIC.items():
        assert f"## {net} / {dem}" in md
        cell = next(c for c in js["cells"] if (c["network"], c["demand"]) == (net, dem))
        assert sorted(cell["policies"]) == sorted(policies)


# ---------------------------------------------------------------- summary.json
def test_summary_json_matches_markdown_numbers(synthetic):
    _md, js = synthetic
    for (net, dem), policies in SYNTHETIC.items():
        cell = next(c for c in js["cells"] if (c["network"], c["demand"]) == (net, dem))
        for policy, (delay, thru) in policies.items():
            s = cell["policies"][policy]
            assert s["seeds"] == 3
            assert s["delay_per_vehicle"]["mean"] == pytest.approx(delay)
            assert s["throughput"]["mean"] == pytest.approx(thru)
            assert s["delay_per_vehicle"]["ci95"] == pytest.approx(CI, abs=1e-3)
            assert s["throughput"]["ci95"] == pytest.approx(CI, abs=1e-3)


# ---------------------------------------------------------------- ranks
def test_overall_mean_ranks(synthetic):
    md, js = synthetic
    # delay ranks: alpha (1, 2), beta (3, 1), gamma (2, 3)
    # throughput:  alpha (2, 3), beta (3, 2), gamma (1, 1)
    expected = {"alpha": (1.5, 2.5), "beta": (2.0, 2.5), "gamma": (2.5, 1.0)}
    got = {o["policy"]: (o["mean_rank_delay"], o["mean_rank_throughput"])
           for o in js["overall"]}
    assert got == expected
    assert [o["policy"] for o in js["overall"]] == ["alpha", "beta", "gamma"]
    assert all(o["cells"] == 2 for o in js["overall"])
    overall = md.split("\n## Overall\n", 1)[1]
    assert "| alpha | 1.50 | 2.50 | 2 |" in overall
    assert "| gamma | 2.50 | 1.00 | 2 |" in overall


def test_ranks_tie_shares_average_position():
    assert tables.ranks({"a": 1.0, "b": 2.0, "c": 3.0}, False) == {"a": 1, "b": 2, "c": 3}
    assert tables.ranks({"a": 1.0, "b": 2.0, "c": 3.0}, True) == {"a": 3, "b": 2, "c": 1}
    assert tables.ranks({"a": 5.0, "b": 5.0, "c": 9.0}, False) == {"a": 1.5, "b": 1.5, "c": 3}


def test_mean_ci_single_seed_has_no_interval():
    assert tables.mean_ci([7.0]) == (7.0, 0.0)


# ---------------------------------------------------------------- smoke
@pytest.mark.skipif(not REAL_CSV.exists(), reason="results/eval_baselines.csv absent")
def test_smoke_real_eval_csv(tmp_path):
    md, js = run_cli(REAL_CSV, tmp_path)
    assert js["episodes"] == sum(1 for _ in open(REAL_CSV, encoding="utf-8")) - 1
    assert js["source"] == "results/eval_baselines.csv"
    assert len(js["cells"]) == 12                   # 4 networks x 3 demands
    for cell in js["cells"]:
        assert len(cell["policies"]) == 4
        body = section(md, f"{cell['network']} / {cell['demand']}")
        assert sum(ln.startswith("| **") for ln in body.splitlines()) == 1
        for s in cell["policies"].values():
            assert s["seeds"] == 10
            assert s["delay_per_vehicle"]["ci95"] >= 0.0
            assert s["throughput"]["mean"] > 0.0
    assert len(js["overall"]) == 4
    assert all(1.0 <= o["mean_rank_delay"] <= 4.0 for o in js["overall"])
