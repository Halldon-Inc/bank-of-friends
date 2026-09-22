#!/usr/bin/env node
/**
 * Backtest market-making strategies against the COMPLETE swap history of the
 * RF/WETH pool (first swap block 64,590,343 -> head).
 *
 *   node scripts/fetch-history.mjs     # once, populates data/swaps.json
 *   node scripts/backtest.mjs
 *
 * METHODOLOGY, and the two traps this version avoids
 * ---------------------------------------------------------------------------
 * 1. THE PRICE PATH IS ENDOGENOUS. An earlier version let the Bank absorb order
 *    flow while still replaying the historical price, which hands the Bank the
 *    selling pressure AND the price decline it caused. That is a free lunch that
 *    does not exist. Here the pool is simulated as a constant-product AMM seeded
 *    from real on-chain liquidity, and ONLY the flow the Bank does not internalise
 *    moves the price. If the Bank buys the dip, there is less dip.
 *
 * 2. CROSSING REVENUE IS NOT A RETURN ON CAPITAL. A crossing network needs no
 *    inventory, so quoting its revenue as "% vs hold" on a small book produces
 *    meaningless four-digit percentages. It is reported as service revenue against
 *    the volume it matched, separately from the inventory strategies.
 *
 * Also: the v4 Swap sign convention is re-proved against the Market's explicit
 * `buy` flag on every run. It is the SWAPPER's delta, not the pool's; assuming
 * otherwise scored 0/42. If it cannot be proved, this script refuses to report.
 */
import fs from "node:fs";
import { ADDR, ABI, client, scanLogs, blocksPerDay, fmt } from "../lib/protocol.mjs";
import { loadTape } from "./backtest-engine.mjs";
// Per-swap times from the engine's block->time fit; the raw `t` is a 2.8-hour bucket start.
const TIME = new Map(loadTape().tape.map((e) => [e.b, e.t]));

const FEE = 0.05;                     // Hook.FEE_BPS = 500, verified on chain
const GAS_USD_PER_FILL = 0.033;       // measured from 8 real swap txs
const ETH_USD = 2734.86;   // SNAPSHOT (CoinGecko 2026-09-21), fixed so reruns of a historical tape are comparable; not live

const raw = JSON.parse(fs.readFileSync("data/swaps.json", "utf8"));
const swaps = raw.swaps
  .map((s) => ({ ...s, a0: BigInt(s.a0), a1: BigInt(s.a1), sq: BigInt(s.sq), liq: BigInt(s.liq) }))
  .sort((a, b) => a.b - b.b);
if (swaps.length === 0) { console.error("no swap history; run scripts/fetch-history.mjs first"); process.exit(2); }

const priceOf = (sq) => { const p = Number(sq) / 2 ** 96; return p * p; };

/* ------------------------------------------------------------ prove the sign convention */
async function verifySignConvention() {
  const c = client();
  const { head, perDay } = await blocksPerDay(c);
  const marketSwaps = await scanLogs(c, {
    address: ADDR.Market, event: ABI.market.find((x) => x.type === "event" && x.name === "Swapped"),
    fromBlock: head - perDay, toBlock: head,
  });
  if (marketSwaps.length === 0) return { ok: false, why: "no Market swaps in the last 24h to calibrate against" };
  const byTx = new Map(swaps.map((s) => [s.tx.toLowerCase(), s]));
  let agree = 0, checked = 0;
  for (const m of marketSwaps) {
    const s = byTx.get(m.transactionHash.toLowerCase());
    if (!s) continue;
    checked++;
    if ((s.a0 > 0n && s.a1 < 0n) === m.args.buy) agree++;
  }
  if (checked === 0) return { ok: false, why: "no overlapping txs between Market and PoolManager logs" };
  return { ok: agree === checked, why: `${agree}/${checked} Market swaps agree with the swapper-delta reading` };
}

/* ------------------------------------------------------------------- the order tape */
/** Each entry is the taker's INTENT: direction and the size they wanted, in RF. */
function tape() {
  let prev = swaps[0].sq;
  const out = [];
  for (const s of swaps) {
    const takerBuysRf = s.a0 > 0n;                       // swapper receives RF
    const rf = Math.abs(Number(s.a0)) / 1e18;
    const weth = Math.abs(Number(s.a1)) / 1e18;
    out.push({ b: s.b, t: TIME.get(s.b), takerBuysRf, rf, weth, midBefore: priceOf(prev), realMid: priceOf(s.sq) });
    prev = s.sq;
  }
  return out;
}

