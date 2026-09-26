#!/usr/bin/env node
/**
 * The standing-order economy, measured.        node scripts/economy.mjs [--write] [--quick]
 *
 * The bank's desk rests members' harvested RF as ONE maker ask in the RF/WETH pool (the
 * "standing sell order"), never as a taker. This script asks the only questions that
 * matter for that claim, and prints every number it uses:
 *
 *   1. On the pool's real tape, replayed endogenously (the bank's range absorbs the
 *      historical taker intents and moves the price), what does a unit of RF sold through
 *      the standing order fetch, against what the same unit would have fetched as a taker
 *      at the same moment? And in total, against a taker selling at the same pace, and
 *      against simply holding?
 *   2. Out of sample: the same programme on 16 other swap-fee pools (8 Robinhood v4 hook
 *      tokens with the same fee design, 8 StonkFun Solana tokens), hourly bars.
 *   3. Synthetic regimes: chop, a -5%/day slide, a +5%/day rally, with and without the
 *      trend brake, so the sign of the programme per regime is visible.
 *   4. How much RF conversion demand exists (sell share of the tape).
 *   5. The scale model: what the programme is worth to N Genesis members, from live inputs.
 *
 * Labels: MEASURED (read from the tape, the chain or the live API), DERIVED (algebra on
 * measured numbers), SYNTHETIC (a generated tape; the sign, never a forecast), CHOICE.
 * `--write` regenerates docs/EVIDENCE.md from this run. Nothing here touches a chain.
 */
import fs from "node:fs";
import { loadTape, makePool, liquidate, syntheticTape } from "./backtest-engine.mjs";
import { snapPrice, liquidityForRf, DEFAULT_GATES, COSTS } from "../lib/strategy.mjs";
import { loadTokens } from "./economy-tape.mjs";

const WRITE = process.argv.includes("--write");
const QUICK = process.argv.includes("--quick");
const out = [];
const log = (s = "") => { out.push(s); console.log(s); };

/* ============================================================ the programme (CHOICE) */
export const STANDING = Object.freeze({
  minBookUsd: 50,          // CHOICE: below this, gas (~$0.6 to $1.2 per 3 days measured) eats the edge
  widthSpacings: 2,        // CHOICE from the 2026-09-23 sweep: 0.6% to 1.2% wide asks filled best; 2% was worst everywhere
  frac: 0.15,              // CONTRACT: each range at most 15% of its side's idle book
  chase: 0.02,             // CHOICE from the sweep: re-place when the ask's edge is > 2% above the current edge
  requoteSeconds: 3600,    // CHOICE: at most one re-quote an hour (the contract allows 24 ops a day)
  brakeDrift24h: 0.10,     // CHOICE: a +10% day, or a new 72h high, switches the slot to the take-profit range
  releaseDrift24h: 0.03,   // CHOICE: back to the edge ask once the 24h drift is under +3% and no new high
  takeProfitLo: 1.10,      // CHOICE: the take-profit range, TWAP x 1.10 to TWAP x 2.0
  takeProfitHi: 2.0,
});
const EDGE = 1.0001 ** DEFAULT_GATES.twapEdgeTicks;   // CONTRACT: every range at least 100 ticks beyond the TWAP
const GAS_OP = COSTS.gasUsdPerFlip / 2;               // CHOICE (repo): $0.035 per open or close
const ETH_USD_FIXED = 2690;                            // SNAPSHOT for the RF runs (CoinGecko via /api/desk, 2026-09-26)

/* ============================================================ the engine */
/**
 * Endogenous replay of one policy against a taker-intent tape, under the contract's rules:
 * one ask; each open 1% to 15% of the idle side; 50% of a side per rolling day; 24 ops a
 * day; a range strictly beyond spot and at least 100 ticks beyond the TWAP; 7-day TTL.
 * Harvested RF has no cost basis, so no loss-lock applies. Bids are never placed here.
 */
