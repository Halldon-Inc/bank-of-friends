import fs from "node:fs";
const SLUG = "rare-friends-genesis";
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let next = null, all = [], pages = 0;
do {
  const url = `https://api.opensea.io/api/v2/events/collection/${SLUG}?event_type=sale&limit=50` + (next ? `&next=${next}` : "");
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) { console.log("http", r.status); break; }
  const j = await r.json();
  all.push(...(j.asset_events||[]));
  next = j.next; pages++;
  if (pages % 5 === 0) process.stdout.write(`\r  page ${pages}, ${all.length} sales   `);
  await sleep(150);
} while (next && pages < 60);
console.log(`\nfetched ${all.length} sales over ${pages} pages`);
fs.writeFileSync("data/genesis-sales.json", JSON.stringify(all));

const sales = all.map(e => {
  const p = e.payment || {};
  return { t: e.event_timestamp, price: Number(p.quantity||0)/10**(p.decimals??6), sym: p.symbol, id: e.nft?.identifier };
}).filter(s => s.price > 0).sort((a,b)=>a.t-b.t);

console.log(`priced sales: ${sales.length}, currencies: ${[...new Set(sales.map(s=>s.sym))].join(", ")}`);
if (!sales.length) process.exit(0);
console.log(`range ${new Date(sales[0].t*1000).toISOString()} -> ${new Date(sales[sales.length-1].t*1000).toISOString()}`);

const byDay = new Map();
for (const s of sales) {
  const d = new Date(s.t*1000).toISOString().slice(0,10);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(s.price);
}
const med = a => { const b=[...a].sort((x,y)=>x-y); return b[Math.floor(b.length/2)]; };
console.log(`\n${"day".padEnd(12)}${"sales".padStart(7)}${"min".padStart(11)}${"median".padStart(11)}${"max".padStart(11)}${"avg".padStart(11)}`);
console.log("-".repeat(62));
const days=[...byDay.entries()].sort();
for (const [d, ps] of days) {
  const avg = ps.reduce((a,b)=>a+b,0)/ps.length;
  console.log(d.padEnd(12)+String(ps.length).padStart(7)+Math.min(...ps).toFixed(0).padStart(11)+med(ps).toFixed(0).padStart(11)+Math.max(...ps).toFixed(0).padStart(11)+avg.toFixed(0).padStart(11));
}
console.log("-".repeat(62));
if (days.length >= 2) {
  const first = med(days[0][1]), last = med(days[days.length-1][1]);
  console.log(`median sale price: ${first.toFixed(0)} -> ${last.toFixed(0)} USDG  (${(((last/first)-1)*100).toFixed(1)}%)`);
}
// recent window trend
const now = sales[sales.length-1].t;
for (const h of [24, 48, 72]) {
  const w = sales.filter(s => s.t >= now - h*3600);
  if (w.length) console.log(`last ${h}h: ${w.length} sales, median ${med(w.map(s=>s.price)).toFixed(0)}, min ${Math.min(...w.map(s=>s.price)).toFixed(0)}, max ${Math.max(...w.map(s=>s.price)).toFixed(0)}`);
}
