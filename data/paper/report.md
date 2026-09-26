# Paper forward test: the desk on live pools across launchpads

Started 2026-09-26T03:20:00.000Z, report 2026-09-26T17:52:09.519Z, tick 28. No money, no chain writes. Every pool starts with a $1000 book at its start price; fills are counted only when a minute bar crosses the whole range; gas is ignored; the taker on the same schedule pays the pool's fee and no impact (this favours the taker). Programmes: standing = the standing sell order (RF-only book); grid = the two-sided grid at the live gates ($500 + $500); gridLoose = the 2026-09-23 sweep's loosened setting (10% step, trend limit off, 3 swings, no drawdown stop, replay check on), whose in-sample result this is meant to test forward.

- **the swap desk** (the product: swaps pooled funds as a taker, paying the full toll both ways): 22 pools, vs hold median +0.00% (ahead 2, behind 0, no trade yet 20), swaps 5, toll paid $20.70
- **standing**: 22 pools, vs taker on the same schedule median +0.36% (beat 11, lost 4, flat 7), vs hold median +0.00%, fills 23, per unit vs taker median +7.73%
- **grid**: 22 pools, vs taker on the same schedule median +0.00% (beat 6, lost 1, flat 15), vs hold median +0.00%, fills 6, per unit vs taker median +9.14%
- **gridLoose**: 22 pools, vs taker on the same schedule median +0.00% (beat 3, lost 4, flat 15), vs hold median +0.00%, fills 4, per unit vs taker median +11.64%

**Every standing-order fill so far:** 23 fills on 11 pools; per unit vs a taker at placement: median +7.05%, worst +2.87%, best +126.99%, 23 of 23 positive. Filled pools vs a taker on the same schedule: DRILL +1.18%, COPPERINU +2.16%, UNIPCS +1.37%, DUST +3.02%, MARLIN +0.36%, QSTRAT +1.19%, TOOLS +2.71%, Bucket +1.21%, AORB +5.84%, SPACEHOOD +1.00%, EMBER +1.42%.

