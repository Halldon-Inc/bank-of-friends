**Play it: <https://bank-of-friends-nu.vercel.app>** with no wallet, no signature and no install.
You land inside the hall with a Friend already on the marble.

| The hall | The Trading Floor |
| --- | --- |
| ![The hall: the facade, the marquee and the pooled plaque](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/hall.png) | ![The Trading Floor: the desk's live decision](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/floor.png) |
| **The Desk: three calls, every guarantee with its test** | **The Vault: a wall of safe deposit boxes** |
| ![The Desk](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/desk.png) | ![The Vault](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/vault.png) |

**Project name**

The First Bank of Friends

**Builder / contact**

Hunt &middot; GitHub [@huntclubhero](https://github.com/huntclubhero) &middot; wallet `huntclubhero.eth`

**Category**

Economy Potential

**One sentence**

A bank built so that one signup harvests your Friend's RF and WETH rewards into your own safe
deposit box for good, while its desk rests the outside liquidity the $RAREFRIENDS pool has never
had, without ever paying the 5% toll itself and without ever touching anyone else's money.

**Source code**

<https://github.com/Halldon-Inc/bank-of-friends> &middot; Next.js 16, viem, Solidity 0.8.30 +
Foundry. **FriendSDK v0.1.2 is used as a library, not a runtime** (see Credits).

**Playable demo**

<https://bank-of-friends-nu.vercel.app> &middot; the live desk and the research are at
<https://bank-of-friends-nu.vercel.app/docs>.

---

## What it is built to do

A Rare Friend earns RF and WETH every week, and most of it sits unclaimed in the protocol; a
claim always pays it into the Friend's own wallet. The First Bank of Friends is built to put that money to work without ever taking the
NFT. **None of it is deployed or running yet**; everything below is what the contract and the
keeper do in tests, and what the demo simulates.

1. **Sign up once.** From your Friend's own wallet: approve RF, approve WETH, and `join` with a
   daily cap per asset. One confirmation with a wallet that batches calls, otherwise three. The
   NFT never leaves your wallet, and there is nothing more to sign until you leave.
2. **The bank harvests for you.** A keeper would claim your Friend's rewards when they are worth at
   least 20x the gas, and move only what that claim just delivered into **your own box**. Money
   you keep in the Friend's wallet is never touched.
3. **Your box is yours, exactly.** Every depositor owns an exact amount of RF and an exact
   amount of WETH. There are no shares and no price in the accounting, so another member joining,
   leaving, selling or getting a better fill cannot move your balance by a single wei.
4. **The desk only ever makes, never takes.** When it trades it posts single-sided range orders
   in the RF pool. The pool's hook charges no fee on liquidity, so **the bank never pays the
   5% toll**; the trader who crosses its order does, and that 5% goes to every activated Friend.
   The desk stays off until the market proves it can pay (see "The desk" below). It is off
   today, and it says why.
5. **The bank keeps everyone's stream flowing.** Rewards reach Friends only after someone calls
   `ActivationManager.allocate()` each week. It has been called once since launch. The keeper is
   built to call it when it is due, for every activated Friend, member or not.
6. **Leave whenever you like.** Withdraw RF, WETH or both, at any time, with no owner check, no
   queue and no pause, including while the desk is halted and even if the protocol's rewards
   contract is switched off. If you sell your Friend, the next collect sees the sale, suspends
   the account and pulls nothing from the buyer, and everything collected while you owned it
   stays yours. **Closing is one action**: "Close account and take everything home" withdraws
   your deposit and your share of desk gains and revokes the bank's access to your Friend's
   wallet in the same step (one signature with a wallet that batches calls).
7. **Your own wallet is never in reach.** Your personal wallet approves nothing. The bank can
   only ever reach the RF and WETH inside your Friend's wallet, never your ETH or anything else
   you own, and a fuzzed test proves no sequence of anyone's actions costs it a wei.

## How to use the demo

Walk with WASD, the arrows, or a tap. Three stations:

- **The Desk** opens your account. You see the three signup calls, a daily cap per asset, what
  you let the bank do, and what it cannot do, each line with the Foundry test that proves it.
  The box opens with what your caps allow on day one and shows the rest as on its way.
- **The Trading Floor** shows the desk's live decision, read from the chain right now, with
  every check it runs and the one that is holding it back. A separate, clearly labelled button
  simulates a week so you can watch it arm.
- **The Vault** is a wall of safe deposit boxes, one per Friend, each showing what went in and
  what the desk made or lost, per asset. The pooled book is drawn as the sum of the boxes.

The demo is simulated end to end and stamped SIMULATED: the contract is not deployed and no
funds move.

## How it works

**Signup.** A Rare Friend's wallet is an ERC-6551 account that only the NFT's owner can use, it
cannot batch calls, RF has no permit, and WETH's permit cannot be signed by a Friend wallet. So
there is no honest one-signature signup: it is two approvals and a `join`. The Bank records the
Friend, its wallet (read from the Friend's own collection and checked against the wallet's
`token()`), and the owner at that moment.
Only Genesis and real Generations Friends can enrol; temporary Friends cannot.

**Harvest.** `ActivationManager.claim` is permissionless and always pays the Friend's own wallet,
never the caller. The Bank's `collect` claims, then moves **only what that claim just delivered**,
up to your daily cap per asset. Before every collect it re-checks who owns the Friend; if the NFT
has moved, the account is suspended and nothing is pulled from the buyer, while the seller keeps
everything collected under their ownership. A pull that fails is remembered and retried. Anyone
may call `collect`; a caller who is not the holder may take a tip of at most 1% of that Friend's
own WETH, once per 12 hours, so the keeper does not have to be us.

**Your box.** Each holder owns an exact vector: idle RF, idle WETH, and units in the desk's open
sell and buy orders. There are no shares and no NAV. Every desk action is a linear step applied
to the holders who funded it, deposits and withdrawals never write a step, and every holder rounds
down, so claims can never exceed the book and nothing another holder does can move your account.
A fuzzed invariant suite checks exactly that.

**The desk.** Off by default. It arms only when all three hold: at least six completed 5% swings in
the last 72 hours, a 72-hour trend inside 10%, and a replay of the same ladder over the last seven
days beats simply holding. When it trades, it rests one single-sided sell range above the price
(RF only) and one buy range below it (WETH only) directly in the Uniswap v4 pool. It never swaps.
On chain, every range must sit at least 1% clear of a time-weighted price that anyone can update
(never the spot price a keeper just moved), no sell may sit below the average cost of RF the desk
bought plus 5% except inside a loss budget of 5% of the book per 30 days, no buy may sit above the
last sale minus 5% within 30 days of that sale, a range is 1% to 15% of its side, the desk may change ranges at most 24 times a
rolling day, and after 7 days anyone may close a range. The owner can never be the keeper, and changing the
keeper takes two days.

**Exit.** `withdrawRF`, `withdrawWETH` or both, any time, with no owner check and no pause. Your
share of an open range can be pulled out by you alone with `exitRanges`, and after seven days
anyone can close a range. The exit path touches only the pool's liquidity, never the rewards
contract or a swap, so it keeps working even if the protocol owner switches the rewards off; a
fork test proves that against the live contracts.

**The keeper.** `npm run keeper` plans (and, only with a key and `--execute`, sends) the weekly
`allocate()`, the claims and the collects. It claims only when a Friend's rewards are worth at
least 20x the gas, suspends sold Friends first, and stops with an alarm if the 5% fee is ever
pointed anywhere but the rewards contract.

## Why you can trust it: we attacked our own bank first

Before this submission we wrote the attacks. The first version of the contract, which we had
described as safe, had **three critical bugs**, each of which would have paid one member's
money to someone else:

| attack on v1 | what happened | v2 |
| --- | --- | --- |
| RF and WETH counted as equal | 1 RF withdrew half of another member's 1 WETH | each member owns exact RF and exact WETH |
| a fake Friend collection | the keeper drained a victim's wallet into the attacker's account | only Genesis and Generations; each Friend wallet is read from its own collection and checked against its `token()` |
| selling the Friend | the seller kept collecting the buyer's rewards | the owner is re-checked at every collect; the next collect after a sale suspends the account and pulls nothing |
| a donation to the bank | the next member's deposit rounded to zero | donations change nobody's claim |
| the daily cap | spent twice, once per token | a cap per asset |
| the owner's own money | swept out of the Friend's wallet with the rewards | only what the bank's own claim delivered |
| the owner as keeper | could dump the book into its own sandwich | the owner can never be the keeper; the desk never swaps |

Every row is a test in `contracts/test/WhyV1WasReplaced.t.sol` that **succeeds against v1 and
fails against v2**. v1 is kept, compiled and never deployable in intent, at
`contracts/src/legacy/FriendBankV1.sol`, so the claim can be checked rather than trusted.
Every guarantee the hall shows is mapped to its named Foundry tests in `contracts/README.md`, and the desk panel prints those names under each line.

## What the research found

Everything here is reproducible: `npm run verify` checks 63 facts against live
chain state, none skipped, and the backtests replay every swap in the pool's history.

**1. The pool pays its liquidity providers nothing, so nobody provides any.** `slot0.lpFee = 0`
and `Hook.FEE_BPS() = 500`: 5% of every swap goes to Friend holders and none to liquidity. The
Market's seed position is 100% of the pool's liquidity. One outside address ever tried, and
left within hours.

**2. The fee is always taken in WETH, and it pays out a week late.** Both directions, verified
on real buy and sell receipts. Fees collect into a pending pot and only stream to Friends after
`allocate()` rolls them into the next seven days. Friend RF rewards come from activations and
Reserve fees, never from trading.

**3. "Our volume raises everyone's rewards" is true for the protocol and false for whoever pays
for it.** A bank round trip of V WETH costs its members `0.0975 V (1 - s)`, where s is their
share of all Friend weight. At one Genesis (s = 0.20%) every 1 WETH the bank churns needs about
**964 WETH** of outside volume just to break even. So the bank never trades for volume. It
adds liquidity, and the volume that crosses it pays Friends.

**4. Every taker strategy lost on this tape, and so did every grid.** Passive LP, grids, mean
reversion and momentum all lost against holding, as did a toll-free range-order grid (4.5% to 89.5% behind holding across four windows).
The bank's own desk, run without its arming rule over the pool's whole life, would have lost
**10.11%** of the book; with the rule it never armed and lost nothing.
The same engine earns on a choppy synthetic tape, so the losses are the market's, not the
code's. RF slid, it did not swing, which is why the desk waits for swings to come back before
it arms.

**5. There is a Laffer curve on the hook fee.** A venue at 1% a side would need 5x the volume to
keep Friend holders whole; 2.5x at 2%; 1.7x at 3%.

## For the Rare Friends team

Things we found that are not in the docs, offered in good faith:

- `allocate()` has been called once since launch. If nobody calls it when the stream ends,
  every Friend's rewards pause. The bank's keeper is built to call it for everyone.
- One externally owned address owns every protocol contract. On a local fork,
  `migrateRewards` moved all unclaimed rewards and froze swaps, and `Hook.setRewards` can
  redirect the fee. A multisig and a timelock would let builders like us promise members more.
- `readGenerationEligibility` can never admit a Genesis, because it reads the Generations
  contract. The Genesis carries 95% of all Friend weight. That is why this hall is not an SDK
  game.
- The 5% fee may sit above the revenue-maximising rate (the table above).

## Built for this community before the Vibeathon

- **[Rare Friends Cards](https://rare-friends-cards.vercel.app)**: every Friend as a trading
  card with its live yield, used by holders and shared by the founder.
- **The meme machine** at `/memes` on the same site, with a Friend on every template.
- When the reward formula changed on 2026-09-20, the cards site was re-derived from the
  protocol's own source the same day, and it still audits clean against the published numbers.

## Run it yourself

```sh
npm install
npm run verify           # 63 facts against live chain state
npm run keeper -- --wallet 0xYOURWALLET   # dry run: what the keeper would claim and allocate
npm run backtest:gated   # the desk against the whole tape
npm run derive           # every parameter, labelled MEASURED, DERIVED or CHOICE
cd contracts && forge test
cd app && npm install && npm run dev      # the hall at /, the research at /docs
```

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

## Known issues and limitations

- **The contract is not deployed and has not been audited.** Nothing in this demo moves funds.
  We will not deploy it to hold anyone's money before an external audit.
- **The bank's income depends on one key it does not control.** See "For the Rare Friends team".
  The keeper stops and raises an alarm if the fee is ever re-pointed.
- **The desk's price guard bounds damage; it does not remove it.** Ranges must sit clear of a
  time-weighted price, but a patient actor can drag that price about 6% an hour (tested), and
  because nobody arbitrages inside a 5%-per-side fee the pool can be held about 10% off for
  free. Members would be trusting the keeper within that band, and the desk's other limits
  (loss lock, loss budget, size and rate caps) cap how often it can be exploited.
- **Signing up takes more than one click.** It is two approvals and a `join` per Friend: one confirmation with a wallet that batches calls, otherwise three transactions. No wallet has yet been tested batching on this chain.
- **The desk is off, and may stay off.** Volume fell from 930 WETH on launch day to about
  3 WETH over the last 24 hours. The desk arms only on measured chop. The pool is under
  a week old, so its 7-day replay check reads "not yet measurable" until 2026-09-23 and says so.
- **Small Friends are not worth enrolling yet.** A collect costs about $0.08 in gas; a Gen-3
  earns cents a week. The bank is built for the Genesis, which holds 95% of all weight.
- **A member who claims outside the bank** leaves those rewards in the Friend's wallet unless
  they turn on sweep mode, which takes only what sits above their balance at signup.
- **Accounts in the demo live in your browser**, because there is no backend.

## Credits

**FriendSDK v0.1.2, under its Apache-2.0 licence, used as a library**: `renderWorld` draws the
scene, `createWorldMovement` handles walking, collision and pathing, `project`/`unproject`
map world to screen. The building itself is ours: `app/lib/hall-art.ts` draws the facade, the
vault and the counter to match the head-on projection, and the SDK props are kept hidden for
collision only.

The contract vendors nine MIT files of Uniswap v4 math (`contracts/src/vendor/`), unmodified apart from import paths, each listed with its source commit in `contracts/README.md`.

Friend artwork is each NFT's own on-chain SVG, read unmodified. No fonts or images are
bundled. Protocol mechanics were read from the contracts themselves via
`rarefriends.com/api/protocol/config`, which ships full ABIs.
