#!/usr/bin/env node
/**
 * The keeper's desk planner against the contract's rules.   node --test scripts/desk-plan.test.mjs
 *
 * Each placement is checked against the inequality RangeDesk.open / FriendBank._preflight
 * would revert on, restated here from the Solidity rather than imported from the planner,
 * so a planner bug cannot also hide in its own test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planDesk, tickOfPrice, priceAtTick, BANK_CONST, STALE_MARGIN } from "../lib/desk-plan.mjs";
import { DEFAULT_GATES, contractOk } from "../lib/strategy.mjs";

const MID = 2e-6, NOW = 1_790_200_000, SPACING = 60;
const SPOT = Math.floor(tickOfPrice(MID));
const ARMED = { mid: MID, ethUsd: 2736, hourlyVol: 0.01, reversals72h: 8, drift72h: 0.01, walkForward7d: 0.02 };
const OFF = { ...ARMED, reversals72h: 2, drift72h: -0.237 };
const closed = { open: false, openedAt: 0 };

function snap(over = {}) {
  const base = {
    now: NOW, spotTick: SPOT, twapTick: SPOT, tickSpacing: SPACING, market: ARMED,
    bank: {
      halted: false, bookR: 1_000_000n * 10n ** 18n, bookW: 2n * 10n ** 18n,
      maxRangeBps: 1500n, maxDailyTurnoverBps: 5000n, usedBpsRf: 0n, usedBpsWeth: 0n, usedModifies: 0n, usedAt: 0n,
      ask: closed, bid: closed,
    },
    desk: { costRf: 0n, costWeth: 0n, lastSellWethPerRf: 0n, lastSellAt: 0, lossSpentWeth: 0n, twapEdgeTicks: 100 },
  };
  return {
    ...base, ...over,
    bank: { ...base.bank, ...(over.bank ?? {}) },
    desk: { ...base.desk, ...(over.desk ?? {}) },
  };
}
const fns = (p) => p.actions.map((a) => a.fn);
const get = (p, fn) => p.actions.find((a) => a.fn === fn);

/** The contract's own reverts, restated. */
function contractAccepts(s, fn, [lo, hi, amount]) {
  const isAsk = fn === "placeAsk";
  const side = isAsk ? s.bank.bookR : s.bank.bookW;
  if (lo % SPACING || hi % SPACING || lo >= hi) return "BadTicks";
  if (isAsk ? s.spotTick >= lo : s.spotTick < hi) return "WrongSideOfSpot";
  if (isAsk ? lo < s.twapTick + 100 : hi > s.twapTick - 100) return "TooCloseToTwap";
  if (amount * 10_000n > side * s.bank.maxRangeBps) return "CapTooHigh";
  if (amount * 10_000n < side * 100n) return "TooSmall";
  if (isAsk && s.desk.costRf > 0n && priceAtTick(lo) < (Number(s.desk.costWeth) / Number(s.desk.costRf)) * 1.05) return "LossBudget";
  if (!isAsk && s.desk.lastSellWethPerRf > 0n && s.now <= s.desk.lastSellAt + BANK_CONST.BID_LOCK_WINDOW
    && priceAtTick(hi) > (Number(s.desk.lastSellWethPerRf) / 1e36) * 0.95) return "LossLocked";
  return null;
}

test("armed with an empty desk: one ask and one bid, both accepted by the contract", () => {
  const s = snap();
  const p = planDesk(s);
  assert.equal(p.regime.armed, true, JSON.stringify(p.regime.checks));
  assert.deepEqual(fns(p), ["placeAsk", "placeBid"]);
  for (const a of p.actions) assert.equal(contractAccepts(s, a.fn, a.args), null, `${a.fn} ${a.args}`);
  // 15% of each side, the gates' and the contract's cap
  assert.equal(get(p, "placeAsk").args[2], (s.bank.bookR * 1500n) / 10_000n);
  assert.equal(get(p, "placeBid").args[2], (s.bank.bookW * 1500n) / 10_000n);
  // and the same ranges pass strategy.mjs's price-space contract check
  const [alo, ahi, aamt] = get(p, "placeAsk").args, [blo, bhi, bamt] = get(p, "placeBid").args;
  const sideValue = { ask: 1_000_000, bid: 2 };
  assert.ok(contractOk({ side: "ask", lo: priceAtTick(alo), hi: priceAtTick(ahi), rf: Number(aamt) / 1e18 }, { spot: MID, twap: MID, sideValue: sideValue.ask }));
  assert.ok(contractOk({ side: "bid", lo: priceAtTick(blo), hi: priceAtTick(bhi), weth: Number(bamt) / 1e18 }, { spot: MID, twap: MID, sideValue: sideValue.bid }));
});

test("the range is one grid step wide", () => {
  const p = planDesk(snap());
  const [lo, hi] = get(p, "placeAsk").args;
  assert.ok(priceAtTick(hi) / priceAtTick(lo) - 1 >= DEFAULT_GATES.gridStep);
});

test("not armed: an unfilled bid is closed, the ask keeps resting, nothing new is placed", () => {
  const s = snap({
    market: OFF,
    bank: { ask: { open: true, openedAt: NOW - 3600, lo: SPOT + 600, hi: SPOT + 1140, liquidity: 10n ** 20n },
            bid: { open: true, openedAt: NOW - 3600, lo: SPOT - 1140, hi: SPOT - 600, liquidity: 10n ** 20n } },
  });
  const p = planDesk(s);
  assert.equal(p.regime.armed, false);
  assert.deepEqual(fns(p), ["closeBid"]);
});

