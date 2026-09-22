/**
 * ACCOUNTS: who has opened one, on what terms, and what is in their box.
 *
 * Joining the bank and the bank deciding to trade are TWO DIFFERENT THINGS, and
 * collapsing them was the worst bug in this build. The desk's only action used to
 * be the lever, so a Genesis holder walked up, got "SAT OUT" because the market is
 * quiet, and reasonably read it as the bank refusing to let him in. Nothing about
 * opening an account depends on whether anyone is trading.
 *
 * THE BOX IS IN KIND. Each Friend gets its own safe deposit box holding the exact
 * RF and the exact WETH the keeper moved in for it. There are no shares and no
 * pooled unit of account: adding RF and WETH into one number is how a share price
 * ends up treating a wei of WETH like a wei of RF. The pooled book is only ever the
 * SUM of the boxes, per asset.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 *
 * Every line of copy below is taken word for word from the contract's own
 * guarantees (FriendBankV2 + RangeDesk), with the Foundry test that proves each
 * one. Signing up is three calls from the Friend's own ERC-6551 wallet: approve
 * RF, approve WETH, then join with a daily cap per asset. There is NO off-chain
 * consent signature: the join IS the consent. One confirmation if the wallet can
 * batch calls, otherwise three; nothing is gasless. Here all three are SIMULATED,
 * because the contract is not deployed and is unaudited. Accounts, boxes and caps
 * are kept in this browser.
 */

export const STORAGE_KEY = "fbof.accounts.v1";

export type Account = {
  id: string;
  label: string;
  collection: string;
  tokenId: string;
  imageUrl: string | null;
  /** The Friend's claimable rewards when the account opened, read from chain. */
  idleRf: number;
  idleWeth: number;
  /** Per-asset daily caps. Each asset is capped on its own, never summed. */
  capPerDayRf: number;
  capPerDayWeth: number;
  /** What the keeper moved into this Friend's box, in kind. */
  boxRf: number;
  boxWeth: number;
  /** The desk's result attributed to this box, in kind, plus or minus. Zero until it trades. */
  pnlRf: number;
  pnlWeth: number;
  /**
   * ON ITS WAY: the idle rewards the day-one cap left behind. The contract moves at
   * most the daily cap per asset, so the rest arrives over the following days. Kept
   * as its own number (not idle minus box) so a withdrawal never inflates it.
   */
  owedRf: number;
  owedWeth: number;
  /** The optional switch: also move anything above what the wallet held at join. */
  sweep: boolean;
  openedAt: string;
};

export const accountId = (collection: string, tokenId: string) => `${collection}-${tokenId}`;

/** The three things signing up actually is, in order. Verbatim from the contract. */
export const SIGNUP_STEPS = [
  { what: "Approve the Bank for RF, from your Friend's wallet", call: "TBA.execute(RF.approve(bank, amount))" },
  { what: "Approve the Bank for WETH, from your Friend's wallet", call: "TBA.execute(WETH.approve(bank, amount))" },
  { what: "Open the account: join, with a daily cap per asset", call: "bank.join(collection, id, capRf, capWeth, sweep)" },
] as const;

type Line = { text: string; tests: readonly string[] };

/** What the member authorises. Each line names the test that proves it. */
export const GRANTS: readonly Line[] = [
  { text: "Claim this Friend's rewards into its own wallet and move what was claimed into your account, up to your daily cap per asset.",
    tests: ["test_PullsOnlyWhatItJustClaimed", "test_PerAssetDailyCapInItsOwnUnits"] },
  { text: "Retry a move that failed, until you next use your Friend's wallet.",
    tests: ["test_FailedPullIsOwedAndRetried", "test_OwnerActionForfeitsOwed"] },
  { text: "If the desk is on, rest maker orders with your account's RF or WETH, at prices the keeper chooses inside the contract's limits (about a 10% band around a time-weighted price), shared pro rata with everyone else whose money is in that order.",
    tests: ["test_AskProceedsGoOnlyToTheHoldersWhoFundedIt", "test_BidProceedsGoOnlyToTheHoldersWhoFundedIt"] },
];

/** The optional switch, off by default. */
export const SWEEP_GRANT: Line = {
  text: "Also move anything above what the wallet holds today.",
  tests: ["test_SweepModeCatchesRewardsSomeoneElseClaimed"],
};

