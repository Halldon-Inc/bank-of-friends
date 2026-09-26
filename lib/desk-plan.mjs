/**
 * The keeper's desk planner: what FriendBankV2's one ask and one bid should do right now.
 *
 * PURE. It reads a snapshot of chain state and the market measurements, and returns
 * the calls to send (closeAsk / closeBid / placeAsk / placeBid) with a reason for each.
 * It sends nothing. scripts/keeper.mjs builds the snapshot, simulates every call as
 * the keeper, and sends only with --execute.
 *
 * The DECISION (armed or not, inventory cap, rung size floor) is lib/strategy.mjs,
 * the same module the backtests and /api/desk use. This file only translates that
 * decision into ticks the contract will accept. Every placement rule below mirrors a
 * revert in RangeDesk.open or FriendBank._preflight, so a plan that passes here does
 * not revert there (the keeper still simulates, because the chain moves between the
 * read and the send).
 *
 *   rule (contract)                                  here
 *   ===============================================  ======================================
 *   ask: spot < tickLower                            lo >= spot + 1, snapped up
 *   bid: tickUpper <= spot                           hi <= spot, snapped down
 *   ask: tickLower >= twap + twapEdgeTicks           lo >= twap + edge
 *   bid: tickUpper <= twap - twapEdgeTicks           hi <= twap - edge
 *   ask: price(lo) >= avg cost x 1.05, or spend      lo >= lock tick; the keeper NEVER spends
 *        the loss budget                             the loss budget (strategy.mjs agrees)
 *   bid: priceCeil(hi) <= last sale x 0.95 (30 days) hi <= lock tick - 1
 *   size 1% .. maxRangeBps of the idle side          bps = min(gates, contract, turnover room)
 *   rolling daily turnover, 24 modifies a day        decayed exactly as _useModify does
 *   book side >= MIN_BOOK, not halted                checked
 *
 * Policy (strategy.mjs nextOrder, mapped onto one ask + one bid):
 *   - a range the price has fully crossed is CLOSED (it filled); its side is re-quoted
 *     on the next run, once the proceeds are back in the book. A flip is two runs.
 *   - not armed: close any unfilled BID (never buy into a regime we cannot read). The ASK
 *     slot belongs to the STANDING SELL ORDER (strategy.mjs standingOrder): idle RF is
 *     offered one spacing past the TWAP edge, two spacings wide, 15% at a time, chased
 *     down when the market walks away, and swapped for a wide take-profit ask when the
 *     trend brake fires. Its rules in the same table form:
 *
 *       rule (standingOrder)                              here
 *       ================================================  ====================================
 *       edge: lo = snapUp(max(spot, twap) x edge) + 1 sp  lo = max(contract floor, that tick)
 *       edge: hi = lo x 1.0001^(2 x spacing)              hi = max(that tick, lo + spacing)
 *       take-profit: [twap x 1.10, twap x 2.0]            same, snapped, contract floor on top
 *       size STANDING.frac (15%) of idle RF               bps = min(15%, contract, turnover room)
 *       book floor: idle RF worth >= $50                  checked by standingOrder (no per-rung floor)
 *       chase / ratchet / release -> close                closeAsk, why = "standing order (...)"
 *       one re-quote an hour                              standingOrder keeps a young ask
 *
 *   - a range within STALE_MARGIN of RANGE_TTL is closed so it can be re-quoted near
 *     the price, before a stranger may close it.
 *   - armed: an empty side gets one range, one grid step wide, as close to the price
 *     as the rules allow. The grid owns both slots; the standing order steps aside.
 */
import { DEFAULT_GATES, COSTS, evaluateRegime, inventoryCapFor, rangeAmounts, standingOrder } from "./strategy.mjs";

export const TICK_BASE = Math.log(1.0001);
/** FriendBank constants (contracts/src/FriendBank.sol). */
export const BANK_CONST = Object.freeze({
  BPS: 10_000n,
  MIN_BOOK: 1_000_000_000n,
  MIN_RANGE_BPS: 100n,
  MAX_MODIFIES_PER_DAY: 24n,
  RANGE_TTL: 7 * 86_400,
  DAY: 86_400,
  LOCK_BPS: 500,
  BID_LOCK_WINDOW: 30 * 86_400,
});
/** Close and re-quote a range this long before strangers may close it. */
export const STALE_MARGIN = 3_600;

