// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/FriendBank.sol";
import {RangeDesk} from "../src/RangeDesk.sol";
import {TickMath} from "../src/vendor/TickMath.sol";
import "./Mocks.sol";
import "./MockPoolManager.sol";

contract Handler is Test {
    FriendBank public bank;
    MToken public rf;
    MToken public weth;
    MCollection public genesis;
    MCollection public gens;
    MActivation public am;
    MPoolManager public pm;
    address public keeper;

    address[4] public actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
    MCollection[6] public cols;
    uint256[6] public ids;

    // conservation ghosts
    uint256 public inR;
    uint256 public inW;
    uint256 public outR;
    uint256 public outW;
    uint256 public tipsW;
    uint256 public donR;
    uint256 public donW;
    int256 public fillR;     // RF that fills added to (bids) or took from (asks) the bank's ranges
    int256 public fillW;
    int24 constant SPOT = -143580;
    int24 constant ASK_LO = SPOT + 300;
    int24 constant ASK_HI = SPOT + 900;
    int24 constant BID_HI = SPOT - 300;
    int24 constant BID_LO = SPOT - 900;

    // safety ghosts
    uint256 public violations;
    uint256 public nOpens;
    uint256 public nFills;
    uint256 public nCloses;
    uint256 public nRangeExits;
    uint256 public nPulls;
    uint256 public nNotHeldTries;
    uint256 public nExits;
    mapping(address => uint256) public principalW;   // owner money parked in a Friend wallet, never to be pulled
    mapping(address => uint256) public principalR;
    // rewards the Bank's own collects claimed into each wallet, and what it pulled out of each wallet
    mapping(address => uint256) public claimedR;
    mapping(address => uint256) public claimedW;
    mapping(address => uint256) public pulledR;
    mapping(address => uint256) public pulledW;

    constructor(FriendBank b, MToken r, MToken w, MCollection g1, MCollection g2, MActivation a, MPoolManager m, address k) {
        bank = b;
        rf = r;
        weth = w;
        genesis = g1;
        gens = g2;
        am = a;
        pm = m;
        keeper = k;
        for (uint256 i; i < 6; ++i) {
            cols[i] = i < 3 ? g1 : g2;
            ids[i] = 100 + i;
            cols[i].mint(ids[i], actors[i % 4]);
        }
    }

    function _f(uint256 s) internal view returns (MCollection c, uint256 id, address tba) {
        uint256 i = s % 6;
        c = cols[i];
        id = ids[i];
        tba = c.tokenBoundAccount(id);
    }

    function join(uint256 s, uint128 capR, uint128 capW) external {
        (MCollection c, uint256 id, address tba) = _f(s);
        address o = c.ownerOf(id);
        vm.startPrank(o);
        MTBA(tba).execute(address(rf), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        MTBA(tba).execute(address(weth), 0, abi.encodeCall(MToken.approve, (address(bank), type(uint256).max)), 0);
        try bank.join(address(c), id, uint128(bound(capR, 1, 1e30)), uint128(bound(capW, 1, 1e24)), false) {} catch {}
        vm.stopPrank();
    }

    function parkPrincipal(uint256 s, uint96 r, uint96 w) external {
        (,, address tba) = _f(s);
        rf.mint(tba, r);
        weth.mint(tba, w);
        principalR[tba] += r;
        principalW[tba] += w;
    }

    struct Snap {
        uint256 owedR;
        uint256 owedW;
        bool held;
        uint256 tbaR;
        uint256 tbaW;
        uint256 bR;
        uint256 bW;
        uint256 callerW;
        address caller;
    }

    function accrueAndCollect(uint256 s, uint96 r, uint64 w, uint256 callerSeed) external {
        (MCollection c, uint256 id, address tba) = _f(s);
        if (r != 0) am.accrue(address(rf), address(c), id, r);
        if (w != 0) am.accrue(address(weth), address(c), id, w);
        Snap memory x;
        x.owedR = am.earned(address(rf), address(c), id);
        x.owedW = am.earned(address(weth), address(c), id);
        FriendBank.Friend memory f = bank.friendOf(address(c), id);
        x.held = f.active && c.ownerOf(id) == f.holder;
        x.tbaR = rf.balanceOf(tba);
        x.tbaW = weth.balanceOf(tba);
        x.bR = rf.balanceOf(address(bank));
        x.bW = weth.balanceOf(address(bank));
        x.caller = callerSeed % 3 == 0 ? keeper : actors[callerSeed % 4];
        x.callerW = weth.balanceOf(x.caller);

        address[] memory cs = new address[](1);
        uint256[] memory is_ = new uint256[](1);
        (cs[0], is_[0]) = (address(c), id);
        vm.prank(x.caller);
        bank.collect(cs, is_);
        _check(x, tba);
    }

    function _check(Snap memory x, address tba) internal {
        uint256 gotR = rf.balanceOf(address(bank)) - x.bR;
        uint256 tip = weth.balanceOf(x.caller) - x.callerW;
        uint256 gotW = weth.balanceOf(address(bank)) + tip - x.bW;
        if (!x.held && x.owedW + x.owedR != 0) nNotHeldTries++;
        if (gotR + gotW != 0) nPulls++;
        if (!x.held && (gotR != 0 || gotW != 0)) violations++;                               // pulled from a Friend not held
        if (rf.balanceOf(tba) != x.tbaR + x.owedR - gotR && rf.balanceOf(tba) != x.tbaR) violations++; // took more than claimed
        // rewards only, in aggregate: never more out of a wallet than the Bank's own claims put in
        claimedR[tba] += rf.balanceOf(tba) + gotR - x.tbaR;
        claimedW[tba] += weth.balanceOf(tba) + gotW - x.tbaW;
        pulledR[tba] += gotR;
        pulledW[tba] += gotW;
        if (pulledR[tba] > claimedR[tba] || pulledW[tba] > claimedW[tba]) violations++;
        if (tip * 10_000 > gotW * bank.MAX_TIP_BPS()) violations++;
        inR += gotR;
        inW += gotW - tip;
        tipsW += tip;
    }

    function _freshTwap() internal {
        try bank.OBSERVER().twapTick() returns (int24) {} catch {
            for (uint256 i; i < 14; ++i) {
                bank.poke();
                vm.warp(block.timestamp + 5 minutes);
            }
            bank.poke();
        }
    }

    function place(bool isAsk, uint256 frac) external {
        _freshTwap();
        uint256 side = isAsk ? bank.bookR() : bank.bookW();
        uint256 amt = side * bound(frac, 100, 1500) / 10_000;
        vm.prank(keeper);
        if (isAsk) {
            try bank.placeAsk(ASK_LO, ASK_HI, amt) { ++nOpens; } catch {}
        } else {
            try bank.placeBid(BID_LO, BID_HI, amt) { ++nOpens; } catch {}
        }
    }

    function _pos(bool isAsk) internal view returns (uint256 x, uint256 y) {
        address d = address(bank.DESK());
        bytes32 k = isAsk ? pm.key(d, ASK_LO, ASK_HI, bytes32(uint256(1))) : pm.key(d, BID_LO, BID_HI, bytes32(uint256(2)));
        (, x, y) = pm.pos(k);
    }

    function positionsR() external view returns (uint256) {
        (uint256 a,) = _pos(true);
        (uint256 b,) = _pos(false);
        return a + b;
    }

    function positionsW() external view returns (uint256) {
        (, uint256 a) = _pos(true);
        (, uint256 b) = _pos(false);
        return a + b;
    }

    function fill(bool isAsk, bool back, uint256 bps, uint256 priceTick) external {
        (uint256 x0, uint256 y0) = _pos(isAsk);
        if (x0 + y0 == 0) return;
        uint256 p = _px(int24(int256(bound(priceTick, 0, 1200))) + (isAsk ? ASK_LO - 300 : BID_LO - 300));
        _fill(isAsk, isAsk != back, bound(bps, 0, 10_000), p);
        (uint256 x1, uint256 y1) = _pos(isAsk);
        fillR += int256(x1) - int256(x0);
        fillW += int256(y1) - int256(y0);
        ++nFills;
    }

    function _px(int24 t) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(t);
        return (s * s / 2 ** 96) * 1e36 / 2 ** 96;
    }

    /// An ask sells RF when the price rises and buys it back when it falls; a bid the reverse.
    function _fill(bool isAsk, bool sellRf, uint256 bps, uint256 p) internal {
        if (isAsk) pm.fill(address(bank.DESK()), ASK_LO, ASK_HI, bytes32(uint256(1)), sellRf, bps, p);
        else pm.fill(address(bank.DESK()), BID_LO, BID_HI, bytes32(uint256(2)), sellRf, bps, p);
    }

    function close(bool isAsk) external {
        vm.prank(keeper);
        if (isAsk) {
            try bank.closeAsk() { ++nCloses; } catch {}
        } else {
            try bank.closeBid() { ++nCloses; } catch {}
        }
    }

    function exitRanges(uint256 a) external {
        vm.prank(actors[a % 4]);
        bank.exitRanges();       // must never revert
        ++nRangeExits;
    }

    function withdraw(uint256 a, uint256 bpsR, uint256 bpsW) external {
        address who = actors[a % 4];
        (uint256 r, uint256 w) = bank.claimOf(who);
        uint256 xr = r * bound(bpsR, 0, 10_000) / 10_000;
        uint256 xw = w * bound(bpsW, 0, 10_000) / 10_000;
        vm.prank(who);
        bank.withdraw(xr, xw, who);          // must never revert for an amount within the claim
        outR += xr;
        outW += xw;
        if (xr + xw != 0) nExits++;
    }

    function sell(uint256 s, uint256 to) external {
        (MCollection c, uint256 id,) = _f(s);
        address o = c.ownerOf(id);
        address n = actors[to % 4];
        if (n == o) return;
        vm.prank(o);
        c.transferFrom(o, n, id);
    }

    function leave(uint256 s) external {
        (MCollection c, uint256 id,) = _f(s);
        vm.prank(c.ownerOf(id));
        try bank.leave(address(c), id) {} catch {}
    }

    function donate(uint96 r, uint64 w) external {
        rf.mint(address(bank), r);
        weth.mint(address(bank), w);
        donR += r;
        donW += w;
    }

    function settle(uint256 a, uint256 n) external {
        bank.settle(actors[a % 4], bound(n, 1, 50));
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 3 days));
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i];
    }
}

