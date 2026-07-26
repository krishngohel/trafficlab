"""Tests for IDM acceleration, MOBIL criteria, and DriverParams sampling."""
import numpy as np
import pytest

from trafficlab.idm import ACC_MIN, DriverParams, GAP_FREE, idm_accel, mobil_ok

P = DriverParams()


class TestIdmAccel:
    def test_zero_accel_at_desired_speed_free_road(self):
        acc = idm_accel(P.v0, P.v0, GAP_FREE, P)
        assert isinstance(acc, float)
        assert acc == pytest.approx(0.0, abs=1e-9)

    def test_positive_accel_below_desired_speed_free_road(self):
        acc = idm_accel(5.0, 5.0, GAP_FREE, P)
        assert 0.0 < acc <= P.a
        # stronger push when further below v0
        assert idm_accel(1.0, 1.0, GAP_FREE, P) > acc

    def test_equilibrium_gap_approx_s0_plus_vT(self):
        # Follower behind a constant-speed leader converges to the IDM
        # equilibrium gap, which for v << v0 is approx s0 + v*T.
        v_lead, dt = 5.0, 0.1
        x_lead, x_f, v_f = 100.0, 0.0, v_lead
        for _ in range(20000):
            gap = x_lead - x_f - P.length
            acc = idm_accel(v_f, v_lead, gap, P)
            v_f = max(0.0, v_f + acc * dt)
            x_f += v_f * dt
            x_lead += v_lead * dt
        gap = x_lead - x_f - P.length
        exact = (P.s0 + v_lead * P.T) / np.sqrt(1.0 - (v_lead / P.v0) ** P.delta)
        assert v_f == pytest.approx(v_lead, abs=1e-3)
        assert gap == pytest.approx(exact, rel=1e-3)
        assert gap == pytest.approx(P.s0 + v_lead * P.T, rel=0.05)

    def test_hard_braking_for_tiny_gaps(self):
        assert idm_accel(10.0, 0.0, 1.0, P) == ACC_MIN     # clamped IDM term
        assert idm_accel(5.0, 5.0, 0.5, P) == ACC_MIN      # gap <= 0.5 boundary
        assert idm_accel(0.0, 0.0, 0.3, P) == ACC_MIN
        assert idm_accel(0.0, 0.0, -1.0, P) == ACC_MIN     # overlap
        # The gap <= 0.5 rule fires even where the formula would not brake:
        p2 = DriverParams(s0=0.5)
        assert idm_accel(0.0, 0.0, 0.6, p2) > 0.0          # just above the rule
        assert idm_accel(0.0, 0.0, 0.5, p2) == ACC_MIN     # forced at boundary

    def test_clamped_to_bounds(self):
        rng = np.random.default_rng(42)
        n = 500
        acc = idm_accel(
            rng.uniform(0, 20, n), rng.uniform(0, 20, n), rng.uniform(-1, 200, n), P
        )
        assert np.all(acc >= ACC_MIN)
        assert np.all(acc <= P.a)

    def test_array_matches_scalar(self):
        rng = np.random.default_rng(7)
        n = 64
        v = rng.uniform(0, 18, n)
        v_lead = rng.uniform(0, 18, n)
        gap = rng.uniform(0.1, 120, n)
        arr = idm_accel(v, v_lead, gap, P)
        assert isinstance(arr, np.ndarray) and arr.shape == (n,)
        for i in range(n):
            scalar = idm_accel(float(v[i]), float(v_lead[i]), float(gap[i]), P)
            assert arr[i] == pytest.approx(scalar, abs=1e-12)

    def test_array_param_fields_broadcast(self):
        rng = np.random.default_rng(3)
        n = 32
        ps = [DriverParams.sample(rng) for _ in range(n)]
        pa = DriverParams(
            v0=np.array([q.v0 for q in ps]),
            T=np.array([q.T for q in ps]),
            a=np.array([q.a for q in ps]),
            b=np.array([q.b for q in ps]),
            s0=np.array([q.s0 for q in ps]),
            delta=np.array([q.delta for q in ps]),
        )
        v = rng.uniform(0, 18, n)
        v_lead = rng.uniform(0, 18, n)
        gap = rng.uniform(0.1, 120, n)
        arr = idm_accel(v, v_lead, gap, pa)
        assert isinstance(arr, np.ndarray) and arr.shape == (n,)
        for i in range(n):
            scalar = idm_accel(float(v[i]), float(v_lead[i]), float(gap[i]), ps[i])
            assert arr[i] == pytest.approx(scalar, abs=1e-12)


class TestMobilOk:
    def test_safety_veto(self):
        # Huge own gain cannot override the new follower braking past b_safe.
        assert not mobil_ok(5.0, -5.0, -4.01, 0.0, 0.0, 0.0, 0.0, 0.2)
        # Exactly -b_safe is allowed (>=); incentive then decides.
        assert mobil_ok(1.0, 0.0, -4.0, 0.0, 0.0, 0.0, 0.0, 0.2)
        # Custom b_safe.
        assert not mobil_ok(5.0, 0.0, -3.0, 0.0, 0.0, 0.0, 0.0, 0.2, b_safe=2.0)
        assert mobil_ok(5.0, 0.0, -3.0, 0.0, 0.0, 0.0, 0.0, 0.2, b_safe=3.0)

    def test_incentive_own_gain(self):
        assert mobil_ok(0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2)
        assert not mobil_ok(0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2)
        # Strict inequality at the threshold.
        assert not mobil_ok(0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2)

    def test_incentive_politeness(self):
        # 0.5 + 0.5*(-1.0) = 0.0, not > 0.2.
        assert not mobil_ok(0.5, 0.0, -1.0, 0.0, 0.0, 0.0, 0.5, 0.2)
        # politeness 0 ignores the follower's loss.
        assert mobil_ok(0.5, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.2)
        # Old follower's gain counts too: 0.1 + 0.3*1.0 = 0.4 > 0.2.
        assert mobil_ok(0.1, 0.0, 0.0, 0.0, 1.0, 0.0, 0.3, 0.2)
        # Deltas use new - old for both followers.
        assert not mobil_ok(0.1, 0.0, 0.0, 0.0, 1.0, 1.0, 0.3, 0.2)

    def test_incentive_bias(self):
        assert not mobil_ok(0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2, bias=0.0)
        # bias lowers the bar: 0.1 > 0.2 - 0.15.
        assert mobil_ok(0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2, bias=0.15)


class TestDriverParamsSample:
    def test_within_documented_bounds(self):
        rng = np.random.default_rng(123)
        for _ in range(200):
            p = DriverParams.sample(rng)
            assert 13.9 * 0.9 <= p.v0 <= 13.9 * 1.15
            assert 1.2 <= p.T <= 1.8
            assert 1.2 <= p.a <= 1.8
            assert 1.5 <= p.b <= 2.5
            assert 1.5 <= p.s0 <= 2.5
            assert 4.0 <= p.length <= 5.0
            assert 0.1 <= p.politeness <= 0.5
            assert p.delta == 4.0
            assert p.lc_threshold == 0.2
            assert p.lc_cooldown == 4.0

    def test_deterministic_under_seeded_generator(self):
        p1 = DriverParams.sample(np.random.default_rng(9))
        p2 = DriverParams.sample(np.random.default_rng(9))
        assert p1 == p2
        assert p1 != DriverParams.sample(np.random.default_rng(10))
