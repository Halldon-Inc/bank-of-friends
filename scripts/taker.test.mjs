#!/usr/bin/env node
/**
 * The swap desk's rules (lib/strategy.mjs takerDecision).   node --test scripts/taker.test.mjs
 * Each test is named for the guarantee the hall prints next to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TAKER, takerDecision, takerBreakEven } from "../lib/strategy.mjs";

const P = 1e-6;
// A deep constant-product pool so quotes are close to price, with the full 5% toll.
const pool = (price, depthWeth = 1_000_000) => {
  const y = depthWeth, x = y / price, k = x * y, fee = TAKER.fee;
  return { buyPx: (w) => w / (x - k / (y + w * (1 - fee))), sellNet: (q) => (y - k / (x + q)) * (1 - fee) };
};
const book = (over = {}) => ({ rf: 500 / P, weth: 500, avgCost: P, lastSellNet: null, ...over });

test("waits inside the band", () => {
  const o = takerDecision({ price: P * 1.1, ema: P, drift72: 0 }, book(), pool(P * 1.1));
  assert.equal(o.action, "wait");
});

test("taker.test.mjs: no buying into a collapse", () => {
  const dip = { price: P * 0.6, ema: P, drift72: -0.10 };
  assert.equal(takerDecision(dip, book(), pool(dip.price)).action, "buy");
  const collapse = { ...dip, drift72: -0.40 };
  const o = takerDecision(collapse, book(), pool(collapse.price));
  assert.equal(o.action, "wait");
  assert.match(o.reason, /collapse/);
});

test("taker.test.mjs: RF cap", () => {
  const dip = { price: P * 0.6, ema: P, drift72: -0.10 };
  // 80% of the book in RF at this price: no more buying
  const heavy = book({ rf: (800 / dip.price), weth: 200 });
  const o = takerDecision(dip, heavy, pool(dip.price));
  assert.equal(o.action, "wait");
  assert.match(o.reason, /cap/);
});

test("taker.test.mjs: sells only above cost", () => {
  const up = { price: P * 1.4, ema: P, drift72: 0.4 };
  // bought at P: 1.4x after both tolls and impact is still above cost, so it sells half
  const o = takerDecision(up, book({ avgCost: P }), pool(up.price));
  assert.equal(o.action, "sell");
  assert.equal(o.amount, book().rf * TAKER.frac);
  // bought at 1.45P: a sale at 1.4P after the toll returns less than cost, so it waits
  const w = takerDecision(up, book({ avgCost: P * 1.45 }), pool(up.price));
  assert.equal(w.action, "wait");
  assert.match(w.reason, /less than it cost/);
});

test("never re-buys above what the last sale returned", () => {
  const dip = { price: P * 0.6, ema: P, drift72: -0.10 };
  const o = takerDecision(dip, book({ lastSellNet: P * 0.5 }), pool(dip.price));
  assert.equal(o.action, "wait");
});

test("break-even falls as membership rises", () => {
  const a = takerBreakEven(0.002), b = takerBreakEven(0.5), c = takerBreakEven(0.9);
  assert.ok(Math.abs(a.cost - 0.0975 * 0.998) < 1e-12);
  assert.ok(a.swing > b.swing && b.swing > c.swing);
  assert.ok(Math.abs(takerBreakEven(1).cost) < 1e-12);
});
