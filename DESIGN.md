# flybrainbnb: design (interfaces)

Three builders work from this file in parallel: **brain** (`brain/`, Python, Railway),
**contract** (`contracts/`, Hardhat), **site** (`site/`, static, Vercel). Anything not fixed
here is the builder's call. Measured numbers are dated 2026-09-15 on the owner's PC.

HARD LIMITS for every builder: no mainnet transactions (no deploy, heartbeat, approve,
transfer). Mainnet RPC reads are fine. Contract and heartbeat tests run on a local Hardhat
node (chain 31337). Never print, log or commit anything from `.env` except
`DEPLOYER_ADDRESS` and `OPERATOR_ADDRESS`. `DEPLOYER_PRIVATE_KEY` never goes to Railway.

## 0. Lore and honesty (site copy and README)

The brain is the male fly central nervous system wiring (MaleCNS v1.0, 165,122 neurons),
simulated off-chain with simplified neurons. BNB Chain is its senses, its heartbeat and its
memory:
- senses: live BNB Smart Chain activity makes named sensory neurons fire;
- heartbeat: every 10 minutes its pulse (a hash of its state, which neurons fired and what
  it sensed) is written to BNB Chain;
- memory: the connectome fingerprint is on-chain from launch, and every name burned into
  it stays forever.

Never say it runs on-chain, is conscious, is alive, or is an uploaded fly. Use "real fly
wiring, simplified neurons". Never imply endorsement by Binance, BNB Chain or CZ. No NFTs.
Credits: Male CNS connectome v1.0 (MaleCNS), Janelia Research Campus FlyEM and Google,
CC BY 4.0; neuron model after Shiu et al. 2024 (Nature). Our code MIT.

## 1. Layout

```
brain/                 Python 3.12, deps: numpy scipy pyarrow pandas (build only) eth-account (heartbeat)
  flysim.py            copied (MIT, fruitflydev). Builder adds per-neuron spike COUNTS (see 3.3)
  build_graph.py       copied, reference only (needs the 1 GB weights file, not copied)
  backrooms_dictionary.py, olfaction.py   copied; dictionary used for group names
  build/graph.npz      copied, 38,302,151 B, sha256 prefix c71b62a6c6eba4f8 (gitignored)
  build/backrooms_dictionary.json  copied
  data/body-annotations.feather    copied, 14.5 MB (gitignored)
  make_assets.py       NEW: writes assets/ (neurons.bin, channels.json, deploy_params.json)
  hashes.py            NEW: every hash in section 5, pure stdlib + numpy
  chain.py             NEW: JSON-RPC reader, channel extraction, gating
  server.py            NEW: sim loop + HTTP/SSE + registry reader + heartbeat
  assets/              COMMITTED runtime assets (graph.npz copied here for Railway, CC BY
                       redistribution with NOTICE; 38 MB is under GitHub's 100 MB limit)
  Dockerfile           python:3.12-slim, runtime deps numpy scipy eth-account only
contracts/             Hardhat, Solidity 0.8.24, optimizer 200 runs, evmVersion shanghai
  contracts/FlyBrainRegistry.sol, contracts/test/MockERC20.sol
  test/registry.test.js, scripts/deploy.js (reads brain/assets/deploy_params.json)
site/                  static: index.html config.js app.js heatmap.js burn.js abi.js style.css
```

Note `.gitignore` ignores `artifacts/`, `build/`, `data/`: that is why runtime assets live in
`brain/assets/`.

## 2. Data (measured)

- `graph.npz` (from `build_graph.py`): CSR `data` float32 (mV per presynaptic spike, signed,
  0.275 mV per synapse, pairs with >= 3 synapses), `indices`, `indptr`, `shape`, `bodies`
  (sorted bodyIds), `sign`, `types`, `superclass`, `subclass`, `receptor`, `fru`, `nt`.
  **N = 165,122** traced neurons, 10,228,000 nonzero edges. Neuron id = row index in this
  file = the id used on-chain.
- Annotation columns (`body-annotations.feather`, 211,577 bodies, 36 cols): type
  (`type`, fallback `flywireType`, `instance`), class (`superclass`, `class`, `subclass`),
  side (`somaSide` R/L/M for 149,042; `rootSide` for 15,903), `receptorType`, `fruDsx`,
  `synonyms`, `somaLocation` (voxel xyz), `entryNerve`, `exitNerve`.
