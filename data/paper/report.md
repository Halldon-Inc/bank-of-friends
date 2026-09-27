# Paper forward test: the desk on live pools across launchpads

Started 2026-09-26T03:20:00.000Z, report 2026-09-27T16:03:28.200Z, tick 68. No money, no chain writes. Every pool starts with a $1000 book at its start price; fills are counted only when a minute bar crosses the whole range; gas is ignored; the taker on the same schedule pays the pool's fee and no impact (this favours the taker). Programmes: standing = the standing sell order (RF-only book); grid = the two-sided grid at the live gates ($500 + $500); gridLoose = the 2026-09-23 sweep's loosened setting (10% step, trend limit off, 3 swings, no drawdown stop, replay check on), whose in-sample result this is meant to test forward.

- **the swap desk** (the product: swaps pooled funds as a taker, paying the full toll both ways): 22 pools, vs hold median +0.00% (ahead 2, behind 1, no trade yet 19), swaps 16, toll paid $55.08
- **standing**: 22 pools, vs taker on the same schedule median +1.67% (beat 17, lost 3, flat 2), vs hold median +0.00%, fills 56, per unit vs taker median +6.88%
- **grid**: 22 pools, vs taker on the same schedule median +0.00% (beat 10, lost 0, flat 12), vs hold median +0.00%, fills 12, per unit vs taker median +8.22%
- **gridLoose**: 22 pools, vs taker on the same schedule median +0.00% (beat 11, lost 1, flat 10), vs hold median +0.00%, fills 16, per unit vs taker median +11.93%

**Every standing-order fill so far:** 56 fills on 15 pools; per unit vs a taker at placement: median +6.86%, worst +2.87%, best +126.99%, 56 of 56 positive. Filled pools vs a taker on the same schedule: DRILL +1.41%, COPPERINU +3.03%, UNIPCS +2.45%, AA +0.78%, DUST +3.76%, MARLIN +4.61%, QSTRAT +2.10%, TOOLS +3.39%, DTF +1.09%, Bucket +3.17%, AORB +5.84%, SPACEHOOD +1.67%, BUTTHOLE +2.44%, ZCAT -1.84%, EMBER +2.33%.