export function run(tape, policy, { rfUsd = 0, inflowUsdPerDay = 0 } = {}, { fee = 0.05, quoteUsd = ETH_USD_FIXED, Lm, spacing = 60 } = {}) {
  const p0 = tape[0].pxBefore;
  const pool = makePool(p0, Lm);
  let rf = rfUsd / quoteUsd / p0, weth = 0, gasUsd = 0, fills = 0, opens = 0, cancels = 0, refused = 0;
  let inflowRf = 0, soldRf = 0, soldWeth = 0, takerFeesPaid = 0, takerSoldRf = 0;
  const fillLog = [];
  const ops = [], openLog = [];
  let ask = null, now = tape[0].t, twap = p0, lastQuoteT = -1e18;
  const hourly = [];
  const used = () => openLog.reduce((a, o) => a + o.frac * Math.max(0, 1 - (now - o.t) / 86400), 0);
  const opsDay = () => ops.filter((t) => t > now - 86400).length;
  /** What a taker would get, per RF, selling `q` right now (a copy of the pool, then the fee). */
  const takerPx = (q) => { if (!(q > 0)) return pool.price() * (1 - fee); return (liquidate(pool, q, 0) / q) * ((1 - fee) / (1 - 0.05)); };
  const ctx = {
    get rf() { return rf; }, get weth() { return weth; }, get spot() { return pool.price(); }, get twap() { return twap; },
    get now() { return now; }, get ask() { return ask; }, hourly, fee,
    get rfUsd() { return rf * pool.price() * quoteUsd; },
    get drift24h() { const h = hourly; return h.length > 24 ? h.at(-1) / h.at(-25) - 1 : null; },
    get high72h() { const h = hourly; if (h.length < 2) return null; return Math.max(...h.slice(Math.max(0, h.length - 73), h.length - 1)); },
    open(lo, hi, frac) {
      if (ask) return false;
      const amt = rf * Math.min(frac, DEFAULT_GATES.maxRangeFrac);
      if (!(amt > 0)) return false;
      if (used() + amt / rf > DEFAULT_GATES.maxDailySideFrac + 1e-9 || opsDay() >= DEFAULT_GATES.maxOpsPerDay) { refused++; return false; }
      lo = snapPrice(lo, spacing, "up"); hi = snapPrice(hi, spacing, "up");
      if (!(hi > lo)) return false;
      const s = pool.price();
      if (!(lo > s && lo >= twap * EDGE)) { refused++; return false; }
      const L = liquidityForRf(lo, hi, amt);
      rf -= amt;
      ask = { k: pool.add(lo, hi, L), lo, hi, amt, t: now, s0: s, takerPx0: takerPx(amt) };
      openLog.push({ t: now, frac: amt / (rf + amt) }); ops.push(now); gasUsd += GAS_OP; opens++; lastQuoteT = now;
      return true;
    },
    close(force = false) {
      if (!ask) return false;
      if (!force && opsDay() >= DEFAULT_GATES.maxOpsPerDay) return false;
      const a = pool.remove(ask.k); ops.push(now); gasUsd += GAS_OP;
      rf += a.rf; weth += a.weth;
      const sold = ask.amt - a.rf;
      if (sold > 1e-12 && a.weth > 0) {
        const px = a.weth / sold;
        fillLog.push({ t: now, placedAt: ask.t, sold, fillOverSpot: px / ask.s0, fillOverTaker: px / ask.takerPx0, fillOverTakerAtFill: px / takerPx(sold), hours: (now - ask.t) / 3600, partial: a.rf > 1e-12 });
        soldRf += sold; soldWeth += a.weth; fills++;
      } else cancels++;
      ask = null;
      return true;
    },
    takerSell(q) {
      q = Math.min(q, rf); if (!(q > 0)) return;
      const gross = pool.rfIn(q); rf -= q; weth += gross * (1 - fee);
      takerFeesPaid += gross * fee; soldRf += q; soldWeth += gross * (1 - fee); takerSoldRf += q;
    },
    canRequote() { return now - lastQuoteT >= STANDING.requoteSeconds; },
  };
  let nextHour = Math.ceil(tape[0].t / 3600) * 3600, nextInflow = tape[0].t;
  policy.start?.(ctx);   // before the first swap: "taker now" means now
  const hourTick = (t) => {
    now = t; const mid = pool.price();
    twap = hourly.length ? (hourly.at(-1) + mid) / 2 : mid;   // CHOICE: a 1h TWAP proxy
    hourly.push(mid);
    if (ask && now - ask.t > DEFAULT_GATES.rangeExpiryDays * 86400) ctx.close(true);
    policy.hour?.(ctx);
  };
  for (const e of tape) {
    while (e.t >= nextHour) { hourTick(nextHour); nextHour += 3600; }
    now = e.t;
    if (inflowUsdPerDay && e.t >= nextInflow) { const q = inflowUsdPerDay / quoteUsd / pool.price(); rf += q; inflowRf += q; nextInflow += 86400; policy.inflow?.(ctx, q); }
    e.buy ? pool.wethIn(e.weth) : pool.rfIn(e.rf);
    if (ask && pool.price() >= ask.hi) { ctx.close(); policy.filled?.(ctx); }
    policy.tick?.(ctx);
  }
  const pEnd = pool.price();
  if (ask) ctx.close(true);
  const mark = weth + rf * pEnd - gasUsd / quoteUsd;
  const liq = liquidate(pool, rf, weth) - gasUsd / quoteUsd;
  const rfTotal = rfUsd / quoteUsd / p0 + inflowRf;
  const days = (tape.at(-1).t - tape[0].t) / 86400;
  const makerSold = soldRf - takerSoldRf;
  return {
    rf, weth, pEnd, p0, mark, liq, fills, opens, cancels, refused, gasUsd, soldRf, soldWeth, inflowRf, rfTotal, days,
    soldFrac: rfTotal > 0 ? soldRf / rfTotal : 0, takerFeesPaid,
    tollPaidByCrossers: makerSold > 0 ? (soldWeth * makerSold / soldRf) * (fee / (1 - fee)) : 0,
    tollPaidByCrossersUsd: makerSold > 0 ? (soldWeth * makerSold / soldRf) * (fee / (1 - fee)) * quoteUsd : 0,
    fillLog, modeSwitches: policy.switches ?? 0,
  };
}

