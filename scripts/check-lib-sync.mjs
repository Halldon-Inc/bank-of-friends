#!/usr/bin/env node
/**
 * The app ships its own copy of the strategy so it can deploy standalone.
 * A second copy is a second source of truth, which goes stale silently and then
 * the dashboard shows gates the desk is not actually using. Assert they are
 * byte-identical on every CI run.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { GATE_LABELS, GATE_INPUTS, evaluateRegime, DEFAULT_GATES } from "../lib/strategy.mjs";

let bad = 0;
for (const f of ["strategy.mjs", "protocol.mjs"]) {
  const a = fs.readFileSync(`lib/${f}`);
  const b = fs.existsSync(`app/lib/${f}`) ? fs.readFileSync(`app/lib/${f}`) : null;
  const h = (x) => (x ? crypto.createHash("sha256").update(x).digest("hex").slice(0, 12) : "MISSING");
  const ok = b && a.equals(b);
  console.log(`${ok ? "  ok  " : " FAIL "} lib/${f} ${h(a)}  vs  app/lib/${f} ${h(b)}`);
  if (!ok) bad++;
}
if (bad) { console.error(`\n${bad} file(s) out of sync. Run: cp lib/*.mjs app/lib/`); process.exit(1); }
console.log("\nlib copies are identical.");

/**
 * Every gate needs a human label. A gate added without one printed its raw key in
 * a column of spaced English once; the labels now live next to the gates.
 */
const probe = evaluateRegime(
  { mid: 1, hourlyVol: 0.01, reversals72h: 0, drift72h: 0, walkForward7d: 0 },
  { rf: 0, weth: 1, valueWeth: 1, hwmWeth: 1, halted: false },
);
const gates = probe.checks.map((c) => c.gate);
const unlabelled = gates.filter((g) => !GATE_LABELS[g]);
console.log(`${unlabelled.length ? " FAIL " : "  ok  "} ${gates.length} gates in the strategy, ${gates.length - unlabelled.length} labelled`);
if (unlabelled.length) { console.error(`no label for: ${unlabelled.join(", ")}. Add them to GATE_LABELS.`); process.exit(1); }

/**
 * THE DEFECT THIS EXISTS FOR: the 7-day drift gate was evaluated by the strategy but
 * never fed by the live desk, so it read "no 7-day history yet" forever and the live
 * desk could never arm. Two checks, one static and one behavioural:
 *  1. every `market.*` / `book.*` input a gate declares appears as a key in the
 *     object literal app/lib/desk.ts passes to evaluateRegime;
 *  2. a market built from ONLY those keys, with numbers in them, leaves no gate
 *     "unmeasured". If a gate reads an input nobody declared, this catches it.
 */
const desk = fs.readFileSync("app/lib/desk.ts", "utf8");
const literalKeys = (name) => {
  const i = desk.indexOf(`const ${name} = {`);
  if (i < 0) return null;
  const end = desk.indexOf("};", i);
  return new Set([...desk.slice(i, end).matchAll(/^\s*([A-Za-z0-9_]+)\s*[:,]/gm)].map((m) => m[1])
    .concat([...desk.slice(i, end).matchAll(/\b([A-Za-z0-9_]+):/g)].map((m) => m[1])));
};
const supplied = { market: literalKeys("marketState"), book: literalKeys("book") };
let missing = [];
for (const g of gates) {
  const inputs = GATE_INPUTS[g];
  if (!inputs) { missing.push(`${g}: declares no inputs in GATE_INPUTS`); continue; }
  for (const inp of inputs) {
    const [obj, key] = inp.split(".");
    if (!supplied[obj]) { missing.push(`${g}: app/lib/desk.ts has no \`const ${obj === "market" ? "marketState" : obj} = {\``); continue; }
    if (!supplied[obj].has(key)) missing.push(`${g}: live desk never sets ${inp}`);
  }
}
const liveMarket = Object.fromEntries([...(supplied.market ?? [])].map((k) => [k, 0.01]));
const liveBook = Object.fromEntries([...(supplied.book ?? [])].map((k) => [k, k === "halted" ? false : 1]));
for (const c of evaluateRegime(liveMarket, liveBook, DEFAULT_GATES).checks) {
  if (c.status === "unmeasured") missing.push(`${c.gate}: still unmeasured when fed only what the live desk supplies`);
}
console.log(`${missing.length ? " FAIL " : "  ok  "} ${gates.length} gates, every input fed by the live desk (${supplied.market?.size ?? 0} market keys, ${supplied.book?.size ?? 0} book keys)`);
if (missing.length) { console.error(`\n${missing.join("\n")}`); process.exit(1); }
