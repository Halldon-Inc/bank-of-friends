# The standing-order economy, measured

Generated 2026-09-26T01:22:48.894Z by `node scripts/economy.mjs --write`. Every number below is printed by that script.

Tape (MEASURED): 10012 swaps, blocks 64590343 to 72653604, 2026-09-16T14:44Z to 2026-09-26T00:23Z, 9.40 days, price -88.8%.
ETH/USD held at $2690 for the RF runs (SNAPSHOT). Gas $0.04 per open or close (CHOICE, repo). Hook fee 5% (MEASURED).

## 0. Instrument checks

- PASS a policy that never quotes returns exactly hold (0 fills, mark difference 0.0e+0 WETH)
- PASS selling the whole RF-only book as a taker at t0 loses -5.10% against the book marked at mid (expected about -5% minus impact)
- PASS the programme fills on a synthetic chop tape (21 fills in 14 days)

## 1. The real tape, replayed endogenously (MEASURED)

The bank's ask is added to the pool and every historical taker intent is replayed through it, so the range absorbs flow and moves the price. Value is marked at the closing mid, gas deducted. "vs taker, same schedule" is a taker that sells the SAME amounts at the moments the programme PLACED each ask that later filled, so the decisions are identical and only the route differs: it isolates execution. "vs sell at once" is selling the whole book as a taker at the start (or each harvest on arrival). "per unit vs taker" is the median over fills of the fill price against what the same amount would have fetched as a taker (toll plus impact), once at the moment the ask was placed (the decision) and once at the moment it finished filling (a hindsight bound: a taker who sold at the exact instant the move ended). On the swap-level RF tape both are positive; on hourly bars the second is distorted, because a bar is replayed as a few large legs that carry the price far past the range in one trade. "toll paid by crossers" is the 5% the buyers who crossed the bank's ask paid to every activated Friend.

### RF-only $1,000 (harvested, no cost basis)

| window | vs hold | vs taker, same schedule | vs sell at once | fills | RF sold | fill / spot at placement | per unit vs taker at placement | per unit vs taker at fill | h to fill | gas | toll paid by crossers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| whole life (9.4 d, price -89%) | +71.29% | +4.23% | -79.75% | 4 | 48% | 1.0276 | +8.2% | +3.9% | 0.7 | $1.75 | $7.13 |
| from Sep 17 (9.0 d, price -60%) | +24.33% | +3.19% | -47.87% | 3 | 39% | 1.0226 | +7.7% | +4.5% | 6.9 | $1.68 | $13.26 |
| from Sep 19 (7.0 d, price -34%) | -0.43% | +1.02% | -30.21% | 1 | 15% | 1.0282 | +8.3% | +4.0% | 27.5 | $0.84 | $5.15 |
| last 7 days (7.0 d, price -33%) | -0.43% | +1.02% | -29.54% | 1 | 15% | 1.0282 | +8.3% | +4.0% | 27.5 | $0.84 | $5.20 |
| last 72h (3.0 d, price +4%) | -0.26% | +1.09% | +9.16% | 1 | 15% | 1.0248 | +7.9% | +4.7% | 1.5 | $0.14 | $8.09 |

### RF stream, $100 a day arriving (harvest arrivals)

| window | vs hold | vs taker, same schedule | vs sell at once | fills | RF sold | fill / spot at placement | per unit vs taker at placement | per unit vs taker at fill | h to fill | gas | toll paid by crossers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| whole life (9.4 d, price -89%) | -0.32% | +0.34% | -20.22% | 1 | 7% | 1.0282 | +8.3% | +3.9% | 27.5 | $1.40 | $2.78 |
| from Sep 17 (9.0 d, price -60%) | +1.41% | +0.51% | -12.84% | 3 | 8% | 1.0259 | +8.0% | +4.6% | 6.9 | $1.75 | $4.35 |
| from Sep 19 (7.0 d, price -34%) | -0.20% | +0.23% | -3.18% | 1 | 5% | 1.0282 | +8.2% | +3.9% | 27.5 | $0.84 | $1.78 |
| last 7 days (7.0 d, price -33%) | -0.24% | +0.27% | -4.22% | 1 | 5% | 1.0282 | +8.2% | +3.9% | 27.5 | $0.84 | $1.79 |
| last 72h (3.0 d, price +4%) | -0.11% | +0.33% | +6.13% | 1 | 5% | 1.0248 | +7.9% | +4.5% | 1.5 | $0.14 | $0.81 |

