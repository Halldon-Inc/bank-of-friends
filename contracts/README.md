# FriendBank contracts

`FriendBank.sol` is the Bank: it harvests a Friend's rewards into its holder's own account, and runs an optional maker-only desk. **It is not deployed and not audited.** Nothing in the contract restricts who may join, so the protection is simply that it will not be deployed to hold anyone's money before an external audit. That is deliberate.

| File | What it is |
| :- | :- |
| `src/FriendBank.sol` | The ledger: enrolment, harvest, per-holder accounts, withdrawals, one-call `close`, desk caps, `bankTotals`. 23.4 KB of 24.576. |
| `src/RangeDesk.sol` | The desk: single-sided Uniswap v4 range orders, the loss-lock, the loss budget. Deployed by, and callable only by, the Bank. |
| `src/PoolObserver.sol` | A truncated time-weighted price that anyone can update (`poke`). Also contains `DeskMath`. |
| `src/legacy/FriendBankV1.sol` | The replaced first version. It is kept only so the tests can prove each exploit against it. **Never deploy.** |
| `src/vendor/*` | Uniswap v4 math, MIT (see below). |

## Setup and tests

Dependencies (forge-std, OpenZeppelin) are installed, not committed:

```sh
cd contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge test
```

The fork suites (`ForkProbe`, `ForkHarvest`, `ForkDesk`) read real Robinhood Chain state on a local fork, so they need the public RPC. They broadcast nothing. If the RPC rate-limits you (HTTP 429), run them one suite at a time (filter forge test by contract name, for example ForkDesk).

Expected: **114 passed, 0 failed.** That is 103 offline tests plus 11 on the fork:

| Suite | Tests | What it covers |
| :- | -: | :- |
| `FriendBank.t.sol` | 32 | Enrolment, harvest, identity after a sale, owed/sweep, exits, keeper tip, admin limits, `bankTotals` |
| `Desk.t.sol` | 33 | Range attribution, keeper-free exit, price rules, redteam findings B, C, D, G, H, I, deploy guards, totals with open ranges |
| `Invariants.t.sol` | 6 | Claims <= book <= balance, conservation, no wrongful pull, principal untouched, everyone can exit, public counters match the records |
| `Close.t.sol` | 6 | One-call `close`: pays exactly the idle line plus the range share, stops all pulls, works halted, keeperless and after `migrateRewards`, skips Friends that are not yours |
| `EoaNeverTouched.t.sol` | 5 | The owner's own wallet (RF, WETH, ETH, even with a max allowance to the Bank) is never touched by any entry point, before or after a sale; the revoke calls |
| `WhyV1WasReplaced.t.sol` | 17 | Each v1 exploit run against v1 (succeeds) and v2 (blocked), plus three range attacks |
| `LegacyExploits.t.sol` | 4 | The V1 exploits, reproduced (a passing test means V1 is broken) |
| `ForkProbe.t.sol` | 6 | The chain facts the design rests on (6551 wallet, allowance survives a sale, permissionless claim) |
| `ForkHarvest.t.sol` | 1 | Signup, collect, sale and exit, end to end on a real Genesis |
| `ForkDesk.t.sol` | 4 | Real v4 fills: an ask pays no hook toll, a bid fills, and exit and `close` survive `migrateRewards` |

`mutate.sh` plants bugs one at a time and checks that the suite catches each. It edits `src/` while it runs and restores it on exit, so do not run it while someone may commit.

## The ledger in one paragraph

Every holder owns an exact vector: idle RF, idle WETH, units in the open ask, units in the open bid. There are no shares and no NAV. Each desk action is a linear step applied lazily to every holder. An open moves idle funds into the range pro rata. A close pays that range's measured proceeds only to the units that funded it. So a later depositor shares nothing, and a holder who exits early is not paid twice. Deposits and withdrawals never write a step, so nothing one holder does can move another's account. Every holder rounds down, so claims never exceed the book, and the book never exceeds the balance.

## Guarantees and their tests

