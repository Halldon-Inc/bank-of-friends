// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/FriendBank.sol";
import {TickMath} from "../src/vendor/TickMath.sol";
import "./Mocks.sol";
import "./MockPoolManager.sol";

contract Base is Test {
    MToken rf;
    MToken weth;
    MCollection genesis;
    MCollection gens;
    MActivation am;
    MPoolManager pm;
    MHook hook;
    FriendBank bank;

    address keeper = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    uint128 constant CAP_RF = 1_000_000e18;
    uint128 constant CAP_WETH = 1e18;
    uint256 constant SCALE = 1e36;

    /// About 5.8e-7 WETH per RF, the live pool's neighbourhood. A multiple of the tick spacing (60).
    int24 constant SPOT = -143580;
    int24 constant ASK_LO = SPOT + 300;
    int24 constant ASK_HI = SPOT + 900;
    int24 constant BID_HI = SPOT - 300;
    int24 constant BID_LO = SPOT - 900;

    function setUp() public virtual {
        MToken a = new MToken("A");
        MToken b = new MToken("B");
        (rf, weth) = address(a) < address(b) ? (a, b) : (b, a);   // v4 sorts currencies: RF is currency0
        genesis = new MCollection();
        gens = new MCollection();
        am = new MActivation();
        pm = new MPoolManager(rf, weth, SPOT);
        hook = new MHook(address(am));
        hook.setPool(address(rf), address(weth));
        bank = new FriendBank(FriendBank.Config({
            rf: address(rf),
            weth: address(weth),
            activation: address(am),
            genesis: address(genesis),
            generations: address(gens),
            poolManager: address(pm),
            hook: address(hook),
            poolFee: 0x800000,
            tickSpacing: 60,
            keeper: keeper
        }));
        vm.fee(0.05 gwei);
    }

    /* ============================================================ harvest */

    /// The exact signup a holder performs: two approvals through the Friend's own wallet, then join.
    function signUp(MCollection c, uint256 id, address who) internal returns (address tba) {
        tba = c.tokenBoundAccount(id);
        vm.startPrank(who);
        MTBA(tba).execute(address(rf), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        bank.join(address(c), id, CAP_RF, CAP_WETH, false);
        vm.stopPrank();
    }

    function collect1(MCollection c, uint256 id) internal {
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        cs[0] = address(c);
        ids[0] = id;
        vm.prank(keeper);
        bank.collect(cs, ids);
    }

    function _collectAs(address who, MCollection c, uint256 id) internal {
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        (cs[0], ids[0]) = (address(c), id);
        vm.prank(who);
        bank.collect(cs, ids);
    }

    function accrue(MCollection c, uint256 id, uint256 r, uint256 w) internal {
        if (r != 0) am.accrue(address(rf), address(c), id, r);
        if (w != 0) am.accrue(address(weth), address(c), id, w);
    }

    function claim(address h) internal view returns (uint256 r, uint256 w) {
        return bank.claimOf(h);
    }

    /// Mint a Friend to `who`, sign up, and deposit exactly (r, w) through a collect by the holder (no tip).
    function member(MCollection c, uint256 id, address who, uint256 r, uint256 w) internal {
        c.mint(id, who);
        signUp(c, id, who);
        accrue(c, id, r, w);
        _collectAs(who, c, id);
    }

    /* =============================================================== desk */

    /// Poke every 5 minutes for 65 minutes so a TWAP exists.
    function readyTwap() internal {
        for (uint256 i; i < 14; ++i) {
            bank.poke();
            vm.warp(block.timestamp + 5 minutes);
        }
        bank.poke();
    }

    function placeAsk(uint256 amount) internal {
        vm.prank(keeper);
        bank.placeAsk(ASK_LO, ASK_HI, amount);
    }

    function placeBid(uint256 amount) internal {
        vm.prank(keeper);
        bank.placeBid(BID_LO, BID_HI, amount);
    }

    function fillAsk(uint256 bps, uint256 price) internal {
        pm.fill(address(bank.DESK()), ASK_LO, ASK_HI, bytes32(uint256(1)), true, bps, price);
    }

    function fillBid(uint256 bps, uint256 price) internal {
        pm.fill(address(bank.DESK()), BID_LO, BID_HI, bytes32(uint256(2)), false, bps, price);
    }

    function closeAsk() internal {
        vm.prank(keeper);
        bank.closeAsk();
    }

    function closeBid() internal {
        vm.prank(keeper);
        bank.closeBid();
    }

    /// WETH per RF at a tick, SCALE.
    function px(int24 t) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(t);
        return (s * s / 2 ** 96) * SCALE / 2 ** 96;
    }

    function line(address h) internal view returns (uint256[4] memory) {
        return bank.lineOf(h);
    }
}
