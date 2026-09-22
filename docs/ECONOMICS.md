# Economics of the First Bank of Friends

Every number here was read from Robinhood Chain (4663) on 2026-09-22 unless it says
otherwise, and each is labelled **MEASURED** (read on chain), **DERIVED** (algebra on
measured inputs) or **CHOICE** (a preference, stated with its consequence). The live
figures behind the dashboard come from `/api/desk`; these are the dated ones.

## 1. The cost stack

| Cost | Value | Label and source |
|---|---|---|
| **Taker fee** | **5% of the WETH leg, each direction** | MEASURED: `Hook.FEE_BPS() = 500`; 5% of the input on a buy (`beforeSwap`), 5% of the gross output on a sell (`afterSwap`) |
| Round trip for a taker | 9.75% | DERIVED: 0.05 + 0.05 x 0.95 |
| Where the fee goes | `ActivationManager` | MEASURED: `Hook.rewards() == 0xD4A3...83Ac`; the desk API raises an alarm if that ever changes |
| **LP fee** | **0%** | MEASURED: `slot0.lpFee = 0`, and the `fee` field of all 8,826 Swap events is 0 |
| Liquidity hooks | none | MEASURED: hook FLAGS `0x20cc` has no `beforeAddLiquidity` / `beforeRemoveLiquidity` |
| Gas, swap | ~209k gas = $0.033 | MEASURED: 8 real txs at 0.057 gwei |
| Gas, range flip | ~$0.07 | CHOICE: remove + re-add in one unlock, about two swaps |
| Pool depth | 112.7 WETH and 193.9M RF, full range | MEASURED: `slot0` + `liquidity` via `extsload` |
| Third-party liquidity | **0** | MEASURED: the Market's seed position is 100% of pool liquidity |

**The 5% is paid by whoever SWAPS. Nobody who provides liquidity pays it.**

## 2. Why the desk is maker-only

Passive liquidity is dominated: with `lpFee = 0` a liquidity provider earns nothing
and takes the full inventory swing. Replayed through the pool's whole history, a
passive full-range position lost 42% to 55% against holding (`docs/BACKTEST.md`).

Active liquidity is different. A v4 **range order** (single-sided liquidity in a narrow
band) is how an exchange limit order works on an AMM, and because the hook has no
liquidity callbacks it **never pays the 5%**. A taker grid needed a 10.80% step just to
break even; a maker grid breaks even at gas. So the desk would quote only as ranges inside
the pool, and it would become the third-party liquidity the pool never had.

That did not make the history profitable. Replayed endogenously, the maker grid still
lost to holding in trending windows, because a trend fills one side only
(`docs/STRATEGY.md`, `scripts/sweep-regimes.mjs`). **The toll was never the binding
constraint. The trend is.** That is why the desk is off until the market has recently
swung back and forth, and why every fill is loss-locked.

## 3. The volume truth

Rewards ARE the 5%. More volume raises every Friend's rewards. It does not follow that
the bank should make volume.

**Takers who cross the bank's ranges pay 5% to every activated Friend. The bank never
pays the toll itself.** If the bank instead traded to add volume, a round trip of V WETH would
pay `0.05V + 0.05 x 0.95V = 0.0975V` in fees, of which members get back only their
share `s` of total reward weight, one stream later:

```
net to members = -0.0975 V (1 - s)            never positive
break-even needs outside volume Vo >= 1.95 V (1 - s) / s
```

| member share s | cost per 1 WETH round trip | outside volume needed per 1 WETH |
|---|---:|---:|
| Hunt today, 0.202% (MEASURED 2,013,675 of 997.5M weight) | 0.0973 WETH | **964x** |
| 1% | 0.0965 WETH | 193x |
| 10% | 0.0878 WETH | 17.5x |
| 50% | 0.0488 WETH | 1.9x |

Holding the chart at 25 WETH a day this way would cost about $3,400 a day at Hunt's
share. It is also wash trading. **The bank never trades against itself.** The live
figure for the founding member is `volumeLoop` in `/api/desk`.

## 4. The reward runway

Fees are paid a week late. `fund()` adds to `streams(asset).pending`; `allocate()` is
permissionless but reverts until the current stream finishes, then streams all of
pending over `DURATION = 604,800 s` (MEASURED, confirmed by fork trace).

