/**
 * The Bank of Friends market maker: a REGIME-GATED grid.
 *
 * Design principle: the default state is FLAT. The desk does not try to make money
 * in every market. It sits on its hands until conditions pay for the risk, then it
 * works a wide grid, then it stands down again.
 *
 * Every gate here was derived from a measured failure in the backtests, not invented:
 *
 *   gate            derived from
 *   ------------    -------------------------------------------------------------
 *   trend           mean-reversion lost 76-84% dip-buying a -89% one-way slide
 *   volume          gas on 8,777 fills was $290, i.e. 3.4x the whole book
 *   volatility      a 10% round-trip toll needs >10% swings to clear
 *   fill size       only 61% of trades were even large enough to beat gas
 *   inventory       flow ran 84.6% one-way; an uncapped bid accumulates the loser
 *   drawdown        the unknown unknown; stop trading and stay stopped
 *
 * This module is PURE and shared by the backtest and the live keeper, so the thing
 * that decides in simulation is literally the thing that decides with real money.
 */

/** Costs, all measured on Robinhood Chain. See docs/ECONOMICS.md. */
export const COSTS = Object.freeze({
  hookFeeBps: 500,          // 5% per side, Hook.FEE_BPS, verified on chain
  fee: 0.05,
  openseaFeeBps: 100,       // 1%, read from a real order's consideration
  gasUsdPerFill: 0.033,     // 209k gas @ 0.057 gwei, ETH $2,735, from 8 real txs
});

/**
 * Break-even grid step. Buying W WETH of RF and selling it back a fraction s higher
 * returns W(1-f)^2(1+s), so a profitable round trip needs s > 1/(1-f)^2 - 1.
 * At f = 5% that is 10.80%. This is arithmetic, not a preference: any step below it
 * loses on EVERY completed round trip regardless of how the market moves.
 */
export const BREAKEVEN_STEP = 1 / (1 - 0.05) ** 2 - 1;

/** What a round trip actually nets at a given step, after both fees. */
export const edgePerRoundTrip = (step, fee = COSTS.fee) => (1 - fee) ** 2 * (1 + step) - 1;

/**
 * Volatility a grid needs to traverse a rung often enough to matter.
 * Expected time to move a fraction s scales as (s/sigma)^2; a round trip is two
 * traverses, so R round trips per 168h needs sigma_h >= s * sqrt(2R/168).
 */
export const volFloorFor = (step, roundTripsPerWeek) => step * Math.sqrt((2 * roundTripsPerWeek) / 168);

/**
 * Inventory ceiling from the Avellaneda-Stoikov inventory-risk term. Tolerating a
 * loss of L of book to a Z-sigma move over horizon H hours gives w <= L/(Z*sigma*sqrt(H)).
 * A FIXED cap is right at one volatility and wrong at every other, so this scales.
 */
export const inventoryCapFor = (hourlyVol, { lossTolerance = 0.10, z = 2, horizonHours = 72 } = {}) =>
  Math.max(0.05, Math.min(0.95, lossTolerance / (z * Math.max(hourlyVol, 0.005) * Math.sqrt(horizonHours))));

/**
 * Default arming conditions. Deliberately conservative: these are the levels at
 * which the desk is WILLING to risk money, not the levels at which it expects to
 * print. Every one is a live, measurable quantity.
 */
