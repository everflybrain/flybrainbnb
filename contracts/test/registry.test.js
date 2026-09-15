const { expect } = require("chai");
const { ethers } = require("hardhat");
const { derivePerm, gcd } = require("../scripts/lib");

const N = 165122;
const CONNECTOME = "0x24d0df1a83cefeff694d4652102a83dc15eeaa247ab90f4913ba3c02825c907c"; // sha256 per DESIGN 5, graph.npz 2026-09-15
const TABLE = ethers.keccak256(ethers.toUtf8Bytes("neuron-table-test"));
const DEAD = "0x000000000000000000000000000000000000dEaD";
const PRICE = ethers.parseEther("1000");
const GAS = {};

async function deployRegistry({ n = N, mul, add, operator } = {}) {
  const [owner, op] = await ethers.getSigners();
  let permMul = mul, permAdd = add;
  if (permMul === undefined) ({ permMul, permAdd } = derivePerm(CONNECTOME, n));
  const F = await ethers.getContractFactory("FlyBrainRegistry");
  const reg = await F.deploy(n, CONNECTOME, TABLE, operator ?? op.address, permMul, permAdd);
  await reg.waitForDeployment();
  return reg;
}

async function deployToken(tax = false) {
  const F = await ethers.getContractFactory(tax ? "MockBEP20Tax" : "MockBEP20");
  const t = await F.deploy("Test", "TST");
  await t.waitForDeployment();
  return t;
}

async function setup(opts = {}) {
  const signers = await ethers.getSigners();
  const [owner, op, alice, bob] = signers;
  const reg = await deployRegistry(opts);
  const token = await deployToken(opts.tax);
  for (const u of [alice, bob]) {
    await token.mint(u.address, ethers.parseEther("1000000000"));
    await token.connect(u).approve(await reg.getAddress(), ethers.MaxUint256);
  }
  await reg.setToken(await token.getAddress(), PRICE);
  return { reg, token, owner, op, alice, bob, signers };
}

const gasOf = async (txp) => (await (await txp).wait()).gasUsed;

describe("permutation", () => {
  it("derivePerm matches DESIGN rules for the real N", () => {
    const { permMul, permAdd } = derivePerm(CONNECTOME, N);
    expect(permMul > 1n && permMul < BigInt(N)).to.equal(true);
    expect(gcd(permMul, BigInt(N))).to.equal(1n);
    expect(permAdd < BigInt(N)).to.equal(true);
    expect([Number(permMul), Number(permAdd)]).to.deep.equal([101275, 52805]); // same as the Python derivation
  });

  it("is a bijection for N = 165122 (full check off-chain, samples on-chain)", async () => {
    const reg = await deployRegistry();
    const mul = Number(await reg.permMul()), add = Number(await reg.permAdd()), inv = Number(await reg.permInv());
    expect((mul * inv) % N).to.equal(1);
    const seen = new Uint8Array(N);
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const v = (mul * i + add) % N; // mul * i < 2^53, exact in doubles
      if (seen[v]) throw new Error("collision at " + i);
      seen[v] = 1;
      hits++;
      if ((inv * ((v + N - add) % N)) % N !== i) throw new Error("inverse fails at " + i);
    }
    expect(hits).to.equal(N);
    expect(seen.every((x) => x === 1)).to.equal(true);
    const samples = [0, 1, 2, N - 2, N - 1];
    for (let k = 0; k < 150; k++) samples.push(Math.floor(Math.random() * N));
    for (const i of samples) {
      const v = Number(await reg.neuronAt(i));
      expect(v).to.equal((mul * i + add) % N);
      expect(Number(await reg.indexOfNeuron(v))).to.equal(i);
    }
    await expect(reg.neuronAt(N)).to.be.revertedWithCustomError(reg, "OutOfRange");
    await expect(reg.indexOfNeuron(N)).to.be.revertedWithCustomError(reg, "OutOfRange");
  });

  for (const [n, mul, add] of [[1009, 17, 500], [1000, 7, 999]]) {
    it(`is a bijection on-chain for small N = ${n}`, async () => {
      const reg = await deployRegistry({ n, mul, add });
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        const v = Number(await reg.neuronAt(i));
        seen.add(v);
        expect(Number(await reg.indexOfNeuron(v))).to.equal(i);
      }
      expect(seen.size).to.equal(n);
    });
  }

  it("constructor rejects bad params", async () => {
    const [, op] = await ethers.getSigners();
    const F = await ethers.getContractFactory("FlyBrainRegistry");
    const bad = [
      [1000, 2, 1, op.address],     // gcd 2
      [1000, 1000, 1, op.address],  // permMul >= N
      [1000, 3, 1000, op.address],  // permAdd >= N
      [1000, 0, 1, op.address],     // permMul 0
      [0, 0, 0, op.address],        // N 0
      [N, 2, 1, op.address],        // even permMul, N even
    ];
    for (const [n, m, a, o] of bad) {
      await expect(F.deploy(n, CONNECTOME, TABLE, o, m, a)).to.be.revertedWithCustomError(F, "BadParams");
    }
    await expect(F.deploy(1009, CONNECTOME, TABLE, ethers.ZeroAddress, 3, 1)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });
});

