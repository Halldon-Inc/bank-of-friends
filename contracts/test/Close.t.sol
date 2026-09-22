// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Base.sol";

/// "Close account and take everything home" is three calls, one confirmation with a batching wallet:
///   bank.close(collections, ids, to); TBA.execute(RF.approve(bank, 0)); TBA.execute(WETH.approve(bank, 0))
contract CloseTest is Base {
    function _one(MCollection c, uint256 id) internal pure returns (address[] memory cs, uint256[] memory ids) {
        cs = new address[](1);
        ids = new uint256[](1);
        (cs[0], ids[0]) = (address(c), id);
    }

    function _setup() internal returns (address tba1, address tba2) {
        genesis.mint(1, alice);
        gens.mint(2, alice);
        tba1 = signUp(genesis, 1, alice);
        tba2 = signUp(gens, 2, alice);
        accrue(genesis, 1, 3_000e18, 0.3e18);
        accrue(gens, 2, 1_000e18, 0.1e18);
        _collectAs(alice, genesis, 1);
        _collectAs(alice, gens, 2);
        member(genesis, 3, bob, 10_000e18, 1e18);
        readyTwap();
        placeAsk(bank.bookR() / 10);
        placeBid(bank.bookW() / 10);
        fillAsk(4_000, px(ASK_LO + 300));
        fillBid(3_000, px(BID_LO + 300));
    }

    function _closeAll(address to) internal {
        address[] memory cs = new address[](2);
        uint256[] memory ids = new uint256[](2);
        (cs[0], ids[0], cs[1], ids[1]) = (address(genesis), 1, address(gens), 2);
        vm.prank(alice);
        bank.close(cs, ids, to);
    }

    /// close pays exactly the idle line plus the range share exitRanges would give, and nothing else.
    function test_ClosePaysExactlyTheLinePlusTheRangeShare() public {
        _setup();
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        bank.exitRanges();
        (uint256 er, uint256 ew) = claim(alice);
        vm.revertToState(snap);

        uint256 r0 = rf.balanceOf(alice);
        uint256 w0 = weth.balanceOf(alice);
        _closeAll(alice);
        assertEq(rf.balanceOf(alice) - r0, er, "RF: idle plus range share, exactly");
        assertEq(weth.balanceOf(alice) - w0, ew, "WETH likewise");
        uint256[4] memory v = bank.lineOf(alice);
        assertEq(v[0] + v[1] + v[2] + v[3], 0, "nothing left behind");
        assertFalse(bank.friendOf(address(genesis), 1).active);
        assertFalse(bank.friendOf(address(gens), 2).active);
        (,,,, uint256 f, uint256 h) = bank.bankTotals();
        assertEq(f, 1, "only bob's Friend is still enrolled");
        assertEq(h, 1);
    }

    /// After close, the approvals left in the Friend's wallet are useless to the Bank; then the owner revokes.
    function test_AfterCloseNothingIsPulledEvenWithApprovalsLeft() public {
        (address tba1,) = _setup();
        _closeAll(alice);
        accrue(genesis, 1, 5_000e18, 0.5e18);
        weth.mint(tba1, 2e18);
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days);
            (address[] memory cs, uint256[] memory ids) = _one(genesis, 1);
            vm.prank(carol);
            bank.collect(cs, ids);
        }
        assertEq(weth.balanceOf(tba1), 2e18, "the Friend's wallet is untouched");
        assertEq(am.earned(address(weth), address(genesis), 1), 0.5e18, "and its rewards are not even claimed");
        (uint256 r, uint256 w) = claim(alice);
        assertEq(r + w, 0);

        vm.startPrank(alice);                             // the two calls that finish closing
        MTBA(tba1).execute(address(rf), 0, abi.encodeCall(MToken.approve, (address(bank), 0)), 0);
        MTBA(tba1).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), 0)), 0);
        vm.stopPrank();
        assertEq(rf.allowance(tba1, address(bank)) + weth.allowance(tba1, address(bank)), 0);
    }

    /// Close needs no keeper, no desk, no rewards contract: halted, keeperless, AM retired, fee redirected.
    function test_CloseWorksHaltedKeeperlessAndAfterMigrateRewards() public {
        _setup();
        bank.setQuotingHalted(true);
        bank.removeKeeper();
        am.setBroken(true);
        hook.setRewards(address(0xDEAD));
        _closeAll(alice);
        uint256[4] memory v = bank.lineOf(alice);
        assertEq(v[0] + v[1] + v[2] + v[3], 0);
        assertGt(weth.balanceOf(alice), 0);
    }

    /// Friends you do not hold (sold, someone else's, never enrolled) are skipped, never reverted on.
    function test_CloseSkipsFriendsThatAreNotYours() public {
        _setup();
        vm.prank(alice);
        gens.transferFrom(alice, carol, 2);               // sold, not yet suspended
        address[] memory cs = new address[](3);
        uint256[] memory ids = new uint256[](3);
        (cs[0], ids[0]) = (address(genesis), 1);
        (cs[1], ids[1]) = (address(genesis), 3);          // bob's
        (cs[2], ids[2]) = (address(gens), 99);            // never enrolled
        vm.prank(alice);
        bank.close(cs, ids, alice);
        assertTrue(bank.friendOf(address(genesis), 3).active, "bob's Friend is untouched");
        assertFalse(bank.friendOf(address(genesis), 1).active);
    }

    /// If the pool itself is down, close cannot burn your range share; your idle funds still leave through
    /// withdraw, and the range share waits (anyone can close the range once the pool answers again).
    function test_ADeadPoolBlocksOnlyTheRangeShare() public {
        _setup();
        pm.setDead(true);
        (address[] memory cs, uint256[] memory ids) = _one(genesis, 1);
        vm.prank(alice);
        vm.expectRevert();
        bank.close(cs, ids, alice);
        (uint256 r, uint256 w) = claim(alice);
        vm.prank(alice);
        bank.withdraw(r, w, alice);                        // idle funds still leave, pool or no pool
        assertEq(rf.balanceOf(alice), r);
    }

    function test_CloseWithNoRangeNeverTouchesThePool() public {
        member(genesis, 1, alice, 1_000e18, 0.2e18);
        pm.setDead(true);
        (address[] memory cs, uint256[] memory ids) = _one(genesis, 1);
        vm.prank(alice);
        bank.close(cs, ids, alice);
        assertEq(rf.balanceOf(alice), 1_000e18);
        assertEq(weth.balanceOf(alice), 0.2e18);
    }
}
