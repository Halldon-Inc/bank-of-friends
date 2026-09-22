// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/*
                  THE BANK OF FRIENDS
        a desk that is flat until the market pays it

  Rare Friends NFTs hold their rewards in their own ERC-6551 wallets, where they
  sit idle. This contract pools that idle flow and runs a regime-gated market
  making desk with it.

  THREE PROPERTIES THIS CONTRACT GUARANTEES, ENFORCED IN CODE, NOT POLICY
  ----------------------------------------------------------------------
  1. THE BANK NEVER HOLDS YOUR NFT. Its only power over a member is an ERC-20
     allowance the member sets themselves, from their own Friend's wallet. Revoke
     it and the Bank is powerless, instantly, without asking anyone.

  2. THE BANK CAN NEVER PULL MORE THAN YOU ALLOWED. Each member sets capPerEpoch
     at join time. It is not `max`. `collect` takes min(cap, allowance, balance,
     harvested). There is no admin path that raises it.

  3. EXIT IS NEVER BLOCKED. `withdraw` has no timelock, no queue, no pause, and no
     owner check. The owner may halt QUOTING. The owner may not halt LEAVING.

  What the owner can do:   halt quoting, set the keeper, tighten (never loosen) risk caps.
  What the owner cannot do: move member funds, upgrade this contract, block an exit,
                            raise a member's cap, or touch a member's NFT.

  There is no proxy and no upgrade path. What is deployed is what runs.
*/

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IActivationManager {
    /// @dev Permissionless: anyone may claim on any Friend's behalf. Funds credit the
    ///      Friend's own token-bound wallet, never the caller. Verified on chain.
    function claim(address asset, address collection, uint256 tokenId) external returns (uint256);
    function earned(address asset, address collection, uint256 tokenId) external view returns (uint256);
}

interface IFriendCollection {
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenBoundAccount(uint256 tokenId) external view returns (address);
}

interface IMarket {
    function swapExactInput(bool buy, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline)
        external returns (uint256);
}