describe("owner and token", () => {
  it("setToken once and locks; only owner", async () => {
    const [owner, op, alice] = await ethers.getSigners();
    const reg = await deployRegistry();
    const t1 = await deployToken(), t2 = await deployToken();
    await expect(reg.connect(alice).setToken(await t1.getAddress(), PRICE)).to.be.revertedWithCustomError(reg, "NotOwner");
    await expect(reg.setToken(ethers.ZeroAddress, PRICE)).to.be.revertedWithCustomError(reg, "ZeroAddress");
    await expect(reg.setToken(alice.address, PRICE)).to.be.revertedWithCustomError(reg, "NotAContract");
    await expect(reg.setToken(await t1.getAddress(), 0)).to.be.revertedWithCustomError(reg, "ZeroPrice");
    await expect(reg.claim(1, "x", "")).to.be.revertedWithCustomError(reg, "TokenNotSet");
    await expect(reg.setToken(await t1.getAddress(), PRICE)).to.emit(reg, "TokenSet").withArgs(await t1.getAddress(), PRICE);
    await expect(reg.setToken(await t2.getAddress(), PRICE)).to.be.revertedWithCustomError(reg, "TokenAlreadySet");
    expect(await reg.token()).to.equal(await t1.getAddress());
  });

  it("setPrice, setOperator, transferOwnership: only owner, events", async () => {
    const [owner, op, alice, bob] = await ethers.getSigners();
    const reg = await deployRegistry();
    await expect(reg.connect(alice).setPrice(5)).to.be.revertedWithCustomError(reg, "NotOwner");
    await expect(reg.setPrice(0)).to.be.revertedWithCustomError(reg, "ZeroPrice");
    await expect(reg.setPrice(5)).to.emit(reg, "PriceSet").withArgs(5);
    await expect(reg.connect(alice).setOperator(bob.address)).to.be.revertedWithCustomError(reg, "NotOwner");
    await expect(reg.setOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, "ZeroAddress");
    await expect(reg.setOperator(bob.address)).to.emit(reg, "OperatorSet").withArgs(bob.address);
    await expect(reg.connect(alice).transferOwnership(alice.address)).to.be.revertedWithCustomError(reg, "NotOwner");
    await expect(reg.transferOwnership(alice.address)).to.emit(reg, "OwnerSet").withArgs(alice.address);
    await expect(reg.setPrice(6)).to.be.revertedWithCustomError(reg, "NotOwner");
    await reg.connect(alice).setPrice(6);
    expect(await reg.owner()).to.equal(alice.address);
  });
});

