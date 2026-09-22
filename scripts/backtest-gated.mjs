#!/usr/bin/env node
/**
 * Backtest the REGIME-GATED market maker.
 *
 *   node scripts/backtest-gated.mjs
 *
 * Two runs, one strategy module (lib/strategy.mjs), so the code that decides in
 * simulation is exactly the code that will decide with real money.
 *
 *  RUN 1  the real history of the RF/WETH pool, 5.6 days.
 *         EXPECTED RESULT: the desk refuses to trade. If it trades here, the gates
 *         are wrong, because every strategy tested on this window lost money.
 *
 *  RUN 2  a SYNTHETIC ranging market with volume restored. Clearly labelled as
 *         synthetic. This does not predict anything. It answers one question only:
 *         if the conditions the desk is waiting for actually arrive, does it act,
 *         and does the grid clear the 10% toll?
 */
import fs from "node:fs";
import { DEFAULT_GATES, COSTS, evaluateRegime, nextOrder, realisedVol, drift, explain } from "../lib/strategy.mjs";
import { fmt } from "../lib/protocol.mjs";

const ETH_USD = 2734.86;
const FEE = 0.05;

/* ------------------------------------------------------------------- execution */
function buyRf(wethIn, mid, poolWeth, poolRf) {
  const net = wethIn * (1 - FEE);
  return poolRf - (poolRf * poolWeth) / (poolWeth + net);
}
function sellRf(rfIn, mid, poolWeth, poolRf) {
  const gross = poolWeth - (poolRf * poolWeth) / (poolRf + rfIn);
  return gross * (1 - FEE);
}

/**
 * Drive the strategy over a price/volume tape. `tape` entries:
 *   { t, mid, tradeWeth, poolWeth, poolRf }
 */
function run(tape, book0, gates = DEFAULT_GATES, label = "") {
  const book = { rf: book0.rf, weth: book0.weth, halted: false, hwmWeth: 0, valueWeth: 0 };
  const state = { gridRef: null, fillsThisHour: 0, hourBucket: null };
  let fills = 0, gasUsd = 0, armedTicks = 0, standDownTicks = 0;
  const reasons = new Map();
  // Price history must be windowed by TIME, not by trade count. An earlier version
  // kept "the last 240 mids", which on launch day was about an hour and on a quiet
  // day was a day and a half. The desk armed mid-crash because its "24h drift" was
  // really a 1h drift. Units matter.
  const hist = [];              // { t, mid }
  let vol24 = 0, trades24 = 0;
  const day = [];
  // Warm-up must be measured from the FIRST tick ever seen, not from the pruned
  // window's head: hist is trimmed to 24h, so `now - hist[0].t >= 86400` can never
  // be true and the desk would sit out forever while appearing to pass.
  const firstT = tape[0].t;
  let warmedUp = false;

  for (const q of tape) {
    hist.push({ t: q.t, mid: q.mid });
    while (hist.length && q.t - hist[0].t > 86400) hist.shift();
    day.push({ t: q.t, w: q.tradeWeth }); while (day.length && q.t - day[0].t > 86400) day.shift();
    // Refuse to act on a partial window: a rolling stat needs its full lookback.
    if (!warmedUp && q.t - firstT >= 86400) warmedUp = true;
    vol24 = day.reduce((a, b) => a + b.w, 0);
    trades24 = day.length;

    const hour = Math.floor(q.t / 3600);
    if (state.hourBucket !== hour) { state.hourBucket = hour; state.fillsThisHour = 0; }

    book.valueWeth = book.weth + book.rf * q.mid;
    book.hwmWeth = Math.max(book.hwmWeth, book.valueWeth);

    const since = (sec) => hist.filter((h) => q.t - h.t <= sec).map((h) => h.mid);
    const lastHour = since(3600);
    const market = {
      mid: q.mid, ethUsd: ETH_USD,
      volume24hWeth: vol24, trades24h: trades24,
      drift24h: drift(hist.map((h) => h.mid)),
      drift1h: drift(lastHour),
      // Scale per-observation vol to an hourly figure using the real sample spacing.
      hourlyVol: (() => {
        if (lastHour.length < 5) return 0;
        const span = Math.max(q.t - (hist.find((h) => q.t - h.t <= 3600)?.t ?? q.t), 1);
        return realisedVol(lastHour) * Math.sqrt(Math.max(lastHour.length - 1, 1) * (3600 / span));
      })(),
    };

    const order = warmedUp ? nextOrder(market, book, state, gates)
                           : { action: "stand-down", regime: { armed: false, checks: [{ gate: "warmup", ok: false, detail: "less than 24h of price history" }] } };
    if (order.action === "stand-down") {
      standDownTicks++;
      for (const c of order.regime.checks) if (!c.ok) reasons.set(c.gate, (reasons.get(c.gate) || 0) + 1);
      continue;
    }
    armedTicks++;
    if (state.gridRef === null) state.gridRef = q.mid;

    if (order.action === "buy") {
      const got = buyRf(order.weth, q.mid, q.poolWeth, q.poolRf);
      book.rf += got; book.weth -= order.weth;
      fills++; gasUsd += COSTS.gasUsdPerFill; state.fillsThisHour++; state.gridRef = q.mid;
    } else if (order.action === "sell") {
      const got = sellRf(order.rf, q.mid, q.poolWeth, q.poolRf);
      book.weth += got; book.rf -= order.rf;
      fills++; gasUsd += COSTS.gasUsdPerFill; state.fillsThisHour++; state.gridRef = q.mid;
    }
  }

  const last = tape[tape.length - 1];
  const realisable = book.weth - gasUsd / ETH_USD + (book.rf > 0 ? sellRf(book.rf, last.mid, last.poolWeth, last.poolRf) : 0);
  const holdRf = book0.rf, holdWeth = book0.weth;
  const holdValue = holdWeth + (holdRf > 0 ? sellRf(holdRf, last.mid, last.poolWeth, last.poolRf) : 0);
  return { label, fills, gasUsd, armedTicks, standDownTicks, reasons, book, realisable, holdValue, ticks: tape.length };
}

