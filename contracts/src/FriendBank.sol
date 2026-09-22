// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolObserver} from "./PoolObserver.sol";
import {RangeDesk} from "./RangeDesk.sol";

/*
                  THE FIRST BANK OF FRIENDS (V2; research prototype, NOT audited, NOT deployed)

  A Friend holder signs up once. After that, the rewards the protocol streams to their
  Friend are claimed into the Friend's own wallet and pulled into the Bank, where they
  sit in the holder's OWN ledger line. By default the Bank only harvests and holds.
  An optional desk makes markets as a MAKER ONLY: it rests single-sided Uniswap v4 range
  orders on the RF/WETH pool (asks hold only RF, bids hold only WETH). The pool's hook has
  no liquidity callbacks, so a range order pays no hook fee, and the desk never swaps.

  THE LEDGER IS EXACT AND USES NO PRICE
  =====================================
  Every holder owns an exact vector (r, w, a, b): idle RF, idle WETH, units in the open ask
  range, units in the open bid range. There are no shares and no NAV. Every desk action is
  a linear step applied lazily to each holder:

      open ask  (U of the book's R RF go into the range):  a += r * U / R,  r = r * (R - U) / R
      open bid  (U of the book's W WETH):                  b += w * U / W,  w = w * (W - U) / W
      close ask (the range's remaining U units came back as dR RF and dW WETH):
                                                           r += a * dR / U, w += a * dW / U, a = 0
      close bid (likewise):                                r += b * dR / U, w += b * dW / U, b = 0

  So a range's proceeds go ONLY to the holders who funded it, in proportion to what they put
  in; a later depositor shares nothing, and a holder who exited early is not paid twice.
  Deposits and withdrawals never write a step, so nothing one holder does can move another
  holder's claim. Every holder's update rounds DOWN, so claims never exceed the book, and
  the book never exceeds what the contract actually holds.

  GUARANTEES, EACH WITH A TEST (test/FriendBank.t.sol, test/Desk.t.sol, test/Invariants.t.sol)
  ================================================================================================
  1. Only the pinned collections (Genesis, and Generations with generation >= 1) can be
     enrolled, and the wallet must report itself as that Friend's token-bound account.
  2. By default the Bank pulls ONLY what its own claims put into the wallet, capped per asset
     per day and by the allowance. A balance the wallet already held is never taken. What it
     claimed but could not pull yet is remembered as owed and retried, and forfeited the moment
     the owner acts through the wallet. (Opt-in SWEEP mode instead pulls anything above what
     the wallet held at signup.)
  3. Every collection re-checks that the Friend still belongs to the holder of record. If it has
     been sold, the Friend is suspended and nothing is claimed or pulled; the buyer's wallet is
     never touched. What the seller deposited before the sale stays the seller's.
  4. Idle funds leave in kind, per asset, any amount, any time: no timelock, queue, pause, keeper,
     owner or price, and no call to the pool, the rewards contract or the market. A holder's share
     of an open range can be taken out by the holder alone (`exitRanges`), by burning exactly
     their share of the range's liquidity. Every range can be closed by anyone once it expires,
     or at any time once quoting is halted or there is no keeper.
  5. The desk can never sell RF below the average cost of the RF it bought plus LOCK_BPS, except
     by spending a small rolling loss budget, and can never bid above its last sale's average
     price minus LOCK_BPS. Every range must sit on the far side of a truncated, time-weighted
     price that anyone can update, never the spot price the keeper could have just moved.
  6. The owner can halt quoting, propose a keeper (2-day delay, never itself), remove the keeper
     at once, and tighten caps. It has no function that reads or writes a holder's line.
*/

interface IERC20V2 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IActivationManagerV2 {
    function claim(address asset, address collection, uint256 tokenId) external returns (uint256);
    function earned(address asset, address collection, uint256 tokenId) external view returns (uint256);
    function allocate(address asset) external;
    function streams(address asset)
        external
        view
        returns (uint256 pending, uint256 rate, uint256 finish, uint256 lastUpdate, uint256 rpw, uint256 rem);
}

interface IFriendCollectionV2 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenBoundAccount(uint256 tokenId) external view returns (address);
}

interface IGenerationsV2 {
    function generation(uint256 tokenId) external view returns (uint8);
}

interface IERC6551AccountV2 {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function state() external view returns (uint256);
}

interface IHookV2 {
    function rewards() external view returns (address);
}