- Positions: `somaLocation` exists locally for **140,024** neurons (voxel coords, bbox
  x 2468..93668, y 4758..68996, z 10154..134531). **25,098** have none: 8,338 ol_intrinsic
  and almost all sensory neurons (vnc_sensory 6,363, cb_sensory 4,868, ol_sensory 4,086,
  sensory_ascending 537), whose cell bodies sit outside the CNS. No download needed.
  Stand-in for those 25,098, in order, flagged `imputed`, labelled on the site
  "layout, not anatomy":
  1. weighted mean of the soma positions of the neuron's postsynaptic targets
     (column j of W, weight |w|, only targets with a real soma), plus 1% bbox jitter;
  2. else centroid of real somas of the same type and side;
  3. else centroid of its superclass, plus 3% bbox jitter.
  Jitter uses `numpy.random.default_rng(0)` so the file is reproducible.
  (Real synapse-level positions would need the MaleCNS synapse tables from
  storage.googleapis.com/flyem-male-cns, multi-GB: not downloaded, not needed.)

## 3. Brain

### 3.1 Timing (measured, numpy single thread, 12-thread PC)

| run | wall |
|---|---|
| load graph.npz | 0.6 s |
| 20 steps (4 ms bio), stock weights, heavy drive | 0.15 s |
| 500 steps (100 ms bio), stock weights, ignited (~55 Hz mean) | 2.0-2.6 s |
| 500 steps, global gain 0.25, four groups driven | 0.85 s |
| 500 steps, R1-R6 at 10 Hz only (no ignition) | 0.23 s |

Choice: **chain window W = 12 s**; **100 ms of brain time (500 steps at dt 0.2 ms) per
window**. Worst case locally 2.6 s, so a Railway vCPU 2-3x slower still finishes in under
8 s. Guard: env `BIO_MS` (default 100); if sim wall time > 0.6 W for 3 windows in a row,
drop to 50 ms; go back to 100 ms after 20 windows under 0.3 W. `bio_ms` is in every frame.

### 3.2 Ignition: must calibrate (measured)

The stock Shiu model ignites on this connectome: 40 Hz on the 25 TRN cells, or 40 Hz on
the 60 taste-peg cells, or 20 Hz on wind_gravity or dorsal ORNs, each alone from rest
lights 44-47k neurons at ~50 Hz mean and **keeps firing at ~45-56 Hz after the drive
stops**. A heatmap would be saturated and chain input would not matter. Fix: one global
efficacy scale `GAIN` passed as `gains = full(n_types, GAIN)`.
Measured with four groups driven together for 100 ms then 50 ms of silence:
GAIN 0.25 -> 14.7 Hz mean while driven, 1.0 Hz after; 0.40 -> 29.5 / 3.4 Hz;
0.55 -> 35.5 / 0.16 Hz. Builder runs a short sweep (GAIN 0.10..0.30, each channel alone at
`max_hz`) and picks the largest GAIN where (a) any single channel at max leaves mean rate
< 5 Hz, (b) 50 ms after all drive stops mean rate < 0.5 Hz, (c) each channel alone lights
> 500 neurons. Starting value 0.2. Record the chosen GAIN and the sweep in
`assets/channels.json` and `/status`. Say "global synaptic scale" on the site, not "trained".

### 3.3 Sim loop

- One `FlyBrain`, state carried across windows via `run(..., state=prev["_state"])`
  (continuous brain). Add `count_all=True` to `run()` returning `_counts` (uint16 per
  neuron, `counts[fired] += 1` each step; fired indices are unique per step).
- Window index `w = floor(unix_ms / 12000)`. At each window end: collect channel values for
  blocks whose `milliTimestamp` falls in the window (lag 3 blocks), compute rates (3.4),
  run the sim for `bio_ms`, publish the frame.
- No history replay: on first boot start at the current block. Persist on the Railway
  volume `/data`: `state.npz` (v, refr, rng state JSON) and `stats.json` (gating buffers)
  after every window; on restart resume them but do not backfill missed windows.