test("not armed with an empty desk: nothing at all", () => {
  assert.deepEqual(fns(planDesk(snap({ market: OFF }))), []);
});

test("a filled ask is closed and NOT re-placed in the same run (the flip is the next run)", () => {
  const s = snap({ bank: { ask: { open: true, openedAt: NOW - 3600, lo: SPOT - 1200, hi: SPOT - 600, liquidity: 10n ** 20n } } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["closeAsk", "placeBid"]);
});

test("a filled bid is closed", () => {
  const s = snap({ bank: { bid: { open: true, openedAt: NOW - 3600, lo: SPOT + 600, hi: SPOT + 1200, liquidity: 10n ** 20n } } });
  assert.ok(fns(planDesk(s)).includes("closeBid"));
});

test("a range close to its 7-day expiry is closed for a re-quote", () => {
  const age = BANK_CONST.RANGE_TTL - STALE_MARGIN;
  const s = snap({ bank: { ask: { open: true, openedAt: NOW - age, lo: SPOT + 600, hi: SPOT + 1140, liquidity: 10n ** 20n } } });
  assert.ok(fns(planDesk(s)).includes("closeAsk"));
  const fresh = snap({ bank: { ask: { open: true, openedAt: NOW - age + 60, lo: SPOT + 600, hi: SPOT + 1140, liquidity: 10n ** 20n } } });
  assert.ok(!fns(planDesk(fresh)).includes("closeAsk"));
});

test("ask loss-lock: never offered below bought cost x 1.05, never spends the loss budget", () => {
  const cost = MID * 1.2;   // RF bought well above today's price
  const s = snap({ desk: { costRf: 10n ** 24n, costWeth: BigInt(Math.round(cost * 1e24)) } });
  const a = get(planDesk(s), "placeAsk");
  assert.equal(contractAccepts(s, "placeAsk", a.args), null);
  assert.ok(priceAtTick(a.args[0]) >= cost * 1.05);
  assert.match(a.why, /loss-lock/);
});

test("bid loss-lock: never buys back above last sale x 0.95 inside 30 days, free after", () => {
  const last = MID * 1.01;
  const desk = { lastSellWethPerRf: BigInt(Math.round(last * 1e18)) * 10n ** 18n, lastSellAt: NOW - 86_400 };
  const s = snap({ desk });
  const b = get(planDesk(s), "placeBid");
  assert.equal(contractAccepts(s, "placeBid", b.args), null);
  assert.ok(priceAtTick(b.args[1]) <= last * 0.95);
  const lapsed = snap({ desk: { ...desk, lastSellAt: NOW - BANK_CONST.BID_LOCK_WINDOW - 1 } });
  assert.ok(get(planDesk(lapsed), "placeBid").args[1] > b.args[1]);
});

test("TWAP not ready: no placement, and it says why", () => {
  const p = planDesk(snap({ twapTick: null }));
  assert.deepEqual(fns(p), []);
  assert.ok(p.notes.some((n) => /TWAP/.test(n)));
});

test("daily turnover: sized down to the room left, skipped under 1%", () => {
  const s = snap({ bank: { usedBpsRf: 4000n, usedAt: BigInt(NOW) } });
  assert.equal(get(planDesk(s), "placeAsk").args[2], (s.bank.bookR * 1000n) / 10_000n);
  const full = snap({ bank: { usedBpsRf: 4950n, usedAt: BigInt(NOW) } });
  assert.ok(!fns(planDesk(full)).includes("placeAsk"));
});

test("24 modifies a day: nothing planned when the limit is used", () => {
  const s = snap({ bank: { usedModifies: 24n * 10n ** 18n, usedAt: BigInt(NOW) } });
  assert.deepEqual(fns(planDesk(s)), []);
});

test("halted: not armed (breaker), bids come down, no placements", () => {
  const s = snap({ bank: { halted: true, bid: { open: true, openedAt: NOW - 60, lo: SPOT - 1140, hi: SPOT - 600, liquidity: 10n ** 20n } } });
  assert.deepEqual(fns(planDesk(s)), ["closeBid"]);
});

test("inventory: a book heavy in RF quotes the ask only", () => {
  const s = snap({ bank: { bookR: 3_000_000n * 10n ** 18n, bookW: 3n * 10n ** 18n } });   // 6 WETH of RF vs 3 WETH: 67%
  const p = planDesk(s);
  // over the 60% ceiling the regime itself is off; under it but over the vol cap, bids are budgeted to zero
  const s2 = snap({ bank: { bookR: 1_475_000n * 10n ** 18n, bookW: 2n * 10n ** 18n } });  // 2.95 of 4.95 = 59.6%, over the 58.9% vol cap
  const p2 = planDesk(s2);
  assert.equal(p.regime.armed, false);
  assert.deepEqual(fns(p2), ["placeAsk"]);
});

test("a rung under the gas floor is not placed", () => {
  const s = snap({ bank: { bookR: 10n ** 22n, bookW: 10n ** 15n } });   // 10k RF = 0.02 WETH; 0.001 WETH
  assert.deepEqual(fns(planDesk(s)), []);
});

test("no live ETH/USD: nothing placed rather than guessing the floor", () => {
  assert.deepEqual(fns(planDesk(snap({ market: { ...ARMED, ethUsd: null } }))), []);
});
