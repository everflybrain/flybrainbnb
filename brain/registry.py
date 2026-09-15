"""
FlyBrainRegistry reads (claims, token, price, latest beat) and the heartbeat sender.

The sender is OFF unless REGISTRY_ADDRESS, OPERATOR_PRIVATE_KEY and HEARTBEAT=1 are all
set. The key is read from the environment only, used only to sign, and never logged.
"""
import json
import os
import threading
import time
from pathlib import Path

from eth_abi import decode as abi_decode

from chain import selector

CLAIM_TUPLE = "(address,uint32,uint32,uint64,uint256,bytes,bytes)"  # strings read as bytes


def _word(n):
    return hex(n)[2:].rjust(64, "0")


def _b32(b):
    b = bytes.fromhex(b[2:]) if isinstance(b, str) else b
    assert len(b) == 32
    return b.hex()


def encode_heartbeat(epoch, state_hash, spike_root, input_hash):
    return (selector("heartbeat(uint64,bytes32,bytes32,bytes32)") + _word(epoch) +
            _b32(state_hash) + _b32(spike_root) + _b32(input_hash))


def decode_claim(claim_id, hexdata):
    (owner, start, count, t, burned, name, note), = abi_decode(
        [CLAIM_TUPLE], bytes.fromhex(hexdata[2:]))
    return dict(id=int(claim_id), owner=owner, start=int(start), count=int(count),
                time=int(t), burned=str(burned),
                name=name.decode("utf-8", errors="replace"),
                note=note.decode("utf-8", errors="replace"),
                name_hex="0x" + name.hex(), note_hex="0x" + note.hex())


class Registry:
    """Polls claimsCount() and fetches new claims; caches them in DATA_DIR/claims.json."""

    def __init__(self, rpc, address, data_dir, on_claim=None):
        self.rpc = rpc
        self.address = address.lower() if address else None
        self.path = Path(data_dir) / "claims.json"
        self.claims = []
        self.token = self.price = self.remaining = None
        self.latest = None
        self.on_claim = on_claim
        self.lock = threading.Lock()
        if self.address and self.path.exists():
            try:
                cached = json.loads(self.path.read_text(encoding="utf-8"))
                if cached.get("address") == self.address:
                    self.claims = cached["claims"]
            except (ValueError, KeyError):
                pass

    def _u(self, sig, arg=""):
        return int(self.rpc.eth_call(self.address, selector(sig) + arg), 16)

    def poll(self):
        if not self.address:
            return
        tok = self._u("token()")
        self.token = "0x" + hex(tok)[2:].rjust(40, "0") if tok else None
        self.price = str(self._u("pricePerNeuron()"))
        self.remaining = self._u("remaining()")
        n = self._u("claimsCount()")
        new = []
        for i in range(len(self.claims), n):
            c = decode_claim(i, self.rpc.eth_call(self.address, selector("getClaim(uint256)") + _word(i)))
            new.append(c)
        if new:
            with self.lock:
                self.claims.extend(new)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"address": self.address, "claims": self.claims}),
                                 encoding="utf-8")
            for c in new:
                if self.on_claim:
                    self.on_claim(c)
        words = self.rpc.eth_call(self.address, selector("latest()"))[2:]
        if len(words) >= 64 * 4:
            self.latest = int(words[:64], 16)

    def loop(self, every=30.0):
        while True:
            try:
                self.poll()
            except Exception as e:
                print(f"registry poll failed: {type(e).__name__}", flush=True)
            time.sleep(every)

    def page(self, offset, limit):
        with self.lock:
            items = list(reversed(self.claims))
        return {"count": len(items), "claims": items[offset:offset + limit]}

    def claim_of_index(self, index):
        with self.lock:
            lo, hi = 0, len(self.claims) - 1
            while lo <= hi:
                mid = (lo + hi) // 2
                c = self.claims[mid]
                if index < c["start"]:
                    hi = mid - 1
                elif index >= c["start"] + c["count"]:
                    lo = mid + 1
                else:
                    return c
        return None


class Heartbeat:
    def __init__(self, rpc, env=None):
        env = os.environ if env is None else env
        self.rpc = rpc
        self.registry = (env.get("REGISTRY_ADDRESS") or "").strip() or None
        self._key = (env.get("OPERATOR_PRIVATE_KEY") or "").strip() or None
        self.chain_id = int(env.get("CHAIN_ID") or 56)
        self.enabled = bool(self.registry and self._key and env.get("HEARTBEAT") == "1")
        self.address = None
        if self.enabled:
            from eth_account import Account
            self.address = Account.from_key(self._key).address
        else:
            self._key = None           # never hold a key we will not use

    def __repr__(self):
        return f"Heartbeat(enabled={self.enabled}, registry={self.registry}, address={self.address})"

    def build(self, epoch, state_hash, spike_root, input_hash, nonce, gas_price):
        from eth_account import Account
        tx = dict(nonce=nonce, gasPrice=gas_price, gas=120_000, to=self.registry, value=0,
                  data="0x" + encode_heartbeat(epoch, state_hash, spike_root, input_hash)[2:],
                  chainId=self.chain_id)
        return "0x" + Account.sign_transaction(tx, self._key).raw_transaction.hex().removeprefix("0x")

    def send(self, epoch, state_hash, spike_root, input_hash):
        """Returns the tx hash, or None when disabled."""
        if not self.enabled:
            return None
        nonce = int(self.rpc.call("eth_getTransactionCount", [self.address, "pending"]), 16)
        gp = max(int(self.rpc.call("eth_gasPrice", []), 16), 50_000_000)   # >= 0.05 gwei
        raw = self.build(epoch, state_hash, spike_root, input_hash, nonce, gp)
        return self.rpc.call("eth_sendRawTransaction", [raw])
