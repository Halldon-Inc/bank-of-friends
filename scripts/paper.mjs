#!/usr/bin/env node
/**
 * PAPER forward test of the desk's two programmes on live pools across launchpads. No money, no chain writes.
 *
 *   node scripts/paper.mjs --tick            one pass: fetch bars, replay, write the report
 *   node scripts/paper.mjs --loop 900        every 15 minutes, forever
 *   node scripts/paper.mjs --report          rebuild the report from cached bars only
 *
 * Universe: data/paper/universe.json (pool, launchpad, the taker fee, type A swap-only or B transfer tax).
 * Bars: GeckoTerminal minute OHLCV (prices in the QUOTE token), plus hourly bars for the gates' 72h and 7-day
 * history before the paper start. Everything is cached under data/paper/bars/ and the replay is deterministic
 * from the paper start, so every tick recomputes the whole test from scratch and only NEW decisions are appended
 * to data/paper/log.jsonl.
 *
 * Programmes, exactly the repo's pure decision functions (lib/strategy.mjs):
 *   standing   the standing sell order (standingOrder), RF-only book of $1,000 at the start price
 *   grid       the two-sided grid at DEFAULT_GATES, $500 + $500
 *   gridLoose  the same grid at the 2026-09-23 sweep's setting: 10% step, trend limit off, 3 swings, no
 *              drawdown stop, replay check on (in-sample winner; this is its forward test)
 * Fills are EXOGENOUS and conservative: an ask counts as filled only when a minute bar's high crosses its whole
 * range, a bid only when the low crosses its whole range; partial fills are ignored; gas is ignored (stated).
 * A type-B pool taxes the token leg of every deposit and withdrawal, as in the 2026-09-23 sweep.
 * Baselines: hold, and a TAKER on the same schedule (sells or buys the same amounts at the moments the
 * programme placed the orders that later filled, paying the pool's fee and no impact, which favours the taker).
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_GATES, standingOrder, explainStanding, measurePath, evaluateRegime, openingLadder,
  flipRange, lockOk, rangeAmounts, liquidityForRf, liquidityForWeth,
} from "../lib/strategy.mjs";

const DIR = "data/paper";
const BARS = path.join(DIR, "bars");
fs.mkdirSync(BARS, { recursive: true });
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const GT = "https://api.geckoterminal.com/api/v2";
const PACE_MS = 3_500;                // GeckoTerminal's free tier is about 30 requests a minute
const STRATS = ["standing", "grid", "gridLoose"];
const LOOSE = Object.freeze({ ...DEFAULT_GATES, gridStep: 0.10, maxDrift72hSteps: Infinity, minReversals72h: 3, maxDrawdown: 1, minWalkForwardEdge: 0 });
const BOOK_USD = 1000;

const universe = JSON.parse(fs.readFileSync(path.join(DIR, "universe.json"), "utf8"));
const statePath = path.join(DIR, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { startedAt: null, ticks: 0, seen: [] };
const seen = new Set(state.seen ?? []);

/* ------------------------------------------------------------------ fetching */
let lastReq = 0;
async function gt(url) {
  for (let a = 0; a < 5; a++) {
    const wait = lastReq + PACE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    let r;
    try { r = await fetch(url, { headers: { accept: "application/json", "user-agent": "bank-of-friends paper test (read-only)" }, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { await new Promise((res) => setTimeout(res, 5_000 * (a + 1))); continue; }
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 20_000 * (a + 1))); continue; }
    if (!r.ok) return { _status: r.status };
    return r.json();
  }
  return { _status: "rate limited" };
}
const barsFile = (p) => path.join(BARS, `${p.label.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
function loadBars(p) {
  return fs.existsSync(barsFile(p)) ? JSON.parse(fs.readFileSync(barsFile(p), "utf8")) : { label: p.label, quoteUsd: null, vol24: null, tvl: null, hourly: [], minute: [], fetched: 0 };
}
const merge = (old, fresh) => { const m = new Map(old.map((b) => [b[0], b])); for (const b of fresh) m.set(b[0], b); return [...m.values()].sort((a, b) => a[0] - b[0]); };
async function refresh(p) {
  const d = loadBars(p);
  const q = `aggregate=1&limit=1000&currency=token&token=base`;
  const m = await gt(`${GT}/networks/${p.net}/pools/${p.pool}/ohlcv/minute?${q}`);
  const ml = m?.data?.attributes?.ohlcv_list;
  if (Array.isArray(ml)) d.minute = merge(d.minute, ml); else d.lastError = `minute: ${JSON.stringify(m).slice(0, 120)}`;
  if (!d.hourly.length || d.fetched % 8 === 0) {
    const h = await gt(`${GT}/networks/${p.net}/pools/${p.pool}/ohlcv/hour?aggregate=1&limit=240&currency=token&token=base`);
    const hl = h?.data?.attributes?.ohlcv_list;
    if (Array.isArray(hl)) d.hourly = merge(d.hourly, hl);
  }
  if (d.quoteUsd == null || d.fetched % 4 === 0) {
    const meta = await gt(`${GT}/networks/${p.net}/pools/${p.pool}`);
    const a = meta?.data?.attributes;
    if (a) { d.quoteUsd = Number(a.quote_token_price_usd) || d.quoteUsd; d.vol24 = Number(a.volume_usd?.h24) || 0; d.tvl = Number(a.reserve_in_usd) || 0; d.name = a.name; }
  }
  d.fetched++;
  fs.writeFileSync(barsFile(p), JSON.stringify(d));
  return d;
}

/* ------------------------------------------------------------------ the replay */
/** Hourly closes ending at `t`, from the hourly bars before the start and the minute bars after. */
function closesTo(d, startTs, t) {
  const out = [];
  for (const b of d.hourly) if (b[0] + 3600 <= startTs && b[0] + 3600 <= t) out.push([b[0] + 3600, b[4]]);
  let hourEnd = null, close = null;
  for (const b of d.minute) {
    if (b[0] < startTs || b[0] >= t) continue;
    const he = Math.floor(b[0] / 3600) * 3600 + 3600;
    if (hourEnd != null && he !== hourEnd) out.push([hourEnd, close]);
    hourEnd = he; close = b[4];
  }
  if (hourEnd != null && hourEnd <= t) out.push([hourEnd, close]);
  return out;
}

function simulate(p, d, startTs, strat) {
  const tax = p.type === "B" ? (p.tax ?? 0) : 0, fee = p.fee, gates = strat === "gridLoose" ? LOOSE : DEFAULT_GATES;
  // Data sanity, conservative on both sides: a close more than 5x away from the previous close is a drained or
  // broken pool (the replay stops there and the pool is labelled), and a bar whose high or low is more than 3x
  // away from the previous close is a one-trade spike whose wick is NOT allowed to fill a resting order.
  const raw = d.minute.filter((b) => b[0] >= startTs);
  const bars = []; let brokeAt = null;
  for (const b of raw) {
    const prev = bars.at(-1)?.[4];
    if (prev && (b[4] / prev > 5 || prev / b[4] > 5)) { brokeAt = b[0]; break; }
    bars.push(prev && (b[2] / prev > 3 || prev / b[3] > 3) ? [b[0], b[1], Math.max(b[1], b[4]), Math.min(b[1], b[4]), b[4], b[5]] : b);
  }
  if (bars.length < 2 || !d.quoteUsd) return brokeAt ? { broken: true, brokeAt } : null;
  const p0 = bars[0][1], quoteUsd = d.quoteUsd;
  let rf = strat === "standing" ? BOOK_USD / quoteUsd / p0 : (BOOK_USD / 2) / quoteUsd / p0;
  let weth = strat === "standing" ? 0 : (BOOK_USD / 2) / quoteUsd;
  const rf0 = rf, weth0 = weth;
  let ranges = [], costRf = 0, costWeth = 0, lastSell = null, hwm = 1, halted = false, ask = null;
  const fills = [], decisions = [], takerLegs = [];
  let lastHour = -1, lastDecision = "";
  const value = (px) => { let v = weth + rf * px; for (const r of ranges) { const a = rangeAmounts(r.lo, r.hi, r.L, px); v += a.weth + a.rf * (1 - tax) * px; } return v; };
  const log = (t, action, why, extra = {}) => { const line = { t, pool: p.label, strat, action, why, ...extra }; decisions.push(line); lastDecision = `${new Date(t * 1000).toISOString().slice(5, 16)}Z ${action}: ${why}`; };
  const openRange = (t, side, lo, hi, size, mode, px) => {
    const L = side === "ask" ? liquidityForRf(lo, hi, size * (1 - tax)) : liquidityForWeth(lo, hi, size);
    if (!(L > 0) || !(size > 0)) return null;
    if (side === "ask") rf -= size; else weth -= size;
    const r = { side, lo, hi, L, size, t, px, mode };
    ranges.push(r);
    return r;
  };
  const closeRange = (r, px) => {
    const a = rangeAmounts(r.lo, r.hi, r.L, px);
    ranges = ranges.filter((x) => x !== r);
    rf += a.rf * (1 - tax); weth += a.weth;
    return a;
  };
  for (const b of bars) {
    const [t, , high, low, close] = b;
    const hour = Math.floor(t / 3600);
    /* fills on this bar, conservative: the whole range must be crossed */
    for (const r of [...ranges]) {
      const filled = r.side === "ask" ? high >= r.hi : low <= r.lo;
      if (!filled) continue;
      const a = closeRange(r, r.side === "ask" ? r.hi : r.lo);
      const avg = Math.sqrt(r.lo * r.hi);
      const takerPx = r.px * (r.side === "ask" ? 1 - fee : 1 / (1 - fee));
      fills.push({ t, side: r.side, size: r.size, avg, placedAt: r.t, spotAtPlace: r.px, perUnitVsTaker: r.side === "ask" ? avg / takerPx - 1 : takerPx / avg - 1 });
      takerLegs.push({ side: r.side, size: r.size, px: takerPx });
      if (r.side === "ask") { lastSell = avg; const f = Math.min(1, r.size / Math.max(rf + r.size, 1e-18)); costRf *= 1 - f; costWeth *= 1 - f; }
      else { costRf += a.rf * (1 - tax); costWeth += r.size; }
      log(t, "filled", `${r.side} [${r.lo.toPrecision(4)}, ${r.hi.toPrecision(4)}] crossed at ${avg.toPrecision(4)} (${r.side === "ask" ? "+" : ""}${((avg / r.px - 1) * 100).toFixed(1)}% from the spot when placed; ${(fills.at(-1).perUnitVsTaker * 100).toFixed(1)}% vs a taker then)`);
      if (r === ask) ask = null;
      if (strat !== "standing") {
        // the grid flips a filled range to the other side, loss-locked, as the contract's keeper would
        const book = { avgCost: costRf > 0 ? costWeth / costRf : 0, lastSellVwap: lastSell };
        const n = flipRange({ side: r.side, lo: r.lo, hi: r.hi }, gates, book);
        if (lockOk(n, gates, book) && !(n.side === "bid" && halted)) {
          const size = n.side === "ask" ? a.rf * (1 - tax) : a.weth;
          const nr = openRange(t, n.side, n.lo, n.hi, Math.min(size, n.side === "ask" ? rf : weth), "grid", close);
          if (nr) log(t, "flip", `${r.side} -> ${n.side} [${n.lo.toPrecision(4)}, ${n.hi.toPrecision(4)}]`);
        }
      }
    }
    if (hour === lastHour) continue;
    lastHour = hour;
    /* the hourly decision, on the same inputs the live desk reads */
    const hc = closesTo(d, startTs, t);
    const closes = hc.map((x) => x[1]);
    if (closes.length < 2) continue;
    const ticks72 = d.minute.filter((x) => x[0] >= t - 72 * 3600 && x[0] < t).map((x) => x[4]);
    const m = measurePath(closes, gates, ticks72.length > 60 ? ticks72 : null);
    const mid = close, twap = closes.length > 1 ? (closes.at(-2) + mid) / 2 : mid;
    const market = { ...m, mid, twap, ethUsd: quoteUsd };
    const v = value(mid), holdNow = weth0 + rf0 * mid;
    hwm = Math.max(hwm, v / holdNow);
    const bk = { rf, weth, valueWeth: v, hwmWeth: hwm * holdNow, halted, avgCost: costRf > 0 ? costWeth / costRf : 0 };
    if (strat === "standing") {
      const so = standingOrder(market, bk, { gridArmed: false, ask: ask ? { lo: ask.lo, hi: ask.hi, openedAt: ask.t, mode: ask.mode } : undefined, now: t }, gates);
      if (so.close && ask) { closeRange(ask, mid); log(t, "close", so.closeWhy ?? "re-quote"); ask = null; }
      if (so.place && !ask) {
        const size = rf * so.place.frac;
        ask = openRange(t, "ask", so.place.lo, so.place.hi, size, so.mode, mid);
        if (ask) log(t, "place", explainStanding(so, market).replace("pays 5% to every Friend", p.label === "RF" ? "pays 5% to every Friend" : `pays the pool's ${(fee * 100).toFixed(2)}% fee`), { lo: so.place.lo, hi: so.place.hi, size, mode: so.mode });
      } else if (!so.place && !ask && so.mode === "idle") lastDecision = `${new Date(t * 1000).toISOString().slice(5, 16)}Z idle: ${so.reason}`;
    } else {
      const regime = evaluateRegime(market, bk, gates);
      if (regime.checks.find((c) => c.gate === "drawdown")?.status === "blocking") halted = true;
      if (!regime.armed || halted) {
        for (const r of ranges.filter((x) => x.side === "bid")) { closeRange(r, mid); log(t, "cancel", "not armed: bids come down, asks keep resting"); }
        lastDecision = `${new Date(t * 1000).toISOString().slice(5, 16)}Z off: ${regime.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}`;
      } else {
        // armed: top up the ladder from free balances, exactly as scripts/backtest-engine.mjs does each hour
        const asks = ranges.filter((r) => r.side === "ask"), bids = ranges.filter((r) => r.side === "bid");
        const { ranges: add } = openingLadder(mid, { rf, weth }, { ethUsd: quoteUsd, hourlyVol: m.hourlyVol, twap }, gates, {
          asksOpen: asks.length, bidsOpen: bids.length, askSide: rf, bidSide: weth, lastSellVwap: lastSell,
          askFrom: asks.length ? Math.max(...asks.map((r) => r.hi)) : undefined, bidFrom: bids.length ? Math.min(...bids.map((r) => r.lo)) : undefined,
          avgCost: bk.avgCost,
        });
        for (const x of add) {
          const size = x.side === "ask" ? x.rf : x.weth;
          const r = openRange(t, x.side, x.lo, x.hi, Math.min(size, x.side === "ask" ? rf : weth), "grid", mid);
          if (r) log(t, "place", `armed: ${x.side} [${x.lo.toPrecision(4)}, ${x.hi.toPrecision(4)}]`, { lo: x.lo, hi: x.hi, size });
        }
        if (!add.length && !ranges.length) lastDecision = `${new Date(t * 1000).toISOString().slice(5, 16)}Z armed, nothing to place`;
      }
    }
  }
  const pEnd = bars.at(-1)[4], v = value(pEnd), hold = weth0 + rf0 * pEnd;
  // the taker on the same schedule: same amounts, same moments, the pool's fee, no impact
  let tRf = rf0, tWeth = weth0;
  for (const l of takerLegs) { if (l.side === "ask") { tRf -= l.size; tWeth += l.size * l.px; } else { tWeth -= l.size; tRf += l.size / l.px; } }
  const takerValue = tWeth + tRf * pEnd;
  const pu = fills.map((f) => f.perUnitVsTaker).sort((a, b) => a - b);
  return {
    hours: (bars.at(-1)[0] - bars[0][0]) / 3600, priceChange: pEnd / p0 - 1,
    vsHold: v / hold - 1, vsTaker: v / takerValue - 1, fills: fills.length, sells: fills.filter((f) => f.side === "ask").length,
    perUnitMedian: pu.length ? pu[pu.length >> 1] : null, open: ranges.map((r) => `${r.side} ${((r.side === "ask" ? r.lo : r.hi) / pEnd - 1) * 100 >= 0 ? "+" : ""}${(((r.side === "ask" ? r.lo : r.hi) / pEnd - 1) * 100).toFixed(1)}%`),
    soldFrac: fills.filter((f) => f.side === "ask").reduce((a, f) => a + f.size, 0) / rf0, lastDecision, decisions, valueUsd: v * quoteUsd,
    brokeAt, fillList: fills.map((f) => ({ t: f.t, side: f.side, perUnitVsTaker: f.perUnitVsTaker, fromSpot: f.avg / f.spotAtPlace - 1 })),
  };
}