export const DEFAULT_GATES = Object.freeze({
  // --- liquidity and activity ---
  minVolume24hWeth: 25,        // today: ~13.7. Deliberately ABOVE current volume.
  minTrades24h: 200,           // today: ~40 via the router. Needs real two-way flow.

  // --- regime: we want chop, not a trend ---
  maxAbsDrift24h: 0.20,        // stand down if the market moved more than 20% net in a day
  maxAbsDrift1h: 0.15,         // and if it is moving fast right now, wait
  // A SLOW BLEED is invisible to a 24h window and is what actually kills a grid.
  // Measured: a -3%/day grind shows -3% on the 24h gate, passes it, and cost -9.7%
  // median over 14 days; -10%/day cost -30.7%. Over a week those same regimes show
  // -19% and -52%, which this gate catches and the 24h one never will.
  maxAbsDrift7d: 0.12,
  // ASYMMETRY. The gates above decide whether the desk trades at all. This one
  // decides which SIDE. Measured across 40 regimes: every losing bucket was a
  // down-trend bucket, and the loss came entirely from spending WETH buying dips
  // that kept dipping. Selling RF into a downtrend is not the same trade: it
  // reduces inventory and raises cash. So below this drift, the desk may sell but
  // may not buy.
  // The 7-DAY trend is the signal. A single down day inside a rising market is
  // noise, and blocking on it costs exactly the dip-buying that works: with a -5%
  // daily trigger, the +3%/day regimes fell from +12.0% to -0.7%. The daily gate is
  // kept only as a circuit breaker for a genuine one-day collapse.
  buyBlockedBelowDrift7d: -0.02,
  buyBlockedBelowDrift24h: -0.18,

  // --- volatility must clear the toll ---
  // DERIVED from the grid step and a stated target of 4 round trips/week = 3.27%.
  // The old 4.00% was picked by hand; it implied 6/week, which was never stated.
  targetRoundTripsPerWeek: 4,
  maxHourlyVol: 0.35,          // [CHOICE] above this it is not chop, it is a repricing

  // --- execution ---
  gridStep: 0.15,              // DERIVED floor 10.80%; this is a 39% margin over it
  sliceFrac: 0.15,             // fraction of the relevant side deployed per rung
  // DERIVED, and the old value was simply wrong. It was set to "10x gas" = $0.33,
  // which ignored that a round trip nets 3.79% of the slice, not 100% of it. The
  // real condition is notional * edge > k * 2 * gas, i.e. notional > k*2*gas/edge.
  // At k = 5 that is $8.72. At k = 10 it is $17.43, which an $86 book cannot reach
  // with a 15% slice, so k is stated rather than hidden.
  gasMarginK: 5,
  maxSpreadFromMid: 0.05,      // do not chase

  // --- risk ---
  // DERIVED per-tick from volatility via inventoryCapFor(); this is only the ceiling.
  maxInventoryFrac: 0.60,
  maxDrawdown: 0.15,           // hard stop; requires a manual reset
  maxFillsPerHour: 6,          // no death by a thousand gas fees
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
 * Evaluate every gate and return a full, human-readable verdict.
 * Returns { armed, reasons: [{gate, ok, detail}] } so the dashboard can show
 * exactly WHY the desk is flat. "It is off" is not an acceptable answer to a member.
 */
export function evaluateRegime(market, book, gates = DEFAULT_GATES) {
  const checks = [];
  const add = (gate, ok, detail) => checks.push({ gate, ok, detail });

  add("volume24h", market.volume24hWeth >= gates.minVolume24hWeth,
    `${market.volume24hWeth.toFixed(2)} WETH vs min ${gates.minVolume24hWeth}`);
  add("trades24h", market.trades24h >= gates.minTrades24h,
    `${market.trades24h} vs min ${gates.minTrades24h}`);
  add("drift24h", Math.abs(market.drift24h) <= gates.maxAbsDrift24h,
    `${(market.drift24h * 100).toFixed(1)}% vs max +/-${gates.maxAbsDrift24h * 100}%`);
  add("drift1h", Math.abs(market.drift1h) <= gates.maxAbsDrift1h,
    `${(market.drift1h * 100).toFixed(1)}% vs max +/-${gates.maxAbsDrift1h * 100}%`);
  // Undefined 7d drift means we do not know yet, which is NOT the same as zero.
  // Refuse to arm rather than assume the trend is flat.
  add("drift7d", market.drift7d != null && Math.abs(market.drift7d) <= gates.maxAbsDrift7d,
    market.drift7d == null
      ? "no 7-day history yet"
      : `${(market.drift7d * 100).toFixed(1)}% vs max +/-${gates.maxAbsDrift7d * 100}%`);
  const volFloor = volFloorFor(gates.gridStep, gates.targetRoundTripsPerWeek);
  add("volFloor", market.hourlyVol >= volFloor,
    `${(market.hourlyVol * 100).toFixed(2)}% vs min ${(volFloor * 100).toFixed(2)}% ` +
    `(= ${gates.targetRoundTripsPerWeek} round trips/wk at a ${(gates.gridStep * 100).toFixed(0)}% step)`);
  add("volCeiling", market.hourlyVol <= gates.maxHourlyVol,
    `${(market.hourlyVol * 100).toFixed(2)}% vs max ${gates.maxHourlyVol * 100}%`);

  const invFrac = book.valueWeth > 0 ? (book.rf * market.mid) / book.valueWeth : 0;
  // Volatility-scaled, not fixed: the tolerable inventory falls as vol rises.
  const invCap = Math.min(gates.maxInventoryFrac, inventoryCapFor(market.hourlyVol));
  add("inventory", invFrac <= invCap,
    `${(invFrac * 100).toFixed(1)}% of book in RF vs max ${(invCap * 100).toFixed(0)}% at this volatility`);

  const dd = book.hwmWeth > 0 ? 1 - book.valueWeth / book.hwmWeth : 0;
  add("drawdown", dd <= gates.maxDrawdown,
    `${(dd * 100).toFixed(1)}% from high-water mark vs max ${gates.maxDrawdown * 100}%`);

  add("breaker", !book.halted, book.halted ? "manually halted" : "clear");

  return { armed: checks.every((c) => c.ok), checks, inventoryFrac: invFrac, drawdown: dd };
}

/**
 * Given an armed desk and the current price, what order (if any) do we want?
 * Returns null when there is nothing to do. The grid reference only moves when a
 * rung actually fills, so the desk cannot chase a trend down.
 */
export function nextOrder(market, book, state, gates = DEFAULT_GATES) {
  const regime = evaluateRegime(market, book, gates);
  if (!regime.armed) return { action: "stand-down", regime };

  if (state.fillsThisHour >= gates.maxFillsPerHour) {
    return { action: "stand-down", regime, throttled: true };
  }

  // Anchor the grid the first time the desk arms. This MUST happen here rather
  // than in the caller: an earlier version only moved gridRef after a fill, so
  // `ref` defaulted to the current mid, `mid <= ref * (1 - step)` could never be
  // true, and the grid could never take its first trade because the reference was
  // only ever set BY a trade. One caller masked it by anchoring on any non-stand-down
  // tick; another did not, and silently never traded in 40 out of 40 regimes.
  if (state.gridRef == null) state.gridRef = market.mid;
  const ref = state.gridRef;
  const step = Math.max(gates.gridStep, BREAKEVEN_STEP * 1.3);

  // One-way mode: in a falling market the desk is allowed to sell, never to buy.
  const buyBlocked =
    (market.drift7d != null && market.drift7d < gates.buyBlockedBelowDrift7d) ||
    market.drift24h < gates.buyBlockedBelowDrift24h;

  if (market.mid <= ref * (1 - step)) {
    if (buyBlocked) {
      // Re-anchor so the desk does not fire a stale buy the moment the trend turns.
      state.gridRef = market.mid;
      return { action: "hold", regime, buyBlocked: true };
    }
    const spendWeth = book.weth * gates.sliceFrac;
    const minFillUsd = (gates.gasMarginK * 2 * COSTS.gasUsdPerFill) / edgePerRoundTrip(gates.gridStep);
    if (spendWeth * market.ethUsd < minFillUsd) return { action: "stand-down", regime, tooSmall: true, minFillUsd };
    // Respect the inventory cap on the way in, not after.
    const projected = (book.rf * market.mid + spendWeth) / Math.max(book.valueWeth, 1e-18);
    if (projected > gates.maxInventoryFrac) return { action: "stand-down", regime, capped: true };
    return { action: "buy", weth: spendWeth, limitPrice: market.mid * (1 + gates.maxSpreadFromMid), regime, step };
  }

  if (market.mid >= ref * (1 + step)) {
    const sellRf = book.rf * gates.sliceFrac;
    const minFillUsd = (gates.gasMarginK * 2 * COSTS.gasUsdPerFill) / edgePerRoundTrip(gates.gridStep);
    if (sellRf * market.mid * market.ethUsd < minFillUsd) return { action: "stand-down", regime, tooSmall: true, minFillUsd };
    return { action: "sell", rf: sellRf, limitPrice: market.mid * (1 - gates.maxSpreadFromMid), regime, step };
  }

  return { action: "hold", regime, buyBlocked };
}

/** One-line summary for logs and the dashboard. */
export function explain(regime) {
  if (regime.armed) return "ARMED";
  const failed = regime.checks.filter((c) => !c.ok);
  return `FLAT (${failed.map((f) => `${f.gate}: ${f.detail}`).join("; ")})`;
}
