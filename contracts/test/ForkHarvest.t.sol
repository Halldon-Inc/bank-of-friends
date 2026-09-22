// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/FriendBank.sol";

interface ITBAx {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

interface INFTx {
    function ownerOf(uint256) external view returns (address);
    function tokenBoundAccount(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}

/// End to end against REAL Robinhood Chain state (a local fork; nothing is broadcast):
/// real Genesis, real ERC-6551 wallet, real ActivationManager, real RF/WETH. The desk is in ForkDesk.t.sol.
contract ForkHarvest is Test {
    address constant HUNT = 0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF;   // never used (Hunt ruling)
    address constant RF = 0x0779369854d3EcdEA927206718FFD7730C67B71f;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant GENESIS = 0x116EaA62241751E0c98dA43d458600c6C17cD361;
    address constant GENS = 0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D;
    address constant AM = 0xD4A35e11318E3679168d409184B788bcF9F283Ac;
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0x7A65d0194e6Cc43971C31CE7D1471Da01D42A0cC;

    address constant KEEPER = address(0x4EE9E4);
    FriendBank bank;
    uint256 id;
    address holder;
    address tba;

    function setUp() public {
        vm.createSelectFork("robinhood");   // latest block: the public RPC keeps no archive state
        bank = new FriendBank(FriendBank.Config({
            rf: RF, weth: WETH, activation: AM, genesis: GENESIS, generations: GENS,
            poolManager: PM, hook: HOOK, poolFee: 0x800000, tickSpacing: 60, keeper: KEEPER
        }));
        // the first Genesis with WETH pending
        for (uint256 i = 1; i <= 200; ++i) {
            try IActivationManagerV2(AM).earned(WETH, GENESIS, i) returns (uint256 e) {
                if (i == 259 || INFTx(GENESIS).ownerOf(i) == HUNT) continue;
                if (e > 1e14) { id = i; break; }
            } catch {}
        }
        require(id != 0, "no earning Genesis");
        holder = INFTx(GENESIS).ownerOf(id);
        tba = INFTx(GENESIS).tokenBoundAccount(id);
    }

    function _signUpThroughTheWallet() internal {
        vm.startPrank(holder);
        ITBAx(tba).execute(RF, 0, abi.encodeCall(IERC20V2.approve, (address(bank), type(uint256).max)), 0);
        ITBAx(tba).execute(WETH, 0, abi.encodeCall(IERC20V2.approve, (address(bank), type(uint256).max)), 0);
        ITBAx(tba).execute(
            address(bank), 0, abi.encodeCall(FriendBank.join, (GENESIS, id, type(uint128).max, type(uint128).max, false)), 0
        );
        vm.stopPrank();
    }

    function _collect(address caller) internal returns (uint256 gasUsed) {
        address[] memory cs = new address[](1);
        uint256[] memory ids = new uint256[](1);
        (cs[0], ids[0]) = (GENESIS, id);
        vm.prank(caller);
        uint256 g = gasleft();
        bank.collect(cs, ids);
        gasUsed = g - gasleft();
    }

    function test_fork_EndToEnd() public {
        emit log_named_uint("genesis id", id);
        emit log_named_address("holder", holder);
        _signUpThroughTheWallet();
        assertEq(bank.friendOf(GENESIS, id).holder, holder);

        uint256 tbaW0 = IERC20V2(WETH).balanceOf(tba);
        uint256 tbaR0 = IERC20V2(RF).balanceOf(tba);
        uint256 eW = IActivationManagerV2(AM).earned(WETH, GENESIS, id);
        uint256 eR = IActivationManagerV2(AM).earned(RF, GENESIS, id);
        emit log_named_uint("earned WETH", eW);
        emit log_named_uint("earned RF", eR);
        emit log_named_uint("wallet WETH already there", tbaW0);
        emit log_named_uint("wallet RF already there", tbaR0);

        uint256 gasUsed = _collect(address(0x5157));
        emit log_named_uint("collect gas, one Friend, both assets", gasUsed);
        emit log_named_uint("basefee", block.basefee);
        uint256 tip = IERC20V2(WETH).balanceOf(address(0x5157));
        emit log_named_uint("tip paid to the stranger", tip);

        (uint256 r, uint256 w) = bank.claimOf(holder);
        assertEq(w + tip, eW, "the bank took exactly what it claimed");
        assertEq(r, eR);
        assertEq(IERC20V2(WETH).balanceOf(tba), tbaW0, "nothing the wallet already held was taken");
        assertEq(IERC20V2(RF).balanceOf(tba), tbaR0);
        assertLe(tip * 10_000, (w + tip) * 100);

        // the Friend is sold. The allowance survives on chain; the bank must not use it.
        address buyer = address(0xB0B);
        vm.prank(holder);
        INFTx(GENESIS).transferFrom(holder, buyer, id);
        assertEq(IERC20V2(WETH).allowance(tba, address(bank)), type(uint256).max, "allowance survived the sale");
        vm.warp(block.timestamp + 2 days);
        uint256 buyerWalletW = IERC20V2(WETH).balanceOf(tba);
        uint256 earnedAfter = IActivationManagerV2(AM).earned(WETH, GENESIS, id);
        _collect(address(this));
        assertFalse(bank.friendOf(GENESIS, id).active, "suspended on sale");
        assertEq(IERC20V2(WETH).balanceOf(tba), buyerWalletW, "buyer's wallet untouched");
        assertEq(IActivationManagerV2(AM).earned(WETH, GENESIS, id), earnedAfter, "buyer's rewards not even claimed");

        // the seller leaves with exactly their line, in kind
        vm.prank(holder);
        bank.withdrawAll(holder);
        (uint256 r3, uint256 w3) = bank.claimOf(holder);
        assertEq(r3 + w3, 0);
        emit log_named_uint("dust left RF", bank.bookR());
        emit log_named_uint("dust left WETH", bank.bookW());
    }
}