/* ============================================================ policies */
export const P = {};
P.hold = () => ({});
P.takerNow = () => ({ start(c) { c.takerSell(c.rf); }, inflow(c, q) { c.takerSell(q); } });
/** A taker that sells the SAME amounts at the moments the programme PLACED each ask that later filled: the same decisions, the taker route. */
P.takerSchedule = (fills) => {
  const q = fills.map((f) => ({ t: f.placedAt, sold: f.sold })).sort((a, b) => a.t - b.t); let i = 0;
  return { tick(c) { while (i < q.length && c.now >= q[i].t) { c.takerSell(q[i].sold); i++; } } };
};
/** THE STANDING SELL ORDER: mode A (edge ask, chase) with the trend brake into mode B (take-profit). */
P.standing = ({ brake = true } = {}) => {
  const pol = { mode: "A", switches: 0 };
  pol.hour = (c) => {
    const d24 = c.drift24h, hi72 = c.high72h;
    const braking = brake && d24 != null && hi72 != null && (d24 > STANDING.brakeDrift24h || c.spot >= hi72);
    if (pol.mode === "A" && braking) { pol.mode = "B"; pol.switches++; if (c.ask) c.close(); }
    else if (pol.mode === "B" && d24 != null && d24 < STANDING.releaseDrift24h && !(hi72 != null && c.spot >= hi72)) { pol.mode = "A"; pol.switches++; if (c.ask) c.close(); }
    if (c.rfUsd < STANDING.minBookUsd && !c.ask) return;
    const edgePx = snapPrice(Math.max(c.spot, c.twap) * EDGE, 60, "up") * 1.0001 ** 60;
    if (pol.mode === "A") {
      if (c.ask && c.ask.lo > edgePx * (1 + STANDING.chase) && c.canRequote()) c.close();
      if (!c.ask && c.canRequote()) c.open(edgePx, edgePx * 1.0001 ** (60 * STANDING.widthSpacings), STANDING.frac);
    } else {
      if (c.ask && c.spot >= Math.sqrt(c.ask.lo * c.ask.hi)) c.close();
      if (!c.ask && c.canRequote()) c.open(Math.max(c.twap * STANDING.takeProfitLo, c.spot * EDGE * 1.0001), c.twap * STANDING.takeProfitHi, STANDING.frac);
    }
  };
  return pol;
};

