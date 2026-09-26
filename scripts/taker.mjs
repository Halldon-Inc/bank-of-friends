#!/usr/bin/env node
/**
 * THE TAKER DESK: the bank swaps pooled funds RF -> WETH and WETH -> RF through the pool, paying the full toll
 * on every swap (5% of the WETH leg in, 5% out on RF), and trades only when the move covers it.
 *
 *   node scripts/taker.mjs            print everything
 *   node scripts/taker.mjs --write    also write docs/TAKER.md
 *
 * What makes it different from a trader paying 5% to strangers: on RF the toll goes to the ActivationManager and
 * streams back to every activated Friend by weight. A bank whose members hold share s of all weight gets s of its
 * own toll back, one to two weeks later (week k's fees stream over week k+1). So a round trip costs members
 * 0.0975 x (1 - s) of the notional, not 0.0975, and the break-even swing falls as membership rises.
 * On the 16 other pools the toll goes elsewhere (creators, holders); they are run with NO rebate as the hard case,
 * and again with the RF rebate as a what-if for the RF structure.
 *
 * Engine: scripts/backtest-engine.mjs makePool, ENDOGENOUS: every historical taker intent is replayed through the
 * pool together with the bank's own swaps, so the bank's buying lifts the price it later sells into and its
 * selling depresses the price it later buys at. Value is marked at LIQUIDATION (the remaining RF sold as a taker,
 * toll and impact included) against holding the same opening book marked the same way.
 *
 * Strategies (hourly decisions on the SIMULATED price, so nothing sees the future):
 *   band      buy when the price is d below its 24h EMA, sell when d above; sell only when the proceeds after BOTH
 *             tolls beat the RF's cost by m, buy back only when d below the last sale net of both tolls (profit lock)
 *   dip       buy after a d fall from the 72h high, sell once a round trip nets m after both tolls (profit lock);
 *             never sells at a loss, so a slide leaves it holding RF (reported)
 *   momentum  buy after a +x 24h move, sell on a -z trailing stop or at +2z; pays the toll both ways, no lock
 * Every buy uses f of idle WETH, every sell f of idle RF. One trade per hour at most. Gas $0.03 a swap.
 */
import fs from "node:fs";
import { loadTape, makePool, syntheticTape } from "./backtest-engine.mjs";
import { loadTokens } from "./economy-tape.mjs";
import { TAKER, takerDecision } from "../lib/strategy.mjs";

