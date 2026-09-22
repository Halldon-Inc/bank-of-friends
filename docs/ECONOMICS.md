# Market-making economics for $RAREFRIENDS

Every number here was read from Robinhood Chain (4663) on 2026-09-22 and is
reproducible with `npm run verify`. Nothing is taken from rarefriends.com's API,
which is unversioned and has changed both a route and a formula on us inside a week.

---

## 1. The cost stack, measured

| Cost | Value | How it was measured |
|---|---|---|
| **Taker fee** | **5% of the WETH leg, each direction** | `Hook.FEE_BPS() = 500`, applied in `beforeSwap`/`afterSwap` |
| **Round trip** | **~10%** | buy pays 5%, sell pays 5% |
| Where the fee goes | `ActivationManager` | `Hook.rewards() == 0xD4A3…83Ac`, address-for-address |
| **LP fee** | **0%** | `slot0.lpFee = 0` on poolId `0x9116…2240` |
| Protocol fee | 0% | `slot0.protocolFee = 0` |
| **Gas, swap** | **~209k gas = $0.033** | 8 real `Swapped` txs, 0.057 gwei, ETH $2,735 |
| Gas, claim | 102k–210k = $0.016–$0.033 | 5 real `Claimed` txs |
| Pool depth | ~111.8 WETH and ~195.6M RF a side | `slot0` + `liquidity` via `extsload` |
| Price impact | ~0.89% per 1 WETH | constant-product at current depth |

**Gas is a rounding error here. The 5% is the entire game.**

---

## 2. Providing liquidity is strictly dominated

This is the finding the whole project rests on.

```
lpFee = 0          ->  liquidity providers earn NOTHING
FEE_BPS = 500      ->  5% of every swap is taken
Hook.rewards()     ->  ...and sent to ActivationManager, i.e. to Friend holders
```

So **the people who supply the liquidity and the people who collect the fees are
different people.** A normal LP takes full impermanent loss for zero compensation.
That is not a mispricing to exploit, it is a deliberate design: the fee is a
transfer from traders to Friend holders, and LPs were never in the split.

The consequence is measurable and stark:

```
pool total liquidity        147,865,847,752,143,433,133,351
Market's full-range position 147,865,847,752,143,433,133,351
third-party liquidity                                     0
```

**100.00%** of the liquidity in a market doing ~$37.5k/day is the protocol's own
seed position. In 7.8 days of life, not one outside party has ever provided
liquidity. They were right not to.

The hook makes no attempt to stop them, either. Its flags are `0x20cc`:
`beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta`.
There is no `beforeAddLiquidity` and no `beforeRemoveLiquidity`, so PoolManager can
never even consult the hook on a liquidity change. **Liquidity is ungated by
construction, not by permission.** Nobody has used that fact because doing so loses money.

> **Do not LP into this pool.** Any design that adds passive liquidity is donating
> impermanent loss to the protocol. We will not ship it.

---

## 3. What RF is actually worth as a reward-weight input

Fees flow to activated Friends pro rata by weight. So the honest benchmark for any
use of RF is: *how much reward weight does this RF buy, forever?*

Measured inputs:

```
totalWeight                987,281,200
sustainable WETH fee inflow  4.81 WETH / week   ($13,145)
  => yield per unit weight   4.87e-9 WETH / week  ($1.333e-5)
rfUsd                      $0.0015636
```

| Use of RF | RF cost | Weight gained | Weight / RF | Annual $ | **APR** |
|---|---:|---:|---:|---:|---:|
| **Activate a Genesis** | 100,000 | 2,000,000 | **20.0** | $1,385 | **886%** |
| Hardwire Gen-1 | 100,000 | 175,000 | 1.75 | $121 | **78%** |
| Hardwire Gen-2 | 10,000 | 16,000 | 1.60 | $11.1 | **71%** |
| Hardwire Gen-3 | 1,000 | 1,450 | 1.45 | $1.00 | **64%** |
| Hardwire Gen-4 | 100 | 130 | 1.30 | $0.090 | **58%** |
| Hardwire Gen-5 | 10 | 12 | 1.20 | $0.0083 | **53%** |
| Hardwire Gen-6 | 1 | 1.1 | 1.10 | $0.00076 | **49%** |

Notes that matter:

- These APRs use **sustainable fee inflow only**. The site's headline ~3,100% figure
  is computed against a stream that is currently paying down a **29.19 WETH backlog**
  of already-collected fees. That backlog is real money, but it is finite. Current
  fees replace **75%** of the weekly WETH payout, leaving **5.8 weeks** of buffer at
  the present rate. Any model that annualises the backlog rate is annualising a
  one-off.
- Activating a Genesis is **11.4x** better per RF than the best Generations path.
  Genesis is capped at 1,024 and 469 are activated. It is the highest-value RF sink
  in the protocol by a wide margin.
- Hardwires and upgrades are **irreversible**. The RF is gone (50% burned, 50% to
  rewards). You are buying a perpetuity and giving up the principal.

**So the hurdle rate for any market-making strategy is roughly 78% APR** — what the
same RF would earn, risk-free and permanently, as a Gen-1 hardwire. That is a high bar
and we should say so out loud rather than pretend a 2% spread is exciting.

