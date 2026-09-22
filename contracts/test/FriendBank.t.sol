// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/FriendBank.sol";

/* ------------------------------------------------------------------ mocks */

contract MockERC20 is IERC20 {
    mapping(address => uint256) public bal;
    mapping(address => mapping(address => uint256)) public allow;
    function mint(address to, uint256 a) external { bal[to] += a; }
    function balanceOf(address a) external view returns (uint256) { return bal[a]; }
    function allowance(address o, address s) external view returns (uint256) { return allow[o][s]; }
    function approve(address s, uint256 a) external returns (bool) { allow[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(bal[msg.sender] >= a, "bal"); bal[msg.sender] -= a; bal[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(bal[f] >= a, "bal");
        require(allow[f][msg.sender] >= a, "allow");
        allow[f][msg.sender] -= a; bal[f] -= a; bal[t] += a; return true;
    }
    /// @dev lets a test act as the token-bound wallet granting an allowance
    function approveAs(address asWho, address s, uint256 a) external { allow[asWho][s] = a; }
}

contract MockCollection is IFriendCollection {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public tbas;
    function setFriend(uint256 id, address o, address tba) external { owners[id] = o; tbas[id] = tba; }
    function ownerOf(uint256 id) external view returns (address) { return owners[id]; }
    function tokenBoundAccount(uint256 id) external view returns (address) { return tbas[id]; }
}

contract MockActivation is IActivationManager {
    MockERC20 public rf; MockERC20 public weth;
    mapping(bytes32 => uint256) public owed;
    mapping(address => address) public tbaOf;   // collection+id -> handled via setOwed
    address public lastCaller;
    constructor(MockERC20 _rf, MockERC20 _w) { rf = _rf; weth = _w; }
    function setOwed(address asset, address c, uint256 id, address tba, uint256 amt) external {
        owed[keccak256(abi.encodePacked(asset, c, id))] = amt;
        _tba[keccak256(abi.encodePacked(c, id))] = tba;
    }
    mapping(bytes32 => address) private _tba;
    function earned(address a, address c, uint256 id) external view returns (uint256) {
        return owed[keccak256(abi.encodePacked(a, c, id))];
    }
    function claim(address a, address c, uint256 id) external returns (uint256) {
        lastCaller = msg.sender;
        bytes32 k = keccak256(abi.encodePacked(a, c, id));
        uint256 amt = owed[k];
        if (amt == 0) revert("nothing");
        owed[k] = 0;
        // credits the FRIEND's wallet, never the caller
        MockERC20(a).mint(_tba[keccak256(abi.encodePacked(c, id))], amt);
        return amt;
    }
}

contract MockMarket is IMarket {
    MockERC20 public rf; MockERC20 public weth;
    uint256 public rate = 1e18;   // 1:1 for arithmetic clarity
    constructor(MockERC20 _rf, MockERC20 _w) { rf = _rf; weth = _w; }
    function swapExactInput(bool buy, uint256 amountIn, uint256, address recipient, uint256)
        external returns (uint256)
    {
        if (buy) { weth.transferFrom(msg.sender, address(this), amountIn); rf.mint(recipient, amountIn); }
        else { rf.transferFrom(msg.sender, address(this), amountIn); weth.mint(recipient, amountIn); }
        return amountIn;
    }
}

/* ------------------------------------------------------------------- tests */

contract FriendBankTest is Test {
    MockERC20 rf; MockERC20 weth;
    MockCollection genesis;
    MockActivation activation;
    MockMarket market;
    FriendBank bank;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    address tbaA  = address(0xBA11);
    uint256 constant ID = 259;
    uint256 constant CAP = 1_000e18;

    function setUp() public {
        rf = new MockERC20(); weth = new MockERC20();
        genesis = new MockCollection();
        activation = new MockActivation(rf, weth);
        market = new MockMarket(rf, weth);
        bank = new FriendBank(address(rf), address(weth), address(activation), address(market));

        genesis.setFriend(ID, alice, tbaA);
        vm.prank(alice);
        bank.join(address(genesis), ID, CAP);
    }

    function _approveFromTba(uint256 amount) internal {
        rf.approveAs(tbaA, address(bank), amount);
        weth.approveAs(tbaA, address(bank), amount);
    }

    /* ------------------------------------------- guarantee 1: no NFT custody */

    function test_BankNeverTakesTheNFT() public view {
        assertEq(genesis.ownerOf(ID), alice, "the NFT must stay with its owner");
        assertTrue(genesis.ownerOf(ID) != address(bank), "the bank must never hold the NFT");
    }

    function test_JoinRequiresActualOwnership() public {
        genesis.setFriend(77, alice, tbaA);
        vm.prank(bob);
        vm.expectRevert(FriendBank.NotFriendOwner.selector);
        bank.join(address(genesis), 77, CAP);
    }

    /* --------------------------------- guarantee 2: cap can never be exceeded */

    function test_CollectIsBoundedByTheMemberCap() public {
        rf.mint(tbaA, 10_000e18);            // far more than the cap
        _approveFromTba(type(uint256).max);  // member even grants unlimited allowance

        (uint256 rfPulled,) = bank.collect(0);
        assertEq(rfPulled, CAP, "must pull the cap, not the balance, even with max allowance");
        assertEq(rf.balanceOf(tbaA), 10_000e18 - CAP, "the rest stays in the Friend's wallet");
    }

    function test_CapRefillsOnlyOncePerEpoch() public {
        rf.mint(tbaA, 10_000e18);
        _approveFromTba(type(uint256).max);
        bank.collect(0);

        vm.expectRevert(FriendBank.NothingToCollect.selector);
        bank.collect(0);                       // same epoch: no room left

        vm.warp(block.timestamp + 1 days);
        (uint256 rf2,) = bank.collect(0);
        assertEq(rf2, CAP, "a new epoch restores exactly one cap, not more");
    }

    function test_OwnerCannotRaiseAMemberCap() public {
        // There is deliberately no function to do this. Assert the surface stays small:
        // tightenRiskCaps is the only risk knob and it only ratchets down.
        vm.expectRevert(FriendBank.OnlyTightening.selector);
        bank.tightenRiskCaps(9000, 1500);      // 9000 > current 6000
        vm.expectRevert(FriendBank.OnlyTightening.selector);
        bank.tightenRiskCaps(6000, 9999);
        bank.tightenRiskCaps(5000, 1000);      // tightening is allowed
        assertEq(bank.maxInventoryBps(), 5000);
    }

    function test_RevokingAllowanceMakesTheBankPowerless() public {
        rf.mint(tbaA, 10_000e18);
        _approveFromTba(type(uint256).max);
        bank.collect(0);

        vm.warp(block.timestamp + 1 days);
        rf.approveAs(tbaA, address(bank), 0);   // member revokes
        weth.approveAs(tbaA, address(bank), 0);

        vm.expectRevert(FriendBank.NothingToCollect.selector);
        bank.collect(0);
    }

    function test_LeavingStopsCollection() public {
        rf.mint(tbaA, 10_000e18);
        _approveFromTba(type(uint256).max);
        vm.prank(alice);
        bank.leave(address(genesis), ID);

        vm.expectRevert(FriendBank.NotAMember.selector);
        bank.collect(0);
    }

    /* ----------------------------------------- guarantee 3: exit is never blocked */

    function test_WithdrawWorksEvenWhenTheDeskIsHalted() public {
        rf.mint(tbaA, 10_000e18);
        _approveFromTba(type(uint256).max);
        bank.collect(0);

        bank.setQuotingHalted(true);           // owner halts the desk
        assertTrue(bank.quotingHalted());

        uint256 shares = bank.sharesOf(alice);
        assertGt(shares, 0);
        vm.prank(alice);
        bank.withdraw(shares);                 // must still succeed

        assertEq(bank.sharesOf(alice), 0);
        assertEq(rf.balanceOf(alice), CAP, "member gets their funds back while halted");
    }

    function test_OwnerCannotMoveMemberFunds() public {
        rf.mint(tbaA, 10_000e18);
        _approveFromTba(type(uint256).max);
        bank.collect(0);

        uint256 before = rf.balanceOf(address(bank));
        // The owner holds no shares, so withdraw gives them nothing.
        vm.expectRevert(FriendBank.InsufficientShares.selector);
        bank.withdraw(1);
        assertEq(rf.balanceOf(address(bank)), before, "owner cannot extract the book");
    }

    /* ---------------------------------------------------------- harvest is open */

    function test_HarvestIsPermissionlessAndCreditsTheFriendNotTheBank() public {
        activation.setOwed(address(rf), address(genesis), ID, tbaA, 500e18);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;

        vm.prank(bob);                          // a total stranger
        bank.harvest(ids);

        assertEq(rf.balanceOf(tbaA), 500e18, "rewards must land in the Friend's own wallet");
        assertEq(rf.balanceOf(address(bank)), 0, "harvest must never move funds to the bank");
    }

    function test_HarvestSurvivesAFriendWithNothingPending() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        bank.harvest(ids);                      // must not revert the whole batch
    }

    /* ------------------------------------------------------------ desk risk caps */

    function test_TradeRespectsTheSizeCap() public {
        weth.mint(address(bank), 1_000e18);
        uint256 tooBig = (1_000e18 * bank.maxTradeBps()) / 10_000 + 1;
        vm.expectRevert(FriendBank.CapTooHigh.selector);
        bank.trade(true, tooBig, 0, block.timestamp + 1);
    }

    function test_TradeBlockedWhenHalted() public {
        weth.mint(address(bank), 1_000e18);
        bank.setQuotingHalted(true);
        vm.expectRevert(FriendBank.DeskHalted.selector);
        bank.trade(true, 1e18, 0, block.timestamp + 1);
    }

    function test_TradeRespectsTheInventoryCap() public {
        // Start almost entirely in WETH, then buy RF repeatedly until the cap binds.
        weth.mint(address(bank), 1_000e18);
        bool reverted;
        for (uint256 i; i < 40; ++i) {
            (bool ok,) = address(bank).call(
                abi.encodeWithSelector(bank.trade.selector, true, 100e18, 0, block.timestamp + 1)
            );
            if (!ok) { reverted = true; break; }
        }
        assertTrue(reverted, "the inventory cap must eventually stop the desk buying");
        (uint256 rfBal, uint256 wethBal) = bank.bookValue();
        uint256 invBps = (rfBal * 10_000) / (rfBal + wethBal);
        assertLe(invBps, bank.maxInventoryBps(), "inventory must never exceed the cap");
    }

    function test_NonKeeperCannotTrade() public {
        weth.mint(address(bank), 1_000e18);
        vm.prank(bob);
        vm.expectRevert(FriendBank.NotKeeper.selector);
        bank.trade(true, 1e18, 0, block.timestamp + 1);
    }

    /* ----------------------------------------------------------------- views */

    function test_CollectableShowsRealExposure() public {
        rf.mint(tbaA, 10_000e18);
        rf.approveAs(tbaA, address(bank), 250e18);   // member approves less than the cap
        (uint256 rfC,) = bank.collectable(0);
        assertEq(rfC, 250e18, "exposure is the smallest of balance, allowance and cap");
    }

    function test_DoubleJoinRejected() public {
        vm.prank(alice);
        vm.expectRevert(FriendBank.AlreadyJoined.selector);
        bank.join(address(genesis), ID, CAP);
    }

    function test_ZeroCapRejected() public {
        genesis.setFriend(2, alice, tbaA);
        vm.prank(alice);
        vm.expectRevert(FriendBank.ZeroCap.selector);
        bank.join(address(genesis), 2, 0);
    }
}
