// setToken(token, price) on FlyBrainRegistry. ONE-WAY: the token can never be changed again.
//   local:   TOKEN=mock PRICE=1000 npx hardhat run scripts/set-token.js --network localhost
//   mainnet: CONFIRM_MAINNET=yes PRICE=<tokens per neuron> npx hardhat run scripts/set-token.js --network bsc
// REGISTRY env or deployments/<chainId>.json; TOKEN env or TOKEN_ADDRESS in ../.env
// (TOKEN=mock deploys a MockBEP20 first, local chains only); PRICE in whole tokens (uses the
// token's decimals) or PRICE_WEI in base units.
// Before mainnet: simulate a claim with the real token on a local fork (fee-on-transfer tokens
// make every claim revert, and setToken cannot be undone).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { readEnv, mainnetGuard, LOCAL_CHAINS } = require("./lib");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  mainnetGuard(chainId);
  const local = LOCAL_CHAINS.has(chainId);
  const env = readEnv();

  const depFile = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  const registry = process.env.REGISTRY || (fs.existsSync(depFile) && JSON.parse(fs.readFileSync(depFile, "utf8")).address);
  if (!registry || !ethers.isAddress(registry)) throw new Error("no REGISTRY and no deployments file");

  let signer;
  if (local) {
    [signer] = await ethers.getSigners();
  } else {
    if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");
    signer = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, ethers.provider);
  }

  const reg = await ethers.getContractAt("FlyBrainRegistry", registry, signer);
  const current = await reg.token();
  if (current !== ethers.ZeroAddress) throw new Error(`token already set to ${current} (locked forever)`);
  const owner = await reg.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signer ${signer.address} is not owner ${owner}`);

  let tokenAddr = process.env.TOKEN || env.TOKEN_ADDRESS;
  if (tokenAddr === "mock") {
    if (!local) throw new Error("TOKEN=mock is local only");
    const m = await (await ethers.getContractFactory("MockBEP20", signer)).deploy("Mock Fly", "MFLY");
    await m.waitForDeployment();
    tokenAddr = await m.getAddress();
    console.log("deployed MockBEP20", tokenAddr);
  }
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) throw new Error("TOKEN / TOKEN_ADDRESS not set");

  const erc = new ethers.Contract(tokenAddr, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], ethers.provider);
  const decimals = Number(await erc.decimals());
  const symbol = await erc.symbol();
  let price;
  if (process.env.PRICE_WEI) price = BigInt(process.env.PRICE_WEI);
  else if (process.env.PRICE) price = ethers.parseUnits(process.env.PRICE, decimals);
  else throw new Error("set PRICE (whole tokens) or PRICE_WEI");
  if (price <= 0n) throw new Error("price must be > 0");

  console.log(`chain ${chainId} registry ${registry} token ${tokenAddr} (${symbol}, ${decimals} dec) price ${ethers.formatUnits(price, decimals)} per neuron`);
  const tx = await reg.setToken(tokenAddr, price);
  const rc = await tx.wait();
  console.log(`setToken tx ${tx.hash} gas ${rc.gasUsed}; token() = ${await reg.token()}, pricePerNeuron() = ${await reg.pricePerNeuron()}`);

  if (fs.existsSync(depFile)) {
    const d = JSON.parse(fs.readFileSync(depFile, "utf8"));
    if (d.address.toLowerCase() === registry.toLowerCase()) {
      Object.assign(d, { token: tokenAddr, pricePerNeuron: price.toString(), setTokenTx: tx.hash });
      fs.writeFileSync(depFile, JSON.stringify(d, null, 2) + "\n");
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
