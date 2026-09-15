"""
Writes the committed runtime assets (DESIGN.md 2, 5, 6):
  assets/neurons.bin        positions (quantised), channel group, superclass, flags
  assets/channels.json      inputs, neuron groups, GAIN, gating, calibration record
  assets/deploy_params.json connectomeHash, neuronTableHash, channelsHash, permMul, permAdd
  assets/calibration.json   copy of the chosen calibration sweep (data/calib_fit.json)

Build-time deps: numpy scipy pandas pyarrow. Inputs: data/graph.npz,
data/body-annotations.feather, data/calib_fit.json (from `py calibrate.py --fit-max
--gains 0.12,0.15,0.18 --out data/calib_fit.json`).

  py make_assets.py
"""
import json
import struct
from pathlib import Path

import numpy as np
import scipy.sparse as sp

import chain
import hashes as H
import inputs as I

HERE = Path(__file__).parent
DATA = HERE / "data"
ASSETS = HERE / "assets"

# CHOSEN by calibrate.py (2026-09-15): largest GAIN meeting DESIGN 3.2 (a)(b)(c) once each
# input has its own max_hz. Stock instantaneous synapses (tau_syn None): a 5 ms synaptic
# current was measured too (data/calib_syn5.json) and kept activity alive after the drive
# stopped at every GAIN tried, without making channels more distinct.
GAIN = 0.15
TAU_SYN = None
W_MS = 12000


def load_graph():
    z = np.load(DATA / "graph.npz", allow_pickle=False)
    return {k: z[k] for k in z.files}


def positions(g, n):
    import pandas as pd
    ann = pd.read_feather(DATA / "body-annotations.feather",
                          columns=["bodyId", "somaLocation", "somaSide", "rootSide"])
    ann = ann.drop_duplicates("bodyId").set_index("bodyId").reindex(g["bodies"])
    pos = np.full((n, 3), np.nan)
    for i, loc in enumerate(ann["somaLocation"].to_numpy()):
        if loc is not None and not (isinstance(loc, float) and np.isnan(loc)) and len(loc) == 3:
            pos[i] = loc
    real = ~np.isnan(pos[:, 0])
    lo, hi = np.nanmin(pos, axis=0), np.nanmax(pos, axis=0)
    span = hi - lo
    rng = np.random.default_rng(0)
    imputed = ~real

    W = sp.csr_matrix((g["data"], g["indices"], g["indptr"]), shape=tuple(g["shape"])).tocsc()
    types, sup = g["types"].astype(str), g["superclass"].astype(str)
    side = ann["somaSide"].fillna(ann["rootSide"]).fillna("").astype(str).to_numpy()
    for j in np.flatnonzero(imputed):
        rows = W.indices[W.indptr[j]:W.indptr[j + 1]]
        wts = np.abs(W.data[W.indptr[j]:W.indptr[j + 1]])
        keep = real[rows]
        if keep.any():
            pos[j] = np.average(pos[rows[keep]], axis=0, weights=wts[keep]) + \
                rng.normal(0, 0.01, 3) * span
            continue
        same = real & (types == types[j]) & (side == side[j])
        if types[j] and same.any():
            pos[j] = pos[same].mean(axis=0)
            continue
        same = real & (sup == sup[j])
        pos[j] = (pos[same].mean(axis=0) if same.any() else (lo + hi) / 2) + \
            rng.normal(0, 0.03, 3) * span
    pos = np.clip(pos, lo, hi)
    return pos, lo, hi, imputed, side


