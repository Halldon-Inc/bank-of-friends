# The paper forward test (live, no money)

`node scripts/paper.mjs --loop 900` has run since 2026-09-26 03:20Z against live pools on every launchpad we could reach: Rare Friends itself, 14 Robinhood Chain v4 hook pools at 4% to 6% (Pons v2, Project Mars, the Index hooks), the busiest fresh Robinhood launches, Long.xyz, StonkFun, Ember and pump.fun (`data/paper/universe.json`). Every 15 minutes it pulls minute bars from GeckoTerminal and replays the desk's own decision functions (`lib/strategy.mjs`) from the start: the standing sell order, the two-sided grid at the live gates, and the grid at the loosened setting the 2026-09-23 sweep picked in sample.

It is conservative on purpose:

- a resting order fills only when a minute bar crosses its WHOLE range; partial fills do not count;
- a bar whose wick is more than 3x from the previous close is treated as a one-trade spike and cannot fill anything;
- a pool whose price jumps more than 5x in one minute is marked drained and its replay stops there (e/acc on pump.fun, 07:01Z);
- the taker it is compared with pays the pool's fee and NO price impact, which flatters the taker;
- gas is ignored (a range order on these chains costs cents).

Every decision is appended to `data/paper/log.jsonl`. `data/paper/report.md` is rewritten every tick; the snapshot below is dated.

---

# Paper forward test: the desk on live pools across launchpads

Started 2026-09-26T03:20:00.000Z, report 2026-09-26T14:08:05.218Z, tick 12. No money, no chain writes. Every pool starts with a $1000 book at its start price; fills are counted only when a minute bar crosses the whole range; gas is ignored; the taker on the same schedule pays the pool's fee and no impact (this favours the taker). Programmes: standing = the standing sell order (RF-only book); grid = the two-sided grid at the live gates ($500 + $500); gridLoose = the 2026-09-23 sweep's loosened setting (10% step, trend limit off, 3 swings, no drawdown stop, replay check on), whose in-sample result this is meant to test forward.

- **standing**: 21 pools, vs taker on the same schedule median +0.00% (beat 9, lost 5, flat 7), vs hold median +0.00%, fills 15, per unit vs taker median +7.73%
- **grid**: 21 pools, vs taker on the same schedule median +0.00% (beat 3, lost 0, flat 18), vs hold median +0.00%, fills 3, per unit vs taker median +7.84%
- **gridLoose**: 21 pools, vs taker on the same schedule median +0.00% (beat 3, lost 0, flat 18), vs hold median +0.00%, fills 2, per unit vs taker median +11.64%

**Every standing-order fill so far:** 15 fills on 8 pools; per unit vs a taker at placement: median +6.88%, worst +2.87%, best +126.99%, 15 of 15 positive. Filled pools vs a taker on the same schedule: COPPERINU +1.12%, UNIPCS +1.21%, DUST +1.83%, MARLIN +0.67%, TOOLS +2.04%, AORB +5.84%, SPACEHOOD +0.88%, EMBER +0.52%.

