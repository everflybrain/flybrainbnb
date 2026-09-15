"""
BNB Smart Chain reader: JSON-RPC with endpoint rotation and backoff, per-window channel
extraction, per-address caps, and median/MAD gating. Reads only; nothing here signs.
"""
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from collections import deque

import numpy as np
from eth_hash.auto import keccak

import inputs as I

DEFAULT_RPC = "https://bsc-rpc.publicnode.com"

USDT = "0x55d398326f99059ff775485246999027b3197955"
USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"
V2_PAIR = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae"          # token0 USDT, token1 WBNB
V3_POOLS = ("0x172fcd41e0913e95784454622d1c3724f546f849",       # 0.01%, token0 USDT
            "0x36696169c63e42cd08ce11f5deebbcebae652050")       # 0.05%, token0 USDT
DEAD = "0x000000000000000000000000000000000000dead"

T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
T_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
T_SWAP_V3 = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83"

WHALE_USD = 100_000.0
MIN_TRANSFER_USD = 1.0
CAP_FRAC = 0.02
CAP_FLOOR = {"usdt": 10_000.0, "usdc": 10_000.0, "dex.buy": 5_000.0, "dex.sell": 5_000.0,
             "crowd": 1e-4}   # crowd: BNB of fees per sender; token: 1% of supply (runtime)
MAD_FLOOR = {"heat": 0.01}

GATING = dict(Z_GATE=2.0, R_MIN=10.0, K=10.0, MAX_HZ=80.0, BUF=360, WARM=30)


def selector(sig):
    return "0x" + keccak(sig.encode()).hex()[:8]


def topic(sig):
    return "0x" + keccak(sig.encode()).hex()


def _addr(topic_hex):
    return "0x" + topic_hex[-40:].lower()


def _words(data):
    d = data[2:] if data.startswith("0x") else data
    return [d[i:i + 64] for i in range(0, len(d), 64)]


def _u(word):
    return int(word, 16)


