#!/usr/bin/env node
/**
 * Backtest the MAKER-ONLY, regime-gated range-order desk.
 *
 *   node scripts/backtest-gated.mjs            (writes docs/STRATEGY.md's code block)
 *
 * One strategy module (lib/strategy.mjs), one engine (scripts/backtest-engine.mjs),
 * endogenous price path. Three runs:
 *
 *  RUN 1  the real history of the RF/WETH pool, gated as it would be live.
 *         Plus the COUNTERFACTUAL: the same grid with the arming rule off.
 *         PASS = the gated desk loses nothing on the real tape.
 *
 *  RUN 2  a SYNTHETIC ranging tape, 14 days, long enough for every gate including
 *         the 7-day replay to become measurable. Labelled as synthetic: it answers
 *         only "when the conditions arrive, does the desk act, and does it keep it?"
 *
 *  RUN 3  the gates as of the LAST SWAP in data/swaps.json, computed, not typed in.
 *         The live figure is /api/desk; this is the tape's figure, dated.
 *
 *   node scripts/backtest-gated.mjs --export-hourly
 *     also writes app/lib/price-hourly.json, the hourly closes the live desk uses for
 *     anything older than its own 72h scan. Refresh data/swaps.json first
 *     (node scripts/fetch-history.mjs), then run this before every deploy.
 */
import fs from "node:fs";
import { DEFAULT_GATES, evaluateRegime, measurePath, makerEdgePerRoundTrip, BREAKEVEN_STEP } from "../lib/strategy.mjs";
import { loadTape, simulateDesk, syntheticTape, hourlyCloses } from "./backtest-engine.mjs";