**Per unit sold, the standing order fetched a median +8.2% more than the taker path at placement, and +4.0% more than a taker selling at the very moment the ask finished filling** (MEASURED over 10 window-and-book runs). Fills land at about 1.02x the spot at placement, where a taker receives at most 0.95x spot before impact (DERIVED: 1.02 / 0.95 = +7.4%).

## 2. Out of sample: 16 other swap-fee pools (MEASURED, hourly bars)

Hourly OHLCV from GeckoTerminal (data/tokens/, fetched 2026-09-23/24), first 24 hours skipped (the launch print). 8 Robinhood Chain v4 hook tokens use the same design as RF (a swap fee of 4% to 5.3% paid by takers, makers pay nothing); 8 StonkFun Solana tokens have a 4% swap fee. Each pool is replayed with its own fee. Hourly bars hide swings inside the hour, and the tape carries only the minimum flow that draws each bar, so fills here are UNDER-counted. RF-only $1,000 book (in each pool's quote token), the same programme, the same taker-on-the-same-schedule comparison. Gas and the toll are shown in USD at each pool's quote price.

| pool | vs hold | vs taker, same schedule | vs sell at once | fills | sold | fill / spot at placement | per unit vs taker at placement | per unit vs taker at fill | h to fill | gas | toll paid by crossers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DRILL (robinhood, fee 5.3%, 14 d, price -79%) | +198.34% | +8.88% | -33.51% | 12 | 84% | 1.0289 | +8.7% | +1.3% | 0.5 | $3.36 | $33.43 |
| COPPERINU (robinhood, fee 5.0%, 25 d, price -78%) | +302.83% | +11.97% | -5.94% | 14 | 90% | 1.0282 | +8.3% | +1.5% | 0.5 | $1.75 | $45.66 |
| UNIPCS (robinhood, fee 5.0%, 17 d, price -87%) | +148.94% | +2.89% | -66.22% | 10 | 80% | 1.0253 | +8.0% | +0.2% | 0.5 | $2.52 | $15.49 |
| AA (robinhood, fee 4.0%, 19 d, price -64%) | +862.58% | +7.23% | +278.10% | 23 | 97% | 1.0276 | +7.4% | -10.5% | 0.5 | $3.01 | $146.00 |
| DUST (robinhood, fee 4.0%, 19 d, price +272%) | +10.84% | +14.91% | +353.84% | 30 | 99% | 1.0279 | +8.0% | -5.2% | 0.5 | $3.92 | $170.22 |
| MOO (robinhood, fee 4.0%, 14 d, price -99%) | +15844.34% | -0.11% | -4.52% | 17 | 93% | 1.0263 | +6.9% | -6.3% | 0.5 | $2.17 | $38.26 |
| MAST (robinhood, fee 4.0%, 26 d, price -99%) | +20078.71% | +3.98% | +170.91% | 23 | 97% | 1.0282 | +7.4% | -5.2% | 0.5 | $2.94 | $105.19 |
| Index (robinhood, fee 4.0%, 82 d, price +17557%) | -94.45% | +16.73% | +930.92% | 59 | 100% | 1.0318 | +7.4% | -1.5% | 1.5 | $10.15 | $404.47 |
| BUTTHOLE (solana, fee 4.0%, 48 d, price -18%) | +145.76% | +2.37% | +111.71% | 25 | 98% | 1.0499 | +9.4% | -2.6% | 0.5 | $3.99 | $83.57 |
| MANLET (solana, fee 4.0%, 48 d, price +46%) | +27.72% | +10.88% | +99.67% | 27 | 99% | 1.0285 | +7.4% | -3.0% | 0.5 | $4.13 | $77.38 |
| FRIES (solana, fee 4.0%, 48 d, price +1%) | -23.33% | +4.24% | -17.71% | 31 | 99% | 1.0278 | +7.1% | -4.2% | 0.5 | $4.34 | $31.95 |
| REDACTED (solana, fee 4.0%, 48 d, price +7%) | +173.71% | +8.78% | +216.50% | 44 | 100% | 1.0394 | +8.3% | -2.5% | 0.5 | $5.39 | $121.85 |
| CLANKER (solana, fee 4.0%, 49 d, price +1443%) | -81.63% | -6.55% | +211.64% | 41 | 100% | 1.0285 | +7.9% | -7.3% | 0.5 | $6.30 | $117.26 |
| UBI (solana, fee 4.0%, 47 d, price -17%) | -16.74% | +21.15% | -26.05% | 30 | 99% | 1.0757 | +12.2% | -11.1% | 0.5 | $4.41 | $28.58 |
| USWR (solana, fee 4.0%, 124 d, price -88%) | +1511.79% | +7.48% | +112.34% | 41 | 100% | 1.0263 | +7.0% | +2.6% | 5.5 | $8.12 | $84.21 |
| DOGE-1 (solana, fee 4.0%, 147 d, price -83%) | +467.84% | +5.04% | +1.53% | 21 | 96% | 1.0256 | +6.9% | +2.7% | 7.5 | $5.81 | $40.18 |

**Summary over 16 pools:** per unit vs taker at placement: median +7.9%, worst +6.9%, best +12.2%; at the moment of fill: median -2.6%, worst -11.1%. Total vs a taker on the same schedule: median +7.48%, worst -6.55%, beat / lost 14 / 2 of 16. Total vs hold: median +173.71%, worst -94.45%, beat / lost 12 / 4 (vs hold is direction: a sell programme beats holding when the token later fell, and trails it when the token kept rising, whatever the execution).

Transfer-tax tokens (type B: the tax is charged on the maker's deposit too) are excluded from the summary above. The 2026-09-23 sweep found every maker design loses on them; a bank would refuse such a pool.

## 3. Synthetic regimes (SYNTHETIC: the sign per regime, never a forecast)

14 days, hourly steps, 3 seeds, RF-only $1,000. Chop: sigma 3% an hour pulled back to a flat anchor (pull 0.22). Slide: -5% a day. Rally: +5% a day. The trend brake (a +10% day or a new 72h high switches the slot to a take-profit range at 1.10x to 2.0x the TWAP) is shown on and off.

| regime | vs hold, median | vs hold, worst | vs taker same schedule, median | fills, median | per unit vs taker at placement | per unit vs taker at fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chop, brake on | -4.76% | -12.15% | +5.76% | 20 | +8.3% | +3.2% |
| chop, brake off | -3.73% | -10.66% | +6.02% | 20 | +8.4% | +3.0% |
| slide -5%/day, brake on | +25.15% | +2.01% | +5.84% | 16 | +8.2% | +3.6% |
| slide -5%/day, brake off | +29.85% | +2.66% | +6.13% | 16 | +8.1% | +3.7% |
| rally +5%/day, brake on | -49.00% | -57.14% | +6.32% | 20 | +8.1% | +3.6% |
| rally +5%/day, brake off | -54.25% | -61.77% | +6.38% | 24 | +8.1% | +3.4% |

Reading: per unit and against the same decisions as a taker, the programme is ahead in every regime. Against HOLDING the result is the market's direction: in chop it is noise around zero (which way the tape happened to end), in a slide selling early wins by construction, and in a rally a sell programme trails holding, with the brake limiting that (compare the two rally rows). None of this is a forecast of RF.

## 4. How much RF conversion demand exists (MEASURED, a proxy)

The tape's sell share: the RF that holders pushed into the pool, by day, against the WETH they bought RF with. This is a proxy for conversion demand (a seller's wallet is not identified, so the share of CLAIMED rewards that was sold is UNMEASURED).

| day (UTC) | swaps | bought, WETH | sold, WETH | RF sold | sell share |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-09-16 | 3526 | 405.27 | 545.14 | 195.62M | 57% |
| 2026-09-17 | 4139 | 83.10 | 78.16 | 63.17M | 48% |
| 2026-09-18 | 400 | 14.69 | 55.83 | 48.39M | 79% |
| 2026-09-19 | 337 | 9.19 | 20.10 | 25.23M | 69% |
| 2026-09-20 | 210 | 2.05 | 6.74 | 9.19M | 77% |
| 2026-09-21 | 142 | 1.04 | 13.36 | 21.00M | 93% |
| 2026-09-22 | 279 | 1.79 | 1.20 | 2.08M | 40% |
| 2026-09-23 | 166 | 4.16 | 2.08 | 3.43M | 33% |
| 2026-09-24 | 318 | 1.74 | 0.73 | 1.23M | 30% |
| 2026-09-25 | 494 | 1.08 | 1.77 | 2.92M | 62% |
| 2026-09-26 | 1 | 0.00 | 0.01 | 0.01M | 100% |

Over the tape, 372.3M RF was sold into the pool (58% of gross volume by WETH). The protocol's RF stream this week is 85.4M RF (MEASURED, /api/desk streamRfPerWeek). Every unit of that sell flow that goes through a taker swap pays 5% and eats impact; the standing order is the same flow, resting instead.

## 5. The scale model (DERIVED from live inputs)

Inputs (MEASURED, /api/desk at 2026-09-26T01:21:47.921Z): RF stream 85.40M RF a week, WETH stream 29.55 WETH a week, total weight 1036.3M, RF $0.001611, ETH $2690, 24h volume 2.71 WETH. Per-unit edge used: the real-tape median above, +8.2% (not an assumed 7%).

| Genesis members | share s of weight | RF flow a week through the bank | gained vs taker path a week | WETH crossed by takers if it all fills | 5% those takers pay to all Friends | members' rebate (s x toll) | members' own WETH stream a week |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.19% | 0.16M RF ($265.59) | $21.90 | 0.099 WETH | 0.0049 WETH ($13.28) | 0.00001 WETH ($0.03) | 0.057 WETH ($153.44) |
| 10 | 1.93% | 1.65M RF ($2655.94) | $218.97 | 0.987 WETH | 0.0494 WETH ($132.80) | 0.00095 WETH ($2.56) | 0.570 WETH ($1534.41) |
| 50 | 9.65% | 8.24M RF ($13279.72) | $1094.87 | 4.936 WETH | 0.2468 WETH ($663.99) | 0.02382 WETH ($64.07) | 2.852 WETH ($7672.05) |
| 200 | 38.60% | 32.96M RF ($53118.87) | $4379.50 | 19.743 WETH | 0.9872 WETH ($2655.94) | 0.38105 WETH ($1025.20) | 11.406 WETH ($30688.19) |

At 50 Genesis the bank routes about 8.2M RF a week; the whole pool traded 2.7 WETH in the last 24 hours, so a programme of that size would be most of the pool's depth near the price. UNMEASURED: whether resting depth draws more buyers (elasticity), and how fills are shared if other makers appear.

**The Genesis line (MEASURED thresholds, /api/desk):** Reserve floor $1371.35 (900,000 RF sold through the pool), convert below $1330.21, max bid $1130.31. The desk is idle whenever the market is above the max bid. Each conversion is 900,000 RF ($1450.33) of pool volume paying about $72.18 to every activated Friend, and each activation spends 100,000 RF ($161.15: half burned, half to the RF reward stream).

## 6. What this does not show

- The real tape is 9.5 days of one launch that fell about 89%. It says nothing about a mature RF market.
- The programme's parameters were chosen on the 2026-09-23 sweep of this same tape, so section 1 is in-sample. Section 2 is the out-of-sample check, and its bars are hourly (fills under-counted) with fees of 4% to 5.3%, not 5%.
- The engine assumes no other makers. Only 7 liquidity events exist in the pool's life; if other range-order makers appear, fills get rarer.
- ETH/USD is held constant; the TWAP is a one-hour proxy, not the on-chain truncated observer; gas is the repo's $0.07-per-flip choice.
- Synthetic tapes show the sign of the programme per regime and nothing else.
- "vs hold" is a directional result: a sell programme wins against holding when the asset later falls and loses when it keeps rising. Whether to convert at all is the member's instruction (RF left in the Friend's wallet, or withdrawn, is never offered); the bank's claim is only that the conversion executes better than any taker route.
- The bank's contract is not deployed, so no fill here has happened.