def _i(word):
    v = int(word, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


# ---- RPC ---------------------------------------------------------------------------

class RpcError(Exception):
    pass


class Rpc:
    """POST JSON-RPC to the first healthy endpoint; a failing endpoint backs off 2^k s
    (max 120 s) and the next one is tried."""

    def __init__(self, urls, timeout=12.0):
        self.urls = [u for u in urls if u]
        self.bad_until = {u: 0.0 for u in self.urls}
        self.fails = {u: 0 for u in self.urls}
        self.timeout = timeout
        self.lock = threading.Lock()
        self.last_ok = 0.0
        self._id = 0

    @classmethod
    def from_env(cls):
        urls = [os.environ.get("BSC_RPC_URL") or DEFAULT_RPC]
        urls += [u.strip() for u in os.environ.get("RPC_FALLBACKS", "").split(",") if u.strip()]
        if DEFAULT_RPC not in urls:
            urls.append(DEFAULT_RPC)
        return cls(urls)

    def _post(self, url, payload):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "flybrainbnb-brain/1"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def _order(self):
        now = time.time()
        ok = [u for u in self.urls if self.bad_until[u] <= now]
        return ok or sorted(self.urls, key=lambda u: self.bad_until[u])[:1]

    def request(self, payload):
        last = None
        for url in self._order():
            try:
                out = self._post(url, payload)
                if isinstance(out, dict) and "error" in out and payload.get("method") != "eth_call":
                    raise RpcError(str(out["error"])[:200])
                self.fails[url] = 0
                self.last_ok = time.time()
                return out
            except (urllib.error.URLError, TimeoutError, OSError, ValueError, RpcError) as e:
                last = e
                with self.lock:
                    self.fails[url] += 1
                    back = min(120.0, 2.0 ** self.fails[url]) * (0.8 + 0.4 * random.random())
                    self.bad_until[url] = time.time() + back
        raise RpcError(f"all endpoints failed: {type(last).__name__}: {str(last)[:160]}")

    def call(self, method, params):
        self._id += 1
        out = self.request({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        if "error" in out:
            raise RpcError(str(out["error"])[:200])
        return out["result"]

    def batch(self, calls):
        payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                   for i, (m, p) in enumerate(calls)]
        out = self.request(payload)
        if not isinstance(out, list):
            raise RpcError("batch not supported")
        by_id = {o.get("id"): o for o in out}
        res = []
        for i in range(len(calls)):
            o = by_id.get(i)
            if o is None or "error" in o:
                raise RpcError(f"batch item {i} failed")
            res.append(o["result"])
        return res

    def eth_call(self, to, data, block="latest"):
        return self.call("eth_call", [{"to": to, "data": data}, block])


# ---- gating ------------------------------------------------------------------------

def median_mad(buf, input_id):
    if not len(buf):
        return 0.0, max(MAD_FLOOR.get(input_id, 0.0), 1e-9)
    a = np.asarray(buf, dtype=np.float64)
    med = float(np.median(a))
    mad = 1.4826 * float(np.median(np.abs(a - med)))
    floor = MAD_FLOOR.get(input_id) or 1e-9 * max(1.0, med)
    return med, max(mad, floor)


def gate(x, buf, input_id, max_hz, g=GATING):
    """(z, rate_hz, warm) for raw value x against the buffer BEFORE x is appended."""
    med, mad = median_mad(buf, input_id)
    z = (x - med) / mad
    warm = len(buf) < g["WARM"]
    if warm or z < g["Z_GATE"]:
        return z, 0.0, warm
    return z, float(min(max_hz, g["R_MIN"] + g["K"] * (z - g["Z_GATE"]))), warm


def cap_sum(per_key, cap):
    """Sum per-key values with each key capped; returns (total, n_capped)."""
    total, capped = 0.0, 0
    for v in per_key.values():
        if v > cap:
            total += cap
            capped += 1
        else:
            total += v
    return total, capped


class Gates:
    def __init__(self, ids, max_hz, g=GATING):
        self.g = g
        self.max_hz = dict(max_hz)
        self.bufs = {i: deque(maxlen=g["BUF"]) for i in ids}

    def cap_for(self, input_id, floor):
        b = self.bufs[input_id]
        med = float(np.median(b)) if len(b) else 0.0
        return max(CAP_FRAC * med, floor)

    def step(self, raw, active):
        out = {}
        for i, buf in self.bufs.items():
            if not active.get(i, True):
                out[i] = dict(raw=0.0, z=0.0, rate_hz=0.0, warm=True, active=False)
                continue
            x = float(raw.get(i, 0.0))
            z, rate, warm = gate(x, buf, i, self.max_hz.get(i, self.g["MAX_HZ"]), self.g)
            buf.append(x)
            out[i] = dict(raw=x, z=float(z), rate_hz=rate, warm=warm, active=True)
        return out

    def stats(self):
        res = {}
        for i, b in self.bufs.items():
            med, mad = median_mad(b, i)
            res[i] = dict(n=len(b), median=med, mad=mad)
        return res

    def dump(self):
        return {i: list(b) for i, b in self.bufs.items()}

    def load(self, d):
        for i, vals in (d or {}).items():
            if i in self.bufs:
                self.bufs[i].extend(float(v) for v in vals)


# ---- window extraction --------------------------------------------------------------

def _hexint(x):
    return int(x, 16) if isinstance(x, str) else int(x)


def block_ms(b):
    return _hexint(b["milliTimestamp"]) if b.get("milliTimestamp") else _hexint(b["timestamp"]) * 1000


def extract(headers, receipts_by_block, logs, gates, token=None):
    """
    Raw channel values for one window. headers: block objects (hashes only);
    receipts_by_block: {n: [receipt]} for sampled blocks; logs: eth_getLogs result;
    token: None or {address, pools:set, decimals, supply}.
    Returns (raw{id: float}, capped{id: int}).
    """
    raw, capped = {i: 0.0 for i in I.IDS}, {i: 0 for i in I.IDS}
    nblocks = len(headers)
    raw["traffic"] = float(sum(len(b["transactions"]) for b in headers))

    fee_by_sender, prices = {}, []
    for rs in receipts_by_block.values():
        for r in rs:
            price = _hexint(r.get("effectiveGasPrice") or "0x0")
            if price == 0:          # system transactions pay nothing
                continue
            prices.append(price / 1e9)
            fee = price * _hexint(r["gasUsed"]) / 1e18
            s = r["from"].lower()
            fee_by_sender[s] = fee_by_sender.get(s, 0.0) + fee
    if receipts_by_block:
        scale = nblocks / len(receipts_by_block)
        total, capped["crowd"] = cap_sum(fee_by_sender, gates.cap_for("crowd", CAP_FLOOR["crowd"]))
        raw["crowd"] = total * scale
        raw["heat"] = float(np.median(prices)) if prices else 0.0

    flows = {"usdt": {}, "usdc": {}, "dex.buy": {}, "dex.sell": {}}
    whales = set()
    tok = token["address"].lower() if token else None
    tflows = {"token.buy": {}, "token.sell": {}, "token.burn": {}}
    for lg in logs:
        addr = lg["address"].lower()
        t = lg["topics"]
        if not t:
            continue
        t0 = t[0].lower()
        if t0 == T_TRANSFER and len(t) >= 3:
            frm, to = _addr(t[1]), _addr(t[2])
            w = _words(lg["data"])
            if not w:
                continue
            if addr in (USDT, USDC):
                usd = _u(w[0]) / 1e18
                if usd < MIN_TRANSFER_USD:
                    continue
                d = flows["usdt" if addr == USDT else "usdc"]
                d[frm] = d.get(frm, 0.0) + usd
                if usd >= WHALE_USD:
                    whales.add(frm)
            elif tok and addr == tok:
                amt = _u(w[0]) / 10 ** token["decimals"]
                pools = token["pools"]
                if to == DEAD:
                    k, key = "token.burn", frm
                elif frm in pools and to not in pools:
                    k, key = "token.buy", to
                elif to in pools and frm not in pools:
                    k, key = "token.sell", frm
                else:
                    continue
                tflows[k][key] = tflows[k].get(key, 0.0) + amt
        elif t0 == T_SWAP_V2 and addr == V2_PAIR:
            w = _words(lg["data"])
            if len(w) < 4:
                continue
            a0in, a1in, a0out, a1out = (_u(x) for x in w[:4])
            txh = lg["transactionHash"]
            if a1out > 0 and a0in > 0:
                flows["dex.buy"][txh] = flows["dex.buy"].get(txh, 0.0) + a0in / 1e18
            if a1in > 0 and a0out > 0:
                flows["dex.sell"][txh] = flows["dex.sell"].get(txh, 0.0) + a0out / 1e18
        elif t0 == T_SWAP_V3 and addr in V3_POOLS:
            w = _words(lg["data"])
            if len(w) < 2:
                continue
            a0 = _i(w[0])
            txh = lg["transactionHash"]
            k = "dex.buy" if a0 > 0 else "dex.sell"
            if a0 != 0:
                flows[k][txh] = flows[k].get(txh, 0.0) + abs(a0) / 1e18

    for k, d in flows.items():
        raw[k], capped[k] = cap_sum(d, gates.cap_for(k, CAP_FLOOR[k]))
    raw["whale"] = float(len(whales))
    if token:
        floor = 0.01 * token["supply"]
        for k, d in tflows.items():
            raw[k], capped[k] = cap_sum(d, gates.cap_for(k, floor))
    return raw, capped


# ---- token pools ------------------------------------------------------------------

def _pad(addr):
    return addr.lower().replace("0x", "").rjust(64, "0")


def discover_token(rpc, token, extra_pools=()):
    sel_pair, sel_pool = selector("getPair(address,address)"), selector("getPool(address,address,uint24)")
    pools = set(p.lower() for p in extra_pools if p)
    for quote in (WBNB, USDT):
        try:
            r = rpc.eth_call(V2_FACTORY, sel_pair + _pad(token) + _pad(quote))
            if isinstance(r, str) and int(r, 16):
                pools.add(_addr(r))
        except Exception:
            pass
        for fee in (100, 500, 2500, 10000):
            try:
                r = rpc.eth_call(V3_FACTORY, sel_pool + _pad(token) + _pad(quote) + hex(fee)[2:].rjust(64, "0"))
                if isinstance(r, str) and int(r, 16):
                    pools.add(_addr(r))
            except Exception:
                pass
    dec = int(rpc.eth_call(token, selector("decimals()")), 16)
    supply = int(rpc.eth_call(token, selector("totalSupply()")), 16) / 10 ** dec
    return {"address": token.lower(), "pools": pools, "decimals": dec, "supply": supply}


# ---- block cursor -----------------------------------------------------------------

class Cursor:
    """Assigns blocks to windows by milliTimestamp, `lag` blocks behind head. No backfill:
    starts at the head on first use and skips ahead when too far behind."""

    def __init__(self, rpc, lag=3, max_blocks=90):
        self.rpc = rpc
        self.lag = lag
        self.max_blocks = max_blocks
        self.next_block = None
        self.head = None

    def fetch_headers(self, lo, hi):
        nums = list(range(lo, hi + 1))
        try:
            hs = self.rpc.batch([("eth_getBlockByNumber", [hex(n), False]) for n in nums])
            return [h for h in hs if h]
        except Exception:
            # fallback: every 3rd block, transactions scaled x3 (DESIGN 3.4)
            out = []
            for n in nums[::3]:
                h = self.rpc.call("eth_getBlockByNumber", [hex(n), False])
                if h:
                    h = dict(h)
                    h["transactions"] = list(h["transactions"]) * 3
                    out.append(h)
            return out

    def window(self, end_ms):
        """Headers of blocks with timestamp < end_ms not yet consumed. (headers, gap)."""
        self.head = _hexint(self.rpc.call("eth_blockNumber", []))
        safe = self.head - self.lag
        gap = False
        if self.next_block is None:
            self.next_block = safe - 26
            gap = True
        if safe - self.next_block + 1 > self.max_blocks:
            self.next_block = safe - self.max_blocks + 1
            gap = True
        if safe < self.next_block:
            return [], gap
        hs = self.fetch_headers(self.next_block, safe)
        hs.sort(key=lambda h: _hexint(h["number"]))
        take = [h for h in hs if block_ms(h) < end_ms]
        if take:
            self.next_block = _hexint(take[-1]["number"]) + 1
        return take, gap


def sample_receipts(rpc, headers, k=3):
    if not headers:
        return {}
    idx = sorted(set(int(round(x)) for x in np.linspace(0, len(headers) - 1, min(k, len(headers)))))
    out = {}
    for i in idx:
        n = _hexint(headers[i]["number"])
        try:
            out[n] = rpc.call("eth_getBlockReceipts", [hex(n)]) or []
        except Exception:
            pass
    return out


def fetch_logs(rpc, lo, hi, token=None):
    addrs = [USDT, USDC, V2_PAIR, *V3_POOLS]
    if token:
        addrs.append(token["address"])
    return rpc.call("eth_getLogs", [{"fromBlock": hex(lo), "toBlock": hex(hi), "address": addrs,
                                     "topics": [[T_TRANSFER, T_SWAP_V2, T_SWAP_V3]]}])