const WRITE = process.argv.includes("--write");
const GAS_USD = 0.033;               // MEASURED: 209k gas swap on Robinhood Chain
const WEEK = 7 * 86400;
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
const pc = (v) => (v == null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

/** Liquidation value of rf through a COPY of the pool at `fee`. */
function liq(pool, rf, weth, fee) {
  if (rf <= 0) return weth;
  const s0 = pool.s, f0 = pool.feesWeth, bak = new Map(pool.pos);
  const got = pool.rfIn(rf) * (1 - fee);
  pool.s = s0; pool.feesWeth = f0; pool.pos.clear(); for (const [k, v] of bak) pool.pos.set(k, v);
  return weth + got;
}

/**
 * Run one strategy on one tape. book = { rf0, weth0 } in pool units; fee = the pool's taker fee on the WETH leg;
 * s = members' share of reward weight (their toll rebate); quoteUsd for gas.
 */
export function runTaker(tape, strat, { rf0, weth0, fee = 0.05, s = 0, quoteUsd = 2690, Lm } = {}) {
  const pool = makePool(tape[0].pxBefore, Lm);
  const t0 = tape[0].t;
  let rf = rf0, weth = weth0, gasQ = 0, trades = 0, buys = 0, sells = 0, volQ = 0, tollQ = 0;
  let costRf = rf0, costWeth = rf0 * tape[0].pxBefore;          // the opening RF is valued at the opening price
  let lastSellNet = null, peak72 = [], ema = tape[0].pxBefore, high = null, entry = null;
  const tollByWeek = new Map();
  const hourly = [];
  let nextHour = Math.ceil(t0 / 3600) * 3600;
  const buy = (w) => {
    if (w <= 0 || w > weth) return;
    const got = pool.wethIn(w * (1 - fee));
    weth -= w; rf += got; costRf += got; costWeth += w;
    tollQ += w * fee; volQ += w; trades++; buys++; gasQ += GAS_USD / quoteUsd;
    const wk = Math.floor((nowT - t0) / WEEK); tollByWeek.set(wk, (tollByWeek.get(wk) ?? 0) + w * fee);
  };
  const sell = (q) => {
    if (q <= 0 || q > rf) return;
    const gross = pool.rfIn(q), net = gross * (1 - fee);
    const f = q / rf; costRf *= 1 - f; costWeth *= 1 - f;
    rf -= q; weth += net; tollQ += gross * fee; volQ += gross; trades++; sells++; gasQ += GAS_USD / quoteUsd;
    lastSellNet = net / q;
    const wk = Math.floor((nowT - t0) / WEEK); tollByWeek.set(wk, (tollByWeek.get(wk) ?? 0) + gross * fee);
  };
  // What a sale of q RF would net right now, and what a buy of w WETH would get, both after the toll and impact.
  const quoteSell = (q) => { const s0 = pool.s, f0 = pool.feesWeth; const g = pool.rfIn(q); pool.s = s0; pool.feesWeth = f0; return g * (1 - fee); };
  const quoteBuy = (w) => { const s0 = pool.s, f0 = pool.feesWeth; const g = pool.wethIn(w * (1 - fee)); pool.s = s0; pool.feesWeth = f0; return g; };
  let nowT = t0;
  const decide = () => {
    const p = pool.price();
    hourly.push(p);
    ema = ema + (p - ema) * (2 / 25);
    peak72.push(p); if (peak72.length > 72) peak72.shift();
    const hi72 = Math.max(...peak72);
    const avgCost = costRf > 0 ? costWeth / costRf : p;
    const f = strat.f, d = strat.d, m = strat.m ?? 0;
    // Guards (null = off): tr = no buying while the 72h drift is below -tr (a collapse, not a dip);
    // cap = no buying past this share of the book in RF; sl = sell everything if the price falls sl below cost.
    // drift over the last 72h, or over whatever history exists if the pool is younger (a launch crash counts)
    const d72 = p / peak72[0] - 1;
    const rfShare = rf * p / Math.max(1e-18, rf * p + weth);
    const canBuy = (strat.tr == null || d72 > -strat.tr) && (strat.cap == null || rfShare < strat.cap);
    if (strat.sl != null && rf > 0 && p <= avgCost * (1 - strat.sl)) { sell(rf); return; }
    if (strat.kind === "desk") {
      // THE SHIPPED DESK: lib/strategy.mjs takerDecision, exactly as the live paper test and /api/desk call it
      const o = takerDecision({ price: p, ema, drift72: d72 }, { rf, weth, avgCost, lastSellNet }, { buyPx: (w) => w / quoteBuy(w), sellNet: (qq) => quoteSell(qq) }, strat.P ?? TAKER);
      if (o.action === "buy") buy(o.amount); else if (o.action === "sell") sell(o.amount);
      return;
    }
    if (strat.kind === "band") {
      if (p <= ema * (1 - d) && weth > 0 && canBuy) {
        const w = weth * f;
        // profit lock on the buy side: only re-buy below the last sale by d, net of both tolls
        const got = quoteBuy(w);
        if (lastSellNet == null || w / got <= lastSellNet * (1 - m)) buy(w);
      } else if (p >= ema * (1 + d) && rf > 0) {
        const q = rf * f, net = quoteSell(q);
        if (net / q >= avgCost * (1 + m)) sell(q);
      }
    } else if (strat.kind === "dip") {
      if (rf > 0) {
        const q = rf * f, net = quoteSell(q);
        if (net / q >= avgCost * (1 + m) && p >= ema) sell(q);
      }
      if (p <= hi72 * (1 - d) && weth > 0 && canBuy) {
        const w = weth * f, got = quoteBuy(w);
        if (lastSellNet == null || w / got <= lastSellNet * (1 - m)) buy(w);
      }
    } else if (strat.kind === "momentum") {
      const h = hourly;
      const d24 = h.length > 24 ? p / h[h.length - 25] - 1 : 0;
      if (entry == null && d24 >= strat.x && weth > 0) { buy(weth * f); entry = p; high = p; }
      else if (entry != null) {
        high = Math.max(high, p);
        if (p <= high * (1 - strat.z) || p >= entry * (1 + 2 * strat.z)) { sell(rf * f); if (rf < 1e-9 || f >= 1) entry = null; else entry = null; }
      }
    }
  };
  for (const e of tape) {
    while (e.t >= nextHour) { nowT = nextHour; decide(); nextHour += 3600; }
    nowT = e.t;
    e.buy ? pool.wethIn(e.weth) : pool.rfIn(e.rf);
  }
  const tEnd = tape.at(-1).t;
  // The rebate: week k's tolls stream evenly over week k+1. Cash = the part streamed before the tape ends;
  // owed = the rest (earned on chain, not yet paid).
  let rebateCash = 0, rebateOwed = 0;
  for (const [wk, toll] of tollByWeek) {
    const start = t0 + (wk + 1) * WEEK, end = start + WEEK;
    const paid = Math.max(0, Math.min(1, (tEnd - start) / WEEK));
    rebateCash += toll * s * paid; rebateOwed += toll * s * (1 - paid);
  }
  const value = liq(pool, rf, weth, fee) - gasQ + rebateCash;
  // hold: the same opening book, same tape, no bank trades
  const base = makePool(tape[0].pxBefore, Lm);
  for (const e of tape) e.buy ? base.wethIn(e.weth) : base.rfIn(e.rf);
  const hold = liq(base, rf0, weth0, fee);
  const start = liq(makePool(tape[0].pxBefore, Lm), rf0, weth0, fee);
  return {
    vsHold: value / hold - 1, vsHoldWithOwed: (value + rebateOwed) / hold - 1, vsStart: value / start - 1, holdVsStart: hold / start - 1,
    trades, buys, sells, volQ, tollQ, rebateCash, rebateOwed, gasQ, endRfShare: rf * pool.price() / Math.max(1e-18, rf * pool.price() + weth),
  };
}

/* ------------------------------------------------------------------ the strategy grid */
const GRID = [];
for (const d of [0.05, 0.10, 0.15, 0.20, 0.30]) for (const f of [0.10, 0.25, 0.50]) for (const m of [0.0, 0.03, 0.10]) {
  GRID.push({ kind: "band", d, f, m, name: `band d${d * 100} f${f * 100} m${m * 100}` });
  GRID.push({ kind: "dip", d, f, m, name: `dip d${d * 100} f${f * 100} m${m * 100}` });
}
// the same band and dip strategies with guards: no buying into a collapse, an RF inventory cap, a stop-loss
for (const d of [0.10, 0.20, 0.30]) for (const f of [0.25, 0.50]) for (const m of [0.0, 0.10]) for (const tr of [0.25, 0.50]) for (const [cap, sl] of [[0.7, null], [0.7, 0.3], [null, 0.3]]) {
  const tag = `tr${tr * 100}${cap ? ` cap${cap * 100}` : ""}${sl ? ` sl${sl * 100}` : ""}`;
  GRID.push({ kind: "band", d, f, m, tr, cap, sl, name: `band d${d * 100} f${f * 100} m${m * 100} ${tag}` });
  GRID.push({ kind: "dip", d, f, m, tr, cap, sl, name: `dip d${d * 100} f${f * 100} m${m * 100} ${tag}` });
}
for (const x of [0.10, 0.20, 0.40]) for (const z of [0.05, 0.10, 0.20]) for (const f of [0.25, 0.50])
  GRID.push({ kind: "momentum", x, z, f, name: `momentum x${x * 100} z${z * 100} f${f * 100}` });
const SHARES = [0.002, 0.10, 0.50, 0.90];

/* ------------------------------------------------------------------ inputs */
const rfTape = loadTape("data/swaps.json").tape;
const tokens = loadTokens("data/tokens").filter((t) => t.meta.type === "A");
const ETH = 2690;
const halfBook = (p0, usd, quoteUsd) => ({ rf0: usd / 2 / quoteUsd / p0, weth0: usd / 2 / quoteUsd });

say(`# The taker desk: pooled funds swapped through the pool, paying the full toll both ways`);
say(``);
say(`Generated ${new Date().toISOString()} by \`node scripts/taker.mjs --write\`. Every number is printed by that script.`);
say(`Engine: endogenous replay (the bank's own swaps move the price it trades at), value at liquidation, gas $0.033 a swap, $10,000 book half RF half WETH. ${GRID.length} strategy settings. Membership share s is the members' share of all reward weight, and so the share of the bank's own toll that streams back to them (one Genesis is 0.19%).`);
say(``);

/* 1. RF, full tape, every setting, at each membership share */
say(`## 1. RF, the real tape (${rfTape.length} swaps, ${((rfTape.at(-1).t - rfTape[0].t) / 86400).toFixed(1)} days, price ${pc(rfTape.at(-1).px / rfTape[0].pxBefore - 1)})`);
say(``);
const rfBook = halfBook(rfTape[0].pxBefore, 10_000, ETH);
const rfRes = {};
for (const s of SHARES) rfRes[s] = GRID.map((g) => ({ g, r: runTaker(rfTape, g, { ...rfBook, fee: 0.05, s, quoteUsd: ETH }) }));
say(`| membership share s | settings that beat holding | best | median | worst | best setting |`);
say(`| ---: | ---: | ---: | ---: | ---: | --- |`);
for (const s of SHARES) {
  const rows = rfRes[s].filter((x) => x.r.trades > 0), v = rows.map((x) => x.r.vsHoldWithOwed);
  const best = rows.reduce((a, b) => (b.r.vsHoldWithOwed > a.r.vsHoldWithOwed ? b : a), rows[0]);
  say(`| ${(s * 100).toFixed(1)}% | ${v.filter((x) => x > 0).length} of ${rows.length} | ${pc(Math.max(...v))} | ${pc(med(v))} | ${pc(Math.min(...v))} | ${best.g.name} (${best.r.trades} swaps) |`);
}
say(``);
say(`vs holding, with the rebate still owed counted at face. A setting that never traded is left out (it equals holding).`);
say(``);

/* 2. 16 pools, train on the first half, test on the second */
say(`## 2. Out of sample: the 16 swap-fee pools, chosen on the first half of each pool, tested on the second half`);
say(``);
const OOS_PICK = {}, OOS_ALL = [];
const split = (tape) => { const mid = tape[Math.floor(tape.length / 2)].t; return [tape.filter((e) => e.t < mid), tape.filter((e) => e.t >= mid)]; };
const q25 = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 4)] : NaN; };
for (const rule of ["median", "25th percentile"]) for (const s of [0, 0.5, 0.9]) {
  const score = rule === "median" ? med : q25;
  const trainScore = GRID.map((g) => ({ g, v: score(tokens.map((t) => { const [a] = split(t.tape); return runTaker(a, g, { ...halfBook(a[0].pxBefore, 10_000, t.quoteUsd), fee: t.meta.fee, s, quoteUsd: t.quoteUsd, Lm: t.Lm }).vsHoldWithOwed; })) }));
  trainScore.sort((a, b) => b.v - a.v);
  const pick = trainScore[0];
  say(`*Selection rule: the best ${rule} across the 16 first halves.*`);
  if (rule === "25th percentile") OOS_PICK[s] = pick.g;
  OOS_ALL.push({ rule, s, g: pick.g });
  const test = tokens.map((t) => { const [, b] = split(t.tape); return { t, r: runTaker(b, pick.g, { ...halfBook(b[0].pxBefore, 10_000, t.quoteUsd), fee: t.meta.fee, s, quoteUsd: t.quoteUsd, Lm: t.Lm }) }; });
  const v = test.map((x) => x.r.vsHoldWithOwed);
  const v25 = q25(test.map((x) => x.r.vsHoldWithOwed));
  say(`**Rebate s = ${(s * 100).toFixed(0)}%${s === 0 ? " (the real case on these pools: their toll does not come back)" : " (what-if: the RF structure, where the toll streams back to members)"}.** Best on the first halves: ${pick.g.name}, ${rule} ${pc(pick.v)} vs hold in sample. On the second halves: median ${pc(med(v))}, 25th percentile ${pc(v25)}, beat holding on ${v.filter((x) => x > 0).length} of ${v.length}, worst ${pc(Math.min(...v))}, best ${pc(Math.max(...v))}.`);
  say(``);
  if (rule === "25th percentile" && (s === 0 || s === 0.9)) {
    say(`| pool | fee | second half: vs hold | vs start | holding vs start | swaps | toll paid |`);
    say(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const { t, r } of test) say(`| ${t.meta.label} | ${(t.meta.fee * 100).toFixed(1)}% | ${pc(r.vsHoldWithOwed)} | ${pc(r.vsStart)} | ${pc(r.holdVsStart)} | ${r.trades} | $${(r.tollQ * t.quoteUsd).toFixed(0)} |`);
    say(``);
  }
}

