#!/usr/bin/env node
/**
 * DERIVE the desk's parameters instead of asserting them.
 *
 *   node scripts/derive-parameters.mjs
 *
 * Every number is one of
 *   [MEASURED]  read from Robinhood Chain (dated), reproducible with npm run verify
 *   [DERIVED]   algebra from a measured input, shown in full
 *   [CHOICE]    a preference that cannot be derived, stated with its consequence
 *
 * The desk is a MAKER-ONLY range-order grid (lib/strategy.mjs). The model references
 * are unchanged: Ho & Stoll (1981) for the dealer's spread, Avellaneda & Stoikov
 * (2008) for inventory risk (tolerable inventory falls with the SQUARE of volatility).
 */
import { DEFAULT_GATES as G, COSTS, BREAKEVEN_STEP, makerEdgePerRoundTrip, inventoryCapFor } from "../lib/strategy.mjs";

const line = (s = "") => console.log(s);
const rule = () => line("=".repeat(78));
const pc = (v, d = 2) => `${(v * 100).toFixed(d)}%`;

/* ============================== MEASURED INPUTS ============================== */
const M = {
  hookFee: 0.05,              // Hook.FEE_BPS() = 500
  lpFee: 0,                   // slot0.lpFee, and the Swap event's fee field on all 8,826 swaps
  hookFlags: "0x20cc",        // beforeInitialize, beforeSwap, afterSwap, both ReturnsDelta; NO liquidity hooks
  tickSpacing: 60,            // Market.seed full range 887220 = 60 x 14787
  gasSwapUsd: 0.033,          // 209k gas @ 0.057 gwei, ETH ~$2,735, 8 real txs
  poolDepthWeth: 112.7,       // full-range virtual WETH, 2026-09-22
  hourlyVol24h: 0.0033,       // /api/desk 2026-09-22 17:30 UTC (hourly closes, last 24h)
  drift72h: -0.234,           // /api/desk 2026-09-22 17:30 UTC
  ethUsd: 2736,
};
// Completed zigzag reversals on the pool's whole tape (8,826 swaps, 2026-09-16 to 09-22).
const REVERSALS = { "2%": { life: 74, last72h: 3 }, "5%": { life: 22, last72h: 2 }, "10%": { life: 10, last72h: 0 } };

line("THE FIRST BANK OF FRIENDS :: parameter derivation (maker-only desk)");
line(`run ${new Date().toISOString()}`);
line();
line("MEASURED INPUTS");
rule();
for (const [k, v] of Object.entries(M)) line(`  ${k.padEnd(16)} ${v}`);
line();

line("1. WHY MAKER-ONLY  [DERIVED]");
rule();
line("  A TAKER round trip pays the hook twice: W(1-f)^2(1+s), so it needs s > 1/(1-f)^2 - 1");
line(`  = ${pc(BREAKEVEN_STEP)} at f = 5%. The hook has no add/remove-liquidity callbacks (FLAGS ${M.hookFlags}),`);
line("  so a v4 RANGE ORDER never pays it. A maker round trip's only cost is gas.");
line("  Takers who cross the bank's ranges still pay 5% to every Friend, so the reward");
line("  stream is untouched; the bank simply stops being one of the payers.");
line();

line(`2. GRID STEP g = ${pc(G.gridStep, 0)}  [CHOICE]`);
rule();
line("  Consequence, from the tape: completed swings the grid could have earned on");
for (const [k, v] of Object.entries(REVERSALS)) line(`    step ${k.padEnd(4)} whole life ${String(v.life).padStart(3)}   last 72h ${v.last72h}`);
line(`  5% is ${(Math.log(1 + G.gridStep) / Math.log(1.0001) / M.tickSpacing).toFixed(1)} tick spacings wide. Narrower steps count more swings but earn`);
line("  less per swing and flip more often (gas); wider steps almost never complete.");
line();

const lock = G.lockBps / 1e4;
line(`3. LOSS-LOCK = ${pc(lock, 0)}  [CHOICE, enforced on chain by RangeDesk.sol]`);
rule();
line("  An ask may not start below costBasis x (1 + lock); a bid may not end above");
line("  lastSell x (1 - lock). Every completed round trip therefore earns at least the lock.");
line(`  With the lock equal to the step, a round trip nets (1+lock)(1+g)^0.5 - 1 = ${pc(makerEdgePerRoundTrip(G.gridStep, lock))} before gas.`);
line("  Cost of the lock: RF bought on the way down is only offered back 5% ABOVE its cost,");
line("  so in a falling market it rests unsold instead of being dumped. That is the point.");
line();

