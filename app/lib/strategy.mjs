/**
 * The First Bank of Friends desk: a MAKER-ONLY range-order grid, off by default.
 *
 * Why maker-only. The pool's hook takes 5% of every SWAP and has no liquidity
 * callbacks (FLAGS 0x20cc: no beforeAddLiquidity, no beforeRemoveLiquidity). A v4
 * range order is liquidity, not a swap, so the bank never pays the toll. Takers who
 * cross the bank's ranges still pay 5% to every activated Friend. The old taker
 * grid needed a 10.80% step just to break even; a maker grid breaks even at gas.
 *
 * Why it is still OFF most of the time. With the toll removed, a maker grid was
 * replayed through the pool's real history and LOST to holding in every window
 * (-5% to -80%), while the same engine made +49% on synthetic chop. The toll was
 * never the binding constraint; the trend is. So the desk arms only when the market
 * has recently swung back and forth, and a replay of the last week agrees:
 *
 *   gate            rule                                           why
 *   ============    =============================================  ==============================
 *   reversals72h    >= 6 completed swings of at least one step      a grid earns only on swings
 *   drift72h        |72h drift| < 2 steps                          a trend fills one side only
 *   walkForward7d   the same grid replayed on the last 7 days       the rule has to have worked
 *                   beats holding                                   on the tape it is about to trade
 *   inventory       RF under 60% of the book; bids sized to a       the flow ran one-way before
 *                   volatility-scaled cap
 *   drawdown        within 15% of its best point vs holding         the unknown unknown
 *   breaker         not manually halted                             a human can always stop it
 *
 * Every fill is LOSS-LOCKED: RF is never offered below what it cost x (1 + lock),
 * and never bought back above what it sold for x (1 - lock). RangeDesk.sol enforces
 * the same constant on chain, so a bug here cannot sell at a loss.
 *
 * A gate whose input is missing is UNMEASURED, not failed and not passed. The desk
 * does not arm on a gate it cannot measure, and the UI says "not yet measurable".
 *
 * This module is PURE and shared by the backtests, the live desk API and the hall,
 * so the thing that decides in simulation is literally the thing that decides live.
 */

/** Costs, all measured on Robinhood Chain. See docs/ECONOMICS.md. */
export const COSTS = Object.freeze({
  hookFeeBps: 500,          // MEASURED: 5% per side, Hook.FEE_BPS, paid by TAKERS only
  fee: 0.05,
  openseaFeeBps: 100,       // MEASURED: 1%, read from a real order's consideration
  gasUsdPerFill: 0.033,     // MEASURED: 209k gas @ 0.057 gwei, ETH $2,735, from 8 real swap txs
  gasUsdPerFlip: 0.07,      // CHOICE: remove + re-add one range in one unlock, ~2x a measured swap
});

/**
 * Break-even step for a TAKER grid: buying W WETH of RF and selling it back a
 * fraction s higher returns W(1-f)^2(1+s), so s > 1/(1-f)^2 - 1 = 10.80% at f = 5%.
 * Kept because it is the reason the desk is maker-only.
 */
export const BREAKEVEN_STEP = 1 / (1 - 0.05) ** 2 - 1;

/** What a TAKER round trip nets at a given step, after both tolls. */
export const edgePerRoundTrip = (step, fee = COSTS.fee) => (1 - fee) ** 2 * (1 + step) - 1;

/**
 * What a MAKER round trip nets before gas, under the loss-lock. A bid range filled at
 * average a is re-offered from a(1+lock) up one step, so it sells at an average of
 * a(1+lock)(1+step)^0.5: the lock is a floor on the edge, not the whole edge.
 */
export const makerEdgePerRoundTrip = (step, lock = step) => (1 + lock) * Math.sqrt(1 + step) - 1;

/** Kept for the hall and older callers: the vol a grid needs to traverse R round trips a week. */
export const volFloorFor = (step, roundTripsPerWeek) => step * Math.sqrt((2 * roundTripsPerWeek) / 168);

/**
 * Inventory ceiling from the Avellaneda-Stoikov inventory-risk term. Tolerating a
 * loss of L of book to a Z-sigma move over horizon H hours gives w <= L/(Z*sigma*sqrt(H)).
 */
export const inventoryCapFor = (hourlyVol, { lossTolerance = 0.10, z = 2, horizonHours = 72 } = {}) =>
  Math.max(0.05, Math.min(0.95, lossTolerance / (z * Math.max(hourlyVol, 0.005) * Math.sqrt(horizonHours))));

