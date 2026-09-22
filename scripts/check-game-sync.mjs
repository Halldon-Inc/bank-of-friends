#!/usr/bin/env node
/**
 * game/ is the canonical source for the SDK game; sdk/games/first-bank is a working
 * copy the SDK CLI builds from. A second copy is a second source of truth, so assert
 * they match. Also asserts the game's strategy.mjs is byte-identical to lib/, because
 * the whole claim of the trading desk is that it runs the REAL strategy.
 */
import fs from "node:fs";
import crypto from "node:crypto";
const h = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12) : "MISSING");
let bad = 0;
for (const f of ["index.tsx", "game.json", "style.css", "world.ts", "host.css", "README.md", "strategy.mjs"]) {
  const a = h(`game/${f}`), b = h(`sdk/games/first-bank/${f}`);
  const ok = a === b && a !== "MISSING";
  console.log(`${ok ? "  ok  " : " FAIL "} game/${f} ${a}  vs  sdk/games/first-bank/${f} ${b}`);
  if (!ok) bad++;
}
const s1 = h("lib/strategy.mjs"), s2 = h("game/strategy.mjs");
const ok = s1 === s2;
console.log(`${ok ? "  ok  " : " FAIL "} lib/strategy.mjs ${s1}  vs  game/strategy.mjs ${s2}   <- the desk must run the real strategy`);
if (!ok) bad++;
if (bad) { console.error(`\n${bad} out of sync. Run: cp game/* sdk/games/first-bank/ && cp lib/strategy.mjs game/`); process.exit(1); }
console.log("\ngame copies are identical.");
