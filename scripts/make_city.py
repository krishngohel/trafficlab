"""Generate a mixed-lane city network config (explicit type).

The shipped grid/arterial generators lay uniform roads: every link gets the same
lane count, so they never exercise the per-link geometry the format actually
carries. A real city is a hierarchy — multi-lane avenues, ordinary two-lane
streets, single-lane locals — and each of those produces different lane
geometry, different movement-to-lane assignment, and (for single-lane
approaches with left turns) different signal phasing.

  python scripts/make_city.py --rows 5 --cols 5 --out configs/networks/city.json

Every interior node is a signalised intersection; the perimeter gets boundary
stubs so traffic has somewhere to enter and leave.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Street hierarchy: (lanes, speed limit m/s). Index into this by class name.
CLASSES = {
    "avenue": (3, 16.7),
    "street": (2, 13.9),
    "local": (1, 11.1),
}


def classify(index: int, count: int, avenues: set[int], locals_: set[int]) -> str:
    if index in avenues:
        return "avenue"
    if index in locals_:
        return "local"
    return "street"


PARKING = {
    "spacing": 110.0,
    "driveway_length": 14.0,
    "speed_limit": 5.6,
    "min_segment": 45.0,
    "streets_only": True,
}


def build(rows: int, cols: int, block: float, arm: float, parking: bool = True) -> dict:
    # Avenues run through the middle of the grid; one local street per axis on
    # the far edge, which is what puts a single-lane approach (and therefore
    # split phasing) into the sample.
    avenue_cols = {c for c in range(cols) if cols >= 3 and c % 2 == 1}
    avenue_rows = {r for r in range(rows) if rows >= 3 and r % 2 == 1}
    local_cols = {0} if cols >= 4 else set()
    local_rows = {0} if rows >= 4 else set()

    nodes: list[dict] = []
    edges: list[dict] = []
    node_id = 0
    grid: dict[tuple[int, int], int] = {}

    for j in range(rows):
        for i in range(cols):
            grid[(i, j)] = node_id
            nodes.append({"id": node_id, "x": i * block, "y": j * block,
                          "type": "intersection"})
            node_id += 1

    def edge(a: int, b: int, cls: str) -> None:
        lanes, limit = CLASSES[cls]
        edges.append({"from": a, "to": b, "lanes": lanes, "two_way": True,
                      "speed_limit": limit})

    # Interior links: a horizontal link belongs to its row's class, a vertical
    # link to its column's class.
    for j in range(rows):
        cls = classify(j, rows, avenue_rows, local_rows)
        for i in range(cols - 1):
            edge(grid[(i, j)], grid[(i + 1, j)], cls)
    for i in range(cols):
        cls = classify(i, cols, avenue_cols, local_cols)
        for j in range(rows - 1):
            edge(grid[(i, j)], grid[(i, j + 1)], cls)

    # Perimeter stubs, carrying the class of the street they continue.
    def stub(i: int, j: int, dx: float, dy: float, cls: str) -> None:
        nonlocal node_id
        nodes.append({
            "id": node_id,
            "x": i * block + dx * arm,
            "y": j * block + dy * arm,
            "type": "boundary",
        })
        edge(node_id, grid[(i, j)], cls)
        node_id += 1

    for j in range(rows):
        cls = classify(j, rows, avenue_rows, local_rows)
        stub(0, j, -1.0, 0.0, cls)
        stub(cols - 1, j, 1.0, 0.0, cls)
    for i in range(cols):
        cls = classify(i, cols, avenue_cols, local_cols)
        stub(i, 0, 0.0, -1.0, cls)
        stub(i, rows - 1, 0.0, 1.0, cls)

    cfg = {"type": "explicit", "nodes": nodes, "edges": edges}
    if parking:
        # Off-street trip ends: garages/lots hang off every street and local
        # (avenues stay clear, see docs/PARKING_DESIGN.md).
        cfg["parking"] = dict(PARKING)
    return cfg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=5)
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--block", type=float, default=220.0)
    ap.add_argument("--arm", type=float, default=170.0)
    ap.add_argument("--out", default="configs/networks/city.json")
    ap.add_argument("--parking", dest="parking", action="store_true", default=True,
                    help="emit the off-street parking block (default)")
    ap.add_argument("--no-parking", dest="parking", action="store_false",
                    help="plain network, no driveways or garages")
    args = ap.parse_args()

    cfg = build(args.rows, args.cols, args.block, args.arm, parking=args.parking)
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cfg, indent=2) + "\n")

    lanes = {}
    for e in cfg["edges"]:
        lanes[e["lanes"]] = lanes.get(e["lanes"], 0) + 1
    signalised = sum(1 for n in cfg["nodes"] if n["type"] == "intersection")
    print(f"wrote {out}")
    print(f"  {signalised} signalised intersections, {len(cfg['edges'])} edges")
    print(f"  edges by lane count: {dict(sorted(lanes.items()))}")
    if cfg.get("parking"):
        sys.path.insert(0, str(ROOT / "src"))
        from trafficlab.network import Network
        net = Network.from_config(cfg)
        print(f"  parking: {len(net.parking_nodes)} garages, "
              f"{len(net.driveways)} driveways, {len(net.entry_lanes)} entry lanes")


if __name__ == "__main__":
    main()