- Python threads: RPC fetcher, sim worker, HTTP server (`ThreadingHTTPServer`).

### 3.4 Channels

RPC: `BSC_RPC_URL` if set, else `https://bsc-rpc.publicnode.com` (measured: eth_getLogs over
31 blocks works, 0.4-0.7 s; `bsc-dataseed*.bnbchain.org` and `defibit` reject eth_getLogs
with "limit exceeded"; `bsc.drpc.org` 429; `1rpc.io/bnb` works but slow). `RPC_FALLBACKS`
comma list tried in order. BSC now makes a block every **~0.45 s** (measured over 200 blocks)
so a window holds ~27 blocks; blocks carry `milliTimestamp`. `eth_getBlockReceipts` works.

Per window, at most: 1 `eth_blockNumber`; 1 JSON-RPC batch of `eth_getBlockByNumber(n,false)`
for all blocks (fallback: sequential every 3rd block, scaled x3); 3 `eth_getBlockByNumber(n,true)`
evenly spaced (sample); 1 `eth_getLogs` with `address` = [USDT, USDC, V2 pair, V3 pools,
TOKEN + its pools, REGISTRY] and `topics[0]` = [Transfer, SwapV2, SwapV3, Claimed].

Addresses (verified by mainnet reads 2026-09-15):

| name | address | notes |
|---|---|---|
| USDT (BSC-USD) | 0x55d398326f99059fF775485246999027B3197955 | 18 decimals |
| USDC | 0x8AC76a51cc950d9822d68b83fE1Ad97B32Cd580d | symbol USDC, 18 decimals, ~108 transfers per 6 blocks |
| WBNB | 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c | 18 decimals |
| PancakeSwap V2 factory | 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 | |
| V2 USDT/WBNB pair | 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE | token0 USDT, token1 WBNB |
| PancakeSwap V3 factory | 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865 | |
| V3 USDT/WBNB 0.01% | 0x172fcD41E0913e95784454622d1c3724f546f849 | token0 USDT; busiest (30 swaps / 6 blocks) |
| V3 USDT/WBNB 0.05% | 0x36696169C63e42cd08ce11f5deebbCeBae652050 | token0 USDT |
| burn sink | 0x000000000000000000000000000000000000dEaD | |

Beware look-alike tokens (a "USDT"-symbol spoof at 0x05ac39...6483 had 452 transfers in 6
blocks): match addresses exactly, never symbols.

