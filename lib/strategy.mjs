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
  hookFeeBps: 500,          // 5% per side, Hook.FEE_BPS
  roundTripFee: 0.10,       // 5% in + 5% out
  openseaFeeBps: 100,       // 1%, read from a real order's consideration
  gasUsdPerFill: 0.033,     // 209k gas @ 0.057 gwei, ETH $2,735
});

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

  // --- volatility must clear the toll ---
  minHourlyVol: 0.04,          // below this there is not enough movement to pay 10%
  maxHourlyVol: 0.35,          // above this it is not chop, it is a repricing

  // --- execution ---
  gridStep: 0.15,              // never tighter than the toll plus a margin
  sliceFrac: 0.15,             // fraction of the relevant side deployed per rung
  minFillUsd: 0.33,            // 10x gas
  maxSpreadFromMid: 0.05,      // do not chase

  // --- risk ---
  maxInventoryFrac: 0.60,      // never more than 60% of book value in RF
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
  add("volFloor", market.hourlyVol >= gates.minHourlyVol,
    `${(market.hourlyVol * 100).toFixed(2)}% vs min ${gates.minHourlyVol * 100}%`);
  add("volCeiling", market.hourlyVol <= gates.maxHourlyVol,
    `${(market.hourlyVol * 100).toFixed(2)}% vs max ${gates.maxHourlyVol * 100}%`);

  const invFrac = book.valueWeth > 0 ? (book.rf * market.mid) / book.valueWeth : 0;
  add("inventory", invFrac <= gates.maxInventoryFrac,
    `${(invFrac * 100).toFixed(1)}% of book in RF vs max ${gates.maxInventoryFrac * 100}%`);

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

  const ref = state.gridRef || market.mid;
  const step = Math.max(gates.gridStep, COSTS.roundTripFee * 1.5);

  if (market.mid <= ref * (1 - step)) {
    const spendWeth = book.weth * gates.sliceFrac;
    if (spendWeth * market.ethUsd < gates.minFillUsd) return { action: "stand-down", regime, tooSmall: true };
    // Respect the inventory cap on the way in, not after.
    const projected = (book.rf * market.mid + spendWeth) / Math.max(book.valueWeth, 1e-18);
    if (projected > gates.maxInventoryFrac) return { action: "stand-down", regime, capped: true };
    return { action: "buy", weth: spendWeth, limitPrice: market.mid * (1 + gates.maxSpreadFromMid), regime, step };
  }

  if (market.mid >= ref * (1 + step)) {
    const sellRf = book.rf * gates.sliceFrac;
    if (sellRf * market.mid * market.ethUsd < gates.minFillUsd) return { action: "stand-down", regime, tooSmall: true };
    return { action: "sell", rf: sellRf, limitPrice: market.mid * (1 - gates.maxSpreadFromMid), regime, step };
  }

  return { action: "hold", regime };
}

/** One-line summary for logs and the dashboard. */
export function explain(regime) {
  if (regime.armed) return "ARMED";
  const failed = regime.checks.filter((c) => !c.ok);
  return `FLAT (${failed.map((f) => `${f.gate}: ${f.detail}`).join("; ")})`;
}