---

## 4. Where a market maker's edge actually is

The edge is not depth and it is not the curve. It is the **5% incumbent toll**.

Anyone who wants to move RF today pays 5%. A market maker quoting a 2% spread is
**60% cheaper than the only other venue**, which is an enormous moat — the kind you
almost never get. Winning the flow is trivial. Keeping the money is the hard part.

Revenue per unit of internalised volume = the spread `s`. Costs:

1. **Adverse selection.** You are the counterparty to whoever wants immediacy. If flow
   is one-directional you accumulate the losing side.
2. **Inventory drift.** RF you are forced to hold while its price moves.
3. **Restocking.** Anything you must rebuy from the pool costs 5%, which instantly
   wipes out 2.5 round trips of a 2% spread.
4. Gas, at $0.033/fill. Irrelevant above ~$50 trade size.

### The problem, stated honestly

Flow over the last 24h through the Market router:

```
35 buys    0.278882 WETH in
 7 sells   3.335976 WETH out
net imbalance  -84.57%  ->  toward SELLING RF
```

Many small buys, a few large dumps. **Net, the market wants to sell RF.** Corroborated
by the pool's own inventory: it was seeded with **64,000,000 RF** (`Market.RF_SEED_AMOUNT`)
and now holds **~195,600,000 RF**. The pool has absorbed ~131.6M RF of net selling and
paid out WETH to do it. Price fell accordingly.

A market maker that posts a bid into that gets filled all day, accumulates RF, pays out
WETH, and watches the mark fall. **That is the single most common way market makers
lose other people's money, and it is exactly the condition present here.**

This is why §6 exists.

---

## 5. Backtest

See `docs/BACKTEST.md`, generated by `npm run backtest` against the complete swap
history of the pool from deployment block 62,624,268. Strategies compared:

| # | Strategy | Inventory risk |
|---|---|---|
| S1 | Passive full-range LP | full IL, zero fee income |
| S2 | Inventory market maker, ±s around pool mid | yes, unbounded without caps |
| S3 | **Crossing network** — match buyer to seller, never hold | **none, by construction** |
| S4 | Auto-compound rewards into reward weight | none, but irreversible |
| S5 | Do nothing: claim and hold | benchmark |

---

## 6. The safety ladder: what "we cannot lose people's money" forces

Market making means taking the other side of someone's trade. It is not possible to
do that with zero risk. So the product is built as a ladder, safest rung first, and
the safe rung is the **default and the headline**, not an afterthought.

### Rung 0 — The crossing network. Cannot lose money.

Match a Friend who wants to sell reward RF against anyone who wants to buy RF, at the
pool's own mid price. Both sides skip the 5%. The Bank takes a small fee on the match.

- **The Bank never holds inventory**, so there is no position to lose value.
- If there is no match, nothing happens. No fill, no risk.
- Worst case for a user is that their order does not fill and they use the pool as usual.

This is the honest answer to the constraint, and it is also the most interesting thing
in the submission: **everyone pays 5% to trade RF. Friends would not.**

### Rung 1 — Bounded inventory market making. Opt-in, capped.

Hard rules, enforced in the contract and not by policy:

| Guarantee | Mechanism |
|---|---|
| Principal is never touched | The Bank's only power is an ERC-20 allowance on a Friend's TBA, and **the member sets the per-epoch cap themselves** at join time. Not `max`. |
| Only reward flow is ever at risk | `collect()` can pull at most `min(memberCap, harvestedThisEpoch)` |
| No leverage, ever | No borrow path exists in the contract |
| Exit is never blocked | `withdraw()` has no timelock, no admin pause, no queue. Pausing quoting is allowed; pausing exit is not. |
| No admin control of funds | Owner may pause quoting and adjust spread inside hard-coded bounds. Owner cannot move member funds, cannot upgrade, cannot alter the exit path. Non-upgradeable. |
| Bounded loss | Max RF inventory, max WETH inventory, max fill per block, and a hard drawdown breaker that halts quoting |
| No oracle games | Quotes anchored to pool `sqrtPriceX96`, clamped against a slow reference, with a per-block fill cap so a single-block price push cannot be monetised |

### Rung 2 — Auto-compound into reward weight. Opt-in, irreversible, flagged as such.

Highest measured return in the protocol (78%–886% APR depending on the sink) but the
RF is consumed permanently. Presented with that tradeoff stated plainly, never as "yield".

### For the Vibeathon itself

**Member #1 is Hunt, and for the duration of the event he is the only member.** The
only money at risk is his, it is reward money he had not claimed, and it is $84.21.
Deposits from anyone else stay closed until the contracts have been audited by someone
who is not us. That is not a limitation to apologise for — it is the correct order of
operations, and it is stated in the submission.

---

## 7. What we will not claim

- We will not quote the ~3,100% headline APR as if it were sustainable. It is a
  backlog being paid down.
- We will not present a market-making spread as "yield" without the adverse-selection
  cost next to it.
- We will not describe a strategy as risk-free unless it is Rung 0, which genuinely is.
- We will not publish a backtest return without the flow imbalance that produced it.
