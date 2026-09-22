// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolObserver, DeskMath} from "./PoolObserver.sol";

interface IHookD {
    function poolId() external view returns (bytes32);
}

interface IERC20D {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @dev The subset of Uniswap v4's IPoolManager the desk uses. ABI-identical to v4-core.
struct PoolKeyV2 {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParamsV2 {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerV2 {
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKeyV2 memory key, ModifyLiquidityParamsV2 memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * @title RangeDesk
 * @notice The Bank's maker-only desk. It holds at most one ASK (a single-sided range of RF above the price)
 *         and one BID (a single-sided range of WETH below it) on the RF/WETH v4 pool. It never swaps. It is
 *         deployed by, and callable only by, the Bank, which owns every holder's attribution; the desk only
 *         owns the ranges' geometry and the price rules. After every call it hands every token it holds back
 *         to the Bank, which measures what it got from its own balances.
 *
 *         Rules enforced at placement:
 *         - the range is entirely on the correct side of spot (single-sided);
 *         - and at least twapEdgeTicks beyond the observer's truncated TWAP, so a spot the keeper has just
 *           moved cannot be used as the reference;
 *         - an ask's lowest price >= size-weighted average cost of the RF the desk bought x (1 + LOCK_BPS),
 *           unless the shortfall below that is reserved from a rolling loss budget (so a loss can be cut);
 *         - a bid's highest price <= the last sale's average price x (1 - LOCK_BPS) while that sale is
 *           within BID_LOCK_WINDOW. Bids never spend loss budget.
 *         Loss is charged on what was REALIZED when the range is removed, not on the placement price.
 */
contract RangeDesk {
    error NotBank();
    error NotPoolManager();
    error BadTicks();
    error WrongSideOfSpot();
    error TooCloseToTwap();
    error LossLocked();
    error LossBudgetExceeded();
    error BadDelta();
    error TransferFailed();
    error OnlyTightening();
    error WrongPool();

    uint256 internal constant SCALE = 1e36;
    uint256 internal constant BPS = 10_000;

    /// @notice The loss-lock, agreed with quant (lib/strategy.mjs DEFAULT_GATES.lockBps = 500).
    uint256 public constant LOCK_BPS = 500;
    uint256 public constant BID_LOCK_WINDOW = 30 days;
    uint256 public constant LOSS_WINDOW = 30 days;

    bytes32 internal constant ASK_SALT = bytes32(uint256(1));
    bytes32 internal constant BID_SALT = bytes32(uint256(2));

    address public immutable BANK;
    address public immutable RF;
    address public immutable WETH;
    IPoolManagerV2 public immutable POOL_MANAGER;
    address public immutable HOOK;
    uint24 public immutable POOL_FEE;
    int24 public immutable TICK_SPACING;
    PoolObserver public immutable OBSERVER;

    /// @dev Tighten only, through the Bank's owner.
    uint256 public lossBudgetBps = 500;
    int24 public twapEdgeTicks = 100;

    uint256 public lossSpentWeth;
    uint256 public lossAt;
    uint256 public costRf;
    uint256 public costWeth;
    uint256 public lastSellWethPerRf;   // SCALE
    uint256 public lastSellAt;

    struct Geo {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 input;       // the input asset still deposited (reduced pro rata by holder exits)
        uint256 reserved;    // loss budget reserved at placement (asks only)
    }

    Geo public ask;
    Geo public bid;
    bool private _inUnlock;

    event LossCharged(uint256 shortfall, uint256 lossSpentWeth);

    modifier onlyBank() {
        if (msg.sender != BANK) revert NotBank();
        _;
    }

    constructor(address rf, address weth, address poolManager, address hook, uint24 fee, int24 spacing) {
        BANK = msg.sender;
        RF = rf;
        WETH = weth;
        POOL_MANAGER = IPoolManagerV2(poolManager);
        HOOK = hook;
        POOL_FEE = fee;
        TICK_SPACING = spacing;
        // A wrong key (the fee field is v4's dynamic-fee flag 0x800000 on this pool, not 0) would watch a pool
        // that does not exist. Fail at deploy instead: the id must be the one the pool's own hook reports.
        bytes32 id = keccak256(abi.encode(rf, weth, fee, spacing, hook));
        if (IHookD(hook).poolId() != id) revert WrongPool();
        OBSERVER = new PoolObserver(poolManager, id);
    }

    /* ================================================================= BANK API */

    /// @notice Rest a range with the `amount` the Bank has just transferred in. Returns what it did not use.
    /// @param rfHeld  all RF the Bank holds for holders (idle plus open ask), for the loss budget
    /// @param wethHeld all WETH likewise
    function open(bool isAsk, int24 lo, int24 hi, uint256 amount, uint256 rfHeld, uint256 wethHeld)
        external
        onlyBank
        returns (uint128 liq)
    {
        if (!DeskMath.validTicks(lo, hi, TICK_SPACING)) revert BadTicks();
        OBSERVER.poke();
        int24 spot = OBSERVER.spotTick();
        if (isAsk ? spot >= lo : spot < hi) revert WrongSideOfSpot();
        int24 twap = OBSERVER.twapTick();
        if (isAsk ? lo < twap + twapEdgeTicks : hi > twap - twapEdgeTicks) revert TooCloseToTwap();

        uint256 reserve;
        if (isAsk) {
            if (costRf != 0) {
                uint256 lowest = DeskMath.priceAt(lo);
                uint256 lockPrice = Math.mulDiv(costWeth, SCALE * (BPS + LOCK_BPS), costRf * BPS, Math.Rounding.Ceil);
                if (lowest < lockPrice) {
                    reserve = Math.mulDiv(amount, lockPrice - lowest, SCALE, Math.Rounding.Ceil);
                    _decayLoss(rfHeld, wethHeld, twap);
                    lossSpentWeth += reserve;
                    if (lossSpentWeth > _lossCap(rfHeld, wethHeld, twap)) revert LossBudgetExceeded();
                }
            }
        } else if (lastSellWethPerRf != 0 && block.timestamp <= lastSellAt + BID_LOCK_WINDOW) {
            if (DeskMath.priceAtCeil(hi) * BPS > lastSellWethPerRf * (BPS - LOCK_BPS)) revert LossLocked();
        }

        liq = DeskMath.liquidityFor(lo, hi, amount, isAsk);
        uint256 r0 = _bal(RF);
        uint256 w0 = _bal(WETH);
        _unlockModify(lo, hi, int256(uint256(liq)), isAsk ? ASK_SALT : BID_SALT);
        uint256 r1 = _bal(RF);
        uint256 w1 = _bal(WETH);
        if (r1 > r0 || w1 > w0) revert BadDelta();
        uint256 used = isAsk ? r0 - r1 : w0 - w1;
        if (used == 0 || (isAsk ? w1 != w0 : r1 != r0)) revert BadDelta();   // single-sided or nothing

        Geo storage g = isAsk ? ask : bid;
        (g.tickLower, g.tickUpper, g.liquidity, g.input, g.reserved) = (lo, hi, liq, used, reserve);
        _sweepToBank();
    }

    /**
     * @notice Burn `num/den` of a range's liquidity (a holder's exit), or all of it (`closing`), and hand
     *         the proceeds to the Bank. Only `closing` does the cost-basis and loss accounting.
     */
    function remove(bool isAsk, uint256 num, uint256 den, bool closing, uint256 rfHeld, uint256 wethHeld)
        external
        onlyBank
        returns (uint256 shortfall)
    {
        Geo storage g = isAsk ? ask : bid;
        uint128 burn = closing ? g.liquidity : uint128(Math.mulDiv(g.liquidity, num, den));
        (uint256 rOut, uint256 wOut) = _burn(g, burn, isAsk ? ASK_SALT : BID_SALT);
        if (closing) {
            if (isAsk) shortfall = _accountAskClose(g, rOut, wOut, rfHeld, wethHeld);
            else _accountBidClose(g, rOut, wOut);
            if (isAsk) delete ask;
            else delete bid;
        } else if (burn != 0) {
            g.input -= Math.mulDiv(g.input, burn, g.liquidity);
            g.liquidity -= burn;
        }
        _sweepToBank();
    }

    function _burn(Geo storage g, uint128 burn, bytes32 salt) internal returns (uint256 rOut, uint256 wOut) {
        if (burn == 0) return (0, 0);
        uint256 r0 = _bal(RF);
        uint256 w0 = _bal(WETH);
        _unlockModify(g.tickLower, g.tickUpper, -int256(uint256(burn)), salt);
        rOut = _bal(RF) - r0;
        wOut = _bal(WETH) - w0;
    }

    function tighten(uint256 newLossBudgetBps, int24 newEdge) external onlyBank {
        if (newLossBudgetBps > lossBudgetBps || newEdge < twapEdgeTicks) revert OnlyTightening();
        lossBudgetBps = newLossBudgetBps;
        twapEdgeTicks = newEdge;
    }

    /* =============================================================== ACCOUNTING */

    function _accountAskClose(Geo storage g, uint256 rOut, uint256 wOut, uint256 rfHeld, uint256 wethHeld)
        internal
        returns (uint256 shortfall)
    {
        uint256 input = g.input;
        uint256 sold = input > rOut ? input - rOut : 0;
        if (sold != 0 && wOut != 0) {
            lastSellWethPerRf = Math.mulDiv(wOut, SCALE, sold);
            lastSellAt = block.timestamp;
        }
        if (costRf != 0 && sold != 0) {
            uint256 lockValue = Math.mulDiv(Math.mulDiv(costWeth, sold, costRf), BPS + LOCK_BPS, BPS);
            if (lockValue > wOut) shortfall = lockValue - wOut;
            // The bought-RF pool shrinks in proportion to the RF sold out of all the RF held.
            uint256 held = Math.max(rfHeld, sold);
            costWeth -= Math.mulDiv(costWeth, sold, held);
            costRf -= Math.mulDiv(costRf, sold, held);
        }
        _decayLoss(rfHeld, wethHeld, OBSERVER.twapTickOrLast());
        uint256 spent = lossSpentWeth > g.reserved ? lossSpentWeth - g.reserved : 0;
        lossSpentWeth = spent + shortfall;
        emit LossCharged(shortfall, lossSpentWeth);
    }

    function _accountBidClose(Geo storage g, uint256 rOut, uint256 wOut) internal {
        uint256 spent = g.input > wOut ? g.input - wOut : 0;
        if (rOut != 0 && spent != 0) {
            costRf += rOut;
            costWeth += spent;
        }
    }

    function _decayLoss(uint256 rfHeld, uint256 wethHeld, int24 twap) internal {
        uint256 d = Math.mulDiv(block.timestamp - lossAt, _lossCap(rfHeld, wethHeld, twap), LOSS_WINDOW);
        lossAt = block.timestamp;
        lossSpentWeth = lossSpentWeth > d ? lossSpentWeth - d : 0;
    }

    /// @dev lossBudgetBps of everything held, RF valued at the TWAP.
    function _lossCap(uint256 rfHeld, uint256 wethHeld, int24 twap) internal view returns (uint256) {
        uint256 rfValue = Math.mulDiv(rfHeld, DeskMath.priceAt(twap), SCALE);
        return Math.mulDiv(wethHeld + rfValue, lossBudgetBps, BPS);
    }

    function avgCostWethPerRf() external view returns (uint256) {
        return costRf == 0 ? 0 : Math.mulDiv(costWeth, SCALE, costRf);
    }

    /* =============================================================== v4 PLUMBING */

    function _unlockModify(int24 lo, int24 hi, int256 delta, bytes32 salt) internal {
        _inUnlock = true;
        POOL_MANAGER.unlock(abi.encode(lo, hi, delta, salt));
        _inUnlock = false;
    }

    /// @notice PoolManager callback. Only the PoolManager, and only inside the desk's own unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_inUnlock) revert NotPoolManager();
        (int24 lo, int24 hi, int256 delta, bytes32 salt) = abi.decode(data, (int24, int24, int256, bytes32));
        PoolKeyV2 memory key = PoolKeyV2(RF, WETH, POOL_FEE, TICK_SPACING, HOOK);
        (int256 d,) = POOL_MANAGER.modifyLiquidity(key, ModifyLiquidityParamsV2(lo, hi, delta, salt), "");
        _settleDelta(RF, int128(d >> 128));
        _settleDelta(WETH, int128(d));
        return "";
    }

    function _settleDelta(address currency, int128 amount) internal {
        if (amount < 0) {
            POOL_MANAGER.sync(currency);
            if (!IERC20D(currency).transfer(address(POOL_MANAGER), uint256(uint128(-amount)))) revert TransferFailed();
            POOL_MANAGER.settle();
        } else if (amount > 0) {
            POOL_MANAGER.take(currency, address(this), uint256(uint128(amount)));
        }
    }

    function _sweepToBank() internal {
        uint256 r = _bal(RF);
        uint256 w = _bal(WETH);
        if (r != 0 && !IERC20D(RF).transfer(BANK, r)) revert TransferFailed();
        if (w != 0 && !IERC20D(WETH).transfer(BANK, w)) revert TransferFailed();
    }

    function _bal(address t) internal view returns (uint256) {
        return IERC20D(t).balanceOf(address(this));
    }
}