Topics:
- Transfer `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- Pancake V2 Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)
  `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822` (seen on the pair)
- Pancake V3 Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)
  `0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83` (seen on the 0.01% pool)
- Claimed / Heartbeat: keccak of the signatures in section 4 (builder computes with eth-account's keccak).

Channels (ids fixed; 8 channels, 11 inputs). Every group is resolved at build time from
annotations (`FlyBrain.where`) or `backrooms_dictionary.groups(fb)`; counts measured:

| id | channel | raw value x per window | cap key, cap | neuron group (selector) | cells |
|---|---|---|---|---|---|
| traffic | chain traffic | tx count over all blocks | none (block totals) | photoreceptors, `type_re ^R1-R6$` | 1,394 |
| crowd | active senders | unique `from` in 3 sampled blocks x blocks/3 | 1 per address | dictionary `JO_A` (sound-sensitive Johnston's organ, subgroup A) | 50 |
| heat | gas | median effective gasPrice (gwei) in sampled blocks; MAD floor 0.01 gwei | per tx | thermosensory `type_re ^TRN_` | 25 |
| usdt | USDT flow | sum USDT Transfer value (USD), ignore < 1 USD | Transfer `from` | dorsal-glomerulus ORNs `type_re ^ORN_D(?!A1$)` | 999 |
| usdc | USDC flow | same for USDC | Transfer `from` | ventral-glomerulus ORNs `type_re ^ORN_V.+` | 1,377 |
| whale | large transfers | count of USDT/USDC Transfers >= 100,000 USD | 1 per `from` | wind/gravity JO, `subclass wind_gravity` | 475 |
| dex.buy | WBNB bought on Pancake | USD in: V2 `amount0In` where `amount1Out>0`; V3 `amount0 > 0` | tx hash | taste pegs, `subclass "taste peg"` | 60 |
| dex.sell | WBNB sold on Pancake | USD out: V2 `amount0Out` where `amount1In>0`; V3 `-amount0` where `amount0<0` | tx hash | labellar bristles, `subclass "labellar bristle"` | 163 |
| token.buy | $TOKEN bought | tokens moved from a pool to a non-pool | Transfer `to` | `receptor ^putative_ppk25$` | 257 |
| token.sell | $TOKEN sold | tokens moved from a non-pool to a pool | Transfer `from` | `receptor ^putative_ppk23$` | 269 |
| token.burn | $TOKEN burned | tokens Transferred to 0x...dEaD (includes registry claims) | Transfer `from` | dictionary `ORN_DA1` (cVA pheromone receptor neurons) | 204 |

Token inputs are inactive (`active:false`, rate 0) until `TOKEN_ADDRESS` is set. Pools:
V2 `getPair(token, WBNB|USDT)`, V3 `getPool(token, WBNB|USDT, 100|500|2500|10000)`, plus
`TOKEN_POOLS` env (comma list, e.g. a launchpad bonding curve); re-discover every 10 min.
Token decimals read from the token. All values as float64 in token units / USD.

Per-address cap: after summing per cap key within the window, each key contributes at most
`max(0.02 * rolling_median(x), CAP_FLOOR[id])`; CAP_FLOOR: usdt/usdc 10,000 USD, dex 5,000 USD,
token 1% of total supply, count channels n/a (shown in the table). Record the number of capped
keys per channel in the frame.

Gating (per input, own buffer of the last 360 windows = 72 min, persisted):
```
med = median(buf); mad = max(1.4826 * median(|buf - med|), MAD_FLOOR[id] or 1e-9 * max(1, med))
z   = (x - med) / mad
rate_hz = 0                                   if warm or z < Z_GATE
        = min(MAX_HZ, R_MIN + K * (z - Z_GATE))  otherwise
```
Defaults Z_GATE 1.0, R_MIN 10 Hz, K 10 Hz per z, MAX_HZ 80 Hz (builder may lower after the
GAIN sweep). Warm-up is live: `warm = len(buf) < 30` (6 minutes after first boot); x is still
appended. Rate applies to every neuron in the group as independent Poisson drive.

## 4. Contract: FlyBrainRegistry

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 { function transferFrom(address,address,uint256) external returns (bool);
                   function balanceOf(address) external view returns (uint256); }

contract FlyBrainRegistry {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint32  public constant MAX_PER_CLAIM = 5000;

    uint32  public immutable neuronCount;      // 165122
    bytes32 public immutable connectomeHash;   // section 5
    bytes32 public immutable neuronTableHash;  // section 5
    uint256 public immutable permMul;          // 1 < permMul < N, gcd(permMul, N) == 1
    uint256 public immutable permAdd;          // permAdd < N
    uint256 public immutable permInv;          // permMul^-1 mod N, computed in constructor (ext. Euclid)

    address public owner;        // = msg.sender at deploy
    address public operator;
    address public token;        // 0 until setToken
    uint256 public pricePerNeuron;
    uint32  public claimedNeurons;               // next permutation index

    struct Claim { address owner; uint32 start; uint32 count; uint64 time; uint256 burned; string name; string note; }
    Claim[] internal _claims;

    struct Beat { uint64 epoch; bytes32 stateHash; bytes32 spikeRoot; bytes32 inputHash; uint64 time; }
    Beat public latest;

    event Claimed(uint256 indexed claimId, address indexed owner, uint32 start, uint32 count, uint256 burned, string name, string note);
    event Heartbeat(uint64 indexed epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash);
    event TokenSet(address token, uint256 pricePerNeuron);
    event PriceSet(uint256 pricePerNeuron);
    event OperatorSet(address operator);
    event OwnerSet(address owner);

    constructor(uint32 neuronCount_, bytes32 connectomeHash_, bytes32 neuronTableHash_,
                address operator_, uint256 permMul_, uint256 permAdd_);

    function setToken(address token_, uint256 price) external;   // onlyOwner, token==0 before, token_!=0, price>0; locks forever
    function setPrice(uint256 price) external;                   // onlyOwner, price>0
    function setOperator(address op) external;                   // onlyOwner
    function transferOwnership(address to) external;             // onlyOwner (allowed: no upgrade/withdraw power)

    function claim(uint32 count, string calldata name, string calldata note) external returns (uint256 claimId);
    function heartbeat(uint64 epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash) external; // onlyOperator, epoch > latest.epoch

    function claimsCount() external view returns (uint256);
    function getClaim(uint256 id) external view returns (Claim memory);
    function neuronAt(uint32 index) public view returns (uint32);          // (permMul*index + permAdd) % N, index < N
    function indexOfNeuron(uint32 neuron) public view returns (uint32);    // permInv*(neuron + N - permAdd) % N
    function claimOfNeuron(uint32 neuron) external view returns (bool claimed, uint256 claimId); // binary search on start
    function remaining() external view returns (uint32);                   // N - claimedNeurons
}
```
Rules:
- claim: `token != 0`; `1 <= count <= MAX_PER_CLAIM`; `count <= remaining()`;
  `1 <= bytes(name).length <= 32`; `bytes(note).length <= 140`; amount = count * price;
  `before = balanceOf(DEAD)`; low-level `transferFrom(msg.sender, DEAD, amount)` accepting
  empty return data or `true`; require `balanceOf(DEAD) - before == amount` (rejects
  fee-on-transfer tokens; the deploy runbook simulates a claim on a local fork before
  `setToken`, since setToken cannot be undone). Store `{msg.sender, claimedNeurons, count,
  block.timestamp, amount, name, note}`, advance `claimedNeurons`, emit. Checks-effects-
  interactions order: store after the transfer check is fine because nothing external is
  called after; add a simple reentrancy lock anyway.
