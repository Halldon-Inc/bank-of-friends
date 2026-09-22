// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "./vendor/TickMath.sol";
import {LiquidityAmounts} from "./vendor/LiquidityAmounts.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * @title PoolObserver
 * @notice A truncated, time-weighted record of the RF/WETH pool's price that anyone can update. The Bank's
 *         desk may only rest ranges on the far side of this price, never of the spot price, which the
 *         keeper could have moved in the same block.
 *
 *         Each poke may move the recorded tick at most MAX_TICK_STEP (about 0.5%) from the previous
 *         record, and pokes closer together than MIN_POKE_GAP are ignored. So pushing the pool, poking
 *         and pushing it back moves the record by 0.5% at most, and a sustained move is followed at up to
 *         about 6% an hour. A TWAP is usable only over at least TWAP_WINDOW with MIN_POKES records inside.
 *
 *         Honest limit: the pool charges 5% per side on swaps, so nobody arbitrages a mispricing under
 *         about 10%. A patient actor can hold spot, and so this record, up to ~10% off at no cost. The
 *         Bank's desk bounds per-range damage with this; it cannot remove it.
 */
contract PoolObserver {
    event Poked(int24 observedTick, int24 recordedTick);

    error TwapNotReady();
    error BadSlot0();

    int24 public constant MAX_TICK_STEP = 50;
    uint256 public constant MIN_POKE_GAP = 5 minutes;
    uint256 public constant TWAP_WINDOW = 1 hours;
    uint256 public constant MIN_POKES = 6;
    uint256 internal constant OBS = 64;

    IExtsload public immutable POOL_MANAGER;
    /// @dev pools[poolId].slot0 in the v4 PoolManager (StateLibrary: pools mapping at slot 6).
    bytes32 public immutable SLOT0;

    struct Obs {
        uint64 ts;
        int256 cum;   // sum of recordedTick * seconds
    }

    Obs[OBS] internal _obs;
    uint256 public obsCount;
    int24 public lastTick;
    uint64 public lastPokeAt;
    int256 public tickCum;

    constructor(address poolManager, bytes32 poolId) {
        POOL_MANAGER = IExtsload(poolManager);
        SLOT0 = keccak256(abi.encode(poolId, uint256(6)));
        // A wrong slot or an uninitialized pool reads as zero or garbage. Fail at deploy instead.
        uint160 sp = uint160(uint256(IExtsload(poolManager).extsload(SLOT0)));
        if (sp < TickMath.MIN_SQRT_PRICE || sp >= TickMath.MAX_SQRT_PRICE) revert BadSlot0();
    }

    function spotTick() public view returns (int24 tick) {
        uint256 word = uint256(POOL_MANAGER.extsload(SLOT0));
        tick = int24(int256(word >> 160));
    }

    function poke() external {
        if (obsCount != 0 && block.timestamp < uint256(lastPokeAt) + MIN_POKE_GAP) return;
        int24 spot = spotTick();
        int24 rec = spot;
        if (obsCount != 0) {
            tickCum += int256(lastTick) * int256(block.timestamp - uint256(lastPokeAt));
            if (spot > lastTick + MAX_TICK_STEP) rec = lastTick + MAX_TICK_STEP;
            else if (spot < lastTick - MAX_TICK_STEP) rec = lastTick - MAX_TICK_STEP;
        }
        lastTick = rec;
        lastPokeAt = uint64(block.timestamp);
        _obs[obsCount % OBS] = Obs(uint64(block.timestamp), tickCum);
        ++obsCount;
        emit Poked(spot, rec);
    }

    /// @notice Time-weighted recorded tick over at least TWAP_WINDOW. Reverts until there are MIN_POKES
    ///         records inside the window and one at or before its start.
    function twapTick() public view returns (int24) {
        uint256 n = obsCount;
        if (n == 0) revert TwapNotReady();
        uint256 cutoff = block.timestamp > TWAP_WINDOW ? block.timestamp - TWAP_WINDOW : 0;
        int256 cumNow = tickCum + int256(lastTick) * int256(block.timestamp - uint256(lastPokeAt));
        uint256 inside;
        uint256 lookback = n < OBS ? n : OBS;
        for (uint256 i = 1; i <= lookback; ++i) {
            Obs memory o = _obs[(n - i) % OBS];
            if (o.ts > cutoff || o.ts == block.timestamp) {
                ++inside;
                continue;
            }
            if (inside < MIN_POKES) revert TwapNotReady();
            return int24((cumNow - o.cum) / int256(block.timestamp - uint256(o.ts)));
        }
        revert TwapNotReady();
    }

    /// @notice The TWAP if there is one, else the last record. Used only to size the loss budget.
    function twapTickOrLast() external view returns (int24) {
        try this.twapTick() returns (int24 t) {
            return t;
        } catch {
            return lastTick;
        }
    }
}

/// @notice Tick and liquidity math for the desk.
library DeskMath {
    uint256 internal constant SCALE = 1e36;
    uint256 internal constant Q96 = 2 ** 96;

    function validTicks(int24 lo, int24 hi, int24 spacing) internal pure returns (bool) {
        return lo < hi && lo % spacing == 0 && hi % spacing == 0 && lo >= TickMath.MIN_TICK && hi <= TickMath.MAX_TICK;
    }

    /// @notice WETH per RF at a tick, SCALE, rounded down.
    function priceAt(int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return Math.mulDiv(Math.mulDiv(s, s, Q96), SCALE, Q96);
    }

    /// @notice WETH per RF at a tick, SCALE, rounded up.
    function priceAtCeil(int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return Math.mulDiv(Math.mulDiv(s, s, Q96, Math.Rounding.Ceil), SCALE, Q96, Math.Rounding.Ceil);
    }

    /// @notice Liquidity for a single-sided range holding `amount` of currency0 (RF) or currency1 (WETH).
    function liquidityFor(int24 lo, int24 hi, uint256 amount, bool rf) internal pure returns (uint128) {
        uint160 sa = TickMath.getSqrtPriceAtTick(lo);
        uint160 sb = TickMath.getSqrtPriceAtTick(hi);
        return rf
            ? LiquidityAmounts.getLiquidityForAmount0(sa, sb, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sa, sb, amount);
    }
}
