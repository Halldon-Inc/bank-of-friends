#!/usr/bin/env node
/**
 * game/ is the canonical source for the SDK game; sdk/games/first-bank is a working
 * copy the SDK CLI builds from. A second copy is a second source of truth, so assert
 * they match. game/ itself is frozen (see below).
 */
import fs from "node:fs";
import crypto from "node:crypto";
const h = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12) : "MISSING");
let bad = 0;
for (const f of ["index.tsx", "game.json", "style.css", "world.ts", "host.css", "FriendPortrait.tsx", "README.md", "strategy.mjs"]) {
  const a = h(`game/${f}`), b = h(`sdk/games/first-bank/${f}`);
  const ok = a === b && a !== "MISSING";
  console.log(`${ok ? "  ok  " : " FAIL "} game/${f} ${a}  vs  sdk/games/first-bank/${f} ${b}`);
  if (!ok) bad++;
}
// game/ is the ABANDONED FriendSDK build, frozen for reference: it is the version that cannot
// admit a Genesis. It keeps the taker-grid strategy it shipped with and is NOT held equal to
// lib/strategy.mjs any more, because the live desk moved to maker-only range orders and the
// frozen game must keep running the code it was built against. The hall at / runs lib/.
if (bad) { console.error(`\n${bad} out of sync. Run: cp game/* sdk/games/first-bank/`); process.exit(1); }
console.log("\ngame copies are identical.");