/* ------------------------------------------------------------- simulated v4-ish pool */
/**
 * Constant product over the full range, seeded from the real opening state.
 * The 5% hook fee is taken from the WETH leg in both directions, exactly as the
 * live hook does, and is accumulated so we can report how much the strategy
 * diverted away from (or sent into) the reward stream.
 */
function makePool(sqrtP0, L) {
  // sqrtP0 arrives as the raw X96 bigint; work in floats from here.
  let sqrtP = Number(sqrtP0) / 2 ** 96;
  const Ln = Number(L) / 1e18;
  let x = Ln / sqrtP;        // RF reserve
  let y = Ln * sqrtP;        // WETH reserve
  let feeWeth = 0;
  return {
    get mid() { return y / x; },
    get rf() { return x; },
    get weth() { return y; },
    get feesToRewards() { return feeWeth; },
    /** Taker sells `dRf` RF into the pool; returns WETH received after the 5% fee. */
    sellRf(dRf) {
      if (dRf <= 0) return 0;
      const k = x * y;
      const outGross = y - k / (x + dRf);
      const fee = outGross * FEE;
      feeWeth += fee;
      x += dRf; y -= outGross;
      return outGross - fee;
    },
    /** Taker spends `dWeth` WETH; 5% taken first; returns RF received. */
    buyRf(dWeth) {
      if (dWeth <= 0) return 0;
      const fee = dWeth * FEE;
      feeWeth += fee;
      const net = dWeth - fee;
      const k = x * y;
      const outRf = x - k / (y + net);
      y += net; x -= outRf;
      return outRf;
    },
  };
}

/** Realisable value: flattening RF back through the pool costs 5% plus impact. */
function liquidate(pool, rfInv, wethInv) {
  if (rfInv <= 0) return wethInv;
  const k = pool.rf * pool.weth;
  const gross = pool.weth - k / (pool.rf + rfInv);
  return wethInv + gross * (1 - FEE);
}

/* ------------------------------------------------------------------------ strategies */

/** Baseline: nobody intervenes. Replays every trade into the pool. */
function runBaseline(T, sqrtP0, L) {
  const pool = makePool(sqrtP0, L);
  for (const e of T) e.takerBuysRf ? pool.buyRf(e.weth) : pool.sellRf(e.rf);
  return { pool };
}

/**
 * S2: inventory market maker. Quotes mid*(1±spread) from the SIMULATED pool mid,
 * fills what it can up to hard caps, and lets the residual hit the pool.
 */
function runInventoryMm(T, sqrtP0, L, rf0, weth0, { spread, maxFillFracOfBook = 0.10 }) {
  const pool = makePool(sqrtP0, L);
  let rf = rf0, weth = weth0, fills = 0, gasUsd = 0, spreadEarned = 0;
  for (const e of T) {
    const mid = pool.mid;
    if (e.takerBuysRf) {
      const wantRf = e.weth / mid;
      const cap = rf * maxFillFracOfBook;
      const can = Math.max(0, Math.min(wantRf, rf, cap));
      if (can > 0) {
        const px = mid * (1 + spread);
        rf -= can; weth += can * px;
        spreadEarned += can * mid * spread;
        fills++; gasUsd += GAS_USD_PER_FILL;
      }
      const residualWeth = Math.max(0, e.weth - can * mid * (1 + spread));
      pool.buyRf(residualWeth);
    } else {
      const wantRf = e.rf;
      const px = mid * (1 - spread);
      const affordable = px > 0 ? weth / px : 0;
      const cap = (weth / Math.max(px, 1e-18)) * maxFillFracOfBook;
      const can = Math.max(0, Math.min(wantRf, affordable, cap));
      if (can > 0) {
        rf += can; weth -= can * px;
        spreadEarned += can * mid * spread;
        fills++; gasUsd += GAS_USD_PER_FILL;
      }
      pool.sellRf(Math.max(0, e.rf - can));
    }
  }
  return { pool, rf, weth, fills, gasUsd, spreadEarned,
    realisable: liquidate(pool, rf, weth) - gasUsd / ETH_USD };
}

/** S1: passive full-range LP alongside the protocol's position. Earns lpFee = 0. */
function runPassiveLp(T, sqrtP0, L, rf0, weth0) {
  const { pool } = runBaseline(T, sqrtP0, L);
  const p1 = pool.mid;
  const k = rf0 * weth0;
  const rf1 = Math.sqrt(k / p1), weth1 = Math.sqrt(k * p1);
  return { pool, rf: rf1, weth: weth1, fills: 0, gasUsd: 0, spreadEarned: 0,
    realisable: liquidate(pool, rf1, weth1) };
}

