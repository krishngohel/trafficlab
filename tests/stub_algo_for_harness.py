"""Tests-local stub algo for the harness tests.

Re-exports the subprocess-importable stub Trainer. Test modules register this
module as ``trafficlab.rl.stub`` in ``sys.modules`` so ``cfg.algo == "stub"``
resolves through the harness's importlib dispatch.
"""
from trafficlab.rl._stub_test_algo import LOSS_EVERY, Trainer  # noqa: F401