| pool | launchpad | fee | type | vol 24h | hours | price since start | swap desk vs hold / swaps | standing vs taker / vs hold / fills / open | grid vs taker / vs hold / fills | gridLoose vs taker / vs hold / fills | last swap-desk decision |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| RF | Rare Friends (v4 hook) | 5.00% | A | $20,539 | 35.9 | -10.64% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +2.0% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:00Z wait: RF is -5.4% against its 24h average; the desk trades only past 30.0% either way |
| DRILL | standalone hook (Project Mars) | 5.30% | A | $14,294 | 36.0 | -15.22% | +0.00% / 0 | +1.41% / +2.34% / 1 / ask +5.6% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:01Z wait: RF is -11.0% against its 24h average; the desk trades only past 30.0% either way |
| COPPERINU | Pons v2 | 5.00% | A | $12,211 | 36.1 | -6.11% | +0.00% / 0 | +3.03% / +2.44% / 3 / ask -0.7% | +0.68% / +0.82% / 1 | +0.00% / +0.00% / 0 | 09-27T15:39Z wait: RF is -1.9% against its 24h average; the desk trades only past 30.0% either way |
| UNIPCS | Pons v2 | 5.00% | A | $11,146 | 36.2 | -25.10% | +0.00% / 0 | +2.45% / +5.07% / 2 / ask +2.9% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:39Z wait: RF is -6.2% against its 24h average; the desk trades only past 30.0% either way |
| AA | Pons v2 | 4.00% | A | $28,660 | 36.5 | +58.02% | -8.81% / 10 | +0.78% / -27.45% / 4 / ask +11.0% | +0.00% / +0.00% / 0 | +2.65% / -5.19% / 4 | 09-27T15:30Z wait: RF is +20.2% against its 24h average; the desk trades only past 30.0% either way |
| DUST | Pons v2 | 4.00% | A | $31,579 | 36.6 | -29.46% | +0.00% / 0 | +3.76% / +22.02% / 4 / ask +18.8% | +0.65% / +3.00% / 1 | +2.13% / +0.66% / 2 | 09-27T15:16Z wait: RF is -8.7% against its 24h average; the desk trades only past 30.0% either way |
| MAST | Pons v2 | 4.00% | A | $8 | 21.1 | -0.43% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +2.4% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T02:51Z wait: RF is -5.7% against its 24h average; the desk trades only past 30.0% either way |
| MARLIN | Pons v2 | 4.00% | A | $14,041 | 34.1 | +8.96% | +18.05% / 2 | +4.61% / +1.96% / 2 / ask +1.9% | +0.60% / +0.25% / 1 | +3.33% / +0.57% / 3 | 09-27T13:24Z wait: RF is -8.7% against its 24h average; the desk trades only past 30.0% either way |
| CULT | Pons v2 | 4.00% | A | $1,600 | 33.9 | +6.83% | +0.00% / 0 | -0.04% / -0.04% / 0 / ask -4.8% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T13:20Z wait: RF is +10.3% against its 24h average; the desk trades only past 30.0% either way |
| FUEL | Pons v2 | 6.00% | A | $4,050 | 35.6 | -32.15% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +3.9% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:06Z wait: RF is -17.0% against its 24h average; the desk trades only past 30.0% either way |
| QSTRAT | Pons v2 | 6.00% | A | $5,015 | 36.4 | +24.79% | +0.00% / 0 | +2.10% / -3.59% / 2 / ask -0.1% | +1.52% / -1.63% / 2 | +1.17% / -0.16% / 1 | 09-27T15:12Z wait: RF is +5.4% against its 24h average; the desk trades only past 30.0% either way |
| TOOLS | Pons v2 | 4.00% | A | $15,889 | 36.5 | +18.29% | +0.00% / 0 | +3.39% / -2.32% / 4 / ask -0.3% | +0.65% / +0.08% / 1 | +1.00% / +0.90% / 1 | 09-27T15:17Z wait: RF is -8.4% against its 24h average; the desk trades only past 30.0% either way |
| Index | IndexFeeHook | 3.97% | A | $34,432 | 35.5 | -8.43% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +1.2% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T14:00Z wait: RF is -2.9% against its 24h average; the desk trades only past 30.0% either way |
| DTF | DTFFeeHook | 3.97% | A | $36,581 | 36.6 | -7.27% | +0.00% / 0 | +1.09% / +0.92% / 1 / ask +2.4% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:01Z wait: RF is -3.2% against its 24h average; the desk trades only past 30.0% either way |
| Bucket | single-pool hook | 3.97% | A | $13,226 | 36.3 | +31.98% | +0.00% / 0 | +3.17% / -14.08% / 5 / ask -1.6% | +1.50% / -4.50% / 3 | +1.40% / -2.19% / 2 | 09-27T15:12Z wait: RF is +11.7% against its 24h average; the desk trades only past 30.0% either way |
| MONIT | unidentified launch hook 0x7Fc2...4A80 (lpFee 0.3%) | 0.30% | A? | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| AGBT | unidentified launch hook 0xEcdE...4a80 (lpFee 0.3%) | 0.30% | A? | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| MB4U | unidentified launch hook 0xDa3B...Ca80 (lpFee 0.3%) | 0.30% | A? | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| AORB | unidentified launch hook 0xbE3F...0a80 (lpFee 0.3%) | 0.30% | A? | $0 | 6.3 | -15.86% | +232.22% / 4 | +5.84% / -9.20% / 5 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T09:13Z buy: RF is 43.1% under its 24h average and not collapsing: buy with 50.0% of the WETH, paying the toll |
| GOOSE | hook 0xb3cA...e8cC, dynamic fee | 0.30% | A? | $13,740,541 | 36.0 | +2.78% | +0.00% / 0 | +0.00% / +0.00% / 0 / ask +4.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-27T15:00Z wait: RF is +0.9% against its 24h average; the desk trades only past 30.0% either way |
| SPACEHOOD | Long.xyz (Doppler multicurve) | 0.70% | A | $158,280 | 36.5 | -24.22% | +0.00% / 0 | +1.67% / +12.78% / 4 / ask +8.2% | +0.37% / +2.38% / 1 | -0.00% / -0.00% / 0 | 09-27T15:03Z wait: RF is -5.7% against its 24h average; the desk trades only past 30.0% either way |
| BUTTHOLE | StonkFun reward v1 (Raydium CLMM 4%) | 4.00% | A | $27,917 | 35.8 | -1.44% | +0.00% / 0 | +2.44% / -2.66% / 3 / ask +16.9% | +0.58% / +0.37% / 1 | +0.71% / -0.13% / 1 | 09-27T15:18Z wait: RF is +6.1% against its 24h average; the desk trades only past 30.0% either way |
| SI | StonkFun reward v3 (1% pool + 1% transfer tax) | 2.00% | B | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| MASK | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |
| ZCAT | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $1,681,967 | 36.7 | -10.17% | +0.00% / 0 | -1.84% / -15.81% / 10 / ask +10.5% | +0.67% / -0.78% / 1 | +0.82% / -0.63% / 1 | 09-27T16:00Z wait: RF is +6.6% against its 24h average; the desk trades only past 30.0% either way |
| EMBER | Ember (Meteora DAMM v2, flagship pool) | 1.00% | A | $313,909 | 36.7 | +6.56% | +0.00% / 0 | +2.33% / +1.68% / 6 / ask +4.2% | +0.00% / +0.00% / 0 | +0.82% / +0.32% / 1 | 09-27T16:00Z wait: RF is -2.9% against its 24h average; the desk trades only past 30.0% either way |
| e/acc | pump.fun (PumpSwap) | 1.25% | A | $0 | 0.8 | -3.05% | +0.00% / 0 | -0.00% / -0.00% / 0 / ask +6.7% (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | 09-26T04:07Z wait: RF is 34.9% over its average, but a sale after both tolls would return less than it cost |
| SpaceX | pump.fun (PumpSwap) | 1.25% | A | $0 | 0 | n/a | warming up | warming up | warming up | warming up |  |

## Reading it

- The swap desk is the product: every hour it asks lib/strategy.mjs takerDecision whether RF (or the pool's token) is 30% under or over its 24h average, and swaps as a taker, paying the pool's full fee and the impact on its reported depth. It never buys into a collapse (25% down over 72 hours), never holds more than 70% of the book in the token, and never sells below cost after both tolls. Most hours it waits.
- "vs taker on the same schedule" isolates execution: the same decisions, routed as a taker. Positive means resting the order beat swapping. "vs hold" is direction and says nothing about the programme.
- A pool with 0 fills has not been crossed yet; the standing order rests 1.9% to 3.1% above the market, so a quiet hour cannot fill it. Fills need buyers.
- Type B pools tax the maker's deposit; the 2026-09-23 sweep found every maker design loses there, and they are here to show it live.
- The unidentified Robinhood launch hooks are compared against a 0.3% taker fee only, because their hook skim is not known; that understates the edge there.

Decision log: data/paper/log.jsonl (one line per new decision). Bars: data/paper/bars/.
