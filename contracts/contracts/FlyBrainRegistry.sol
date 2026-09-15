// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title FlyBrainRegistry
/// @notice On-chain memory for an off-chain fly brain simulation (real fly wiring, simplified
///         neurons). Holders burn tokens to 0x...dEaD to write a name and note onto a batch of
///         neurons forever. The operator writes a heartbeat (hashes of the brain state) per epoch.
///         No NFTs, no upgrades, no withdrawals, no payable functions.
contract FlyBrainRegistry {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint32 public constant MAX_PER_CLAIM = 5000;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_NOTE_BYTES = 140;
    uint256 public constant EPOCH_SECONDS = 600;

    uint32 public immutable neuronCount;
    bytes32 public immutable connectomeHash;
    bytes32 public immutable neuronTableHash;
    uint256 public immutable permMul;
    uint256 public immutable permAdd;
    uint256 public immutable permInv;

    struct Claim {
        address owner;
        uint32 start;
        uint32 count;
        uint64 time;
        uint256 burned;
        string name;
        string note;
    }

    struct Beat {
        uint64 epoch;
        bytes32 stateHash;
        bytes32 spikeRoot;
        bytes32 inputHash;
        uint64 time;
    }

    // Storage is packed by hand to keep claim() and heartbeat() cheap. The public getters keep
    // the ABI of DESIGN.md section 4.
    address public owner;                 // slot 0
    address public operator;              // slot 1 (20 bytes)
    uint64 private _beatEpoch;            // slot 1 (8 bytes)
    uint32 private _beatTime;             // slot 1 (4 bytes), unix seconds, fits until 2106
    address public token;                 // slot 2 (20 bytes)
    uint32 public claimedNeurons;         // slot 2 (4 bytes), next permutation index
    uint8 private _lock;                  // slot 2 (1 byte), reentrancy lock
    uint256 public pricePerNeuron;        // slot 3
    bytes32 private _stateHash;           // slot 4
    bytes32 private _spikeRoot;           // slot 5
    bytes32 private _inputHash;           // slot 6
    Claim[] internal _claims;             // slot 7

    event Claimed(uint256 indexed claimId, address indexed owner, uint32 start, uint32 count, uint256 burned, string name, string note);
    event Heartbeat(uint64 indexed epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash);
    event TokenSet(address token, uint256 pricePerNeuron);
    event PriceSet(uint256 pricePerNeuron);
    event OperatorSet(address operator);
    event OwnerSet(address owner);

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error BadParams();
    error TokenAlreadySet();
    error TokenNotSet();
    error NotAContract();
    error ZeroPrice();
    error BadCount();
    error SoldOut();
    error BadName();
    error BadNote();
    error Reentrancy();
    error TransferFailed();
    error BurnMismatch(uint256 expected, uint256 received);
    error EpochNotIncreasing();
    error EpochInFuture();
    error CostAboveMax(uint256 cost, uint256 maxBurn);
    error OutOfRange();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        uint32 neuronCount_,
        bytes32 connectomeHash_,
        bytes32 neuronTableHash_,
        address operator_,
        uint256 permMul_,
        uint256 permAdd_
    ) {
        if (operator_ == address(0)) revert ZeroAddress();
        if (neuronCount_ == 0 || permMul_ >= neuronCount_ || permAdd_ >= neuronCount_) revert BadParams();
        if (neuronCount_ > 1 && permMul_ == 0) revert BadParams();

        // Extended Euclid: permInv = permMul^-1 mod N, requires gcd(permMul, N) == 1.
        int256 n = int256(uint256(neuronCount_));
        int256 oldR = int256(permMul_);
        int256 r = n;
        int256 oldS = 1;
        int256 s = 0;
        while (r != 0) {
            int256 q = oldR / r;
            (oldR, r) = (r, oldR - q * r);
            (oldS, s) = (s, oldS - q * s);
        }
        if (neuronCount_ > 1 && oldR != 1) revert BadParams();
        int256 inv = oldS % n;
        if (inv < 0) inv += n;

        neuronCount = neuronCount_;
        connectomeHash = connectomeHash_;
        neuronTableHash = neuronTableHash_;
        permMul = permMul_;
        permAdd = permAdd_;
        permInv = neuronCount_ == 1 ? 0 : uint256(inv);
        owner = msg.sender;
        operator = operator_;
        emit OwnerSet(msg.sender);
        emit OperatorSet(operator_);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Sets the burn token and price. Can be called once; the token is locked forever.
    function setToken(address token_, uint256 price) external onlyOwner {
        if (token != address(0)) revert TokenAlreadySet();
        if (token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert NotAContract();
        if (price == 0) revert ZeroPrice();
        token = token_;
        pricePerNeuron = price;
        emit TokenSet(token_, price);
    }

    function setPrice(uint256 price) external onlyOwner {
        if (price == 0) revert ZeroPrice();
        pricePerNeuron = price;
        emit PriceSet(price);
    }

    function setOperator(address op) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operator = op;
        emit OperatorSet(op);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        owner = to;
        emit OwnerSet(to);
    }

    // ---------------------------------------------------------------- claims

    /// @notice Burns count * pricePerNeuron tokens to 0x...dEaD and records name + note on the next
    ///         `count` neurons of the fixed shuffled order. Nothing is returned; no NFT.
    /// @param maxBurn The most the caller agrees to burn (the cost they were shown). Reverts if the
    ///        price was raised in between, so a leftover allowance can never be charged more.
    function claim(uint32 count, string calldata name, string calldata note, uint256 maxBurn) external returns (uint256 claimId) {
        if (_lock != 0) revert Reentrancy();
        address t = token;
        if (t == address(0)) revert TokenNotSet();
        if (count == 0 || count > MAX_PER_CLAIM) revert BadCount();
        uint32 start = claimedNeurons;
        if (count > neuronCount - start) revert SoldOut();
        if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_BYTES) revert BadName();
        if (bytes(note).length > MAX_NOTE_BYTES) revert BadNote();

        _lock = 1;
        uint256 amount = uint256(count) * pricePerNeuron;
        if (amount > maxBurn) revert CostAboveMax(amount, maxBurn);
        _burn(t, amount);

        claimId = _claims.length;
        Claim storage c = _claims.push();
        c.owner = msg.sender;
        c.start = start;
        c.count = count;
        c.time = uint64(block.timestamp);
        c.burned = amount;
        c.name = name;
        c.note = note;
        claimedNeurons = start + count;
        _lock = 0;
        emit Claimed(claimId, msg.sender, start, count, amount, name, note);
    }

    /// @dev transferFrom(msg.sender, DEAD, amount); accepts empty return data or `true`, and
    ///      requires DEAD's balance to grow by exactly `amount` (rejects fee-on-transfer tokens).
    function _burn(address t, uint256 amount) private {
        uint256 before = IERC20(t).balanceOf(DEAD);
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, DEAD, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
        uint256 received = IERC20(t).balanceOf(DEAD) - before;
        if (received != amount) revert BurnMismatch(amount, received);
    }

    // ---------------------------------------------------------------- heartbeat

    function heartbeat(uint64 epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash) external {
        if (msg.sender != operator) revert NotOperator();
        if (epoch <= _beatEpoch) revert EpochNotIncreasing();
        // An epoch can never be ahead of real time (+1 for clock skew), so no single heartbeat,
        // even from a leaked operator key, can block the heartbeats of later epochs.
        if (epoch > block.timestamp / EPOCH_SECONDS + 1) revert EpochInFuture();
        _beatEpoch = epoch;
        _beatTime = uint32(block.timestamp);
        _stateHash = stateHash;
        _spikeRoot = spikeRoot;
        _inputHash = inputHash;
        emit Heartbeat(epoch, stateHash, spikeRoot, inputHash);
    }

    /// @notice Same ABI as `Beat public latest`.
    function latest() external view returns (uint64 epoch, bytes32 stateHash, bytes32 spikeRoot, bytes32 inputHash, uint64 time) {
        return (_beatEpoch, _stateHash, _spikeRoot, _inputHash, uint64(_beatTime));
    }

    // ---------------------------------------------------------------- views

    function claimsCount() external view returns (uint256) {
        return _claims.length;
    }

    function getClaim(uint256 id) external view returns (Claim memory) {
        if (id >= _claims.length) revert OutOfRange();
        return _claims[id];
    }

    /// @notice Neuron id (row in graph.npz) at permutation index `index`.
    function neuronAt(uint32 index) public view returns (uint32) {
        if (index >= neuronCount) revert OutOfRange();
        return uint32((permMul * index + permAdd) % neuronCount);
    }

    /// @notice Permutation index of neuron id `neuron` (inverse of neuronAt).
    function indexOfNeuron(uint32 neuron) public view returns (uint32) {
        if (neuron >= neuronCount) revert OutOfRange();
        return uint32((permInv * (uint256(neuron) + neuronCount - permAdd)) % neuronCount);
    }

    function claimOfNeuron(uint32 neuron) external view returns (bool claimed, uint256 claimId) {
        uint32 idx = indexOfNeuron(neuron);
        if (idx >= claimedNeurons) return (false, 0);
        // Claims are contiguous and ordered by start: find the last claim with start <= idx.
        uint256 lo = 0;
        uint256 hi = _claims.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (_claims[mid].start <= idx) lo = mid;
            else hi = mid - 1;
        }
        return (true, lo);
    }

    function remaining() external view returns (uint32) {
        return neuronCount - claimedNeurons;
    }
}
