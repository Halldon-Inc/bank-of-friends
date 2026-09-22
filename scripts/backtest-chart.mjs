#!/usr/bin/env node
/**
 * Backtest CHART-TRADING strategies: a bot trading RF/WETH for its own account,
 * taking liquidity from the pool, the way a crypto market-making desk actually runs.
 *
 * This is a different question from scripts/backtest.mjs, which tested being a VENUE.
 * Here the bot is a taker: it pays the 5% hook fee in both directions and moves the
 * price by the size it trades.
 *
 *   node scripts/backtest-chart.mjs
 *
 * THE BENCHMARK THAT MATTERS
 * --------------------------
 * 94% of reward value arrives as WETH. So "do nothing" means HOLDING WETH, not
 * holding RF. Every strategy is scored in WETH. A strategy that converts WETH into
 * RF has to beat simply sitting in WETH, and over this window RF fell 89% against it.
 */
import fs from "node:fs";
import { fmt } from "../lib/protocol.mjs";
import { loadTape } from "./backtest-engine.mjs";
// Per-swap times from the engine's block->time fit; the raw `t` is a 2.8-hour bucket start.
const TIME = new Map(loadTape().tape.map((e) => [e.b, e.t]));

const FEE = 0.05;
const GAS_WETH = 0.033 / 2734.86;   // measured gas at the same SNAPSHOT ETH price
const ETH_USD = 2734.86;   // SNAPSHOT (CoinGecko 2026-09-21), fixed so reruns of a historical tape are comparable; not live

const raw = JSON.parse(fs.readFileSync("data/swaps.json", "utf8"));
const SINCE = process.env.SINCE ? Date.parse(process.env.SINCE) / 1000 : 0;
const S = raw.swaps.map((s) => ({ t: TIME.get(s.b), b: s.b, sq: BigInt(s.sq), liq: BigInt(s.liq) }))
  .filter((s) => s.t >= SINCE).sort((a, b) => a.b - b.b);
if (SINCE) console.log(`[filtered to trades on/after ${new Date(SINCE * 1000).toISOString()}]`);
const P = S.map((s) => { const p = Number(s.sq) / 2 ** 96; return { t: s.t, b: s.b, p: p * p, L: Number(s.liq) / 1e18 }; });

const days = (P[P.length - 1].t - P[0].t) / 86400;
const p0 = P[0].p, p1 = P[P.length - 1].p;

/** A taker fill against the pool: 5% on the WETH leg, plus constant-product impact. */
function buyRf(wethIn, q) {
  const net = wethIn * (1 - FEE);
  const y = q.L * Math.sqrt(q.p), x = q.L / Math.sqrt(q.p);
  return x - (x * y) / (y + net);
}
function sellRf(rfIn, q) {
  const y = q.L * Math.sqrt(q.p), x = q.L / Math.sqrt(q.p);
  const gross = y - (x * y) / (x + rfIn);
  return gross * (1 - FEE);
}
const markWeth = (rf, weth, q) => weth + (rf > 0 ? sellRf(rf, q) : 0);

/* --------------------------------------------------------------------- strategies */

/** Grid: buy a slice every `step` down from the last action, sell a slice every `step` up. */
function grid(rf0, weth0, step, slice = 0.2) {
  let rf = rf0, weth = weth0, ref = P[0].p, trades = 0, gas = 0;
  for (const q of P) {
    if (q.p <= ref * (1 - step) && weth > 0) {
      const spend = weth * slice;
      if (spend * (1 - FEE) > GAS_WETH * 10) { rf += buyRf(spend, q); weth -= spend; trades++; gas += GAS_WETH; ref = q.p; }
    } else if (q.p >= ref * (1 + step) && rf > 0) {
      const give = rf * slice;
      const got = sellRf(give, q);
      if (got > GAS_WETH * 10) { weth += got; rf -= give; trades++; gas += GAS_WETH; ref = q.p; }
    }
  }
  return { rf, weth: weth - gas, trades, value: markWeth(rf, weth - gas, P[P.length - 1]) };
}

/** Mean reversion on a rolling window: buy `band` below the mean, sell `band` above. */
function meanRevert(rf0, weth0, window, band, slice = 0.25) {
  let rf = rf0, weth = weth0, trades = 0, gas = 0;
  const buf = [];
  for (const q of P) {
    buf.push(q.p); if (buf.length > window) buf.shift();
    if (buf.length < window) continue;
    const ma = buf.reduce((a, b) => a + b, 0) / buf.length;
    if (q.p < ma * (1 - band) && weth > 0) {
      const spend = weth * slice;
      if (spend * (1 - FEE) > GAS_WETH * 10) { rf += buyRf(spend, q); weth -= spend; trades++; gas += GAS_WETH; }
    } else if (q.p > ma * (1 + band) && rf > 0) {
      const give = rf * slice;
      const got = sellRf(give, q);
      if (got > GAS_WETH * 10) { weth += got; rf -= give; trades++; gas += GAS_WETH; }
    }
  }
  return { rf, weth: weth - gas, trades, value: markWeth(rf, weth - gas, P[P.length - 1]) };
}