/**
 * Default parameters. Labelled so nobody has to guess which were measured.
 */
export const DEFAULT_GATES = Object.freeze({
  // the grid
  gridStep: 0.05,              // CHOICE: wide enough that a swing is a swing, not noise
  rungs: 2,                    // CONTRACT: RangeDesk holds at most ONE ask range and ONE bid range at a time
  tickSpacing: 60,             // MEASURED: the pool's tickSpacing (Market.seed full range 887220)

  // the contract's rules (RangeDesk in RangeDesk.sol), mirrored so the strategy never
  // asks for anything the contract would revert. Values are the contract's constants.
  lockBps: 500,                // RangeDesk.LOCK_BPS: ask priceLower >= avgCost x 1.05; bid priceUpper <= lastSellVWAP x 0.95
  twapEdgeTicks: 100,          // every range at least 100 ticks beyond the observer TWAP, on the correct side of spot
  minRangeFrac: 0.01,          // each range 1% to 15% of that side's IDLE balance at placement
  maxRangeFrac: 0.15,
  maxDailySideFrac: 0.50,      // at most 50% of each side opened per rolling day
  maxOpsPerDay: 24,            // opens + closes per rolling day (a flip is two)
  rangeExpiryDays: 7,          // anyone may close a range older than this
  bidLockLapseDays: 30,        // the bid lock lapses 30 days after the last sale

  // the arming rule
  minReversals72h: 6,          // CHOICE: two completed swings a day; today: 2 at 5% (MEASURED 2026-09-22)
  maxDrift72hSteps: 2,         // CHOICE: |72h drift| < 2 x gridStep = 10%; today: -23.7%
  minWalkForwardEdge: 0,       // CHOICE: the replay must strictly beat holding

  // risk
  maxInventoryFrac: 0.60,      // ceiling; the live cap is volatility-scaled by inventoryCapFor
  maxDrawdown: 0.15,           // CHOICE: hard stop, manual reset
  maxFlipsPerHour: 6,          // CHOICE: no death by a thousand gas fees (the contract's 24 ops/day binds first)
  // DERIVED: a rung must earn k x its gas. It earns at least lockBps on its notional,
  // so notional >= k * gasUsdPerFlip / lock. At k = 5 and a 5% lock that is $7.00.
  gasMarginK: 5,
});

/** Human names for every gate. The dashboard and the hall read these. */
export const GATE_LABELS = Object.freeze({
  reversals72h: "swings in 72h",
  drift72h: "trend over 72h",
  walkForward7d: "last week replayed",
  inventory: "inventory",
  drawdown: "drawdown",
  breaker: "breaker",
});

/**
 * Which live input feeds each gate. scripts/check-lib-sync.mjs asserts that the
 * live desk (app/lib/desk.ts) supplies every `market.*` input listed here, because
 * a gate with no live input can never pass and the desk silently never arms.
 */
export const GATE_INPUTS = Object.freeze({
  reversals72h: ["market.reversals72h"],
  drift72h: ["market.drift72h"],
  walkForward7d: ["market.walkForward7d"],
  inventory: ["market.mid", "book.rf", "book.valueWeth"],
  drawdown: ["book.valueWeth", "book.hwmWeth"],
  breaker: ["book.halted"],
});

