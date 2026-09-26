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

test("not armed: an unfilled bid is closed, an ask inside the chase band keeps resting, nothing new is placed", () => {
  const edge = get(planDesk(snap({ market: OFF })), "placeAsk").args[0];   // where the standing order would rest now
  const s = snap({
    market: OFF,
    bank: { ask: { open: true, openedAt: NOW - 3600, lo: edge + SPACING, hi: edge + 3 * SPACING, liquidity: 10n ** 20n },
            bid: { open: true, openedAt: NOW - 3600, lo: SPOT - 1140, hi: SPOT - 600, liquidity: 10n ** 20n } },
  });
  const p = planDesk(s);
  assert.equal(p.regime.armed, false);
  assert.deepEqual(fns(p), ["closeBid"]);
});

test("not armed with an empty desk: the standing sell order takes the ask slot, the bid stays empty", () => {
  const s = snap({ market: OFF });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["placeAsk"]);
  assert.equal(contractAccepts(s, "placeAsk", get(p, "placeAsk").args), null);
  assert.match(get(p, "placeAsk").why, /standing order \(edge\)/);
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

test("a grid rung under the gas floor is not placed", () => {
  const s = snap({ bank: { bookR: 2_000n * 10n ** 18n, bookW: 4n * 10n ** 15n } });   // 2k RF = 0.004 WETH; 0.004 WETH: armed, $11 a side
  const p = planDesk(s);
  assert.equal(p.regime.armed, true);
  assert.deepEqual(fns(p), []);
  assert.ok(p.notes.some((n) => /rung floor/.test(n)));
});

test("no live ETH/USD: nothing placed rather than guessing the floor", () => {
  assert.deepEqual(fns(planDesk(snap({ market: { ...ARMED, ethUsd: null } }))), []);
});

/* ===================================================== the standing sell order */
import { standingOrder, explainStanding, STANDING, snapPrice } from "../lib/strategy.mjs";

const TWAP = priceAtTick(SPOT);
const CALM = { ...OFF, drift24h: 0.01, high72h: MID * 1.3 };       // off, no rally
/** Where the edge ask rests now, in ticks, from a plan on an empty desk. */
const edgeLo = (over = {}) => get(planDesk(snap({ market: CALM, ...over })), "placeAsk").args[0];

test("standing (a): not armed, $1,000 of idle RF: exactly one ask, accepted by the contract, one spacing past the edge, two wide, 15%", () => {
  const rf = BigInt(Math.round(1000 / 2736 / MID)) * 10n ** 18n;
  const s = snap({ market: CALM, bank: { bookR: rf, bookW: 10n ** 16n } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["placeAsk"]);
  const a = get(p, "placeAsk");
  assert.equal(contractAccepts(s, "placeAsk", a.args), null);
  const [lo, hi, amt] = a.args;
  assert.ok(lo >= SPOT + 1 && lo >= s.twapTick + 100);
  const snappedEdge = Math.ceil((s.twapTick + 100) / SPACING) * SPACING;
  assert.equal(lo, snappedEdge + SPACING);
  assert.equal(hi - lo, STANDING.widthSpacings * SPACING);
  assert.equal(amt, (rf * 1500n) / 10_000n);
  assert.match(a.why, /standing order \(edge\)/);
  assert.equal(p.standing.mode, "edge");
});

test("standing (b): an RF book under $50 is idle, and the note says so", () => {
  const rf = BigInt(Math.round(30 / 2736 / MID)) * 10n ** 18n;
  const p = planDesk(snap({ market: CALM, bank: { bookR: rf, bookW: 10n ** 16n } }));
  assert.deepEqual(fns(p), []);
  assert.equal(p.standing.mode, "idle");
  assert.ok(p.notes.some((n) => /under the \$50 floor/.test(n)));
});

test("standing (c): an edge ask 3% above where the edge is now is chased down", () => {
  const lo = edgeLo();
  const off = Math.round(Math.log(1.03) / Math.log(1.0001) / SPACING) * SPACING;
  const s = snap({ market: CALM, bank: { ask: { open: true, openedAt: NOW - 7200, lo: lo + off, hi: lo + off + 2 * SPACING, liquidity: 10n ** 20n } } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["closeAsk"]);
  assert.match(get(p, "closeAsk").why, /standing order \(edge\): chase/);
});

test("standing (d): an ask younger than an hour, 1% above the edge, is left alone", () => {
  const lo = edgeLo();
  const off = Math.round(Math.log(1.01) / Math.log(1.0001) / SPACING) * SPACING;
  const s = snap({ market: CALM, bank: { ask: { open: true, openedAt: NOW - 600, lo: lo + off, hi: lo + off + 2 * SPACING, liquidity: 10n ** 20n } } });
  assert.deepEqual(fns(planDesk(s)), []);
});

test("standing (e): the trend brake (24h drift +12%) places a take-profit ask from TWAP x 1.10 to TWAP x 2.0", () => {
  const s = snap({ market: { ...CALM, drift24h: 0.12 } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["placeAsk"]);
  const a = get(p, "placeAsk");
  assert.equal(contractAccepts(s, "placeAsk", a.args), null);
  const [lo, hi] = a.args;
  assert.ok(priceAtTick(lo) >= TWAP * STANDING.takeProfitLo);
  assert.ok(Math.abs(priceAtTick(hi) / (TWAP * STANDING.takeProfitHi) - 1) < 0.01);
  assert.match(a.why, /standing order \(take-profit\)/);
  assert.equal(p.standing.mode, "takeProfit");
});

test("standing (e2): a new 72h high fires the brake too", () => {
  const p = planDesk(snap({ market: { ...CALM, drift24h: 0.02, high72h: MID } }));
  assert.equal(p.standing.mode, "takeProfit");
  assert.deepEqual(fns(p), ["placeAsk"]);
});

test("standing (f): a take-profit ask half crossed is realised", () => {
  const lo = Math.ceil(tickOfPrice(TWAP * 1.10) / SPACING) * SPACING, hi = Math.ceil(tickOfPrice(TWAP * 2.0) / SPACING) * SPACING;
  const midTick = Math.round((lo + hi) / 2);   // geometric middle in price = arithmetic middle in ticks
  const s = snap({ market: { ...CALM, drift24h: 0.12, mid: priceAtTick(midTick + 1) }, spotTick: midTick + 1,
    bank: { ask: { open: true, openedAt: NOW - 7200, lo, hi, liquidity: 10n ** 20n } } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["closeAsk"]);
  assert.match(get(p, "closeAsk").why, /realise/);
});

test("standing (g): the rally is over (24h drift +1%): the take-profit ask comes down for the edge", () => {
  const lo = Math.ceil(tickOfPrice(TWAP * 1.10) / SPACING) * SPACING, hi = Math.ceil(tickOfPrice(TWAP * 2.0) / SPACING) * SPACING;
  const s = snap({ market: CALM, bank: { ask: { open: true, openedAt: NOW - 7200, lo, hi, liquidity: 10n ** 20n } } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["closeAsk"]);
  assert.match(get(p, "closeAsk").why, /rally over/);
  assert.equal(p.standing.mode, "edge");
});

test("standing (g2): the brake fires while an edge ask rests: the edge ask is pulled first", () => {
  const lo = edgeLo();
  const s = snap({ market: { ...CALM, drift24h: 0.15 }, bank: { ask: { open: true, openedAt: NOW - 7200, lo, hi: lo + 2 * SPACING, liquidity: 10n ** 20n } } });
  const p = planDesk(s);
  assert.deepEqual(fns(p), ["closeAsk"]);
  assert.match(get(p, "closeAsk").why, /take-profit\): rally/);
});

test("standing (h): armed, the grid owns both slots and the standing order steps aside", () => {
  const p = planDesk(snap({ market: { ...ARMED, drift24h: 0.2, high72h: MID } }));
  assert.equal(p.standing.mode, "grid");
  assert.deepEqual(fns(p), ["placeAsk", "placeBid"]);
  assert.match(get(p, "placeAsk").why, /^armed/);
});

test("standing (i): bought RF above the edge holds the standing ask up to cost x 1.05", () => {
  const cost = MID * 1.2;
  const s = snap({ market: CALM, desk: { costRf: 10n ** 24n, costWeth: BigInt(Math.round(cost * 1e24)) } });
  const a = get(planDesk(s), "placeAsk");
  assert.equal(contractAccepts(s, "placeAsk", a.args), null);
  assert.ok(priceAtTick(a.args[0]) >= cost * 1.05);
  assert.match(a.why, /standing order \(edge\).*loss-lock/);
});

test("standing (k): halted, or TWAP not ready, or the brake unmeasured", () => {
  assert.deepEqual(fns(planDesk(snap({ market: CALM, bank: { halted: true } }))), []);
  assert.deepEqual(fns(planDesk(snap({ market: CALM, twapTick: null }))), []);
  const p = planDesk(snap({ market: { ...OFF, drift24h: null, high72h: null } }));   // the edge runs by default
  assert.deepEqual(fns(p), ["placeAsk"]);
  assert.match(p.standing.reason, /not yet measurable/);
});

/* standingOrder itself, in price space */
const PM = { mid: MID, twap: MID, ethUsd: 2736, drift24h: 0.01, high72h: MID * 1.3 };
const PB = { rf: 1000 / 2736 / MID, weth: 0.01, valueWeth: 1000 / 2736 + 0.01, avgCost: 0 };
const edgeNow = () => snapPrice(MID * 1.0001 ** 100, SPACING, "up") * 1.0001 ** SPACING;

test("standingOrder (j): edge placement, sizes and width", () => {
  const o = standingOrder(PM, PB, { gridArmed: false, now: NOW });
  assert.equal(o.mode, "edge");
  assert.ok(Math.abs(o.place.lo / edgeNow() - 1) < 1e-9);
  assert.ok(Math.abs(o.place.hi / o.place.lo - 1.0001 ** (2 * SPACING)) < 1e-9);
  assert.equal(o.place.frac, 0.15);
  assert.match(explainStanding(o, PM), /Resting 15\.0% of the bank's RF for sale/);
});

test("standingOrder (j): idle under $50, grid armed, brake, ratchet, release, chase, young ask, lock", () => {
  assert.equal(standingOrder(PM, { ...PB, rf: 30 / 2736 / MID }, { now: NOW }).mode, "idle");
  assert.equal(standingOrder(PM, PB, { gridArmed: true, now: NOW }).mode, "grid");
  const tp = standingOrder({ ...PM, drift24h: 0.11 }, PB, { now: NOW });
  assert.equal(tp.mode, "takeProfit");
  assert.ok(tp.place.lo >= MID * 1.10 && Math.abs(tp.place.hi / (MID * 2) - 1) < 0.01);
  assert.equal(standingOrder({ ...PM, drift24h: 0.02, high72h: MID }, PB, { now: NOW }).mode, "takeProfit");
  const open = { lo: tp.place.lo, hi: tp.place.hi, openedAt: NOW - 7200 };
  const ratchet = standingOrder({ ...PM, drift24h: 0.11, mid: Math.sqrt(open.lo * open.hi) * 1.001 }, PB, { now: NOW, ask: open });
  assert.ok(ratchet.close && /realise/.test(ratchet.closeWhy));
  const rel = standingOrder({ ...PM, drift24h: 0.01 }, PB, { now: NOW, ask: open });
  assert.ok(rel.close && /rally over/.test(rel.closeWhy) && rel.mode === "edge");
  const keep = standingOrder({ ...PM, drift24h: 0.05 }, PB, { now: NOW, ask: open });
  assert.equal(keep.close, undefined);
  const far = { lo: edgeNow() * 1.03, hi: edgeNow() * 1.04, openedAt: NOW - 7200 };
  assert.match(standingOrder(PM, PB, { now: NOW, ask: far }).closeWhy, /chase/);
  assert.equal(standingOrder(PM, PB, { now: NOW, ask: { ...far, openedAt: NOW - 60 } }).close, undefined);
  const near = { lo: edgeNow() * 1.01, hi: edgeNow() * 1.02, openedAt: NOW - 7200 };
  assert.equal(standingOrder(PM, PB, { now: NOW, ask: near }).close, undefined);
  const locked = standingOrder(PM, { ...PB, avgCost: MID * 1.2 }, { now: NOW });
  assert.ok(locked.place.lo >= MID * 1.2 * 1.05);
  assert.match(standingOrder({ ...PM, drift24h: null, high72h: null }, PB, { now: NOW }).reason, /not yet measurable/);
});