def main():
    ASSETS.mkdir(exist_ok=True)
    g = load_graph()
    n = int(g["shape"][0])
    conn = H.connectome_hash(n, g["bodies"], g["indptr"], g["indices"], g["data"])

    class _T:  # enough of FlyBrain for inputs.resolve
        pass
    import flysim
    fb = _T()
    fb.n, fb.types = n, g["types"].astype(str)
    fb.superclass, fb.subclass = g["superclass"].astype(str), g["subclass"].astype(str)
    fb.receptor, fb.fru = g["receptor"].astype(str), g["fru"].astype(str)
    fb.where = lambda **kw: flysim.FlyBrain.where(fb, **kw)
    groups = I.resolve(fb)

    calib = json.loads((DATA / "calib_fit.json").read_text())
    row = next(r for r in calib["rows"] if abs(r["gain"] - GAIN) < 1e-9)
    max_hz = {k: v["max_hz"] for k, v in row["per_input"].items()}

    channels = dict(
        version=1, W_ms=W_MS, gain=GAIN, tau_syn=TAU_SYN, bio_ms_default=100,
        model="LIF after Shiu et al. 2024; global synaptic scale GAIN on every synapse",
        mapping=I.MAPPING_NOTE,
        gating={**chain.GATING, "CAP_FRAC": chain.CAP_FRAC, "CAP_FLOOR": chain.CAP_FLOOR,
                "MAD_FLOOR": chain.MAD_FLOOR, "WHALE_USD": chain.WHALE_USD,
                "TOKEN_CAP_FLOOR": "1% of total supply"},
        calibration=dict(
            criteria="largest GAIN with (a) any input alone at its max_hz -> brain mean < 5 Hz, "
                     "(b) mean < 0.5 Hz 40-50 ms after all drive stops, (c) every input alone "
                     "lights > 500 neurons outside the input groups",
            chosen={k: row[k] for k in ("gain", "single_max_mean_hz", "all_driven_mean_hz",
                                        "after_stop_mean_hz_40_50ms", "min_downstream_active",
                                        "jaccard_median")},
            sweep=[{k: r[k] for k in ("gain", "ok_a", "ok_b", "ok_c", "single_max_mean_hz",
                                      "min_downstream_active")} for r in calib["rows"]]),
        inputs=[dict(id=inp["id"], channel=inp["channel"], label=inp["label"],
                     signal=inp["signal"], group=inp["group"], selector=inp["selector"],
                     source=inp["source"], note=inp.get("note", ""),
                     max_hz=max_hz[inp["id"]], neurons=[int(x) for x in ids])
                for inp, ids in groups],
    )
    ch_hash = H.channels_hash(channels)
    (ASSETS / "channels.json").write_text(
        json.dumps(channels, sort_keys=True, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    table = H.neuron_table_hash(n, g["bodies"], g["types"].astype(str), ch_hash)
    mul, add = H.permutation(conn, n)
    (ASSETS / "deploy_params.json").write_text(json.dumps(dict(
        neuronCount=n, connectomeHash=H.hx(conn), neuronTableHash=H.hx(table),
        channelsHash=H.hx(ch_hash), permMul=mul, permAdd=add), indent=1))
    (ASSETS / "calibration.json").write_text(json.dumps(calib, indent=1))

    pos, lo, hi, imputed, side = positions(g, n)
    q = np.round((pos - lo) / np.where(hi > lo, hi - lo, 1) * 65535).astype("<u2")
    group = np.zeros(n, dtype=np.uint8)
    for gi, (_, ids) in enumerate(groups, start=1):
        group[ids] = gi
    sup_names = sorted(set(g["superclass"].astype(str)))
    sup_id = np.searchsorted(np.array(sup_names), g["superclass"].astype(str)).astype(np.uint8)
    flags = (imputed.astype(np.uint8) | (side == "L") * 2 | (side == "R") * 4 |
             (side == "M") * 8).astype(np.uint8)
    with open(ASSETS / "neurons.bin", "wb") as f:
        f.write(b"FLYN" + struct.pack("<HHI", 1, len(groups), n))
        f.write(struct.pack("<6f", *lo, *hi))
        for axis in range(3):
            f.write(q[:, axis].tobytes())
        f.write(group.tobytes())
        f.write(sup_id.tobytes())
        f.write(flags.tobytes())
    (ASSETS / "superclasses.json").write_text(json.dumps(sup_names))
    print(json.dumps(dict(n=n, imputed=int(imputed.sum()), channelsHash=H.hx(ch_hash),
                          connectomeHash=H.hx(conn), neuronTableHash=H.hx(table),
                          permMul=mul, permAdd=add, superclasses=len(sup_names)), indent=1))


if __name__ == "__main__":
    main()