| pool | launchpad | fee | type | vol 24h | hours | price since start | standing vs taker / vs hold / fills / open | grid vs taker / vs hold / fills | gridLoose vs taker / vs hold / fills | last standing decision |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| RF | Rare Friends (v4 hook) | 5.00% | A | $7,602 | 10.1 | -0.36% | +0.00% / +0.00% / 0 / ask +2.6% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T03:54Z place: Resting 15.0% of the bank's RF for sale 2.2% above the market; the buyer who takes it pays 5% to every Friend. |
| DRILL | standalone hook (Project Mars) | 5.30% | A | $39,154 | 10.0 | -6.51% | +0.00% / +0.00% / 0 / ask +4.2% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T06:42Z place: Resting 15.0% of the bank's RF for sale 2.5% above the market; the buyer who takes it pays the pool's 5.30% fee. |
| COPPERINU | Pons v2 | 5.00% | A | $9,941 | 10.5 | +0.32% | +1.12% / +0.44% / 1 / ask +2.9% | +0.66% / +0.32% / 1 | +0.00% / +0.00% / 0 | 09-26T12:31Z place: Resting 15.0% of the bank's RF for sale 1.8% above the market; the buyer who takes it pays the pool's 5.00% fee. |
| UNIPCS | Pons v2 | 5.00% | A | $13,125 | 10.5 | -7.34% | +1.21% / +1.24% / 1 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T13:01Z close: chase: the market walked away |
| AA | Pons v2 | 4.00% | A | $10,580 | 10.6 | -45.99% | +0.00% / +0.00% / 0 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T14:00Z close: rally over, back to the edge |
| DUST | Pons v2 | 4.00% | A | $45,457 | 10.7 | +4.26% | +1.83% / +1.30% / 2 / ask +4.0% | +0.56% / +0.03% / 1 | +0.74% / +0.21% / 1 | 09-26T12:13Z place: Resting 15.0% of the bank's RF for sale 3.8% above the market; the buyer who takes it pays the pool's 4.00% fee. |
| MAST | Pons v2 | 4.00% | A | $28 | 0 | n/a | warming up | warming up | warming up |  |
| MARLIN | Pons v2 | 4.00% | A | $14,917 | 10.6 | +36.04% | +0.67% / -3.79% / 1 / ask -11.8% | +0.00% / +0.00% / 0 | +0.73% / -1.84% / 1 | 09-26T08:05Z place: Rally: a take-profit ask rests from 10.2% to 100.9% above the time-weighted price. |
| CULT | Pons v2 | 4.00% | A | $1,876 | 10.3 | +2.73% | -0.00% / -0.00% / 0 / ask -1.0% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T03:26Z place: Rally: a take-profit ask rests from 12.0% to 100.5% above the time-weighted price. |
| FUEL | Pons v2 | 6.00% | A | $1,555 | 9.0 | -15.10% | -0.00% / -0.00% / 0 / ask +2.4% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T13:00Z place: Resting 15.0% of the bank's RF for sale 2.4% above the market; the buyer who takes it pays the pool's 6.00% fee. |
| QSTRAT | Pons v2 | 6.00% | A | $7,896 | 9.9 | -0.35% | -0.00% / -0.00% / 0 / ask +3.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T03:32Z place: Resting 15.0% of the bank's RF for sale 1.8% above the market; the buyer who takes it pays the pool's 6.00% fee. |
| TOOLS | Pons v2 | 4.00% | A | $20,336 | 10.3 | +14.61% | +2.04% / -1.90% / 2 / ask +2.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T11:11Z place: Resting 15.0% of the bank's RF for sale 2.2% above the market; the buyer who takes it pays the pool's 4.00% fee. |
| Index | IndexFeeHook | 3.97% | A | $14,716 | 10.5 | -1.70% | -0.00% / -0.00% / 0 / ask +4.4% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T03:25Z place: Resting 15.0% of the bank's RF for sale 2.7% above the market; the buyer who takes it pays the pool's 3.97% fee. |
| DTF | DTFFeeHook | 3.97% | A | $37,420 | 10.7 | -4.58% | +0.00% / +0.00% / 0 / ask +2.5% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T14:00Z place: Resting 15.0% of the bank's RF for sale 2.5% above the market; the buyer who takes it pays the pool's 3.97% fee. |
| Bucket | single-pool hook | 3.97% | A | $21,925 | 8.9 | -7.44% | +0.00% / +0.00% / 0 / ask +0.9% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T10:22Z place: Resting 15.0% of the bank's RF for sale 3.7% above the market; the buyer who takes it pays the pool's 3.97% fee. |
| MONIT | unidentified launch hook 0x7Fc2...4A80 (lpFee 0.3%) | 0.30% | A? | $13,157,816 | 0 | n/a | warming up | warming up | warming up |  |
| AGBT | unidentified launch hook 0xEcdE...4a80 (lpFee 0.3%) | 0.30% | A? | $10,529,740 | 0 | n/a | warming up | warming up | warming up |  |
| MB4U | unidentified launch hook 0xDa3B...Ca80 (lpFee 0.3%) | 0.30% | A? | $10,030,516 | 0 | n/a | warming up | warming up | warming up |  |
| AORB | unidentified launch hook 0xbE3F...0a80 (lpFee 0.3%) | 0.30% | A? | $10,521,688 | 6.3 | -15.86% | +5.84% / -9.20% / 5 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T09:25Z filled: ask [2.572e-7, 2.603e-7] crossed at 2.588e-7 (+126.3% from the spot when placed; 127.0% vs a taker then) |
| GOOSE | hook 0xb3cA...e8cC, dynamic fee | 0.30% | A? | $17,324,827 | 10.2 | +2.80% | +0.00% / +0.00% / 0 / ask +4.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T12:00Z place: Resting 15.0% of the bank's RF for sale 2.2% above the market; the buyer who takes it pays the pool's 0.30% fee. |
| SPACEHOOD | Long.xyz (Doppler multicurve) | 0.70% | A | $150,062 | 10.8 | +1.27% | +0.88% / +0.86% / 2 / ask +1.1% | +0.33% / +0.18% / 1 | +0.00% / +0.00% / 0 | 09-26T09:01Z place: Resting 15.0% of the bank's RF for sale 3.2% above the market; the buyer who takes it pays the pool's 0.70% fee. |
| BUTTHOLE | StonkFun reward v1 (Raydium CLMM 4%) | 4.00% | A | $25,321 | 10.0 | -14.02% | +0.00% / +0.00% / 0 / none | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T13:27Z close: chase: the market walked away |
| SI | StonkFun reward v3 (1% pool + 1% transfer tax) | 2.00% | B | $0 | 0 | n/a | warming up | warming up | warming up |  |
| MASK | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $0 | 0 | n/a | warming up | warming up | warming up |  |
| ZCAT | StonkFun reward v3 (1% pool + 3% transfer tax) | 4.00% | B | $1,692,405 | 10.8 | -13.35% | -0.89% / -0.89% / 0 / ask +19.4% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T03:20Z place: Rally: a take-profit ask rests from 10.6% to 100.3% above the time-weighted price. |
| EMBER | Ember (Meteora DAMM v2, flagship pool) | 1.00% | A | $484,665 | 10.8 | +5.49% | +0.52% / -0.04% / 1 / ask +0.3% | +0.00% / +0.00% / 0 | +0.00% / +0.00% / 0 | 09-26T12:00Z place: Resting 15.0% of the bank's RF for sale 2.5% above the market; the buyer who takes it pays the pool's 1.00% fee. |
| e/acc | pump.fun (PumpSwap) | 1.25% | A | $58,261,425 | 0.8 | -3.05% | +0.00% / +0.00% / 0 / ask +6.7% (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | +0.00% / +0.00% / 0 (pool drained 07:01Z; replay stops there) | 09-26T03:20Z place: Resting 15.0% of the bank's RF for sale 3.1% above the market; the buyer who takes it pays the pool's 1.25% fee. |
| SpaceX | pump.fun (PumpSwap) | 1.25% | A | $43,562,526 | 0 | n/a | warming up | warming up | warming up |  |

## Reading it

- "vs taker on the same schedule" isolates execution: the same decisions, routed as a taker. Positive means resting the order beat swapping. "vs hold" is direction and says nothing about the programme.
- A pool with 0 fills has not been crossed yet; the standing order rests 1.9% to 3.1% above the market, so a quiet hour cannot fill it. Fills need buyers.
- Type B pools tax the maker's deposit; the 2026-09-23 sweep found every maker design loses there, and they are here to show it live.
- The unidentified Robinhood launch hooks are compared against a 0.3% taker fee only, because their hook skim is not known; that understates the edge there.

Decision log: data/paper/log.jsonl (one line per new decision). Bars: data/paper/bars/.
