"""
The continuous brain: every 12 s chain window -> gated input rates -> bio_ms of simulation
-> frame, window leaf, epoch hashes, optional heartbeat. One worker thread.
"""
import json
import os
import struct
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

import chain
import flysim
import hashes as H
from registry import Heartbeat, Registry

HERE = Path(__file__).parent
VERSION = "0.1.0"
EPOCH_S = 600
TOP_K = 2000
KEEP_FRAMES = 30
KEEP_SPIKE_EPOCHS = 144


class Config:
    def __init__(self, env=None):
        e = os.environ if env is None else env
        self.assets = Path(e.get("ASSETS_DIR") or HERE / "assets")
        self.graph = Path(e.get("GRAPH_PATH") or HERE / "data" / "graph.npz")
        self.data_dir = Path(e.get("DATA_DIR") or HERE / "data" / "runtime")
        self.bio_ms = float(e.get("BIO_MS") or 100)
        self.gain = float(e["GAIN"]) if e.get("GAIN") else None
        self.token = (e.get("TOKEN_ADDRESS") or "").strip() or None
        self.token_pools = [p.strip() for p in (e.get("TOKEN_POOLS") or "").split(",") if p.strip()]
        self.registry = (e.get("REGISTRY_ADDRESS") or "").strip() or None
        self.window_ms = int(e.get("WINDOW_MS") or 12000)
        self.finality_ms = int(e.get("FINALITY_DELAY_MS") or 2500)
        # REGISTRY_RPC_URL: where the registry lives and heartbeats go (default: the senses RPC).
        self.registry_rpc = (e.get("REGISTRY_RPC_URL") or "").strip() or None
        self.epoch_s = int(e.get("EPOCH_S") or EPOCH_S)   # != 600 is for local testing only
        self.env = e


def read_neurons_bin(path):
    b = Path(path).read_bytes()
    assert b[:4] == b"FLYN"
    ver, gcount, n = struct.unpack_from("<HHI", b, 4)
    off = 36 + 6 * n
    group = np.frombuffer(b, dtype=np.uint8, count=n, offset=off)
    sup = np.frombuffer(b, dtype=np.uint8, count=n, offset=off + n)
    flags = np.frombuffer(b, dtype=np.uint8, count=n, offset=off + 2 * n)
    return dict(n=n, groups=gcount, group=group, superclass=sup, flags=flags)


