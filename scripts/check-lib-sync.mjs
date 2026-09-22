#!/usr/bin/env node
/**
 * The app ships its own copy of the strategy so it can deploy standalone.
 * A second copy is a second source of truth, which goes stale silently and then
 * the dashboard shows gates the desk is not actually using. Assert they are
 * byte-identical on every CI run.
 */
import fs from "node:fs";
import crypto from "node:crypto";
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
 * The other half of the same drift, and the one that actually shipped: a gate was
 * added to the strategy and never given a label, so the dashboard printed the raw
 * key `drift7d` in a column of spaced English. A fallback to the key hides that,
 * so assert the map covers every gate instead.
 */
const gates = [...fs.readFileSync("lib/strategy.mjs", "utf8").matchAll(/\badd\("([A-Za-z0-9]+)"/g)].map((m) => m[1]);
const desk = fs.readFileSync("app/components/Desk.tsx", "utf8");
const block = desk.slice(desk.indexOf("const LABEL"), desk.indexOf("};", desk.indexOf("const LABEL")));
const labelled = new Set([...block.matchAll(/([A-Za-z0-9]+):\s*"/g)].map((m) => m[1]));
const unlabelled = gates.filter((g) => !labelled.has(g));
console.log(`\n${unlabelled.length ? " FAIL " : "  ok  "} ${gates.length} gates in the strategy, ${gates.filter((g) => labelled.has(g)).length} named in the dashboard`);
if (unlabelled.length) {
  console.error(`\nno label for: ${unlabelled.join(", ")}. Add them to LABEL in app/components/Desk.tsx.`);
  process.exit(1);
}
