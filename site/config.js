// Site configuration. Token address and price are never set here:
// they are always read from the registry contract (token(), pricePerNeuron(), remaining()).
window.FLY_CONFIG = {
  BRAIN_API: "https://brain-production-2ead.up.railway.app",  // Railway brain service (empty = brain offline)
  REGISTRY_ADDRESS: "0x42600a4FaC8CB14E283eFa18596E3f660339C964",   // TEST registry bound to the test coin; the real one is 0xe11a73Cea3feC43b300128B92b5E9efA8577afE6
  CHAIN_ID: 56,
  RPC_URL: "https://bsc-rpc.publicnode.com",
  EXPLORER: "https://bscscan.com",
  REPO: "https://github.com/fruitflydev/flybrainbnb"
};