| Guarantee | Tests |
| :- | :- |
| Only Genesis and real Generations can enrol, and the wallet must be that Friend's | `test_UnknownCollectionRejected_TheLegacyTheftPath`, `test_TemporaryFriendRejected`, `test_StrangerCannotJoinSomeoneElsesFriend` |
| It pulls only what its own claims added, up to your daily cap | `test_PullsOnlyWhatItJustClaimed`, `test_PerAssetDailyCapInItsOwnUnits`, `invariant_PrincipalInFriendWalletsUntouched` |
| A failed pull is retried, and forfeited once you use the wallet | `test_FailedPullIsOwedAndRetried`, `test_OwnerActionForfeitsOwed`, `test_OwedIsForfeitedIfTheOwnerSpendsItFirst` |
| A sold Friend is suspended; the buyer is never touched; the seller keeps what they deposited | `test_SaleSuspendsAndTheBuyerIsNeverTouched`, `test_BoughtBackStaysSuspendedUntilRejoined`, `invariant_NoWrongfulPull` |
| Withdraw RF, WETH or both, any time, halted or not, without touching the pool | `test_WithdrawWorksHaltedAndAfterRenounce`, `test_WithdrawRFAndWETHSeparately`, `test_WethStillExitsIfRfTransfersBreak`, `test_IdleWithdrawNeverTouchesThePool`, `invariant_EveryoneCanExit` |
| Your share of an open order is yours to take out, with no keeper | `test_ExitMidRangeThenCloseNeverPaysTwice`, `test_ExitAndCloseWorkWithoutKeeperOrRewardsContract`, `test_fork_ExitSurvivesMigrateRewards` |
| A range's proceeds go only to those who funded it | `test_AskProceedsGoOnlyToTheHoldersWhoFundedIt`, `test_BidProceedsGoOnlyToTheHoldersWhoFundedIt`, `test_DonationToARangeGoesToItsFunders` |
| Nobody else's actions change your account | `testFuzz_Isolation` (in both files), `test_DonationMovesNobody` |
| The desk never swaps and pays no 5% toll | `test_fork_AskFillsAsMakerWithNoHookFee` |
| No selling below cost + 5% except inside a 5%/30-day loss budget; no bidding above the last sale - 5% within 30 days of it | `test_AskBelowCostPlusLockNeedsBudget`, `test_H_CanCutALossWithinTheBudget`, `test_BidMustSitBelowLastSaleMinusLock`, `test_I_CostBasisIsSizeWeighted` |
| Ranges are bounded by a truncated TWAP, never by a spot the keeper just moved | `test_G_AskNearADepressedSpotIsRefused`, `test_G_BidNearAPumpedSpotIsRefused`, `test_PokeMovesTheRecordAtMostHalfAPercent` |
| No churn, dust or midnight-reset abuse | `test_B_ChurnCostsNothingAndIsCapped`, `test_C_DustRangesRefused`, `test_D_NoMidnightReset` |
| The owner cannot touch accounts; the keeper is timelocked and never the owner | `test_OwnerHasNoPathToHolderFunds`, `test_KeeperChangeIsDelayedAndNeverTheOwner`, `test_KeeperNeverTheOwnerAtDeploy` |
| A wrong pool key or storage slot fails at deploy | `test_DeployRefusesAWrongPoolKey`, `test_DeployRefusesAnUnreadablePool` |

## Closing an account

These are three calls. A wallet that can batch calls signs them once:

```
bank.close(collections, tokenIds, to)                 // stop collecting, exit open ranges, send all RF and WETH to `to`
TBA.execute(RF,   0, RF.approve(bank, 0),   0)       // TBA = collection.tokenBoundAccount(tokenId), sent by its owner
TBA.execute(WETH, 0, WETH.approve(bank, 0), 0)
```

The Bank cannot revoke the two approvals itself; only the Friend's owner can make its wallet call `approve`. Revoking is hygiene, not safety. After `close`, or after a sale, the Bank never claims or pulls from that Friend again (`test_AfterCloseNothingIsPulledEvenWithApprovalsLeft`, `test_AfterSellingTheFriendNothingReachesEitherWallet`). It never touches the owner's own wallet at all (`EoaNeverTouched.t.sol`).

If the pool itself is down, `close` cannot burn your share of an open range and reverts. Your idle funds still leave through `withdraw`, which never calls the pool (`test_ADeadPoolBlocksOnlyTheRangeShare`).

## What it cannot do

- **It cannot sign you up without gas.** RF has no permit, and WETH's permit cannot be signed by a Friend's wallet. Signup is two approvals from the Friend's wallet plus `join`: one confirmation with a wallet that batches calls, otherwise three.
- **It cannot guarantee profit or principal.** You leave in kind with exactly your share of what your funds did.
- **It cannot stop the one upstream owner key.** That key can redirect or retire the rewards. The Bank raises `RewardsRedirected` and `ClaimFailed`; it cannot prevent them.
- **It cannot revoke a sold Friend's approvals.** The Bank never uses them, but only the new owner can revoke them.
- **It cannot make the TWAP bound tight.** The pool's 5% toll means nobody arbitrages under ~10%, so the TWAP bounds damage per range; it does not remove it.

## Vendored code

Each file is copied unmodified except for import paths. The original SPDX header is kept. All are MIT.

| File | Source | Licence |
| :- | :- | :- |
| `src/vendor/TickMath.sol` | Uniswap/v4-core `src/libraries/TickMath.sol` @ 46c6834 | MIT |
| `src/vendor/BitMath.sol` | Uniswap/v4-core `src/libraries/BitMath.sol` @ 46c6834 | MIT |
| `src/vendor/CustomRevert.sol` | Uniswap/v4-core `src/libraries/CustomRevert.sol` @ 46c6834 | MIT |
| `src/vendor/FullMath.sol` | Uniswap/v4-core `src/libraries/FullMath.sol` @ 46c6834 | MIT |
| `src/vendor/FixedPoint96.sol` | Uniswap/v4-core `src/libraries/FixedPoint96.sol` @ 46c6834 | MIT |
| `src/vendor/SafeCast.sol` | Uniswap/v4-core `src/libraries/SafeCast.sol` @ 46c6834 | MIT |
| `src/vendor/SqrtPriceMath.sol` | Uniswap/v4-core `src/libraries/SqrtPriceMath.sol` @ 46c6834 (tests only) | MIT |
| `src/vendor/UnsafeMath.sol` | Uniswap/v4-core `src/libraries/UnsafeMath.sol` @ 46c6834 (tests only) | MIT |
| `src/vendor/LiquidityAmounts.sol` | Uniswap/v4-periphery `src/libraries/LiquidityAmounts.sol` @ 9969eec (imports repointed to `./`) | MIT |

No BUSL-1.1 or GPL file is included. The PoolManager and hook interfaces the desk calls are declared locally in `RangeDesk.sol`.
