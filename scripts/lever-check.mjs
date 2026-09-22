/**
 * Can the hall's lever ever arm, and does it arm in the right weeks? Every regime is
 * run through the real strategy (measurePath + evaluateRegime), many seeds each.
 * The path is 240 hourly closes: the 7-day replay needs 169, so a 168-hour path can
 * NEVER arm. That is a real constraint on the hall, not a tuning choice.
 */
import { DEFAULT_GATES, evaluateRegime, measurePath } from "../lib/strategy.mjs";
const REGIMES = [
  { name: "dead calm",    trend: 0.0,   sigma: 0.004, pull: 0.02 },
  { name: "slow bleed",   trend: -0.03, sigma: 0.010, pull: 0.00 },
  { name: "hard dump",    trend: -0.10, sigma: 0.020, pull: 0.00 },
  { name: "quiet chop",   trend: 0.0,   sigma: 0.030, pull: 0.22 },
  { name: "live chop",    trend: 0.0,   sigma: 0.048, pull: 0.26 },
  { name: "wild chop",    trend: 0.0,   sigma: 0.075, pull: 0.30 },
  { name: "steady climb", trend: 0.03,  sigma: 0.028, pull: 0.05 },
  { name: "melt up",      trend: 0.10,  sigma: 0.045, pull: 0.00 },
];
const HOURS = 240;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function roll(r) {
  const path = []; let p = 5.7e-7, anchor = 5.7e-7;
  const perHour = Math.pow(1 + r.trend, 1 / 24) - 1;
  for (let i = 0; i < HOURS; i++) {
    anchor *= 1 + perHour;
    p = p * Math.exp(-r.pull * Math.log(p / anchor) + r.sigma * gauss()) * (1 + perHour);
    path.push(p);
  }
  return { ...measurePath(path, DEFAULT_GATES), ethUsd: 2736 };
}
const bookRf = 3159, bookWeth = 0.029;
console.log(`${"regime".padEnd(14)}${"armed".padStart(9)}  top blocker`);
console.log("=".repeat(62));
let anyArm = 0, trendArm = 0;
for (const r of REGIMES) {
  let armed = 0; const blockers = {};
  for (let i = 0; i < 200; i++) {
    const m = roll(r);
    const valueWeth = bookWeth + bookRf * m.mid;
    const v = evaluateRegime(m, { rf: bookRf, weth: bookWeth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES);
    if (v.armed) armed++;
    else for (const c of v.checks) if (!c.ok) blockers[c.gate] = (blockers[c.gate] || 0) + 1;
  }
  anyArm += armed;
  if (Math.abs(r.trend) >= 0.03) trendArm += armed;
  const top = Object.entries(blockers).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g, n]) => `${g} ${Math.round(n / 2)}%`).join(", ");
  console.log(`${r.name.padEnd(14)}${(armed / 2).toFixed(0).padStart(8)}%  ${top || "-"}`);
}
console.log("=".repeat(62));
if (anyArm === 0) { console.log("\nTHE LEVER CAN NEVER ARM. The hall is broken."); process.exit(1); }
console.log(`\noverall arm rate ${(anyArm / (200 * REGIMES.length) * 100).toFixed(1)}%; in trending regimes ${(trendArm / (200 * 4) * 100).toFixed(1)}%`);
