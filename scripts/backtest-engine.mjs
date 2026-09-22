/**
 * Shared backtest plumbing: the real tape, and a concentrated-liquidity pool that
 * holds the Market's full-range position plus the bank's range orders.
 *
 * The price path is ENDOGENOUS. Every historical taker intent (the pool-side amount
 * it pushed in) is replayed through the combined liquidity, so the bank's ranges
 * absorb flow and change the path. Replaying the historical price while letting the
 * bank absorb the flow that made it is the free lunch an earlier version reported.
 *
 * lpFee = 0 (MEASURED on every swap), so no fee accrues to any range. The 5% hook
 * fee is paid by takers and never touches liquidity; it is tracked only as what
 * the reward stream receives.
 */
import fs from "node:fs";

export const FEE = 0.05;                                        // MEASURED Hook.FEE_BPS
export const L_MARKET = 147865847752143433133351n;              // MEASURED Market seed = 100% of pool liquidity
const priceOf = (sq) => { const p = Number(sq) / 2 ** 96; return p * p; };

/** Load data/swaps.json as taker intents in block order. Swapper-delta convention, proved 42/42 in backtest.mjs. */
export function loadTape(file = "data/swaps.json") {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const swaps = raw.swaps.slice().sort((a, b) => a.b - b.b);
  // Timestamps: the fetcher stamps each swap with its 100k-block bucket start. Fit a line
  // through those (block, time) pairs so every swap gets its own time, not its bucket's.
  const pairs = new Map();
  for (const s of swaps) if (s.t) pairs.set(Math.floor(s.b / 100000) * 100000, s.t);
  const P = [...pairs.entries()];
  const mb = P.reduce((a, p) => a + p[0], 0) / P.length, mt = P.reduce((a, p) => a + p[1], 0) / P.length;
  const den = P.reduce((a, p) => a + (p[0] - mb) ** 2, 0);
  const slope = den > 0 ? P.reduce((a, p) => a + (p[0] - mb) * (p[1] - mt), 0) / den : 0.1008;
  const tOf = (b) => mt + (b - mb) * slope;
  let prev = null;
  const tape = swaps.map((s) => {
    const p = priceOf(BigInt(s.sq));
    const e = {
      b: s.b, t: tOf(s.b), buy: BigInt(s.a0) > 0n,
      rf: Math.abs(Number(s.a0)) / 1e18, weth: Math.abs(Number(s.a1)) / 1e18,
      px: p, pxBefore: prev ?? p,
    };
    prev = p; return e;
  });
  return { tape, secPerBlock: slope, meta: { swaps: tape.length, firstBlock: swaps[0]?.b, lastBlock: swaps.at(-1)?.b } };
}

/** Full-range Market liquidity plus arbitrary bank ranges, in sqrt-price space. */
export function makePool(price, Lm = Number(L_MARKET) / 1e18) {
  const pos = new Map(); let id = 0;
  const S = { s: Math.sqrt(price), Lm, pos, feesWeth: 0 };
  const Lat = (up) => { let L = S.Lm; for (const p of pos.values()) if (up ? (p.sa <= S.s && S.s < p.sb) : (p.sa < S.s && S.s <= p.sb)) L += p.L; return L; };
  const nextUp = () => { let n = Infinity; for (const p of pos.values()) { if (p.sa > S.s && p.sa < n) n = p.sa; if (p.sb > S.s && p.sb < n) n = p.sb; } return n; };
  const nextDn = () => { let n = 0; for (const p of pos.values()) { if (p.sa < S.s && p.sa > n) n = p.sa; if (p.sb < S.s && p.sb > n) n = p.sb; } return n; };
  S.price = () => S.s * S.s;
  /** WETH into the pool (pool side, after the hook). Returns RF out. */
  S.wethIn = (dy) => {
    S.feesWeth += dy / (1 - FEE) * FEE;
    let out = 0;
    while (dy > 1e-18) {
      const L = Lat(true), nx = nextUp(), ds = dy / L;
      if (S.s + ds <= nx) { out += L * (1 / S.s - 1 / (S.s + ds)); S.s += ds; dy = 0; }
      else { out += L * (1 / S.s - 1 / nx); dy -= L * (nx - S.s); S.s = nx; }
    }
    return out;
  };
  /** RF into the pool. Returns WETH out, pool side (the taker then pays 5% of it). */
  S.rfIn = (dx) => {
    let out = 0;
    while (dx > 1e-12) {
      const L = Lat(false), nx = nextDn(), s1 = 1 / (1 / S.s + dx / L);
      if (s1 >= nx) { out += L * (S.s - s1); S.s = s1; dx = 0; }
      else { dx -= L * (1 / nx - 1 / S.s); out += L * (S.s - nx); S.s = nx; }
    }
    S.feesWeth += out * FEE;
    return out;
  };
  S.add = (lo, hi, L) => { const k = ++id; pos.set(k, { sa: Math.sqrt(lo), sb: Math.sqrt(hi), L }); return k; };
  S.amounts = (k) => {
    const p = pos.get(k), s = S.s;
    if (s <= p.sa) return { rf: p.L * (1 / p.sa - 1 / p.sb), weth: 0 };
    if (s >= p.sb) return { rf: 0, weth: p.L * (p.sb - p.sa) };
    return { rf: p.L * (1 / s - 1 / p.sb), weth: p.L * (s - p.sa) };
  };
  S.remove = (k) => { const a = S.amounts(k); pos.delete(k); return a; };
  return S;
}