/** Realised volatility of log returns over a window of prices. */
export function realisedVol(prices) {
  if (!prices || prices.length < 3) return 0;
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (r.length < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}

export function drift(prices) {
  if (!prices || prices.length < 2) return 0;
  const a = prices[0], b = prices[prices.length - 1];
  return a > 0 ? (b - a) / a : 0;
}

/**
 * Completed zigzag reversals of at least `step`: a move of `step` from the last
 * extreme in the direction opposite to the previous one. This is the only thing a
 * grid of that step can earn from, so it is counted directly rather than inferred
 * from volatility (volatility counts a one-way slide as opportunity; this does not).
 */
export function countReversals(prices, step) {
  if (!prices || prices.length < 2) return 0;
  let ext = prices[0], dir = 0, n = 0;
  for (const p of prices) {
    if (dir >= 0) {
      if (p > ext) ext = p;
      else if (p < ext / (1 + step)) { if (dir === 1) n++; dir = -1; ext = p; }
    } else {
      if (p < ext) ext = p;
      else if (p > ext * (1 + step)) { n++; dir = 1; ext = p; }
    }
  }
  return n;
}

/* =============================================================== range-order maths */

/** Snap a price (WETH per RF) to the pool's tick grid, rounding AGAINST the bank. */
export function snapPrice(price, tickSpacing = DEFAULT_GATES.tickSpacing, direction = "down") {
  const t = Math.log(price) / Math.log(1.0001);
  const k = direction === "up" ? Math.ceil(t / tickSpacing) : Math.floor(t / tickSpacing);
  return 1.0001 ** (k * tickSpacing);
}

/** Amounts held by a range [lo, hi] of liquidity L at price p (prices in WETH per RF). */
export function rangeAmounts(lo, hi, L, p) {
  const a = Math.sqrt(lo), b = Math.sqrt(hi), s = Math.sqrt(p);
  if (s <= a) return { rf: L * (1 / a - 1 / b), weth: 0 };
  if (s >= b) return { rf: 0, weth: L * (b - a) };
  return { rf: L * (1 / s - 1 / b), weth: L * (s - a) };
}

/** Liquidity for an ask (all RF, range above price) or a bid (all WETH, range below). */
export const liquidityForRf = (lo, hi, rf) => rf / (1 / Math.sqrt(lo) - 1 / Math.sqrt(hi));
export const liquidityForWeth = (lo, hi, weth) => weth / (Math.sqrt(hi) - Math.sqrt(lo));

/** Average price a fully crossed range fills at: the geometric mean of its edges. */
export const rangeAvgPrice = (lo, hi) => Math.sqrt(lo * hi);

/**
 * THE LOSS-LOCK. The same inequality RangeDesk.sol checks on chain.
 * An ask may not start below costBasis x (1 + lock); a bid may not end above
 * lastSell x (1 - lock). A range with no basis (the opening ladder) is exempt,
 * because it is not selling anything the desk bought.
 */
export function lockOk(range, gates = DEFAULT_GATES, book = {}) {
  const lock = gates.lockBps / 10_000;
  // The contract locks asks against the SIZE-WEIGHTED cost of all RF the desk bought
  // (harvested RF has no basis), and bids against the VWAP of the last ask it closed.
  const askBasis = Math.max(range.basis ?? 0, book.avgCost ?? 0);
  const bidBasis = range.basis ?? book.lastSellVwap ?? null;
  if (range.side === "ask") return askBasis === 0 || range.lo >= askBasis * (1 + lock) * (1 - 1e-12);
  return bidBasis == null || range.hi <= bidBasis * (1 - lock) * (1 + 1e-12);
}

/**
 * Every per-range rule the contract enforces, so a plan that passes here cannot revert
 * there: loss-lock, correct side of spot, at least twapEdgeTicks beyond the TWAP, and a
 * size between minRangeFrac and maxRangeFrac of that side. The contract can also let an
 * ask sell below its lock out of a small loss budget; the strategy never asks it to.
 */
export function contractOk(range, { spot, twap, sideValue }, gates = DEFAULT_GATES, book = {}) {
  if (!lockOk(range, gates, book)) return false;
  const edge = 1.0001 ** gates.twapEdgeTicks;
  const t = twap ?? spot;
  if (range.side === "ask" && !(range.lo > spot && range.lo >= t * edge)) return false;
  if (range.side === "bid" && !(range.hi < spot && range.hi <= t / edge)) return false;
  if (sideValue > 0) {
    const size = range.side === "ask" ? range.rf : range.weth;
    if (size != null && (size > sideValue * gates.maxRangeFrac * (1 + 1e-9) || size < sideValue * gates.minRangeFrac)) return false;
  }
  return true;
}

/**
 * Flip a fully crossed range to the other side, one step away, loss-locked.
 * A filled bid (now RF, bought at avg a) becomes an ask [a(1+lock), a(1+lock)(1+step)].
 * A filled ask (now WETH, sold at avg a) becomes a bid [a(1-lock)/(1+step), a(1-lock)].
 */
export function flipRange(range, gates = DEFAULT_GATES, book = {}) {
  const g = gates.gridStep, lock = gates.lockBps / 10_000;
  const avg = rangeAvgPrice(range.lo, range.hi);
  if (range.side === "bid") {
    // The contract's basis is the book-wide average cost after this fill, not this range's.
    const lo = snapPrice(Math.max(avg, book.avgCost ?? 0) * (1 + lock), gates.tickSpacing, "up");
    return { side: "ask", lo, hi: lo * (1 + g), basis: avg };
  }
  const hi = snapPrice(avg * (1 - lock), gates.tickSpacing, "down");
  return { side: "bid", lo: hi / (1 + g), hi, basis: avg };
}

/**
 * The opening ladder around mid: asks above, bids below, one step wide each.
 * Sizes are split evenly; a caller that cannot afford `minRungUsd` per rung gets
 * fewer rungs, never smaller ones.
 */
export function openingLadder(mid, book, market, gates = DEFAULT_GATES, opts = {}) {
  const g = gates.gridStep;
  const minRungUsd = (gates.gasMarginK * COSTS.gasUsdPerFlip) / (gates.lockBps / 10_000);
  const usd = (weth) => weth * (market.ethUsd ?? 0);
  const perSide = Math.floor(gates.rungs / 2);
  // Contract limits: each range at most maxRangeFrac of its side, at most maxDailySideFrac
  // of a side opened per day, and every range twapEdgeTicks clear of the TWAP.
  const frac = Math.min(gates.maxRangeFrac, 1 / perSide);
  const perDay = Math.max(1, Math.floor(gates.maxDailySideFrac / frac + 1e-9));
  const edge = 1.0001 ** gates.twapEdgeTicks, twap = market.twap ?? mid;
  // Bids are sized so that if every one fills, RF is still within the vol-scaled cap.
  const value = book.weth + book.rf * mid;
  const cap = market.hourlyVol == null ? 0 : Math.min(gates.maxInventoryFrac, inventoryCapFor(market.hourlyVol));
  const bidBudget = Math.max(0, Math.min(book.weth, cap * value - book.rf * mid));
  const askSide = opts.askSide ?? book.rf, bidSide = opts.bidSide ?? book.weth;
  const askSize = askSide * frac, bidSize = bidSide * frac;
  const nAsk = Math.max(0, Math.min(perSide - (opts.asksOpen ?? 0), perDay, Math.floor(book.rf / askSize || 0),
    usd(askSize * mid) >= minRungUsd ? Infinity : 0));
  const nBid = Math.max(0, Math.min(perSide - (opts.bidsOpen ?? 0), perDay, Math.floor(bidBudget / bidSize || 0),
    usd(bidSize) >= minRungUsd ? Infinity : 0));
  const out = [];
  // Asks never start below the contract's lock on the book-wide cost of bought RF.
  const askLock = (opts.avgCost ?? 0) * (1 + gates.lockBps / 10_000);
  let lo = snapPrice(Math.max(opts.askFrom ?? 0, askLock, Math.max(mid, twap) * edge), gates.tickSpacing, "up");
  for (let i = 0; i < nAsk; i++) { out.push({ side: "ask", lo, hi: lo * (1 + g), rf: askSize, basis: null }); lo *= 1 + g; }
  // Bids never end above the contract's lock on the last ask sale.
  const bidLock = opts.lastSellVwap != null ? opts.lastSellVwap * (1 - gates.lockBps / 10_000) : Infinity;
  let hi = snapPrice(Math.min(opts.bidFrom ?? Infinity, bidLock, Math.min(mid, twap) / edge), gates.tickSpacing, "down");
  for (let i = 0; i < nBid; i++) { out.push({ side: "bid", lo: hi / (1 + g), hi, weth: bidSize, basis: null }); hi /= 1 + g; }
  return { ranges: out, minRungUsd, bidBudget };
}

/**
 * Price-only replay of the desk on a path (oldest first). Used by the arming rule
 * (walk-forward on the trailing week) and by the hall. It assumes a small book that
 * does not move the price; scripts/backtest-gated.mjs runs the ENDOGENOUS version
 * with every contract limit. Like the contract, it holds at most ONE ask and ONE bid,
 * each maxRangeFrac of that side's IDLE balance, re-quoted TWAP-edge ticks off the
 * price whenever its side is empty, and loss-locked against the book's cost basis
 * and last sale. Returns value relative to holding the same opening mix.
 */
export function replayGrid(prices, gates = DEFAULT_GATES) {
  if (!prices || prices.length < 2) return { vsHold: 0, flips: 0 };
  const p0 = prices[0], g = gates.gridStep, lock = gates.lockBps / 10_000;
  const edge = 1.0001 ** gates.twapEdgeTicks;
  let rf = 0.5 / p0, weth = 0.5, costRf = 0, costWeth = 0, lastSell = null, ask = null, bid = null, flips = 0;
  for (const p of prices) {
    if (ask && p >= ask.hi) {                     // filled: all WETH now
      const a = rangeAmounts(ask.lo, ask.hi, ask.L, p);
      const f = Math.min(1, ask.rf / Math.max(rf + ask.rf, 1e-18)); costRf *= 1 - f; costWeth *= 1 - f;
      lastSell = a.weth / ask.rf; weth += a.weth; ask = null; flips++;
    }
    if (bid && p <= bid.lo) {                     // filled: all RF now
      const a = rangeAmounts(bid.lo, bid.hi, bid.L, p);
      costRf += a.rf; costWeth += bid.weth; rf += a.rf; bid = null; flips++;
    }
    if (!ask && rf > 0) {
      const avg = costRf > 0 ? costWeth / costRf : 0;
      const lo = snapPrice(Math.max(p * edge, avg * (1 + lock)), gates.tickSpacing, "up"), hi = lo * (1 + g);
      const size = rf * gates.maxRangeFrac;
      ask = { lo, hi, rf: size, L: liquidityForRf(lo, hi, size) }; rf -= size;
    }
    if (!bid && weth > 0) {
      const hi = snapPrice(Math.min(p / edge, lastSell != null ? lastSell * (1 - lock) : Infinity), gates.tickSpacing, "down"), lo = hi / (1 + g);
      const size = weth * gates.maxRangeFrac;
      bid = { lo, hi, weth: size, L: liquidityForWeth(lo, hi, size) }; weth -= size;
    }
  }
  const pEnd = prices[prices.length - 1];
  let value = weth + rf * pEnd;
  for (const r of [ask, bid]) if (r) { const a = rangeAmounts(r.lo, r.hi, r.L, pEnd); value += a.weth + a.rf * pEnd; }
  const hold = 0.5 + (0.5 / p0) * pEnd;
  return { vsHold: value / hold - 1, flips };
}

/**
 * Every market input the arming rule needs, from a price path.
 * `hourly` is hourly closes, oldest first, ending now. A window the path does not
 * cover comes back null, which the gates report as "not yet measurable".
 * `ticks` (optional) is the swap-level path for the last 72h; when given, swings are
 * counted on it, because hourly closes hide swings that happen inside an hour.
 * @param {number[]} hourly
 * @param {typeof DEFAULT_GATES} [gates]
 * @param {number[] | null} [ticks]
 */
export function measurePath(hourly, gates = DEFAULT_GATES, ticks = null) {
  const n = hourly?.length ?? 0;
  const back = (h) => (n > h ? hourly.slice(n - 1 - h) : null);
  const w72 = back(72), w7d = back(168);
  return {
    mid: n ? hourly[n - 1] : null,
    drift1h: back(1) ? drift(back(1)) : null,
    drift24h: back(24) ? drift(back(24)) : null,
    drift72h: w72 ? drift(w72) : null,
    drift7d: w7d ? drift(w7d) : null,
    hourlyVol: back(24) ? realisedVol(back(24)) : null,
    reversals72h: ticks ? countReversals(ticks, gates.gridStep) : (w72 ? countReversals(w72, gates.gridStep) : null),
    walkForward7d: w7d ? replayGrid(w7d, gates).vsHold : null,
    // The 72h high feeds the standing order's trend brake (a new high means "do not sell at the edge").
    high72h: ticks ? Math.max(...ticks) : (w72 ? Math.max(...w72) : null),
    historyHours: Math.max(0, n - 1),
  };
}

/* ============================================================ the standing sell order */

/**
 * The standing sell order: what the ONE ask slot holds when the two-sided grid is off.
 * Harvested RF is offered as a MAKER just above the market instead of sold as a taker.
 * Measured on the real tape (bank-of-friends-notes/2026-09-23/mm-research.md): a one to
 * two tick-spacing ask past the TWAP edge filled at a median 1.018x to 1.022x the spot at
 * placement, where a taker receives at most 0.95x, about +7% per RF sold. Keeper-only,
 * no contract change: the contract already allows any ask that is beyond spot, beyond the
 * TWAP edge and above the cost of RF the desk BOUGHT (harvested RF has no basis).
 */
export const STANDING = Object.freeze({
  minBookUsd: 50,        // CHOICE: below this gas eats the edge (the $100/day stream lost 0.3% to gas over 72h)
  widthSpacings: 2,      // 1.2%: MEASURED best fill premium in the sweep (w 0.6% to 1.2%; 2% worst everywhere)
  frac: 0.15,            // contract max per placement
  chase: 0.02,           // MEASURED: chase 2% best or tied; 4% often never filled
  brakeDrift24h: 0.10,   // CHOICE: trend brake, UNMEASURED on real data (no rally in the tape)
  releaseDrift24h: 0.03, // CHOICE
  takeProfitLo: 1.10,    // CHOICE: take-profit range [TWAP x 1.10, TWAP x 2.0]
  takeProfitHi: 2.0,
  requoteSeconds: 3600,  // at most one re-quote an hour
});

/** The live inputs the standing order reads. app/lib/desk.ts must supply every one. */
export const STANDING_INPUTS = Object.freeze(["market.mid", "market.ethUsd", "market.drift24h", "market.high72h", "book.rf", "book.valueWeth"]);

/**
 * PURE. Price space (WETH per RF), snapped to the tick grid against the bank.
 *
 *   market: { mid, twap?, ethUsd, drift24h, high72h }
 *   book:   { rf (IDLE RF, the amount an ask can be sized from), weth, valueWeth, avgCost? }
 *   state:  { gridArmed, ask?: { lo, hi, openedAt, mode? }, now }
 *
 * Returns { mode: "grid" | "edge" | "takeProfit" | "idle", reason, place?: { lo, hi, frac }, close?: true, closeWhy? }
 *
 *   grid        the two-sided grid is armed and owns both slots; nothing here
 *   edge        rest STANDING.frac of idle RF one spacing past the TWAP edge, widthSpacings wide;
 *               close and re-place ("chase") once the market has walked more than `chase` away,
 *               at most once an hour
 *   takeProfit  the brake fired (24h drift over brakeDrift24h, or a new 72h high): an edge ask
 *               would sell into a rally, so the slot holds a wide range [TWAP x 1.10, TWAP x 2.0]
 *               instead; it is realised once half crossed, and released once the 24h drift is
 *               back under releaseDrift24h
 *   idle        the idle RF is worth less than minBookUsd, so an order is not worth its gas
 *
 * A brake input that is missing (drift24h or high72h null) is UNMEASURED: the edge programme
 * runs, because selling at the edge is the measured default and the brake is only insurance.
 * The contract stores no mode for an open ask, so when `state.ask.mode` is absent it is
 * inferred: an ask whose lower edge is at or above TWAP x takeProfitLo (less 1%) is take-profit.
 *
 * @param {{ mid: number, twap?: number, ethUsd: number | null, drift24h: number | null, high72h: number | null }} market
 * @param {{ rf: number, weth: number, valueWeth: number, avgCost?: number }} book
 * @param {{ gridArmed?: boolean, now?: number, ask?: { lo: number, hi: number, openedAt: number, mode?: "edge" | "takeProfit" } | null }} [state]
 * @param {typeof DEFAULT_GATES} [gates]
 * @returns {{ mode: "grid" | "edge" | "takeProfit" | "idle", reason: string, place?: { lo: number, hi: number, frac: number }, close?: true, closeWhy?: string }}
 */
export function standingOrder(market, book, state = {}, gates = DEFAULT_GATES) {
  const P = STANDING, S = gates.tickSpacing, lock = gates.lockBps / 10_000;
  if (state.gridArmed) return { mode: "grid", reason: "the two-sided grid is armed and owns both slots" };
  const mid = market.mid, twap = market.twap ?? mid;
  const ask = state.ask ?? null;
  const now = state.now ?? 0;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const brakeMeasured = market.drift24h != null && market.high72h != null;
  const atHigh = market.high72h != null && market.high72h > 0 && mid >= market.high72h;
  const braked = (market.drift24h != null && market.drift24h > P.brakeDrift24h) || atHigh;
  const released = market.drift24h != null && market.drift24h < P.releaseDrift24h && !atHigh;
  const askMode = ask ? (ask.mode ?? (ask.lo >= twap * P.takeProfitLo * 0.99 ? "takeProfit" : "edge")) : null;
  const edgeMul = 1.0001 ** gates.twapEdgeTicks, spacingMul = 1.0001 ** S;
  // The loss-lock on RF the desk BOUGHT; harvested RF has no basis and is never locked.
  const lockLo = book.avgCost > 0 ? snapPrice(book.avgCost * (1 + lock), S, "up") : 0;
  const bookUsd = book.rf * mid * (market.ethUsd ?? 0);

  /* an open take-profit ask: ratchet, release, or keep */
  if (ask && askMode === "takeProfit") {
    if (mid >= Math.sqrt(ask.lo * ask.hi)) {
      return { mode: "takeProfit", reason: "the rally crossed half the take-profit range", close: true, closeWhy: "half crossed: realise and re-place" };
    }
    if (released) {
      return { mode: "edge", reason: `the 24h drift is back to ${pct(market.drift24h)}, under ${pct(P.releaseDrift24h)}`, close: true, closeWhy: "rally over, back to the edge" };
    }
    return { mode: "takeProfit", reason: `a take-profit ask is resting from ${pct(ask.lo / twap - 1)} to ${pct(ask.hi / twap - 1)} above the time-weighted price` };
  }

  /* the brake: an edge ask must not sell into a rally */
  if (braked) {
    if (ask) return { mode: "takeProfit", reason: "rally: the edge ask would sell into it", close: true, closeWhy: "rally: switching the slot to a take-profit ask" };
    if (market.ethUsd == null) return { mode: "idle", reason: "no live ETH/USD, so the size floor cannot be checked" };
    if (bookUsd < P.minBookUsd) return { mode: "idle", reason: `the idle RF is worth $${bookUsd.toFixed(2)}, under the $${P.minBookUsd} floor, so an order is not worth its gas` };
    const lo = Math.max(snapPrice(Math.max(twap * P.takeProfitLo, mid * edgeMul * spacingMul), S, "up"), lockLo);
    const hi = Math.max(snapPrice(twap * P.takeProfitHi, S, "up"), lo * spacingMul);
    const why = atHigh ? "the price is at a new 72h high" : `the 24h drift is ${pct(market.drift24h)}, over ${pct(P.brakeDrift24h)}`;
    return { mode: "takeProfit", reason: `rally (${why}): a take-profit ask instead of selling at the edge`, place: { lo, hi, frac: P.frac } };
  }

  /* the edge programme */
  const edgePrice = Math.max(mid, twap) * edgeMul;
  const loNow = Math.max(snapPrice(edgePrice, S, "up") * spacingMul, lockLo);
  const hiNow = loNow * 1.0001 ** (P.widthSpacings * S);
  const brakeNote = brakeMeasured ? "" : " (the trend brake is not yet measurable, so the edge programme runs by default)";
  if (ask) {
    const age = now - ask.openedAt;
    if (age < P.requoteSeconds) return { mode: "edge", reason: `the edge ask was placed ${(age / 60).toFixed(0)} minutes ago; at most one re-quote an hour${brakeNote}` };
    if (ask.lo > loNow * (1 + P.chase)) {
      return { mode: "edge", reason: `the ask sits ${pct(ask.lo / loNow - 1)} above where the edge is now, beyond the ${pct(P.chase)} chase`, close: true, closeWhy: "chase: the market walked away" };
    }
    return { mode: "edge", reason: `the edge ask is resting ${pct(ask.lo / mid - 1)} above the market${brakeNote}` };
  }
  if (market.ethUsd == null) return { mode: "idle", reason: "no live ETH/USD, so the size floor cannot be checked" };
  if (bookUsd < P.minBookUsd) return { mode: "idle", reason: `the idle RF is worth $${bookUsd.toFixed(2)}, under the $${P.minBookUsd} floor, so an order is not worth its gas` };
  return {
    mode: "edge",
    reason: `resting ${pct(P.frac)} of the idle RF from ${pct(loNow / mid - 1)} to ${pct(hiNow / mid - 1)} above the market${lockLo > 0 && loNow === lockLo ? ", held up by the loss-lock on bought RF" : ""}${brakeNote}`,
    place: { lo: loNow, hi: hiNow, frac: P.frac },
  };
}

/** One sentence for the logs, the dashboard and the hall. */
export function explainStanding(order, market = null) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  switch (order?.mode) {
    case "grid": return "The two-sided grid is armed and holds both slots.";
    case "idle": return `Idle: ${order.reason}.`;
    case "takeProfit":
      if (order.place && market?.mid) return `Rally: a take-profit ask rests from ${pct(order.place.lo / (market.twap ?? market.mid) - 1)} to ${pct(order.place.hi / (market.twap ?? market.mid) - 1)} above the time-weighted price.`;
      return `Rally: ${order.reason}${order.close ? ` (${order.closeWhy})` : ""}.`;
    case "edge":
      if (order.place && market?.mid) return `Resting ${pct(order.place.frac)} of the bank's RF for sale ${pct(order.place.lo / market.mid - 1)} above the market; the buyer who takes it pays 5% to every Friend.`;
      return `Standing order: ${order.reason}${order.close ? ` (${order.closeWhy})` : ""}.`;
    default: return "No standing order.";
  }
}

