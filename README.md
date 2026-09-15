# flybrainbnb

Real fly wiring, simplified neurons.

A simulated fruit fly brain built from the male fly central nervous system connectome
(Janelia/Google MaleCNS v1.0: 165,122 neurons, about 10.2 million connections). The brain
runs off-chain, on CPU. BNB Smart Chain is its senses, its heartbeat and its memory:

- **Senses.** Live BNB Smart Chain activity (block traffic, active senders, gas, USDT and
  USDC flow, large transfers, WBNB swaps on PancakeSwap, and later the project token's buys,
  sells and burns) drives named sensory neuron groups. A live heatmap on the website shows
  which neurons fire.
- **Heartbeat.** Every 10 minutes the brain's pulse (a hash of its state, a Merkle root of
  which neurons fired and a hash of the inputs) can be written to BNB Chain.
- **Memory.** The connectome fingerprint and the neuron table are written on-chain when the
  registry is deployed. Holders burn tokens to own neurons: the burn stores their wallet, a
  name (up to 32 bytes) and a note (up to 140 bytes) on-chain forever. No NFTs.

What it is not: it does not run on-chain, it is not conscious, and it is not an uploaded
fly. Neurons are leaky integrate-and-fire units on real wiring. This is an independent
project, not affiliated with or endorsed by Binance, BNB Chain or anyone associated with
them.

## Status

- Brain service: live on Railway (https://brain-production-2ead.up.railway.app/status),
  reading BNB Smart Chain mainnet. Heartbeats on, every 10 minutes from the operator wallet.
- Website: live on Vercel (https://flybrainbnb.vercel.app).
- Registry contract: **deployed** on BNB Smart Chain at
  [`0xe11a73Cea3feC43b300128B92b5E9efA8577afE6`](https://bscscan.com/address/0xe11a73Cea3feC43b300128B92b5E9efA8577afE6)
  (tx [`0x820a970b…3b3001`](https://bscscan.com/tx/0x820a970b70556acf5669f1cae923b832fdbec21de52cb366ce72f7efb03b3001), block 121994444).
  Deployment record: `contracts/deployments/56.json`.
- Token: **not launched.** The contract address (CA) is set later, once, with
  `scripts/set-token.js`. Until then the site shows the token as not live.

## Components

| path | what |
|---|---|
| `contracts/` | `FlyBrainRegistry.sol` (Hardhat): burn-to-claim neurons, heartbeats, one-time `setToken`. Neurons are handed out from a fixed shuffled order derived from the connectome hash; flat price per neuron; at most 5,000 per claim. |
| `brain/` | Python service (FastAPI + SSE): CPU LIF simulation (`flysim.py`), BSC reader and channel gating (`chain.py`), registry reader and heartbeat sender (`registry.py`), hashes and Merkle proofs (`hashes.py`), the 12 s window loop (`engine.py`). Runtime assets in `brain/assets/`. See `brain/README.md`. |
| `site/` | Static site (no build): WebGL heatmap of all neurons, owners wall, burn panel, proof panel. `config.js` holds the brain API URL and registry address. |
| `DESIGN.md` | Full design: channels, calibration procedure, contract interface, hash definitions, API. |

### Channels

Each chain signal drives one named sensory group (the mapping is a choice, disclosed, not
biology): chain traffic -> lamina L2 visual relay cells; active senders -> Johnston's organ
A; gas -> thermosensory neurons; USDT and USDC flow -> olfactory receptor neurons (dorsal
and ventral glomeruli); large transfers -> Johnston's organ wind/gravity neurons; WBNB
bought/sold -> taste peg and labellar bristle neurons; token buy/sell/burn -> pharyngeal
sensillum, ppk23 and DA1 (cVA) neurons. The three token inputs stay off until
`TOKEN_ADDRESS` is set.

### Calibration

The stock simulation runs away: driving almost any single sensory group lights up about
45,000 neurons that keep firing after the drive stops. One global synaptic scale
(`GAIN = 0.15`) plus a per-input maximum rate keeps a single input under about 4 Hz mean and
lets activity die out within 50 ms of the drive stopping. Details in `brain/README.md`.

## Tests

```
cd contracts && npm ci && npx hardhat test        # 24 contract tests, in-memory chain
cd brain && py -m pip install -r requirements-dev.txt && py -m pytest -q tests
```

The brain tests build a small synthetic graph, so they do not need the connectome data.

## Running locally

```
cd contracts && npx hardhat node
npx hardhat run scripts/deploy.js --network localhost
TOKEN=mock PRICE=1000 npx hardhat run scripts/set-token.js --network localhost
npx hardhat run scripts/local-claims.js --network localhost
cd ../brain && BRAIN_AUTOSTART=1 DATA_DIR=./data/runtime py -m uvicorn server:app --port 8000
```

Scripts refuse chain 56 (BSC mainnet) unless `CONFIRM_MAINNET=yes` is set.

## Owner runbook: going live on-chain

Keys live only in `.env` at the repo root (`DEPLOYER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`,
`BSC_RPC_URL`, `TOKEN_ADDRESS`). Never commit it. The deployer key never goes to Railway.

1. **Deploy the registry** (owner wallet):
   `cd contracts && CONFIRM_MAINNET=yes npx hardhat run scripts/deploy.js --network bsc`.
   This writes `deployments/56.json` with the address, connectome hash and neuron table hash.
2. **Point the brain and site at it:** set `REGISTRY_ADDRESS` on Railway (and `HEARTBEAT=1`
   to start the 10-minute pulse from the operator wallet), and `REGISTRY_ADDRESS` in
   `site/config.js`, then redeploy both.
3. **Set the CA once the coin exists.** First simulate a claim with the real token on a local
   BSC fork: fee-on-transfer tokens make every claim revert, and `setToken` can never be
   undone. Then put the address in `.env` as `TOKEN_ADDRESS` and run
   `CONFIRM_MAINNET=yes PRICE=<tokens per neuron> npx hardhat run scripts/set-token.js --network bsc`.
   Set `TOKEN_ADDRESS` (and optionally `TOKEN_POOLS`) on Railway so the token inputs turn on.
   The site reads token and price from the registry, so it needs no change.

## Credits and licences

- Our code (contracts, brain service, site): MIT, see `LICENSE`.
- Connectome: MaleCNS v1.0, Janelia Research Campus FlyEM and Google, released under
  CC BY 4.0 (https://www.janelia.org/project-team/flyem). Data files are not in this repo;
  the brain image is built from `graph.npz` derived from that release, and derived assets in
  `brain/assets/` carry the same CC BY 4.0 attribution.
- Named neuron groups in `brain/backrooms_dictionary.py` cite their sources inline.