- Names/notes are raw bytes; no content filter; any UTF-8 (or not). Consumers escape.
- Constructor: `neuronCount_ > 0`, `permMul_ < N`, `permAdd_ < N`, gcd == 1 (from the Euclid
  that produces `permInv`), `operator_ != 0`.
- No upgrades, no withdraw, no fees, no payable functions, no receive().
- Tests (local Hardhat, MockERC20 + a fee-on-transfer mock): permutation is a bijection for a
  small N (e.g. 1009 and 1000 with gcd checks) and spot checks at N = 165122; claim bounds
  (0, MAX+1, over remaining, name 0/33 bytes, note 141 bytes, multibyte UTF-8 at the byte
  limit); burn lands on DEAD; claimOfNeuron for first/last neuron of each claim and unclaimed;
  setToken once; only owner/operator; heartbeat epoch must increase; fee token rejected.

## 5. Hashes (all SHA-256, off-chain, reproducible with hashlib; little-endian integers)

- `connectomeHash = sha256("flybrainbnb/connectome/v1" || u32 N || i64 bodies[N] ||
  i64 indptr[N+1] || i32 indices[nnz] || f32 data[nnz])` using the CSR arrays of graph.npz
  as stored (after casting to those dtypes).
- `channelsHash = sha256(canonical channels.json)` where canonical = `json.dumps(obj,
  sort_keys=True, separators=(",",":"), ensure_ascii=False).encode()`; `channels.json` =
  `{version:1, W_ms:12000, gain, gating defaults, inputs:[{id, label, signal, selector,
  source, neurons:[sorted ids]}]}`.
- `neuronTableHash = sha256("flybrainbnb/neurons/v1" || u32 N || i64 bodies[N] ||
  "\n".join(types).utf8 || channelsHash)` (pins neuron order, cell types and the channel
  map on-chain; positions are cosmetic and not pinned).
- Permutation: `seed = sha256("flybrainbnb/perm/v1" || connectomeHash)`;
  `permMul = int(seed[0:8], big) % N`, then `+1 mod N` until `permMul > 1 and gcd(permMul, N) == 1`;
  `permAdd = int(seed[8:16], big) % N`. (N = 165122 = 2 x 82561, so permMul must be odd.)
  `make_assets.py` writes `assets/deploy_params.json` = `{neuronCount, connectomeHash,
  neuronTableHash, permMul, permAdd, channelsHash}` (hex strings 0x-prefixed).
