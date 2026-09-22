// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";

interface ITBA {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
    function owner() external view returns (address);
    function state() external view returns (uint256);
    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4);
    function isValidSigner(address s, bytes calldata ctx) external view returns (bytes4);
}
interface INFT {
    function ownerOf(uint256) external view returns (address);
    function tokenBoundAccount(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}
interface IERC20x {
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}
interface IAM {
    function claim(address asset, address collection, uint256 tokenId) external returns (uint256);
    function earned(address asset, address collection, uint256 tokenId) external view returns (uint256);
}

/// Runs INSIDE the TBA via delegatecall. Stateless, immutable addresses baked in.
contract ProbeEnroller {
    address immutable rf; address immutable weth; address immutable spender;
    constructor(address a, address b, address s) { rf = a; weth = b; spender = s; }
    function enroll(uint256 amt) external {
        IERC20x(rf).approve(spender, amt);
        IERC20x(weth).approve(spender, amt);
    }
}

contract ForkProbe is Test {
    address constant RF = 0x0779369854d3EcdEA927206718FFD7730C67B71f;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant GENESIS = 0x116EaA62241751E0c98dA43d458600c6C17cD361;
    address constant GENS = 0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D;
    address constant AM = 0xD4A35e11318E3679168d409184B788bcF9F283Ac;
    uint256 constant ID = 1;   // a neutral Genesis; never Hunt's #259 or his wallet (Hunt ruling)
    address constant HUNT = 0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF;

    address owner; ITBA tba;

    function setUp() public {
        vm.createSelectFork("robinhood");   // latest block: the public RPC keeps no archive state
        owner = INFT(GENESIS).ownerOf(ID);
        require(owner != HUNT, "never act on Hunt's Friends");
        tba = ITBA(INFT(GENESIS).tokenBoundAccount(ID));
    }

    function test_probe_callApproveFromOwner() public {
        address bank = address(0xBA4C);
        vm.prank(owner);
        tba.execute(RF, 0, abi.encodeCall(IERC20x.approve, (bank, 123)), 0);
        assertEq(IERC20x(RF).allowance(address(tba), bank), 123);
    }

    function test_probe_strangerCannotExecute() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        tba.execute(RF, 0, abi.encodeCall(IERC20x.approve, (address(0xBAD), 1)), 0);
    }

    function test_probe_delegatecallEnroller() public {
        address bank = address(0xBA4C);
        ProbeEnroller e = new ProbeEnroller(RF, WETH, bank);
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(tba).call(
            abi.encodeCall(ITBA.execute, (address(e), 0, abi.encodeCall(ProbeEnroller.enroll, (777)), 1))
        );
        emit log_named_uint("delegatecall ok", ok ? 1 : 0);
        emit log_bytes(ret);
        emit log_named_uint("rf allowance", IERC20x(RF).allowance(address(tba), bank));
        emit log_named_uint("weth allowance", IERC20x(WETH).allowance(address(tba), bank));
    }

    function test_probe_allowanceSurvivesSale() public {
        address bank = address(0xBA4C);
        vm.prank(owner);
        tba.execute(RF, 0, abi.encodeCall(IERC20x.approve, (bank, type(uint256).max)), 0);
        uint256 s0 = tba.state();
        address buyer = address(0xB0B);
        vm.prank(owner);
        INFT(GENESIS).transferFrom(owner, buyer, ID);
        assertEq(tba.owner(), buyer, "TBA owner follows the NFT");
        assertEq(INFT(GENESIS).tokenBoundAccount(ID), address(tba), "TBA address stable across sale");
        emit log_named_uint("state before", s0);
        emit log_named_uint("state after", tba.state());
        assertEq(IERC20x(RF).allowance(address(tba), bank), type(uint256).max, "ALLOWANCE SURVIVES THE SALE");
        vm.prank(owner);
        vm.expectRevert();
        tba.execute(RF, 0, abi.encodeCall(IERC20x.approve, (bank, 0)), 0);  // old owner can no longer revoke
    }

    function test_probe_1271() public {
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        vm.prank(owner);
        INFT(GENESIS).transferFrom(owner, signer, ID);
        bytes32 h = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        (bool ok, bytes memory ret) = address(tba).staticcall(abi.encodeCall(ITBA.isValidSignature, (h, abi.encodePacked(r, s, v))));
        emit log_named_uint("1271 raw call ok", ok ? 1 : 0);
        emit log_bytes(ret);
        (ok, ret) = address(tba).staticcall(abi.encodeCall(ITBA.isValidSigner, (signer, "")));
        emit log_named_uint("isValidSigner ok", ok ? 1 : 0);
        emit log_bytes(ret);
    }

    function test_probe_claimCreditsTba() public {
        // find an activated Genesis with something earned, 1..60
        for (uint256 i = 1; i <= 60; ++i) {
            try IAM(AM).earned(WETH, GENESIS, i) returns (uint256 e) {
                if (e == 0 || i == 259 || INFT(GENESIS).ownerOf(i) == HUNT) continue;
                address t = INFT(GENESIS).tokenBoundAccount(i);
                address o = INFT(GENESIS).ownerOf(i);
                uint256 tb = IERC20x(WETH).balanceOf(t);
                uint256 ob = IERC20x(WETH).balanceOf(o);
                vm.prank(address(0xCAFE));
                uint256 got = IAM(AM).claim(WETH, GENESIS, i);
                emit log_named_uint("genesis id", i);
                emit log_named_uint("claimed", got);
                assertEq(IERC20x(WETH).balanceOf(t) - tb, got, "credit lands in the TBA");
                assertEq(IERC20x(WETH).balanceOf(o), ob, "owner EOA untouched");
                assertEq(IERC20x(WETH).balanceOf(address(0xCAFE)), 0, "caller gets nothing");
                return;
            } catch { continue; }
        }
        revert("no earning genesis found in 1..60");
    }
}
