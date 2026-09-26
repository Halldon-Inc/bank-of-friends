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

## The standing sell order (keeper-only, live when the grid is off)

The grid above earns only on swings, and RF has not swung. What the pool has had every day
is holders converting harvested RF to WETH, each one paying the 5% toll as a taker. The
standing sell order puts that conversion in the ONE ask slot as a **maker** instead: idle RF
rests just past the TWAP edge, an outside buyer crosses it and pays the 5% to every Friend,
and the member sells above the market instead of 5% below it. Measured on the real tape
(`bank-of-friends-notes/2026-09-23/mm-research.md`): a one to two spacing ask past the edge
filled at a median **1.018x to 1.022x** the spot at placement, where a taker receives at most
0.95x, about **+7% per RF sold**. It is `standingOrder` in `lib/strategy.mjs`, translated into
ticks by `lib/desk-plan.mjs`, and it needs no contract change: the contract already accepts
any ask beyond spot, beyond the TWAP edge and above the cost of RF the desk BOUGHT (harvested
RF has no basis, so it is never loss-locked).

| parameter | value | label |
|---|---|---|
| `minBookUsd` | $50 of idle RF, else idle | CHOICE: below this gas eats the edge (the $100/day stream lost 0.3% to gas over 72h) |
| `widthSpacings` | 2 spacings = 1.2% | MEASURED: best fill premium in the sweep (0.6% to 1.2%; 2% was worst in every window) |
| `frac` | 15% of idle RF per placement | CONTRACT: `maxRangeBps` |
| `chase` | re-place once the ask sits more than 2% above the current edge | MEASURED: 2% best or tied; 4% often never filled |
| `brakeDrift24h` | 24h drift over +10%, or a new 72h high | CHOICE: the trend brake, UNMEASURED on real data (the tape has no rally) |
| `releaseDrift24h` | 24h drift back under +3% | CHOICE |
| `takeProfitLo` / `takeProfitHi` | [TWAP x 1.10, TWAP x 2.0] | CHOICE: in a synthetic +5%/day rally the programme is -49% vs hold with the brake and -54% without (`npm run economy`); the brake limits, it does not remove |
| `requoteSeconds` | one re-quote an hour at most | CONTRACT pace: 24 modifies and 50% of a side per rolling day |

**The rules.** Grid armed: the grid owns both slots and this programme steps aside. Otherwise:

1. **Edge.** The ask is `[snapUp(max(spot, TWAP) x 1.0001^100) + one spacing, + two spacings]`,
   15% of idle RF, re-placed on fill. When the market has walked away so the ask sits more
   than 2% above where the edge is now, it is closed and re-placed (at most once an hour).
2. **Brake.** When the 24h drift is over +10% or the price prints a new 72h high, an edge ask
   would sell into the rally, so it is pulled and the slot holds a wide **take-profit** ask
   from TWAP x 1.10 to TWAP x 2.0 instead. Once the price crosses half of that range the ask is
   realised and re-placed from the new TWAP; once the 24h drift is back under +3% it comes
   down and the edge programme resumes.
3. **Idle.** Under $50 of idle RF nothing is placed, and the keeper says why.
4. A brake input the live path cannot measure yet (no 24h or 72h history) is UNMEASURED: the
   edge programme runs, because it is the measured default and the brake is only insurance.

**Why there is no standing bid.** Every bid-on-dips policy measured on the real tape lost:
`bidDip` was -20% to -30% vs hold from Sep 17 and -2.4% from Sep 19, because it bought RF that
kept falling. A bid is a bet that the price comes back; an ask on harvested RF is a conversion
the member wanted anyway, executed better. So bids belong only to the armed grid, where six
completed swings and a flat 72h trend have already been measured, and while the grid is off
the bid slot stays empty and idle WETH is simply held.

**What it gives up.** It sells everyone's idle RF pro rata (a member who wants to keep RF sets
the RF cap to 0 at signup or withdraws it), it sells slowly in a slide (9% to 15% of an RF book
in 72h against 39% for a daily taker DCA), and in a rally the brake is a choice, not a measured
rule. `npm run test:desk` checks every placement it plans against the contract's reverts.

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
tape: 10012 swaps, blocks 64590343 -> 72653604, 9.40 days
price 5.3380e-6 -> 5.9896e-7 WETH (-88.8%)
grid: step 5%, 2 rungs, loss-lock 5%
maker edge per round trip +7.59% before gas; a TAKER grid needs a 10.80% step to break even

  GATED, Hunt's book
    book            3,159 RF + 0.028987 WETH
    hours           226   armed 0 (0.0%)
    range flips     0   refused by contract rules 0   deferred by daily limits 0   gas $0.00
    realisable      0.030784 WETH ($84.23)
    hold            0.030784 WETH ($84.23)
    vs hold         +0.00%
    hours off, by gate (a gate is counted when blocking OR not yet measurable): reversals72h 222h, walkForward7d 219h, drift72h 188h

  GATED, $10k balanced
    book            $5,000 RF + $5,000 WETH at the opening price
    hours           226   armed 0 (0.0%)
    range flips     0   refused by contract rules 0   deferred by daily limits 0   gas $0.00
    realisable      2.021940 WETH ($5532.03)
    hold            2.021940 WETH ($5532.03)
    vs hold         +0.00%
    hours off, by gate (a gate is counted when blocking OR not yet measurable): reversals72h 222h, walkForward7d 219h, drift72h 188h

  COUNTERFACTUAL: same grid, arming rule OFF (risk gates still on)
    book            $10k balanced
    hours           226   armed 226 (100.0%)
    range flips     1   refused by contract rules 1   deferred by daily limits 0   gas $0.63
    realisable      1.836803 WETH ($5025.49)
    hold            2.021940 WETH ($5532.03)
    vs hold         -9.16%

  VERDICT: PASS. The gated desk lost nothing (+0.00%). Ungated it would have been -9.16%:
  the arming rule saved 9.16% of the book.
  Friends' fee stream in the replay: 62.46 WETH gated, 62.48 WETH ungated (takers pay 5% whoever fills them).

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
RUN 3  -  THE GATES AS OF THE TAPE'S LAST SWAP (block 72653604, 2026-09-26T00:23Z)
         computed from data/swaps.json, not typed in. The live figure is /api/desk.
======================================================================================
status: OFF

gate            state       detail
======================================================================================
reversals72h    blocking    0 completed swings of 5% vs min 6
drift72h        met         3.6% vs max +/-10%
walkForward7d   blocking    the grid would have been -6.2% vs holding over the last 7 days
inventory       met         6.1% of book in RF vs max 60%
drawdown        met         0.0% behind its best point vs holding, max 15%
breaker         met         clear
```
