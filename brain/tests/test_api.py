import gzip
import json

import numpy as np
from fastapi.testclient import TestClient

import hashes as H
import registry
from conftest import N, BLOCK_MS0, FakeRpc
from server import create_app

W_MS = 12000


def window_for_head(rpc):
    return (BLOCK_MS0 + 450 * rpc.head) // W_MS


def test_engine_windows_epoch_rollover_and_api_shapes(make_engine, fixture_dir):
    rpc = FakeRpc(head=10_000)
    eng = make_engine(rpc)
    w0 = window_for_head(rpc)
    # pick windows either side of an epoch boundary (epoch = 50 windows)
    last_of_epoch = (w0 // 50) * 50 + 49
    frames = []
    for k, w in enumerate([last_of_epoch - 1, last_of_epoch, last_of_epoch + 1]):
        rpc.head = (w + 1) * W_MS // 450 - (BLOCK_MS0 // 450) + 5
        frames.append(eng.process_window(w))
    assert frames[0]["blocks"] > 0 and frames[-1]["epoch"] == frames[0]["epoch"] + 1
    rec = eng.epoch_record(frames[0]["epoch"])
    assert rec and len(rec["windows"]) == 2 and rec["tx"] is None
    assert rec["spikeRoot"] == H.hx(H.merkle_root([bytes.fromhex(x["leaf"][2:]) for x in rec["windows"]]))
    assert "eth_sendRawTransaction" not in rpc.calls                    # heartbeat off

    app = create_app(lambda: eng, autostart=False, env={"CORS_ORIGINS": "https://site.example"})
    with TestClient(app) as c:
        s = c.get("/status").json()
        for k in ("ok", "version", "n", "window_ms", "bio_ms", "gain", "window", "epoch", "block", "rpc_ok",
                  "lag_s", "sim_wall_ms", "warm", "connectomeHash", "neuronTableHash", "channelsHash",
                  "registry", "lastHeartbeat", "heartbeat_enabled"):
            assert k in s, k
        assert s["n"] == N and s["heartbeat_enabled"] is False and s["channelsHashMatchesDeploy"]
        assert s["lastHeartbeat"]["epoch"] == frames[0]["epoch"] and s["lastHeartbeat"]["tx"] is None
        assert s["registry"] == dict(address=None, token=None, price=None, claimsCount=0, remaining=None)

        f = c.get("/frame").json()
        for k in ("window", "epoch", "t_ms", "fromBlock", "toBlock", "bio_ms", "total_spikes",
                  "active_neurons", "mean_hz", "inputs", "top", "leaf"):
            assert k in f, k
        assert [i["id"] for i in f["inputs"]][:3] == ["traffic", "crowd", "heat"]
        assert set(f["inputs"][0]) == {"id", "raw", "z", "rate_hz", "warm", "active", "capped"}
        assert all(i["active"] is False for i in f["inputs"] if i["id"].startswith("token."))

        r = c.get("/frame.bin", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and len(r.content) == N          # client decodes gzip
        dense = np.frombuffer(r.content, np.uint8)
        assert int(dense.sum()) == min(f["total_spikes"], 255 * N) or dense.max() == 255
        assert c.get(f"/frame.bin?w={frames[0]['window']}").status_code == 200
        assert c.get("/frame.bin?w=1").status_code == 404

        nb = c.get("/neurons.bin")
        assert nb.content[:4] == b"FLYN" and "max-age=86400" in nb.headers["cache-control"]

        ch = c.get("/channels").json()
        assert len(ch["inputs"]) == 11 and "superclasses" in ch and "gating" in ch
        assert ch["stats"]["traffic"]["n"] >= 1

        assert c.get("/owners").json() == {"count": 0, "claims": []}
        n0 = c.get("/neuron/0").json()
        assert set(n0) == {"id", "bodyId", "type", "superclass", "side", "imputed", "group", "index", "claim"}
        assert n0["group"] == "traffic" and n0["claim"] is None
        assert c.get(f"/neuron/{N}").status_code == 404
        assert c.get(f"/epoch/{frames[0]['epoch']}").json()["epoch"] == frames[0]["epoch"]
        assert c.get("/epoch/1").status_code == 404

        body = c.get("/stream?once=1")
        assert body.headers["content-type"].startswith("text/event-stream")
        ev = body.text.split("\n")
        assert ev[0] == "event: frame" and "top" not in json.loads(ev[1][len("data: "):])

        ok = c.get("/status", headers={"Origin": "https://site.example"})
        assert ok.headers.get("access-control-allow-origin") == "https://site.example"
        bad = c.get("/status", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in bad.headers


def test_restart_resumes_state_and_buffers(make_engine):
    rpc = FakeRpc(head=10_000)
    eng = make_engine(rpc)
    w = window_for_head(rpc)
    rpc.head = (w + 1) * W_MS // 450 - (BLOCK_MS0 // 450) + 5
    eng.process_window(w)
    eng2 = make_engine(FakeRpc(head=rpc.head))
    assert eng2.state is not None and len(eng2.gates.bufs["traffic"]) == 1
    assert np.array_equal(eng2.state["v"], eng.state["v"])


def test_rpc_failure_runs_brain_without_drive(make_engine):
    class Down(FakeRpc):
        def call(self, method, params):
            raise OSError("down")
    eng = make_engine(Down())
    f = eng.process_window(123456)
    assert f["rpc_ok"] is False and f["blocks"] == 0 and all(i["rate_hz"] == 0 for i in f["inputs"])
    assert len(eng.gates.bufs["traffic"]) == 0


def test_heartbeat_off_unless_all_three_set():
    key = "0x" + "11" * 32                                   # throwaway test key, not a wallet
    base = {"REGISTRY_ADDRESS": "0x" + "22" * 20, "OPERATOR_PRIVATE_KEY": key, "HEARTBEAT": "1"}
    for missing in base:
        env = {k: v for k, v in base.items() if k != missing}
        hb = registry.Heartbeat(FakeRpc(), env)
        assert hb.enabled is False and hb._key is None and hb.send(1, b"\0" * 32, b"\0" * 32, b"\0" * 32) is None
    assert registry.Heartbeat(FakeRpc(), {**base, "HEARTBEAT": "0"}).enabled is False
    hb = registry.Heartbeat(FakeRpc(), {**base, "CHAIN_ID": "31337"})
    assert hb.enabled and key not in repr(hb)
    raw = hb.build(7, b"\x01" * 32, b"\x02" * 32, b"\x03" * 32, nonce=0, gas_price=50_000_000)
    from eth_account import Account
    assert Account.recover_transaction(raw) == hb.address


def test_heartbeat_calldata():
    data = registry.encode_heartbeat(7, b"\x01" * 32, "0x" + "02" * 32, b"\x03" * 32)
    from eth_hash.auto import keccak
    assert data[:10] == "0x" + keccak(b"heartbeat(uint64,bytes32,bytes32,bytes32)").hex()[:8]
    assert len(data) == 10 + 64 * 4 and data[10:74] == "0" * 63 + "7"


def test_claim_decoding_keeps_invalid_utf8_as_hex():
    from eth_abi import encode
    blob = encode([registry.CLAIM_TUPLE], [("0x" + "ab" * 20, 5, 3, 1700000000, 10**18,
                                            "<script>é".encode() , b"\xff\xfe")])
    c = registry.decode_claim(4, "0x" + blob.hex())
    assert c["name"] == "<script>é" and c["note_hex"] == "0xfffe" and c["start"] == 5 and c["count"] == 3


def test_registry_rpc_is_separate_from_senses_and_epoch_length_override(make_engine):
    """Local e2e: senses read live BSC while the registry/heartbeats use REGISTRY_RPC_URL."""
    import chain
    senses = FakeRpc()
    # heartbeats stay off here so the epoch rollover below makes no network call
    eng = make_engine(senses, env={"REGISTRY_ADDRESS": "0x" + "22" * 20, "REGISTRY_RPC_URL": "http://127.0.0.1:8545",
                                   "EPOCH_S": "60"})
    assert isinstance(eng.reg_rpc, chain.Rpc) and eng.reg_rpc.urls == ["http://127.0.0.1:8545"]
    assert eng.registry.rpc is eng.reg_rpc and eng.heartbeat.rpc is eng.reg_rpc and eng.rpc is senses
    assert eng.status()["gating_overrides"]["EPOCH_S"] == 60
    w = 1_000_000                                            # 12 s windows: 5 per 60 s epoch
    assert [eng.process_window(w + k)["epoch"] for k in range(6)] == [(w + k) * 12 // 60 for k in range(6)]

    default = make_engine(FakeRpc())
    assert default.reg_rpc is default.rpc and default.cfg.epoch_s == 600
    assert "EPOCH_S" not in default.gating_overrides


class _FakeNode:
    """Local JSON-RPC stub: reports chain_id, rejects or accepts eth_sendRawTransaction."""

    def __init__(self, chain_id, reject_send):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        node = self
        self.seen = []

        class Hd(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                m = body["method"]
                node.seen.append(m)
                res = {"eth_chainId": hex(chain_id), "eth_getTransactionCount": "0x0",
                       "eth_gasPrice": hex(10**8), "eth_sendRawTransaction": "0x" + "ab" * 32}.get(m, "0x0")
                out = {"jsonrpc": "2.0", "id": body["id"], "result": res}
                if m == "eth_sendRawTransaction" and reject_send:
                    out = {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32000, "message": "rejected"}}
                b = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

        self.server = HTTPServer(("127.0.0.1", 0), Hd)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


def test_heartbeat_never_reaches_the_public_fallback(make_engine, monkeypatch):
    """REGISTRY_RPC_URL unset + a local BSC_RPC_URL: a rejected or wrong-chain heartbeat must not
    be re-broadcast to chain.DEFAULT_RPC (public mainnet)."""
    import pytest
    import chain
    local, mainnet = _FakeNode(31337, reject_send=True), _FakeNode(56, reject_send=False)
    monkeypatch.setattr(chain, "DEFAULT_RPC", mainnet.url)
    key = "0x" + "11" * 32                                   # throwaway test key, not a wallet
    env = {"REGISTRY_ADDRESS": "0x" + "22" * 20, "OPERATOR_PRIVATE_KEY": key, "HEARTBEAT": "1",
           "BSC_RPC_URL": local.url}
    eng = make_engine(chain.Rpc([local.url, mainnet.url]), env=env)   # senses rpc keeps a fallback
    assert eng.heartbeat.enabled and eng.heartbeat.rpc.urls == [local.url]
    with pytest.raises(RuntimeError, match="chain id"):                # CHAIN_ID defaults to 56
        eng.heartbeat.send(7, b"\x01" * 32, b"\x02" * 32, b"\x03" * 32)
    assert "eth_sendRawTransaction" not in local.seen

    eng = make_engine(FakeRpc(), env={**env, "CHAIN_ID": "31337"})
    with pytest.raises(chain.RpcError):
        eng.heartbeat.send(7, b"\x01" * 32, b"\x02" * 32, b"\x03" * 32)
    assert local.seen.count("eth_sendRawTransaction") == 1
    # even a multi-endpoint Rpc never fails a signed tx over to the next endpoint
    with pytest.raises(chain.RpcError):
        chain.Rpc([local.url, mainnet.url]).call("eth_sendRawTransaction", ["0x00"])
    assert mainnet.seen == []

    no_url = make_engine(FakeRpc(), env={k: v for k, v in env.items() if k != "BSC_RPC_URL"})
    assert no_url.heartbeat.enabled is False and no_url.heartbeat._key is None


def test_heartbeat_refuses_non_600s_epochs(make_engine):
    env = {"REGISTRY_ADDRESS": "0x" + "22" * 20, "OPERATOR_PRIVATE_KEY": "0x" + "11" * 32, "HEARTBEAT": "1",
           "REGISTRY_RPC_URL": "http://127.0.0.1:9", "EPOCH_S": "60"}
    eng = make_engine(FakeRpc(), env=env)
    assert eng.heartbeat.enabled is False and "EPOCH_S" in eng.heartbeat.off_reason
    assert make_engine(FakeRpc(), env={**env, "EPOCH_S": "600"}).heartbeat.enabled is True
