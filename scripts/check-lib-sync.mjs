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
