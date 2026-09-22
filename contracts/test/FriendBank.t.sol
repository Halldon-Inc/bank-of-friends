// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Base.sol";

contract FriendBankTest is Base {
    /* ============================================================= signup */

    function test_SignupEntirelyThroughTheFriendWallet() public {
        genesis.mint(1, alice);
        address tba = genesis.tokenBoundAccount(1);
        vm.startPrank(alice);
        MTBA(tba).execute(address(rf), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        // join called BY the Friend's wallet: consent is proven by the fact that only the owner can make it call.
        MTBA(tba).execute(
            address(bank), 0, abi.encodeCall(FriendBank.join, (address(genesis), 1, CAP_RF, CAP_WETH, false)), 0
        );
        vm.stopPrank();
        assertEq(bank.friendOf(address(genesis), 1).holder, alice, "holder is the NFT owner, not the wallet");
    }

    function test_StrangerCannotJoinSomeoneElsesFriend() public {
        genesis.mint(1, alice);
        vm.prank(bob);
        vm.expectRevert(FriendBank.NotFriendOwner.selector);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);
    }

    function test_UnknownCollectionRejected_TheLegacyTheftPath() public {
        genesis.mint(1, alice);
        address victimTba = signUp(genesis, 1, alice);
        EvilCollection evil = new EvilCollection(victimTba, bob);
        vm.prank(bob);
        vm.expectRevert(FriendBank.UnknownCollection.selector);
        bank.join(address(evil), 1, CAP_RF, CAP_WETH, false);
    }

    /* ====================================================== rewards only */

    function test_PullsOnlyWhatItJustClaimed() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        weth.mint(tba, 50e18);          // the owner's own money, parked in the Friend's wallet
        rf.mint(tba, 9_000_000e18);
        accrue(genesis, 1, 1000e18, 0.01e18);

        collect1(genesis, 1);
        (uint256 r, uint256 w) = claim(alice);
        assertEq(r, 1000e18, "exactly the RF just claimed");
        assertApproxEqAbs(w, 0.01e18, 0.01e18 / 100, "exactly the WETH just claimed, less a bounded tip");
        assertEq(weth.balanceOf(tba), 50e18, "pre-existing WETH untouched");
        assertEq(rf.balanceOf(tba), 9_000_000e18, "pre-existing RF untouched");
    }

    function test_SomeoneElseClaimingFirstMeansNothingIsPulled() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.01e18);
        am.claim(address(weth), address(genesis), 1);   // e.g. the owner claims in the Rare Friends UI
        collect1(genesis, 1);
        (, uint256 w) = claim(alice);
        assertEq(w, 0, "the bank never sweeps a balance it did not just claim");
        assertEq(weth.balanceOf(tba), 0.01e18);
    }

    function test_PerAssetDailyCapInItsOwnUnits() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 3e18);                    // 3 WETH, cap is 1 WETH per day
        collect1(genesis, 1);
        (, uint256 w) = claim(alice);
        assertLe(w, 1e18);
        assertEq(weth.balanceOf(tba), 2e18, "the excess waits in the Friend's wallet");
        assertEq(bank.friendOf(address(genesis), 1).owedWeth, 2e18, "and is remembered as owed");
        vm.warp(block.timestamp + 1 days);
        collect1(genesis, 1);                           // nothing new claimed: the owed amount is paid down
        assertEq(weth.balanceOf(tba), 1e18, "one more day's cap, no more");
    }

    /* =========================================================== identity */

    function test_SaleSuspendsAndTheBuyerIsNeverTouched() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        accrue(genesis, 1, 500e18, 0.02e18);
        collect1(genesis, 1);
        (uint256 aliceR, uint256 aliceW) = claim(alice);

        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);            // sold. The allowance to the bank survives, as on chain.
        assertEq(weth.allowance(tba, address(bank)), type(uint256).max);

        accrue(genesis, 1, 700e18, 0.03e18);            // rewards that now belong to bob's Friend
        collect1(genesis, 1);
        assertFalse(bank.friendOf(address(genesis), 1).active, "suspended");
        (uint256 r2, uint256 w2) = claim(alice);
        assertEq(r2, aliceR, "alice gets nothing from bob's Friend");
        assertEq(w2, aliceW);
        (uint256 br, uint256 bw) = claim(bob);
        assertEq(br + bw, 0, "and bob was not enrolled by someone else's consent");
        assertEq(am.earned(address(weth), address(genesis), 1), 0.03e18, "bob's rewards were not even claimed");

        vm.prank(alice);
        bank.withdrawAll(alice);                        // the old owner keeps what was deposited under her
        assertEq(rf.balanceOf(alice), aliceR);
        assertEq(weth.balanceOf(alice), aliceW);
    }

    function test_BoughtBackStaysSuspendedUntilRejoined() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);
        bank.suspendIfTransferred(address(genesis), 1);  // anyone may do this
        vm.prank(bob);
        genesis.transferFrom(bob, alice, 1);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        (, uint256 w) = claim(alice);
        assertEq(w, 0, "suspension is sticky");
    }

    function test_NewOwnerCanOptInOnTheirOwnLine() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        (, uint256 aliceW) = claim(alice);
        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);

        vm.prank(bob);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);
        accrue(genesis, 1, 0, 0.02e18);
        collect1(genesis, 1);
        (, uint256 bobW) = claim(bob);
        (, uint256 aliceW2) = claim(alice);
        assertGt(bobW, 0);
        assertEq(aliceW2, aliceW, "alice's line is unchanged by bob's enrolment");
    }

    function test_OneOwnerManyFriendsBothCollections() public {
        genesis.mint(7, alice);
        gens.mint(8, alice);
        gens.mint(9, alice);
        signUp(genesis, 7, alice);
        signUp(gens, 8, alice);
        signUp(gens, 9, alice);
        accrue(genesis, 7, 0, 0.01e18);
        accrue(gens, 8, 0, 0.002e18);
        accrue(gens, 9, 0, 0.003e18);
        address[] memory cs = new address[](3);
        uint256[] memory ids = new uint256[](3);
        (cs[0], cs[1], cs[2]) = (address(genesis), address(gens), address(gens));
        (ids[0], ids[1], ids[2]) = (7, 8, 9);
        bank.collect(cs, ids);                          // no keeper needed
        (, uint256 w) = claim(alice);
        assertApproxEqAbs(w, 0.015e18, 0.015e18 / 100);
    }

    function test_FriendHeldByAContractWallet() public {
        MSafe safe = new MSafe(carol);
        gens.mint(3, address(safe));
        address tba = gens.tokenBoundAccount(3);
        vm.startPrank(carol);
        safe.exec(tba, abi.encodeCall(MTBA.execute, (address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0)));
        safe.exec(address(bank), abi.encodeCall(FriendBank.join, (address(gens), 3, 0, CAP_WETH, false)));
        vm.stopPrank();
        accrue(gens, 3, 0, 0.01e18);
        collect1(gens, 3);
        vm.prank(carol);
        safe.exec(address(bank), abi.encodeCall(FriendBank.withdrawAll, (carol)));
        assertGt(weth.balanceOf(carol), 0);
    }

    function test_LeaveStopsPullsAndKeepsTheLine() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        (, uint256 w) = claim(alice);
        vm.prank(alice);
        bank.leave(address(genesis), 1);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        (, uint256 w2) = claim(alice);
        assertEq(w2, w);
    }

    /* ==================================================== the exact ledger */

    function _twoHolders() internal {
        genesis.mint(1, alice);
        genesis.mint(2, bob);
        signUp(genesis, 1, alice);
        signUp(genesis, 2, bob);
        accrue(genesis, 1, 0, 1e18);                    // alice: all WETH
        accrue(genesis, 2, 1_000_000e18, 0);            // bob: all RF
        collect1(genesis, 1);
        collect1(genesis, 2);
    }

    function test_DonationMovesNobody() public {
        _twoHolders();
        (uint256 aR, uint256 aW) = claim(alice);
        weth.mint(address(bank), 1000e18);
        rf.mint(address(bank), 1e30);
        (uint256 aR2, uint256 aW2) = claim(alice);
        assertEq(aR2, aR);
        assertEq(aW2, aW);
    }

    /* =============================================================== exit */

    function test_WithdrawWorksHaltedAndAfterRenounce() public {
        _twoHolders();
        bank.setQuotingHalted(true);
        bank.renounce();
        assertEq(bank.keeper(), address(0));
        (uint256 r, uint256 w) = claim(alice);
        vm.prank(alice);
        bank.withdrawAll(alice);
        assertEq(weth.balanceOf(alice), w);
        assertEq(rf.balanceOf(alice), r);
    }

    function test_OwnerHasNoPathToHolderFunds() public {
        _twoHolders();
        vm.expectRevert(FriendBank.Insufficient.selector);
        bank.withdraw(1, 0, address(this));             // the deployer is the owner and holds no line
    }

    /* ================================================ owed, sweep, failures */

    function test_FailedPullIsOwedAndRetried() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.01e18);
        weth.setBlocked(tba, true);                     // the claim lands, the pull fails (e.g. a gas-starved call)
        _collectAs(alice, genesis, 1);
        (, uint256 w) = claim(alice);
        assertEq(w, 0);
        assertEq(bank.friendOf(address(genesis), 1).owedWeth, 0.01e18, "a pull the Bank could not finish is remembered");

        weth.setBlocked(tba, false);
        _collectAs(alice, genesis, 1);                  // nothing new to claim: owed is paid down
        (, w) = claim(alice);
        assertEq(w, 0.01e18, "and collected on the next pass");
        assertEq(bank.friendOf(address(genesis), 1).owedWeth, 0);
    }

    function test_OwnerActionForfeitsOwed() public {
        genesis.mint(1, alice);
        address tba = genesis.tokenBoundAccount(1);
        vm.startPrank(alice);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), 0.004e18)), 0);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);
        vm.stopPrank();
        accrue(genesis, 1, 0, 0.01e18);
        _collectAs(alice, genesis, 1);
        assertEq(bank.friendOf(address(genesis), 1).owedWeth, 0.006e18);
        vm.prank(alice);                                // any owner action through the wallet
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        _collectAs(alice, genesis, 1);
        assertEq(weth.balanceOf(tba), 0.006e18, "the unpulled rewards stay with the owner");
    }

    function test_OwedIsForfeitedIfTheOwnerSpendsItFirst() public {
        genesis.mint(1, alice);
        address tba = genesis.tokenBoundAccount(1);
        vm.startPrank(alice);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), 0.004e18)), 0);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);
        vm.stopPrank();
        accrue(genesis, 1, 0, 0.01e18);
        _collectAs(alice, genesis, 1);                  // 0.006 owed, sitting in the wallet
        vm.startPrank(alice);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.transfer, (alice, 0.006e18)), 0);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        vm.stopPrank();
        weth.mint(tba, 5e18);                           // later the owner parks their own money there
        _collectAs(alice, genesis, 1);
        assertEq(weth.balanceOf(tba), 5e18, "owed was clamped to 0 when it was spent; the new money is safe");
    }

    function test_SweepModeCatchesRewardsSomeoneElseClaimed() public {
        genesis.mint(1, alice);
        address tba = genesis.tokenBoundAccount(1);
        weth.mint(tba, 2e18);                           // already there at signup: the floor
        vm.startPrank(alice);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, true);
        vm.stopPrank();
        accrue(genesis, 1, 0, 0.01e18);
        am.claim(address(weth), address(genesis), 1);   // e.g. "claim all" on rarefriends.com
        _collectAs(alice, genesis, 1);
        (, uint256 w) = claim(alice);
        assertEq(w, 0.01e18, "sweep collects it anyway");
        assertEq(weth.balanceOf(tba), 2e18, "and never goes below the signup floor");
    }

    function test_ClaimFailureIsReportedNotSwallowed() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.01e18);
        am.setBroken(true);                             // e.g. migrateRewards retired the manager
        vm.expectEmit(true, true, false, true, address(bank));
        emit FriendBank.ClaimFailed(address(genesis), 1, address(weth), 0.01e18);
        collect1(genesis, 1);
    }

    function test_TemporaryFriendRejected() public {
        gens.mint(5, alice);
        gens.setGeneration(5, 0);
        vm.prank(alice);
        vm.expectRevert(FriendBank.TemporaryFriend.selector);
        bank.join(address(gens), 5, CAP_RF, CAP_WETH, false);
    }

    function test_KeeperChangeIsDelayedAndNeverTheOwner() public {
        vm.expectRevert(FriendBank.BadKeeper.selector);
        bank.proposeKeeper(address(this));
        bank.proposeKeeper(bob);
        vm.expectRevert(FriendBank.KeeperNotReady.selector);
        bank.activateKeeper();
        vm.warp(block.timestamp + 2 days);
        bank.activateKeeper();
        assertEq(bank.keeper(), bob);
        bank.removeKeeper();                            // immediate
        assertEq(bank.keeper(), address(0));
    }

    /* =========================================================== keeper */

    function test_KeeperTipIsBoundedAndPaidFromThatFriendOnly() public {
        _twoHolders();
        (uint256 bR, uint256 bW) = claim(bob);
        accrue(genesis, 1, 0, 0.5e18);
        address stranger = address(0x5157);
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        (cs[0], ids[0]) = (address(genesis), 1);
        vm.warp(block.timestamp + 25 hours);
        vm.prank(stranger);
        bank.collect(cs, ids);
        uint256 tip = weth.balanceOf(stranger);
        assertGt(tip, 0);
        assertLe(tip, 0.5e18 * 100 / 10_000, "at most 1% of what was collected");
        (uint256 bR2, uint256 bW2) = claim(bob);
        assertEq(bR2, bR);
        assertEq(bW2, bW, "bob pays nothing for alice's collection");

        accrue(genesis, 1, 0, 0.3e18);                  // still inside the day's cap
        vm.prank(stranger);
        bank.collect(cs, ids);
        assertEq(weth.balanceOf(stranger), tip, "no second tip inside the interval");
        assertEq(am.earned(address(weth), address(genesis), 1), 0, "but the collection itself still happened");
    }

    function test_HolderCollectingPaysNoTip() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        accrue(genesis, 1, 0, 0.5e18);
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        (cs[0], ids[0]) = (address(genesis), 1);
        vm.prank(alice);
        bank.collect(cs, ids);
        (, uint256 w) = claim(alice);
        assertEq(w, 0.5e18 > CAP_WETH ? CAP_WETH : 0.5e18);
    }

    /* ======================================================= harvest extras */

    function test_WethStillExitsIfRfTransfersBreak() public {
        member(genesis, 1, alice, 5_000e18, 0.2e18);
        (uint256 r, uint256 w) = claim(alice);
        assertGt(r, 0);
        rf.setBlocked(address(bank), true);             // e.g. RF's syncPreview hook starts reverting
        vm.prank(alice);
        vm.expectRevert();
        bank.withdrawAll(alice);
        vm.prank(alice);
        bank.withdrawWETH(w, alice);                    // per-asset exit
        assertEq(weth.balanceOf(alice), w);
    }

    function test_WithdrawRFAndWETHSeparately() public {
        member(genesis, 1, alice, 5_000e18, 0.2e18);
        vm.startPrank(alice);
        bank.withdrawRF(1_000e18, alice);
        bank.withdrawWETH(0.05e18, alice);
        vm.stopPrank();
        (uint256 r, uint256 w) = claim(alice);
        assertEq(r, 4_000e18);
        assertEq(w, 0.15e18);
    }

    function test_CollectStartsTheNextRewardStreamWhenDue() public {
        member(genesis, 1, alice, 0, 0.01e18);
        am.setStream(address(weth), 5e18, block.timestamp + 1 days);
        accrue(genesis, 1, 0, 0.01e18);
        collect1(genesis, 1);
        assertEq(am.allocations(), 0, "not due yet: no call, no wasted revert");
        vm.warp(block.timestamp + 1 days);
        collect1(genesis, 1);
        assertEq(am.allocations(), 1, "due: collect starts it");
    }

    function test_AlarmWhenTheFeeIsRedirected() public {
        member(genesis, 1, alice, 0, 0.01e18);
        hook.setRewards(address(0xDEAD));
        vm.expectEmit(false, false, false, true, address(bank));
        emit FriendBank.RewardsRedirected(address(0xDEAD));
        collect1(genesis, 1);
    }

    function test_CollectableViewMatchesWhatCollectDoes() public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        accrue(genesis, 1, 7e18, 0.02e18);
        (uint256 eR, uint256 eW, uint256 roomR, uint256 roomW, uint256 aR, uint256 aW,,) =
            bank.collectable(address(genesis), 1);
        assertEq(eR, 7e18);
        assertEq(eW, 0.02e18);
        assertEq(roomR, CAP_RF);
        assertEq(roomW, CAP_WETH);
        assertEq(aR, type(uint256).max);
        assertEq(aW, type(uint256).max);
    }

    function test_KeeperNeverTheOwnerAtDeploy() public {
        FriendBank.Config memory c = FriendBank.Config({
            rf: address(rf), weth: address(weth), activation: address(am), genesis: address(genesis),
            generations: address(gens), poolManager: address(pm), hook: address(hook), poolFee: 0x800000,
            tickSpacing: 60, keeper: address(this)
        });
        vm.expectRevert(FriendBank.BadKeeper.selector);
        new FriendBank(c);
    }

    /* ========================================================= bankTotals */

    function _counts() internal view returns (uint256 f, uint256 h) {
        (,,,, f, h) = bank.bankTotals();
    }

    function test_BankTotalsCountsFollowJoinLeaveSaleRejoin() public {
        genesis.mint(1, alice);
        gens.mint(2, alice);
        genesis.mint(3, bob);
        signUp(genesis, 1, alice);
        (uint256 f, uint256 h) = _counts();
        assertEq(f, 1); assertEq(h, 1);
        signUp(gens, 2, alice);
        (f, h) = _counts();
        assertEq(f, 2); assertEq(h, 1, "one owner, two Friends, one holder");
        signUp(genesis, 3, bob);
        (f, h) = _counts();
        assertEq(f, 3); assertEq(h, 2);

        vm.prank(alice);
        bank.leave(address(gens), 2);
        (f, h) = _counts();
        assertEq(f, 2); assertEq(h, 2);

        vm.prank(alice);
        genesis.transferFrom(alice, carol, 1);          // sold
        bank.suspendIfTransferred(address(genesis), 1);
        (f, h) = _counts();
        assertEq(f, 1); assertEq(h, 1, "alice has no enrolled Friend left");

        vm.prank(carol);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);   // the buyer opts in
        (f, h) = _counts();
        assertEq(f, 2); assertEq(h, 2);

        vm.prank(carol);
        genesis.transferFrom(carol, bob, 1);            // sold again, nobody suspends it first
        vm.prank(bob);
        bank.join(address(genesis), 1, CAP_RF, CAP_WETH, false);   // the new owner joins over the stale record
        (f, h) = _counts();
        assertEq(f, 2, "the stale record was closed as the new one opened");
        assertEq(h, 1, "carol dropped out, bob now has two");
    }

    function test_BankTotalsEqualTheSumOfLines() public {
        _twoHolders();
        genesis.mint(3, carol);
        signUp(genesis, 3, carol);
        accrue(genesis, 3, 777e18, 0.03e18);
        collect1(genesis, 3);
        weth.mint(address(bank), 5e18);                 // a donation: not in anyone's line, not in the totals
        (uint256 rI, uint256 wI, uint256 rA, uint256 wB,,) = bank.bankTotals();
        address[3] memory hs = [alice, bob, carol];
        uint256[4] memory t;
        for (uint256 i; i < 3; ++i) {
            uint256[4] memory v = bank.lineOf(hs[i]);
            for (uint256 k; k < 4; ++k) t[k] += v[k];
        }
        assertEq(rI, t[0]);
        assertEq(wI, t[1]);
        assertEq(rA, t[2]);
        assertEq(wB, t[3]);
    }
}
