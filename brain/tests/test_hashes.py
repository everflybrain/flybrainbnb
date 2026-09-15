import hashlib
import math
import struct

import numpy as np
import pytest

import hashes as H


def leaf(i):
    return hashlib.sha256(bytes([i])).digest()


def test_merkle_single_leaf_is_leaf_and_odd_node_promoted():
    a, b, c = leaf(1), leaf(2), leaf(3)
    assert H.merkle_root([a]) == a
    assert H.merkle_root([a, b]) == hashlib.sha256(a + b).digest()
    ab = hashlib.sha256(a + b).digest()
    assert H.merkle_root([a, b, c]) == hashlib.sha256(ab + c).digest()   # c promoted unchanged


@pytest.mark.parametrize("n", [1, 2, 3, 5, 8, 9, 50])
def test_merkle_proofs_verify_for_every_leaf(n):
    leaves = [leaf(i) for i in range(n)]
    root = H.merkle_root(leaves)
    for i in range(n):
        assert H.verify_proof(leaves[i], H.merkle_proof(leaves, i), root)
    assert not H.verify_proof(leaf(200), H.merkle_proof(leaves, 0), root) or n == 0


def test_window_leaf_layout_and_order_independence():
    ids, counts = np.array([7, 3, 11]), np.array([2, 1, 70000])
    got = H.window_leaf(42, ids, counts)
    want = hashlib.sha256(b"flybrainbnb/window/v1" + struct.pack("<QI", 42, 3) +
                          struct.pack("<3I", 3, 7, 11) + struct.pack("<3H", 1, 2, 65535)).digest()
    assert got == want
    assert H.window_leaf(42, ids[::-1], counts[::-1]) == got


def test_permutation_is_bijection_and_matches_contract_formula():
    for n in (1009, 1000, 165122):
        mul, add = H.permutation(b"\x07" * 32, n)
        assert 1 < mul < n and math.gcd(mul, n) == 1 and add < n
        if n <= 1009:
            assert sorted(H.neuron_at(i, mul, add, n) for i in range(n)) == list(range(n))
        inv = pow(mul, -1, n)
        for i in (0, 1, n // 2, n - 1):
            assert inv * (H.neuron_at(i, mul, add, n) + n - add) % n == i


def test_input_hash_and_state_hash_layout():
    ch = b"\x09" * 32
    win = dict(w=5, fromBlock=10, toBlock=36, bio_ms=100, raw={"a": 1.5, "b": 0.0}, rates={"a": 12.0})
    got = H.input_hash(ch, [win], ["a", "b"])
    want = hashlib.sha256(b"flybrainbnb/input/v1" + ch + struct.pack("<QQQH", 5, 10, 36, 100) +
                          struct.pack("<df", 1.5, 12.0) + struct.pack("<df", 0.0, 0.0)).digest()
    assert got == want
    v, refr = np.array([-52.0, -45.5], np.float32), np.array([0, 3], np.int32)
    assert H.state_hash(9, v, refr) == hashlib.sha256(
        b"flybrainbnb/state/v1" + struct.pack("<Q", 9) + v.tobytes() + refr.tobytes()).digest()


def test_channels_hash_is_canonical():
    assert H.channels_hash({"b": 1, "a": "é"}) == hashlib.sha256('{"a":"é","b":1}'.encode()).digest()
