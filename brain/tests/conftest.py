import json
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import chain  # noqa: E402
import hashes as H  # noqa: E402
import inputs as I  # noqa: E402

N = 60
BLOCK_MS0 = 1_700_000_000_000


def addr_topic(a):
    return "0x" + a[2:].lower().rjust(64, "0")


def word(v):
    return hex(v % (1 << 256))[2:].rjust(64, "0")


class FakeRpc:
    """Serves a synthetic chain: block n has timestamp BLOCK_MS0 + 450*n ms."""

    def __init__(self, head=1000, logs=None, receipts=None):
        self.head = head
        self.logs = logs or []
        self.receipts = receipts or []
        self.calls = []
        self.last_ok = 0

    def header(self, n):
        return {"number": hex(n), "timestamp": hex((BLOCK_MS0 + 450 * n) // 1000),
                "milliTimestamp": hex(BLOCK_MS0 + 450 * n), "transactions": ["0x"] * 10}

    def call(self, method, params):
        self.calls.append(method)
        if method == "eth_blockNumber":
            return hex(self.head)
        if method == "eth_getBlockByNumber":
            return self.header(int(params[0], 16))
        if method == "eth_getBlockReceipts":
            return self.receipts
        if method == "eth_getLogs":
            return self.logs
        raise AssertionError(f"unexpected rpc {method}")

    def batch(self, calls):
        return [self.call(m, p) for m, p in calls]

    def eth_call(self, to, data, block="latest"):
        raise AssertionError("no eth_call expected")


def write_fixture(root):
    rng = np.random.default_rng(3)
    dense = (rng.random((N, N)) < 0.15) * rng.uniform(-1, 3, (N, N))
    np.fill_diagonal(dense, 0)
    import scipy.sparse as sp
    W = sp.csr_matrix(dense.astype(np.float32))
    types = np.array([f"T{i % 7}" for i in range(N)])
    (root / "data").mkdir()
    np.savez(root / "data" / "graph.npz", data=W.data, indices=W.indices, indptr=W.indptr,
             shape=np.array(W.shape), bodies=np.arange(1000, 1000 + N, dtype=np.int64), types=types,
             superclass=np.array(["sensory" if i < 33 else "central" for i in range(N)]),
             subclass=types, receptor=types, fru=types, nt=types)
    assets = root / "assets"
    assets.mkdir()
    inputs = [dict(id=inp["id"], channel=inp["channel"], label=inp["label"], signal="",
                   group="", selector={}, source="", note="", max_hz=80.0,
                   neurons=[k * 3, k * 3 + 1, k * 3 + 2]) for k, inp in enumerate(I.INPUTS)]
    channels = dict(version=1, W_ms=12000, gain=1.0, tau_syn=None,
                    gating={**chain.GATING, "CAP_FRAC": chain.CAP_FRAC}, inputs=inputs,
                    calibration={"chosen": {"gain": 1.0}})
    (assets / "channels.json").write_text(json.dumps(channels))
    ch = H.channels_hash(channels)
    mul, add = H.permutation(b"\x01" * 32, N)
    (assets / "deploy_params.json").write_text(json.dumps(dict(
        neuronCount=N, connectomeHash="0x" + "01" * 32, neuronTableHash="0x" + "02" * 32,
        channelsHash=H.hx(ch), permMul=mul, permAdd=add)))
    (assets / "superclasses.json").write_text(json.dumps(["central", "sensory"]))
    group = np.zeros(N, np.uint8)
    for k, inp in enumerate(inputs, 1):
        group[inp["neurons"]] = k
    with open(assets / "neurons.bin", "wb") as f:
        f.write(b"FLYN" + struct.pack("<HHI", 1, len(inputs), N) + struct.pack("<6f", 0, 0, 0, 1, 1, 1))
        f.write(np.zeros(3 * N, "<u2").tobytes() + group.tobytes() + np.zeros(N, np.uint8).tobytes()
                + np.array([1 if i % 2 else 4 for i in range(N)], np.uint8).tobytes())
    return root


@pytest.fixture
def fixture_dir(tmp_path):
    return write_fixture(tmp_path)


@pytest.fixture
def make_engine(fixture_dir):
    from engine import Config, Engine

    def make(rpc=None, env=None):
        e = {"ASSETS_DIR": str(fixture_dir / "assets"), "GRAPH_PATH": str(fixture_dir / "data" / "graph.npz"),
             "DATA_DIR": str(fixture_dir / "runtime")}
        e.update(env or {})
        return Engine(Config(e), rpc=rpc or FakeRpc())
    return make
