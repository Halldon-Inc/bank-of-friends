#!/usr/bin/env node
/**
 * "With volume back, will it actually be profitable?"
 *
 * One synthetic run is an anecdote. This sweeps the SAME strategy module across a
 * grid of market regimes and reports the distribution, including the losers, so the
 * answer is a range with a win rate rather than a single flattering number.
 *
 *   node scripts/sweep-regimes.mjs
 *
 * Every tape is generated, therefore none of this is a forecast. What it CAN tell us:
 * which regimes the desk makes money in, which it loses in, and whether the gates
 * successfully keep it out of the bad ones.
 */
import { DEFAULT_GATES, COSTS, nextOrder, realisedVol, drift } from "../lib/strategy.mjs";

const ETH_USD = 2734.86;
const FEE = 0.05;
const MID0 = 5.7e-7;
const L = 147865.85;

function tape({ ticks, halfLife, sigma, band, tradeWeth, tradesPerDay, trendPerDay, seed }) {
  let s = seed, mid = MID0;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const kappa = Math.log(2) / halfLife;
  const perTickTrend = Math.pow(1 + trendPerDay, 1 / 1440) - 1;
  const out = [];
  const t0 = 1790000000;
  let anchor = MID0;
  for (let i = 0; i < ticks; i++) {
    anchor *= 1 + perTickTrend;
    const dev = Math.log(mid / anchor);
    mid = mid * Math.exp(-kappa * dev + sigma * gauss()) * (1 + perTickTrend);
    mid = Math.min(anchor * (1 + band), Math.max(anchor * (1 - band), mid));
    const sp = Math.sqrt(mid);
    out.push({ t: t0 + i * 60, mid, tradeWeth: tradeWeth * (0.4 + 1.2 * rnd()), poolWeth: L * sp, poolRf: L / sp });
  }
  return out;
}

function run(T, book0, gates = DEFAULT_GATES) {
  const book = { rf: book0.rf, weth: book0.weth, halted: false, hwmWeth: 0, valueWeth: 0 };
  const state = { gridRef: null, fillsThisHour: 0, hourBucket: null };
  let fills = 0, gasUsd = 0, armed = 0;
  const hist = [], day = [], week = [];
  const firstT = T[0].t;
  let warmedUp = false;

  for (const q of T) {
    hist.push({ t: q.t, mid: q.mid });
    while (hist.length && q.t - hist[0].t > 86400) hist.shift();
    week.push({ t: q.t, mid: q.mid });
    while (week.length && q.t - week[0].t > 7 * 86400) week.shift();
    day.push({ t: q.t, w: q.tradeWeth });
    while (day.length && q.t - day[0].t > 86400) day.shift();
    if (!warmedUp && q.t - firstT >= 86400) warmedUp = true;

    const hour = Math.floor(q.t / 3600);
    if (state.hourBucket !== hour) { state.hourBucket = hour; state.fillsThisHour = 0; }
    book.valueWeth = book.weth + book.rf * q.mid;
    book.hwmWeth = Math.max(book.hwmWeth, book.valueWeth);

    const lastHour = hist.filter((h) => q.t - h.t <= 3600).map((h) => h.mid);
    const market = {
      mid: q.mid, ethUsd: ETH_USD,
      volume24hWeth: day.reduce((a, b) => a + b.w, 0),
      trades24h: day.length,
      drift24h: drift(hist.map((h) => h.mid)),
      drift1h: drift(lastHour),
      drift7d: (q.t - week[0].t) >= 6 * 86400 ? drift(week.map((w) => w.mid)) : null,
      hourlyVol: lastHour.length >= 5 ? realisedVol(lastHour) * Math.sqrt(Math.max(lastHour.length - 1, 1)) : 0,
    };

    const order = warmedUp ? nextOrder(market, book, state, gates) : { action: "stand-down" };
    if (order.action !== "buy" && order.action !== "sell") continue;
    armed++;
    if (state.gridRef === null) state.gridRef = q.mid;

    if (order.action === "buy") {
      const net = order.weth * (1 - FEE);
      const got = q.poolRf - (q.poolRf * q.poolWeth) / (q.poolWeth + net);
      book.rf += got; book.weth -= order.weth;
    } else {
      const gross = q.poolWeth - (q.poolRf * q.poolWeth) / (q.poolRf + order.rf);
      book.weth += gross * (1 - FEE); book.rf -= order.rf;
    }
    fills++; gasUsd += COSTS.gasUsdPerFill; state.fillsThisHour++; state.gridRef = q.mid;
  }

  const last = T[T.length - 1];
  const liq = (rf) => rf <= 0 ? 0 : (last.poolWeth - (last.poolRf * last.poolWeth) / (last.poolRf + rf)) * (1 - FEE);
  const realisable = book.weth - gasUsd / ETH_USD + liq(book.rf);
  const hold = book0.weth + liq(book0.rf);
  return { fills, gasUsd, realisable, hold, edge: hold > 0 ? realisable / hold - 1 : 0 };
}

