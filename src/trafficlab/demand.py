"""Poisson vehicle demand: per-tick arrivals and turning-movement sampling.

See docs/SIM_DESIGN.md (demand.py). Rates are veh/h per entry LINK, split
evenly across its lanes; a piecewise-linear profile multiplies the base rate
over sim time (clamped at both ends). All randomness comes from the single
Generator passed in; entry links are always visited sorted by id.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .network import Network

MOVEMENTS = ("left", "through", "right")


class Demand:
    """Samples entry-lane arrivals and turning movements for one simulation."""

    def __init__(self, cfg: dict, network: Network, rng: np.random.Generator):
        self.cfg = cfg
        self.network = network
        self.rng = rng
        self.base_rate = float(cfg.get("base_rate", 0.0))
        self.turning: dict[str, float] = dict(cfg.get("turning") or {})
        per_entry = cfg.get("per_entry") or {}

        groups: dict[int, list[int]] = {}
        for lane_id in network.entry_lanes:
            groups.setdefault(network.lanes[lane_id].link, []).append(lane_id)
        self._entry_links: list[tuple[int, list[int]]] = [
            (link_id, sorted(lane_ids)) for link_id, lane_ids in sorted(groups.items())
        ]
        self._rates: dict[int, float] = {}
        for link_id, _ in self._entry_links:
            override = per_entry.get(str(link_id), per_entry.get(link_id))
            self._rates[link_id] = self.base_rate if override is None else float(override)

        profile = cfg.get("profile")
        if profile:
            pts = sorted((float(t), float(m)) for t, m in profile)
            self._prof_t: np.ndarray | None = np.asarray([p[0] for p in pts])
            self._prof_m: np.ndarray | None = np.asarray([p[1] for p in pts])
        else:
            self._prof_t = self._prof_m = None
        self._avail_cache: dict[tuple[int, int], tuple[str, ...]] = {}

    def _multiplier(self, t: float) -> float:
        """Piecewise-linear profile multiplier at sim time t, clamped at the ends."""
        if self._prof_t is None:
            return 1.0
        return float(np.interp(t, self._prof_t, self._prof_m))

    def arrivals(self, t: float, dt: float) -> list[int]:
        """Entry lane ids to spawn this tick. Poisson(rate*mult*dt/3600) per entry
        link, links visited sorted by id; spawn lane drawn uniformly via rng."""
        mult = self._multiplier(t)
        out: list[int] = []
        for link_id, lane_ids in self._entry_links:
            lam = self._rates[link_id] * mult * dt / 3600.0
            for _ in range(int(self.rng.poisson(lam))):
                out.append(lane_ids[int(self.rng.integers(len(lane_ids)))])
        return out

    def _available(self, ix: int, from_link: int) -> tuple[str, ...]:
        """Movements with at least one connection at (ix, from_link), in MOVEMENTS order."""
        key = (ix, from_link)
        cached = self._avail_cache.get(key)
        if cached is None:
            found: set[str] = set()
            for lane_id in self.network.links[from_link].lanes:
                for conn_id in self.network.lane_connections.get(lane_id, []):
                    conn = self.network.connections[conn_id]
                    if conn.intersection == ix:
                        found.add(conn.movement)
            cached = tuple(m for m in MOVEMENTS if m in found)
            self._avail_cache[key] = cached
        return cached

    def turn_for(self, ix: int, from_link: int) -> str:
        """Sample a movement, renormalized over those actually available at
        (ix, from_link). Missing/zero-mass turning config falls back to uniform."""
        avail = self._available(ix, from_link)
        if not avail:
            raise ValueError(f"no movements from link {from_link} at intersection {ix}")
        if self.turning:
            weights = [max(0.0, float(self.turning.get(m, 0.0))) for m in avail]
        else:
            weights = [1.0] * len(avail)
        total = sum(weights)
        if total <= 0.0:
            weights = [1.0] * len(avail)
            total = float(len(avail))
        r = float(self.rng.random()) * total
        acc = 0.0
        for movement, w in zip(avail, weights):
            acc += w
            if r < acc:
                return movement
        return avail[-1]
