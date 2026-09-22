// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Base.sol";

/**
 * "After I transfer or sell my Friend, can the Bank still move my ETH or anything in my own wallet?"
 *
 * No. The Bank's only pull is `_pull(token, f.tba, amount)` in FriendBank.sol, and `from` is always the
 * Friend's token-bound wallet (the `tba` recorded at join), never msg.sender and never an owner EOA. Neither
 * FriendBank nor RangeDesk has a payable function, a receive or fallback, a value-bearing call, or any NFT
 * transfer. These tests give the owner's own wallet RF, WETH, ETH and even a MAX allowance to the Bank and
 * to the desk, drive every entry point, and check the wallet only ever GAINS what it withdraws.
 */
contract EoaNeverTouched is Base {
    uint256 constant EOA_RF = 1_000_000e18;
    uint256 constant EOA_WETH = 50e18;

    function setUp() public override {
        super.setUp();
        rf.mint(alice, EOA_RF);
        weth.mint(alice, EOA_WETH);
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);                             // the worst case: the owner's EOA approved everything
        rf.approve(address(bank), type(uint256).max);
        weth.approve(address(bank), type(uint256).max);
        rf.approve(address(bank.DESK()), type(uint256).max);
        weth.approve(address(bank.DESK()), type(uint256).max);
        vm.stopPrank();
    }

    struct Wallet {
        uint256 rf;
        uint256 weth;
        uint256 eth;
    }

    function _wallet(address a) internal view returns (Wallet memory) {
        return Wallet(rf.balanceOf(a), weth.balanceOf(a), a.balance);
    }

    /// The wallet may only go up, and only by what was just withdrawn to it.
    function _assertOnlyGained(Wallet memory before, uint256 rfIn, uint256 wethIn, string memory step) internal view {
        Wallet memory now_ = _wallet(alice);
        assertEq(now_.rf, before.rf + rfIn, step);
        assertEq(now_.weth, before.weth + wethIn, step);
        assertEq(now_.eth, before.eth, step);
        assertEq(rf.allowance(alice, address(bank)), type(uint256).max, "the EOA allowance is never used");
        assertEq(weth.allowance(alice, address(bank)), type(uint256).max, "the EOA allowance is never used");
    }

    function test_EveryEntryPointLeavesTheOwnersWalletAlone() public {
        genesis.mint(1, alice);
        Wallet memory w = _wallet(alice);

        signUp(genesis, 1, alice);
        _assertOnlyGained(w, 0, 0, "join");

        accrue(genesis, 1, 5_000e18, 0.4e18);
        _collectAs(alice, genesis, 1);
        _assertOnlyGained(w, 0, 0, "collect by the owner");
        accrue(genesis, 1, 0, 0.1e18);
        vm.warp(block.timestamp + 1 days);
        collect1(genesis, 1);
        _assertOnlyGained(w, 0, 0, "collect by the keeper");

        member(genesis, 2, bob, 20_000e18, 1e18);         // someone else's activity
        readyTwap();
        placeAsk(bank.bookR() / 10);
        placeBid(bank.bookW() / 10);
        fillAsk(5_000, px(ASK_LO + 300));
        fillBid(5_000, px(BID_LO + 300));
        bank.settle(alice, 100);
        bank.poke();
        _assertOnlyGained(w, 0, 0, "desk ops, settle, poke");

        vm.prank(alice);
        bank.exitRanges();
        _assertOnlyGained(w, 0, 0, "exitRanges credits the Bank line, not the wallet");

        (uint256 r, uint256 x) = claim(alice);
        vm.prank(alice);
        bank.withdrawRF(r / 4, alice);
        _assertOnlyGained(w, r / 4, 0, "withdrawRF");
        w = _wallet(alice);
        vm.prank(alice);
        bank.withdrawWETH(x / 4, alice);
        _assertOnlyGained(w, 0, x / 4, "withdrawWETH");

        closeAsk();
        closeBid();
        w = _wallet(alice);
        vm.prank(alice);
        bank.leave(address(genesis), 1);
        _assertOnlyGained(w, 0, 0, "leave");

        (r, x) = claim(alice);
        vm.prank(alice);
        bank.withdrawAll(alice);
        _assertOnlyGained(w, r, x, "withdrawAll pays exactly the line");
    }

    /// After a sale, nothing the Bank does can reach the seller's wallet, and the buyer's leftover allowance
    /// from the Friend's wallet is dead: the Friend is suspended and is never claimed or pulled from again.
    function test_AfterSellingTheFriendNothingReachesEitherWallet() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        accrue(genesis, 1, 5_000e18, 0.4e18);
        _collectAs(alice, genesis, 1);

        vm.prank(alice);
        genesis.transferFrom(alice, bob, 1);            // sold; the Friend's wallet (and its allowance) goes with it
        assertEq(weth.allowance(tba, address(bank)), type(uint256).max, "the allowance survives the sale, as on chain");
        weth.mint(tba, 3e18);                           // the buyer's money in the Friend's wallet

        Wallet memory seller = _wallet(alice);
        Wallet memory buyer = _wallet(bob);
        for (uint256 i; i < 5; ++i) {
            accrue(genesis, 1, 1_000e18, 0.1e18);
            vm.warp(block.timestamp + 1 days);
            collect1(genesis, 1);                       // the keeper
            _collectAs(carol, genesis, 1);              // a stranger
            _collectAs(bob, genesis, 1);                // the buyer himself
        }
        assertFalse(bank.friendOf(address(genesis), 1).active);
        assertEq(weth.balanceOf(tba), 3e18, "the buyer's Friend wallet is untouched");
        assertEq(am.earned(address(weth), address(genesis), 1), 0.5e18, "and its rewards are not even claimed");
        _assertOnlyGained(seller, 0, 0, "seller's own wallet");
        assertEq(rf.balanceOf(bob), buyer.rf);
        assertEq(weth.balanceOf(bob), buyer.weth);
        assertEq(bob.balance, buyer.eth);
    }

    /// The exact calls an owner sends to revoke, through the Friend's own wallet. The Bank cannot do this for
    /// them: only the Friend's current owner can make the wallet call `approve`.
    function test_OwnerRevokesThroughTheFriendWallet() public {
        genesis.mint(1, alice);
        address tba = signUp(genesis, 1, alice);
        vm.startPrank(alice);
        bank.leave(address(genesis), 1);
        MTBA(tba).execute(address(rf), 0, abi.encodeCall(MToken.approve, (address(bank), 0)), 0);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), 0)), 0);
        vm.stopPrank();
        assertEq(rf.allowance(tba, address(bank)), 0);
        assertEq(weth.allowance(tba, address(bank)), 0);
        vm.prank(address(bank));                        // not even the Bank itself can call the wallet
        vm.expectRevert();
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
    }

    function test_TheBankAndDeskRefuseEth() public {
        vm.startPrank(alice);
        (bool ok,) = address(bank).call{value: 1 ether}("");
        assertFalse(ok, "no receive");
        (ok,) = address(bank.DESK()).call{value: 1 ether}("");
        assertFalse(ok, "no receive");
        (ok,) = address(bank).call{value: 1 ether}(abi.encodeCall(FriendBank.withdrawRF, (0, alice)));
        assertFalse(ok, "no payable entry point");
        vm.stopPrank();
        assertEq(alice.balance, 10 ether);
    }

    /// Any sequence of anyone's actions: the owner's own wallet never loses a wei.
    function testFuzz_OwnersWalletNeverDecreases(uint256 seed) public {
        genesis.mint(1, alice);
        signUp(genesis, 1, alice);
        member(genesis, 2, bob, 10_000e18, 1e18);
        readyTwap();
        for (uint256 i; i < 20; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            Wallet memory w = _wallet(alice);
            uint256 op = seed % 9;
            if (op == 0) { accrue(genesis, 1, seed % 1e22, seed % 1e17); collect1(genesis, 1); }
            else if (op == 1) { vm.warp(block.timestamp + 1 days); readyTwap(); }
            else if (op == 2) { vm.prank(keeper); try bank.placeAsk(ASK_LO, ASK_HI, bank.bookR() / 10) {} catch {} }
            else if (op == 3) { vm.prank(keeper); try bank.placeBid(BID_LO, BID_HI, bank.bookW() / 10) {} catch {} }
            else if (op == 4) { vm.prank(keeper); try bank.closeAsk() {} catch {} }
            else if (op == 5) { vm.prank(keeper); try bank.closeBid() {} catch {} }
            else if (op == 6) { vm.prank(alice); bank.exitRanges(); }
            else if (op == 7) { vm.prank(bob); bank.withdrawAll(bob); }
            else { vm.prank(carol); try bank.suspendIfTransferred(address(genesis), 1) {} catch {} }
            _assertOnlyGained(w, 0, 0, "any op");
        }
    }
}
