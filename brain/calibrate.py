"""
Global synaptic scale (GAIN) calibration, DESIGN.md 3.2, plus a distinctness check.

For each GAIN: every input alone at MAX_HZ for BIO_MS from rest, then all inputs together
for BIO_MS followed by 50 ms of silence. Picks the largest GAIN where
  (a) any single input at max leaves brain mean rate < 5 Hz,
  (b) the last 10 ms of the 50 ms after all drive stops has mean rate < 0.5 Hz,
  (c) every input alone lights > 500 neurons (downstream of its own group).
Distinctness: Jaccard overlap of the downstream active sets (input-group neurons removed).

With --fit-max, each input first gets its own max_hz: the highest of MAX_CANDIDATES whose
alone-run keeps brain mean rate under FIT_TARGET_HZ (big receptor groups otherwise
saturate the brain long before small groups light anything). A uniform max_hz satisfies
(a) and (c) at no GAIN on this connectome (measured 2026-09-15, see data/calib_*.json).

  py calibrate.py --gains 0.1,0.15,0.2,0.25,0.3 [--tau-syn 5] [--out data/calibration.json]
"""
import argparse
import json
import time
from itertools import combinations
from pathlib import Path

import numpy as np

import flysim
import inputs as I

HERE = Path(__file__).parent


def brain(tau_syn=None):
    p = flysim.Params()
    p.tau_syn = tau_syn
    return flysim.FlyBrain(HERE / "data" / "graph.npz", p=p)


def steps_for(fb, ms):
    return int(round(ms / fb.p.dt))


def run_input(fb, gains, ids, hz, bio_ms, all_input, seed=1):
    r = fb.run({tuple(ids.tolist()): hz}, steps_for(fb, bio_ms), gains=gains, seed=seed, count_all=True)
    c = r["_counts"].astype(np.int64)
    c[all_input] = 0
    active = np.flatnonzero(c > 0)
    return r["_total_hz"], active


def jaccard(a, b):
    u = len(np.union1d(a, b))
    return len(np.intersect1d(a, b)) / u if u else 0.0


MAX_CANDIDATES = (80.0, 60.0, 40.0, 30.0, 20.0, 15.0, 10.0)
FIT_TARGET_HZ = 4.0


def fit_max(fb, gains, groups, all_input, bio_ms):
    out = {}
    for inp, ids in groups:
        for hz in MAX_CANDIDATES:
            mean, _ = run_input(fb, gains, ids, hz, bio_ms, all_input)
            if mean < FIT_TARGET_HZ:
                break
        out[inp["id"]] = hz
    return out


def sweep(fb, gains_list, max_hz, bio_ms, only=None, fit=False):
    groups = I.resolve(fb)
    if only:
        groups = [(i, g) for i, g in groups if i["id"] in only]
    all_input = np.concatenate([g for _, g in I.resolve(fb)])
    rows = []
    for G in gains_list:
        gains = np.full(fb.n_types, G, dtype=np.float32)
        t0 = time.time()
        mx = fit_max(fb, gains, groups, all_input, bio_ms) if fit else             {i["id"]: max_hz for i, _ in groups}
        per = {}
        for inp, ids in groups:
            hz, active = run_input(fb, gains, ids, mx[inp["id"]], bio_ms, all_input)
            per[inp["id"]] = dict(max_hz=mx[inp["id"]], mean_hz=round(float(hz), 3),
                                  downstream_active=int(len(active)), _active=active)
        drive = {tuple(ids.tolist()): mx[i["id"]] for i, ids in groups}
        r = fb.run(drive, steps_for(fb, bio_ms), gains=gains, seed=2)
        s1 = fb.run({}, steps_for(fb, 40), gains=gains, state=r["_state"])
        s2 = fb.run({}, steps_for(fb, 10), gains=gains, state=s1["_state"])
        ids_ = list(per)
        jac = {f"{a}|{b}": round(jaccard(per[a]["_active"], per[b]["_active"]), 3)
               for a, b in combinations(ids_, 2)}
        # union of all downstream sets vs the typical pair: one blob or distinct sets?
        row = dict(
            gain=G,
            single_max_mean_hz=max(v["mean_hz"] for v in per.values()),
            all_driven_mean_hz=round(float(r["_total_hz"]), 3),
            after_stop_mean_hz_40_50ms=round(float(s2["_total_hz"]), 3),
            min_downstream_active=min(v["downstream_active"] for v in per.values()),
            per_input={k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")}
                       for k, v in per.items()},
            jaccard=jac,
            jaccard_median=round(float(np.median(list(jac.values()))), 3) if jac else None,
            wall_s=round(time.time() - t0, 1),
        )
        row["ok_a"] = row["single_max_mean_hz"] < 5.0
        row["ok_b"] = row["after_stop_mean_hz_40_50ms"] < 0.5
        row["ok_c"] = row["min_downstream_active"] > 500
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if k not in ("jaccard", "per_input")}),
              flush=True)
        print("   ", {k: (v["max_hz"], v["mean_hz"], v["downstream_active"]) for k, v in row["per_input"].items()},
              flush=True)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gains", default="0.1,0.15,0.2,0.25,0.3")
    ap.add_argument("--tau-syn", type=float, default=None)
    ap.add_argument("--max-hz", type=float, default=80.0)
    ap.add_argument("--bio-ms", type=float, default=100.0)
    ap.add_argument("--only", default="")
    ap.add_argument("--fit-max", action="store_true")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    fb = brain(a.tau_syn)
    rows = sweep(fb, [float(x) for x in a.gains.split(",")], a.max_hz, a.bio_ms,
                 only=[x for x in a.only.split(",") if x], fit=a.fit_max)
    ok = [r for r in rows if r["ok_a"] and r["ok_b"] and r["ok_c"]]
    pick = max(ok, key=lambda r: r["gain"])["gain"] if ok else None
    res = dict(tau_syn=a.tau_syn, max_hz=a.max_hz, fit_max=a.fit_max, bio_ms=a.bio_ms, pick=pick, rows=rows)
    print("PICK", pick)
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