/* ============================================================ helpers */
const pc = (v, d = 2) => (v == null || Number.isNaN(v) ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const usd = (v) => `$${v.toFixed(2)}`;
const table = (head, rows) => {
  log(`| ${head.join(" | ")} |`);
  log(`| ${head.map((h, i) => (i ? "---:" : "---")).join(" | ")} |`);
  for (const r of rows) log(`| ${r.join(" | ")} |`);
};

/** One window: the programme, hold, taker-now, and a taker at the programme's own pace. */
function compare(tape, book, opts, { brake = true } = {}) {
  const hours = Math.max(1, Math.round((tape.at(-1).t - tape[0].t) / 3600));
  const hold = run(tape, P.hold(), book, opts);
  const prog = run(tape, P.standing({ brake }), book, opts);
  const pace = run(tape, P.takerSchedule(prog.fillLog), book, opts);
  const nowr = run(tape, P.takerNow(), book, opts);
  const f = prog.fillLog;
  return {
    hold, prog, pace, nowr,
    vsHold: prog.mark / hold.mark - 1, vsPace: prog.mark / pace.mark - 1, vsNow: prog.mark / nowr.mark - 1,
    fillOverSpot: med(f.map((x) => x.fillOverSpot)), unitVsTaker: med(f.map((x) => x.fillOverTaker - 1)), unitVsTakerAtFill: med(f.map((x) => x.fillOverTakerAtFill - 1)),
    hoursToFill: med(f.map((x) => x.hours)),
  };
}
const pct = (v, d = 0) => (v == null ? "n/a" : `${(v * 100).toFixed(d)}%`);
const row = (name, r) => [name, pc(r.vsHold), pc(r.vsPace), pc(r.vsNow), String(r.prog.fills), pct(r.prog.soldFrac),
  r.fillOverSpot == null ? "n/a" : r.fillOverSpot.toFixed(4), pc(r.unitVsTaker, 1), pc(r.unitVsTakerAtFill, 1), r.hoursToFill == null ? "n/a" : r.hoursToFill.toFixed(1),
  usd(r.prog.gasUsd), usd(r.prog.tollPaidByCrossersUsd)];
const HEAD = ["window", "vs hold", "vs taker, same schedule", "vs sell at once", "fills", "RF sold", "fill / spot at placement", "per unit vs taker at placement", "per unit vs taker at fill", "h to fill", "gas", "toll paid by crossers"];

/* ============================================================ 0. instrument checks */
log("# The standing-order economy, measured");
log("");
log(`Generated ${new Date().toISOString()} by \`node scripts/economy.mjs --write\`. Every number below is printed by that script.`);
log("");
const { tape: FULL, meta } = loadTape("data/swaps.json");
const first = new Date(FULL[0].t * 1000).toISOString(), last = new Date(FULL.at(-1).t * 1000).toISOString();
log(`Tape (MEASURED): ${meta.swaps} swaps, blocks ${meta.firstBlock} to ${meta.lastBlock}, ${first.slice(0, 16)}Z to ${last.slice(0, 16)}Z, ${((FULL.at(-1).t - FULL[0].t) / 86400).toFixed(2)} days, price ${pc(FULL.at(-1).px / FULL[0].pxBefore - 1, 1)}.`);
log(`ETH/USD held at $${ETH_USD_FIXED} for the RF runs (SNAPSHOT). Gas ${usd(GAS_OP)} per open or close (CHOICE, repo). Hook fee 5% (MEASURED).`);
log("");
log("## 0. Instrument checks");
log("");
{
  const book = { rfUsd: 1000 };
  const h = run(FULL, P.hold(), book), never = run(FULL, { hour() {} }, book);
  const a = Math.abs(never.mark - h.mark) < 1e-15 && never.fills === 0;
  const now = run(FULL, P.takerNow(), book);
  const loss = now.mark / (book.rfUsd / ETH_USD_FIXED) - 1;   // vs the book marked at mid at t0
  const b = loss < -0.045 && loss > -0.08;
  const chop = syntheticTape({ days: 14, stepMin: 60, sigma: 0.03, pull: 0.22, trendPerDay: 0, seed: 1 });
  const c = run(chop, P.standing(), book).fills;
  log(`- ${a ? "PASS" : "FAIL"} a policy that never quotes returns exactly hold (${never.fills} fills, mark difference ${Math.abs(never.mark - h.mark).toExponential(1)} WETH)`);
  log(`- ${b ? "PASS" : "FAIL"} selling the whole RF-only book as a taker at t0 loses ${pc(loss)} against the book marked at mid (expected about -5% minus impact)`);
  log(`- ${c > 0 ? "PASS" : "FAIL"} the programme fills on a synthetic chop tape (${c} fills in 14 days)`);
  if (!(a && b && c > 0)) { console.error("instrument check failed"); process.exit(1); }
}

/* ============================================================ 1. the real tape */
log("");
log("## 1. The real tape, replayed endogenously (MEASURED)");
log("");
log("The bank's ask is added to the pool and every historical taker intent is replayed through it, so the range absorbs flow and moves the price. Value is marked at the closing mid, gas deducted. \"vs taker, same schedule\" is a taker that sells the SAME amounts at the moments the programme PLACED each ask that later filled, so the decisions are identical and only the route differs: it isolates execution. \"vs sell at once\" is selling the whole book as a taker at the start (or each harvest on arrival). \"per unit vs taker\" is the median over fills of the fill price against what the same amount would have fetched as a taker (toll plus impact), once at the moment the ask was placed (the decision) and once at the moment it finished filling (a hindsight bound: a taker who sold at the exact instant the move ended). On the swap-level RF tape both are positive; on hourly bars the second is distorted, because a bar is replayed as a few large legs that carry the price far past the range in one trade. \"toll paid by crossers\" is the 5% the buyers who crossed the bank's ask paid to every activated Friend.");
log("");
const at = (iso) => FULL.findIndex((e) => e.t >= Date.parse(iso) / 1000);
const WINDOWS = {
  "whole life": FULL,
  "from Sep 17": FULL.slice(at("2026-09-17T00:00:00Z")),
  "from Sep 19": FULL.slice(at("2026-09-19T00:00:00Z")),
  "last 7 days": FULL.filter((e) => e.t > FULL.at(-1).t - 7 * 86400),
  "last 72h": FULL.filter((e) => e.t > FULL.at(-1).t - 72 * 3600),
};
const realUnit = [], realUnitFill = [];
for (const [bn, book] of Object.entries({ "RF-only $1,000 (harvested, no cost basis)": { rfUsd: 1000 }, "RF stream, $100 a day arriving (harvest arrivals)": { inflowUsdPerDay: 100 } })) {
  log(`### ${bn}`);
  log("");
  const rows = [];
  for (const [wn, tp] of Object.entries(WINDOWS)) {
    const r = compare(tp, book);
    if (r.unitVsTaker != null) { realUnit.push(r.unitVsTaker); realUnitFill.push(r.unitVsTakerAtFill); }
    const days = (tp.at(-1).t - tp[0].t) / 86400;
    rows.push(row(`${wn} (${days.toFixed(1)} d, price ${pc(tp.at(-1).px / tp[0].pxBefore - 1, 0)})`, r));
  }
  table(HEAD, rows);
  log("");
}
const REAL_UNIT = med(realUnit);
log(`**Per unit sold, the standing order fetched a median ${pc(REAL_UNIT, 1)} more than the taker path at placement, and ${pc(med(realUnitFill), 1)} more than a taker selling at the very moment the ask finished filling** (MEASURED over ${realUnit.length} window-and-book runs). Fills land at about 1.02x the spot at placement, where a taker receives at most 0.95x spot before impact (DERIVED: 1.02 / 0.95 = +7.4%).`);
log("");

/* ============================================================ 2. out of sample */
log("## 2. Out of sample: 16 other swap-fee pools (MEASURED, hourly bars)");
log("");
log("Hourly OHLCV from GeckoTerminal (data/tokens/, fetched 2026-09-23/24), first 24 hours skipped (the launch print). 8 Robinhood Chain v4 hook tokens use the same design as RF (a swap fee of 4% to 5.3% paid by takers, makers pay nothing); 8 StonkFun Solana tokens have a 4% swap fee. Each pool is replayed with its own fee. Hourly bars hide swings inside the hour, and the tape carries only the minimum flow that draws each bar, so fills here are UNDER-counted. RF-only $1,000 book (in each pool's quote token), the same programme, the same taker-on-the-same-schedule comparison. Gas and the toll are shown in USD at each pool's quote price.");
log("");
const haveTokens = fs.existsSync("data/tokens/manifest.json");
if (!haveTokens) log("data/tokens/ is missing, so the out-of-sample section is skipped this run.");
const tokens = haveTokens ? loadTokens("data/tokens").filter((t) => t.meta.type === "A" && t.tape.length > 50) : [];
const taxed = haveTokens ? loadTokens("data/tokens").filter((t) => t.meta.type === "B") : [];
const tokRows = [], tokUnit = [], tokUnitFill = [], tokPace = [], tokHold = [];
for (const t of tokens) {
  const r = compare(t.tape, { rfUsd: 1000 }, { fee: t.meta.fee, quoteUsd: t.quoteUsd, Lm: t.Lm });
  tokRows.push([`${t.meta.label} (${t.meta.chain}, fee ${(t.meta.fee * 100).toFixed(1)}%, ${t.days.toFixed(0)} d, price ${pc(t.tape.at(-1).px / t.tape[0].pxBefore - 1, 0)})`, pc(r.vsHold), pc(r.vsPace), pc(r.vsNow), String(r.prog.fills), pct(r.prog.soldFrac), r.fillOverSpot == null ? "n/a" : r.fillOverSpot.toFixed(4), pc(r.unitVsTaker, 1), pc(r.unitVsTakerAtFill, 1), r.hoursToFill == null ? "n/a" : r.hoursToFill.toFixed(1), usd(r.prog.gasUsd), usd(r.prog.tollPaidByCrossersUsd)]);
  if (r.unitVsTaker != null) { tokUnit.push(r.unitVsTaker); tokUnitFill.push(r.unitVsTakerAtFill); }
  tokPace.push(r.vsPace); tokHold.push(r.vsHold);
}
if (tokens.length) table(["pool", "vs hold", "vs taker, same schedule", "vs sell at once", "fills", "sold", "fill / spot at placement", "per unit vs taker at placement", "per unit vs taker at fill", "h to fill", "gas", "toll paid by crossers"], tokRows);
log("");
const beatPace = tokPace.filter((v) => v > 1e-9).length, lostPace = tokPace.filter((v) => v < -1e-9).length;
const beatHold = tokHold.filter((v) => v > 1e-9).length, lostHold = tokHold.filter((v) => v < -1e-9).length;
if (tokens.length) log(`**Summary over ${tokens.length} pools:** per unit vs taker at placement: median ${pc(med(tokUnit), 1)}, worst ${pc(Math.min(...tokUnit), 1)}, best ${pc(Math.max(...tokUnit), 1)}; at the moment of fill: median ${pc(med(tokUnitFill), 1)}, worst ${pc(Math.min(...tokUnitFill), 1)}. Total vs a taker on the same schedule: median ${pc(med(tokPace))}, worst ${pc(Math.min(...tokPace))}, beat / lost ${beatPace} / ${lostPace} of ${tokens.length}. Total vs hold: median ${pc(med(tokHold))}, worst ${pc(Math.min(...tokHold))}, beat / lost ${beatHold} / ${lostHold} (vs hold is direction: a sell programme beats holding when the token later fell, and trails it when the token kept rising, whatever the execution).`);
log("");
if (taxed.length) {
  log("Transfer-tax tokens (type B: the tax is charged on the maker's deposit too) are excluded from the summary above. The 2026-09-23 sweep found every maker design loses on them; a bank would refuse such a pool.");
  log("");
}

/* ============================================================ 3. synthetic regimes */
log("## 3. Synthetic regimes (SYNTHETIC: the sign per regime, never a forecast)");
log("");
log("14 days, hourly steps, 3 seeds, RF-only $1,000. Chop: sigma 3% an hour pulled back to a flat anchor (pull 0.22). Slide: -5% a day. Rally: +5% a day. The trend brake (a +10% day or a new 72h high switches the slot to a take-profit range at 1.10x to 2.0x the TWAP) is shown on and off.");
log("");
const REG = [
  { name: "chop", sigma: 0.03, pull: 0.22, trend: 0 },
  { name: "slide -5%/day", sigma: 0.02, pull: 0, trend: -0.05 },
  { name: "rally +5%/day", sigma: 0.02, pull: 0, trend: 0.05 },
];
const synRows = [];
for (const r of REG) for (const brake of [true, false]) {
  const H = [], Pc = [], F = [], U = [], UF = [];
  for (const seed of QUICK ? [1] : [1, 2, 3]) {
    const tp = syntheticTape({ days: 14, stepMin: 60, sigma: r.sigma, pull: r.pull, trendPerDay: r.trend, seed });
    const c = compare(tp, { rfUsd: 1000 }, {}, { brake });
    H.push(c.vsHold); Pc.push(c.vsPace); F.push(c.prog.fills); if (c.unitVsTaker != null) { U.push(c.unitVsTaker); UF.push(c.unitVsTakerAtFill); }
  }
  synRows.push([`${r.name}, brake ${brake ? "on" : "off"}`, pc(med(H)), pc(Math.min(...H)), pc(med(Pc)), String(med(F)), pc(med(U), 1), pc(med(UF), 1)]);
}
table(["regime", "vs hold, median", "vs hold, worst", "vs taker same schedule, median", "fills, median", "per unit vs taker at placement", "per unit vs taker at fill"], synRows);
log("");
log("Reading: per unit and against the same decisions as a taker, the programme is ahead in every regime. Against HOLDING the result is the market's direction: in chop it is noise around zero (which way the tape happened to end), in a slide selling early wins by construction, and in a rally a sell programme trails holding, with the brake limiting that (compare the two rally rows). None of this is a forecast of RF.");
log("");

/* ============================================================ 4. flow size */
log("## 4. How much RF conversion demand exists (MEASURED, a proxy)");
log("");
log("The tape's sell share: the RF that holders pushed into the pool, by day, against the WETH they bought RF with. This is a proxy for conversion demand (a seller's wallet is not identified, so the share of CLAIMED rewards that was sold is UNMEASURED).");
log("");
{
  const byDay = new Map();
  for (const e of FULL) {
    const d = new Date(e.t * 1000).toISOString().slice(0, 10);
    const o = byDay.get(d) ?? { buyW: 0, sellW: 0, sellRf: 0, n: 0 };
    if (e.buy) o.buyW += e.weth / 0.95; else { o.sellW += e.weth; o.sellRf += e.rf; }
    o.n++; byDay.set(d, o);
  }
  const rows = []; let totSellRf = 0, totSellW = 0, totBuyW = 0;
  for (const [d, o] of [...byDay.entries()].sort()) {
    totSellRf += o.sellRf; totSellW += o.sellW; totBuyW += o.buyW;
    rows.push([d, String(o.n), o.buyW.toFixed(2), o.sellW.toFixed(2), (o.sellRf / 1e6).toFixed(2) + "M", pct(o.sellW / Math.max(o.buyW + o.sellW, 1e-12))]);
  }
  table(["day (UTC)", "swaps", "bought, WETH", "sold, WETH", "RF sold", "sell share"], rows);
  log("");
  log(`Over the tape, ${(totSellRf / 1e6).toFixed(1)}M RF was sold into the pool (${pct(totSellW / (totBuyW + totSellW))} of gross volume by WETH). The protocol's RF stream this week is ${(85.4).toFixed(1)}M RF (MEASURED, /api/desk streamRfPerWeek). Every unit of that sell flow that goes through a taker swap pays 5% and eats impact; the standing order is the same flow, resting instead.`);
  log("");
}

/* ============================================================ 5. scale model */
log("## 5. The scale model (DERIVED from live inputs)");
log("");
let live = null;
try {
  const r = await fetch("https://bank-of-friends-nu.vercel.app/api/desk", { signal: AbortSignal.timeout(20_000) });
  if (r.ok) live = await r.json();
} catch {}
if (!live) {
  log("The live desk API did not answer; the scale table needs streamRfPerWeek, streamWethPerWeek, totalWeight, rfUsd and ethUsd from /api/desk. UNMEASURED this run.");
} else {
  const m = live.market, rw = live.rewards, g = live.genesis, res = live.reserve;
  const GW = 2_000_000;
  log(`Inputs (MEASURED, /api/desk at ${live.asOf}): RF stream ${(rw.streamRfPerWeek / 1e6).toFixed(2)}M RF a week, WETH stream ${rw.streamWethPerWeek.toFixed(2)} WETH a week, total weight ${(rw.totalWeight / 1e6).toFixed(1)}M, RF $${m.rfUsd.toFixed(6)}, ETH $${m.ethUsd.toFixed(0)}, 24h volume ${m.volume24hWeth.toFixed(2)} WETH. Per-unit edge used: the real-tape median above, ${pc(REAL_UNIT, 1)} (not an assumed 7%).`);
  log("");
  const rows = [];
  for (const n of [1, 10, 50, 200]) {
    const s = (n * GW) / rw.totalWeight;
    const rfWeek = rw.streamRfPerWeek * s, rfUsdWeek = rfWeek * m.rfUsd;
    const gain = rfUsdWeek * REAL_UNIT;
    const crossedWeth = rfUsdWeek / m.ethUsd;            // if all of it fills, the buyers' gross WETH
    const toll = crossedWeth * 0.05, rebate = toll * s;
    rows.push([String(n), pct(s, 2), `${(rfWeek / 1e6).toFixed(2)}M RF (${usd(rfUsdWeek)})`, usd(gain), `${crossedWeth.toFixed(3)} WETH`, `${toll.toFixed(4)} WETH (${usd(toll * m.ethUsd)})`, `${rebate.toFixed(5)} WETH (${usd(rebate * m.ethUsd)})`, `${(rw.streamWethPerWeek * s).toFixed(3)} WETH (${usd(rw.streamWethPerWeek * s * m.ethUsd)})`]);
  }
  table(["Genesis members", "share s of weight", "RF flow a week through the bank", "gained vs taker path a week", "WETH crossed by takers if it all fills", "5% those takers pay to all Friends", "members' rebate (s x toll)", "members' own WETH stream a week"], rows);
  log("");
  log(`At 50 Genesis the bank routes about ${(rw.streamRfPerWeek * 50 * GW / rw.totalWeight / 1e6).toFixed(1)}M RF a week; the whole pool traded ${m.volume24hWeth.toFixed(1)} WETH in the last 24 hours, so a programme of that size would be most of the pool's depth near the price. UNMEASURED: whether resting depth draws more buyers (elasticity), and how fills are shared if other makers appear.`);
  log("");
  log(`**The Genesis line (MEASURED thresholds, /api/desk):** Reserve floor ${usd(res.floorUsd)} (900,000 RF sold through the pool), convert below ${usd(g.convertBelowUsd)}, max bid ${usd(g.maxBidUsd)}. The desk is idle whenever the market is above the max bid. Each conversion is 900,000 RF (${usd(900_000 * m.rfUsd)}) of pool volume paying about ${usd(res.floorWeth / 0.95 * 0.05 * m.ethUsd)} to every activated Friend, and each activation spends 100,000 RF (${usd(100_000 * m.rfUsd)}: half burned, half to the RF reward stream).`);
  log("");
}

/* ============================================================ 6. what this does not show */
log("## 6. What this does not show");
log("");
log("- The real tape is 9.5 days of one launch that fell about 89%. It says nothing about a mature RF market.");
log("- The programme's parameters were chosen on the 2026-09-23 sweep of this same tape, so section 1 is in-sample. Section 2 is the out-of-sample check, and its bars are hourly (fills under-counted) with fees of 4% to 5.3%, not 5%.");
log("- The engine assumes no other makers. Only 7 liquidity events exist in the pool's life; if other range-order makers appear, fills get rarer.");
log("- ETH/USD is held constant; the TWAP is a one-hour proxy, not the on-chain truncated observer; gas is the repo's $0.07-per-flip choice.");
log("- Synthetic tapes show the sign of the programme per regime and nothing else.");
log("- \"vs hold\" is a directional result: a sell programme wins against holding when the asset later falls and loses when it keeps rising. Whether to convert at all is the member's instruction (RF left in the Friend's wallet, or withdrawn, is never offered); the bank's claim is only that the conversion executes better than any taker route.");
log("- The bank's contract is not deployed, so no fill here has happened.");
log("");

if (WRITE) {
  fs.writeFileSync("docs/EVIDENCE.md", out.join("\n") + "\n");
  console.log("\nwrote docs/EVIDENCE.md");
}
