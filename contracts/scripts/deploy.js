// Deploy FlyBrainRegistry.
//   local:   npx hardhat run scripts/deploy.js --network localhost
//   mainnet: CONFIRM_MAINNET=yes npx hardhat run scripts/deploy.js --network bsc   (owner only)
// Params: DEPLOY_PARAMS=<path> or ../brain/assets/deploy_params.json (written by brain/make_assets.py).
// permMul/permAdd are always re-derived here from connectomeHash and must match the file.
// Signer: hardhat account #0 on local chains; DEPLOYER_PRIVATE_KEY from ../.env elsewhere.
// Operator: OPERATOR_ADDRESS from ../.env (public), or OPERATOR env override.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ROOT, readEnv, derivePerm, mainnetGuard, LOCAL_CHAINS } = require("./lib");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  mainnetGuard(chainId);
  const local = LOCAL_CHAINS.has(chainId);
  const env = readEnv();

  const paramsPath = process.env.DEPLOY_PARAMS || path.join(ROOT, "brain", "assets", "deploy_params.json");
  let params;
  if (fs.existsSync(paramsPath)) {
    params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
    console.log("params:", paramsPath);
  } else if (local) {
    const h = ethers.sha256(ethers.toUtf8Bytes("flybrainbnb/dev-placeholder"));
    params = { neuronCount: 165122, connectomeHash: h, neuronTableHash: h, placeholder: true };
    console.log("WARNING: no deploy_params.json, using placeholder hashes (local chain only)");
  } else {
    throw new Error(`missing ${paramsPath}; run brain/make_assets.py first`);
  }

  const N = Number(params.neuronCount);
  const isHash = (x) => /^0x[0-9a-fA-F]{64}$/.test(x || "");
  if (!Number.isInteger(N) || N <= 1 || N >= 2 ** 32) throw new Error("bad neuronCount");
  if (!isHash(params.connectomeHash) || !isHash(params.neuronTableHash)) throw new Error("bad hashes in params");
  if (!local && (/^0x0{64}$/.test(params.neuronTableHash) || params.placeholder)) throw new Error("placeholder params refused off local chains");

  const { permMul, permAdd } = derivePerm(params.connectomeHash, N);
  for (const [k, v] of [["permMul", permMul], ["permAdd", permAdd]]) {
    if (params[k] !== undefined && BigInt(params[k]) !== v) throw new Error(`${k} in params (${params[k]}) != derived (${v})`);
  }

  const operator = process.env.OPERATOR || env.OPERATOR_ADDRESS;
  if (!operator || !ethers.isAddress(operator)) throw new Error("OPERATOR_ADDRESS missing in .env");

  let signer;
  if (local) {
    [signer] = await ethers.getSigners();
  } else {
    if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");
    signer = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, ethers.provider);
    if (env.DEPLOYER_ADDRESS && signer.address.toLowerCase() !== env.DEPLOYER_ADDRESS.toLowerCase()) {
      throw new Error("DEPLOYER_PRIVATE_KEY does not match DEPLOYER_ADDRESS");
    }
  }

  const bal = await ethers.provider.getBalance(signer.address);
  console.log(`chain ${chainId}  deployer ${signer.address}  balance ${ethers.formatEther(bal)}`);
  console.log(`operator ${operator}  N ${N}  permMul ${permMul}  permAdd ${permAdd}`);
  console.log(`connectomeHash ${params.connectomeHash}\nneuronTableHash ${params.neuronTableHash}`);

  const F = await ethers.getContractFactory("FlyBrainRegistry", signer);
  const reg = await F.deploy(N, params.connectomeHash, params.neuronTableHash, operator, permMul, permAdd);
  const tx = reg.deploymentTransaction();
  const rc = await tx.wait();
  const address = await reg.getAddress();

  // read back
  const check = {
    neuronCount: Number(await reg.neuronCount()),
    connectomeHash: await reg.connectomeHash(),
    neuronTableHash: await reg.neuronTableHash(),
    permMul: (await reg.permMul()).toString(),
    permAdd: (await reg.permAdd()).toString(),
    permInv: (await reg.permInv()).toString(),
    owner: await reg.owner(),
    operator: await reg.operator(),
  };
  if (check.neuronCount !== N || check.permMul !== permMul.toString() || check.operator.toLowerCase() !== operator.toLowerCase()) {
    throw new Error("read-back mismatch");
  }
  if ((BigInt(check.permMul) * BigInt(check.permInv)) % BigInt(N) !== 1n) throw new Error("permInv read-back wrong");

  const out = {
    chainId,
    address,
    txHash: tx.hash,
    blockNumber: rc.blockNumber,
    gasUsed: rc.gasUsed.toString(),
    deployer: signer.address,
    ...check,
    channelsHash: params.channelsHash || null,
    placeholder: !!params.placeholder,
    paramsFile: path.relative(ROOT, paramsPath).replace(/\\/g, "/"),
    compiler: { solc: "0.8.24", optimizerRuns: 200, evmVersion: "shanghai" },
    deployedAt: new Date().toISOString(),
  };
  if (hre.network.name === "hardhat") {
    console.log(`FlyBrainRegistry ${address}  gas ${rc.gasUsed}  (in-memory chain, deployments file not written)`);
    return;
  }
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`FlyBrainRegistry ${address}  gas ${rc.gasUsed}  -> ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