export const priceAtTick = (t) => 1.0001 ** t;
export const tickOfPrice = (p) => Math.log(p) / TICK_BASE;
export const snapUp = (t, s) => Math.ceil(t / s) * s;
export const snapDown = (t, s) => Math.floor(t / s) * s;
const e18 = (v) => Number(v) / 1e18;

/** One grid step in ticks, snapped UP to the spacing so a range is never narrower than the step. */
export const stepTicks = (gates, spacing) => snapUp(Math.log(1 + gates.gridStep) / TICK_BASE, spacing);

/** Rolling counters, decayed exactly as FriendBank._useModify decays them. */
export function roomToday(bank, now) {
  const dt = BigInt(Math.max(0, now - Number(bank.usedAt)));
  const day = BigInt(BANK_CONST.DAY);
  const d = (dt * bank.maxDailyTurnoverBps) / day;
  const dec = (u) => (u > d ? u - d : 0n);
  const m = (dt * BANK_CONST.MAX_MODIFIES_PER_DAY * 10n ** 18n) / day;
  const mods = bank.usedModifies > m ? bank.usedModifies - m : 0n;
  const modRoom = (BANK_CONST.MAX_MODIFIES_PER_DAY * 10n ** 18n - mods) / 10n ** 18n;
  return {
    rfBps: bank.maxDailyTurnoverBps - dec(bank.usedBpsRf),
    wethBps: bank.maxDailyTurnoverBps - dec(bank.usedBpsWeth),
    modifies: Number(modRoom < 0n ? 0n : modRoom),
  };
}

/** What sits in a range at the spot tick, in whole tokens. */
export function rangeHoldings(r, spotTick) {
  if (!r?.open || !r.liquidity) return { rf: 0, weth: 0 };
  const a = rangeAmounts(priceAtTick(r.lo), priceAtTick(r.hi), Number(r.liquidity), priceAtTick(spotTick));
  return { rf: a.rf / 1e18, weth: a.weth / 1e18 };
}

/**
 * The book in the terms strategy.mjs's gates use. Drawdown is REALIZED desk loss from the
 * contract's own loss ledger (lossSpentWeth), because that is the one loss the chain
 * measures; the high-water mark is "value plus what the desk has lost", so a slide in RF
 * that the desk did not trade cannot trip it.
 */
export function bookFor(s) {
  const a = rangeHoldings(s.bank.ask, s.spotTick), b = rangeHoldings(s.bank.bid, s.spotTick);
  const rf = e18(s.bank.bookR) + a.rf + b.rf;
  const weth = e18(s.bank.bookW) + a.weth + b.weth;
  const valueWeth = weth + rf * s.market.mid;
  return { rf, weth, valueWeth, hwmWeth: valueWeth + e18(s.desk.lossSpentWeth), halted: s.bank.halted };
}

/**
 * @param {{
 *   now: number, spotTick: number, twapTick: number | null, tickSpacing: number,
 *   market: { mid: number, ethUsd: number | null, hourlyVol: number | null,
 *             reversals72h: number | null, drift72h: number | null, walkForward7d: number | null },
 *   bank: { halted: boolean, bookR: bigint, bookW: bigint, maxRangeBps: bigint, maxDailyTurnoverBps: bigint,
 *           usedBpsRf: bigint, usedBpsWeth: bigint, usedModifies: bigint, usedAt: bigint,
 *           ask: { open: boolean, openedAt: number, lo?: number, hi?: number, liquidity?: bigint },
 *           bid: { open: boolean, openedAt: number, lo?: number, hi?: number, liquidity?: bigint } },
 *   desk: { costRf: bigint, costWeth: bigint, lastSellWethPerRf: bigint, lastSellAt: number,
 *           lossSpentWeth: bigint, twapEdgeTicks: number },
 * }} s
 * @param {typeof DEFAULT_GATES} [gates]
 */