function report(r) {
  console.log(`\n  ticks            ${r.ticks}`);
  console.log(`  armed on         ${r.armedTicks} ticks (${(r.armedTicks / r.ticks * 100).toFixed(1)}%)`);
  console.log(`  stood down on    ${r.standDownTicks} ticks (${(r.standDownTicks / r.ticks * 100).toFixed(1)}%)`);
  console.log(`  FILLS            ${r.fills}`);
  console.log(`  gas spent        $${r.gasUsd.toFixed(2)}`);
  if (r.reasons.size) {
    console.log(`  why it stood down (ticks blocked by each gate):`);
    for (const [g, n] of [...r.reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${g.padEnd(12)} ${n}`);
    }
  }
  console.log(`  end book         ${fmt.n(r.book.rf)} RF + ${r.book.weth.toFixed(6)} WETH`);
  console.log(`  realisable       ${r.realisable.toFixed(6)} WETH ($${(r.realisable * ETH_USD).toFixed(2)})`);
  console.log(`  hold benchmark   ${r.holdValue.toFixed(6)} WETH ($${(r.holdValue * ETH_USD).toFixed(2)})`);
  const d = r.holdValue > 0 ? ((r.realisable / r.holdValue) - 1) * 100 : 0;
  console.log(`  vs hold          ${d >= 0 ? "+" : ""}${d.toFixed(2)}%`);
}

/* ================================================== RUN 1: the real tape */
console.log("=".repeat(86));
console.log("RUN 1  -  REAL HISTORY of the RF/WETH pool");
console.log("         every strategy tested on this window lost money, so a correct");
console.log("         desk should refuse to trade. That is the pass condition.");
console.log("=".repeat(86));

const raw = JSON.parse(fs.readFileSync("data/swaps.json", "utf8"));
const S = raw.swaps.map((s) => ({ t: s.t, sq: BigInt(s.sq), liq: BigInt(s.liq), a1: BigInt(s.a1) })).sort((a, b) => a.t - b.t);
const realTape = S.map((s) => {
  const sp = Number(s.sq) / 2 ** 96, mid = sp * sp, L = Number(s.liq) / 1e18;
  return { t: s.t, mid, tradeWeth: Math.abs(Number(s.a1)) / 1e18, poolWeth: L * sp, poolRf: L / sp };
});
const BOOK = { rf: 3159.22, weth: 0.028987 };   // Hunt's actual idle rewards
console.log(`\nbook: ${fmt.n(BOOK.rf)} RF + ${BOOK.weth} WETH  ($${((BOOK.weth + BOOK.rf * realTape[0].mid) * ETH_USD).toFixed(2)} at open)`);
const r1 = run(realTape, BOOK, DEFAULT_GATES, "real");
report(r1);
console.log(`\n  VERDICT: ${r1.fills === 0 ? "PASS - the desk correctly stayed flat through a -89% slide." : `${r1.fills} fills. Review the gates.`}`);

/* ================================================== RUN 2: synthetic ranging market */
console.log(`\n${"=".repeat(86)}`);
console.log("RUN 2  -  SYNTHETIC ranging market, volume restored");
console.log("         THIS IS NOT A PREDICTION. It is generated data, and it answers one");
console.log("         question: if the conditions the desk waits for arrive, does it act?");
console.log("=".repeat(86));

function syntheticRange({ ticks = 6000, mid0 = 5.7e-7, halfLife = 400, sigma = 0.012, band = 0.28, tradeWeth = 0.02, seed = 42 }) {
  // Ornstein-Uhlenbeck around a flat mean: chop, no trend. Exactly the regime the gates want.
  let s = seed, mid = mid0;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const kappa = Math.log(2) / halfLife;
  const out = [];
  const L = 147865.85, t0 = 1790000000;
  for (let i = 0; i < ticks; i++) {
    const logDev = Math.log(mid / mid0);
    mid = mid * Math.exp(-kappa * logDev + sigma * gauss());
    mid = Math.min(mid0 * (1 + band), Math.max(mid0 * (1 - band), mid));
    const sp = Math.sqrt(mid);
    out.push({ t: t0 + i * 60, mid, tradeWeth: tradeWeth * (0.5 + rnd()), poolWeth: L * sp, poolRf: L / sp });
  }
  return out;
}

const synth = syntheticRange({});
const sVol24 = synth.slice(0, 1440).reduce((a, b) => a + b.tradeWeth, 0);
console.log(`\nsynthetic tape: ${synth.length} one-minute ticks (${(synth.length / 1440).toFixed(1)} days)`);
console.log(`  mean-reverting, no trend, +/-28% band, ~${sVol24.toFixed(0)} WETH/day volume, ${1440} trades/day`);
console.log(`  (for scale: the real market did 13.7 WETH/day and ~40 router trades/day)`);
const r2 = run(synth, BOOK, DEFAULT_GATES, "synthetic");
report(r2);
console.log(`\n  VERDICT: ${r2.fills > 0 ? `the desk armed and worked the grid (${r2.fills} fills).` : "the desk stayed flat even here. Gates are too tight."}`);

/* ================================================== what has to change */
console.log(`\n${"=".repeat(86)}`);
console.log("WHAT HAS TO CHANGE BEFORE THIS DESK TURNS ON, measured against today");
console.log("=".repeat(86));
const today = { volume24hWeth: 13.73, trades24h: 41, drift24h: -0.187, drift1h: 0, hourlyVol: 0.1266, mid: 5.7175e-7, ethUsd: ETH_USD };
const reg = evaluateRegime(today, { rf: BOOK.rf, weth: BOOK.weth, valueWeth: BOOK.weth + BOOK.rf * today.mid, hwmWeth: BOOK.weth + BOOK.rf * today.mid, halted: false });
console.log(`\nstatus right now: ${reg.armed ? "ARMED" : "FLAT"}\n`);
console.log(`${"gate".padEnd(14)}${"ok".padEnd(6)}detail`);
console.log("-".repeat(80));
for (const c of reg.checks) console.log(`${c.gate.padEnd(14)}${(c.ok ? "yes" : "NO").padEnd(6)}${c.detail}`);
console.log("-".repeat(80));
console.log(`\n${explain(reg)}`);