| | WETH | RF | label |
|---|---:|---:|---|
| streaming this week | 39.03 | 10.62M | MEASURED `streams().rate` |
| queued for next week (allocates 2026-09-23 15:09 UTC) | 29.27 | 83.16M | MEASURED `streams().pending` |
| steady state at the last 72h of activity | ~4.0 | ~10.5M | DERIVED |

Pool volume went 930, 157, 70, 29, 8.7, 14.3 WETH a day from Sep 16 to Sep 21. Next
week's RF, 83M, is 43% of the pool's RF depth; if it were all sold the price would fall
about 51% (DERIVED, constant product). About 43.3M RF and 6.48 WETH of past inflows came
directly from the protocol owner's wallet (MEASURED transfers), so part of the stream is
subsidy. **Any APR quoted off this week's stream is annualising a one-off.**

## 5. Reward weight: what RF buys

| Use of RF | RF | Weight | Weight per RF | Capital kept? |
|---|---:|---:|---:|---|
| **Activate a Genesis** | 100,000 | 2,000,000 | **20.0** | the NFT, with a Reserve floor |
| Hardwire Gen-1 | 100,000 | 175,000 | 1.75 | no, burned |
| Gen-1 tier 3 to 4 | 168,750 | 345,938 | 2.05 | no |
| Gen-3 tier 1 to 2 | 750 | 1,163 | 1.55 | no |
| Promote Gen-3 t1 to Gen-2 t0 | 9,000 | 13,788 | 1.53 | no |

MEASURED from `weightMultiplierBps`, `cumulativeBps` and the docs. **A Genesis cannot be
upgraded, promoted or hardwired.** Generations upgrades pay back their burned RF in 29 to
168 weeks at steady-state rewards (DERIVED); they are not yield.

## 6. The Reserve floor and the Genesis desk (research panel only)

The Reserve pays `RF_PER_GENESIS - DEPOSIT_FEE = 900,000 RF` for any Genesis (MEASURED).
Selling that through the pool returns about **0.49 WETH ($1,364)** today (DERIVED), a
contract-enforced floor under every Genesis while conversion stays enabled. The desk API
publishes two thresholds and no sale price (OpenSea's events API requires a key):

- **convert below** F x 0.97: buy, deposit, sell the RF (the 3% is a CHOICE for drift);
- **max bid** = F, plus one queued stream's share at dump value, minus the 100k RF
  activation, minus 2 sigma of a one-week RF move on F (CHOICE).

It is not in the contract. It is shown so a member can see what a Genesis is worth to
the bank, and it is idle whenever the market is above the max bid.

## 7. The ladder, safest rung first

**Rung 0, the default: harvest and hold in kind.** Each Friend has its own box. The
keeper claims (permissionless, credited to the Friend's own wallet) and moves exactly
the RF and WETH that Friend earned. No shares, no NAV, no strategy risk.

**Rung 1: the maker desk. Off until the arming rule holds.** Range orders inside the
pool, loss-locked on chain, bids sized to a volatility-scaled inventory cap, a 15%
drawdown breaker measured against holding, and exit that is never paused.

**Never:** self-volume, a separate low-fee venue (it diverts every Friend's fee and gets
only arbitrage flow), passive LP, or Generations upgrades sold as yield.

| Guarantee | Mechanism |
|---|---|
| Money already in the Friend's wallet is never touched | the bank moves only what its own claim just delivered, capped per asset per day (sweep mode, if switched on, also takes anything above the signup balance) |
| No sale below cost | the loss-lock, checked by `RangeDesk.sol` on every range. The contract allows a small 30-day loss budget below the lock; the strategy never uses it |
| No leverage | no borrow path exists |
| Exit is never blocked | `withdraw()` has no timelock, pause, queue or owner check |
| No admin control of funds | the owner can halt quoting and tighten caps; it cannot move funds or loosen anything; it can change the keeper only with a two-day delay, and never to itself |

## 8. What we will not claim

- We will not quote the ~3,100% headline APR. It is a backlog being paid down.
- We will not call a spread "yield" without the inventory risk beside it.
- We will not say the desk adds volume. It adds depth; takers add volume.
- We will not publish a backtest without the counterfactual beside it.