export function planDesk(s, gates = DEFAULT_GATES) {
  const S = s.tickSpacing;
  const book = bookFor(s);
  const regime = evaluateRegime(s.market, book, gates);
  const actions = [], notes = [];
  const room = roomToday(s.bank, s.now);
  let mods = room.modifies;
  const closing = { ask: false, bid: false };

  /* the standing sell order: what the ask slot holds when the grid is off ------ */
  // In price space, from the same snapshot. The contract stores no mode for an open ask,
  // so standingOrder infers it: an ask whose lower edge is at or above TWAP x takeProfitLo
  // (less 1%) is a take-profit ask, anything nearer the price is an edge ask.
  const twapPrice = s.twapTick == null ? undefined : priceAtTick(s.twapTick);
  const avgCost = s.desk.costRf > 0n ? Number(s.desk.costWeth) / Number(s.desk.costRf) : 0;
  const standing = standingOrder(
    { mid: s.market.mid, twap: twapPrice, ethUsd: s.market.ethUsd ?? null, drift24h: s.market.drift24h ?? null, high72h: s.market.high72h ?? null },
    { rf: e18(s.bank.bookR), weth: e18(s.bank.bookW), valueWeth: book.valueWeth, avgCost },
    { gridArmed: regime.armed, now: s.now, ask: s.bank.ask.open ? { lo: priceAtTick(s.bank.ask.lo), hi: priceAtTick(s.bank.ask.hi), openedAt: s.bank.ask.openedAt } : null },
    gates,
  );
  const standingLabel = standing.mode === "takeProfit" ? "standing order (take-profit)" : "standing order (edge)";

  /* closes --------------------------------------------------------------- */
  for (const side of ["ask", "bid"]) {
    const r = s.bank[side];
    if (!r.open) continue;
    const filled = side === "ask" ? s.spotTick >= r.hi : s.spotTick < r.lo;
    const age = s.now - r.openedAt;
    let why = null;
    if (filled) why = `filled: the price (tick ${s.spotTick}) crossed the whole range [${r.lo}, ${r.hi}]`;
    else if (side === "bid" && !regime.armed) why = "not armed: never leave a bid resting in a regime we cannot read";
    else if (side === "ask" && !regime.armed && standing.close) why = `${standingLabel}: ${standing.closeWhy}`;
    else if (age >= BANK_CONST.RANGE_TTL - STALE_MARGIN) why = `stale: open ${(age / 86_400).toFixed(1)} days; re-quote before strangers may close it`;
    if (!why) { notes.push(`${side} [${r.lo}, ${r.hi}] resting, ${(age / 3_600).toFixed(1)} h old`); continue; }
    if (mods < 1) { notes.push(`${side} should close (${why}) but the 24-a-day modify limit is used up`); continue; }
    mods--;
    closing[side] = true;
    actions.push({ fn: side === "ask" ? "closeAsk" : "closeBid", args: [], why });
  }

  /* places ---------------------------------------------------------------- */
  const place = (side) => {
    if (s.bank[side].open || closing[side]) return;
    const isAsk = side === "ask";
    // Not armed: bids never rest, and the ask slot belongs to the standing sell order.
    const viaStanding = !regime.armed && isAsk && !!standing.place;
    if (!regime.armed && !viaStanding) {
      if (isAsk && standing.mode === "idle") notes.push(`ask: ${standing.reason}`);
      return;
    }
    if (s.bank.halted) return notes.push(`${side}: quoting is halted`);
    if (s.twapTick == null) return notes.push(`${side}: the observer's TWAP is not ready (it needs 6 pokes in the last hour); keep poking`);
    if (mods < 1) return notes.push(`${side}: the 24-a-day modify limit is used up`);
    const sideRaw = isAsk ? s.bank.bookR : s.bank.bookW;
    if (sideRaw < BANK_CONST.MIN_BOOK) return notes.push(`${side}: the ${isAsk ? "RF" : "WETH"} book is below the contract minimum`);

    let bps = BigInt(Math.floor((viaStanding ? standing.place.frac : gates.maxRangeFrac) * 10_000));
    if (s.bank.maxRangeBps < bps) bps = s.bank.maxRangeBps;
    const turn = isAsk ? room.rfBps : room.wethBps;
    if (turn < bps) bps = turn;
    if (!isAsk) {
      // Bids are sized so a full fill keeps RF inside the volatility-scaled cap.
      const cap = s.market.hourlyVol == null ? 0 : Math.min(gates.maxInventoryFrac, inventoryCapFor(s.market.hourlyVol));
      const budget = Math.max(0, Math.min(book.weth, cap * book.valueWeth - book.rf * s.market.mid));
      const budgetBps = BigInt(Math.floor((budget / e18(sideRaw)) * 10_000));
      if (budgetBps < bps) bps = budgetBps;
    }
    if (bps < BANK_CONST.MIN_RANGE_BPS) {
      return notes.push(`${side}: room for only ${bps} bps (${isAsk ? "daily turnover" : "turnover or the inventory cap"}); the contract minimum is 100`);
    }
    const amount = (sideRaw * bps) / BANK_CONST.BPS;
    const notionalWeth = isAsk ? e18(amount) * s.market.mid : e18(amount);
    if (s.market.ethUsd == null) return notes.push(`${side}: no live ETH/USD, so the rung-size floor cannot be checked; not placing`);
    if (viaStanding) {
      // The standing order's floor is on the idle RF book (STANDING.minBookUsd), checked by
      // standingOrder before it offers a placement; the grid's per-rung gas floor does not apply.
    } else {
      const minRungUsd = (gates.gasMarginK * COSTS.gasUsdPerFlip) / (gates.lockBps / 10_000);
      if (notionalWeth * s.market.ethUsd < minRungUsd) {
        return notes.push(`${side}: $${(notionalWeth * s.market.ethUsd).toFixed(2)} is under the $${minRungUsd.toFixed(2)} rung floor (gas)`);
      }
    }

    const step = stepTicks(gates, S), edge = s.desk.twapEdgeTicks, lock = BANK_CONST.LOCK_BPS / 10_000;
    let lo, hi, basis = "";
    if (isAsk) {
      let floor = Math.max(s.spotTick + 1, s.twapTick + edge);
      if (s.desk.costRf > 0n) {
        const lockTick = Math.ceil(tickOfPrice((Number(s.desk.costWeth) / Number(s.desk.costRf)) * (1 + lock)) + 1e-6);
        if (lockTick > floor) basis = ", held up by the loss-lock on bought RF";
        floor = Math.max(floor, lockTick);
      }
      lo = snapUp(floor, S);
      hi = lo + step;
      if (viaStanding) {
        // The standing order's range, already snapped in price space; the contract's own
        // floor (beyond spot, beyond the TWAP edge, above the lock) is applied on top.
        const t = (p) => Math.round(tickOfPrice(p) / S) * S;
        lo = Math.max(lo, t(standing.place.lo));
        hi = Math.max(t(standing.place.hi), lo + S);
      }
    } else {
      let ceil = Math.min(s.spotTick, s.twapTick - edge);
      const lockLive = s.desk.lastSellWethPerRf > 0n && s.now <= s.desk.lastSellAt + BANK_CONST.BID_LOCK_WINDOW;
      if (lockLive) {
        const lockTick = Math.floor(tickOfPrice((Number(s.desk.lastSellWethPerRf) / 1e36) * (1 - lock)) - 1e-6) - 1;
        if (lockTick < ceil) basis = ", held down by the loss-lock on the last sale";
        ceil = Math.min(ceil, lockTick);
      }
      hi = snapDown(ceil, S);
      lo = hi - step;
    }
    mods--;
    actions.push({
      fn: isAsk ? "placeAsk" : "placeBid",
      args: [lo, hi, amount],
      why: `${viaStanding ? standingLabel : "armed"}; ${bps} bps of the ${isAsk ? "RF" : "WETH"} book in [${lo}, ${hi}] (${((priceAtTick(isAsk ? lo : hi) / s.market.mid - 1) * 100).toFixed(1)}% from mid${basis})`,
    });
  };
  place("ask");
  place("bid");
  return { regime, book, actions, notes, standing };
}