| pool | launchpad | fee | type | vol 24h | hours | price since start | swap desk vs hold / swaps | standing vs taker / vs hold / fills / open | grid vs taker / vs hold / fills | gridLoose vs taker / vs hold / fills | last swap-desk decision |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| RF | Rare Friends (v4 hook) | 5.00% | A | $8,894 | 13.8 | -0.79% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +3.0% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:03Z wait: RF is -0.5% against its 24h average; the desk trades only past 30.0% either way |
| DRILL | standalone hook (Project Mars) | 5.30% | A | $42,471 | 14.3 | +4.57% | +0.00% / 0 | +1.18% / -0.94% / 1 / ask +1.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:02Z wait: RF is +0.6% against its 24h average; the desk trades only past 30.0% either way |
| COPPERINU | Pons v2 | 5.00% | A | $24,716 | 13.1 | -3.15% | +0.00% / 0 | +2.16% / +1.92% / 2 / ask +12.5% | +0.67% / +0.59% / 1 | -0.00% / -0.00% / 0 | 09-26T16:32Z wait: RF is +3.6% against its 24h average; the desk trades only past 30.0% either way |
| UNIPCS | Pons v2 | 5.00% | A | $25,382 | 14.3 | -19.74% | +0.00% / 0 | +1.37% / +3.75% / 1 / ask +10.2% | -0.00% / -0.00% / 0 | -0.00% / -0.00% / 0 | 09-26T17:15Z wait: RF is -9.4% against its 24h average; the desk trades only past 30.0% either way |
| AA | Pons v2 | 4.00% | A | $16,340 | 14.3 | -43.63% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +10.9% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:05Z wait: RF is 32.4% under its average, but 69.0% down over 72 hours: a collapse, not a dip |
| DUST | Pons v2 | 4.00% | A | $44,796 | 14.5 | -22.63% | +0.00% / 0 | +3.02% / +14.61% / 3 / ask +29.7% | +0.63% / +2.31% / 1 | +2.16% / +0.70% / 2 | 09-26T17:24Z wait: RF is -9.0% against its 24h average; the desk trades only past 30.0% either way |
| MAST | Pons v2 | 4.00% | A | $6 | 10.9 | -0.23% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +2.1% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T16:03Z wait: RF is -6.4% against its 24h average; the desk trades only past 30.0% either way |
| MARLIN | Pons v2 | 4.00% | A | $13,583 | 14.4 | +45.87% | +1.88% / 1 | +0.36% / -4.80% / 1 / ask -17.7% | +0.00% / +0.00% / 0 | +0.70% / -2.37% / 1 | 09-26T17:45Z wait: RF is +16.5% against its 24h average; the desk trades only past 30.0% either way |
| CULT | Pons v2 | 4.00% | A | $2,096 | 10.3 | +2.73% | +0.00% / 0 | -0.00% / -0.00% / 0 / ask -1.0% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T13:03Z wait: RF is +15.7% against its 24h average; the desk trades only past 30.0% either way |
| FUEL | Pons v2 | 6.00% | A | $2,604 | 13.2 | -15.19% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +2.5% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:14Z wait: RF is -11.9% against its 24h average; the desk trades only past 30.0% either way |
| QSTRAT | Pons v2 | 6.00% | A | $9,408 | 14.0 | +9.38% | +0.00% / 0 | +1.19% / -0.80% / 1 / none | +0.71% / -0.33% / 1 | -0.00% / -0.00% / 0 | 09-26T17:05Z wait: RF is +4.2% against its 24h average; the desk trades only past 30.0% either way |
| TOOLS | Pons v2 | 4.00% | A | $12,057 | 13.8 | +21.18% | +0.00% / 0 | +2.71% / -3.60% / 3 / none | +0.64% / -0.12% / 1 | +0.00% / +0.00% / 0 | 09-26T17:09Z wait: RF is +4.5% against its 24h average; the desk trades only past 30.0% either way |
| Index | IndexFeeHook | 3.97% | A | $18,842 | 14.3 | -4.52% | +0.00% / 0 | -0.00% / -0.00% / 0 / ask +4.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:03Z wait: RF is -3.0% against its 24h average; the desk trades only past 30.0% either way |
| DTF | DTFFeeHook | 3.97% | A | $38,138 | 14.5 | -4.74% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +2.7% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:00Z wait: RF is -3.2% against its 24h average; the desk trades only past 30.0% either way |
| Bucket | single-pool hook | 3.97% | A | $18,116 | 14.3 | -5.94% | +0.00% / 0 | +1.21% / -0.01% / 1 / ask +0.5% | +0.67% / +0.08% / 1 | +0.00% / +0.00% / 0 | 09-26T17:05Z wait: RF is -6.6% against its 24h average; the desk trades only past 30.0% either way |
| MONIT | unidentified launch hook 0x7Fc2...4A80 (lpFee 0.3%) | 0.30% | A? | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| AGBT | unidentified launch hook 0xEcdE...4a80 (lpFee 0.3%) | 0.30% | A? | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| MB4U | unidentified launch hook 0xDa3B...Ca80 (lpFee 0.3%) | 0.30% | A? | $2,491,933 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| AORB | unidentified launch hook 0xbE3F...0a80 (lpFee 0.3%) | 0.30% | A? | $14,039,480 | 6.3 | -15.86% | +232.22% / 4 | +5.84% / -9.20% / 5 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T09:13Z buy: RF is 43.1% under its 24h average and not collapsing: buy with 50.0% of the WETH, paying the toll |
| GOOSE | hook 0xb3cA...e8cC, dynamic fee | 0.30% | A? | $10,834,820 | 13.7 | +2.78% | +0.00% / 0 | +0.00% / +0.00% / 0 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:07Z wait: RF is +0.0% against its 24h average; the desk trades only past 30.0% either way |
| SPACEHOOD | Long.xyz (Doppler multicurve) | 0.70% | A | $202,572 | 14.2 | -14.95% | +0.00% / 0 | +1.00% / +6.32% / 2 / ask +10.0% | +0.36% / +1.51% / 1 | +0.00% / +0.00% / 0 | 09-26T17:02Z wait: RF is -12.0% against its 24h average; the desk trades only past 30.0% either way |
| BUTTHOLE | StonkFun reward v1 (Raydium CLMM 4%) | 4.00% | A | $24,963 | 13.9 | -1.84% | +0.00% / 0 | -0.00% / -0.00% / 0 / ask +2.3% | +0.00% / +0.00% / 0 | -0.15% / -0.15% / 0 | 09-26T17:17Z wait: RF is +0.3% against its 24h average; the desk trades only past 30.0% either way |
| SI | StonkFun reward v3 (1% pool + 1% transfer tax) | 2.00% | B | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| MASK | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| ZCAT | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $2,140,230 | 14.3 | -24.80% | +0.00% / 0 | -1.77% / -1.77% / 0 / ask +3.8% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T17:00Z wait: RF is -17.9% against its 24h average; the desk trades only past 30.0% either way |
| EMBER | Ember (Meteora DAMM v2, flagship pool) | 1.00% | A | $583,064 | 14.3 | +12.48% | +0.00% / 0 | +1.42% / -1.06% / 3 / ask +5.5% | +0.00% / +0.00% / 0 | +0.80% / -0.10% / 1 | 09-26T17:00Z wait: RF is +4.3% against its 24h average; the desk trades only past 30.0% either way |
| e/acc | pump.fun (PumpSwap) | 1.25% | A | $58,261,941 | 0.8 | -3.05% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +6.7% (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | 09-26T04:07Z wait: RF is 34.9% over its average, but a sale after both tolls would return less than it cost |
| SpaceX | pump.fun (PumpSwap) | 1.25% | A | $43,562,526 | 0 | n/a | warming up | warming up | warming up | warming up |  |

## Reading it

- The swap desk is the product: every hour it asks lib/strategy.mjs takerDecision whether RF (or the pool's token) is 30% under or over its 24h average, and swaps as a taker, paying the pool's full fee and the impact on its reported depth. It never buys into a collapse (25% down over 72 hours), never holds more than 70% of the book in the token, and never sells below cost after both tolls. Most hours it waits.
- "vs taker on the same schedule" isolates execution: the same decisions, routed as a taker. Positive means resting the order beat swapping. "vs hold" is direction and says nothing about the programme.
- A pool with 0 fills has not been crossed yet; the standing order rests 1.9% to 3.1% above the market, so a quiet hour cannot fill it. Fills need buyers.
- Type B pools tax the maker's deposit; the 2026-09-23 sweep found every maker design loses there, and they are here to show it live.
- The unidentified Robinhood launch hooks are compared against a 0.3% taker fee only, because their hook skim is not known; that understates the edge there.

Decision log: data/paper/log.jsonl (one line per new decision). Bars: data/paper/bars/.
