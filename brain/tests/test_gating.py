import numpy as np
import pytest

import chain
from conftest import addr_topic, word

G = dict(chain.GATING)


def test_median_mad_and_floor():
    med, mad = chain.median_mad([1, 2, 3, 4, 100], "usdt")
    assert med == 3 and mad == pytest.approx(1.4826 * 1)
    med, mad = chain.median_mad([5, 5, 5], "usdt")          # zero MAD -> relative floor
    assert mad == pytest.approx(1e-9 * 5)
    assert chain.median_mad([0.05] * 40, "heat")[1] == 0.01  # heat floor in gwei


def test_warmup_blocks_drive_then_gate_opens_at_z_gate():
    buf = [10.0] * (G["WARM"] - 1) + [12.0]
    z, rate, warm = chain.gate(1e6, buf[:-1], "usdt", 80.0, G)
    assert warm and rate == 0.0 and z > 0
    buf = list(np.tile([9.0, 10.0, 11.0], 20))              # med 10, MAD 1.4826
    mad = 1.4826
    z, rate, warm = chain.gate(10 + 1.9 * mad, buf, "usdt", 80.0, G)
    assert not warm and z == pytest.approx(1.9) and rate == 0.0       # below Z_GATE 2.0
    z, rate, _ = chain.gate(10 + 3.0 * mad, buf, "usdt", 80.0, G)
    assert rate == pytest.approx(G["R_MIN"] + G["K"] * (3.0 - G["Z_GATE"]))
    _, rate, _ = chain.gate(10 + 1e3 * mad, buf, "usdt", 25.0, G)
    assert rate == 25.0                                      # per-input max_hz


def test_gates_step_appends_after_scoring_and_inactive_inputs_stay_zero():
    g = chain.Gates(["usdt", "token.buy"], {"usdt": 80, "token.buy": 80})
    for _ in range(40):
        g.step({"usdt": 5.0}, {"usdt": True, "token.buy": False})
    out = g.step({"usdt": 5.0, "token.buy": 1e9}, {"usdt": True, "token.buy": False})
    assert out["token.buy"] == dict(raw=0.0, z=0.0, rate_hz=0.0, warm=True, active=False)
    assert len(g.bufs["usdt"]) == 41 and len(g.bufs["token.buy"]) == 0
    assert Z_GATE_DEFAULT_IS_TWO()


def Z_GATE_DEFAULT_IS_TWO():
    return chain.GATING["Z_GATE"] == 2.0


def test_cap_sum():
    assert chain.cap_sum({"a": 5, "b": 50, "c": 500}, 40) == (5 + 40 + 40, 2)


def _transfer(token, frm, to, usd, tx="0x1"):
    return dict(address=token, topics=[chain.T_TRANSFER, addr_topic(frm), addr_topic(to)],
                data="0x" + word(int(usd * 10**18)), transactionHash=tx)


def test_extract_flows_whales_swaps_and_caps():
    gates = chain.Gates(chain.I.IDS, {})
    a, b = "0x" + "aa" * 20, "0x" + "bb" * 20
    logs = [
        _transfer(chain.USDT, a, b, 400_000),          # whale, capped at floor 10k
        _transfer(chain.USDT, a, b, 200_000),          # same sender: still one whale
        _transfer(chain.USDT, b, a, 500),
        _transfer(chain.USDT, b, a, 0.5),              # dust ignored
        _transfer(chain.USDC, b, a, 3_000),
        _transfer("0x" + "05" * 20, a, b, 9e9),        # look-alike token: ignored
        dict(address=chain.V2_PAIR, topics=[chain.T_SWAP_V2, addr_topic(a), addr_topic(b)],
             data="0x" + word(700 * 10**18) + word(0) + word(0) + word(1), transactionHash="0xs1"),
        dict(address=chain.V2_PAIR, topics=[chain.T_SWAP_V2, addr_topic(a), addr_topic(b)],
             data="0x" + word(0) + word(1) + word(800 * 10**18) + word(0), transactionHash="0xs2"),
        dict(address=chain.V3_POOLS[0], topics=[chain.T_SWAP_V3, addr_topic(a), addr_topic(b)],
             data="0x" + word(-9_000 * 10**18) + word(3) + word(0) * 5, transactionHash="0xs3"),
    ]
    raw, capped = chain.extract([{"transactions": [1, 2]}] * 3, {}, logs, gates)
    assert raw["usdt"] == pytest.approx(10_000 + 500) and capped["usdt"] == 1
    assert raw["usdc"] == pytest.approx(3_000)
    assert raw["whale"] == 1.0
    assert raw["dex.buy"] == pytest.approx(700)
    assert raw["dex.sell"] == pytest.approx(800 + 5_000) and capped["dex.sell"] == 1
    assert raw["traffic"] == 6


def test_crowd_is_fee_weighted_so_sybil_wallets_do_not_count():
    gates = chain.Gates(chain.I.IDS, {})
    gwei = 10**9
    headers = [{"transactions": []}] * 3
    # 50 fresh wallets each paying a 21k-gas transfer at 0.05 gwei ...
    sybil = [dict(**{"from": "0x%040x" % i}, effectiveGasPrice=hex(gwei // 20), gasUsed=hex(21000))
             for i in range(50)]
    # ... move the channel exactly as much as ONE wallet paying the same total fee:
    # splitting can at most recover the fees actually paid, never add per-wallet weight
    one = [dict(**{"from": "0x" + "ee" * 20}, effectiveGasPrice=hex(gwei // 20), gasUsed=hex(21000 * 50))]
    raw_sybil, _ = chain.extract(headers, {1: sybil}, [], gates)
    raw_one, _ = chain.extract(headers, {1: one}, [], gates)
    assert raw_sybil["crowd"] == pytest.approx(50 * 21000 * 0.05e-9 * 3)
    assert raw_sybil["crowd"] == pytest.approx(raw_one["crowd"])
    # a big payer is capped (floor 1e-4 BNB while the buffer is empty); system tx (price 0) ignored
    real = [dict(**{"from": "0x" + "cc" * 20}, effectiveGasPrice=hex(gwei), gasUsed=hex(300_000)),
            dict(**{"from": "0x" + "dd" * 20}, effectiveGasPrice="0x0", gasUsed=hex(10**6))]
    raw_real, capped = chain.extract(headers, {1: real}, [], gates)
    assert raw_real["crowd"] == pytest.approx(1e-4 * 3) and capped["crowd"] == 1
    assert raw_real["heat"] == pytest.approx(1.0)


def test_token_buy_sell_burn_classification():
    gates = chain.Gates(chain.I.IDS, {})
    tok, pool, u = "0x" + "70" * 20, "0x" + "90" * 20, "0x" + "11" * 20
    token = dict(address=tok, pools={pool}, decimals=18, supply=1e9)
    logs = [_transfer(tok, pool, u, 100), _transfer(tok, u, pool, 40), _transfer(tok, u, chain.DEAD, 7)]
    raw, _ = chain.extract([{"transactions": []}], {}, logs, gates, token)
    assert (raw["token.buy"], raw["token.sell"], raw["token.burn"]) == (100, 40, 7)
