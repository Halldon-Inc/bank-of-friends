# The maker-only desk

The desk is a **two-range maker**: at most ONE ask range (RF above the price) and ONE
bid range (WETH below it) inside the RF/WETH pool, each a single 5%-wide band, and it
never swaps. That is the contract's shape (one ask and one bid, so every holder's share
of a range is exact); a ladder of several ranges per side would need a larger contract. The hook takes 5% of every swap and has no
liquidity callbacks, so **the bank never pays the toll**; every taker who crosses one of
its ranges still pays 5% to every activated Friend.

It is **OFF by default** and arms only when all six gates are met. Strategy:
`lib/strategy.mjs` (byte-identical in `app/lib/`, shared by the backtests, `/api/desk`
and the hall). Parameters are derived and labelled in `node scripts/derive-parameters.mjs`.

| gate | rule | label |
|---|---|---|
| swings in 72h | at least 6 completed swings of one grid step (5%) | CHOICE |
| trend over 72h | net 72h move under 2 steps (10%) | CHOICE |
| last week replayed | the same desk replayed on the trailing 7 days beats holding | CHOICE |
| inventory | RF under 60% of the book; bids sized to a volatility-scaled cap | DERIVED cap, CHOICE ceiling |
| drawdown | within 15% of its best point, measured against holding | CHOICE |
| breaker | not manually halted | |

A gate with no data (the pool is younger than the window) is **not yet measurable**: it
never passes by default and is never shown as a failure.

**The contract's rules** (`RangeDesk` in `RangeDesk.sol`), mirrored in `DEFAULT_GATES`
and checked by `contractOk` before every open, so the strategy never asks for something
the contract would revert:

| rule | value |
|---|---|
| ask loss-lock | priceLower >= size-weighted cost of all RF the desk BOUGHT x 1.05 (harvested RF has no basis) |
| bid loss-lock | priceUpper <= VWAP of the last ask closed x 0.95, lapsing after 30 days |
| TWAP edge | every range on the correct side of spot and at least 100 ticks (~1%) beyond the observer TWAP |
| shape | at most one ask and one bid open at a time (a second placement reverts RangeOpen) |
| size | each range 1% to 15% of its side's IDLE book at placement; at most 50% of a side opened per rolling day |
| turnover | at most 24 opens + closes per rolling day; any range older than 7 days can be closed by anyone |

The contract can also let an ask sell below its lock out of a small 30-day loss budget.
**The strategy never asks it to.** A maker round trip nets at least 7.59% before gas.

## What the gates cost and what they buy

`node scripts/sweep-regimes.mjs`: 15 synthetic regimes x 4 seeds, 14 days, a $10k book,
the gated desk beside the same desk with the three regime gates switched off. Both obey
every contract rule above, including one ask and one bid at a time.

| | gated | ungated |
|---|---|---|
| median vs hold | +0.00% | -0.14% |
| worst | -6.76% | -42.98% |
| best | +3.81% | +16.94% |
| up / down / flat | 16 / 12 / 32 | 26 / 34 / 0 |

With one range a side at no more than 15% of its idle balance, the desk is small by
construction: it cannot make much, and gated it cannot lose much. Ungated it is still
ruinous in a trend, because it re-quotes every hour and keeps selling RF into a rally
(or buying into a slide) 15% at a time: down to -43% vs hold at +10%/day. The arming rule
keeps it out of both and gives up the chop upside. On the real tape the ungated desk lost
10.11% and the gated desk lost nothing (below).

Would a ladder be materially better? Not on this evidence: the 7-per-side ladder, under
the same contract rules, had a gated best of +9.9% and a worst of -4.8% over the same
60 runs. That is a few points of upside in chop, not a different product, so the
single-range contract stays.

## The backtest, generated

`node scripts/backtest-gated.mjs --write` regenerates the block below from `data/swaps.json`.