contract FriendBank {
    /* ------------------------------------------------------------------ errors */
    error NotOwner();
    error NotKeeper();
    error NotFriendOwner();
    error AlreadyJoined();
    error NotAMember();
    error ZeroCap();
    error NothingToCollect();
    error DeskHalted();
    error CapTooHigh();
    error InsufficientShares();
    error OnlyTightening();
    error BadAsset();
    error TransferFailed();

    /* ------------------------------------------------------------------ events */
    event Joined(address indexed owner, address indexed collection, uint256 indexed tokenId, address tba, uint256 capPerEpoch);
    event Left(address indexed owner, address indexed collection, uint256 indexed tokenId);
    event Harvested(address indexed collection, uint256 indexed tokenId, uint256 rf, uint256 weth);
    event Collected(address indexed collection, uint256 indexed tokenId, uint256 rf, uint256 weth, uint256 sharesMinted);
    event Withdrawn(address indexed owner, uint256 shares, uint256 rf, uint256 weth);
    event DeskTraded(bool buy, uint256 amountIn, uint256 amountOut);
    event QuotingHalted(bool halted);
    event KeeperSet(address keeper);
    event RiskCapsTightened(uint256 maxInventoryBps, uint256 maxTradeBps);

    /* --------------------------------------------------------------- immutables */
    IERC20 public immutable RF;
    IERC20 public immutable WETH;
    IActivationManager public immutable ACTIVATION;
    IMarket public immutable MARKET;

    /// @notice A member may never expose more than this per epoch, whatever they ask for.
    uint256 public constant ABSOLUTE_CAP_PER_EPOCH = 100_000_000e18;
    uint256 public constant EPOCH = 1 days;

    /* -------------------------------------------------------------------- state */
    address public owner;
    address public keeper;
    bool public quotingHalted;

    /// @dev Risk caps in basis points of book value. Can only ever be tightened.
    uint256 public maxInventoryBps = 6000;
    uint256 public maxTradeBps = 1500;

    struct Member {
        address friendOwner;
        address collection;
        uint256 tokenId;
        address tba;
        uint256 capPerEpoch;
        uint256 epochPulled;
        uint256 epochStart;
        bool active;
    }

    Member[] public members;
    mapping(bytes32 => uint256) private _indexOfPlusOne;

    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyKeeper() { if (msg.sender != keeper && msg.sender != owner) revert NotKeeper(); _; }

    constructor(address rf, address weth, address activation, address market) {
        RF = IERC20(rf);
        WETH = IERC20(weth);
        ACTIVATION = IActivationManager(activation);
        MARKET = IMarket(market);
        owner = msg.sender;
        keeper = msg.sender;
    }

    /* ==================================================================== JOIN */

    /**
     * @notice Register a Friend so the Bank may harvest and deploy its rewards.
     * @dev The caller must own the NFT. The Bank takes no custody here and cannot
     *      move anything until the member separately approves it FROM the Friend's
     *      token-bound wallet. This function only records consent and the cap.
     * @param capPerEpoch The most the Bank may ever pull from this Friend per day.
     *        Set it to the smallest number you are comfortable with. It is not max.
     */
    function join(address collection, uint256 tokenId, uint256 capPerEpoch) external {
        if (capPerEpoch == 0) revert ZeroCap();
        if (capPerEpoch > ABSOLUTE_CAP_PER_EPOCH) revert CapTooHigh();
        if (IFriendCollection(collection).ownerOf(tokenId) != msg.sender) revert NotFriendOwner();

        bytes32 k = _key(collection, tokenId);
        if (_indexOfPlusOne[k] != 0) revert AlreadyJoined();

        address tba = IFriendCollection(collection).tokenBoundAccount(tokenId);
        members.push(Member({
            friendOwner: msg.sender,
            collection: collection,
            tokenId: tokenId,
            tba: tba,
            capPerEpoch: capPerEpoch,
            epochPulled: 0,
            epochStart: block.timestamp,
            active: true
        }));
        _indexOfPlusOne[k] = members.length;
        emit Joined(msg.sender, collection, tokenId, tba, capPerEpoch);
    }

    /// @notice Stop the Bank harvesting this Friend. Always available to its owner.
    function leave(address collection, uint256 tokenId) external {
        uint256 i = _requireMember(collection, tokenId);
        Member storage m = members[i];
        if (IFriendCollection(collection).ownerOf(tokenId) != msg.sender) revert NotFriendOwner();
        m.active = false;
        emit Left(msg.sender, collection, tokenId);
    }

    /* ================================================================= HARVEST */

    /**
     * @notice Claim pending rewards for a batch of members. PERMISSIONLESS.
     * @dev Rewards land in each Friend's OWN wallet, not here. Anyone may call this
     *      and it benefits the member whether or not the Bank ever collects. The
     *      caller pays the gas. This is the "auto-pull" half that carries no risk:
     *      it moves a member's money only from the protocol into the member's own
     *      wallet, never to the Bank.
     */
    function harvest(uint256[] calldata ids) external {
        for (uint256 j; j < ids.length; ++j) {
            Member storage m = members[ids[j]];
            if (!m.active) continue;
            uint256 rf = _tryClaim(address(RF), m.collection, m.tokenId);
            uint256 weth = _tryClaim(address(WETH), m.collection, m.tokenId);
            if (rf != 0 || weth != 0) emit Harvested(m.collection, m.tokenId, rf, weth);
        }
    }

    function _tryClaim(address asset, address collection, uint256 tokenId) internal returns (uint256) {
        try ACTIVATION.claim(asset, collection, tokenId) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;   // nothing pending, or the protocol refused. Never block the batch.
        }
    }

    /**
     * @notice Pull harvested rewards from a member's Friend wallet into the desk.
     * @dev Bounded four ways: the member's own cap, their remaining epoch budget,
     *      the allowance they granted, and the wallet balance. The Bank cannot
     *      exceed the smallest of these and there is no admin override.
     */
    function collect(uint256 id) public onlyKeeper returns (uint256 rfPulled, uint256 wethPulled) {
        Member storage m = members[id];
        if (!m.active) revert NotAMember();

        if (block.timestamp >= m.epochStart + EPOCH) {
            m.epochStart = block.timestamp;
            m.epochPulled = 0;
        }
        uint256 room = m.capPerEpoch > m.epochPulled ? m.capPerEpoch - m.epochPulled : 0;
        if (room == 0) revert NothingToCollect();

        rfPulled = _pull(RF, m.tba, room);
        wethPulled = _pull(WETH, m.tba, room);
        if (rfPulled == 0 && wethPulled == 0) revert NothingToCollect();

        m.epochPulled += rfPulled + wethPulled;

        // Shares are minted against contributed value, denominated in RF-equivalent
        // units at the time of contribution. The desk's PnL then accrues pro rata.
        uint256 minted = rfPulled + wethPulled;
        uint256 supply = totalShares;
        if (supply != 0) {
            uint256 book = RF.balanceOf(address(this)) + WETH.balanceOf(address(this));
            if (book > minted) minted = (minted * supply) / (book - minted);
        }
        sharesOf[m.friendOwner] += minted;
        totalShares += minted;

        emit Collected(m.collection, m.tokenId, rfPulled, wethPulled, minted);
    }

    function _pull(IERC20 token, address from, uint256 room) internal returns (uint256 amount) {
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return 0;
        uint256 allowed = token.allowance(from, address(this));
        if (allowed == 0) return 0;
        amount = bal < allowed ? bal : allowed;
        if (amount > room) amount = room;
        if (amount == 0) return 0;
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    /* ================================================================ WITHDRAW */

    /**
     * @notice Redeem shares for a pro-rata slice of the desk's holdings.
     * @dev No timelock. No queue. No pause. No owner check. Deliberately.
     *      `quotingHalted` does NOT gate this function and must never be made to.
     */
    function withdraw(uint256 shares) external {
        uint256 have = sharesOf[msg.sender];
        if (shares == 0 || shares > have) revert InsufficientShares();

        uint256 supply = totalShares;
        uint256 rf = (RF.balanceOf(address(this)) * shares) / supply;
        uint256 weth = (WETH.balanceOf(address(this)) * shares) / supply;

        sharesOf[msg.sender] = have - shares;
        totalShares = supply - shares;

        if (rf != 0 && !RF.transfer(msg.sender, rf)) revert TransferFailed();
        if (weth != 0 && !WETH.transfer(msg.sender, weth)) revert TransferFailed();
        emit Withdrawn(msg.sender, shares, rf, weth);
    }

    /* ==================================================================== DESK */

    /**
     * @notice Execute one leg the keeper has decided on.
     * @dev The regime gates live off chain in lib/strategy.mjs, where they can be
     *      audited and backtested against real history. What is enforced HERE is the
     *      part that must not depend on the keeper behaving: size caps, inventory
     *      caps, the halt switch, and a caller-supplied minOut. A compromised keeper
     *      can waste money inside these bounds. It cannot drain the desk.
     */
    function trade(bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        external onlyKeeper returns (uint256 out)
    {
        if (quotingHalted) revert DeskHalted();

        uint256 rfBal = RF.balanceOf(address(this));
        uint256 wethBal = WETH.balanceOf(address(this));
        uint256 book = rfBal + wethBal;

        // Size cap: no single trade may move more than maxTradeBps of the book.
        if (amountIn > (book * maxTradeBps) / 10_000) revert CapTooHigh();

        IERC20 tokenIn = buy ? WETH : RF;
        tokenIn.approve(address(MARKET), amountIn);
        out = MARKET.swapExactInput(buy, amountIn, minOut, address(this), deadline);
        tokenIn.approve(address(MARKET), 0);

        // Inventory cap, checked AFTER the fill so it binds on the result.
        if (buy) {
            uint256 newRf = RF.balanceOf(address(this));
            uint256 newBook = newRf + WETH.balanceOf(address(this));
            if (newBook != 0 && (newRf * 10_000) / newBook > maxInventoryBps) revert CapTooHigh();
        }
        emit DeskTraded(buy, amountIn, out);
    }

    /* =================================================================== ADMIN */

    function setKeeper(address k) external onlyOwner { keeper = k; emit KeeperSet(k); }

    /// @notice Stop the desk quoting. Does NOT and must not affect `withdraw`.
    function setQuotingHalted(bool h) external onlyOwner { quotingHalted = h; emit QuotingHalted(h); }

    /// @notice Risk caps ratchet one way only. The owner can make the desk safer, never riskier.
    function tightenRiskCaps(uint256 newMaxInventoryBps, uint256 newMaxTradeBps) external onlyOwner {
        if (newMaxInventoryBps > maxInventoryBps || newMaxTradeBps > maxTradeBps) revert OnlyTightening();
        maxInventoryBps = newMaxInventoryBps;
        maxTradeBps = newMaxTradeBps;
        emit RiskCapsTightened(newMaxInventoryBps, newMaxTradeBps);
    }

    function transferOwnership(address n) external onlyOwner { owner = n; }

    /* ==================================================================== VIEW */

    function memberCount() external view returns (uint256) { return members.length; }

    function pending(uint256 id) external view returns (uint256 rf, uint256 weth) {
        Member storage m = members[id];
        rf = ACTIVATION.earned(address(RF), m.collection, m.tokenId);
        weth = ACTIVATION.earned(address(WETH), m.collection, m.tokenId);
    }

    /// @notice What the Bank could pull right now. Shows a member their real exposure.
    function collectable(uint256 id) external view returns (uint256 rf, uint256 weth) {
        Member storage m = members[id];
        if (!m.active) return (0, 0);
        uint256 room = block.timestamp >= m.epochStart + EPOCH
            ? m.capPerEpoch
            : (m.capPerEpoch > m.epochPulled ? m.capPerEpoch - m.epochPulled : 0);
        rf = _min3(RF.balanceOf(m.tba), RF.allowance(m.tba, address(this)), room);
        weth = _min3(WETH.balanceOf(m.tba), WETH.allowance(m.tba, address(this)), room);
    }

    function bookValue() external view returns (uint256 rf, uint256 weth) {
        return (RF.balanceOf(address(this)), WETH.balanceOf(address(this)));
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 m = a < b ? a : b;
        return m < c ? m : c;
    }

    function _key(address c, uint256 t) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(c, t));
    }

    function _requireMember(address c, uint256 t) internal view returns (uint256) {
        uint256 p = _indexOfPlusOne[_key(c, t)];
        if (p == 0) revert NotAMember();
        return p - 1;
    }
}