- Epoch `e = floor(window_start_unix_s / 600)`; an epoch holds the windows starting in it.
- Window leaf `leaf_w = sha256("flybrainbnb/window/v1" || u64 w || u32 k || u32 ids[k] (sorted
  neurons with count>0) || u16 counts[k])`.
- `spikeRoot` = binary Merkle root (sha256(left||right), odd node promoted unchanged) over
  `leaf_w` in window order; single leaf -> the leaf.
- `inputHash = sha256("flybrainbnb/input/v1" || channelsHash || for each window in order:
  u64 w || u64 fromBlock || u64 toBlock || u16 bio_ms || for each input in channels.json
  order: f64 raw || f32 rate_hz)`.
- `stateHash = sha256("flybrainbnb/state/v1" || u64 e || f32 v[N] || i32 refr[N])` at the end
  of the epoch's last window.
- Heartbeat: when the first window of epoch e+1 finishes, send
  `heartbeat(e, stateHash, spikeRoot, inputHash)` from OPERATOR if `REGISTRY_ADDRESS`,
  `OPERATOR_PRIVATE_KEY` and `HEARTBEAT=1` are all set and e > latest.epoch and the epoch has
  at least one window. Legacy gasPrice = max(eth_gasPrice, 0.05 gwei), gas limit 120k,
  chainId from `CHAIN_ID` (56 live, 31337 in tests). On failure retry once in the next
  window, then skip. Cost ~0.00001 BNB per beat at 0.05 gwei. Builders test only on 31337.
- Persist `/data/epochs/<e>.json` = `{epoch, windows:[{w, fromBlock, toBlock, bio_ms, raw{},
  rates{}, capped{}, leaf}], stateHash, spikeRoot, inputHash, tx}` forever (small) and
  `/data/spikes/<e>.bin` (the ids/counts for every window) for the last 144 epochs (24 h).

## 6. Brain HTTP API (CORS `*`, JSON unless noted, gzip when accepted)

- `GET /status` -> `{ok, version, n:165122, window_ms:12000, bio_ms, gain, window, epoch,
  block, rpc_ok, lag_s, sim_wall_ms, warm, connectomeHash, neuronTableHash, channelsHash,
  registry:{address|null, token|null, price|null, claimsCount, remaining}, lastHeartbeat:
  {epoch, stateHash, spikeRoot, inputHash, tx|null} | null, heartbeat_enabled}`
- `GET /neurons.bin` (immutable, `Cache-Control: public, max-age=86400`). Little-endian:
  ```
  0   4  magic "FLYN"
  4   u16 version = 1
  6   u16 groupCount G   (0 = none, 1..G = channel inputs in channels.json order)
  8   u32 N
  12  f32 minx miny minz maxx maxy maxz   (voxel units)
  36  N x u16 x, N x u16 y, N x u16 z      (quantised: min + q/65535*(max-min))
  ..  N x u8 group id
  ..  N x u8 superclass id  (index into /channels.superclasses)
  ..  N x u8 flags          (bit0 imputed position, bit1 side L, bit2 side R, bit3 side M)
  ```
  A neuron in two groups takes the first in channel order (none overlap today; test it).
- `GET /frame` -> latest window meta: `{window, epoch, t_ms, fromBlock, toBlock, bio_ms,
  total_spikes, active_neurons, mean_hz, inputs:[{id, raw, z, rate_hz, warm, active, capped}],
  top:[[neuronId, count], ... up to 2000 by count desc], leaf}`
- `GET /frame.bin?w=<window>` -> dense `N x u8` spike counts for that window (saturate at
  255), latest if `w` omitted, 404 if not in the last 30 windows. Gzipped on the wire.
- `GET /stream` (SSE): `event: frame` data = /frame JSON without `top`; `event: heartbeat`
  data = lastHeartbeat; `event: claim` data = a claim object; comment keep-alive every 15 s.
- `GET /channels` -> channels.json plus `superclasses:[names]`, `gating` defaults, and live
  buffer stats `{id: {n, median, mad}}`.