```
======================================================================================
RUN 1  -  REAL HISTORY of the RF/WETH pool, maker-only grid, endogenous replay
======================================================================================
tape: 8999 swaps, blocks 64590343 -> 69878361, 6.17 days
price 5.3380e-6 -> 5.8175e-7 WETH (-89.1%)
grid: step 5%, 2 rungs, loss-lock 5%
maker edge per round trip +7.59% before gas; a TAKER grid needs a 10.80% step to break even

  GATED, Hunt's book
    book            3,159 RF + 0.028987 WETH
    hours           148   armed 0 (0.0%)
    range flips     0   refused by contract rules 0   deferred by daily limits 0   gas $0.00
    realisable      0.030733 WETH ($84.09)
    hold            0.030733 WETH ($84.09)
    vs hold         +0.00%
    hours off, by gate (a gate is counted when blocking OR not yet measurable): drift72h 148h, walkForward7d 148h, reversals72h 144h

  GATED, $10k balanced
    book            $5,000 RF + $5,000 WETH at the opening price
    hours           148   armed 0 (0.0%)
    range flips     0   refused by contract rules 0   deferred by daily limits 0   gas $0.00
    realisable      2.016360 WETH ($5516.76)
    hold            2.016360 WETH ($5516.76)
    vs hold         +0.00%
    hours off, by gate (a gate is counted when blocking OR not yet measurable): drift72h 148h, walkForward7d 148h, reversals72h 144h

  COUNTERFACTUAL: same grid, arming rule OFF (risk gates still on)
    book            $10k balanced
    hours           148   armed 148 (100.0%)
    range flips     1   refused by contract rules 1   deferred by daily limits 0   gas $0.56
    realisable      1.812567 WETH ($4959.18)
    hold            2.016360 WETH ($5516.76)
    vs hold         -10.11%

  VERDICT: PASS. The gated desk lost nothing (+0.00%). Ungated it would have been -10.11%:
  the arming rule saved 10.11% of the book.
  Friends' fee stream in the replay: 61.83 WETH gated, 61.84 WETH ungated (takers pay 5% whoever fills them).

======================================================================================
RUN 2  -  SYNTHETIC ranging tape, 14 days. NOT A PREDICTION.
         mean-reverting taker flow around a flat anchor; it answers only whether the
         desk arms when the market swings, and whether it keeps what it earns
======================================================================================
tape: 4032 taker trades, price range 4.830e-7 to 6.607e-7, net -2.8%
  GATED, $10k balanced
    book            $5,000 RF + $5,000 WETH
    hours           336   armed 131 (39.0%)
    range flips     1   refused by contract rules 0   deferred by daily limits 0   gas $0.21
    realisable      3.531197 WETH ($9661.35)
    hold            3.488520 WETH ($9544.59)
    vs hold         +1.22%
    hours off, by gate (a gate is counted when blocking OR not yet measurable): walkForward7d 191h, drift72h 91h, reversals72h 72h

  COUNTERFACTUAL: arming rule OFF
    book            $10k balanced
    hours           336   armed 336 (100.0%)
    range flips     2   refused by contract rules 1   deferred by daily limits 0   gas $0.49
    realisable      3.576570 WETH ($9785.50)
    hold            3.488520 WETH ($9544.59)
    vs hold         +2.52%

  VERDICT: the desk armed after its warm-up and worked the grid (1 flips, +1.22% vs hold).

======================================================================================
RUN 3  -  THE GATES AS OF THE TAPE'S LAST SWAP (block 69878361, 2026-09-22T18:43Z)
         computed from data/swaps.json, not typed in. The live figure is /api/desk.
======================================================================================
status: OFF

gate            state       detail
======================================================================================
reversals72h    blocking    0 completed swings of 5% vs min 6
drift72h        blocking    -18.9% vs max +/-10%
walkForward7d   not yet     not yet measurable: less than 7 days of history
inventory       met         6.0% of book in RF vs max 60%
drawdown        met         0.0% behind its best point vs holding, max 15%
breaker         met         clear
```
