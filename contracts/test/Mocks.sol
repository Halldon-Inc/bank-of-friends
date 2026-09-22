// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/* Mocks that behave like the verified chain facts (see ForkProbe.t.sol):
   - a Friend's wallet is an ERC-6551 account whose `execute` is owner-only, CALL only
   - the wallet address never changes when the NFT is sold, and allowances it granted survive the sale
   - ActivationManager.claim is permissionless and credits the Friend's wallet, never the caller */

contract MToken {
    string public symbol;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s) { symbol = s; }

    mapping(address => bool) public blocked;   // simulates a token hook that starts reverting for a sender

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setBlocked(address a, bool b) external { blocked[a] = b; }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(!blocked[msg.sender], "blocked");
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(!blocked[f], "blocked");
        require(balanceOf[f] >= a, "bal");
        if (allowance[f][msg.sender] != type(uint256).max) {
            require(allowance[f][msg.sender] >= a, "allow");
            allowance[f][msg.sender] -= a;
        }
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MTBA {
    error UnsupportedOperation();
    error NotOwner();

    MCollection public immutable collection;
    uint256 public immutable id;
    uint256 public state;

    constructor(MCollection c, uint256 i) { collection = c; id = i; }

    function owner() public view returns (address) { return collection.ownerOf(id); }

    function token() external view returns (uint256, address, uint256) {
        return (block.chainid, address(collection), id);
    }

    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory ret)
    {
        if (msg.sender != owner()) revert NotOwner();
        if (operation != 0) revert UnsupportedOperation();
        ++state;
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}

contract MCollection {
    mapping(uint256 => address) internal _owner;
    mapping(uint256 => address) public tokenBoundAccount;
    mapping(uint256 => uint8) internal _gen;

    /// Generations reports 0 for a temporary Friend. Everything minted here is gen 1 unless set.
    function generation(uint256 id) external view returns (uint8) { return _gen[id] == 0 ? 1 : _gen[id] - 1; }
    function setGeneration(uint256 id, uint8 g) external { _gen[id] = g + 1; }

    function mint(uint256 id, address to) external returns (address tba) {
        require(_owner[id] == address(0), "minted");
        _owner[id] = to;
        tba = address(new MTBA(this, id));
        tokenBoundAccount[id] = tba;
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = _owner[id];
        require(o != address(0), "nonexistent");
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(_owner[id] == from && msg.sender == from, "not owner");
        _owner[id] = to;
    }
}

/// A collection an attacker controls: claims any wallet it likes is its Friend's wallet.
contract EvilCollection {
    address public victimTba;
    address public attacker;
    constructor(address v, address a) { victimTba = v; attacker = a; }
    function ownerOf(uint256) external view returns (address) { return attacker; }
    function tokenBoundAccount(uint256) external view returns (address) { return victimTba; }
}

contract MActivation {
    mapping(bytes32 => uint256) public owed;
    bool public broken;

    function setBroken(bool b) external { broken = b; }

    // reward streams: `allocate` starts the next one once the current one has finished
    mapping(address => uint256) public pendingOf;
    mapping(address => uint256) public finishOf;
    uint256 public allocations;

    function setStream(address asset, uint256 pending, uint256 finish) external {
        pendingOf[asset] = pending;
        finishOf[asset] = finish;
    }

    function streams(address asset) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (pendingOf[asset], 0, finishOf[asset], 0, 0, 0);
    }

    function allocate(address asset) external {
        require(block.timestamp >= finishOf[asset] && pendingOf[asset] != 0, "StreamUnavailable");
        pendingOf[asset] = 0;
        finishOf[asset] = block.timestamp + 7 days;
        ++allocations;
    }

    function accrue(address asset, address c, uint256 id, uint256 amt) external {
        owed[keccak256(abi.encode(asset, c, id))] += amt;
    }

    function earned(address asset, address c, uint256 id) external view returns (uint256) {
        return owed[keccak256(abi.encode(asset, c, id))];
    }

    function claim(address asset, address c, uint256 id) external returns (uint256 amt) {
        require(!broken, "Retired");
        bytes32 k = keccak256(abi.encode(asset, c, id));
        amt = owed[k];
        require(amt != 0, "nothing");
        owed[k] = 0;
        MToken(asset).mint(MCollection(c).tokenBoundAccount(id), amt);
    }
}

/// Constant-price market with the pool's real 5% toll. `rfPerWeth` is WAD.
contract MMarket {
    MToken public rf;
    MToken public weth;
    uint256 public rfPerWeth = 1_750_000e18;
    uint256 public constant FEE_BPS = 500;

    constructor(MToken r, MToken w) { rf = r; weth = w; }

    function setPrice(uint256 p) external { rfPerWeth = p; }

    function swapExactInput(bool buy, uint256 amountIn, uint256 minOut, address recipient, uint256)
        external
        returns (uint256 out)
    {
        if (buy) {
            weth.transferFrom(msg.sender, address(this), amountIn);
            out = (amountIn * (10_000 - FEE_BPS) / 10_000) * rfPerWeth / 1e18;
            rf.mint(recipient, out);
        } else {
            rf.transferFrom(msg.sender, address(this), amountIn);
            out = (amountIn * (10_000 - FEE_BPS) / 10_000) * 1e18 / rfPerWeth;
            weth.mint(recipient, out);
        }
        require(out >= minOut, "slippage");
    }
}

/// A multisig-like contract that owns a Friend and acts through arbitrary calls.
contract MSafe {
    address public admin;
    constructor(address a) { admin = a; }
    function exec(address to, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == admin, "admin");
        bool ok;
        (ok, ret) = to.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}