/** Momentum: ride the trend instead of fading it. Sell on a `band` drop, buy on a `band` rip. */
function momentum(rf0, weth0, window, band, slice = 0.3) {
  let rf = rf0, weth = weth0, trades = 0, gas = 0;
  const buf = [];
  for (const q of P) {
    buf.push(q.p); if (buf.length > window) buf.shift();
    if (buf.length < window) continue;
    const then = buf[0], chg = (q.p - then) / then;
    if (chg < -band && rf > 0) {
      const give = rf * slice; const got = sellRf(give, q);
      if (got > GAS_WETH * 10) { weth += got; rf -= give; trades++; gas += GAS_WETH; }
    } else if (chg > band && weth > 0) {
      const spend = weth * slice;
      if (spend * (1 - FEE) > GAS_WETH * 10) { rf += buyRf(spend, q); weth -= spend; trades++; gas += GAS_WETH; }
    }
  }
  return { rf, weth: weth - gas, trades, value: markWeth(rf, weth - gas, P[P.length - 1]) };
}

/* --------------------------------------------------------------------------- run */
console.log("Bank of Friends :: CHART-TRADING backtest (bot trades for its own account)");
console.log(`${P.length} ticks over ${days.toFixed(2)} days`);
console.log(`RF/WETH  ${p0.toExponential(4)} -> ${p1.toExponential(4)}   (${(((p1 / p0) - 1) * 100).toFixed(1)}%)`);
console.log(`cost per round trip: ${(FEE * 200).toFixed(0)}% in fees, plus impact and $0.033/trade gas\n`);

const BOOKS = [
  { label: "Hunt's idle rewards, as they actually arrive (94% WETH)", rf: 3159.22, weth: 0.028987 },
  { label: "scaled $10,000, as rewards arrive (94% WETH)", rf: (600 / (p0 * ETH_USD)), weth: 9400 / ETH_USD },
];

for (const book of BOOKS) {
  const startWeth = book.weth + book.rf * p0;
  // The honest do-nothing: hold what you were given. Its value in WETH at the close.
  const holdAsGiven = book.weth + (book.rf > 0 ? sellRf(book.rf, P[P.length - 1]) : 0);
  const allWeth = book.weth + sellRf(book.rf, P[0]);   // convert to WETH on day 1 and sit

  console.log("=".repeat(100));
  console.log(`${book.label}`);
  console.log(`  ${fmt.n(book.rf)} RF + ${book.weth.toFixed(6)} WETH  =  ${startWeth.toFixed(6)} WETH ($${(startWeth * ETH_USD).toFixed(2)}) at open`);
  console.log("=".repeat(100));

  const rows = [];
  for (const step of [0.05, 0.10, 0.15, 0.20, 0.30]) rows.push([`grid, ${(step * 100).toFixed(0)}% step`, grid(book.rf, book.weth, step)]);
  for (const band of [0.10, 0.20, 0.30]) rows.push([`mean revert, 50-tick MA, ${(band * 100).toFixed(0)}% band`, meanRevert(book.rf, book.weth, 50, band)]);
  for (const band of [0.10, 0.20]) rows.push([`momentum, 50-tick, ${(band * 100).toFixed(0)}% trigger`, momentum(book.rf, book.weth, 50, band)]);

  console.log(`\n${"strategy".padEnd(42)}${"trades".padStart(8)}${"end RF".padStart(14)}${"end WETH".padStart(12)}${"value (WETH)".padStart(14)}${"vs hold".padStart(10)}`);
  console.log("-".repeat(100));
  for (const [name, r] of rows) {
    const vs = ((r.value / holdAsGiven) - 1) * 100;
    console.log(name.padEnd(42) + String(r.trades).padStart(8) + fmt.n(r.rf).padStart(14) +
      r.weth.toFixed(5).padStart(12) + r.value.toFixed(6).padStart(14) +
      `${vs >= 0 ? "+" : ""}${vs.toFixed(1)}%`.padStart(10));
  }
  console.log("-".repeat(100));
  console.log(`${"HOLD what you were given (benchmark)".padEnd(42)}${"0".padStart(8)}${fmt.n(book.rf).padStart(14)}${book.weth.toFixed(5).padStart(12)}${holdAsGiven.toFixed(6).padStart(14)}${"0.0%".padStart(10)}`);
  const vsAll = ((allWeth / holdAsGiven) - 1) * 100;
  console.log(`${"SELL ALL RF ON DAY 1, sit in WETH".padEnd(42)}${"1".padStart(8)}${"0".padStart(14)}${allWeth.toFixed(5).padStart(12)}${allWeth.toFixed(6).padStart(14)}${(vsAll >= 0 ? "+" : "") + vsAll.toFixed(1) + "%"}`.padEnd(10));

  const best = rows.reduce((a, b) => (b[1].value > a[1].value ? b : a));
  console.log(`\n  best bot: ${best[0]}  ->  ${best[1].value.toFixed(6)} WETH  (${(((best[1].value / holdAsGiven) - 1) * 100).toFixed(1)}% vs hold, ${(((best[1].value / allWeth) - 1) * 100).toFixed(1)}% vs sitting in WETH)`);
  console.log();
}

console.log("what to take from this:");
console.log("  - every strategy is scored in WETH, because WETH is how 94% of rewards arrive");
console.log("  - 'sit in WETH' is the real do-nothing benchmark, and over this window it was very hard to beat");
console.log("  - a 10% round-trip toll means a bot needs a >10% swing just to break even on a completed trade");
console.log("  - 5.6 days, one token, one violent downtrend. This is a small sample and it is not a forecast.");
