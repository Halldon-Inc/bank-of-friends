// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Base.sol";
import {RangeDesk} from "../src/RangeDesk.sol";
import {PoolObserver} from "../src/PoolObserver.sol";

/// The maker-only desk against a PoolManager stand-in whose fills the test controls to the wei.
/// Real Uniswap v4 behaviour is covered on a fork in ForkDesk.t.sol.
contract DeskTest is Base {
    RangeDesk desk;

    function setUp() public override {
        super.setUp();
        desk = bank.DESK();
    }

    /// Move the pool and poke until the truncated record has caught up.
    function moveAndSettleTwap(int24 t) internal {
        pm.setTick(t);
        for (uint256 i; i < 240; ++i) {
            bank.poke();
            vm.warp(block.timestamp + 5 minutes);
        }
        bank.poke();
    }

    function sumLines(address[3] memory hs) internal view returns (uint256[4] memory t) {
        for (uint256 i; i < 3; ++i) {
            uint256[4] memory v = bank.lineOf(hs[i]);
            for (uint256 k; k < 4; ++k) t[k] += v[k];
        }
    }

    function assertBookHolds(address[3] memory hs) internal view {
        uint256[4] memory t = sumLines(hs);
        (, , uint256 askUnits) = bank.ask();
        (, , uint256 bidUnits) = bank.bid();
        assertLe(t[0], bank.bookR(), "idle RF claims > book");
        assertLe(t[1], bank.bookW(), "idle WETH claims > book");
        assertLe(t[2], askUnits, "ask units claimed > range units");
        assertLe(t[3], bidUnits, "bid units claimed > range units");
        assertLe(bank.bookR(), rf.balanceOf(address(bank)));
        assertLe(bank.bookW(), weth.balanceOf(address(bank)));
    }

    /* ====================================================== attribution */

    function test_AskProceedsGoOnlyToTheHoldersWhoFundedIt() public {
        member(genesis, 1, alice, 1_000e18, 0);
        member(genesis, 2, bob, 3_000e18, 0);
        readyTwap();
        placeAsk(600e18);                                // 15% of the RF side
        uint256[4] memory a0 = line(alice);
        uint256[4] memory b0 = line(bob);
        assertApproxEqRel(a0[2] * 3, b0[2], 1e12, "units split 1:3, like the RF that funded them");

        member(genesis, 3, carol, 2_000e18, 0);          // joins AFTER the range opened
        fillAsk(5_000, px(ASK_LO + 300));
        closeAsk();

        uint256[4] memory a1 = line(alice);
        uint256[4] memory b1 = line(bob);
        uint256[4] memory c1 = line(carol);
        assertEq(c1[0], 2_000e18, "the later depositor shares nothing of the range");
        assertEq(c1[1], 0);
        assertGt(a1[1], 0);
        assertApproxEqRel(a1[1] * 3, b1[1], 1e12, "WETH proceeds split 1:3");
        assertEq(a1[2] + b1[2], 0, "units are spent at close");
        assertBookHolds([alice, bob, carol]);
    }

    function test_BidProceedsGoOnlyToTheHoldersWhoFundedIt() public {
        member(genesis, 1, alice, 0, 0.4e18);
        member(genesis, 2, bob, 0, 0.2e18);
        readyTwap();
        placeBid(0.09e18);
        member(genesis, 3, carol, 0, 0.5e18);
        fillBid(10_000, px(BID_LO + 300));
        closeBid();
        uint256[4] memory a = line(alice);
        uint256[4] memory b = line(bob);
        assertApproxEqRel(a[0], b[0] * 2, 1e12, "RF bought splits 2:1");
        assertEq(line(carol)[0], 0);
        assertEq(line(carol)[1], 0.5e18);
        assertBookHolds([alice, bob, carol]);
    }

    /// redteam note 2: a holder who exits mid-range is paid their share once, and the later close cannot
    /// pay them again or shortchange anyone else.
    function test_ExitMidRangeThenCloseNeverPaysTwice() public {
        member(genesis, 1, alice, 1_000e18, 0);
        member(genesis, 2, bob, 1_000e18, 0);
        readyTwap();
        placeAsk(300e18);
        fillAsk(4_000, px(ASK_LO + 200));

        vm.prank(alice);
        bank.exitRanges();
        uint256[4] memory a1 = line(alice);
        assertEq(a1[2], 0, "alice holds no more ask units");
        assertGt(a1[1], 0, "and has her share of what already filled");

        fillAsk(5_000, px(ASK_LO + 500));                // more fills after she left
        closeAsk();
        uint256[4] memory a2 = line(alice);
        assertEq(a2[0], a1[0], "the close pays alice nothing more");
        assertEq(a2[1], a1[1]);
        uint256[4] memory b2 = line(bob);
        assertGt(b2[1], a1[1], "bob kept the later fills");
        assertBookHolds([alice, bob, carol]);

        vm.prank(alice);
        bank.withdrawAll(alice);
        vm.prank(bob);
        bank.withdrawAll(bob);                           // the last one out still gets paid
    }

    function test_WithdrawAllIncludesAnOpenRange() public {
        member(genesis, 1, alice, 1_000e18, 0.1e18);
        readyTwap();
        placeAsk(100e18);
        fillAsk(10_000, px(ASK_LO + 300));
        vm.prank(alice);
        bank.withdrawAll(alice);
        uint256[4] memory a = line(alice);
        assertEq(a[0] + a[1] + a[2] + a[3], 0);
        assertGt(weth.balanceOf(alice), 0.1e18, "idle WETH plus the ask's proceeds");
    }

    function test_DonationToARangeGoesToItsFunders() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        placeAsk(100e18);
        member(genesis, 2, bob, 1_000e18, 0);
        pm.donate(address(desk), ASK_LO, ASK_HI, bytes32(uint256(1)), 0, 0.01e18);
        closeAsk();
        assertApproxEqAbs(line(alice)[1], 0.01e18, 2, "the donation lands on the range's funders");
        assertEq(line(bob)[1], 0);
    }

    function test_RoundingNeverOverAllocates() public {
        member(genesis, 1, alice, 1_000e18 + 1, 0);
        member(genesis, 2, bob, 1_000e18 + 1, 0);
        readyTwap();
        placeAsk(200e18 + 7);
        fillAsk(3_333, px(ASK_LO + 100) + 1);            // odd proceeds that cannot split evenly
        closeAsk();
        assertBookHolds([alice, bob, carol]);
        vm.prank(alice);
        bank.withdrawAll(alice);
        vm.prank(bob);
        bank.withdrawAll(bob);
    }

    /* ============================================== exit liveness (keeper-free) */

    function test_ExitAndCloseWorkWithoutKeeperOrRewardsContract() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        placeAsk(100e18);
        am.setBroken(true);                               // migrateRewards retired the manager
        hook.setRewards(address(0xDEAD));                 // and the fee was redirected
        bank.removeKeeper();
        vm.prank(alice);
        bank.exitRanges();                                // her share, no keeper
        assertEq(line(alice)[2], 0);
        vm.prank(carol);
        bank.closeAsk();                                  // anyone may close once there is no keeper
    }

    function test_IdleWithdrawNeverTouchesThePool() public {
        member(genesis, 1, alice, 1_000e18, 0.1e18);
        pm.setDead(true);                                 // the PoolManager reverts everything
        vm.startPrank(alice);
        bank.withdrawRF(500e18, alice);
        bank.withdrawWETH(0.1e18, alice);
        vm.stopPrank();
        accrue(genesis, 1, 0, 0.01e18);
        vm.warp(block.timestamp + 10 minutes);            // past the poke gap, so collect really calls the pool
        collect1(genesis, 1);                             // and harvesting does not depend on it either
        assertGt(line(alice)[1], 0);
    }

    function test_StrangerCannotCloseBeforeTtl_CanAfter() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        placeAsk(100e18);
        vm.prank(carol);
        vm.expectRevert(FriendBank.NotCloseable.selector);
        bank.closeAsk();
        vm.warp(block.timestamp + 7 days);
        vm.prank(carol);
        bank.closeAsk();
    }

    function test_AnyoneClosesWhileHalted() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        placeAsk(100e18);
        bank.setQuotingHalted(true);
        vm.prank(carol);
        bank.closeAsk();
    }

    /* ======================================================= price rules */

    function test_TwapMustExistBeforeAnyRange() public {
        member(genesis, 1, alice, 1_000e18, 0);
        vm.prank(keeper);
        vm.expectRevert(PoolObserver.TwapNotReady.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 100e18);
    }

    function test_PokeMovesTheRecordAtMostHalfAPercent() public {
        readyTwap();
        PoolObserver o = bank.OBSERVER();
        pm.setTick(SPOT + 5_000);                         // a 65% pump
        vm.warp(block.timestamp + 5 minutes);
        bank.poke();
        assertEq(o.lastTick(), SPOT + 50, "one poke follows by 50 ticks, no more");
    }

    /// redteam G: the keeper dumps the pool and rests an ask just above the price it depressed.
    function test_G_AskNearADepressedSpotIsRefused() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        pm.setTick(SPOT - 3_000);                         // pushed down 26%
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.TooCloseToTwap.selector);
        bank.placeAsk(SPOT - 2_940, SPOT - 2_340, 100e18);
    }

    function test_G_BidNearAPumpedSpotIsRefused() public {
        member(genesis, 1, alice, 0, 0.5e18);
        readyTwap();
        pm.setTick(SPOT + 3_000);
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.TooCloseToTwap.selector);
        bank.placeBid(SPOT + 2_340, SPOT + 2_940, 0.05e18);
    }

    function test_RangeMustBeSingleSided() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.WrongSideOfSpot.selector);
        bank.placeAsk(SPOT - 60, SPOT + 600, 100e18);     // straddles spot
    }

    /// Establish a cost basis: buy RF with a bid that fills at `price`.
    function buyAt(uint256 wethAmount, uint256 price) internal {
        placeBid(wethAmount);
        fillBid(10_000, price);
        closeBid();
    }

    /// redteam I: the lock uses the SIZE-WEIGHTED cost of the RF held, so a small fill cannot certify a big one.
    function test_I_CostBasisIsSizeWeighted() public {
        member(genesis, 1, alice, 0, 1e18);
        readyTwap();
        uint256 pHigh = px(BID_HI);
        uint256 pLow = px(BID_LO);
        buyAt(0.01e18, pHigh);                            // small, dear
        buyAt(0.1e18, pLow);                              // large, cheap
        uint256 avg = desk.avgCostWethPerRf();
        uint256 rfSmall = 0.01e18 * SCALE / pHigh;
        uint256 rfLarge = 0.1e18 * SCALE / pLow;
        uint256 expected = (0.11e18) * SCALE / (rfSmall + rfLarge);
        assertApproxEqRel(avg, expected, 1e14, "weighted by size, not the last fill");
    }

    /// The lock: with RF bought at cost C, an ask priced below C x 1.05 needs loss budget.
    function test_AskBelowCostPlusLockNeedsBudget() public {
        member(genesis, 1, alice, 0, 1e18);
        readyTwap();
        buyAt(0.15e18, px(BID_LO + 300));                 // cost basis about 6% below spot
        bank.tightenCaps(1500, 5000, 0, 100);             // owner sets the loss budget to zero
        moveAndSettleTwap(SPOT - 1_200);                  // price falls ~11%, below cost
        uint256 rfSide = bank.bookR();
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.LossBudgetExceeded.selector);
        bank.placeAsk(SPOT - 1_200 + 300, SPOT - 1_200 + 900, rfSide / 10);
    }

    /// redteam H: the desk can still cut a loss, within a small rolling budget.
    function test_H_CanCutALossWithinTheBudget() public {
        member(genesis, 1, alice, 0, 1e18);
        readyTwap();
        buyAt(0.15e18, px(BID_LO + 300));
        moveAndSettleTwap(SPOT - 6_000);                  // a 45% fall
        uint256 rfSide = bank.bookR();
        vm.startPrank(keeper);
        bank.placeAsk(SPOT - 6_000 + 300, SPOT - 6_000 + 900, rfSide / 50);   // a small loss-cutting ask: allowed
        assertGt(desk.lossSpentWeth(), 0, "and it spent budget");
        bank.closeAsk();
        vm.stopPrank();
        bank.tightenCaps(1500, 5000, 10, 100);            // 0.1% budget
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.LossBudgetExceeded.selector);
        bank.placeAsk(SPOT - 6_000 + 300, SPOT - 6_000 + 900, rfSide * 15 / 100);
    }

    function test_AskAboveCostPlusLockIsFree() public {
        member(genesis, 1, alice, 0, 1e18);
        readyTwap();
        buyAt(0.15e18, px(BID_LO));                       // cost ~9% below spot
        uint256 rfSide = bank.bookR();
        placeAsk(rfSide / 10);                            // ask ~3% above spot: > cost x 1.05
        assertEq(desk.lossSpentWeth(), 0);
    }

    function test_BidMustSitBelowLastSaleMinusLock() public {
        member(genesis, 1, alice, 2_000e18, 0.5e18);
        readyTwap();
        placeAsk(200e18);
        fillAsk(10_000, px(ASK_LO));                      // sold at the ask's floor
        closeAsk();
        vm.prank(keeper);
        vm.expectRevert(RangeDesk.LossLocked.selector);
        bank.placeBid(SPOT - 660, SPOT - 120, 0.05e18);   // only ~4% under the sale: refused
        placeBid(0.05e18);                                // ~6% under: allowed
        vm.prank(keeper);
        bank.closeBid();
        vm.warp(block.timestamp + 31 days);
        readyTwap();
        vm.prank(keeper);
        bank.placeBid(SPOT - 660, SPOT - 120, 0.05e18);   // the lock lapses after 30 days
    }

    /// redteam note 6: a range that fills and un-fills realizes nothing.
    function test_CrossAndUncrossRealizesNothing() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        placeAsk(100e18);
        uint256 p = px(ASK_LO + 300);
        fillAsk(10_000, p);
        pm.fill(address(desk), ASK_LO, ASK_HI, bytes32(uint256(1)), false, 10_000, p);   // price comes back
        closeAsk();
        assertEq(desk.lastSellWethPerRf(), 0, "no sale was realized, so no sale price is recorded");
        assertApproxEqAbs(line(alice)[0], 1_000e18, 1e6);
    }

    /* ==================================================== caps (B, C, D) */

    /// redteam B: open-and-close churn costs nothing (no fills, no toll) and is capped at 24 modifies a day.
    function test_B_ChurnCostsNothingAndIsCapped() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        uint256[4] memory before = line(alice);
        for (uint256 i; i < 12; ++i) {
            placeAsk(20e18);
            closeAsk();
        }
        uint256[4] memory afterward = line(alice);
        assertApproxEqAbs(afterward[0], before[0], 12, "twelve unfilled round trips cost nothing");
        vm.prank(keeper);
        vm.expectRevert(FriendBank.TooManyModifies.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 20e18);
    }

    /// redteam C: dust ranges are refused, so the step log grows by at most 24 a day.
    function test_C_DustRangesRefused() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        vm.prank(keeper);
        vm.expectRevert(FriendBank.TooSmall.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 9e18);              // under 1% of the RF side
    }

    /// redteam D: turnover is a rolling window, so there is no midnight reset to straddle.
    function test_D_NoMidnightReset() public {
        member(genesis, 1, alice, 10_000e18, 0);
        vm.warp((block.timestamp / 1 days + 1) * 1 days - 80 minutes);
        readyTwap();                                      // ends at 23:50 UTC
        for (uint256 i; i < 3; ++i) {                     // 3 x 15% = 45% just before midnight
            placeAsk(bank.bookR() * 15 / 100);
            closeAsk();
        }
        vm.warp((block.timestamp / 1 days + 1) * 1 days + 2 minutes);    // 00:02 UTC
        bank.poke();
        uint256 amt = bank.bookR() * 15 / 100;
        vm.prank(keeper);
        vm.expectRevert(FriendBank.CapTooHigh.selector);
        bank.placeAsk(ASK_LO, ASK_HI, amt);
    }

    function test_OnlyKeeperPlaces() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        vm.prank(alice);
        vm.expectRevert(FriendBank.NotKeeper.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 100e18);
        vm.prank(bank.owner());
        vm.expectRevert(FriendBank.NotKeeper.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 100e18);
    }

    function test_SizeCap() public {
        member(genesis, 1, alice, 1_000e18, 0);
        readyTwap();
        vm.prank(keeper);
        vm.expectRevert(FriendBank.CapTooHigh.selector);
        bank.placeAsk(ASK_LO, ASK_HI, 151e18);
    }

    function _cfg() internal view returns (FriendBank.Config memory) {
        return FriendBank.Config({
            rf: address(rf), weth: address(weth), activation: address(am), genesis: address(genesis),
            generations: address(gens), poolManager: address(pm), hook: address(hook), poolFee: 0x800000,
            tickSpacing: 60, keeper: keeper
        });
    }

    /// A key that is not the hook's pool (e.g. fee 0 instead of the dynamic-fee flag) fails at deploy.
    function test_DeployRefusesAWrongPoolKey() public {
        FriendBank.Config memory c = _cfg();
        c.poolFee = 0;
        vm.expectRevert(RangeDesk.WrongPool.selector);
        new FriendBank(c);
    }

    /// A slot that reads as zero (wrong layout, or an uninitialized pool) fails at deploy.
    function test_DeployRefusesAnUnreadablePool() public {
        pm.setUninitialized(true);
        vm.expectRevert(PoolObserver.BadSlot0.selector);
        new FriendBank(_cfg());
    }

    /// With ranges open, totals report idle books plus the units deposited into each range, and they bound
    /// the sum of every holder's line (rounding only ever leaves dust on the Bank's side).
    function test_BankTotalsWithOpenRanges() public {
        member(genesis, 1, alice, 1_000e18, 0.3e18);
        member(genesis, 2, bob, 3_000e18, 0.1e18);
        readyTwap();
        placeAsk(600e18);
        placeBid(0.05e18);
        fillAsk(4_000, px(ASK_LO + 300));
        (uint256 rI, uint256 wI, uint256 rA, uint256 wB,,) = bank.bankTotals();
        uint256[4] memory t = sumLines([alice, bob, carol]);
        assertGe(rI, t[0]); assertGe(wI, t[1]); assertGe(rA, t[2]); assertGe(wB, t[3]);
        assertApproxEqAbs(rA, t[2], 2);
        assertApproxEqAbs(wB, t[3], 2);
        (, , uint256 askUnits) = bank.ask();
        assertEq(rA, askUnits, "the ask is reported as what went in, not the live RF/WETH mix");
    }

    function test_DeskOnlyAnswersTheBank() public {
        vm.expectRevert(RangeDesk.NotBank.selector);
        desk.open(true, ASK_LO, ASK_HI, 1, 1, 1);
        vm.expectRevert(RangeDesk.NotBank.selector);
        desk.remove(true, 1, 1, true, 1, 1);
        vm.expectRevert(RangeDesk.NotPoolManager.selector);
        desk.unlockCallback("");
    }

    /* ============================================================ ledger */

    /// Nothing bob does, other than sharing a range both funded, can change alice's line.
    function testFuzz_Isolation(uint96 bobReward, uint16 bobWithdrawBps, bool bobExits, bool bobSells, bool bobLeaves)
        public
    {
        member(genesis, 1, alice, 1_000e18, 0.3e18);
        member(genesis, 2, bob, 2_000e18, 0.1e18);
        readyTwap();
        placeAsk(300e18);
        placeBid(0.05e18);
        fillAsk(3_000, px(ASK_LO + 200));
        uint256[4] memory a0 = line(alice);

        accrue(genesis, 2, uint256(bobReward) % 1e24, uint256(bobReward) % 1e17);
        _collectAs(bob, genesis, 2);
        if (bobExits) {
            vm.prank(bob);
            bank.exitRanges();
        }
        uint256[4] memory b = line(bob);
        uint256 bps = uint256(bobWithdrawBps) % 10_001;
        vm.prank(bob);
        bank.withdraw(b[0] * bps / 10_000, b[1] * bps / 10_000, bob);
        if (bobLeaves) {
            vm.prank(bob);
            bank.leave(address(genesis), 2);
        }
        if (bobSells) {
            vm.prank(bob);
            genesis.transferFrom(bob, carol, 2);
            collect1(genesis, 2);
        }
        weth.mint(address(bank), uint256(bobReward));
        rf.mint(address(bank), uint256(bobReward));

        uint256[4] memory a1 = line(alice);
        for (uint256 k; k < 4; ++k) assertEq(a1[k], a0[k], "alice's line moved");
    }

    function testFuzz_ClaimsNeverExceedTheBook(uint256 seed) public {
        member(genesis, 1, alice, 3_000e18, 0.4e18);
        member(genesis, 2, bob, 1_000e18, 0.2e18);
        member(genesis, 3, carol, 7e18, 0.05e18);
        readyTwap();
        for (uint256 i; i < 16; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 6;
            vm.warp(block.timestamp + 2 hours);
            bank.poke();
            (bool aOpen,,) = bank.ask();
            (bool bOpen,,) = bank.bid();
            vm.startPrank(keeper);
            if (op == 0 && !aOpen) try bank.placeAsk(ASK_LO, ASK_HI, bank.bookR() * (100 + (seed >> 8) % 1300) / 10_000) {} catch {}
            else if (op == 1 && !bOpen) try bank.placeBid(BID_LO, BID_HI, bank.bookW() * (100 + (seed >> 8) % 1300) / 10_000) {} catch {}
            else if (op == 2 && aOpen) bank.closeAsk();
            else if (op == 3 && bOpen) bank.closeBid();
            vm.stopPrank();
            if (op == 4 && aOpen) fillAsk((seed >> 16) % 10_001, px(ASK_LO) + (seed >> 40) % 1e29);
            if (op == 5 && bOpen) fillBid((seed >> 16) % 10_001, px(BID_HI) - (seed >> 40) % 1e29);
            if (seed % 5 == 0) {
                vm.prank(bob);
                bank.exitRanges();
            }
            assertBookHolds([alice, bob, carol]);
        }
        vm.startPrank(keeper);
        (bool ao,,) = bank.ask();
        (bool bo,,) = bank.bid();
        if (ao) bank.closeAsk();
        if (bo) bank.closeBid();
        vm.stopPrank();
        vm.prank(alice); bank.withdrawAll(alice);
        vm.prank(bob); bank.withdrawAll(bob);
        vm.prank(carol); bank.withdrawAll(carol);
    }

    function test_FarBehindHolderSettlesInChunksThenExits() public {
        member(genesis, 1, alice, 10_000e18, 0);
        readyTwap();
        for (uint256 i; i < 150; ++i) {
            if (i % 10 == 0) {
                vm.warp(block.timestamp + 1 days);
                readyTwap();
            }
            placeAsk(bank.bookR() / 50);
            closeAsk();
        }
        assertEq(bank.stepsBehind(alice), 300);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        assertEq(am.earned(address(weth), address(genesis), 1), 0.01e18, "too far behind: skipped, not lost");
        uint256 g = gasleft();
        bank.settle(alice, 150);
        emit log_named_uint("settle gas per step", (g - gasleft()) / 150);
        bank.settle(alice, 150);
        assertEq(bank.stepsBehind(alice), 0);
        collect1(genesis, 1);
        assertEq(am.earned(address(weth), address(genesis), 1), 0);
        vm.prank(alice);
        bank.withdrawAll(alice);
    }
}