- `GET /owners?offset=0&limit=100` -> `{count, claims:[{id, owner, start, count, burned,
  time, name, note}]}` newest first, from the registry (poll `claimsCount()` every 30 s,
  `getClaim(i)` for new ids, cached in `/data/claims.json`); `{count:0, claims:[]}` if no
  registry. `GET /neuron/<id>` -> `{id, bodyId, type, superclass, side, imputed, group,
  index, claim|null}`.
- `GET /epoch/<e>` -> the persisted epoch record.

Env (Railway): `BSC_RPC_URL`, `RPC_FALLBACKS`, `REGISTRY_ADDRESS`, `TOKEN_ADDRESS`,
`TOKEN_POOLS`, `OPERATOR_PRIVATE_KEY`, `HEARTBEAT` (0/1), `CHAIN_ID` (56), `BIO_MS`, `GAIN`,
`DATA_DIR` (/data), `PORT`. Set variables with PowerShell (Git Bash mangles `/data`).

## 7. Site (static, Vercel)

- `config.js`: `window.FLY_CONFIG = { BRAIN_API: "https://<railway>", REGISTRY_ADDRESS: "",
  CHAIN_ID: 56, RPC_URL: "https://bsc-rpc.publicnode.com" }`. Token and price are always
  read from the registry (`token()`, `pricePerNeuron()`, `remaining()`), never configured.
- Libraries (cdnjs only, exact versions): three.js `r128/three.min.js` (UMD; write a small
  drag-to-rotate, no OrbitControls), ethers `6.x ethers.umd.min.js` (builder pins an exact
  version that exists on cdnjs).
- Heatmap: fetch `/neurons.bin`, build `THREE.Points` (165,122 points, additive off, small
  size), per-point color from a decaying activity value: on each SSE frame fetch
  `/frame.bin?w=`, `act = max(act*decay, log1p(count)/log1p(255))`, animate decay between
  frames. Dim base color per superclass; channel groups get an outline/legend; imputed
  positions drawn the same but the legend says "sensory neurons placed near their targets:
  layout, not anatomy". Side panel: live inputs with raw value, z, rate, warm-up badge.
  Click a point -> `/neuron/<id>` card with owner name if claimed. Pause when tab hidden.
- Burn panel: if `REGISTRY_ADDRESS` empty or `token() == 0`: disabled, text
  "token isn't live yet". Else: connect injected wallet (`window.ethereum`), switch to chain
  56 (`wallet_switchEthereumChain 0x38`), count input (1..min(MAX_PER_CLAIM, remaining)),
  name (1..32 UTF-8 bytes, counted with TextEncoder) and note (0..140 bytes), cost = count *
  price shown with token symbol/decimals; if allowance < cost: `approve(registry, cost)`
  exact; then `claim(count, name, note)`; parse `Claimed` from the receipt and show the
  assigned neuron ids (`(permMul*i + permAdd) % N` for i in start..start+count-1, reading
  permMul/permAdd/neuronCount from the contract) and highlight them in the heatmap.
  State plainly: tokens are burned to 0x...dEaD, nothing is returned, no NFT, the name and
  note are public forever.
- Owners wall: `/owners` (fallback: read the registry directly), newest first, name, note,
  short address linking to bscscan, neuron count, time. Every user string via
  `textContent` only, never `innerHTML`; offensive content allowed, escaping mandatory;
  strip nothing, but render with `unicode-bidi: isolate` and `overflow-wrap:anywhere`.
- Lore section (text of section 0), on-chain proof section (registry address, connectome
  hash, latest heartbeat epoch/tx linking bscscan), credits section.
- Must work at 400 px width; no fake data: when the brain API is down say "brain offline".

## 8. Deploy runbook (owner runs later; builders do not)

1. `py brain/make_assets.py` -> assets + deploy_params.json; commit.
2. Local: `npx hardhat test`; fork test of a claim against the real token before setToken.
3. Mainnet deploy with DEPLOYER (owner), operator = OPERATOR_ADDRESS
   (0x... from .env, public). 4. Railway brain with REGISTRY_ADDRESS, HEARTBEAT=1.
5. Vercel site with config.js. 6. When the coin exists: `setToken(token, price)` once,
   `TOKEN_ADDRESS` on Railway.
