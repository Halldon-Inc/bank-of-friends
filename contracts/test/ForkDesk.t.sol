// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/FriendBank.sol";
import {RangeDesk, PoolKeyV2} from "../src/RangeDesk.sol";
import {PoolObserver} from "../src/PoolObserver.sol";
import {TickMath} from "../src/vendor/TickMath.sol";

interface ITBAf {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

interface INFTf {
    function ownerOf(uint256) external view returns (address);
    function tokenBoundAccount(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}

struct SwapParamsF {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPMf {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKeyV2 memory key, SwapParamsF memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IAMf {
    function migrateRewards(address asset, address recipient, uint256 amount) external;
    function owner() external view returns (address);
}

/// An outside trader moving the real pool through the real hook (5% toll and all), to fill the Bank's ranges.
contract Pusher {
    IPMf immutable pm;
    PoolKeyV2 key;

    constructor(address p, PoolKeyV2 memory k) {
        pm = IPMf(p);
        key = k;
    }

    function push(bool rfForWeth, uint256 amountIn, int24 limitTick) external {
        pm.unlock(abi.encode(rfForWeth, amountIn, TickMath.getSqrtPriceAtTick(limitTick)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (bool zf1, uint256 amt, uint160 lim) = abi.decode(data, (bool, uint256, uint160));
        int256 d = pm.swap(key, SwapParamsF(zf1, -int256(amt), lim), "");
        _square(key.currency0, int128(d >> 128));
        _square(key.currency1, int128(d));
        return "";
    }

    function _square(address c, int128 a) internal {
        if (a < 0) {
            pm.sync(c);
            IERC20V2(c).transfer(address(pm), uint256(uint128(-a)));
            pm.settle();
        } else if (a > 0) {
            pm.take(c, address(this), uint256(uint128(a)));
        }
    }
}

/// The maker-only desk against REAL Robinhood Chain state on a local fork (nothing is broadcast):
/// the real v4 PoolManager and pool, the real hook, a real Genesis and its real ERC-6551 wallet.
contract ForkDesk is Test {
    address constant HUNT = 0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF;   // never used (Hunt ruling)
    address constant RF = 0x0779369854d3EcdEA927206718FFD7730C67B71f;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant GENESIS = 0x116EaA62241751E0c98dA43d458600c6C17cD361;
    address constant GENS = 0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D;
    address constant AM = 0xD4A35e11318E3679168d409184B788bcF9F283Ac;
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0x7A65d0194e6Cc43971C31CE7D1471Da01D42A0cC;
    address constant KEEPER = address(0x4EE9E4);
    uint256 constant SCALE = 1e36;

    FriendBank bank;
    PoolObserver obs;
    Pusher pusher;
    address holder;
    uint256 enrolledId;
    int24 spot;

    function setUp() public {
        vm.createSelectFork("robinhood");   // latest block: the public RPC keeps no archive state
        bank = new FriendBank(FriendBank.Config({
            rf: RF, weth: WETH, activation: AM, genesis: GENESIS, generations: GENS,
            poolManager: PM, hook: HOOK, poolFee: 0x800000, tickSpacing: 60, keeper: KEEPER
        }));
        obs = bank.OBSERVER();
        pusher = new Pusher(PM, PoolKeyV2(RF, WETH, 0x800000, 60, HOOK));
        spot = obs.spotTick();

        // a real Genesis with rewards, enrolled exactly as a holder would
        uint256 id;
        for (uint256 i = 1; i <= 40; ++i) {
            try IActivationManagerV2(AM).earned(WETH, GENESIS, i) returns (uint256 e) {
                if (i == 259 || INFTf(GENESIS).ownerOf(i) == HUNT) continue;
                if (e > 1e14 && IActivationManagerV2(AM).earned(RF, GENESIS, i) > 100e18) { id = i; break; }
            } catch {}
        }
        require(id != 0, "no earning Genesis");
        enrolledId = id;
        holder = INFTf(GENESIS).ownerOf(id);
        address tba = INFTf(GENESIS).tokenBoundAccount(id);
        vm.startPrank(holder);
        ITBAf(tba).execute(RF, 0, abi.encodeCall(IERC20V2.approve, (address(bank), type(uint256).max)), 0);
        ITBAf(tba).execute(WETH, 0, abi.encodeCall(IERC20V2.approve, (address(bank), type(uint256).max)), 0);
        bank.join(GENESIS, id, type(uint128).max, type(uint128).max, false);
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        (cs[0], ids[0]) = (GENESIS, id);
        bank.collect(cs, ids);
        vm.stopPrank();
        require(bank.bookR() > 0 && bank.bookW() > 0, "nothing collected");

        for (uint256 i; i < 14; ++i) {                      // a TWAP, from the real pool
            bank.poke();
            vm.warp(block.timestamp + 5 minutes);
        }
        bank.poke();
        deal(WETH, address(pusher), 200e18);
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 r = t / 60 * 60;
        return r > t ? r - 60 : r;
    }

    function _px(int24 t) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(t);
        return (s * s / 2 ** 96) * SCALE / 2 ** 96;
    }

    /// A real ask fills when an outside buyer pushes the real pool through it, and pays NO hook fee:
    /// the RF sold fetches at least the range's lowest price.
    function test_fork_AskFillsAsMakerWithNoHookFee() public {
        int24 lo = _floor(spot) + 180;
        int24 hi = lo + 300;
        uint256 amount = bank.bookR() * 15 / 100;
        vm.prank(KEEPER);
        bank.placeAsk(lo, hi, amount);
        (, , uint256 units) = bank.ask();
        emit log_named_int("spot tick", spot);
        emit log_named_uint("ask units (RF)", units);

        pusher.push(false, 200e18, hi + 60);                 // an outside buyer lifts the price through the ask
        emit log_named_int("spot after push", obs.spotTick());

        uint256 w0 = bank.bookW();
        vm.prank(KEEPER);
        bank.closeAsk();
        uint256 got = bank.bookW() - w0;
        emit log_named_uint("WETH received for the RF", got);
        assertGe(got, units * _px(lo) / SCALE, "sold at or above the range's lowest price: no 5% toll");
        assertLe(got, units * _px(hi) / SCALE + 1, "and no more than its highest");
        uint256[4] memory v = bank.lineOf(holder);
        assertEq(v[2], 0);
        assertLe(v[1], bank.bookW());
    }

    /// A real bid fills when an outside seller pushes the price down through it.
    function test_fork_BidFillsAsMaker() public {
        int24 hi = _floor(spot) - 180;
        int24 lo = hi - 300;
        uint256 amount = bank.bookW() * 15 / 100;
        vm.prank(KEEPER);
        bank.placeBid(lo, hi, amount);
        (, , uint256 units) = bank.bid();

        deal(RF, address(pusher), 500_000_000e18);
        pusher.push(true, 500_000_000e18, lo - 60);          // an outside seller dumps RF through the bid
        emit log_named_int("spot after dump", obs.spotTick());

        uint256 r0 = bank.bookR();
        vm.prank(KEEPER);
        bank.closeBid();
        uint256 got = bank.bookR() - r0;
        emit log_named_uint("RF bought with the bid's WETH", got);
        assertGe(got * _px(hi) / SCALE + 1, units, "paid no more than the range's highest price");
    }

    /// The exit path survives the rewards contract being retired: modifyLiquidity never touches the hook.
    function test_fork_ExitSurvivesMigrateRewards() public {
        int24 lo = _floor(spot) + 180;
        uint256 amount = bank.bookR() * 15 / 100;
        vm.prank(KEEPER);
        bank.placeAsk(lo, lo + 300, amount);
        address amOwner = IAMf(AM).owner();
        vm.prank(amOwner);
        IAMf(AM).migrateRewards(WETH, amOwner, 1);           // retires the manager (fork simulation only)
        vm.prank(holder);
        bank.exitRanges();
        assertEq(bank.lineOf(holder)[2], 0);
        vm.prank(holder);
        bank.withdrawAll(holder);
    }

    /// One-call close on the real pool, after the rewards contract is retired (fork simulation only).
    function test_fork_CloseAfterMigrateRewards() public {
        int24 lo = _floor(spot) + 180;
        uint256 amount = bank.bookR() * 15 / 100;
        vm.prank(KEEPER);
        bank.placeAsk(lo, lo + 300, amount);
        address amOwner = IAMf(AM).owner();
        vm.prank(amOwner);
        IAMf(AM).migrateRewards(WETH, amOwner, 1);
        (address[] memory cs, uint256[] memory ids) = (new address[](1), new uint256[](1));
        cs[0] = GENESIS;
        ids[0] = enrolledId;
        uint256 r0 = IERC20V2(RF).balanceOf(holder);
        vm.prank(holder);
        bank.close(cs, ids, holder);
        uint256[4] memory v = bank.lineOf(holder);
        assertEq(v[0] + v[1] + v[2] + v[3], 0, "everything went home");
        assertGt(IERC20V2(RF).balanceOf(holder), r0);
        assertFalse(bank.friendOf(GENESIS, enrolledId).active);
    }
}
