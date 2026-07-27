"""IDM car-following and MOBIL lane-change criteria (pure, vectorizable).

See docs/SIM_DESIGN.md section idm.py. `idm_accel` accepts scalars or
broadcastable numpy arrays for the kinematic inputs, and `p` may be a
DriverParams whose fields are themselves arrays (one entry per vehicle).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

ACC_MIN = -8.0    # hard physical deceleration floor, m/s^2
GAP_CRASH = 0.5   # gaps at or below this force ACC_MIN, m
GAP_FREE = 1e9    # sentinel gap for a free road


@dataclass
class DriverParams:
    """Per-driver IDM/MOBIL parameters. Fields may be numpy arrays."""
    v0: float = 13.9           # desired speed, m/s
    T: float = 1.5             # desired time headway, s
    a: float = 1.5             # max acceleration, m/s^2
    b: float = 2.0             # comfortable deceleration, m/s^2
    s0: float = 2.0            # jam (standstill) gap, m
    delta: float = 4.0         # velocity exponent
    length: float = 4.5        # vehicle length, m
    politeness: float = 0.3    # MOBIL politeness factor
    lc_threshold: float = 0.2  # MOBIL incentive threshold, m/s^2
    lc_cooldown: float = 4.0   # s between lane changes

    @staticmethod
    def sample(rng: np.random.Generator) -> "DriverParams":
        """Heterogeneous driver; deterministic given the generator's state.

        Bounds: v0 = 13.9 * U(0.9, 1.15), T ~ U(1.2, 1.8), a ~ U(1.2, 1.8),
        b ~ U(1.5, 2.5), s0 ~ U(1.5, 2.5), length ~ U(4.0, 5.0),
        politeness ~ U(0.1, 0.5); delta, lc_threshold, lc_cooldown fixed.
        Draw order is exactly the field order above.
        """
        return DriverParams(
            v0=float(13.9 * rng.uniform(0.9, 1.15)),
            T=float(rng.uniform(1.2, 1.8)),
            a=float(rng.uniform(1.2, 1.8)),
            b=float(rng.uniform(1.5, 2.5)),
            s0=float(rng.uniform(1.5, 2.5)),
            length=float(rng.uniform(4.0, 5.0)),
            politeness=float(rng.uniform(0.1, 0.5)),
        )


def idm_accel(
    v: float | np.ndarray,
    v_lead: float | np.ndarray,
    gap: float | np.ndarray,
    p: DriverParams,
    v0: float | np.ndarray | None = None,
) -> float | np.ndarray:
    """IDM acceleration for follower(s) at speed v behind leader(s) at v_lead.

    s* = s0 + max(0, v*T + v*(v - v_lead) / (2*sqrt(a*b)))
    acc = a * (1 - (v/v0)**delta - (s*/gap)**2), clamped to [-8.0, p.a].
    Free road: pass gap = 1e9. gap <= 0.5 returns -8.0.
    Scalar inputs give a float; any array input broadcasts to an ndarray.
    `v0` overrides p.v0 (used for element speed limits: effective desired
    speed = min(driver v0, limit) computed by the caller).
    """
    if not (isinstance(v, np.ndarray) or isinstance(v_lead, np.ndarray)
            or isinstance(gap, np.ndarray) or isinstance(p.a, np.ndarray)
            or isinstance(v0, np.ndarray)):
        # Scalar fast path (pure math): ~10x faster than numpy on scalars,
        # and this is the simulation's hottest function.
        if gap <= GAP_CRASH:
            return ACC_MIN
        desired = p.v0 if v0 is None else v0
        s_star = p.s0 + max(0.0, v * p.T + v * (v - v_lead) / (2.0 * math.sqrt(p.a * p.b)))
        acc = p.a * (1.0 - (v / desired) ** p.delta - (s_star / gap) ** 2)
        return ACC_MIN if acc < ACC_MIN else (p.a if acc > p.a else acc)
    v = np.asarray(v, dtype=np.float64)
    v_lead = np.asarray(v_lead, dtype=np.float64)
    gap = np.asarray(gap, dtype=np.float64)
    a = np.asarray(p.a, dtype=np.float64)
    desired = p.v0 if v0 is None else v0
    crash = gap <= GAP_CRASH
    safe_gap = np.where(crash, 1.0, gap)  # dummy divisor where overridden
    s_star = p.s0 + np.maximum(0.0, v * p.T + v * (v - v_lead) / (2.0 * np.sqrt(a * p.b)))
    acc = a * (1.0 - (v / desired) ** p.delta - (s_star / safe_gap) ** 2)
    acc = np.where(crash, ACC_MIN, np.clip(acc, ACC_MIN, a))
    return float(acc) if acc.ndim == 0 else acc


def mobil_ok(
    a_self_new: float, a_self_old: float,
    a_newfollower_new: float, a_newfollower_old: float,
    a_oldfollower_new: float, a_oldfollower_old: float,
    politeness: float, threshold: float,
    bias: float = 0.0, b_safe: float = 4.0,
) -> bool:
    """MOBIL lane-change decision.

    Safety: the would-be new follower must not need accel < -b_safe.
    Incentive: (own gain) + politeness*(new-follower gain + old-follower gain)
    > threshold - bias.
    """
    if a_newfollower_new < -b_safe:
        return False
    gain = (a_self_new - a_self_old) + politeness * (
        (a_newfollower_new - a_newfollower_old)
        + (a_oldfollower_new - a_oldfollower_old)
    )
    return bool(gain > threshold - bias)
