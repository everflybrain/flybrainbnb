// Local end-to-end helper: mint mock tokens to hardhat accounts #2 and #3 and make two claims
// (one with a multibyte name and note). Local chains only.
//   npx hardhat run scripts/local-claims.js --network localhost
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { LOCAL_CHAINS } = require("./lib");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (!LOCAL_CHAINS.has(chainId)) throw new Error(`local chains only (got ${chainId})`);
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${chainId}.json`), "utf8"));
  const signers = await ethers.getSigners();
  const reg = await ethers.getContractAt("FlyBrainRegistry", dep.address);
  const tokenAddr = await reg.token();
  if (tokenAddr === ethers.ZeroAddress) throw new Error("token not set");
  const token = await ethers.getContractAt("MockBEP20", tokenAddr);
  const price = await reg.pricePerNeuron();

  const plan = [
    { who: signers[2], count: 3, name: "<img src=x onerror=alert(1)>", note: "plain ascii note & <b>tags</b>" },
    { who: signers[3], count: 7, name: "Mücke 🧠 蝇", note: "é€ ‮right-to-left 🪰 burned forever" },
  ];
  for (const p of plan) {
    const cost = price * BigInt(p.count);
    await (await token.mint(p.who.address, cost)).wait();
    await (await token.connect(p.who).approve(dep.address, cost)).wait();
    const tx = await reg.connect(p.who).claim(p.count, p.name, p.note);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Claimed");
    const start = Number(ev.args.start);
    const ids = [];
    for (let i = 0; i < p.count; i++) ids.push(Number(await reg.neuronAt(start + i)));
    console.log(JSON.stringify({ claimId: Number(ev.args.claimId), owner: p.who.address, start, count: p.count,
      nameBytes: Buffer.byteLength(p.name), noteBytes: Buffer.byteLength(p.note), gas: rc.gasUsed.toString(), neurons: ids }));
  }
  console.log(`claimsCount ${await reg.claimsCount()} remaining ${await reg.remaining()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
