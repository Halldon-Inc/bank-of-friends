/** Can the lever ever arm? Run every regime through the real strategy, many seeds. */
import { DEFAULT_GATES, evaluateRegime, realisedVol, drift } from "../lib/strategy.mjs";
const REGIMES = [
  { name: "dead calm",    trend: 0.0,   sigma: 0.004, pull: 0.02, volume: 8,   trades: 90 },
  { name: "slow bleed",   trend: -0.03, sigma: 0.010, pull: 0.00, volume: 40,  trades: 600 },
  { name: "hard dump",    trend: -0.10, sigma: 0.020, pull: 0.00, volume: 70,  trades: 900 },
  { name: "quiet chop",   trend: 0.0,   sigma: 0.030, pull: 0.22, volume: 30,  trades: 400 },
  { name: "live chop",    trend: 0.0,   sigma: 0.048, pull: 0.26, volume: 55,  trades: 800 },
  { name: "wild chop",    trend: 0.0,   sigma: 0.075, pull: 0.30, volume: 90,  trades: 1400 },
  { name: "steady climb", trend: 0.03,  sigma: 0.028, pull: 0.05, volume: 60,  trades: 850 },
  { name: "melt up",      trend: 0.10,  sigma: 0.045, pull: 0.00, volume: 120, trades: 1800 },
];
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
function roll(r) {
  const RF_PRICE = 5.7e-7;
  const path = []; let p = RF_PRICE, anchor = RF_PRICE;
  const perHour = Math.pow(1 + r.trend, 1/24) - 1;
  for (let i = 0; i < 168; i++) { anchor *= 1+perHour; const dev = Math.log(p/anchor);
    p = p*Math.exp(-r.pull*dev + r.sigma*gauss())*(1+perHour); path.push(p); }
  const lastDay = path.slice(-24);
  return { mid: path[path.length-1], ethUsd: 2734.86, volume24hWeth: r.volume, trades24h: r.trades,
    drift24h: drift(lastDay), drift1h: drift(path.slice(-2)), drift7d: drift(path), hourlyVol: realisedVol(lastDay) };
}
const bookRf = 3159, bookWeth = 0.029;
console.log(`${"regime".padEnd(14)}${"armed".padStart(9)}${"  top blocker"}`);
console.log("-".repeat(62));
let anyArm = 0;
for (const r of REGIMES) {
  let armed = 0; const blockers = {};
  for (let i = 0; i < 200; i++) {
    const m = roll(r);
    const valueWeth = bookWeth + bookRf * 5.7e-7;
    const v = evaluateRegime(m, { rf: bookRf, weth: bookWeth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES);
    if (v.armed) armed++;
    else for (const c of v.checks) if (!c.ok) blockers[c.gate] = (blockers[c.gate]||0)+1;
  }
  anyArm += armed;
  const top = Object.entries(blockers).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([g,n])=>`${g} ${Math.round(n/2)}%`).join(", ");
  console.log(`${r.name.padEnd(14)}${(armed/2).toFixed(0).padStart(8)}%  ${top || "-"}`);
}
console.log("-".repeat(62));
console.log(anyArm === 0 ? "\nTHE LEVER CAN NEVER ARM. The game is broken." : `\noverall arm rate ${(anyArm/(200*REGIMES.length)*100).toFixed(1)}%`);
