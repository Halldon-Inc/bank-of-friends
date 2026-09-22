# FriendBank contracts

`FriendBank.sol` is the vault and desk. **It is not deployed.** The tests assert the
three safety properties rather than the happy path.

## Setup

Dependencies are installed, not vendored:

```sh
cd contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge build
forge test
```

Expected: **18 passed, 0 failed.**

## What the tests prove

| Guarantee | Test |
| --- | --- |
| The Bank never holds your NFT | `test_BankNeverTakesTheNFT`, `test_JoinRequiresActualOwnership` |
| It can never pull more than your cap | `test_CollectIsBoundedByTheMemberCap` (passes even when the member grants an **unlimited** allowance), `test_CapRefillsOnlyOncePerEpoch` |
| Revoking makes it powerless | `test_RevokingAllowanceMakesTheBankPowerless`, `test_LeavingStopsCollection` |
| Exit is never blocked | `test_WithdrawWorksEvenWhenTheDeskIsHalted` |
| The owner cannot take funds or loosen risk | `test_OwnerCannotMoveMemberFunds`, `test_OwnerCannotRaiseAMemberCap` |
| Harvest is permissionless and credits the Friend | `test_HarvestIsPermissionlessAndCreditsTheFriendNotTheBank` |
| The desk respects its caps | `test_TradeRespectsTheSizeCap`, `test_TradeRespectsTheInventoryCap`, `test_TradeBlockedWhenHalted`, `test_NonKeeperCannotTrade` |

## Status

Unaudited and undeployed. Deposits from anyone other than the builder are closed
until an external audit. That is deliberate, not an oversight.
