**Play it: <https://bank-of-friends-nu.vercel.app>** with no wallet, no signature and no install.
You land inside the hall with a Friend already on the marble.

| The hall | The Trading Floor |
| --- | --- |
| ![The hall: the facade, the marquee and the pooled plaque](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/hall.png) | ![The Trading Floor: the standing sell order, live](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/floor.png) |
| **The Desk: three calls, every guarantee with its test** | **The Vault: a wall of safe deposit boxes** |
| ![The Desk](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/desk.png) | ![The Vault](https://raw.githubusercontent.com/Halldon-Inc/bank-of-friends/main/docs/media/vault.png) |

**Project name**

The First Bank of Friends

**Builder / contact**

Hunt &middot; GitHub [@huntclubhero](https://github.com/huntclubhero) &middot; wallet `huntclubhero.eth`

**Category**

Economy Potential

**One sentence**

A bank where one signup harvests your Friend's RF and WETH rewards into your own safe deposit
box, and your RF becomes a standing sell order resting above the market in the $RAREFRIENDS
pool: the bank never swaps, so it never pays the 5% toll, you are filled above the market
instead of 5% below it, and every buyer who takes it pays 5% to every activated Friend.

**Source code**

<https://github.com/Halldon-Inc/bank-of-friends> &middot; Next.js 16, viem, Solidity 0.8.30 +
Foundry. **FriendSDK v0.1.2 is used as a library, not a runtime** (see Credits).

**Playable demo**

<https://bank-of-friends-nu.vercel.app> &middot; the live desk and the research are at
<https://bank-of-friends-nu.vercel.app/docs>.

---

## The economy in one picture

```
 every week the protocol pays each activated Friend
   RF   (activations, hardwires, upgrades, Reserve fees)
   WETH (5% of every swap in the RF pool)
          |
          v   the keeper claims when it is worth 20x the gas; a claim always pays the Friend's own wallet
 +--------------------------------------------------------------------+
 | YOUR BOX in the bank: exact RF, exact WETH, no shares, no NAV      |
 |   RF you deposit   = a standing SELL order, resting ABOVE market   |
 |   WETH you deposit = a standing BID, resting BELOW the last sale,  |
 |                      only while the market is measurably two-way   |
 +--------------------------------------------------------------------+
          |
          v   one ask and one bid rest inside the RF/WETH pool: the pool's first outside liquidity
   an outside TAKER crosses the bank's order
          |
          +---> pays 5% in WETH to the ActivationManager -> streamed to EVERY activated Friend
          |                                                  (members get their share back)
          +---> the proceeds land in the boxes of the members who funded that order, exactly,
                and leave whenever they ask
```

**Why this is an economy and not a trade.** The pool pays its liquidity providers nothing
(`slot0.lpFee = 0`) and takes 5% from every taker, so nobody rests any liquidity and every
holder who converts a reward pays the toll and walks the Market's price curve. That leaves the
whole distance between the market price and a resting order on the table. The bank picks it
up for its members: a resting ask one tick above the market filled at a median **1.02x
the spot at placement** on the real tape, where a taker receives at most 0.95x. That is
**about +8% per RF sold against the taker route**, paid by a buyer who was going to
buy anyway, and it does not need the price to go anywhere. Sell pressure that today dumps
through the price becomes an order book above it.

## What it is built to do

A Rare Friend earns RF and WETH every week, and most of it sits unclaimed in the protocol; a
claim always pays it into the Friend's own wallet. The First Bank of Friends is built to put
that money to work without ever taking the NFT. **None of it is deployed or running yet**;
everything below is what the contract and the keeper do in tests, and what the demo simulates.

1. **Sign up once.** From your Friend's own wallet: approve RF, approve WETH, and `join` with a
   daily cap per asset. One confirmation with a wallet that batches calls, otherwise three. The
   NFT never leaves your wallet, and there is nothing more to sign until you leave.
2. **The bank harvests for you.** A keeper claims your Friend's rewards when they are worth at
   least 20x the gas, and moves only what that claim just delivered into **your own box**. Money
   you keep in the Friend's wallet is never touched.
3. **Your deposit is your instruction.** RF cap 0 means keep your RF (it stays in your Friend's
   wallet); RF cap above 0 means sell it, above the market, as a maker. WETH is held, and joins
   the bank's bid only while the market is measurably two-way. No strategy to sign, no switch.
4. **The desk only ever makes, never takes.** The standing sell order rests 15% of the RF book at
   a time, 1.2% wide, just above the market, is re-placed when it fills or when the market walks
   2% away, and in a rally moves to a take-profit range (+10% to +100%) rather than selling into
   it at the edge. The pool's hook charges no fee on liquidity, so **the bank never pays the 5%
   toll**; the trader who crosses its order does, and that 5% goes to every activated Friend.
   The two-sided grid, which adds bids, arms only on measured chop and is off today.
5. **Your box is yours, exactly.** Every depositor owns an exact amount of RF and an exact
   amount of WETH. There are no shares and no price in the accounting, so another member joining,
   leaving, selling or getting a better fill cannot move your balance by a single wei, and a
   range's proceeds go only to the members who funded it.
6. **The bank keeps everyone's stream flowing.** Rewards reach Friends only after someone calls
   `ActivationManager.allocate()` each week. It has been called once since launch. The keeper is
   built to call it when it is due, for every activated Friend, member or not.
7. **Leave whenever you like.** Withdraw RF, WETH or both, at any time, with no owner check, no
   queue and no pause, including while the desk is halted and even if the protocol's rewards
   contract is switched off. If you sell your Friend, the next collect sees the sale, suspends
   the account and pulls nothing from the buyer. **Closing is one action.**
8. **Your own wallet is never in reach.** Your personal wallet approves nothing. The bank can
   only ever reach the RF and WETH inside your Friend's wallet, and a fuzzed test proves no
   sequence of anyone's actions costs it a wei.

## How to use the demo

Walk with WASD, the arrows, or a tap. Three stations:

- **The Desk** opens your account. You see the three signup calls, a daily cap per asset, what
  you let the bank do, and what it cannot do, each line with the Foundry test that proves it.
- **The Trading Floor** shows the desk's live decision, read from the chain right now: the
  standing sell order it would rest (price above the market, size, edge per RF against the
  taker route, and what the buyer would pay to every Friend), and the two-sided grid's
  conditions. A separate, clearly labelled button simulates a week.
- **The Vault** is a wall of safe deposit boxes, one per Friend, each showing what went in and
  what the desk made or lost, per asset. The pooled book is drawn as the sum of the boxes.

The demo is simulated end to end and stamped SIMULATED: the contract is not deployed and no
funds move.

## Tokenomics

Full write-up: [`docs/TOKENOMICS.md`](https://github.com/Halldon-Inc/bank-of-friends/blob/main/docs/TOKENOMICS.md).
Every number is printed by `npm run economy` into [`docs/EVIDENCE.md`](https://github.com/Halldon-Inc/bank-of-friends/blob/main/docs/EVIDENCE.md)
or read live in `/api/desk`, and labelled MEASURED, DERIVED, SYNTHETIC or CHOICE.

**Where the money comes from**

| source | per unit | label | who pays |
| --- | --- | --- | --- |
| the spread: a resting ask fills above the market | fill / spot at placement = 1.02 (median, real tape) | MEASURED | the taker who crossed |
| the toll avoided: a member converting through the bank pays 0%, not 5% | +5.26% of the WETH leg | MEASURED constant | nobody: the bank is liquidity, not a swap |
| the fee rebate: every taker who crosses the bank pays 5% to all Friends; members hold share s of all weight | 0.05 x s of every WETH crossed | DERIVED | the taker |
| the Genesis desk (designed, not in the contract): buy under a floor-backed max bid, activate with pooled RF | positive only under `genesis.maxBidUsd`; idle today | DERIVED | the reward stream |

**Where the RF goes (paired with $RAREFRIENDS)**

- Every fill routes 5% of its WETH leg to every activated Friend, members included.
- RF the bank sells is sold **above** the market, never through it: the dump becomes an order book.
- RF the bank buys (the grid's bids, when armed) is bought below the last sale with WETH the protocol paid in swap fees: fees -> rewards -> bids -> RF.
- Each Genesis the pooled desk would buy needs 100,000 RF to activate (50,000 burned, 50,000 to the RF stream); pooled RF pays it in kind.
- The keeper calls `allocate()` so every Friend's stream keeps running.

**What makes it not lose**

| rule | enforced by |
| --- | --- |
| the bank never swaps; it only rests ranges, so it never pays the toll | `RangeDesk.sol` (no swap path), fork test |
| never sell bought RF below cost x 1.05; never bid above the last sale x 0.95 | on chain, the loss lock |
| every range at least 1% clear of a time-weighted price anyone can update | on chain, `PoolObserver` |
| bids only when the market has swung 5% and back six times in 72h, trended under 10%, and last week replayed beats holding | keeper, `lib/strategy.mjs` |
| asks rest whenever RF is deposited and worth its gas; in a rally they move to a take-profit range instead of selling into it | keeper, `lib/strategy.mjs` `standingOrder` |
| withdraw any time, no owner check, no pause | on chain, `invariant_EveryoneCanExit` |

**What it does not claim:** it does not beat holding RF in a rally. A member who deposits RF
asked for it to be sold; the promise is per unit sold, against the route they would otherwise
have taken, and it holds in every window measured.

**Evidence (`npm run economy`)**

**Per unit sold, against the taker route, in every window and every pool** (MEASURED, [`npm run economy`](https://github.com/Halldon-Inc/bank-of-friends/blob/main/docs/EVIDENCE.md)):

| test | per unit vs taker at placement | total vs a taker making the same decisions | fills |
| --- | ---: | ---: | ---: |
| RF real tape, 10 window-and-book runs (9.4 days, price -89%) | median **+8.2%** (fills at ~1.02x spot at placement; +4.0% even against a taker selling at the instant the fill completed) | +1.0% to +4.2% (RF-only book), +0.1% to +0.5% (a $100/day stream) | 1 to 4 per window |
| 16 other swap-fee pools, out of sample (8 Robinhood v4 hook tokens, 8 StonkFun; hourly bars; fees 4% to 5.3%) | median **+7.9%**, worst +6.9%, best +12.2% | median **+7.5%**, beat 14 of 16, worst -6.6% | 10 to 59 per pool |
| SYNTHETIC chop / slide -5%/day / rally +5%/day (3 seeds, 14 days) | +8.3% / +8.2% / +8.1% | +5.8% / +5.8% / +6.3% | 20 / 16 / 20 |

Against **holding**, the result is the market's direction and nothing else: +71% over the real tape's whole life (RF fell 89%), about -0.3% in the flat last 72 hours, -49% in a synthetic +5%/day rally (the take-profit brake limits that only a little: -54% with it off). A sell programme trails holding when the asset keeps rising, whatever the execution; that is why converting at all is the member's instruction, not the bank's bet.

Conversion demand exists: over the tape, 372M RF was sold into the pool (58% of gross volume by WETH; the daily sell share ran 30% to 93%). Every unit of it went through a taker swap, paid 5% and ate impact. The standing order is the same flow, resting instead.

**Forward test, live, no money** ([`docs/PAPER.md`](https://github.com/Halldon-Inc/bank-of-friends/blob/main/docs/PAPER.md), running since 2026-09-26 03:20Z)

The backtests above are history. This is the same code deciding in real time on live pools across launchpads: Rare Friends, Pons v2, Project Mars, the Robinhood Index hooks, fresh Robinhood launches, Long.xyz, StonkFun, Ember and pump.fun. A fill counts only when a minute bar crosses the whole resting range, one-trade wicks cannot fill, a drained pool is cut off, and the taker it is compared with pays no price impact.

| after 10.8 hours, 21 live pools | fills | per unit vs a taker at the moment of the decision | total vs a taker making the same decisions |
| --- | ---: | --- | --- |
| standing sell order | 15 on 8 pools | median **+6.9%**, worst +2.9%, **15 of 15 positive** | **ahead on all 8 filled pools** (+0.5% to +5.8%) |
| two-sided grid, live gates | 3 | median +7.8% | ahead on 3, flat elsewhere: too few fills to judge |
| grid, loosened in-sample setting | 2 | median +11.6% | ahead on 2: too few fills to judge |

The pools behind the taker were unfilled orders marked a few thousandths of a percent under the market, and ZCAT, a StonkFun transfer-tax coin, where the tax on the maker's deposit cost 0.9% before any fill. That is why the bank refuses transfer-tax pools. The test keeps running; the file is rewritten every 15 minutes.

**At scale** (DERIVED from live `/api/desk` inputs: this week's streams, total weight, prices)

DERIVED from live `/api/desk` inputs on 2026-09-26 (RF stream 85.4M RF a week, WETH stream 29.55 WETH a week, total weight 1,036M, RF $0.00161, ETH $2,690), at the real-tape median edge of +8.2%, assuming each member routes their whole RF stream through the bank and it all fills:

| Genesis members | share of weight | RF a week through the bank | gained vs the taker path, a week | WETH crossed by takers | 5% paid to every Friend | members' own WETH stream |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.19% | 0.16M RF ($266) | $22 | 0.10 WETH | $13 | $153 |
| 10 | 1.93% | 1.65M RF ($2,656) | $219 | 0.99 WETH | $133 | $1,534 |
| 50 | 9.65% | 8.24M RF ($13,280) | $1,095 | 4.94 WETH | $664 | $7,672 |
| 200 | 38.6% | 32.96M RF ($53,119) | $4,380 | 19.74 WETH | $2,656 | $30,688 |

The members' rebate of that 5% (their share s of it) is small at any realistic share ($64 a week at 50 Genesis) and the economy does not lean on it. UNMEASURED: at 50 Genesis the bank would be most of the pool's depth near the price (the whole pool traded 2.7 WETH in the last 24 hours), so whether resting depth draws more buyers, and how fills are shared if other makers appear, are open. The Genesis desk is idle today: the Reserve floor is $1,371, convert-below $1,330, max bid $1,130; each conversion would be 900,000 RF ($1,450) of pool volume paying about $72 to every Friend, and each activation spends 100,000 RF ($161, half burned).

## How it works

**Signup.** A Rare Friend's wallet is an ERC-6551 account that only the NFT's owner can use, it
cannot batch calls, RF has no permit, and WETH's permit cannot be signed by a Friend wallet. So
there is no honest one-signature signup: it is two approvals and a `join`. The Bank records the
Friend, its wallet (read from the Friend's own collection and checked against the wallet's
`token()`), and the owner at that moment. Only Genesis and real Generations Friends can enrol.

**Harvest.** `ActivationManager.claim` is permissionless and always pays the Friend's own wallet,
never the caller. The Bank's `collect` claims, then moves **only what that claim just delivered**,
up to your daily cap per asset. Before every collect it re-checks who owns the Friend; if the NFT
has moved, the account is suspended and nothing is pulled from the buyer. Anyone may call
`collect`; a caller who is not the holder may take a tip of at most 1% of that Friend's own WETH,
once per 12 hours, so the keeper does not have to be us.

**Your box.** Each holder owns an exact vector: idle RF, idle WETH, and units in the desk's open
sell and buy orders. There are no shares and no NAV. Every desk action is a linear step applied
to the holders who funded it, deposits and withdrawals never write a step, and every holder rounds
down, so claims can never exceed the book and nothing another holder does can move your account.

**The desk.** Two programmes share one ask slot and one bid slot in the Uniswap v4 pool, and
neither ever swaps. The **standing sell order** (`lib/strategy.mjs` `standingOrder`, keeper-only,
no contract change) rests idle RF one tick above the higher of spot and the time-weighted price,
1.2% wide, 15% of the RF book per placement, re-placed on fill, chased down when the market
walks 2% away, and switched to a take-profit range (time-weighted price x 1.10 to x 2.0) when
the price rises more than 10% in a day or makes a new 72-hour high. The **two-sided grid** arms
only when all three hold: at least six completed 5% swings in the last 72 hours, a 72-hour trend
inside 10%, and a replay of the same ladder over the last seven days beats holding; only then
does the bank bid with members' WETH. On chain, every range must sit at least 1% clear of a
time-weighted price that anyone can update, no sell may sit below the average cost of RF the
desk bought plus 5%, no buy may sit above the last sale minus 5% within 30 days of it, a range
is 1% to 15% of its side, at most 50% of a side per day and 24 changes a day, and after 7 days
anyone may close a range. The owner can never be the keeper, and changing the keeper takes two days.

**Exit.** `withdrawRF`, `withdrawWETH` or both, any time, with no owner check and no pause. Your
share of an open range can be pulled out by you alone with `exitRanges`. The exit path touches
only the pool's liquidity, never the rewards contract or a swap, so it keeps working even if the
protocol owner switches the rewards off; a fork test proves that against the live contracts.

**The keeper.** `npm run keeper` plans (and, only with a key and `--execute`, sends) the weekly
`allocate()`, the claims and the collects. With `--bank` it also runs the desk: it measures the
market, reads the bank's one ask and one bid, and plans `closeAsk`, `closeBid`, `placeAsk` or
`placeBid` (`lib/desk-plan.mjs`): the standing sell order when the grid is off, both sides when
it is on. Every desk call is simulated as the bank's keeper before anything is sent, and the
planner mirrors each rule the contract enforces, so it never asks for a trade the contract
would refuse.

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
Every guarantee the hall shows is mapped to its named Foundry tests in `contracts/README.md`.

## What the research found

Everything here is reproducible: `npm run verify` checks 63 facts against live chain state,
none skipped, and the backtests replay every swap in the pool's history.

**1. The pool pays its liquidity providers nothing, so nobody provides any.** `slot0.lpFee = 0`
and `Hook.FEE_BPS() = 500`: 5% of every swap goes to Friend holders and none to liquidity. The
Market's seed position is 100% of the pool's liquidity. One outside address ever tried, and
left within hours. **This is the gap the bank's standing orders fill.**

**2. The fee is always taken in WETH, and it pays out a week late.** Both directions, verified
on real buy and sell receipts. Fees collect into a pending pot and only stream to Friends after
`allocate()` rolls them into the next seven days. Friend RF rewards come from activations and
Reserve fees, never from trading.

**3. "Our volume raises everyone's rewards" is true for the protocol and false for whoever pays
for it.** A bank round trip of V WETH costs its members `0.0975 V (1 - s)`, where s is their
share of all Friend weight. At one Genesis (s = 0.20%) every 1 WETH the bank churns needs about
**964 WETH** of outside volume just to break even. So the bank never trades for volume. It
rests liquidity, and the takers who cross it pay Friends.

**4. Every taker strategy lost on this tape, and so did every two-sided grid.** Passive LP,
grids, mean reversion, momentum and every bid policy lost against holding on a tape that fell
89% in six days. The one thing that earned per unit was maker execution of sales the holder
wanted anyway, which is why the standing order is a sell programme with a rally brake, and the
bids wait for a two-way market.

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
- A non-zero LP fee, or a share of the hook fee to liquidity in range, would make every holder a
  potential maker and deepen the pool at no cost to takers. The bank's desk is pool-agnostic (the
  pool key is a deploy argument), so the same standing orders can rest in any RF-paired pool your
  roadmap launches.

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
npm run economy          # the standing order vs the taker route: real tape, 16 other pools, synthetic regimes
node scripts/paper.mjs --tick   # the live forward test across launchpads, one pass (no money)
npm run keeper -- --wallet 0xYOURWALLET   # dry run: what the keeper would claim and allocate
npm run test:desk        # the keeper's desk planner against the contract's rules
npm run backtest:gated   # the two-sided grid against the whole tape
npm run derive           # every parameter, labelled MEASURED, DERIVED or CHOICE
cd contracts && forge test
cd app && npm install && npm run dev      # the hall at /, the research at /docs
```

## Checks

| check | result |
| --- | --- |
| `forge test` (contracts/) | **114/114**: 103 offline (incl. 17 in `WhyV1WasReplaced.t.sol`, 5 proving the owner's own wallet is never touched, and fuzzed invariants) plus 11 on a fork of live Robinhood Chain state, nothing broadcast. The contract is unchanged by this update; the 103 offline tests were re-run 2026-09-26 |
| `contracts/mutate.sh` | **16/16** planted bugs caught (no ownership re-check, sweeping the whole wallet, rounding up, withdraw gated by halt, TWAP guard off, and eleven more) |
| `npm run verify` | **63/63** facts asserted against live chain state, none skipped (2026-09-26) |
| `npm run economy` | instrument checks 3/3; real tape per unit **+8.2%** vs the taker route (10 runs); 16 pools out of sample **+7.9%** per unit, beat **14 of 16** on total vs a taker on the same schedule; synthetic chop / slide / rally all positive vs the same-schedule taker |
| `npm run test:desk` | **30/30**: every planned ask and bid, standing order and grid, checked against the contract's reverts restated from the Solidity |
| `npm run keeper -- --wallet huntclubhero.eth` | dry run 2026-09-26: 8 Friends found on chain (7 earning), claims planned for RF x3 and WETH x6, nothing sent, no alarm |
| `node scripts/paper.mjs --loop 900` | forward test on 21 live pools across 7 launchpads since 2026-09-26 03:20Z: standing sell order 15 of 15 fills ahead of the taker route per unit (median +6.9%), ahead of the same-schedule taker on all 8 filled pools; decision log in `data/paper/log.jsonl` |
| `scripts/rehearse-desk.mjs` (local fork) | 2026-09-26, fork of live Robinhood Chain state at block 72,700,207: four real Genesis enrolled, 49,403 RF collected, and with the real gates OFF (no armed override) the keeper planned and sent `placeAsk` 1.9% above mid as the standing order; the contract accepted it (2 confirmed, 0 failed) and the next run found it resting. Nothing broadcast |
| `npm run backtest:gated` | real tape (10,012 swaps, 9.4 days): the two-sided grid stays off, +0.00% vs hold; ungated it would have lost 9.16% |
| `npm run sweep` | 60 regimes: gated worst -6.76% vs ungated worst -42.98% |
| `npm run sweep:hall <url>` | **168/168** on the deployed site across twelve sizes, 320px to 3440px |
| `npm run play:hall <url>` | **98/98** on the deployed site: open an account, read the live floor (the word on the board must match `/api/desk`, and a standing order must show its price and its edge), simulate a week, open the vault, take out and close, in all three room shapes |
| `node scripts/visual-check.mjs <url>` | **70/70** on /docs across seven widths |
| `npm run check:lib-sync` | copies identical, and every grid gate is fed by the live desk |
| `npx tsc --noEmit`, `next build` | clean |

## Known issues and limitations

- **The contract is not deployed and has not been audited.** Nothing in this demo moves funds.
  We will not deploy it to hold anyone's money before an external audit.
- **The standing sell order sells every member's deposited RF pro rata.** A member who wants to
  keep RF sets an RF cap of 0 or withdraws it; a per-member sell / keep flag is the first
  contract change after the audit.
- **It does not beat holding in a rally.** The take-profit brake limits how much it gives up
  (SYNTHETIC +5%/day: -49% vs holding, against -54% for the edge ask alone), and
  the brake is a CHOICE that has not been tested on real data, because the real tape has no rally.
- **The bank's income depends on one key it does not control.** See "For the Rare Friends team".
  The keeper stops and raises an alarm if the fee is ever re-pointed.
- **The desk's price guard bounds damage; it does not remove it.** A patient actor can drag the
  time-weighted price about 6% an hour (tested), and because nobody arbitrages inside a
  5%-per-side fee the pool can be held about 10% off for free. The loss lock, the loss budget and
  the size and rate caps bound how often that can be exploited.
- **Signing up takes more than one click.** Two approvals and a `join` per Friend.
- **The two-sided grid is off, and may stay off.** It needs a two-way market roughly 3x to 10x
  today's volume; the standing sell order does not.
- **Small Friends are not worth enrolling yet.** A collect costs about $0.08 in gas; a Gen-3
  earns cents a week. The bank is built for the Genesis, which holds 95% of all weight.
- **Accounts in the demo live in your browser**, because there is no backend.

## Credits

**FriendSDK v0.1.2, under its Apache-2.0 licence, used as a library**: `renderWorld` draws the
scene, `createWorldMovement` handles walking, collision and pathing, `project`/`unproject`
map world to screen. The building itself is ours: `app/lib/hall-art.ts` draws the facade, the
vault and the counter to match the head-on projection, and the SDK props are kept hidden for
collision only.

The contract vendors nine MIT files of Uniswap v4 math (`contracts/src/vendor/`), unmodified
apart from import paths, each listed with its source commit in `contracts/README.md`.

Friend artwork is each NFT's own on-chain SVG, read unmodified. No fonts or images are
bundled. Protocol mechanics were read from the contracts themselves via
`rarefriends.com/api/protocol/config`, which ships full ABIs.