/* 3. synthetic regimes, including RF at 4x volume */
say(`## 3. Synthetic regimes (SYNTHETIC: the sign per regime, never a forecast)`);
say(``);
say(`14 days, RF's real pool depth, 3 seeds. "4x volume chop" doubles the swing size of normal chop, which is what four times the two-way flow does to a pool of this depth.`);
say(``);
const REG = {
  "chop": { sigma: 0.03, pull: 0.22 },
  "4x volume chop": { sigma: 0.06, pull: 0.22 },
  "slide -5%/day": { sigma: 0.02, pull: 0, trendPerDay: -0.05 },
  "rally +5%/day": { sigma: 0.02, pull: 0, trendPerDay: 0.05 },
};
say(`The strategy is the one section 2 picked on the first halves by the worst-case-aware rule (25th percentile) at each rebate level, not one tuned on RF.`);
say(``);
say(`| regime | s | setting | median vs hold | median vs start | holding vs start | swaps |`);
say(`| --- | ---: | --- | ---: | ---: | ---: | ---: |`);
for (const [name, cfg] of Object.entries(REG)) for (const s of [0, 0.5, 0.9]) {
  const g = OOS_PICK[s];
  const runs = [1, 2, 3].map((seed) => { const tp = syntheticTape({ days: 14, stepMin: 5, seed, ...cfg }); return runTaker(tp, g, { ...halfBook(tp[0].pxBefore, 10_000, ETH), fee: 0.05, s, quoteUsd: ETH }); });
  say(`| ${name} | ${(s * 100).toFixed(0)}% | ${g.name} | ${pc(med(runs.map((r) => r.vsHoldWithOwed)))} | ${pc(med(runs.map((r) => r.vsStart)))} | ${pc(med(runs.map((r) => r.holdVsStart)))} | ${med(runs.map((r) => r.trades))} |`);
}
say(``);
say(`And the same out-of-sample pick on RF's real tape:`);
say(``);
say(`| s | setting | vs hold | vs start | holding vs start | swaps |`);
say(`| ---: | --- | ---: | ---: | ---: | ---: |`);
for (const s of [0, 0.5, 0.9]) { const g = OOS_PICK[s]; const r = runTaker(rfTape, g, { ...rfBook, fee: 0.05, s, quoteUsd: ETH }); say(`| ${(s * 100).toFixed(0)}% | ${g.name} | ${pc(r.vsHoldWithOwed)} | ${pc(r.vsStart)} | ${pc(r.holdVsStart)} | ${r.trades} |`); }
say(``);