/** Realisable value: flatten RF through a COPY of the pool at 5% + impact. */
export function liquidate(pool, rf, weth) {
  if (rf <= 0) return weth;
  const s0 = pool.s, f0 = pool.feesWeth, bak = new Map(pool.pos);
  const out = pool.rfIn(rf) * (1 - FEE);
  pool.s = s0; pool.feesWeth = f0; pool.pos.clear(); for (const [k, v] of bak) pool.pos.set(k, v);
  return weth + out;
}

/** Deterministic PRNG so every synthetic run is reproducible. */
export function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return { rnd, gauss };
}

/**
 * Synthetic taker flow: a target mid path (mean-reverting around a trending anchor)
 * turned into the trades that would move a Market-only pool along it. The bank is
 * then replayed against those INTENTS, so its liquidity changes the path it sees.
 */
export function syntheticTape({ days, stepMin = 5, sigma, pull, trendPerDay = 0, seed, p0 = 5.8e-7 }) {
  const { gauss } = rng(seed);
  const base = makePool(p0);
  const n = Math.round((days * 1440) / stepMin), perStep = Math.pow(1 + trendPerDay, stepMin / 1440) - 1;
  const out = []; let target = p0, anchor = p0;
  for (let i = 0; i < n; i++) {
    anchor *= 1 + perStep;
    target = target * Math.exp(-pull * Math.log(target / anchor) + sigma * gauss()) * (1 + perStep);
    const before = base.price(), sT = Math.sqrt(target), L = base.Lm;
    if (sT > base.s) { const dy = L * (sT - base.s); base.wethIn(dy); out.push({ t: i * stepMin * 60, buy: true, weth: dy, rf: 0, px: base.price(), pxBefore: before }); }
    else if (sT < base.s) { const dx = L * (1 / sT - 1 / base.s); base.rfIn(dx); out.push({ t: i * stepMin * 60, buy: false, weth: 0, rf: dx, px: base.price(), pxBefore: before }); }
  }
  return out;
}

/* ================================================================== the desk itself */
import {
  DEFAULT_GATES, COSTS, evaluateRegime, measurePath, openingLadder, flipRange, contractOk,
  liquidityForRf, liquidityForWeth,
} from "../lib/strategy.mjs";

/**
 * Run the live strategy against a tape, endogenously. Every hour the desk re-reads
 * the SIMULATED market (not the historical one) through measurePath + evaluateRegime,
 * exactly as app/lib/desk.ts does live, then:
 *   armed, no ranges   -> place the opening ladder (openingLadder)
 *   not armed / halted -> cancel unfilled bids, leave loss-locked asks resting
 * After every swap, any range the price has fully crossed is flipped (flipRange).
 * Every open is checked against the contract's rules (contractOk: loss-lock on the
 * book-wide cost basis, TWAP edge, 1-15% size) plus its rolling-day limits (24 ops,
 * 50% of a side) and 7-day expiry. A refused open is counted, never forced.
 * `alwaysArmed` is a COUNTERFACTUAL: it ignores the three regime gates (not the risk
 * gates) to show what the arming rule is protecting the book from.
 */
