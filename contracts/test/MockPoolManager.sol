// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TickMath} from "../src/vendor/TickMath.sol";
import {SqrtPriceMath} from "../src/vendor/SqrtPriceMath.sol";
import {PoolKeyV2, ModifyLiquidityParamsV2} from "../src/RangeDesk.sol";
import {MToken} from "./Mocks.sol";

interface IUnlockCallbackM {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// A PoolManager stand-in with v4's call shapes (unlock, modifyLiquidity, sync, settle, take, extsload)
/// and v4's single-sided deposit math. Fills are driven by the test, at a price the test chooses, which is
/// what makes the ledger's attribution checkable to the wei. Real v4 behaviour is covered in ForkDesk.t.sol.
contract MPoolManager {
    uint256 internal constant SCALE = 1e36;

    MToken public immutable rf;
    MToken public immutable weth;
    int24 public tick;

    struct Pos {
        uint128 liq;
        uint256 amt0;   // RF held by the position
        uint256 amt1;   // WETH held by the position
    }

    mapping(bytes32 => Pos) public pos;
    address internal locker;
    int256 internal d0;
    int256 internal d1;
    address internal synced;
    uint256 internal syncedBal;

    constructor(MToken r, MToken w, int24 t) {
        rf = r;
        weth = w;
        tick = t;
    }

    bool public dead;   // models a PoolManager that reverts everything

    function setTick(int24 t) external { tick = t; }
    function setDead(bool d) external { dead = d; }

    bool public uninitialized;   // slot0 reads as zero, like a pool that was never initialized
    function setUninitialized(bool u) external { uninitialized = u; }

    function extsload(bytes32) external view returns (bytes32) {
        require(!dead, "dead");
        if (uninitialized) return bytes32(0);
        uint160 sp = TickMath.getSqrtPriceAtTick(tick);
        return bytes32((uint256(uint24(tick)) << 160) | uint256(sp));
    }

    function key(address o, int24 lo, int24 hi, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(o, lo, hi, salt));
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!dead, "dead");
        require(locker == address(0), "locked");
        locker = msg.sender;
        r = IUnlockCallbackM(msg.sender).unlockCallback(data);
        require(d0 == 0 && d1 == 0, "CurrencyNotSettled");
        locker = address(0);
    }

    function modifyLiquidity(PoolKeyV2 memory k, ModifyLiquidityParamsV2 memory p, bytes calldata)
        external
        returns (int256 callerDelta, int256 fees)
    {
        require(msg.sender == locker, "not locker");
        require(k.currency0 == address(rf) && k.currency1 == address(weth), "key");
        Pos storage s = pos[key(msg.sender, p.tickLower, p.tickUpper, p.salt)];
        int256 a0;
        int256 a1;
        if (p.liquidityDelta > 0) {
            uint128 l = uint128(uint256(p.liquidityDelta));
            uint160 sa = TickMath.getSqrtPriceAtTick(p.tickLower);
            uint160 sb = TickMath.getSqrtPriceAtTick(p.tickUpper);
            uint256 x;
            uint256 y;
            if (tick < p.tickLower) x = SqrtPriceMath.getAmount0Delta(sa, sb, l, true);
            else if (tick >= p.tickUpper) y = SqrtPriceMath.getAmount1Delta(sa, sb, l, true);
            else revert("in range: both tokens");
            s.liq += l;
            s.amt0 += x;
            s.amt1 += y;
            a0 = -int256(x);
            a1 = -int256(y);
        } else {
            uint128 l = uint128(uint256(-p.liquidityDelta));
            require(l <= s.liq, "liq");
            uint256 x = s.amt0 * l / s.liq;
            uint256 y = s.amt1 * l / s.liq;
            s.liq -= l;
            s.amt0 -= x;
            s.amt1 -= y;
            a0 = int256(x);
            a1 = int256(y);
        }
        d0 += a0;
        d1 += a1;
        assembly {
            callerDelta := or(shl(128, a0), and(sub(shl(128, 1), 1), a1))
        }
        fees = 0;
    }

    function sync(address c) external {
        synced = c;
        syncedBal = MToken(c).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = MToken(synced).balanceOf(address(this)) - syncedBal;
        if (synced == address(rf)) d0 += int256(paid);
        else d1 += int256(paid);
        synced = address(0);
    }

    function take(address c, address to, uint256 amount) external {
        MToken(c).transfer(to, amount);
        if (c == address(rf)) d0 -= int256(amount);
        else d1 -= int256(amount);
    }

    /* ======================================================= test drivers */

    /// Price crosses a position: convert `bps` of what it holds at `wethPerRf` (SCALE). An ask sells RF,
    /// a bid buys RF. Calling it the other way round models the price crossing back (un-filling).
    function fill(address o, int24 lo, int24 hi, bytes32 salt, bool sellRf, uint256 bps, uint256 wethPerRf) external {
        Pos storage s = pos[key(o, lo, hi, salt)];
        if (sellRf) {
            uint256 x = s.amt0 * bps / 10_000;
            uint256 y = x * wethPerRf / SCALE;
            s.amt0 -= x;
            s.amt1 += y;
            weth.mint(address(this), y);
        } else {
            uint256 y = s.amt1 * bps / 10_000;
            uint256 x = y * SCALE / wethPerRf;
            s.amt1 -= y;
            s.amt0 += x;
            rf.mint(address(this), x);
        }
    }

    /// v4 `donate`: anyone can gift in-range positions. Here it lands on one position.
    function donate(address o, int24 lo, int24 hi, bytes32 salt, uint256 x, uint256 y) external {
        Pos storage s = pos[key(o, lo, hi, salt)];
        s.amt0 += x;
        s.amt1 += y;
        rf.mint(address(this), x);
        weth.mint(address(this), y);
    }
}

contract MHook {
    address public rewards;
    bytes32 public poolId;
    constructor(address r) { rewards = r; }
    function setRewards(address r) external { rewards = r; }
    /// Report the id of the (rf, weth, 0x800000, 60, this) pool, as the real hook does.
    function setPool(address rf, address weth) external {
        poolId = keccak256(abi.encode(rf, weth, uint24(0x800000), int24(60), address(this)));
    }
}