/**
 * Evaluate every gate and return a full, human-readable verdict.
 * Returns { armed, checks: [{gate, ok, status, label, detail}] }. `status` is
 * "met", "blocking" or "unmeasured"; `ok` is true only for "met".
 */
export function evaluateRegime(market, book, gates = DEFAULT_GATES) {
  const checks = [];
  const add = (gate, value, pass, detail) => {
    const status = value == null || Number.isNaN(value) ? "unmeasured" : pass ? "met" : "blocking";
    checks.push({ gate, ok: status === "met", status, label: GATE_LABELS[gate] ?? gate, detail });
  };
  const g = gates.gridStep, pc = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

  const rev = market.reversals72h;
  add("reversals72h", rev, rev >= gates.minReversals72h,
    rev == null ? "not yet measurable: less than 72h of history"
      : `${rev} completed swings of ${pc(g, 0)} vs min ${gates.minReversals72h}`);

  const d72 = market.drift72h, maxD = gates.maxDrift72hSteps * g;
  add("drift72h", d72, d72 != null && Math.abs(d72) < maxD,
    d72 == null ? "not yet measurable: less than 72h of history" : `${pc(d72)} vs max +/-${pc(maxD, 0)}`);

  const wf = market.walkForward7d;
  add("walkForward7d", wf, wf != null && wf > gates.minWalkForwardEdge,
    wf == null ? "not yet measurable: less than 7 days of history"
      : `the grid would have been ${wf >= 0 ? "+" : ""}${pc(wf)} vs holding over the last 7 days`);

  // The ceiling decides whether the desk arms at all. The tighter, volatility-scaled
  // cap (inventoryCapFor) sizes the BIDS in openingLadder, so a book already heavy in
  // RF quotes asks only and sells down toward the cap instead of being locked out.
  const invFrac = book.valueWeth > 0 ? (book.rf * market.mid) / book.valueWeth : 0;
  add("inventory", invFrac, invFrac <= gates.maxInventoryFrac,
    `${pc(invFrac)} of book in RF vs max ${pc(gates.maxInventoryFrac, 0)}`);

  // Drawdown is measured against HOLDING the same book (callers pass value and
  // high-water mark in those terms), so an RF slide the desk did not trade cannot trip it.
  const dd = book.hwmWeth > 0 ? 1 - book.valueWeth / book.hwmWeth : 0;
  add("drawdown", dd, dd <= gates.maxDrawdown, `${pc(dd)} behind its best point vs holding, max ${pc(gates.maxDrawdown, 0)}`);

  add("breaker", 0, !book.halted, book.halted ? "manually halted" : "clear");

  return { armed: checks.every((c) => c.ok), checks, inventoryFrac: invFrac, drawdown: dd };
}

