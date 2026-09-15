// Site configuration. Token address and price are never set here:
// they are always read from the registry contract (token(), pricePerNeuron(), remaining()).
window.FLY_CONFIG = {
  BRAIN_API: "",          // e.g. "https://flybrainbnb-production.up.railway.app" (empty = brain offline)
  REGISTRY_ADDRESS: "",   // FlyBrainRegistry on BNB Smart Chain (empty = not deployed yet)
  CHAIN_ID: 56,
  RPC_URL: "https://bsc-rpc.publicnode.com",
  EXPLORER: "https://bscscan.com",
  REPO: "https://github.com/fruitflydev/flybrainbnb"
};