/* 4. break-even */
/* 3b. the shipped desk (lib/strategy.mjs TAKER), everywhere, with the equivalence check */
const DESK = { kind: "desk", name: "the shipped desk (lib/strategy.mjs TAKER)" };
const GRIDTWIN = GRID.find((g) => g.name === "band d30 f50 m0 tr25 cap70");
{
  let pass = true, checked = 0;
  for (const t of tokens) for (const s of [0, 0.9]) {
    const [, b] = split(t.tape), bk = { ...halfBook(b[0].pxBefore, 10_000, t.quoteUsd), fee: t.meta.fee, s, quoteUsd: t.quoteUsd, Lm: t.Lm };
    const a1 = runTaker(b, DESK, bk), a2 = runTaker(b, GRIDTWIN, bk);
    checked++; if (!(Math.abs(a1.vsHold - a2.vsHold) < 1e-9 && a1.trades === a2.trades)) pass = false;
  }
  say(`## 3b. The shipped desk`);
  say(``);
  say(`The desk the site and the keeper run is lib/strategy.mjs \`takerDecision\` with \`TAKER\` (band 30%, half the idle side a trade, no buying 25% down over 72h, RF capped at 70% of the book, sells only above cost after both tolls). Instrument check: it reproduces the grid entry it was selected as on all ${checked} pool-and-rebate runs: ${pass ? "PASS" : "FAIL"}.`);
  say(``);
  say(`| test | s | vs hold median | beat hold | 25th percentile | worst | best |`);
  say(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const s of [0, 0.5, 0.9]) {
    const sec = tokens.map((t) => { const [, b] = split(t.tape); return runTaker(b, DESK, { ...halfBook(b[0].pxBefore, 10_000, t.quoteUsd), fee: t.meta.fee, s, quoteUsd: t.quoteUsd, Lm: t.Lm }).vsHoldWithOwed; });
    say(`| 16 pools, second halves (out of sample) | ${(s * 100).toFixed(0)}% | ${pc(med(sec))} | ${sec.filter((x) => x > 0).length} of 16 | ${pc(q25(sec))} | ${pc(Math.min(...sec))} | ${pc(Math.max(...sec))} |`);
  }
  for (const s of [0, 0.5, 0.9]) {
    const full = tokens.map((t) => runTaker(t.tape, DESK, { ...halfBook(t.tape[0].pxBefore, 10_000, t.quoteUsd), fee: t.meta.fee, s, quoteUsd: t.quoteUsd, Lm: t.Lm }).vsHoldWithOwed);
    say(`| 16 pools, whole history (in sample for the first half) | ${(s * 100).toFixed(0)}% | ${pc(med(full))} | ${full.filter((x) => x > 0).length} of 16 | ${pc(q25(full))} | ${pc(Math.min(...full))} | ${pc(Math.max(...full))} |`);
  }
  const rfAfter = rfTape.filter((e) => e.t >= rfTape[0].t + 86400);
  for (const [label, tp] of [["RF, from launch", rfTape], ["RF, after its first 24 hours (as the pools are run)", rfAfter]]) for (const s of [0.002, 0.5, 0.9]) {
    const r = runTaker(tp, DESK, { ...halfBook(tp[0].pxBefore, 10_000, ETH), fee: 0.05, s, quoteUsd: ETH });
    say(`| ${label} | ${(s * 100).toFixed(1)}% | ${pc(r.vsHoldWithOwed)} | ${r.trades} swaps | | | |`);
  }
  say(``);
}

