// Site configuration. Token address and price are never set here:
// they are always read from the registry contract (token(), pricePerNeuron(), remaining()).
window.FLY_CONFIG = {
  BRAIN_API: "https://brain-production-2ead.up.railway.app",  // Railway brain service (empty = brain offline)
  REGISTRY_ADDRESS: "",   // FlyBrainRegistry on BNB Smart Chain (set when the fresh registry is deployed)
  CHAIN_ID: 56,
  RPC_URL: "https://bsc-rpc.publicnode.com",
  EXPLORER: "https://bscscan.com",
  REPO: "https://github.com/fruitflydev/everflybrain"
};
