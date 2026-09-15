// Minimal ABIs. name/note are declared as `bytes` on the read paths: the ABI encoding of
// `string` and `bytes` is identical, but decoding as bytes never throws on invalid UTF-8
// (the contract stores raw bytes). We decode with TextDecoder (replacement characters).
window.FLY_ABI = {
  registry: [
    "function token() view returns (address)",
    "function pricePerNeuron() view returns (uint256)",
    "function remaining() view returns (uint32)",
    "function neuronCount() view returns (uint32)",
    "function permMul() view returns (uint256)",
    "function permAdd() view returns (uint256)",
    "function MAX_PER_CLAIM() view returns (uint32)",
    "function claimsCount() view returns (uint256)",
    "function connectomeHash() view returns (bytes32)",
    "function neuronTableHash() view returns (bytes32)",
    "function latest() view returns (uint64 epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash, uint64 time)",
    "function getClaim(uint256 id) view returns (tuple(address owner, uint32 start, uint32 count, uint64 time, uint256 burned, bytes name, bytes note))",
    "function claim(uint32 count, string name, string note) returns (uint256 claimId)"
  ],
  // event Claimed(uint256 indexed claimId, address indexed owner, uint32 start, uint32 count, uint256 burned, string name, string note)
  claimedSig: "Claimed(uint256,address,uint32,uint32,uint256,string,string)",
  claimedDataTypes: ["uint32", "uint32", "uint256", "bytes", "bytes"],
  erc20: [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
  ]
};