/**
 * "The bank cannot..." Each line names its tests. The maker-only line was held
 * back until its fork tests had actually run against the live pool; they have.
 */
export const GUARANTEES: readonly Line[] = [
  { text: "touch your own wallet: not your ETH, not your tokens, not your NFTs, even if you approved it.",
    tests: ["test_EveryEntryPointLeavesTheOwnersWalletAlone", "testFuzz_OwnersWalletNeverDecreases", "test_TheBankAndDeskRefuseEth"] },
  { text: "hold your NFT.", tests: ["test_SignupEntirelyThroughTheFriendWallet", "test_StrangerCannotJoinSomeoneElsesFriend"] },
  { text: "take anything your Friend's wallet held when you joined, or anything you add later unless you switch on 'also move extras'.", tests: ["test_PullsOnlyWhatItJustClaimed", "invariant_PrincipalInFriendWalletsUntouched"] },
  { text: "move more than your daily cap.", tests: ["test_PerAssetDailyCapInItsOwnUnits"] },
  { text: "touch your Friend's wallet after you sell it. What you deposited stays yours.",
    tests: ["test_SaleSuspendsAndTheBuyerIsNeverTouched", "test_BoughtBackStaysSuspendedUntilRejoined", "invariant_NoWrongfulPull"] },
  { text: "stop you withdrawing RF, WETH or both, any amount, at any time, even while the desk is halted.",
    tests: ["test_WithdrawWorksHaltedAndAfterRenounce", "test_WithdrawRFAndWETHSeparately", "test_WethStillExitsIfRfTransfersBreak", "test_IdleWithdrawNeverTouchesThePool", "invariant_EveryoneCanExit"] },
  { text: "keep your share of an open order: take it out yourself, any time, no keeper needed.",
    tests: ["test_ExitMidRangeThenCloseNeverPaysTwice", "test_ExitAndCloseWorkWithoutKeeperOrRewardsContract", "test_WithdrawAllIncludesAnOpenRange"] },
  { text: "let anyone else's deposits, withdrawals or sales change your account.", tests: ["testFuzz_Isolation", "test_DonationMovesNobody"] },
  { text: "sell RF below what it paid plus 5%, except inside a loss budget of 5% of the book per 30 days, or, within 30 days of a sale, buy back above that sale's price minus 5%.",
    tests: ["test_AskBelowCostPlusLockNeedsBudget", "test_H_CanCutALossWithinTheBudget", "test_BidMustSitBelowLastSaleMinusLock", "test_I_CostBasisIsSizeWeighted"] },
  { text: "swap. It only rests maker orders, which pay no 5% toll.",
    tests: ["test_fork_AskFillsAsMakerWithNoHookFee", "test_fork_BidFillsAsMaker"] },
  { text: "let its owner touch accounts. The owner can pause the desk, tighten its limits and, with two days' notice, change the keeper; it can never be the keeper.",
    tests: ["test_OwnerHasNoPathToHolderFunds", "test_KeeperChangeIsDelayedAndNeverTheOwner", "test_KeeperNeverTheOwnerAtDeploy"] },
];

/**
 * CLOSE ACCOUNT AND TAKE EVERYTHING HOME: one action. `close` stops collecting,
 * takes your share out of any open order and sends all your RF and WETH to you;
 * the two revokes ride along in the same step, because the bank cannot revoke an
 * approval for you. Verbatim from the contract.
 */
export const CLOSE_CALLS = [
  "bank.close([collection], [id], you)",
  "TBA.execute(RF.approve(bank, 0))",
  "TBA.execute(WETH.approve(bank, 0))",
] as const;

export const CLOSE_SUMMARY =
  "Stop collecting, take your share out of any open order, send all your RF and WETH to you, and revoke both approvals from your Friend's wallet.";

export const CLOSE_TESTS = [
  "test_ClosePaysExactlyTheLinePlusTheRangeShare",
  "test_AfterCloseNothingIsPulledEvenWithApprovalsLeft",
] as const;

/** What signing up can and cannot reach. */
export const WALLET_SCOPE =
  "Your own wallet approves nothing. The bank can only ever reach the RF and WETH inside your Friend's wallet, never your ETH or anything else in your personal wallet.";

/* -------------------------------------------------------------------- store */

/**
 * Accounts opened before boxes existed carried one RF cap and no box. Read them
 * forward rather than dropping them: their box is what the keeper would have moved
 * in, which is the idle balance they were opened with.
 */