/**
 * S3: crossing network. Zero inventory: it only matches opposite flow inside a
 * window, at the prevailing mid, and charges each side. Unmatched flow goes to
 * the pool as normal. Reported as a SERVICE, not a return on a book.
 */
function runCrossing(T, sqrtP0, L, { windowSec = 3600, feePerSide = 0.005 }) {
  const pool = makePool(sqrtP0, L);
  const restingBuy = [], restingSell = [];
  let matchedRfNotionalWeth = 0, revenueWeth = 0, matches = 0, gasUsd = 0;
  let poolVolumeWeth = 0;
  for (const e of T) {
    const now = e.t ?? 0;
    const expire = (a) => { while (a.length && now - a[0].t > windowSec) { const o = a.shift();
      o.side === "buy" ? poolVolumeWeth += pool.buyRf(o.weth) * 0 + o.weth : pool.sellRf(o.rf); } };
    expire(restingBuy); expire(restingSell);
    const mid = pool.mid;
    let needRf = e.takerBuysRf ? e.weth / mid : e.rf;
    const book = e.takerBuysRf ? restingSell : restingBuy;
    while (needRf > 1e-12 && book.length) {
      const top = book[0];
      const take = Math.min(needRf, top.rf);
      const notional = take * mid;
      matchedRfNotionalWeth += notional;
      revenueWeth += notional * feePerSide * 2;
      needRf -= take; top.rf -= take;
      if (top.rf <= 1e-12) book.shift();
      matches++; gasUsd += GAS_USD_PER_FILL;
    }
    if (needRf > 1e-12) {
      (e.takerBuysRf ? restingBuy : restingSell)
        .push({ t: now, rf: needRf, weth: needRf * mid, side: e.takerBuysRf ? "buy" : "sell" });
    }
  }
  // Anything still resting at the end never filled; push it to the pool.
  for (const o of restingBuy) pool.buyRf(o.weth);
  for (const o of restingSell) pool.sellRf(o.rf);
  return { pool, matches, gasUsd, revenueWeth, matchedNotionalWeth: matchedRfNotionalWeth,
    netRevenueWeth: revenueWeth - gasUsd / ETH_USD };
}

/* ------------------------------------------------------------------------------ run */
const sign = await verifySignConvention();
console.log("Bank of Friends :: market-making backtest (endogenous pool)");
console.log(`swaps: ${swaps.length}   blocks ${swaps[0].b} -> ${swaps[swaps.length - 1].b}`);
console.log(`sign-convention check: ${sign.ok ? "PASS" : "FAIL"} (${sign.why})`);
if (!sign.ok) { console.error("\nRefusing to report: trade direction unverified."); process.exit(2); }

const T = tape();
const days = ((T[T.length - 1].t ?? 0) - (T[0].t ?? 0)) / 86400;
const sqrtP0 = swaps[0].sq, L0 = swaps[0].liq;
const p0 = priceOf(sqrtP0);

let buyVol = 0, sellVol = 0;
for (const e of T) (e.takerBuysRf ? (buyVol += e.weth) : (sellVol += e.weth));
const imbalance = (buyVol - sellVol) / (buyVol + sellVol);

const base = runBaseline(T, sqrtP0, L0);
console.log(`\nwindow ${days.toFixed(2)} days   |   ${T.length} trades`);
console.log(`observed RF price ${p0.toExponential(4)} -> ${priceOf(swaps[swaps.length - 1].sq).toExponential(4)} WETH  (${fmt.pct((priceOf(swaps[swaps.length - 1].sq) - p0) / p0)})`);
console.log(`simulated baseline pool reaches ${base.pool.mid.toExponential(4)} WETH  (sanity: should be close to observed)`);
console.log(`volume ${buyVol.toFixed(2)} WETH bought / ${sellVol.toFixed(2)} WETH sold   net ${fmt.pct(imbalance)} toward ${imbalance > 0 ? "BUYING" : "SELLING"}`);
console.log(`baseline fees into the reward stream: ${base.pool.feesToRewards.toFixed(4)} WETH ($${(base.pool.feesToRewards * ETH_USD).toFixed(0)})`);

