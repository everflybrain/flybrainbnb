// Shared helpers for deploy scripts. Never log values read from .env except public addresses.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT, ".env");

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// DESIGN.md section 5: seed = sha256("flybrainbnb/perm/v1" || connectomeHash)
function derivePerm(connectomeHashHex, n) {
  const N = BigInt(n);
  const hash = Buffer.from(connectomeHashHex.replace(/^0x/, ""), "hex");
  if (hash.length !== 32) throw new Error("connectomeHash must be 32 bytes");
  const seed = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("flybrainbnb/perm/v1", "utf8"), hash])).digest();
  let permMul = BigInt("0x" + seed.subarray(0, 8).toString("hex")) % N;
  for (let i = 0n; i < N; i++) {
    if (permMul > 1n && gcd(permMul, N) === 1n) break;
    permMul = (permMul + 1n) % N;
  }
  if (!(permMul > 1n && gcd(permMul, N) === 1n)) throw new Error("no valid permMul for N");
  const permAdd = BigInt("0x" + seed.subarray(8, 16).toString("hex")) % N;
  return { permMul, permAdd };
}

function mainnetGuard(chainId) {
  if (Number(chainId) === 56 && process.env.CONFIRM_MAINNET !== "yes") {
    console.error("Refusing chain 56 (BSC mainnet). Set CONFIRM_MAINNET=yes to proceed.");
    process.exit(1);
  }
}

const LOCAL_CHAINS = new Set([31337, 1337]);

module.exports = { ROOT, readEnv, derivePerm, gcd, mainnetGuard, LOCAL_CHAINS };
