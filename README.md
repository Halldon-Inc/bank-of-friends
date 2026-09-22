# The First Bank of Friends

**Sign up once, and the bank is built to harvest your Rare Friend's RF and WETH rewards into
your own safe deposit box for good.** The bank's desk only ever rests maker orders in the $RAREFRIENDS pool,
so it never pays the 5% toll, and it never touches anyone else's money.

- **Play:** <https://bank-of-friends-nu.vercel.app> (no wallet, no install). Walk into the hall:
  the Desk opens an account, the Trading Floor shows the desk's live decision, the Vault is a
  wall of safe deposit boxes.
- **Research and the live desk:** <https://bank-of-friends-nu.vercel.app/docs>
- **Vibeathon entry:** [SUBMISSION.md](SUBMISSION.md), category Economy Potential.

## What it does

1. **Signup:** from the Friend's own ERC-6551 wallet, approve RF, approve WETH, `join` with a
   daily cap per asset. The NFT never leaves the wallet.
2. **Harvest:** `collect` claims the Friend's rewards (the claim always pays the Friend's own
   wallet) and moves only what that claim delivered into the holder's box. The owner is
   re-checked every time; the first collect after a sale suspends the account and pulls
   nothing from the buyer.
3. **Accounts in kind:** every holder owns exact RF and exact WETH, plus units in any open
   desk order they funded. No shares, no NAV, no price in the accounting.
4. **Maker-only desk:** off until an objective rule arms it; single-sided Uniswap v4 range
   orders, loss-locked on chain, bounded by a time-weighted price, never a swap.
5. **Exit:** withdraw RF, WETH or both at any time, with no owner check, even with the desk
   halted and the protocol's rewards switched off.
6. **Keeper:** `npm run keeper` plans the weekly `allocate()` so rewards keep streaming for
   every activated Friend, claims when it is worth 20x the gas, and alarms if the 5% fee is re-pointed.
   It is a dry run unless given a key and `--execute`; nothing is running today.

**Not deployed, not audited.** Nothing here moves funds, and we will not deploy it to hold
anyone's money before an external audit.

## Repository

```
app/         the product: the hall at /, the research and live desk at /docs
contracts/   FriendBank (ledger), RangeDesk (maker desk), PoolObserver (TWAP). NOT DEPLOYED
             src/legacy/FriendBankV1.sol is the replaced first version, kept so the tests
             can prove each exploit against it
lib/         protocol reader and the strategy module, shared by everything
scripts/     verification, keeper, backtests, parameter derivation, UI harnesses
docs/        economics, backtests, strategy results
game/        the abandoned FriendSDK build, frozen for reference (it cannot admit a Genesis)
```

`lib/strategy.mjs` is the single strategy; `app/lib/` holds byte-identical copies so the app
deploys standalone. `npm run check:lib-sync` fails if they drift **and** if any gate the
strategy evaluates is not fed by the live desk, which is how a gate that could never be
satisfied shipped once before.

## Commands

```sh
npm install

npm run verify           # facts about the protocol, asserted against live chain state
npm run keeper -- --wallet 0xYOU    # dry run: what the keeper would allocate and claim
npm run derive           # every parameter, labelled MEASURED / DERIVED / CHOICE
npm run history          # pull every swap in the pool's history
npm run backtest:gated   # the desk against the whole tape, gated and ungated
npm run sweep            # the desk across 60 market regimes
npm run check:lever      # how often the arming rule arms, per regime

cd contracts && forge test          # see contracts/README.md

npm run sweep:hall <url>  # the hall at 12 screen sizes: fill, overlap, signs on their artwork
npm run play:hall  <url>  # walk in, open an account, read the floor, open the vault
node scripts/visual-check.mjs <url>   # /docs at seven widths
```

Before a deploy, refresh the price seed: `node scripts/fetch-history.mjs && node
scripts/backtest-gated.mjs --export-hourly`. The deployed site extends that series itself from
the chain, so it stays fully measured without a redeploy.

## Checks

| check | result |
| --- | --- |
| `forge test` (contracts/) | **114/114**: 103 offline (incl. 17 in `WhyV1WasReplaced.t.sol`, 5 proving the owner's own wallet is never touched, and fuzzed invariants) plus 11 on a fork of live Robinhood Chain state, nothing broadcast |
| `contracts/mutate.sh` | **16/16** planted bugs caught (no ownership re-check, sweeping the whole wallet, rounding up, withdraw gated by halt, TWAP guard off, and eleven more) |
| `npm run verify` | **63/63** facts asserted against live chain state, none skipped |
| `npm run keeper -- --wallet huntclubhero.eth` | dry run: no alarm; claims planned for the one Friend worth claiming, the rest below 20x gas |
| `npm run backtest:gated` | real tape: desk stays off, +0.00% vs hold; ungated it would have lost 10.11% |
| `npm run sweep` | 60 regimes: gated worst -6.76% vs ungated worst -42.98% |
| `npm run sweep:hall <url>` | **168/168** across twelve sizes, 320px to 3440px: fill, overlap, signs on their artwork, plaque inside its plate |
| `npm run play:hall <url>` | **95/95**: open an account, read the live floor, simulate a week, open the vault, take out and close, in all three room shapes |
| `node scripts/visual-check.mjs <url>` | **70/70** on /docs across seven widths |
| `npm run check:lib-sync` | copies identical, and every strategy gate is fed by the live desk |
| `npx tsc --noEmit`, `next build` | clean |

## Status and honesty

- The desk **has never traded**. On the real tape it would have stayed off for the pool's
  whole life, and the same ladder without its arming rule would have lost 10.11% of the book.
- The bank's income depends on one externally owned key that owns every Rare Friends contract.
  The keeper alarms if the 5% fee is re-pointed or the rewards contract is retired; the bank
  cannot prevent either.
- The pool is a week old, one token, one downtrend. Nothing here is a forecast.

## Two SDK limitations we could not work around

- **Genesis holders cannot play any FriendSDK game.** `readGenerationEligibility` reads the
  **Generations** contract and requires generation 1 or higher, so a Genesis is excluded, and
  the Genesis carries 95% of all Friend weight. That is why the hall uses the SDK as a library
  rather than a runtime.
- **The SDK's Friend picker shows no artwork.** Ours shows every Friend's on-chain art.

## Licence

MIT, see [LICENSE](LICENSE). Vendored Uniswap v4 math under `contracts/src/vendor/` is MIT
and listed in `contracts/README.md`. FriendSDK is Apache-2.0 and used as a library. No fonts
or images are bundled; Friend artwork is read from chain and rendered unmodified.