/* ---- part 1: strategies that put a book at risk ---- */
const BOOKS = [
  { label: "Hunt's actual idle rewards ($84)", rf: 3159.22, weth: 0.028987 },
  { label: "scaled book ($10,000, half each side)", rf: 5000 / (p0 * ETH_USD), weth: 5000 / ETH_USD },
];

for (const book of BOOKS) {
  const startWeth = book.weth + book.rf * p0;
  console.log(`\n${"=".repeat(96)}`);
  console.log(`${book.label}   ${fmt.n(book.rf)} RF + ${book.weth.toFixed(6)} WETH   = ${startWeth.toFixed(6)} WETH ($${(startWeth * ETH_USD).toFixed(2)}) at open`);
  console.log("=".repeat(96));

  // Hold benchmark must be priced in the world where the Bank did nothing.
  const holdWeth = book.weth + book.rf * base.pool.mid;

  const rows = [];
  rows.push(["S1 passive full-range LP (lpFee = 0)", runPassiveLp(T, sqrtP0, L0, book.rf, book.weth)]);
  for (const spread of [0.01, 0.02, 0.04]) {
    rows.push([`S2 inventory MM, ${(spread * 100).toFixed(0)}% spread, 10% max fill`,
      runInventoryMm(T, sqrtP0, L0, book.rf, book.weth, { spread })]);
  }

  console.log(`\n${"strategy".padEnd(44)}${"fills".padStart(7)}${"end RF".padStart(14)}${"end WETH".padStart(11)}${"realisable".padStart(12)}${"vs hold".padStart(10)}`);
  console.log("-".repeat(98));
  for (const [name, r] of rows) {
    const vs = holdWeth > 0 ? ((r.realisable / holdWeth) - 1) * 100 : 0;
    console.log(name.padEnd(44) + String(r.fills).padStart(7) + fmt.n(r.rf).padStart(14) +
      r.weth.toFixed(5).padStart(11) + r.realisable.toFixed(6).padStart(12) +
      `${vs >= 0 ? "+" : ""}${vs.toFixed(1)}%`.padStart(10));
  }
  console.log("-".repeat(98));
  console.log(`S5 claim and hold (benchmark)${" ".repeat(16)}${"0".padStart(7)}${fmt.n(book.rf).padStart(14)}${book.weth.toFixed(5).padStart(11)}${holdWeth.toFixed(6).padStart(12)}${"0.0%".padStart(10)}`);
}

/* ---- part 2: the strategy that risks no book at all ---- */
const x = runCrossing(T, sqrtP0, L0, { windowSec: 3600, feePerSide: 0.005 });
console.log(`\n${"=".repeat(96)}`);
console.log("S3 CROSSING NETWORK  -  zero inventory, therefore zero market risk");
console.log("=".repeat(96));
console.log(`  capital required            0 (it never holds a position)`);
console.log(`  matches                     ${x.matches}`);
console.log(`  notional matched            ${x.matchedNotionalWeth.toFixed(2)} WETH ($${(x.matchedNotionalWeth * ETH_USD).toFixed(0)}) of ${(buyVol + sellVol).toFixed(0)} WETH total flow`);
console.log(`  share of flow internalised  ${fmt.pct(x.matchedNotionalWeth / (buyVol + sellVol))}`);
console.log(`  gross fee revenue @0.5%/side ${x.revenueWeth.toFixed(4)} WETH ($${(x.revenueWeth * ETH_USD).toFixed(0)})`);
console.log(`  gas                         $${x.gasUsd.toFixed(2)}`);
console.log(`  NET REVENUE                 ${x.netRevenueWeth.toFixed(4)} WETH ($${(x.netRevenueWeth * ETH_USD).toFixed(0)}) over ${days.toFixed(1)} days`);
console.log(`  saved for users vs the pool  ~${(x.matchedNotionalWeth * (FEE - 0.005) * 2).toFixed(2)} WETH ($${(x.matchedNotionalWeth * (FEE - 0.005) * 2 * ETH_USD).toFixed(0)}) in avoided 5% tolls`);
console.log(`  fees diverted from rewards  ${(base.pool.feesToRewards - x.pool.feesToRewards).toFixed(4)} WETH ($${((base.pool.feesToRewards - x.pool.feesToRewards) * ETH_USD).toFixed(0)})  <-- the honest cost to the protocol`);