/* ------------------------------------------------------------------ report */
const pc = (x) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const med = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
function report(results, startTs) {
  const now = new Date().toISOString();
  const lines = [`# Paper forward test: the desk on live pools across launchpads`, ``,
    `Started ${new Date(startTs * 1000).toISOString()}, report ${now}, tick ${state.ticks}. No money, no chain writes. Every pool starts with a $${BOOK_USD} book at its start price; fills are counted only when a minute bar crosses the whole range; gas is ignored; the taker on the same schedule pays the pool's fee and no impact (this favours the taker). Programmes: standing = the standing sell order (RF-only book); grid = the two-sided grid at the live gates ($500 + $500); gridLoose = the 2026-09-23 sweep's loosened setting (10% step, trend limit off, 3 swings, no drawdown stop, replay check on), whose in-sample result this is meant to test forward.`, ``];
  const usable = results.filter((r) => r.sim.standing && !r.sim.standing.broken);
  for (const s of STRATS) {
    const rows = usable.map((r) => r.sim[s]).filter(Boolean);
    lines.push(`- **${s}**: ${rows.length} pools, vs taker on the same schedule median ${pc(med(rows.map((x) => x.vsTaker)))} (beat ${rows.filter((x) => x.vsTaker > 0).length}, lost ${rows.filter((x) => x.vsTaker < 0).length}, flat ${rows.filter((x) => x.vsTaker === 0).length}), vs hold median ${pc(med(rows.map((x) => x.vsHold)))}, fills ${rows.reduce((a, x) => a + x.fills, 0)}, per unit vs taker median ${pc(med(rows.map((x) => x.perUnitMedian)))}`);
  }
  const allFills = usable.flatMap((r) => (r.sim.standing?.fillList ?? []).map((f) => f.perUnitVsTaker)).sort((a, b) => a - b);
  if (allFills.length) lines.push(``, `**Every standing-order fill so far:** ${allFills.length} fills on ${usable.filter((r) => r.sim.standing?.fills).length} pools; per unit vs a taker at placement: median ${pc(allFills[allFills.length >> 1])}, worst ${pc(allFills[0])}, best ${pc(allFills.at(-1))}, ${allFills.filter((x) => x > 0).length} of ${allFills.length} positive. Filled pools vs a taker on the same schedule: ${usable.filter((r) => r.sim.standing?.fills).map((r) => `${r.p.label} ${pc(r.sim.standing.vsTaker)}`).join(", ")}.`);
  lines.push(``, `| pool | launchpad | fee | type | vol 24h | hours | price since start | standing vs taker / vs hold / fills / open | grid vs taker / vs hold / fills | gridLoose vs taker / vs hold / fills | last standing decision |`, `| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |`);
  for (const r of results) {
    const s = r.sim.standing, g = r.sim.grid, l = r.sim.gridLoose;
    const cell = (x, withOpen = false) => x?.broken && x.fills == null ? "pool drained before any bar" : x ? `${pc(x.vsTaker)} / ${pc(x.vsHold)} / ${x.fills}${withOpen ? ` / ${x.open.join(" ") || "none"}` : ""}${x.brokeAt ? ` (pool drained ${new Date(x.brokeAt * 1000).toISOString().slice(11, 16)}Z; replay stops there)` : ""}` : (r.bars.lastError ? "no bars" : "warming up");
    lines.push(`| ${r.p.label} | ${r.p.launchpad} | ${(r.p.fee * 100).toFixed(2)}% | ${r.p.type} | $${Math.round(r.bars.vol24 ?? 0).toLocaleString("en-US")} | ${s ? s.hours.toFixed(1) : "0"} | ${s ? pc(s.priceChange) : "n/a"} | ${cell(s, true)} | ${cell(g)} | ${cell(l)} | ${s?.lastDecision ?? ""} |`);
  }
  lines.push(``, `## Reading it`, ``,
    `- "vs taker on the same schedule" isolates execution: the same decisions, routed as a taker. Positive means resting the order beat swapping. "vs hold" is direction and says nothing about the programme.`,
    `- A pool with 0 fills has not been crossed yet; the standing order rests 1.9% to 3.1% above the market, so a quiet hour cannot fill it. Fills need buyers.`,
    `- Type B pools tax the maker's deposit; the 2026-09-23 sweep found every maker design loses there, and they are here to show it live.`,
    `- The unidentified Robinhood launch hooks are compared against a 0.3% taker fee only, because their hook skim is not known; that understates the edge there.`,
    ``, `Decision log: data/paper/log.jsonl (one line per new decision). Bars: data/paper/bars/.`);
  fs.writeFileSync(path.join(DIR, "report.md"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(DIR, "report.json"), JSON.stringify({ startedAt: startTs, at: now, tick: state.ticks, pools: results.map((r) => ({ label: r.p.label, launchpad: r.p.launchpad, fee: r.p.fee, type: r.p.type, vol24: r.bars.vol24, sim: Object.fromEntries(STRATS.map((s) => [s, r.sim[s] ? { ...r.sim[s], decisions: undefined } : null])) })) }, null, 1));
}

/* ------------------------------------------------------------------ main */
async function tick(fetchBars = true) {
  if (!state.startedAt) state.startedAt = Math.floor(Date.now() / 60_000) * 60;
  const startTs = state.startedAt;
  const results = [];
  for (const p of universe) {
    const d = fetchBars ? await refresh(p) : loadBars(p);
    const sim = {};
    for (const s of STRATS) { try { sim[s] = simulate(p, d, startTs, s); } catch (e) { sim[s] = null; d.lastError = `${s}: ${e.message}`; } }
    results.push({ p, bars: d, sim });
    for (const s of STRATS) for (const line of sim[s]?.decisions ?? []) {
      const key = `${line.t}|${line.pool}|${line.strat}|${line.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fs.appendFileSync(path.join(DIR, "log.jsonl"), JSON.stringify(line) + "\n");
    }
    process.stdout.write(`  ${p.label.padEnd(10)} ${String(d.minute.length).padStart(5)} min bars, ${String(d.hourly.length).padStart(4)} hourly, quote $${d.quoteUsd ?? "?"}${d.lastError ? `  ${d.lastError}` : ""}\n`);
  }
  state.ticks++;
  state.seen = [...seen].slice(-20_000);
  fs.writeFileSync(statePath, JSON.stringify(state));
  report(results, startTs);
  console.log(`tick ${state.ticks} done at ${new Date().toISOString()}; report at ${path.join(DIR, "report.md")}`);
}

if (has("--report")) await tick(false);
else if (has("--loop")) { const every = Number(val("--loop") ?? 900) * 1000; for (;;) { const t0 = Date.now(); try { await tick(); } catch (e) { console.error("tick failed:", e.message); } await new Promise((r) => setTimeout(r, Math.max(10_000, every - (Date.now() - t0)))); } }
else await tick();