/**
 * What should the desk's ranges be right now? Pure: returns intent, never acts.
 *
 *  - not armed: cancel every unfilled BID (never buy into a regime we cannot read)
 *    and leave loss-locked ASKS resting (selling at a locked profit is always fine).
 *  - armed with no ranges: place the opening ladder.
 *  - armed with ranges: flip any range the price has fully crossed.
 */
export function nextOrder(market, book, state, gates = DEFAULT_GATES) {
  const regime = evaluateRegime(market, book, gates);
  const ranges = state.ranges ?? [];
  if (!regime.armed) {
    return { action: "stand-down", regime, cancel: ranges.filter((r) => r.side === "bid"), keep: ranges.filter((r) => r.side === "ask") };
  }
  if (ranges.length === 0) {
    const { ranges: open, minRungUsd } = openingLadder(market.mid, book, market, gates);
    if (open.length === 0) return { action: "stand-down", regime, tooSmall: true, minRungUsd };
    return { action: "place", regime, orders: open };
  }
  if ((state.flipsThisHour ?? 0) >= gates.maxFlipsPerHour) return { action: "hold", regime, throttled: true };
  const flips = [];
  for (const r of ranges) {
    const crossed = r.side === "ask" ? market.mid >= r.hi : market.mid <= r.lo;
    if (crossed) { const n = flipRange(r, gates); if (lockOk(n, gates)) flips.push({ from: r, to: n }); }
  }
  return flips.length ? { action: "flip", regime, flips } : { action: "hold", regime };
}

/** One sentence, in words, for the dashboard, the hall and the logs. */
export function explain(regime) {
  if (regime.armed) return "ARMED: the market is swinging, and the desk is quoting both sides.";
  const blocking = regime.checks.filter((c) => c.status === "blocking");
  const unmeasured = regime.checks.filter((c) => c.status === "unmeasured");
  const parts = [];
  if (blocking.length) parts.push(`waiting on ${blocking.map((c) => `${c.label} (${c.detail})`).join("; ")}`);
  if (unmeasured.length) parts.push(`not yet measurable: ${unmeasured.map((c) => c.label).join(", ")}`);
  return `OFF: ${parts.join(". ")}`;
}
