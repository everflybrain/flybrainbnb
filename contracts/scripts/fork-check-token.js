// Dry-run a real token against the deployed registry on a LOCAL FORK of BNB Smart Chain.
// Nothing here touches mainnet: the fork must report a local chain id, and every
// transaction is sent through impersonated accounts on the fork.
//
//   npx hardhat node --fork https://bsc-rpc.publicnode.com --port 8546
//   TOKEN=0x... node scripts/fork-check-token.js
//
// Env: TOKEN (required), FORK_URL (default http://127.0.0.1:8546), PRICE_TOKENS (default 1000,
// whole tokens per neuron), HOLDER (default: the token's owner()), COUNT (default 3).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { LOCAL_CHAINS } = require("./lib");

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function impersonate(provider, addr) {
  await provider.send("hardhat_impersonateAccount", [addr]);
  await provider.send("hardhat_setBalance", [addr, "0x8AC7230489E80000"]); // 10 BNB of fork gas
  // Impersonated accounts are not listed by eth_accounts, so build the signer directly.
  return new ethers.JsonRpcSigner(provider, addr);
}

async function main() {
  const TOKEN = process.env.TOKEN;
  if (!TOKEN || !ethers.isAddress(TOKEN)) throw new Error("TOKEN env must be a token address");
  const url = process.env.FORK_URL || "http://127.0.0.1:8546";
  const provider = new ethers.JsonRpcProvider(url);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (!LOCAL_CHAINS.has(chainId)) throw new Error(`refusing: ${url} reports chain ${chainId}, not a local fork`);
  // Mine one empty block first so "latest" is a local block and reads run under the local
  // hardfork rules rather than as historical execution at the pinned fork block.
  await provider.send("evm_mine", []);

  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "56.json"), "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "abi", "FlyBrainRegistry.abi.json"), "utf8"));
  const reg = new ethers.Contract(dep.address, abi, provider);
  const tok = new ethers.Contract(TOKEN, ERC20, provider);

  const [name, symbol, decimals] = await Promise.all([tok.name(), tok.symbol(), tok.decimals()]);
  const holder = process.env.HOLDER || (await tok.owner());
  const price = ethers.parseUnits(process.env.PRICE_TOKENS || "1000", decimals);
  const count = Number(process.env.COUNT || 3);
  const dead = await reg.DEAD();
  console.log(`fork chain ${chainId} at block ${await provider.getBlockNumber()}`);
  console.log(`registry ${dep.address}  token ${TOKEN} (${name} / ${symbol}, ${decimals} dp)`);
  console.log(`holder ${holder} balance ${ethers.formatUnits(await tok.balanceOf(holder), decimals)} ${symbol}`);

  const already = await reg.token();
  if (already !== ethers.ZeroAddress && already.toLowerCase() !== TOKEN.toLowerCase()) throw new Error(`registry already has another token on this fork: ${already}`);
  if (already === ethers.ZeroAddress) {
    const owner = await reg.owner();
    const ownerSigner = await impersonate(provider, owner);
    const t1 = await reg.connect(ownerSigner).setToken(TOKEN, price);
    const r1 = await t1.wait();
    console.log(`setToken ok  gas ${r1.gasUsed}  token ${await reg.token()}  price ${ethers.formatUnits(await reg.pricePerNeuron(), decimals)} ${symbol}/neuron`);
  } else {
    console.log(`token already set on this fork (earlier run); price ${ethers.formatUnits(await reg.pricePerNeuron(), decimals)} ${symbol}/neuron`);
  }
  const priceNow = await reg.pricePerNeuron();

  const hs = await impersonate(provider, holder);
  const deadBefore = await tok.balanceOf(dead);
  const holderBefore = await tok.balanceOf(holder);
  const claims = [
    [count, "fork check", "first claim on the fork"],
    [1, "Mücke 🧠 蝇 name of 31 byte", "é € ‮ emoji 🪰 and a note that is fairly long, up to the 140 byte cap...."],
  ];
  for (const [n, nm, note] of claims) {
    const cost = priceNow * BigInt(n);
    await (await tok.connect(hs).approve(dep.address, cost)).wait();
    const tx = await reg.connect(hs).claim(n, nm, note, cost);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Claimed");
    const ids = [];
    for (let i = 0; i < Number(ev.args.count); i++) ids.push(Number(await reg.neuronAt(Number(ev.args.start) + i)));
    const [has, cid] = await reg.claimOfNeuron(ids[0]);
    console.log(`claim #${ev.args.claimId} ${n} neuron(s)  gas ${rc.gasUsed}  burned ${ethers.formatUnits(ev.args.burned, decimals)} ${symbol}  neurons ${ids.join(",")}  claimOfNeuron(${ids[0]}) -> ${has} #${cid}`);
  }
  const deadDelta = (await tok.balanceOf(dead)) - deadBefore;
  const holderDelta = holderBefore - (await tok.balanceOf(holder));
  const expected = priceNow * BigInt(count + 1);
  console.log(`burned to dEaD ${ethers.formatUnits(deadDelta, decimals)} ${symbol}  (holder paid ${ethers.formatUnits(holderDelta, decimals)}; expected ${ethers.formatUnits(expected, decimals)})`);
  console.log(`claims ${await reg.claimsCount()}  claimed neurons ${await reg.claimedNeurons()}  remaining ${await reg.remaining()}`);
  const stored = await reg.getClaim(1);
  console.log(`stored name #1: ${JSON.stringify(stored.name)}  note bytes ${ethers.toUtf8Bytes(stored.note).length}`);
  if (deadDelta !== expected || holderDelta !== expected) throw new Error("transfer amounts differ from cost: token takes a fee or rebases");
  console.log("RESULT: token works with the registry on the fork. Mainnet untouched.");
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message || e); process.exit(1); });