say(`## 4. The break-even arithmetic (DERIVED)`);
say(``);
say(`A round trip of V WETH pays 0.05 V on the way in and 5% of the proceeds on the way out, 0.0975 V in all, and members get back s of it. The swing a round trip must capture before impact and gas:`);
say(``);
say(`| membership share s | toll cost to members per round trip | break-even swing |`);
say(`| ---: | ---: | ---: |`);
for (const s of [0.002, 0.10, 0.25, 0.50, 0.75, 0.90, 1.0]) { const c = 0.0975 * (1 - s); say(`| ${(s * 100).toFixed(1)}% | ${(c * 100).toFixed(2)}% | ${(100 * (1 / (1 - c) - 1)).toFixed(2)}% |`); }
say(``);
say(`## 5. What this does not show`);
say(``);
say(`- RF's tape is 9.4 days of a launch that fell about 89%; the 16 pools are young, correlated launches on hourly bars.`);
say(`- The rebate assumes every member's Friend is activated and the protocol keeps routing the toll to the ActivationManager (one owner key can change that).`);
say(`- The same settings were searched on the same RF tape; section 2 is the only out-of-sample result.`);
say(`- Nothing here is deployed; the bank's contract today has no swap path at all, and adding one is a contract change and an audit.`);

if (WRITE) { fs.writeFileSync("docs/TAKER.md", out.join("\n") + "\n"); console.log("\nwrote docs/TAKER.md"); }