class Engine:
    def __init__(self, cfg, rpc=None, brain=None):
        self.cfg = cfg
        self.channels = json.loads((cfg.assets / "channels.json").read_text(encoding="utf-8"))
        self.channels_hash = H.channels_hash(self.channels)
        self.deploy = json.loads((cfg.assets / "deploy_params.json").read_text())
        self.superclasses = json.loads((cfg.assets / "superclasses.json").read_text())
        self.neurons_bin = cfg.assets / "neurons.bin"
        self.table = read_neurons_bin(self.neurons_bin)
        self.inputs = self.channels["inputs"]
        self.ids = [i["id"] for i in self.inputs]

        p = flysim.Params()
        p.tau_syn = self.channels.get("tau_syn")
        self.brain = brain or flysim.FlyBrain(cfg.graph, p=p)
        self.n = self.brain.n
        self.gain = cfg.gain if cfg.gain is not None else float(self.channels["gain"])
        self.gains = np.full(self.brain.n_types, self.gain, dtype=np.float32)
        self.keys = {i["id"]: tuple(i["neurons"]) for i in self.inputs}
        self.steps_per_ms = 1.0 / self.brain.p.dt

        self.rpc = rpc or chain.Rpc.from_env()
        self.cursor = chain.Cursor(self.rpc)
        self.gates = chain.Gates(self.ids, {i["id"]: i["max_hz"] for i in self.inputs},
                                 {**chain.GATING, **{k: self.channels["gating"][k]
                                                     for k in chain.GATING}})
        self.gating_overrides = {}
        if cfg.env.get("GATE_WARM"):          # local testing only; deviates from channels.json
            self.gates.g["WARM"] = self.gating_overrides["WARM"] = int(cfg.env["GATE_WARM"])
        self.token = None
        self.token_checked = 0.0

        self.reg_rpc = chain.Rpc([cfg.registry_rpc]) if cfg.registry_rpc else self.rpc
        if cfg.epoch_s != EPOCH_S:
            self.gating_overrides["EPOCH_S"] = cfg.epoch_s
        self.heartbeat = Heartbeat(self.reg_rpc, cfg.env)
        self.listeners = []
        self.registry = Registry(self.reg_rpc, cfg.registry, cfg.data_dir,
                                 on_claim=lambda c: self.emit("claim", c))

        self.state = None
        self.bio_ms = cfg.bio_ms
        self.slow, self.fast = 0, 0
        self.frames = OrderedDict()          # w -> (frame dict, dense uint8 bytes)
        self.latest = None
        self.epoch = None
        self.epoch_windows = []
        self.leaves = []
        self.last_heartbeat = None
        self.pending_beat = None
        self.rpc_ok = False
        self.lag_s = None
        self.sim_wall_ms = None
        self.lock = threading.Lock()
        (cfg.data_dir / "epochs").mkdir(parents=True, exist_ok=True)
        (cfg.data_dir / "spikes").mkdir(parents=True, exist_ok=True)
        self._restore()

    # ---- listeners --------------------------------------------------------------
    def emit(self, event, data):
        for fn in list(self.listeners):
            try:
                fn(event, data)
            except Exception:
                pass

    # ---- persistence ------------------------------------------------------------
    def _restore(self):
        d = self.cfg.data_dir
        try:
            z = np.load(d / "state.npz", allow_pickle=False)
            if z["v"].shape == (self.n,):
                self.state = {"v": z["v"], "refr": z["refr"], "rng": json.loads(str(z["rng"])),
                              "g": z["g"] if "g" in z.files and z["g"].shape == (self.n,) else None}
        except (OSError, ValueError, KeyError):
            pass
        try:
            s = json.loads((d / "stats.json").read_text())
            self.gates.load(s.get("gates"))
            self.bio_ms = s.get("bio_ms", self.bio_ms)
            self.last_heartbeat = s.get("last_heartbeat")
            cur = s.get("current_epoch")
            if cur:
                self.epoch = cur["epoch"]
                self.epoch_windows = cur["windows"]
                self.leaves = [bytes.fromhex(x["leaf"][2:]) for x in cur["windows"]]
        except (OSError, ValueError, KeyError):
            pass

    def _persist(self):
        d = self.cfg.data_dir
        st = self.state
        arrays = dict(v=st["v"], refr=st["refr"], rng=np.array(json.dumps(st["rng"])))
        if st.get("g") is not None:
            arrays["g"] = st["g"]
        tmp = d / "state.tmp.npz"
        np.savez(tmp, **arrays)
        os.replace(tmp, d / "state.npz")
        stats = dict(gates=self.gates.dump(), bio_ms=self.bio_ms, last_heartbeat=self.last_heartbeat,
                     current_epoch={"epoch": self.epoch, "windows": self.epoch_windows})
        (d / "stats.tmp.json").write_text(json.dumps(stats))
        os.replace(d / "stats.tmp.json", d / "stats.json")

    # ---- chain ------------------------------------------------------------------
    def read_chain(self, w):
        end_ms = (w + 1) * self.cfg.window_ms
        if self.cfg.token and time.time() - self.token_checked > 600:
            self.token_checked = time.time()
            try:
                self.token = chain.discover_token(self.rpc, self.cfg.token, self.cfg.token_pools)
            except Exception:
                self.token = None
        headers, gap = self.cursor.window(end_ms)
        if not headers:
            return None
        lo, hi = chain._hexint(headers[0]["number"]), chain._hexint(headers[-1]["number"])
        receipts = chain.sample_receipts(self.rpc, headers)
        logs = chain.fetch_logs(self.rpc, lo, hi, self.token)
        raw, capped = chain.extract(headers, receipts, logs, self.gates, self.token)
        self.lag_s = round(time.time() - chain.block_ms(headers[-1]) / 1000.0, 2)
        return dict(fromBlock=lo, toBlock=hi, blocks=len(headers), raw=raw, capped=capped,
                    gap=gap, logs=len(logs), sampled=len(receipts))

    # ---- one window -------------------------------------------------------------
    def process_window(self, w):
        t_start = time.time()
        try:
            ch = self.read_chain(w)
            self.rpc_ok = ch is not None
        except Exception as e:
            print(f"chain read failed w={w}: {type(e).__name__}: {str(e)[:120]}", flush=True)
            ch, self.rpc_ok = None, False
        active = {i: (i not in ("token.buy", "token.sell", "token.burn") or self.token is not None)
                  for i in self.ids}
        if ch:
            gated = self.gates.step(ch["raw"], active)
            capped = ch["capped"]
        else:  # no chain data: no drive, buffers untouched
            gated = {i: dict(raw=0.0, z=0.0, rate_hz=0.0, warm=len(self.gates.bufs[i]) < self.gates.g["WARM"],
                             active=active[i]) for i in self.ids}
            capped = {i: 0 for i in self.ids}

        e = (w * self.cfg.window_ms // 1000) // self.cfg.epoch_s
        finished = None
        if self.epoch is not None and e != self.epoch and self.epoch_windows and self.state is not None:
            finished = self.finalize_epoch()
        if self.epoch != e:
            self.epoch, self.epoch_windows, self.leaves = e, [], []

        drive = {self.keys[i]: g["rate_hz"] for i, g in gated.items() if g["rate_hz"] > 0}
        bio_ms = self.bio_ms
        steps = int(round(bio_ms * self.steps_per_ms))
        t0 = time.time()
        r = self.brain.run(drive, steps, gains=self.gains, seed=w, state=self.state, count_all=True)
        sim_s = time.time() - t0
        self.state = r["_state"]
        self.sim_wall_ms = round(sim_s * 1000)
        self._guard(sim_s)

        counts = r["_counts"]
        ids = np.flatnonzero(counts).astype(np.uint32)
        cvals = counts[ids]
        leaf = H.window_leaf(w, ids, cvals)
        order = np.argsort(-cvals.astype(np.int64), kind="stable")[:TOP_K]
        total = int(cvals.sum())
        frame = dict(
            window=w, epoch=e, t_ms=(w + 1) * self.cfg.window_ms, fromBlock=ch["fromBlock"] if ch else 0,
            toBlock=ch["toBlock"] if ch else 0, blocks=ch["blocks"] if ch else 0, bio_ms=bio_ms,
            total_spikes=total, active_neurons=int(len(ids)),
            mean_hz=round(total / self.n / (bio_ms / 1000.0), 4), rpc_ok=self.rpc_ok,
            gap=bool(ch and ch["gap"]), sim_wall_ms=self.sim_wall_ms,
            inputs=[dict(id=i, raw=gated[i]["raw"], z=round(gated[i]["z"], 3),
                         rate_hz=round(gated[i]["rate_hz"], 2), warm=gated[i]["warm"],
                         active=gated[i]["active"], capped=int(capped.get(i, 0))) for i in self.ids],
            top=[[int(ids[k]), int(cvals[k])] for k in order],
            leaf=H.hx(leaf),
        )
        dense = np.minimum(counts, 255).astype(np.uint8).tobytes()
        win_rec = dict(w=w, fromBlock=frame["fromBlock"], toBlock=frame["toBlock"], bio_ms=int(bio_ms),
                       raw={i: gated[i]["raw"] for i in self.ids},
                       rates={i: gated[i]["rate_hz"] for i in self.ids},
                       capped={i: int(capped.get(i, 0)) for i in self.ids}, leaf=frame["leaf"])
        with self.lock:
            self.frames[w] = (frame, dense)
            while len(self.frames) > KEEP_FRAMES:
                self.frames.popitem(last=False)
            self.latest = frame
            self.epoch_windows.append(win_rec)
            self.leaves.append(leaf)
        with open(self.cfg.data_dir / "spikes" / f"{e}.bin", "ab") as f:
            f.write(struct.pack("<QI", w, len(ids)) + ids.astype("<u4").tobytes() +
                    cvals.astype("<u2").tobytes())
        self._persist()
        self.emit("frame", {k: v for k, v in frame.items() if k != "top"})
        if finished is not None:
            self.pending_beat = dict(finished, tries=0)
        self._maybe_beat()
        frame["_wall_ms"] = round((time.time() - t_start) * 1000)
        return frame

    def _guard(self, sim_s):
        W = self.cfg.window_ms / 1000.0
        if sim_s > 0.6 * W:
            self.slow, self.fast = self.slow + 1, 0
            if self.slow >= 3 and self.bio_ms > 50:
                self.bio_ms, self.slow = 50.0, 0
        elif sim_s < 0.3 * W:
            self.fast, self.slow = self.fast + 1, 0
            if self.fast >= 20 and self.bio_ms < self.cfg.bio_ms:
                self.bio_ms, self.fast = self.cfg.bio_ms, 0
        else:
            self.slow = self.fast = 0

    # ---- epochs and heartbeats -------------------------------------------------
    def finalize_epoch(self):
        e = self.epoch
        sh = H.state_hash(e, self.state["v"], self.state["refr"])
        root = H.merkle_root(self.leaves)
        ih = H.input_hash(self.channels_hash, self.epoch_windows, self.ids)
        rec = dict(epoch=e, windows=self.epoch_windows, stateHash=H.hx(sh), spikeRoot=H.hx(root),
                   inputHash=H.hx(ih), tx=None)
        (self.cfg.data_dir / "epochs" / f"{e}.json").write_text(json.dumps(rec))
        for old in (self.cfg.data_dir / "spikes").glob("*.bin"):
            if old.stem.isdigit() and int(old.stem) < e - KEEP_SPIKE_EPOCHS:
                old.unlink()
        self.last_heartbeat = dict(epoch=e, stateHash=rec["stateHash"], spikeRoot=rec["spikeRoot"],
                                   inputHash=rec["inputHash"], tx=None)
        return dict(epoch=e, stateHash=sh, spikeRoot=root, inputHash=ih)

    def _maybe_beat(self):
        b = self.pending_beat
        if not b:
            return
        if not self.heartbeat.enabled:
            self.pending_beat = None
            self.emit("heartbeat", self.last_heartbeat)
            return
        try:
            if self.registry.latest is not None and b["epoch"] <= self.registry.latest:
                self.pending_beat = None
                return
            tx = self.heartbeat.send(b["epoch"], b["stateHash"], b["spikeRoot"], b["inputHash"])
            self.pending_beat = None
            if self.last_heartbeat and self.last_heartbeat["epoch"] == b["epoch"]:
                self.last_heartbeat["tx"] = tx
            path = self.cfg.data_dir / "epochs" / f"{b['epoch']}.json"
            rec = json.loads(path.read_text())
            rec["tx"] = tx
            path.write_text(json.dumps(rec))
            self.emit("heartbeat", self.last_heartbeat)
        except Exception as ex:
            b["tries"] += 1
            print(f"heartbeat epoch {b['epoch']} failed ({b['tries']}): {type(ex).__name__}", flush=True)
            if b["tries"] >= 2:
                self.pending_beat = None

    # ---- loop -------------------------------------------------------------------
    def run_forever(self, stop=None):
        W = self.cfg.window_ms
        last = None
        while stop is None or not stop.is_set():
            now = int(time.time() * 1000)
            w = (now - self.cfg.finality_ms) // W - 1      # latest window that has ended
            if last is not None and w <= last:
                time.sleep(max(0.05, ((last + 2) * W + self.cfg.finality_ms - now) / 1000.0))
                continue
            try:
                f = self.process_window(w)
                print(f"w={w} blocks={f['blocks']} spikes={f['total_spikes']} active={f['active_neurons']} "
                      f"sim={f['sim_wall_ms']}ms wall={f['_wall_ms']}ms rates="
                      f"{ {i['id']: i['rate_hz'] for i in f['inputs'] if i['rate_hz']} }", flush=True)
            except Exception as ex:
                print(f"window {w} failed: {type(ex).__name__}: {str(ex)[:200]}", flush=True)
            last = w

    def start(self):
        threading.Thread(target=self.run_forever, daemon=True, name="sim").start()
        if self.registry.address:
            threading.Thread(target=self.registry.loop, daemon=True, name="registry").start()

    # ---- views ------------------------------------------------------------------
    def status(self):
        f = self.latest
        return dict(
            ok=True, version=VERSION, n=self.n, window_ms=self.cfg.window_ms, bio_ms=self.bio_ms,
            gain=self.gain, tau_syn=self.channels.get("tau_syn"),
            window=f["window"] if f else None, epoch=self.epoch,
            block=self.cursor.head, rpc_ok=self.rpc_ok, lag_s=self.lag_s, sim_wall_ms=self.sim_wall_ms,
            warm=any(len(b) < self.gates.g["WARM"] for i, b in self.gates.bufs.items()
                     if not i.startswith("token.") or self.token is not None),
            connectomeHash=self.deploy["connectomeHash"], neuronTableHash=self.deploy["neuronTableHash"],
            channelsHash=H.hx(self.channels_hash),
            channelsHashMatchesDeploy=H.hx(self.channels_hash) == self.deploy["channelsHash"],
            registry=dict(address=self.registry.address, token=self.registry.token,
                          price=self.registry.price, claimsCount=len(self.registry.claims),
                          remaining=self.registry.remaining),
            token=dict(address=self.cfg.token, active=self.token is not None,
                       pools=sorted(self.token["pools"]) if self.token else []),
            lastHeartbeat=self.last_heartbeat, heartbeat_enabled=self.heartbeat.enabled,
            calibration=self.channels.get("calibration", {}).get("chosen"),
            gating_overrides=self.gating_overrides,
        )

    def frame_bin(self, w=None):
        with self.lock:
            if not self.frames:
                return None, None
            if w is None:
                w = next(reversed(self.frames))
            item = self.frames.get(w)
        return (w, item[1]) if item else (None, None)

    def neuron(self, i):
        t = self.table
        flags = int(t["flags"][i])
        side = "L" if flags & 2 else "R" if flags & 4 else "M" if flags & 8 else None
        gid = int(t["group"][i])
        n, mul, add = self.n, int(self.deploy["permMul"]), int(self.deploy["permAdd"])
        index = (pow(mul, -1, n) * (i + n - add)) % n
        return dict(id=i, bodyId=int(self.brain.bodies[i]), type=str(self.brain.types[i]),
                    superclass=str(self.brain.superclass[i]), side=side, imputed=bool(flags & 1),
                    group=self.ids[gid - 1] if gid else None, index=index,
                    claim=self.registry.claim_of_index(index))

    def epoch_record(self, e):
        p = self.cfg.data_dir / "epochs" / f"{int(e)}.json"
        return json.loads(p.read_text()) if p.exists() else None