describe("claim", () => {
  it("bounds on count and byte limits (multibyte UTF-8)", async () => {
    const { reg, alice } = await setup();
    const r = reg.connect(alice);
    await expect(r.claim(0, "a", "")).to.be.revertedWithCustomError(reg, "BadCount");
    await expect(r.claim(5001, "a", "")).to.be.revertedWithCustomError(reg, "BadCount");
    await expect(r.claim(1, "", "")).to.be.revertedWithCustomError(reg, "BadName");
    await expect(r.claim(1, "a".repeat(33), "")).to.be.revertedWithCustomError(reg, "BadName");
    await expect(r.claim(1, "a", "b".repeat(141))).to.be.revertedWithCustomError(reg, "BadNote");

    const euro32 = "€".repeat(10) + "ab";           // 30 + 2 bytes
    const emoji32 = "\u{1F9E0}".repeat(8);                // 8 x 4 bytes
    const note140 = "é".repeat(70);                  // 70 x 2 bytes
    expect(Buffer.byteLength(euro32)).to.equal(32);
    expect(euro32.length).to.equal(12);
    await expect(r.claim(1, "€".repeat(11), "")).to.be.revertedWithCustomError(reg, "BadName"); // 11 chars, 33 bytes
    await expect(r.claim(1, emoji32 + "a", "")).to.be.revertedWithCustomError(reg, "BadName");
    await expect(r.claim(1, "a", note140 + "a")).to.be.revertedWithCustomError(reg, "BadNote");
    await r.claim(1, euro32, note140);
    await r.claim(1, emoji32, "");
    await r.claim(5000, "a".repeat(32), "z".repeat(140));
    const c0 = await reg.getClaim(0);
    expect(c0.name).to.equal(euro32);
    expect(c0.note).to.equal(note140);
    expect((await reg.getClaim(1)).name).to.equal(emoji32);
    expect((await reg.getClaim(2)).count).to.equal(5000n);
    await expect(reg.getClaim(3)).to.be.revertedWithCustomError(reg, "OutOfRange");
  });

  it("burns exactly count * price to 0x...dEaD and emits Claimed", async () => {
    const { reg, token, alice } = await setup();
    const before = await token.balanceOf(alice.address);
    await expect(reg.connect(alice).claim(3, "<script>alert(1)</script>", "note"))
      .to.emit(reg, "Claimed").withArgs(0, alice.address, 0, 3, PRICE * 3n, "<script>alert(1)</script>", "note")
      .and.to.emit(token, "Transfer").withArgs(alice.address, DEAD, PRICE * 3n);
    expect(await token.balanceOf(DEAD)).to.equal(PRICE * 3n);
    expect(await token.balanceOf(alice.address)).to.equal(before - PRICE * 3n);
    expect(await token.balanceOf(await reg.getAddress())).to.equal(0n);
    const c = await reg.getClaim(0);
    expect([c.owner, c.start, c.count, c.burned]).to.deep.equal([alice.address, 0n, 3n, PRICE * 3n]);
    expect(await reg.claimedNeurons()).to.equal(3n);
    expect(await reg.remaining()).to.equal(BigInt(N - 3));
    expect(await reg.claimsCount()).to.equal(1n);
  });

  it("rejects without allowance or balance, and fee-on-transfer tokens", async () => {
    const { reg, token, bob, signers } = await setup();
    const poor = signers[5];
    await expect(reg.connect(poor).claim(1, "p", "")).to.be.revertedWithCustomError(reg, "TransferFailed");
    await token.connect(bob).approve(await reg.getAddress(), PRICE - 1n);
    await expect(reg.connect(bob).claim(1, "b", "")).to.be.revertedWithCustomError(reg, "TransferFailed");

    const tax = await setup({ tax: true });
    await expect(tax.reg.connect(tax.alice).claim(2, "t", ""))
      .to.be.revertedWithCustomError(tax.reg, "BurnMismatch").withArgs(PRICE * 2n, (PRICE * 2n * 95n) / 100n);
    expect(await tax.reg.claimedNeurons()).to.equal(0n);
  });

  it("claimOfNeuron at claim boundaries and for unclaimed neurons", async () => {
    const { reg, alice, bob } = await setup();
    const sizes = [1, 50, 7, 5000, 2];
    let start = 0;
    for (let k = 0; k < sizes.length; k++) {
      await reg.connect(k % 2 ? bob : alice).claim(sizes[k], "c" + k, "");
      start += sizes[k];
    }
    let s = 0;
    for (let k = 0; k < sizes.length; k++) {
      for (const idx of [s, s + sizes[k] - 1]) {
        const neuron = await reg.neuronAt(idx);
        expect(await reg.indexOfNeuron(neuron)).to.equal(BigInt(idx));
        const [claimed, id] = await reg.claimOfNeuron(neuron);
        expect([claimed, id]).to.deep.equal([true, BigInt(k)]);
      }
      s += sizes[k];
    }
    for (const idx of [start, start + 1, N - 1]) {
      const [claimed, id] = await reg.claimOfNeuron(await reg.neuronAt(idx));
      expect([claimed, id]).to.deep.equal([false, 0n]);
    }
  });

  it("claimOfNeuron with no claims", async () => {
    const reg = await deployRegistry();
    expect(await reg.claimOfNeuron(0)).to.deep.equal([false, 0n]);
    await expect(reg.claimOfNeuron(N)).to.be.revertedWithCustomError(reg, "OutOfRange");
  });

  it("sells out exactly at N", async () => {
    const { reg, alice } = await setup({ n: 7, mul: 3, add: 4 });
    await expect(reg.connect(alice).claim(8, "a", "")).to.be.revertedWithCustomError(reg, "SoldOut");
    await reg.connect(alice).claim(5, "a", "");
    await expect(reg.connect(alice).claim(3, "a", "")).to.be.revertedWithCustomError(reg, "SoldOut");
    await reg.connect(alice).claim(2, "b", "");
    expect(await reg.remaining()).to.equal(0n);
    await expect(reg.connect(alice).claim(1, "c", "")).to.be.revertedWithCustomError(reg, "SoldOut");
    const ids = new Set();
    for (let n = 0; n < 7; n++) {
      const [claimed, id] = await reg.claimOfNeuron(n);
      expect(claimed).to.equal(true);
      ids.add(Number(await reg.indexOfNeuron(n)));
      expect(id).to.equal(Number(await reg.indexOfNeuron(n)) < 5 ? 0n : 1n);
    }
    expect(ids.size).to.equal(7);
  });

  it("gas: claim(1), claim(50)", async () => {
    const { reg, bob, alice } = await setup();
    const name = "fly fan 12345", note = "burned for the brain, forty bytes long..";
    GAS["claim(1) first ever (13B name, 40B note)"] = await gasOf(reg.connect(alice).claim(1, name, note));
    GAS["claim(1) later (13B name, 40B note)"] = await gasOf(reg.connect(bob).claim(1, name, note));
    GAS["claim(50) (13B name, 40B note)"] = await gasOf(reg.connect(alice).claim(50, name, note));
    GAS["claim(1) later (1B name, no note)"] = await gasOf(reg.connect(bob).claim(1, "a", ""));
    GAS["claim(50) max strings (32B name, 140B note)"] = await gasOf(reg.connect(alice).claim(50, "n".repeat(32), "x".repeat(140)));
    GAS["claim(5000) (13B name, 40B note)"] = await gasOf(reg.connect(alice).claim(5000, name, note));
  });
});