const minRung = (G.gasMarginK * COSTS.gasUsdPerFlip) / lock;
line(`4. MINIMUM RUNG = $${minRung.toFixed(2)}  [DERIVED]`);
rule();
line(`  A flip (remove + re-add in one unlock) costs ~$${COSTS.gasUsdPerFlip} [CHOICE: ~2x a measured $${M.gasSwapUsd} swap].`);
line(`  A rung earns at least lock x notional per round trip. Requiring k = ${G.gasMarginK} x gas:`);
line(`      notional >= k x gas / lock = ${G.gasMarginK} x ${COSTS.gasUsdPerFlip} / ${lock} = $${minRung.toFixed(2)}`);
line(`  One range is at most ${pc(G.maxRangeFrac, 0)} of its side, so a side needs about $${(minRung / G.maxRangeFrac).toFixed(0)} idle before`);
line("  the desk can quote it at all. Hunt's ~$100 book (94% WETH) can quote a bid, not an ask; a");
line("  pooled book quotes both. That is what pooling buys the desk.");
line();

line("5. THE ARMING RULE  [CHOICE, each with its consequence]");
rule();
line(`  swings in 72h  >= ${G.minReversals72h} completed ${pc(G.gridStep, 0)} swings (two a day). Today: ${REVERSALS["5%"].last72h}.`);
line(`  trend over 72h |drift| < ${G.maxDrift72hSteps} x g = ${pc(G.maxDrift72hSteps * G.gridStep, 0)}. A trend fills one side only. Today: ${pc(M.drift72h, 1)}.`);
line(`  last week      the same grid replayed on the trailing 7 days beats holding (> ${G.minWalkForwardEdge}).`);
line("                 Unmeasurable until the pool is 7 days old (2026-09-23 14:44 UTC).");
line("  A gate with no data is 'not yet measurable'. It never passes by default.");
line();

line("6. INVENTORY  [DERIVED cap, CHOICE ceiling]");
rule();
line("  Avellaneda-Stoikov: tolerating a loss L of book to a Z-sigma move over H hours");
line("  gives w <= L / (Z sigma sqrt(H)). With L = 10%, Z = 2, H = 72 [CHOICE]:");
for (const v of [0.0033, 0.0149, 0.04, 0.08]) line(`    hourly vol ${pc(v).padStart(6)} -> cap ${pc(inventoryCapFor(v), 0)}`);
line(`  The cap sizes the BIDS: the desk never buys past it. The arming ceiling is ${pc(G.maxInventoryFrac, 0)};`);
line("  a book already heavy in RF still quotes asks and sells down toward the cap.");
line();

line("7. THE CONTRACT'S RULES  [the contract's constants, mirrored in DEFAULT_GATES]");
rule();
line(`  ask lock      priceLower >= book-wide cost of BOUGHT RF x ${1 + lock}; harvested RF has no basis`);
line(`  bid lock      priceUpper <= VWAP of the last ask closed x ${1 - lock}, lapsing after ${G.bidLockLapseDays} days`);
line(`  TWAP edge     every range >= ${G.twapEdgeTicks} ticks (${pc(1.0001 ** G.twapEdgeTicks - 1)}) beyond the observer TWAP`);
line(`  size          ${pc(G.minRangeFrac, 0)} to ${pc(G.maxRangeFrac, 0)} of a side per range, <= ${pc(G.maxDailySideFrac, 0)} of a side opened per day`);
line(`  turnover      <= ${G.maxOpsPerDay} opens + closes per day; ranges expire after ${G.rangeExpiryDays} days`);
line("  shape         at most ONE ask and ONE bid open at a time; a second placement reverts RangeOpen");
line(`  So each side quotes one ${pc(G.gridStep, 0)} band of at most ${pc(G.maxRangeFrac, 0)} of its idle balance, and can re-quote`);
line(`  at most ${Math.floor(G.maxDailySideFrac / G.maxRangeFrac)} times a day before the 50% turnover cap binds.`);
line();

line(`8. DRAWDOWN = ${pc(G.maxDrawdown, 0)} vs HOLDING  [CHOICE]`);
rule();
line("  Measured against holding the same book, so an RF slide the desk never traded cannot");
line("  trip it. Tripping it halts the desk until a human resets it.");
line();
line("See docs/STRATEGY.md (backtest-gated) and scripts/sweep-regimes.mjs for what these do.");