const ETH_USD = 2736;   // SNAPSHOT (CoinGecko 2026-09-22), fixed so reruns are comparable; the live figure is /api/desk
const out = [];
const log = (s = "") => { out.push(s); console.log(s); };
const pct = (v, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const line = "=".repeat(86);

function report(title, r, book) {
  log(`  ${title}`);
  log(`    book            ${book}`);
  log(`    hours           ${r.hours}   armed ${r.armedHours} (${(r.armedHours / Math.max(r.hours, 1) * 100).toFixed(1)}%)`);
  log(`    range flips     ${r.flips}   refused by contract rules ${r.refused}   deferred by daily limits ${r.deferred}   gas $${r.gasUsd.toFixed(2)}${r.halted ? "   HALTED by drawdown" : ""}`);
  log(`    realisable      ${r.realisable.toFixed(6)} WETH ($${(r.realisable * ETH_USD).toFixed(2)})`);
  log(`    hold            ${r.hold.toFixed(6)} WETH ($${(r.hold * ETH_USD).toFixed(2)})`);
  log(`    vs hold         ${pct(r.vsHold)}`);
  const b = Object.entries(r.blockers).sort((a, c) => c[1] - a[1]).map(([g, n]) => `${g} ${n}h`).join(", ");
  if (b) log(`    hours off, by gate (a gate is counted when blocking OR not yet measurable): ${b}`);
}

const { tape, meta } = loadTape();
const last = tape.at(-1);
const days = (last.t - tape[0].t) / 86400;

log(line);
log("RUN 1  -  REAL HISTORY of the RF/WETH pool, maker-only grid, endogenous replay");
log(line);
log(`tape: ${meta.swaps} swaps, blocks ${meta.firstBlock} -> ${meta.lastBlock}, ${days.toFixed(2)} days`);
log(`price ${tape[0].pxBefore.toExponential(4)} -> ${last.px.toExponential(4)} WETH (${pct(last.px / tape[0].pxBefore - 1, 1)})`);
log(`grid: step ${DEFAULT_GATES.gridStep * 100}%, ${DEFAULT_GATES.rungs} rungs, loss-lock ${DEFAULT_GATES.lockBps / 100}%`);
log(`maker edge per round trip ${pct(makerEdgePerRoundTrip(DEFAULT_GATES.gridStep, DEFAULT_GATES.lockBps / 1e4))} before gas; a TAKER grid needs a ${(BREAKEVEN_STEP * 100).toFixed(2)}% step to break even\n`);
const hunt = { rf0: 3159, weth0: 0.028987 };   // MEASURED: Hunt's idle rewards when the study began
const bal = { rf0: (10000 / ETH_USD) / 2 / tape[0].pxBefore, weth0: (10000 / ETH_USD) / 2 };
const r1h = simulateDesk(tape, { ...hunt, ethUsd: ETH_USD });
const r1b = simulateDesk(tape, { ...bal, ethUsd: ETH_USD });
const c1b = simulateDesk(tape, { ...bal, ethUsd: ETH_USD, alwaysArmed: true });
report("GATED, Hunt's book", r1h, "3,159 RF + 0.028987 WETH");
log("");
report("GATED, $10k balanced", r1b, "$5,000 RF + $5,000 WETH at the opening price");
log("");
report("COUNTERFACTUAL: same grid, arming rule OFF (risk gates still on)", c1b, "$10k balanced");
log("");
// PASS means the live desk lost nothing on the real tape. The counterfactual is shown
// beside it and not hidden when it is better: the arming rule costs something in some
// markets, and scripts/sweep-regimes.mjs shows what it buys in the others.
log(r1b.vsHold >= -1e-9 && r1h.vsHold >= -1e-9
  ? `  VERDICT: PASS. The gated desk lost nothing (${pct(r1b.vsHold)}). Ungated it would have been ${pct(c1b.vsHold)}` +
    (c1b.vsHold < r1b.vsHold ? `:\n  the arming rule saved ${((r1b.vsHold - c1b.vsHold) * 100).toFixed(2)}% of the book.` : `:\n  on this tape the arming rule cost ${((c1b.vsHold - r1b.vsHold) * 100).toFixed(2)}%.`)
  : `  VERDICT: FAIL. The gated desk lost money on the real tape: ${pct(r1b.vsHold)}.`);
log(`  Friends' fee stream in the replay: ${r1b.feesToFriendsWeth.toFixed(2)} WETH gated, ${c1b.feesToFriendsWeth.toFixed(2)} WETH ungated (takers pay 5% whoever fills them).`);

log("\n" + line);
log("RUN 2  -  SYNTHETIC ranging tape, 14 days. NOT A PREDICTION.");
log("         mean-reverting taker flow around a flat anchor; it answers only whether the");
log("         desk arms when the market swings, and whether it keeps what it earns");
log(line);
const synth = syntheticTape({ days: 14, sigma: 0.012, pull: 0.03, seed: 7 });   // CHOICE: 5-min steps
const sp = synth.map((x) => x.px);
log(`tape: ${synth.length} taker trades, price range ${Math.min(...sp).toExponential(3)} to ${Math.max(...sp).toExponential(3)}, net ${pct(synth.at(-1).px / synth[0].pxBefore - 1, 1)}`);
const sbal = { rf0: (10000 / ETH_USD) / 2 / synth[0].pxBefore, weth0: (10000 / ETH_USD) / 2 };
const r2 = simulateDesk(synth, { ...sbal, ethUsd: ETH_USD });
const c2 = simulateDesk(synth, { ...sbal, ethUsd: ETH_USD, alwaysArmed: true });
report("GATED, $10k balanced", r2, "$5,000 RF + $5,000 WETH");
log("");
report("COUNTERFACTUAL: arming rule OFF", c2, "$10k balanced");
log("");
log(r2.armedHours > 0 && r2.flips > 0
  ? `  VERDICT: the desk armed after its warm-up and worked the grid (${r2.flips} flips, ${pct(r2.vsHold)} vs hold).`
  : "  VERDICT: the desk never traded even here. The gates are too tight for the market they wait for.");

log("\n" + line);
log(`RUN 3  -  THE GATES AS OF THE TAPE'S LAST SWAP (block ${meta.lastBlock}, ${new Date(last.t * 1000).toISOString().slice(0, 16)}Z)`);
log("         computed from data/swaps.json, not typed in. The live figure is /api/desk.");
log(line);
const hourly = [];
{ let i = 0, p = tape[0].pxBefore; for (let h = Math.ceil(tape[0].t / 3600) * 3600; h <= last.t + 3600; h += 3600) { while (i < tape.length && tape[i].t <= h) p = tape[i++].px; hourly.push(p); } }
const t72 = last.t - 72 * 3600;
const ticks = [tape.filter((e) => e.t <= t72).at(-1)?.px ?? tape[0].pxBefore, ...tape.filter((e) => e.t > t72).map((e) => e.px)];
const m = measurePath(hourly, DEFAULT_GATES, ticks);
const v = hunt.weth0 + hunt.rf0 * last.px;
const reg = evaluateRegime({ ...m, ethUsd: ETH_USD }, { rf: hunt.rf0, weth: hunt.weth0, valueWeth: v, hwmWeth: v, halted: false });
log(`status: ${reg.armed ? "ARMED" : "OFF"}\n`);
log(`${"gate".padEnd(16)}${"state".padEnd(12)}detail`);
log("=".repeat(86));
for (const c of reg.checks) log(`${c.gate.padEnd(16)}${(c.status === "unmeasured" ? "not yet" : c.status).padEnd(12)}${c.detail}`);

if (process.argv.includes("--export-hourly")) {
  const h = hourlyCloses(tape);
  fs.writeFileSync("app/lib/price-hourly.json", JSON.stringify({ generatedAt: new Date().toISOString(), source: "data/swaps.json", ...h }) + "\n");
  console.log(`\nwrote app/lib/price-hourly.json: ${h.closes.length} hourly closes to block ${h.lastBlock} (${new Date(h.lastTs * 1000).toISOString()})`);
}

if (process.argv.includes("--write")) {
  const md = fs.readFileSync("docs/STRATEGY.md", "utf8");
  const a = md.indexOf("```\n"), b = md.indexOf("```", a + 4);
  if (a >= 0 && b > a) fs.writeFileSync("docs/STRATEGY.md", md.slice(0, a + 4) + out.join("\n") + "\n" + md.slice(b));
  console.log("\nwrote docs/STRATEGY.md");
}
