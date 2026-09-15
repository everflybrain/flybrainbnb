# flybrainbnb brain service

Real fly wiring, simplified neurons. The male fly CNS connectome (MaleCNS v1.0, 165,122
neurons) simulated off-chain on CPU; live BNB Smart Chain activity drives named sensory
groups, every 10 minutes a pulse (state hash, spike Merkle root, input hash) can be written
to the registry. Interfaces: `../DESIGN.md` sections 3, 5, 6.

## Files

| file | what |
|---|---|
| `flysim.py` | LIF simulator (copied, MIT); adds `count_all` and optional `Params.tau_syn` (unused, see calibration) |
| `inputs.py` | the 11 inputs and the neuron group each drives (CHOSEN mapping, disclosed) |
| `calibrate.py` | GAIN sweep + per-input max rate + Jaccard distinctness check |
| `make_assets.py` | writes `assets/` (neurons.bin, channels.json, deploy_params.json, calibration.json) |
| `hashes.py` | every hash in DESIGN 5, Merkle proofs |
| `chain.py` | JSON-RPC (rotation + backoff), block cursor, channel extraction, caps, median/MAD gating |
| `registry.py` | registry reader (claims, token, price) and heartbeat sender (off by default) |
| `engine.py` | the 12 s window loop, persistence, epochs |
| `server.py` | FastAPI + SSE |
| `build_graph.py`, `backrooms_dictionary.py`, `olfaction.py` | copied; graph builder and named groups |

## Data (not in git, uploaded to Railway)

`data/` is gitignored. `.railwayignore` re-includes it so `railway up` (run from `brain/`)
uploads `data/graph.npz`; if a CLI version ignores that, use `railway up --no-gitignore`.
The Dockerfile copies only `data/graph.npz` (38,302,151 B, sha256 prefix c71b62a6c6eba4f8).

Rebuild from the public CC BY 4.0 release (no account):

```
https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/
  body-annotations-male-cns-v1.0-minconf-0.5.feather      14 MB
  body-neurotransmitters-male-cns-v1.0.feather            42 MB
  connectome-weights-male-cns-v1.0-minconf-0.5.feather   1.1 GB
```

Save them in `data/` under the names `build_graph.py` reads (`body-annotations.feather`,
`body-neurotransmitters.feather`, `connectome-weights.feather`), then:

```
py -m pip install -r requirements-dev.txt
py build_graph.py                                            # -> data/graph.npz
py calibrate.py --fit-max --gains 0.12,0.15,0.18 --out data/calib_fit.json
py make_assets.py                                            # -> assets/ (commit these)
py -m pytest -q tests
```

`make_assets.py` needs `data/body-annotations.feather` for positions and sides.

## Run

```
BRAIN_AUTOSTART=1 DATA_DIR=./data/runtime py -m uvicorn server:app --port 8000
```

Env: `BSC_RPC_URL` (default https://bsc-rpc.publicnode.com), `RPC_FALLBACKS`, `CORS_ORIGINS`
(comma list of site origins; empty = no cross-origin access), `REGISTRY_ADDRESS`,
`TOKEN_ADDRESS`, `TOKEN_POOLS`, `OPERATOR_PRIVATE_KEY`, `HEARTBEAT` (1 to send), `CHAIN_ID`
(56), `REGISTRY_RPC_URL` (registry reads and heartbeats; default = the senses RPC), `BIO_MS` (100), `GAIN` (override; default from channels.json), `DATA_DIR` (/data in
Docker), `PORT`, `FINALITY_DELAY_MS` (2500). `GATE_WARM` and `EPOCH_S` (default 600) are for local testing only.

Heartbeats are sent only when `REGISTRY_ADDRESS`, `OPERATOR_PRIVATE_KEY` and `HEARTBEAT=1`
are all set. Set Railway variables with PowerShell (Git Bash rewrites `/data`).

## Calibration (2026-09-15, this PC)

Stock synapses ignite: a single sensory group lights ~45k neurons that keep firing after
the drive stops. With one global synaptic scale **GAIN = 0.15** and a per-input max rate
(10-80 Hz, chosen so each input alone keeps the brain mean under ~4 Hz), all three DESIGN
3.2 criteria hold: single input at max <= 4.19 Hz mean, 0.0 Hz 40-50 ms after all drive
stops, every input lights >= 1,441 neurons beyond its own group. No uniform max rate
satisfied (a) and (c) at any GAIN.

Distinctness (Jaccard of downstream active sets, input alone at its max): visual L2 vs
Johnston's organ A 0.003, L2 vs taste pegs 0.003, JO-A vs taste pegs 0.23, JO-A vs
wind/gravity 0.26. The olfactory inputs (USDT, USDC, token burn) and thermosensory (gas)
share one ~9k-neuron population (pairwise 0.75-0.78). A 5 ms synaptic current (Shiu et al.
2024) was tried: overlap was the same (0.72-0.74) and activity persisted after the drive
stopped at every GAIN, so the stock instantaneous synapse is kept.

Group changes from DESIGN 3.4, both measured: photoreceptors R1-R6 are histaminergic
(inhibitory in this model) and light nothing, so `traffic` drives lamina L2; putative ppk25
neurons are 95% transmitter "unclear" (zero weight), so `token.buy` drives pharyngeal
sensillum neurons. There are no sugar/bitter/water receptor labels in graph.npz.

Credits: Male CNS connectome v1.0, Janelia FlyEM and Google, CC BY 4.0; neuron model after
Shiu et al. 2024 (Nature). Code MIT.