describe("heartbeat", () => {
  it("operator only, epoch strictly increasing, stores latest, emits", async () => {
    const [owner, op, alice] = await ethers.getSigners();
    const reg = await deployRegistry();
    const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s));
    expect((await reg.latest()).epoch).to.equal(0n);
    await expect(reg.connect(alice).heartbeat(1, h("a"), h("b"), h("c"))).to.be.revertedWithCustomError(reg, "NotOperator");
    await expect(reg.heartbeat(1, h("a"), h("b"), h("c"))).to.be.revertedWithCustomError(reg, "NotOperator");
    await expect(reg.connect(op).heartbeat(0, h("a"), h("b"), h("c"))).to.be.revertedWithCustomError(reg, "EpochNotIncreasing");

    const e = 2961000n; // ~ floor(unix/600) in 2026
    const tx = reg.connect(op).heartbeat(e, h("s"), h("k"), h("i"));
    await expect(tx).to.emit(reg, "Heartbeat").withArgs(e, h("s"), h("k"), h("i"));
    const rc = await (await tx).wait();
    GAS["heartbeat first"] = rc.gasUsed;
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    const L = await reg.latest();
    expect([L.epoch, L.stateHash, L.spikeRoot, L.inputHash, L.time]).to.deep.equal([e, h("s"), h("k"), h("i"), BigInt(blk.timestamp)]);

    await expect(reg.connect(op).heartbeat(e, h("x"), h("y"), h("z"))).to.be.revertedWithCustomError(reg, "EpochNotIncreasing");
    await expect(reg.connect(op).heartbeat(e - 1n, h("x"), h("y"), h("z"))).to.be.revertedWithCustomError(reg, "EpochNotIncreasing");
    GAS["heartbeat later"] = await gasOf(reg.connect(op).heartbeat(e + 1n, h("x"), h("y"), h("z")));
    GAS["heartbeat after a skipped epoch"] = await gasOf(reg.connect(op).heartbeat(e + 3n, h("x2"), h("y2"), h("z2")));
    expect((await reg.latest()).epoch).to.equal(e + 3n);

    await reg.setOperator(alice.address);
    await expect(reg.connect(op).heartbeat(e + 4n, h("a"), h("b"), h("c"))).to.be.revertedWithCustomError(reg, "NotOperator");
    await reg.connect(alice).heartbeat(e + 4n, h("a"), h("b"), h("c"));
  });

  it("latest() keeps the Beat tuple ABI", async () => {
    const reg = await deployRegistry();
    const f = reg.interface.getFunction("latest");
    expect(f.outputs.map((o) => `${o.type} ${o.name}`)).to.deep.equal([
      "uint64 epoch", "bytes32 stateHash", "bytes32 spikeRoot", "bytes32 inputHash", "uint64 time",
    ]);
  });

  after(() => {
    console.log("\n    gas used (tx receipts):");
    for (const [k, v] of Object.entries(GAS)) console.log(`      ${k.padEnd(46)} ${v}`);
  });
});
