#!/usr/bin/env node
/**
 * "When the market changes, will the desk make money, and does the arming rule help?"
 *
 * One synthetic run is an anecdote. This sweeps the SAME strategy and the SAME
 * endogenous engine as scripts/backtest-gated.mjs across trend x volatility regimes,
 * several seeds each, and reports the distribution for two desks side by side:
 *
 *   gated     the live rule: regime gates + loss-lock + inventory sizing + drawdown
 *   ungated   the same grid with the three REGIME gates off (the risk gates stay)
 *
 * so the arming rule's cost in chop and its benefit in trends are both on the page.
 *
 *   node scripts/sweep-regimes.mjs
 *
 * Every tape is generated, therefore none of this is a forecast.
 */
import { DEFAULT_GATES } from "../lib/strategy.mjs";
import { simulateDesk, syntheticTape } from "./backtest-engine.mjs";

const ETH_USD = 2736;           // SNAPSHOT (CoinGecko 2026-09-22), fixed so reruns are comparable
const DAYS = 14;                // CHOICE: long enough for the 7-day replay to be measurable for a week
const SEEDS = [1, 2, 3, 4];     // CHOICE
const BOOK_USD = 10_000;        // CHOICE: a pooled book, balanced at the start
const PULL = 0.03;              // CHOICE: mean reversion per 5-min step when the anchor is flat

const REGIMES = [];
for (const trendPerDay of [-0.10, -0.03, 0, 0.03, 0.10])
  for (const sigma of [0.004, 0.012, 0.02])
    REGIMES.push({ trendPerDay, sigma, name: `trend ${(trendPerDay * 100).toFixed(0).padStart(3)}%/d, sigma ${(sigma * 100).toFixed(1)}%/5min` });

const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log("First Bank of Friends :: regime sweep, maker-only grid");
console.log(`${REGIMES.length} regimes x ${SEEDS.length} seeds, ${DAYS} days each, $${BOOK_USD.toLocaleString()} balanced book`);
console.log(`grid ${DEFAULT_GATES.gridStep * 100}% x ${DEFAULT_GATES.rungs}, lock ${DEFAULT_GATES.lockBps / 100}%, arm: >=${DEFAULT_GATES.minReversals72h} swings/72h, |72h drift| < ${DEFAULT_GATES.maxDrift72hSteps * DEFAULT_GATES.gridStep * 100}%, 7d replay beats hold\n`);
console.log(`${"regime".padEnd(34)}${"armed".padStart(7)}${"gated med".padStart(11)}${"worst".padStart(9)}${"ungated med".padStart(13)}${"worst".padStart(9)}`);
console.log("=".repeat(83));

const G = [], U = [];
for (const r of REGIMES) {
  const g = [], u = []; let armed = 0, hours = 0;
  for (const seed of SEEDS) {
    const tape = syntheticTape({ days: DAYS, sigma: r.sigma, pull: PULL, trendPerDay: r.trendPerDay, seed });
    const book = { rf0: (BOOK_USD / ETH_USD) / 2 / tape[0].pxBefore, weth0: (BOOK_USD / ETH_USD) / 2, ethUsd: ETH_USD };
    const a = simulateDesk(tape, book), b = simulateDesk(tape, { ...book, alwaysArmed: true });
    g.push(a.vsHold); u.push(b.vsHold); armed += a.armedHours; hours += a.hours;
  }
  G.push(...g); U.push(...u);
  console.log(`${r.name.padEnd(34)}${((armed / hours) * 100).toFixed(0).padStart(6)}%${pct(med(g)).padStart(11)}${pct(Math.min(...g)).padStart(9)}${pct(med(u)).padStart(13)}${pct(Math.min(...u)).padStart(9)}`);
}
console.log("=".repeat(83));
const win = (a) => a.filter((x) => x > 1e-9).length, lose = (a) => a.filter((x) => x < -1e-9).length;
console.log(`\nall ${G.length} runs            gated                     ungated`);
console.log(`  median vs hold     ${pct(med(G)).padEnd(26)}${pct(med(U))}`);
console.log(`  worst              ${pct(Math.min(...G)).padEnd(26)}${pct(Math.min(...U))}`);
console.log(`  best               ${pct(Math.max(...G)).padEnd(26)}${pct(Math.max(...U))}`);
console.log(`  up / down / flat   ${`${win(G)} / ${lose(G)} / ${G.length - win(G) - lose(G)}`.padEnd(26)}${win(U)} / ${lose(U)} / ${U.length - win(U) - lose(U)}`);
console.log("\nNOTHING HERE IS A FORECAST. Every tape is generated. It shows the SHAPE of the strategy:");
console.log("which regimes pay, which do not, and what the arming rule costs and saves.");
