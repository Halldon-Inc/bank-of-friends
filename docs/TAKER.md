# The taker desk: pooled funds swapped through the pool, paying the full toll both ways

Generated 2026-09-26T17:32:04.735Z by `node scripts/taker.mjs --write`. Every number is printed by that script.
Engine: endogenous replay (the bank's own swaps move the price it trades at), value at liquidation, gas $0.033 a swap, $10,000 book half RF half WETH. 252 strategy settings. Membership share s is the members' share of all reward weight, and so the share of the bank's own toll that streams back to them (one Genesis is 0.19%).

## 1. RF, the real tape (10012 swaps, 9.4 days, price -88.78%)

| membership share s | settings that beat holding | best | median | worst | best setting |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0.2% | 38 of 252 | +28.97% | -38.08% | -62.83% | band d10 f25 m0 tr25 cap70 sl30 (1 swaps) |
| 10.0% | 38 of 252 | +29.17% | -36.45% | -62.39% | band d10 f25 m0 tr25 cap70 sl30 (1 swaps) |
| 50.0% | 42 of 252 | +29.98% | -33.40% | -60.58% | band d10 f25 m0 tr25 cap70 sl30 (1 swaps) |
| 90.0% | 48 of 252 | +30.79% | -27.04% | -58.77% | band d10 f25 m0 tr25 cap70 sl30 (1 swaps) |

vs holding, with the rebate still owed counted at face. A setting that never traded is left out (it equals holding).

## 2. Out of sample: the 16 swap-fee pools, chosen on the first half of each pool, tested on the second half

*Selection rule: the best median across the 16 first halves.*
**Rebate s = 0% (the real case on these pools: their toll does not come back).** Best on the first halves: band d30 f25 m10, median +55.18% vs hold in sample. On the second halves: median +4.10%, 25th percentile -45.39%, beat holding on 9 of 16, worst -96.65%, best +177.37%.

*Selection rule: the best median across the 16 first halves.*
**Rebate s = 50% (what-if: the RF structure, where the toll streams back to members).** Best on the first halves: band d30 f25 m10, median +58.92% vs hold in sample. On the second halves: median +7.94%, 25th percentile -37.64%, beat holding on 9 of 16, worst -94.67%, best +193.92%.

*Selection rule: the best median across the 16 first halves.*
**Rebate s = 90% (what-if: the RF structure, where the toll streams back to members).** Best on the first halves: band d30 f25 m0, median +73.26% vs hold in sample. On the second halves: median +12.35%, 25th percentile -25.96%, beat holding on 10 of 16, worst -93.08%, best +202.58%.

*Selection rule: the best 25th percentile across the 16 first halves.*
**Rebate s = 0% (the real case on these pools: their toll does not come back).** Best on the first halves: band d30 f50 m0 tr25 cap70, 25th percentile +7.71% vs hold in sample. On the second halves: median -0.57%, 25th percentile -29.52%, beat holding on 7 of 16, worst -77.28%, best +91.10%.

| pool | fee | second half: vs hold | vs start | holding vs start | swaps | toll paid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DRILL | 5.3% | +58.87% | +23.49% | -22.27% | 4 | $379 |
| COPPERINU | 5.0% | +5.86% | +10.47% | +4.35% | 3 | $253 |
| UNIPCS | 5.0% | +22.95% | +9.36% | -11.06% | 1 | $175 |
| AA | 4.0% | +14.96% | -22.93% | -32.96% | 4 | $465 |
| DUST | 4.0% | +8.51% | +35.48% | +24.86% | 25 | $749 |
| MOO | 4.0% | -34.73% | -66.07% | -48.01% | 8 | $705 |
| MAST | 4.0% | -35.02% | -63.99% | -44.59% | 8 | $705 |
| Index | 4.0% | -29.52% | +19.65% | +69.77% | 16 | $277 |
| BUTTHOLE | 4.0% | +91.10% | +42.06% | -25.66% | 21 | $1109 |
| MANLET | 4.0% | +45.32% | +36.46% | -6.10% | 23 | $325 |
| FRIES | 4.0% | -12.10% | +17.44% | +33.60% | 48 | $1552 |
| REDACTED | 4.0% | -77.28% | -88.19% | -48.03% | 3 | $175 |
| CLANKER | 4.0% | -0.57% | +174.54% | +176.10% | 50 | $3384 |
| UBI | 4.0% | -14.18% | -0.50% | +15.94% | 45 | $3517 |
| USWR | 4.0% | -43.78% | -70.70% | -47.88% | 2 | $150 |
| DOGE-1 | 4.0% | -24.33% | -39.40% | -19.92% | 13 | $808 |

*Selection rule: the best 25th percentile across the 16 first halves.*
**Rebate s = 50% (what-if: the RF structure, where the toll streams back to members).** Best on the first halves: band d30 f50 m0 tr25 cap70, 25th percentile +14.01% vs hold in sample. On the second halves: median +6.17%, 25th percentile -27.81%, beat holding on 9 of 16, worst -75.55%, best +98.81%.

*Selection rule: the best 25th percentile across the 16 first halves.*
**Rebate s = 90% (what-if: the RF structure, where the toll streams back to members).** Best on the first halves: band d30 f50 m0 tr25 cap70, 25th percentile +19.04% vs hold in sample. On the second halves: median +11.55%, 25th percentile -22.27%, beat holding on 9 of 16, worst -74.16%, best +104.98%.

| pool | fee | second half: vs hold | vs start | holding vs start | swaps | toll paid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DRILL | 5.3% | +63.41% | +23.90% | -22.27% | 4 | $379 |
| COPPERINU | 5.0% | +8.17% | +11.97% | +4.35% | 3 | $253 |
| UNIPCS | 5.0% | +24.89% | +9.93% | -11.06% | 1 | $175 |
| AA | 4.0% | +21.74% | -20.77% | -32.96% | 4 | $465 |
| DUST | 4.0% | +14.49% | +37.61% | +24.86% | 25 | $749 |
| MOO | 4.0% | -22.27% | -65.09% | -48.01% | 8 | $705 |
| MAST | 4.0% | -22.48% | -57.05% | -44.59% | 8 | $705 |
| Index | 4.0% | -28.02% | +22.20% | +69.77% | 16 | $277 |
| BUTTHOLE | 4.0% | +104.98% | +52.38% | -25.66% | 21 | $1109 |
| MANLET | 4.0% | +48.65% | +39.58% | -6.10% | 23 | $325 |
| FRIES | 4.0% | -0.63% | +27.03% | +33.60% | 48 | $1552 |
| REDACTED | 4.0% | -74.16% | -86.57% | -48.03% | 3 | $175 |
| CLANKER | 4.0% | +11.55% | +200.43% | +176.10% | 50 | $3384 |
| UBI | 4.0% | +15.94% | +27.30% | +15.94% | 45 | $3517 |
| USWR | 4.0% | -41.11% | -69.30% | -47.88% | 2 | $150 |
| DOGE-1 | 4.0% | -14.69% | -31.68% | -19.92% | 13 | $808 |

## 3. Synthetic regimes (SYNTHETIC: the sign per regime, never a forecast)

14 days, RF's real pool depth, 3 seeds. "4x volume chop" doubles the swing size of normal chop, which is what four times the two-way flow does to a pool of this depth.

The strategy is the one section 2 picked on the first halves by the worst-case-aware rule (25th percentile) at each rebate level, not one tuned on RF.

| regime | s | setting | median vs hold | median vs start | holding vs start | swaps |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| chop | 0% | band d30 f50 m0 tr25 cap70 | +0.00% | +3.71% | +3.71% | 0 |
| chop | 50% | band d30 f50 m0 tr25 cap70 | +0.00% | +3.71% | +3.71% | 0 |
| chop | 90% | band d30 f50 m0 tr25 cap70 | +0.00% | +3.71% | +3.71% | 0 |
| 4x volume chop | 0% | band d30 f50 m0 tr25 cap70 | +0.00% | +7.70% | +7.70% | 0 |
| 4x volume chop | 50% | band d30 f50 m0 tr25 cap70 | +0.00% | +7.70% | +7.70% | 0 |
| 4x volume chop | 90% | band d30 f50 m0 tr25 cap70 | +0.00% | +7.70% | +7.70% | 0 |
| slide -5%/day | 0% | band d30 f50 m0 tr25 cap70 | +61.86% | +24.16% | -23.29% | 7 |
| slide -5%/day | 50% | band d30 f50 m0 tr25 cap70 | +64.34% | +26.06% | -23.29% | 7 |
| slide -5%/day | 90% | band d30 f50 m0 tr25 cap70 | +66.32% | +27.58% | -23.29% | 7 |
| rally +5%/day | 0% | band d30 f50 m0 tr25 cap70 | -15.04% | +29.19% | +52.06% | 10 |
| rally +5%/day | 50% | band d30 f50 m0 tr25 cap70 | -13.70% | +31.22% | +52.06% | 10 |
| rally +5%/day | 90% | band d30 f50 m0 tr25 cap70 | -12.63% | +32.84% | +52.06% | 10 |

And the same out-of-sample pick on RF's real tape:

| s | setting | vs hold | vs start | holding vs start | swaps |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0% | band d30 f50 m0 tr25 cap70 | -35.14% | -63.10% | -43.11% | 1 |
| 50% | band d30 f50 m0 tr25 cap70 | -34.01% | -62.88% | -43.11% | 1 |
| 90% | band d30 f50 m0 tr25 cap70 | -33.10% | -62.70% | -43.11% | 1 |

## 3b. The shipped desk

The desk the site and the keeper run is lib/strategy.mjs `takerDecision` with `TAKER` (band 30%, half the idle side a trade, no buying 25% down over 72h, RF capped at 70% of the book, sells only above cost after both tolls). Instrument check: it reproduces the grid entry it was selected as on all 32 pool-and-rebate runs: PASS.

| test | s | vs hold median | beat hold | 25th percentile | worst | best |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 pools, second halves (out of sample) | 0% | -0.57% | 7 of 16 | -29.52% | -77.28% | +91.10% |
| 16 pools, second halves (out of sample) | 50% | +6.17% | 9 of 16 | -27.81% | -75.55% | +98.81% |
| 16 pools, second halves (out of sample) | 90% | +11.55% | 9 of 16 | -22.27% | -74.16% | +104.98% |
| 16 pools, whole history (in sample for the first half) | 0% | +0.46% | 9 of 16 | -25.19% | -95.84% | +302.73% |
| 16 pools, whole history (in sample for the first half) | 50% | +11.29% | 9 of 16 | -15.62% | -95.71% | +313.92% |
| 16 pools, whole history (in sample for the first half) | 90% | +17.04% | 10 of 16 | -10.19% | -95.60% | +322.87% |
| RF, from launch | 0.2% | -35.13% | 1 swaps | | | |
| RF, from launch | 50.0% | -34.01% | 1 swaps | | | |
| RF, from launch | 90.0% | -33.10% | 1 swaps | | | |
| RF, after its first 24 hours (as the pools are run) | 0.2% | +0.00% | 0 swaps | | | |
| RF, after its first 24 hours (as the pools are run) | 50.0% | +0.00% | 0 swaps | | | |
| RF, after its first 24 hours (as the pools are run) | 90.0% | +0.00% | 0 swaps | | | |

## 4. The break-even arithmetic (DERIVED)

A round trip of V WETH pays 0.05 V on the way in and 5% of the proceeds on the way out, 0.0975 V in all, and members get back s of it. The swing a round trip must capture before impact and gas:

| membership share s | toll cost to members per round trip | break-even swing |
| ---: | ---: | ---: |
| 0.2% | 9.73% | 10.78% |
| 10.0% | 8.78% | 9.62% |
| 25.0% | 7.31% | 7.89% |
| 50.0% | 4.88% | 5.12% |
| 75.0% | 2.44% | 2.50% |
| 90.0% | 0.97% | 0.98% |
| 100.0% | 0.00% | 0.00% |

## 5. What this does not show

- RF's tape is 9.4 days of a launch that fell about 89%; the 16 pools are young, correlated launches on hourly bars.
- The rebate assumes every member's Friend is activated and the protocol keeps routing the toll to the ActivationManager (one owner key can change that).
- The same settings were searched on the same RF tape; section 2 is the only out-of-sample result.
- Nothing here is deployed; the bank's contract today has no swap path at all, and adding one is a contract change and an audit.