contract Invariants is Test {
    Handler h;
    FriendBank bank;
    MToken rf;
    MToken weth;

    function setUp() public {
        MToken a = new MToken("A");
        MToken b = new MToken("B");
        (rf, weth) = address(a) < address(b) ? (a, b) : (b, a);
        MCollection g1 = new MCollection();
        MCollection g2 = new MCollection();
        MActivation am = new MActivation();
        MPoolManager pm = new MPoolManager(rf, weth, -143580);
        MHook hk = new MHook(address(am));
        hk.setPool(address(rf), address(weth));
        address keeper = address(0xC0FFEE);
        bank = new FriendBank(FriendBank.Config({
            rf: address(rf), weth: address(weth), activation: address(am), genesis: address(g1),
            generations: address(g2), poolManager: address(pm), hook: address(hk), poolFee: 0x800000,
            tickSpacing: 60, keeper: keeper
        }));
        vm.fee(0.05 gwei);
        h = new Handler(bank, rf, weth, g1, g2, am, pm, keeper);
        for (uint256 i; i < 6; ++i) h.join(i, type(uint128).max, type(uint128).max);
        targetContract(address(h));
    }

    function afterInvariant() public {
        emit log_named_uint("ranges opened", h.nOpens());
        emit log_named_uint("fills", h.nFills());
        emit log_named_uint("ranges closed", h.nCloses());
        emit log_named_uint("range exits", h.nRangeExits());
        emit log_named_uint("collects that pulled", h.nPulls());
        emit log_named_uint("collects on a Friend NOT held (must pull 0)", h.nNotHeldTries());
        emit log_named_uint("non-zero withdrawals", h.nExits());
        emit log_named_uint("steps", bank.stepCount());
    }

    function _sumLines() internal view returns (uint256[4] memory t) {
        for (uint256 i; i < 4; ++i) {
            uint256[4] memory v = bank.lineOf(h.actor(i));
            for (uint256 k; k < 4; ++k) t[k] += v[k];
        }
    }

    /// Summed over every holder: idle claims <= book <= balance, and range units <= the range's units.
    function invariant_ClaimsLeBookLeBalance() public view {
        uint256[4] memory t = _sumLines();
        (,, uint256 askUnits) = bank.ask();
        (,, uint256 bidUnits) = bank.bid();
        assertLe(t[0], bank.bookR(), "sum RF claims > book");
        assertLe(t[1], bank.bookW(), "sum WETH claims > book");
        assertLe(t[2], askUnits, "ask units claimed > range");
        assertLe(t[3], bidUnits, "bid units claimed > range");
        assertLe(bank.bookR(), rf.balanceOf(address(bank)), "book RF > balance");
        assertLe(bank.bookW(), weth.balanceOf(address(bank)), "book WETH > balance");
        assertEq(rf.balanceOf(address(bank.DESK())) + weth.balanceOf(address(bank.DESK())), 0, "the desk keeps nothing");
    }

    /// Every token is accounted for: held by the bank or in its ranges = collected + fills + donations - withdrawn.
    function invariant_Conservation() public view {
        assertEq(
            int256(rf.balanceOf(address(bank)) + h.positionsR()),
            int256(h.inR() + h.donR()) + h.fillR() - int256(h.outR()),
            "RF"
        );
        assertEq(
            int256(weth.balanceOf(address(bank)) + h.positionsW()),
            int256(h.inW() + h.donW()) + h.fillW() - int256(h.outW()),
            "WETH"
        );
    }

    /// The public counters match the Friend records: enrolled Friends, and distinct addresses holding one.
    function invariant_BankTotalsCountsMatchRecords() public view {
        uint256 active;
        address[6] memory hs;
        uint256 distinct;
        for (uint256 i; i < 6; ++i) {
            FriendBank.Friend memory f = bank.friendOf(address(h.cols(i)), h.ids(i));
            if (!f.active) continue;
            ++active;
            bool seen;
            for (uint256 j; j < distinct; ++j) if (hs[j] == f.holder) seen = true;
            if (!seen) hs[distinct++] = f.holder;
        }
        (uint256 rI, uint256 wI, uint256 rA, uint256 wB, uint256 fr, uint256 ho) = bank.bankTotals();
        assertEq(fr, active, "activeFriends");
        assertEq(ho, distinct, "holders");
        (,, uint256 askUnits) = bank.ask();
        (,, uint256 bidUnits) = bank.bid();
        assertEq(rI, bank.bookR());
        assertEq(wI, bank.bookW());
        assertEq(rA, askUnits);
        assertEq(wB, bidUnits);
    }

    /// Never pulled from a Friend its holder no longer owns, never more than the Bank's claims, tip bounded.
    function invariant_NoWrongfulPull() public view {
        assertEq(h.violations(), 0);
    }

    /// Money the owner parked in a Friend wallet is never taken.
    function invariant_PrincipalInFriendWalletsUntouched() public view {
        for (uint256 i; i < 6; ++i) {
            (MCollection c, uint256 id) = (h.cols(i), h.ids(i));
            address tba = c.tokenBoundAccount(id);
            assertGe(rf.balanceOf(tba), h.principalR(tba));
            assertGe(weth.balanceOf(tba), h.principalW(tba));
        }
    }

    /// Everyone can leave at once, open ranges included, with no keeper, and nobody is owed anything after.
    function invariant_EveryoneCanExit() public {
        uint256 snap = vm.snapshotState();
        bank.removeKeeper();
        for (uint256 i; i < 4; ++i) {
            address a = h.actor(i);
            vm.prank(a);
            bank.withdrawAll(a);
        }
        for (uint256 i; i < 4; ++i) {
            uint256[4] memory v = bank.lineOf(h.actor(i));
            assertEq(v[0] + v[1] + v[2] + v[3], 0, "a holder is still owed after withdrawAll");
        }
        assertLe(bank.bookR(), rf.balanceOf(address(bank)));
        assertLe(bank.bookW(), weth.balanceOf(address(bank)));
        vm.revertToState(snap);
    }
}