function normalise(a: Partial<Account> & { id: string }): Account {
  const idleRf = Number(a.idleRf ?? 0), idleWeth = Number(a.idleWeth ?? 0);
  return {
    label: a.id, collection: "", tokenId: "", imageUrl: null, sweep: false,
    ...a,
    openedAt: String((a as { openedAt?: string; signedAt?: string }).openedAt ?? (a as { signedAt?: string }).signedAt ?? new Date(0).toISOString()),
    idleRf, idleWeth,
    capPerDayRf: Number(a.capPerDayRf ?? 0),
    capPerDayWeth: Number(a.capPerDayWeth ?? 0),
    boxRf: Number(a.boxRf ?? idleRf),
    boxWeth: Number(a.boxWeth ?? idleWeth),
    pnlRf: Number(a.pnlRf ?? 0),
    pnlWeth: Number(a.pnlWeth ?? 0),
    owedRf: Number(a.owedRf ?? 0),
    owedWeth: Number(a.owedWeth ?? 0),
  } as Account;
}

export function loadAccounts(): Account[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as Account[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === "string").map(normalise) : [];
  } catch {
    return [];
  }
}

function save(list: Account[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

export function addAccount(a: Account): Account[] {
  const next = [...loadAccounts().filter((x) => x.id !== a.id), a];
  save(next);
  return next;
}

export function removeAccount(id: string): Account[] {
  const next = loadAccounts().filter((x) => x.id !== id);
  save(next);
  return next;
}

/**
 * Withdraw ONE asset from a box. The other asset stays exactly where it is, which
 * is the property the contract gives withdraw: each asset leaves on its own.
 */
export function withdrawAsset(id: string, asset: "rf" | "weth"): Account[] {
  const next = loadAccounts().map((a) => a.id !== id ? a
    : asset === "rf" ? { ...a, boxRf: 0, pnlRf: 0 } : { ...a, boxWeth: 0, pnlWeth: 0 });
  save(next);
  return next;
}

/** A box's holdings, per asset: what was deposited plus the desk's in-kind result. */
export const boxRf = (a: Account) => a.boxRf + a.pnlRf;
export const boxWeth = (a: Account) => a.boxWeth + a.pnlWeth;

/**
 * The pooled book is the SUM OF THE BOXES, per asset, and nothing else. The dollar
 * figure is for reading only; nothing is ever minted or redeemed against it.
 */
/**
 * What is still on its way into a box, and how long it takes at the member's own
 * caps: ceil(remaining / cap) per asset, and the larger of the two, because the
 * two assets arrive in parallel and the slower one sets the date.
 */
export function onItsWay(a: Account, rfUsd: number, ethUsd: number) {
  const days = (left: number, cap: number) => (left > 0 && cap > 0 ? Math.ceil(left / cap) : 0);
  return {
    rf: a.owedRf, weth: a.owedWeth,
    usd: a.owedRf * rfUsd + a.owedWeth * ethUsd,
    days: Math.max(days(a.owedRf, a.capPerDayRf), days(a.owedWeth, a.capPerDayWeth)),
  };
}

export function totals(list: Account[], rfUsd: number, ethUsd: number) {
  const rf = list.reduce((a, x) => a + boxRf(x), 0);
  const weth = list.reduce((a, x) => a + boxWeth(x), 0);
  const pnlRf = list.reduce((a, x) => a + x.pnlRf, 0);
  const pnlWeth = list.reduce((a, x) => a + x.pnlWeth, 0);
  const usdOf = (x: Account) => boxRf(x) * rfUsd + boxWeth(x) * ethUsd;
  const usd = list.reduce((a, x) => a + usdOf(x), 0);
  return {
    depositors: list.length,
    rf, weth, pnlRf, pnlWeth, usd,
    owedRf: list.reduce((a, x) => a + x.owedRf, 0),
    owedWeth: list.reduce((a, x) => a + x.owedWeth, 0),
    owedUsd: list.reduce((a, x) => a + x.owedRf * rfUsd + x.owedWeth * ethUsd, 0),
    rfSideUsd: rf * rfUsd,
    wethSideUsd: weth * ethUsd,
    /** Each box's slice of the book, for drawing the pooled bar as its segments. */
    slices: list.map((x) => ({ id: x.id, label: x.label, usd: usdOf(x), share: usd > 0 ? usdOf(x) / usd : 0 })),
  };
}