/* --------------------------------------------------------------------- sweep */
const BOOK = { rf: 3159.22, weth: 0.028987 };   // Hunt's real idle rewards
const DAYS = 14;
const TICKS = DAYS * 1440;

const REGIMES = [];
for (const trendPerDay of [-0.10, -0.03, 0.00, 0.03, 0.10]) {
  for (const sigma of [0.004, 0.008, 0.015, 0.025]) {
    for (const tradesPerDay of [300, 1440]) {
      REGIMES.push({
        name: `trend ${(trendPerDay * 100).toFixed(0)}%/d, sigma ${(sigma * 100).toFixed(1)}%, ${tradesPerDay} trades/d`,
        trendPerDay, sigma, tradesPerDay,
        halfLife: 400, band: 0.35,
        tradeWeth: 40 / tradesPerDay,   // ~40 WETH/day, comfortably over the 25 gate
      });
    }
  }
}

console.log("Bank of Friends :: regime sweep");
console.log(`${REGIMES.length} regimes x 6 seeds, ${DAYS} simulated days each, book $86 (Hunt's real idle rewards)`);
console.log(`gates: volume>=${DEFAULT_GATES.minVolume24hWeth} WETH, trades>=${DEFAULT_GATES.minTrades24h}, |drift24h|<=${DEFAULT_GATES.maxAbsDrift24h * 100}%, vol ${DEFAULT_GATES.minHourlyVol * 100}-${DEFAULT_GATES.maxHourlyVol * 100}%, grid ${DEFAULT_GATES.gridStep * 100}%\n`);

console.log(`${"regime".padEnd(44)}${"traded".padStart(8)}${"median".padStart(10)}${"worst".padStart(10)}${"best".padStart(10)}${"win%".padStart(7)}`);
console.log("-".repeat(89));

const all = [];
for (const r of REGIMES) {
  const runs = [];
  for (let seed = 1; seed <= 6; seed++) {
    const T = tape({ ticks: TICKS, seed: seed * 7919, ...r,
      tradeWeth: r.tradeWeth * (1440 / r.tradesPerDay) });
    runs.push(run(T, BOOK));
  }
  const edges = runs.map((x) => x.edge).sort((a, b) => a - b);
  const traded = runs.filter((x) => x.fills > 0).length;
  const med = edges[Math.floor(edges.length / 2)];
  const wins = edges.filter((e) => e > 0).length;
  all.push({ ...r, edges, traded, med, wins, runs });
  console.log(
    r.name.padEnd(44) +
    `${traded}/6`.padStart(8) +
    `${(med * 100).toFixed(1)}%`.padStart(10) +
    `${(edges[0] * 100).toFixed(1)}%`.padStart(10) +
    `${(edges[edges.length - 1] * 100).toFixed(1)}%`.padStart(10) +
    `${Math.round((wins / 6) * 100)}%`.padStart(7)
  );
}
console.log("-".repeat(89));

const tradedRegimes = all.filter((a) => a.traded > 0);
const flatRegimes = all.filter((a) => a.traded === 0);
const allEdges = tradedRegimes.flatMap((a) => a.edges);
const winners = allEdges.filter((e) => e > 0.0005).length;
const losers = allEdges.filter((e) => e < -0.0005).length;

console.log(`\nregimes where the desk ever traded: ${tradedRegimes.length} of ${all.length}`);
console.log(`regimes where the gates kept it flat: ${flatRegimes.length}`);
if (allEdges.length) {
  const sorted = [...allEdges].sort((a, b) => a - b);
  console.log(`\nacross ${allEdges.length} runs in which it traded:`);
  console.log(`  win rate   ${((winners / allEdges.length) * 100).toFixed(0)}%   (${winners} up, ${losers} down, ${allEdges.length - winners - losers} flat)`);
  console.log(`  median     ${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2)}% over ${DAYS} days`);
  console.log(`  worst      ${(sorted[0] * 100).toFixed(2)}%`);
  console.log(`  best       ${(sorted[sorted.length - 1] * 100).toFixed(2)}%`);
}

console.log(`\nregimes where it stayed flat (the gates working):`);
for (const f of flatRegimes.slice(0, 8)) console.log(`  ${f.name}`);
if (flatRegimes.length > 8) console.log(`  ... and ${flatRegimes.length - 8} more`);

console.log(`\nNOTHING HERE IS A FORECAST. Every tape is generated. What it shows is the`);
console.log(`SHAPE of the strategy: which regimes pay, which do not, and whether the gates`);
console.log(`keep the desk out of the ones that do not.`);