console.log(`\nassumptions, stated so they can be argued with:`);
console.log(`  - pool simulated as full-range constant product from the real opening liquidity; only`);
console.log(`    flow the Bank does NOT internalise moves the price`);
console.log(`  - MAKER REALITY: nothing routes a taker to a quote outside the pool. The only way the`);
console.log(`    bank is ever filled is as liquidity INSIDE the pool, when a taker's swap crosses its`);
console.log(`    range; that is modelled in scripts/backtest-gated.mjs. S2 and S3 here overstate capture.`);
console.log(`  - inventory is marked at LIQUIDATION value through the simulated pool: 5% + impact`);
console.log(`  - gas $${GAS_USD_PER_FILL}/fill, measured from real transactions`);
console.log(`  - ${days.toFixed(1)} days is a SHORT and unusual window (the token fell ~89%). These are not forecasts,`);
console.log(`    and nothing here is annualised, because annualising a 5-day sample is not evidence.`);

/* ------------------------------------------------- part 3: the fee-elasticity question */
/**
 * Any venue that internalises flow at a fee below 5% reduces the toll that funds
 * Friend rewards. That is arithmetic, not opinion, and the crossing result above
 * quantifies it. The only way a cheaper venue is net-positive for Friends is if the
 * lower cost brings enough extra volume to make up the difference.
 *
 * This is a Laffer curve on the hook fee. We cannot prove where the peak is from
 * 5.6 days of data, but we CAN state exactly what it would take.
 */
console.log(`\n${"=".repeat(96)}`);
console.log("THE FEE-ELASTICITY QUESTION  -  is 5% above the revenue-maximising rate?");
console.log("=".repeat(96));
const observedVolWeth = buyVol + sellVol;
const baselineRewardWeth = base.pool.feesToRewards;
console.log(`observed over ${days.toFixed(1)} days: ${observedVolWeth.toFixed(1)} WETH volume -> ${baselineRewardWeth.toFixed(2)} WETH to rewards at a 5% toll\n`);
console.log(`${"venue fee".padEnd(12)}${"round trip".padStart(12)}${"volume needed to hold rewards flat".padStart(38)}${"multiple".padStart(11)}`);
console.log("-".repeat(73));
for (const f of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05]) {
  const needed = observedVolWeth * (FEE / f);
  console.log(
    `${(f * 100).toFixed(1) + "%"}`.padEnd(12) +
    `${(f * 200).toFixed(1)}%`.padStart(12) +
    `${needed.toFixed(0)} WETH`.padStart(38) +
    `${(FEE / f).toFixed(1)}x`.padStart(11)
  );
}
console.log("-".repeat(73));
console.log(`\nRead it this way: a venue charging 1% per side must bring 5x today's volume for`);
console.log(`Friend holders to end up no worse off. Whether a 10% -> 2% round-trip cost actually`);
console.log(`multiplies turnover by 5x is an EMPIRICAL question this dataset cannot answer.`);
console.log(`It is a hypothesis with a mechanism and a clear break-even, not a projection.`);

/* ------------------------------------------- part 4: the minimum economic fill size */
console.log(`\n${"=".repeat(96)}`);
console.log("MINIMUM ECONOMIC FILL SIZE  -  why a small book must not quote every trade");
console.log("=".repeat(96));
const sizes = T.map((e) => e.weth).sort((a, b) => a - b);
const pctl = (p) => sizes[Math.floor(sizes.length * p)] ?? 0;
console.log(`trade size in WETH:  p10 ${pctl(0.1).toExponential(2)}  median ${pctl(0.5).toExponential(2)}  p90 ${pctl(0.9).toExponential(2)}  max ${sizes[sizes.length - 1].toFixed(3)}`);
for (const spread of [0.01, 0.02, 0.04]) {
  const breakeven = (GAS_USD_PER_FILL / ETH_USD) / spread;
  const above = sizes.filter((s) => s >= breakeven).length;
  console.log(`  at a ${(spread * 100).toFixed(0)}% spread, a fill must exceed ${breakeven.toExponential(2)} WETH ($${(breakeven * ETH_USD).toFixed(2)}) to beat gas` +
    `  ->  only ${above} of ${sizes.length} trades (${fmt.pct(above / sizes.length)}) qualify`);
}
console.log(`\nQuoting all ${T.length} trades costs $${(T.length * GAS_USD_PER_FILL).toFixed(0)} in gas, which is ${(T.length * GAS_USD_PER_FILL / 84.21).toFixed(1)}x Hunt's entire book.`);
console.log(`A size filter is not an optimisation here. It is the difference between profit and ruin.`);