export function simulateDesk(tape, { rf0, weth0, ethUsd = 2736, gates = DEFAULT_GATES, alwaysArmed = false }) {
  const pool = makePool(tape[0].pxBefore);
  let rf = rf0, weth = weth0, gas = 0, flips = 0, refused = 0, deferred = 0, halted = false;
  let ranges = [];
  const hourly = [], ticks = [];
  let hwmRatio = 1, armedHours = 0, hours = 0;
  const blockers = {};
  let nextHour = Math.ceil(tape[0].t / 3600) * 3600;
  // The contract's book-level state: size-weighted cost of RF the desk BOUGHT (harvested
  // RF has none), the VWAP of the last ask it closed, and rolling-day op/turnover logs.
  let costRf = 0, costWeth = 0, lastSellVwap = null, twap = tape[0].pxBefore, now = tape[0].t;
  const ops = [], opened = { ask: [], bid: [] };
  const book = () => ({ avgCost: costRf > 0 ? costWeth / costRf : 0, lastSellVwap });
  const trim = (arr) => { while (arr.length && arr[0].t < now - 86400) arr.shift(); };
  const bookValue = () => {
    let r = rf, w = weth;
    for (const x of ranges) { const a = pool.amounts(x.k); r += a.rf; w += a.weth; }
    return { r, w, v: w + r * pool.price() };
  };
  // The contract sizes each range against that side's IDLE book at placement.
  const sideValue = (side) => (side === "ask" ? rf : weth);
  /** Open one range if every contract rule allows it right now. */
  const open = (x) => {
    trim(ops); trim(opened.ask); trim(opened.bid);
    if (ranges.some((r) => r.side === x.side)) return false;   // one ask and one bid at most (RangeOpen)
    const size = x.side === "ask" ? x.rf : x.weth, sv = sideValue(x.side);
    const usedToday = opened[x.side].reduce((s2, o) => s2 + o.frac, 0);
    if (ops.length >= gates.maxOpsPerDay || usedToday + size / sv > gates.maxDailySideFrac + 1e-9) { deferred++; return false; }
    if (!contractOk(x, { spot: pool.price(), twap, sideValue: sv }, gates, book())) { refused++; return false; }
    if (x.side === "ask" ? size > rf + 1e-18 : size > weth + 1e-18) return false;
    const L = x.side === "ask" ? liquidityForRf(x.lo, x.hi, x.rf) : liquidityForWeth(x.lo, x.hi, x.weth);
    if (!(L > 0)) return false;
    if (x.side === "ask") rf -= x.rf; else weth -= x.weth;
    ranges.push({ ...x, k: pool.add(x.lo, x.hi, L), t: now });
    ops.push({ t: now }); opened[x.side].push({ t: now, frac: size / sv });
    gas += COSTS.gasUsdPerFlip / 2;
    return true;
  };
  const close = (x) => {
    const a = pool.remove(x.k); rf += a.rf; weth += a.weth; ops.push({ t: now }); gas += COSTS.gasUsdPerFlip / 2;
    ranges = ranges.filter((r) => r !== x);
    return a;
  };

  const hourTick = (t) => {
    now = t;
    const mid = pool.price();
    twap = hourly.length ? (hourly[hourly.length - 1] + mid) / 2 : mid;   // CHOICE: a 1h TWAP proxy
    hourly.push(mid);
    hours++;
    const cut = t - 72 * 3600;
    while (ticks.length && ticks[0].t < cut) ticks.shift();
    const m = measurePath(hourly, gates, hourly.length > 72 ? [hourly[hourly.length - 73], ...ticks.map((q) => q.p)] : null);
    const bv = bookValue();
    // Drawdown vs HOLDING the opening book, so an RF slide the desk never traded cannot trip it.
    const holdNow = weth0 + rf0 * mid;
    hwmRatio = Math.max(hwmRatio, bv.v / holdNow);
    const bk = { rf: bv.r, weth: bv.w, valueWeth: bv.v, hwmWeth: hwmRatio * holdNow, halted };
    const regime = evaluateRegime({ ...m, mid, ethUsd }, bk, gates);
    // Counterfactual only: the same grid with the arming rule switched off (risk gates stay).
    if (alwaysArmed) regime.armed = regime.checks.every((c) => c.ok || ["reversals72h", "drift72h", "walkForward7d"].includes(c.gate));
    if (regime.checks.find((c) => c.gate === "drawdown")?.status === "blocking") halted = true;
    // Ranges past the contract's expiry can be closed by anyone; the keeper closes them first.
    for (const x of ranges.filter((r) => now - r.t > gates.rangeExpiryDays * 86400)) close(x);
    if (regime.armed && !halted) {
      armedHours++;
      // Open (or top up) the ladder from free balances, beyond whatever is already resting.
      const asks = ranges.filter((r) => r.side === "ask"), bids = ranges.filter((r) => r.side === "bid");
      const { ranges: add } = openingLadder(mid, { rf, weth }, { ethUsd, hourlyVol: m.hourlyVol, twap }, gates, {
        asksOpen: asks.length, bidsOpen: bids.length, askSide: rf, bidSide: weth, lastSellVwap,
        askFrom: asks.length ? Math.max(...asks.map((r) => r.hi)) : undefined,
        bidFrom: bids.length ? Math.min(...bids.map((r) => r.lo)) : undefined,
        avgCost: book().avgCost,
      });
      for (const x of add) open(x);
    } else {
      for (const c of regime.checks) if (!c.ok) blockers[c.gate] = (blockers[c.gate] ?? 0) + 1;
      for (const x of ranges.filter((r) => r.side === "bid")) close(x);
    }
  };

  for (const e of tape) {
    while (e.t >= nextHour) { hourTick(nextHour); nextHour += 3600; }
    now = e.t;
    e.buy ? pool.wethIn(e.weth) : pool.rfIn(e.rf);
    ticks.push({ t: e.t, p: pool.price() });
    const px = pool.price();
    for (const x of [...ranges]) {
      if (!(x.side === "ask" ? px >= x.hi : px <= x.lo)) continue;
      trim(ops);
      if (ops.length + 2 > gates.maxOpsPerDay) { deferred++; continue; }   // leave it resting, converted
      const allRf = bookValue().r;
      const a = close(x);
      if (x.side === "bid") { costRf += a.rf; costWeth += x.weth; }
      else { const f = Math.min(1, x.rf / Math.max(allRf, 1e-18)); costRf *= 1 - f; costWeth *= 1 - f; lastSellVwap = a.weth / x.rf; }
      // A filled bid is not re-bid while the desk is off or halted: its RF waits as a locked ask.
      const n = flipRange(x, gates, book());
      const sized = n.side === "ask" ? { ...n, rf: a.rf } : { ...n, weth: a.weth };
      if (n.side === "bid" && halted) continue;
      if (open(sized)) flips++;
    }
  }
  for (const x of [...ranges]) close(x);
  const realisable = liquidate(pool, rf, weth) - gas / ethUsd;
  const base = makePool(tape[0].pxBefore);
  for (const e of tape) e.buy ? base.wethIn(e.weth) : base.rfIn(e.rf);
  const hold = liquidate(base, rf0, weth0);
  return {
    hours, armedHours, flips, refused, deferred, gasUsd: gas, halted, blockers,
    endRf: rf, endWeth: weth, realisable, hold, vsHold: realisable / hold - 1,
    p0: tape[0].pxBefore, pEnd: pool.price(), pBase: base.price(),
    feesToFriendsWeth: pool.feesWeth, baseFeesWeth: base.feesWeth,
    lastRegimeInputs: measurePath(hourly, gates),
  };
}

/**
 * Hourly closes of a tape, hour-aligned: closes[i] is the price after the last swap
 * at or before startTs + i*3600. The live desk ships these for everything older than
 * its own 72h scan, because this RPC serves old blocks slowly (a 7-day getLogs scan
 * did not finish in 170 s on 2026-09-22) while the last 72h scans in seconds.
 */
export function hourlyCloses(tape) {
  const startTs = Math.ceil(tape[0].t / 3600) * 3600;
  const closes = [];
  let i = 0, p = tape[0].pxBefore;
  for (let h = startTs; h <= tape.at(-1).t; h += 3600) {
    while (i < tape.length && tape[i].t <= h) p = tape[i++].px;
    closes.push(p);
  }
  return { startTs, closes, lastTs: startTs + (closes.length - 1) * 3600, lastBlock: tape.at(-1).b };
}
