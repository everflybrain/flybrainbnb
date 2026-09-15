"""
The 11 chain inputs (8 channels) and the neuron group each one drives.

Ids and order are fixed: they are hashed into channels.json, whose hash is part of
neuronTableHash on-chain. Every group is resolved from the connectome's own
annotations (graph.npz) or from backrooms_dictionary.py, never from guesses.

Honesty notes (disclosed in channels.json as `mapping`):
  - graph.npz carries no sugar, bitter or water receptor labels. The two DEX
    channels drive the annotated subclasses "taste peg" and "labellar bristle";
    the site must call them that, never "sugar neurons" or "bitter neurons".
  - Which chain signal goes to which sense is a CHOSEN mapping for display, not
    biology: no fly ever sensed a blockchain.
"""
import numpy as np

import backrooms_dictionary as bd

# signal: what the raw value x is. group: plain name of the neuron group.
INPUTS = [
    dict(id="traffic", channel="traffic", label="chain traffic",
         signal="transactions in all blocks of the window",
         group="lamina monopolar cells L2 (visual relay directly below photoreceptors R1-R6)",
         selector={"type_re": "^L2$"}, source="annotation type",
         note="photoreceptors are histaminergic, which this model treats as inhibitory, so "
              "driving them from rest lights nothing downstream (measured); L2 is cholinergic"),
    dict(id="crowd", channel="crowd", label="active senders",
         signal="fees paid (BNB) by senders in 3 sampled blocks, each sender capped at "
                "max(2% of the rolling median, 0.0001 BNB), scaled by blocks/3; fee-weighted, "
                "so splitting activity across many cheap wallets adds nothing beyond the fees paid",
         group="Johnston's organ subgroup A (sound-sensitive)",
         selector={"dictionary": "JO_A"}, source="backrooms_dictionary JO_A"),
    dict(id="heat", channel="heat", label="gas",
         signal="median effective gas price (gwei) in sampled blocks",
         group="thermosensory neurons (TRN)", selector={"type_re": "^TRN_"},
         source="annotation type"),
    dict(id="usdt", channel="usdt", label="USDT flow",
         signal="USD moved by USDT Transfers >= 1 USD, per-sender capped",
         group="olfactory receptor neurons, dorsal glomeruli (except DA1)",
         selector={"type_re": "^ORN_D(?!A1$)"}, source="annotation type"),
    dict(id="usdc", channel="usdc", label="USDC flow",
         signal="USD moved by USDC Transfers >= 1 USD, per-sender capped",
         group="olfactory receptor neurons, ventral glomeruli",
         selector={"type_re": "^ORN_V.+"}, source="annotation type"),
    dict(id="whale", channel="whale", label="large transfers",
         signal="USDT/USDC Transfers >= 100,000 USD, at most 1 per sender (value-gated)",
         group="Johnston's organ wind/gravity neurons",
         selector={"subclass": "wind_gravity"}, source="annotation subclass"),
    dict(id="dex.buy", channel="dex", label="WBNB bought on PancakeSwap",
         signal="USD paid into USDT/WBNB pools for WBNB, per-tx capped",
         group="taste peg neurons (annotated subclass; tastant not labelled)",
         selector={"subclass": "taste peg"}, source="annotation subclass"),
    dict(id="dex.sell", channel="dex", label="WBNB sold on PancakeSwap",
         signal="USD taken out of USDT/WBNB pools for WBNB, per-tx capped",
         group="labellar bristle neurons (annotated subclass; mechanosensory)",
         selector={"subclass": "labellar bristle"}, source="annotation subclass"),
    dict(id="token.buy", channel="token", label="$TOKEN bought",
         signal="tokens moved from a pool to a non-pool, per-recipient capped",
         group="pharyngeal sensillum neurons (annotated subclass; tastant not labelled)",
         selector={"subclass": "pharyngeal sensillum"}, source="annotation subclass",
         note="putative_ppk25 neurons were the first choice but 244 of 257 have transmitter "
              "'unclear' (zero weight in this model) and light nothing downstream (measured)"),
    dict(id="token.sell", channel="token", label="$TOKEN sold",
         signal="tokens moved from a non-pool to a pool, per-sender capped",
         group="putative ppk23 receptor neurons (annotated receptorType)",
         selector={"receptor": "^putative_ppk23$"}, source="annotation receptorType"),
    dict(id="token.burn", channel="token", label="$TOKEN burned",
         signal="tokens Transferred to 0x...dEaD (includes registry claims), per-sender capped",
         group="cVA pheromone receptor neurons (ORN_DA1)",
         selector={"dictionary": "ORN_DA1"}, source="backrooms_dictionary ORN_DA1"),
]
IDS = [i["id"] for i in INPUTS]
TOKEN_IDS = ("token.buy", "token.sell", "token.burn")

MAPPING_NOTE = (
    "CHOSEN mapping: which chain signal drives which sensory group is a display choice, "
    "not biology. graph.npz has no sugar/bitter/water receptor labels; the DEX inputs drive "
    "the annotated subclasses 'taste peg' and 'labellar bristle' and must be called that.")


def resolve_one(fb, sel):
    if "dictionary" in sel:
        return bd.groups(fb, [sel["dictionary"]])[sel["dictionary"]]
    return fb.where(**sel)


def resolve(fb):
    """[(input, sorted int64 ids)] in INPUTS order, disjoint: a neuron already taken by
    an earlier input is dropped from later ones (first in channel order wins)."""
    taken = np.zeros(fb.n, dtype=bool)
    out = []
    for inp in INPUTS:
        ids = np.unique(resolve_one(fb, inp["selector"])).astype(np.int64)
        ids = ids[~taken[ids]]
        taken[ids] = True
        out.append((inp, ids))
    return out