contract FriendBank {
    /* ================================================================== errors */
    error NotOwner();
    error NotPendingOwner();
    error NotKeeper();
    error BadKeeper();
    error KeeperNotReady();
    error NotFriendOwner();
    error UnknownCollection();
    error TemporaryFriend();
    error BadAccount();
    error AlreadyJoined();
    error NotAMember();
    error ZeroCap();
    error DeskHalted();
    error CapTooHigh();
    error TooSmall();
    error TooManyModifies();
    error RangeOpen();
    error NoRange();
    error NotCloseable();
    error OnlyTightening();
    error BookTooSmall();
    error Insufficient();
    error NotSettled();
    error TransferFailed();
    error Reentrancy();
    error BadDelta();

    /* ================================================================== events */
    event Joined(
        address indexed holder, address indexed collection, uint256 indexed tokenId,
        address tba, uint256 capRf, uint256 capWeth, bool sweep
    );
    event Left(address indexed holder, address indexed collection, uint256 indexed tokenId, address by);
    event Suspended(address indexed holder, address indexed collection, uint256 indexed tokenId, address currentOwner);
    event Collected(
        address indexed holder, address indexed collection, uint256 indexed tokenId,
        uint256 rf, uint256 weth, uint256 tip, address caller
    );
    event Owed(address indexed collection, uint256 indexed tokenId, uint256 owedRf, uint256 owedWeth);
    event ClaimFailed(address indexed collection, uint256 indexed tokenId, address asset, uint256 earned);
    event Skipped(address indexed collection, uint256 indexed tokenId, uint8 reason);
    event RewardsRedirected(address hookRewards);
    event Allocated(address asset);
    event Settled(address indexed holder, uint256 fromStep, uint256 toStep);
    event Withdrawn(address indexed holder, address indexed to, uint256 rf, uint256 weth);
    event RangeOpened(bool indexed ask, uint256 indexed step, int24 tickLower, int24 tickUpper, uint256 units);
    event RangeClosed(bool indexed ask, uint256 indexed step, uint256 units, uint256 rfOut, uint256 wethOut);
    event RangeExited(address indexed holder, bool indexed ask, uint256 units, uint256 rf, uint256 weth);
    event QuotingHalted(bool halted);
    event KeeperProposed(address keeper, uint256 eta);
    event KeeperSet(address keeper);
    event CapsTightened(uint256 maxRangeBps, uint256 maxDailyTurnoverBps, uint256 lossBudgetBps, int24 twapEdgeTicks);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    /* =============================================================== constants */
    uint256 internal constant SCALE = 1e36;
    uint256 internal constant BPS = 10_000;
    uint256 public constant EPOCH = 1 days;

    /// @notice Keeper tip: WETH (1:1 with the gas token, so no price is needed), from the collected
    ///         Friend's OWN WETH, at most once per interval, never above MAX_TIP_BPS of it.
    uint256 public constant MAX_TIP_BPS = 100;
    /// @dev Measured on a fork: ~568k gas to claim and pull both assets for one Friend. x2 basefee
    ///      covers the L1 data component that gasUsed does not show on an Orbit chain.
    uint256 public constant TIP_GAS_PER_FRIEND = 400_000;
    uint256 public constant TIP_INTERVAL = 12 hours;

    /// @notice A holder more than this many steps behind is skipped by `collect` until settled.
    uint256 public constant MAX_INLINE_SETTLE = 256;

    /// @notice Desk sizing: a range holds between 1% and maxRangeBps of its side of the book.
    uint256 public constant MIN_BOOK = 1e9;
    uint256 public constant MIN_RANGE_BPS = 100;
    /// @notice At most 24 opens plus closes per rolling day, which also bounds the step log.
    uint256 public constant MAX_MODIFIES_PER_DAY = 24;
    /// @notice A range anyone may close after this long.
    uint256 public constant RANGE_TTL = 7 days;

    uint256 public constant KEEPER_DELAY = 2 days;

    uint8 internal constant SKIP_NOT_ACTIVE = 1;
    uint8 internal constant SKIP_BEHIND = 2;

    uint8 internal constant OPEN_ASK = 0;
    uint8 internal constant OPEN_BID = 1;
    uint8 internal constant CLOSE_ASK = 2;
    uint8 internal constant CLOSE_BID = 3;


    /* ============================================================== immutables */
    IERC20V2 public immutable RF;
    IERC20V2 public immutable WETH;
    IActivationManagerV2 public immutable ACTIVATION;
    address public immutable GENESIS;
    address public immutable GENERATIONS;
    /// @notice The rewards contract's fee source, watched for redirection.
    address public immutable HOOK;
    /// @notice The maker-only desk (deployed by this constructor) and its price observer.
    RangeDesk public immutable DESK;
    PoolObserver public immutable OBSERVER;

    struct Config {
        address rf;
        address weth;
        address activation;
        address genesis;
        address generations;
        address poolManager;
        address hook;
        uint24 poolFee;
        int24 tickSpacing;
        address keeper;
    }

    /* =================================================================== state */
    address public owner;
    address public pendingOwner;
    address public keeper;
    address public pendingKeeper;
    uint256 public pendingKeeperEta;
    bool public quotingHalted;
    uint256 private _lock = 1;

    /// @dev Desk caps. Each can only be tightened. (The loss budget and TWAP edge live in the desk.)
    uint256 public maxRangeBps = 1500;
    uint256 public maxDailyTurnoverBps = 5000;

    /// @dev Rolling counters: each decays linearly to zero over a day.
    uint256 public usedBpsRf;
    uint256 public usedBpsWeth;
    uint256 public usedModifies;   // x1e18
    uint256 public usedAt;

    /// @dev Units attributed to holders in each open range: RF for the ask, WETH for the bid.
    struct Units {
        bool open;
        uint64 openedAt;
        uint256 units;
    }

    Units public ask;
    Units public bid;

    struct Friend {
        address holder;      // ownerOf at join. Pulls are credited here and only while this is still the owner.
        uint64 epochStart;
        uint64 lastTipAt;
        bool active;
        bool sweep;          // opt-in: pull anything above the signup balance, not only the Bank's own claims
        address tba;
        uint128 capRf;       // per EPOCH, RF units
        uint128 capWeth;     // per EPOCH, WETH units
        uint128 pulledRf;
        uint128 pulledWeth;
        uint128 owedRf;      // claimed by the Bank into the wallet but not yet pulled
        uint128 owedWeth;
        uint128 floorRf;     // sweep mode only: the wallet balance at signup, never taken
        uint128 floorWeth;
        uint256 seenState;   // the wallet's execute nonce when owed was last recorded
    }

    struct Position {
        uint256 r;           // idle RF, valid as of `step`
        uint256 w;           // idle WETH
        uint256 a;           // units in the open ask range
        uint256 b;           // units in the open bid range
        uint256 step;        // index of the next step not yet applied
        uint256 inR;         // lifetime deposits and withdrawals, for the P&L view only
        uint256 inW;
        uint256 outR;
        uint256 outW;
    }

    /// @dev open: x = keep, y = gain.  close: x = RF per unit, y = WETH per unit. All / SCALE.
    struct Step {
        uint8 kind;
        uint256 x;
        uint256 y;
    }

    mapping(bytes32 => Friend) internal friends;
    mapping(address => Position) public positions;
    Step[] public steps;

    /// @notice Sum of every holder's idle claim before rounding. Internal accounting, never balanceOf.
    uint256 public bookR;
    uint256 public bookW;

    /// @notice Friends currently enrolled (joined, not left, not suspended), and addresses with at least one.
    uint256 public activeFriends;
    uint256 public holders;
    mapping(address => uint256) public activeFriendsOf;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(Config memory c) {
        if (c.keeper == msg.sender) revert BadKeeper();
        require(c.rf < c.weth, "RF must be currency0");
        RF = IERC20V2(c.rf);
        WETH = IERC20V2(c.weth);
        ACTIVATION = IActivationManagerV2(c.activation);
        GENESIS = c.genesis;
        GENERATIONS = c.generations;
        HOOK = c.hook;
        RangeDesk desk = new RangeDesk(c.rf, c.weth, c.poolManager, c.hook, c.poolFee, c.tickSpacing);
        DESK = desk;
        OBSERVER = desk.OBSERVER();
        owner = msg.sender;
        keeper = c.keeper;
        emit OwnershipTransferred(address(0), msg.sender);
        emit KeeperSet(c.keeper);
    }

    /* ==================================================================== JOIN */

    /**
     * @notice Enrol a Friend. Callable by the Friend's owner, or by its token-bound wallet (so a wallet
     *         that can batch calls can do approve RF, approve WETH and join in one confirmation). This
     *         records consent and caps; it moves nothing. The Bank can pull only after the owner has
     *         approved it FROM the Friend's wallet.
     * @param sweep false (default): pull only what the Bank's own claims add. true: pull anything above
     *        the wallet's balance right now, which also catches rewards someone else claimed.
     */
    function join(address collection, uint256 tokenId, uint128 capRfPerDay, uint128 capWethPerDay, bool sweep)
        public
    {
        if (collection != GENESIS && collection != GENERATIONS) revert UnknownCollection();
        if (collection == GENERATIONS && IGenerationsV2(collection).generation(tokenId) == 0) revert TemporaryFriend();
        if (capRfPerDay == 0 && capWethPerDay == 0) revert ZeroCap();

        address holder = IFriendCollectionV2(collection).ownerOf(tokenId);
        address tba = IFriendCollectionV2(collection).tokenBoundAccount(tokenId);
        if (msg.sender != holder && msg.sender != tba) revert NotFriendOwner();
        if (holder == tba || tba == address(0)) revert BadAccount();
        (uint256 chainId, address tc, uint256 tid) = IERC6551AccountV2(tba).token();
        if (chainId != block.chainid || tc != collection || tid != tokenId) revert BadAccount();

        Friend storage f = friends[_key(collection, tokenId)];
        if (f.active) {
            if (f.holder == holder) revert AlreadyJoined();
            emit Suspended(f.holder, collection, tokenId, holder);   // sold without anyone noticing yet
            _deactivate(f.holder);
        }
        _activate(holder);
        f.holder = holder;
        f.tba = tba;
        f.active = true;
        f.sweep = sweep;
        f.capRf = capRfPerDay;
        f.capWeth = capWethPerDay;
        f.pulledRf = 0;
        f.pulledWeth = 0;
        f.owedRf = 0;
        f.owedWeth = 0;
        f.floorRf = sweep ? uint128(RF.balanceOf(tba)) : 0;
        f.floorWeth = sweep ? uint128(WETH.balanceOf(tba)) : 0;
        f.seenState = IERC6551AccountV2(tba).state();
        f.epochStart = uint64(block.timestamp);
        f.lastTipAt = 0;
        emit Joined(holder, collection, tokenId, tba, capRfPerDay, capWethPerDay, sweep);
    }

    /// @notice Stop the Bank pulling from this Friend. The holder of record, the current owner, or the
    ///         Friend's wallet may call it. It never touches what is already in the Bank.
    function leave(address collection, uint256 tokenId) public {
        Friend storage f = friends[_key(collection, tokenId)];
        if (!f.active) revert NotAMember();
        if (msg.sender != f.holder && msg.sender != f.tba && msg.sender != _ownerOrZero(collection, tokenId)) {
            revert NotFriendOwner();
        }
        f.active = false;
        _deactivate(f.holder);
        emit Left(f.holder, collection, tokenId, msg.sender);
    }

    /// @notice Anyone may suspend a Friend that no longer belongs to its holder of record.
    function suspendIfTransferred(address collection, uint256 tokenId) external {
        Friend storage f = friends[_key(collection, tokenId)];
        if (f.active && !_stillHeld(collection, tokenId, f)) _suspend(collection, tokenId, f);
    }

    /* ================================================================= COLLECT */

    /**
     * @notice Claim each Friend's rewards into its own wallet and pull them into the holder's line.
     *         PERMISSIONLESS: the destination of every unit is fixed by the contract, not by the caller.
     *         Also starts the protocol's next reward stream when one is due, and raises an alarm if
     *         the swap fee is no longer routed to the rewards contract.
     */
    function collect(address[] calldata collections, uint256[] calldata tokenIds) external nonReentrant {
        if (collections.length != tokenIds.length) revert BadAccount();
        _maintenance();
        for (uint256 j; j < collections.length; ++j) {
            _collectOne(collections[j], tokenIds[j]);
        }
    }

    function _maintenance() internal {
        try IHookV2(HOOK).rewards() returns (address r) {
            if (r != address(ACTIVATION)) emit RewardsRedirected(r);
        } catch {
            emit RewardsRedirected(address(0));
        }
        _allocateIfDue(address(WETH));
        _allocateIfDue(address(RF));
        try OBSERVER.poke() {} catch {}   // harvesting must never depend on the pool
    }

    function _allocateIfDue(address asset) internal {
        try ACTIVATION.streams(asset) returns (uint256 pending, uint256, uint256 finish, uint256, uint256, uint256) {
            if (pending == 0 || block.timestamp < finish) return;
        } catch {
            return;
        }
        try ACTIVATION.allocate(asset) {
            emit Allocated(asset);
        } catch {}
    }

    function _collectOne(address collection, uint256 tokenId) internal {
        Friend storage f = friends[_key(collection, tokenId)];
        if (!f.active) {
            emit Skipped(collection, tokenId, SKIP_NOT_ACTIVE);
            return;
        }
        if (!_stillHeld(collection, tokenId, f)) {
            _suspend(collection, tokenId, f);
            return;
        }
        Position storage p = positions[f.holder];
        if (steps.length - p.step > MAX_INLINE_SETTLE && !_empty(p)) {
            emit Skipped(collection, tokenId, SKIP_BEHIND);
            return;
        }
        _settle(f.holder, p, type(uint256).max);

        if (block.timestamp >= uint256(f.epochStart) + EPOCH) {
            f.epochStart = uint64(block.timestamp);
            f.pulledRf = 0;
            f.pulledWeth = 0;
        }

        // Owed is honoured only while the owner has not touched the wallet since it was recorded. Any
        // `execute` bumps the wallet's state, and then the Bank can no longer tell its unpulled rewards
        // from the owner's own money, so it takes neither.
        uint256 st = IERC6551AccountV2(f.tba).state();
        if (st != f.seenState) {
            f.owedRf = 0;
            f.owedWeth = 0;
            f.seenState = st;
        }
        uint256 rf = _claimAndPull(RF, collection, tokenId, f, true);
        uint256 weth = _claimAndPull(WETH, collection, tokenId, f, false);
        if (f.owedRf != 0 || f.owedWeth != 0) emit Owed(collection, tokenId, f.owedRf, f.owedWeth);
        if (rf == 0 && weth == 0) return;

        uint256 tip;
        if (weth != 0 && msg.sender != f.holder && block.timestamp >= uint256(f.lastTipAt) + TIP_INTERVAL) {
            tip = Math.min(TIP_GAS_PER_FRIEND * block.basefee * 2, (weth * MAX_TIP_BPS) / BPS);
            if (tip != 0) f.lastTipAt = uint64(block.timestamp);
        }

        p.r += rf;
        p.w += weth - tip;
        p.inR += rf;
        p.inW += weth - tip;
        bookR += rf;
        bookW += weth - tip;

        if (tip != 0 && !WETH.transfer(msg.sender, tip)) revert TransferFailed();
        emit Collected(f.holder, collection, tokenId, rf, weth, tip, msg.sender);
    }

    /**
     * @dev Default mode: available = owed (clamped to the wallet balance) + what THIS call's claim added.
     *      Sweep mode: available = wallet balance above the signup floor.
     *      Then pull min(available, today's room, allowance). A pull that fails stays owed.
     */
    function _claimAndPull(IERC20V2 token, address collection, uint256 tokenId, Friend storage f, bool isRf)
        internal
        returns (uint256 got)
    {
        uint256 room = isRf ? f.capRf - f.pulledRf : f.capWeth - f.pulledWeth;
        if (room == 0) return 0;
        address tba = f.tba;
        uint256 allowed = token.allowance(tba, address(this));
        if (allowed == 0) return 0;

        uint256 before = token.balanceOf(tba);
        try ACTIVATION.claim(address(token), collection, tokenId) {}
        catch {
            _reportClaimFailure(token, collection, tokenId);
        }
        uint256 afterClaim = token.balanceOf(tba);

        uint256 available;
        if (f.sweep) {
            uint256 floor = isRf ? f.floorRf : f.floorWeth;
            available = afterClaim > floor ? afterClaim - floor : 0;
        } else {
            uint256 owed = isRf ? f.owedRf : f.owedWeth;
            if (owed > before) owed = before;
            available = owed + (afterClaim > before ? afterClaim - before : 0);
        }

        uint256 amount = Math.min(Math.min(available, room), Math.min(allowed, afterClaim));
        if (amount != 0) got = _pull(token, tba, amount);

        if (!f.sweep) {
            if (isRf) f.owedRf = uint128(available - got);
            else f.owedWeth = uint128(available - got);
        }
        if (isRf) f.pulledRf += uint128(got);
        else f.pulledWeth += uint128(got);
    }

    function _pull(IERC20V2 token, address from, uint256 amount) internal returns (uint256 got) {
        uint256 mine = token.balanceOf(address(this));
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20V2.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) return 0;
        got = token.balanceOf(address(this)) - mine;
    }

    function _reportClaimFailure(IERC20V2 token, address collection, uint256 tokenId) internal {
        try ACTIVATION.earned(address(token), collection, tokenId) returns (uint256 e) {
            if (e != 0) emit ClaimFailed(collection, tokenId, address(token), e);
        } catch {
            emit ClaimFailed(collection, tokenId, address(token), type(uint256).max);
        }
    }

    /* ================================================================== SETTLE */

    /// @notice Walk a holder forward through up to `maxSteps` steps. Permissionless and harmless.
    function settle(address holder, uint256 maxSteps) external returns (bool done) {
        return _settle(holder, positions[holder], maxSteps);
    }

    function _settle(address holder, Position storage p, uint256 maxSteps) internal returns (bool done) {
        uint256 head = steps.length;
        uint256 from = p.step;
        if (from == head) return true;
        if (_empty(p)) {
            p.step = head;
            return true;
        }
        uint256[4] memory v = [p.r, p.w, p.a, p.b];
        uint256 end = head - from > maxSteps ? from + maxSteps : head;
        for (uint256 i = from; i < end; ++i) {
            _apply(steps[i], v);
        }
        p.r = v[0];
        p.w = v[1];
        p.a = v[2];
        p.b = v[3];
        p.step = end;
        emit Settled(holder, from, end);
        return end == head;
    }

    /// @dev Each holder rounds DOWN. SCALE (1e36) exceeds any token balance, so the factors' own rounding
    ///      can never lift the sum of the floors above the book; the floors here keep it below.
    function _apply(Step storage s, uint256[4] memory v) internal view {
        uint8 k = s.kind;
        if (k == OPEN_ASK) {
            uint256 r = v[0];
            v[2] += Math.mulDiv(r, s.y, SCALE);
            v[0] = Math.mulDiv(r, s.x, SCALE);
        } else if (k == OPEN_BID) {
            uint256 w = v[1];
            v[3] += Math.mulDiv(w, s.y, SCALE);
            v[1] = Math.mulDiv(w, s.x, SCALE);
        } else {
            uint256 u = k == CLOSE_ASK ? v[2] : v[3];
            v[0] += Math.mulDiv(u, s.x, SCALE);
            v[1] += Math.mulDiv(u, s.y, SCALE);
            if (k == CLOSE_ASK) v[2] = 0;
            else v[3] = 0;
        }
    }

    /* ================================================================ WITHDRAW */

    /**
     * @notice Take idle RF and WETH out of your line, in kind, any amount, any time. Either amount may be
     *         zero, so WETH can always leave even if RF transfers were ever to fail. Touches nothing but
     *         the two tokens: no pool, no rewards contract, no market.
     * @dev    `quotingHalted` must never gate this. If you are very far behind, `settle` in chunks first.
     */
    function withdraw(uint256 rfAmount, uint256 wethAmount, address to) public nonReentrant {
        _withdraw(rfAmount, wethAmount, to);
    }

    function withdrawRF(uint256 amount, address to) external nonReentrant {
        _withdraw(amount, 0, to);
    }

    function withdrawWETH(uint256 amount, address to) external nonReentrant {
        _withdraw(0, amount, to);
    }

    /// @notice Exit everything: your share of any open range, then all idle RF and WETH.
    function withdrawAll(address to) external nonReentrant {
        _exitRanges(msg.sender);
        Position storage p = positions[msg.sender];
        _withdraw(p.r, p.w, to);
    }

    /**
     * @notice Close your account in one call: stop collecting from each listed Friend you enrolled, take your
     *         share out of any open range, and send every idle RF and WETH you own to `to`. Friends you no
     *         longer hold, or never enrolled, are skipped, never reverted on. To finish closing, revoke the two
     *         approvals from each Friend's wallet: TBA.execute(RF.approve(bank, 0)) and the same for WETH.
     *         The Bank cannot revoke them for you; only the Friend's owner can make its wallet call approve.
     */
    function close(address[] calldata collections, uint256[] calldata tokenIds, address to) external nonReentrant {
        if (collections.length != tokenIds.length) revert BadAccount();
        for (uint256 j; j < collections.length; ++j) {
            Friend storage f = friends[_key(collections[j], tokenIds[j])];
            if (!f.active || f.holder != msg.sender) continue;
            f.active = false;
            _deactivate(msg.sender);
            emit Left(msg.sender, collections[j], tokenIds[j], msg.sender);
        }
        _exitRanges(msg.sender);
        Position storage p = positions[msg.sender];
        _withdraw(p.r, p.w, to);
    }

    function _withdraw(uint256 rfAmount, uint256 wethAmount, address to) internal {
        Position storage p = positions[msg.sender];
        if (!_settle(msg.sender, p, type(uint256).max)) revert NotSettled();
        if (rfAmount > p.r || wethAmount > p.w) revert Insufficient();
        p.r -= rfAmount;
        p.w -= wethAmount;
        p.outR += rfAmount;
        p.outW += wethAmount;
        bookR -= rfAmount;
        bookW -= wethAmount;
        if (rfAmount != 0 && !RF.transfer(to, rfAmount)) revert TransferFailed();
        if (wethAmount != 0 && !WETH.transfer(to, wethAmount)) revert TransferFailed();
        emit Withdrawn(msg.sender, to, rfAmount, wethAmount);
    }

    /**
     * @notice Take your share out of any open range, keeper-free. Burns exactly your units' share of the
     *         range's LIQUIDITY (never an amount recomputed from a price) and credits what comes back to
     *         your idle line. Calls only PoolManager.modifyLiquidity, which the pool's hook never sees.
     */
    function exitRanges() external nonReentrant {
        _exitRanges(msg.sender);
    }

    function _exitRanges(address holder) internal {
        Position storage p = positions[holder];
        if (!_settle(holder, p, type(uint256).max)) revert NotSettled();
        if (p.a != 0 && ask.open) _exitOne(p, true);
        if (p.b != 0 && bid.open) _exitOne(p, false);
    }

    function _exitOne(Position storage p, bool isAsk) internal {
        Units storage u = isAsk ? ask : bid;
        uint256 units = isAsk ? p.a : p.b;
        (uint256 r, uint256 w) = _fromDesk(isAsk, units, u.units, false);
        u.units -= units;
        if (isAsk) p.a = 0;
        else p.b = 0;
        p.r += r;
        p.w += w;
        bookR += r;
        bookW += w;
        emit RangeExited(msg.sender, isAsk, units, r, w);
    }

    /* ==================================================================== DESK */

    /**
     * @notice Rest an ask: `amount` RF from the book in a single-sided range [tickLower, tickUpper] above the
     *         price. Here: halt switch, one ask at a time, size 1% to maxRangeBps of the RF side, rolling
     *         turnover and modify caps. In the desk: correct side of spot, beyond the TWAP by the edge, and
     *         the loss-lock or a loss-budget reservation. The Bank measures what actually went in.
     */
    function placeAsk(int24 tickLower, int24 tickUpper, uint256 amount) external onlyKeeper nonReentrant {
        if (ask.open) revert RangeOpen();
        _preflight(true, amount, bookR);
        uint256 spent = _open(true, tickLower, tickUpper, amount);
        _openStep(OPEN_ASK, spent, bookR);
        bookR -= spent;
        ask = Units(true, uint64(block.timestamp), spent);
        emit RangeOpened(true, steps.length - 1, tickLower, tickUpper, spent);
    }

    /// @notice Rest a bid: `amount` WETH in a single-sided range below the price. Same caps; the desk adds
    ///         the bid loss-lock against the last sale's average price.
    function placeBid(int24 tickLower, int24 tickUpper, uint256 amount) external onlyKeeper nonReentrant {
        if (bid.open) revert RangeOpen();
        _preflight(false, amount, bookW);
        uint256 spent = _open(false, tickLower, tickUpper, amount);
        _openStep(OPEN_BID, spent, bookW);
        bookW -= spent;
        bid = Units(true, uint64(block.timestamp), spent);
        emit RangeOpened(false, steps.length - 1, tickLower, tickUpper, spent);
    }

    /// @notice The keeper may close a range at any time. Anyone may close one older than RANGE_TTL, and anyone
    ///         may close any range while quoting is halted or there is no keeper. Never capped for non-keepers.
    function closeAsk() external nonReentrant {
        _close(true);
    }

    function closeBid() external nonReentrant {
        _close(false);
    }

    function _open(bool isAsk, int24 lo, int24 hi, uint256 amount) internal returns (uint256 spent) {
        IERC20V2 tin = isAsk ? RF : WETH;
        IERC20V2 other = isAsk ? WETH : RF;
        uint256 in0 = tin.balanceOf(address(this));
        uint256 o0 = other.balanceOf(address(this));
        if (!tin.transfer(address(DESK), amount)) revert TransferFailed();
        DESK.open(isAsk, lo, hi, amount, bookR + ask.units, bookW + bid.units);
        uint256 in1 = tin.balanceOf(address(this));
        if (in1 > in0 || other.balanceOf(address(this)) < o0) revert BadDelta();
        spent = in0 - in1;
        if (spent == 0 || spent > amount) revert BadDelta();
    }

    function _close(bool isAsk) internal {
        Units storage u = isAsk ? ask : bid;
        if (!u.open) revert NoRange();
        bool isKeeper = msg.sender == keeper && keeper != address(0);
        if (!isKeeper && block.timestamp < uint256(u.openedAt) + RANGE_TTL && !quotingHalted && keeper != address(0)) {
            revert NotCloseable();
        }
        if (isKeeper) _useModify();
        (uint256 rOut, uint256 wOut) = _fromDesk(isAsk, 0, 0, true);
        uint256 units = u.units;
        if (units != 0) {
            steps.push(Step({
                kind: isAsk ? CLOSE_ASK : CLOSE_BID,
                x: Math.mulDiv(rOut, SCALE, units),
                y: Math.mulDiv(wOut, SCALE, units)
            }));
        }
        bookR += rOut;
        bookW += wOut;
        emit RangeClosed(isAsk, steps.length, units, rOut, wOut);
        delete u.open;
        delete u.units;
        delete u.openedAt;
    }

    /// @dev Everything the desk hands back is measured from the Bank's own balances.
    function _fromDesk(bool isAsk, uint256 num, uint256 den, bool closing) internal returns (uint256 rOut, uint256 wOut) {
        uint256 r0 = RF.balanceOf(address(this));
        uint256 w0 = WETH.balanceOf(address(this));
        DESK.remove(isAsk, num, den, closing, bookR + ask.units, bookW + bid.units);
        uint256 r1 = RF.balanceOf(address(this));
        uint256 w1 = WETH.balanceOf(address(this));
        if (r1 < r0 || w1 < w0) revert BadDelta();
        rOut = r1 - r0;
        wOut = w1 - w0;
    }

    function _preflight(bool isAsk, uint256 amount, uint256 side) internal {
        if (quotingHalted) revert DeskHalted();
        if (side < MIN_BOOK) revert BookTooSmall();
        if (amount * BPS > side * maxRangeBps) revert CapTooHigh();
        if (amount * BPS < side * MIN_RANGE_BPS) revert TooSmall();
        _useModify();
        uint256 used = Math.mulDiv(amount, BPS, side, Math.Rounding.Ceil);
        if (isAsk) {
            usedBpsRf += used;
            if (usedBpsRf > maxDailyTurnoverBps) revert CapTooHigh();
        } else {
            usedBpsWeth += used;
            if (usedBpsWeth > maxDailyTurnoverBps) revert CapTooHigh();
        }
    }

    function _openStep(uint8 kind, uint256 units, uint256 side) internal {
        steps.push(Step({kind: kind, x: Math.mulDiv(side - units, SCALE, side), y: Math.mulDiv(units, SCALE, side)}));
    }

    /// @dev Rolling counters decay linearly to zero over a day, so there is no midnight reset to exploit.
    function _useModify() internal {
        uint256 dt = block.timestamp - usedAt;
        usedAt = block.timestamp;
        uint256 d = Math.mulDiv(dt, maxDailyTurnoverBps, 1 days);
        usedBpsRf = usedBpsRf > d ? usedBpsRf - d : 0;
        usedBpsWeth = usedBpsWeth > d ? usedBpsWeth - d : 0;
        uint256 m = Math.mulDiv(dt, MAX_MODIFIES_PER_DAY * 1e18, 1 days);
        usedModifies = (usedModifies > m ? usedModifies - m : 0) + 1e18;
        if (usedModifies > MAX_MODIFIES_PER_DAY * 1e18) revert TooManyModifies();
    }

    /// @notice Convenience pass-through: anyone may poke the observer directly too.
    function poke() external {
        OBSERVER.poke();
    }

    /* =================================================================== ADMIN */

    /// @notice A new keeper takes effect KEEPER_DELAY after it is proposed, and can never be the owner.
    function proposeKeeper(address k) external onlyOwner {
        if (k == address(0) || k == owner) revert BadKeeper();
        pendingKeeper = k;
        pendingKeeperEta = block.timestamp + KEEPER_DELAY;
        emit KeeperProposed(k, pendingKeeperEta);
    }

    function activateKeeper() external {
        if (pendingKeeper == address(0) || block.timestamp < pendingKeeperEta) revert KeeperNotReady();
        if (pendingKeeper == owner) revert BadKeeper();
        keeper = pendingKeeper;
        pendingKeeper = address(0);
        emit KeeperSet(keeper);
    }

    /// @notice Removing the keeper is immediate: it can only make the desk do less.
    function removeKeeper() external onlyOwner {
        keeper = address(0);
        pendingKeeper = address(0);
        emit KeeperSet(address(0));
    }

    function setQuotingHalted(bool h) external onlyOwner {
        quotingHalted = h;
        emit QuotingHalted(h);
    }

    function tightenCaps(uint256 newMaxRangeBps, uint256 newMaxDailyTurnoverBps, uint256 newLossBudgetBps, int24 newEdge)
        external
        onlyOwner
    {
        if (newMaxRangeBps > maxRangeBps || newMaxDailyTurnoverBps > maxDailyTurnoverBps) revert OnlyTightening();
        maxRangeBps = newMaxRangeBps;
        maxDailyTurnoverBps = newMaxDailyTurnoverBps;
        DESK.tighten(newLossBudgetBps, newEdge);
        emit CapsTightened(newMaxRangeBps, newMaxDailyTurnoverBps, newLossBudgetBps, newEdge);
    }

    function transferOwnership(address n) external onlyOwner {
        pendingOwner = n;
        emit OwnershipTransferStarted(owner, n);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        if (msg.sender == keeper) revert BadKeeper();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Give up admin for good. The desk halts permanently; anyone may then close open ranges.
    function renounce() external onlyOwner {
        quotingHalted = true;
        keeper = address(0);
        pendingKeeper = address(0);
        emit QuotingHalted(true);
        emit KeeperSet(address(0));
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }

    /* ==================================================================== VIEW */

    /// @notice A holder's idle RF and WETH as of the latest step, without writing anything.
    function claimOf(address holder) public view returns (uint256 r, uint256 w) {
        uint256[4] memory v = lineOf(holder);
        return (v[0], v[1]);
    }

    /// @notice A holder's full line: idle RF, idle WETH, ask units (RF), bid units (WETH).
    function lineOf(address holder) public view returns (uint256[4] memory v) {
        Position storage p = positions[holder];
        v = [p.r, p.w, p.a, p.b];
        if (_empty(p)) return v;
        uint256 head = steps.length;
        for (uint256 i = p.step; i < head; ++i) {
            _apply(steps[i], v);
        }
    }

    /// @notice What the keeper needs to plan a collect for one Friend.
    function collectable(address collection, uint256 tokenId)
        external
        view
        returns (
            uint256 earnedRf,
            uint256 earnedWeth,
            uint256 roomRf,
            uint256 roomWeth,
            uint256 allowRf,
            uint256 allowWeth,
            uint256 owedRf,
            uint256 owedWeth
        )
    {
        Friend storage f = friends[_key(collection, tokenId)];
        earnedRf = ACTIVATION.earned(address(RF), collection, tokenId);
        earnedWeth = ACTIVATION.earned(address(WETH), collection, tokenId);
        bool fresh = block.timestamp >= uint256(f.epochStart) + EPOCH;
        roomRf = fresh ? f.capRf : f.capRf - f.pulledRf;
        roomWeth = fresh ? f.capWeth : f.capWeth - f.pulledWeth;
        if (f.tba != address(0)) {
            allowRf = RF.allowance(f.tba, address(this));
            allowWeth = WETH.allowance(f.tba, address(this));
        }
        owedRf = f.owedRf;
        owedWeth = f.owedWeth;
    }

    /**
     * @notice Everything the Bank holds for holders, in one call, for a public display.
     * @return rfIdle     RF in holders' idle lines (the book; rounding dust included, donations excluded)
     * @return wethIdle   WETH likewise
     * @return rfInAsk    RF DEPOSITED into the open ask and still attributed to holders. If the ask has filled,
     *                    part of it is now WETH inside the range; this reports what went in, not the live mix.
     * @return wethInBid  WETH deposited into the open bid, on the same terms
     * @return friends_   Friends enrolled right now (joined, not left, not suspended)
     * @return holders_   addresses with at least one enrolled Friend. A holder who left still owns their line
     *                    until they withdraw, and is counted in the totals above but not here.
     */
    function bankTotals()
        external
        view
        returns (uint256 rfIdle, uint256 wethIdle, uint256 rfInAsk, uint256 wethInBid, uint256 friends_, uint256 holders_)
    {
        return (bookR, bookW, ask.units, bid.units, activeFriends, holders);
    }

    function stepCount() external view returns (uint256) {
        return steps.length;
    }

    function stepsBehind(address holder) external view returns (uint256) {
        return steps.length - positions[holder].step;
    }

    function friendOf(address collection, uint256 tokenId) external view returns (Friend memory) {
        return friends[_key(collection, tokenId)];
    }

    /* ================================================================ INTERNAL */

    function _empty(Position storage p) internal view returns (bool) {
        return p.r == 0 && p.w == 0 && p.a == 0 && p.b == 0;
    }

    function _stillHeld(address collection, uint256 tokenId, Friend storage f) internal view returns (bool) {
        if (_ownerOrZero(collection, tokenId) != f.holder) return false;
        try IFriendCollectionV2(collection).tokenBoundAccount(tokenId) returns (address t) {
            return t == f.tba;
        } catch {
            return false;
        }
    }

    function _ownerOrZero(address collection, uint256 tokenId) internal view returns (address) {
        try IFriendCollectionV2(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }

    function _suspend(address collection, uint256 tokenId, Friend storage f) internal {
        f.active = false;
        _deactivate(f.holder);
        emit Suspended(f.holder, collection, tokenId, _ownerOrZero(collection, tokenId));
    }

    function _activate(address h) internal {
        ++activeFriends;
        if (activeFriendsOf[h]++ == 0) ++holders;
    }

    function _deactivate(address h) internal {
        --activeFriends;
        if (--activeFriendsOf[h] == 0) --holders;
    }

    function _key(address c, uint256 t) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, t));
    }
}
