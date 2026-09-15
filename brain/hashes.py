"""
Every hash in DESIGN.md section 5. SHA-256, little-endian integers, stdlib + numpy only.
"""
import hashlib
import json
import math
import struct

import numpy as np


def sha256(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hx(b):
    return "0x" + b.hex()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def connectome_hash(n, bodies, indptr, indices, data):
    return sha256(b"flybrainbnb/connectome/v1", struct.pack("<I", n),
                  np.asarray(bodies, dtype="<i8").tobytes(),
                  np.asarray(indptr, dtype="<i8").tobytes(),
                  np.asarray(indices, dtype="<i4").tobytes(),
                  np.asarray(data, dtype="<f4").tobytes())


def channels_hash(channels_obj):
    return sha256(canonical(channels_obj))


def neuron_table_hash(n, bodies, types, ch_hash):
    return sha256(b"flybrainbnb/neurons/v1", struct.pack("<I", n),
                  np.asarray(bodies, dtype="<i8").tobytes(),
                  "\n".join(str(t) for t in types).encode("utf-8"), ch_hash)


def permutation(conn_hash, n):
    seed = sha256(b"flybrainbnb/perm/v1", conn_hash)
    mul = int.from_bytes(seed[0:8], "big") % n
    while not (mul > 1 and math.gcd(mul, n) == 1):
        mul = (mul + 1) % n
    add = int.from_bytes(seed[8:16], "big") % n
    return mul, add


def neuron_at(index, mul, add, n):
    return (mul * index + add) % n


def window_leaf(w, ids, counts):
    ids = np.asarray(ids, dtype="<u4")
    counts = np.minimum(np.asarray(counts), 65535).astype("<u2")
    order = np.argsort(ids, kind="stable")
    return sha256(b"flybrainbnb/window/v1", struct.pack("<QI", w, len(ids)),
                  ids[order].tobytes(), counts[order].tobytes())


def merkle_levels(leaves):
    """All levels bottom-up; an odd last node is promoted unchanged."""
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur, nxt = levels[-1], []
        for i in range(0, len(cur), 2):
            nxt.append(sha256(cur[i], cur[i + 1]) if i + 1 < len(cur) else cur[i])
        levels.append(nxt)
    return levels


def merkle_root(leaves):
    if not leaves:
        return b"\x00" * 32
    return merkle_levels(leaves)[-1][0]


def merkle_proof(leaves, index):
    """[(sibling_hash, sibling_is_left)], skipping levels where the node is promoted."""
    proof = []
    for level in merkle_levels(leaves)[:-1]:
        sib = index ^ 1
        if sib < len(level):
            proof.append((level[sib], sib < index))
        index //= 2
    return proof


def verify_proof(leaf, proof, root):
    h = leaf
    for sib, left in proof:
        h = sha256(sib, h) if left else sha256(h, sib)
    return h == root


def input_hash(ch_hash, windows, input_ids):
    """windows: [{w, fromBlock, toBlock, bio_ms, raw{id}, rates{id}}] in window order."""
    parts = [b"flybrainbnb/input/v1", ch_hash]
    for win in windows:
        parts.append(struct.pack("<QQQH", win["w"], win["fromBlock"], win["toBlock"],
                                 int(win["bio_ms"])))
        for i in input_ids:
            parts.append(struct.pack("<df", float(win["raw"].get(i, 0.0)),
                                     float(win["rates"].get(i, 0.0))))
    return sha256(*parts)


def state_hash(epoch, v, refr):
    return sha256(b"flybrainbnb/state/v1", struct.pack("<Q", epoch),
                  np.asarray(v, dtype="<f4").tobytes(), np.asarray(refr, dtype="<i4").tobytes())
