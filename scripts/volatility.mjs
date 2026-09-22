import fs from "node:fs";
const raw = JSON.parse(fs.readFileSync("data/swaps.json","utf8"));
const swaps = raw.swaps.map(s=>({b:s.b,t:s.t,sq:BigInt(s.sq)})).sort((a,b)=>a.b-b.b);
const price = s => { const p = Number(s.sq)/2**96; return p*p; };
const P = swaps.map(s=>({t:s.t,b:s.b,p:price(s)}));

console.log("=== RF/WETH price series, full history ===");
console.log(`${P.length} price points over ${((P[P.length-1].t-P[0].t)/86400).toFixed(2)} days`);
console.log(`open  ${P[0].p.toExponential(4)}`);
console.log(`close ${P[P.length-1].p.toExponential(4)}`);
const hi = P.reduce((a,b)=>b.p>a.p?b:a), lo = P.reduce((a,b)=>b.p<a.p?b:a);
console.log(`high  ${hi.p.toExponential(4)}  at ${new Date(hi.t*1000).toISOString()}`);
console.log(`low   ${lo.p.toExponential(4)}  at ${new Date(lo.t*1000).toISOString()}`);
console.log(`total move ${(((P[P.length-1].p/P[0].p)-1)*100).toFixed(1)}%   high-to-low ${(((lo.p/hi.p)-1)*100).toFixed(1)}%`);

// hourly bars
const bars = new Map();
for (const q of P) { const h = Math.floor(q.t/3600); if(!bars.has(h)) bars.set(h,{o:q.p,h:q.p,l:q.p,c:q.p,n:0}); const b=bars.get(h); b.h=Math.max(b.h,q.p); b.l=Math.min(b.l,q.p); b.c=q.p; b.n++; }
const B = [...bars.entries()].sort((a,b)=>a[0]-b[0]).map(([h,v])=>({h,...v}));
console.log(`\n=== ${B.length} hourly bars ===`);
const ranges = B.map(b=>(b.h-b.l)/b.l*100).sort((a,b)=>a-b);
const pc = p => ranges[Math.floor(ranges.length*p)]?.toFixed(2)+"%";
console.log(`hourly high-low range:  p25 ${pc(.25)}  median ${pc(.5)}  p75 ${pc(.75)}  p90 ${pc(.9)}  max ${ranges[ranges.length-1].toFixed(1)}%`);
const above10 = ranges.filter(r=>r>=10).length;
const above20 = ranges.filter(r=>r>=20).length;
console.log(`hours with >=10% range: ${above10}/${B.length} (${(above10/B.length*100).toFixed(1)}%)   >=20%: ${above20} (${(above20/B.length*100).toFixed(1)}%)`);

// hourly returns + realised vol
const rets = []; for(let i=1;i<B.length;i++) rets.push(Math.log(B[i].c/B[i-1].c));
const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
const sd = Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/rets.length);
console.log(`hourly log-return sd: ${(sd*100).toFixed(2)}%   annualised vol ${(sd*Math.sqrt(24*365)*100).toFixed(0)}%`);
console.log(`mean hourly return:   ${(mean*100).toFixed(3)}%  (drift is ${mean<0?"DOWN":"UP"})`);

// how often does price round-trip >10% (the break-even for a 5%+5% toll)?
console.log(`\n=== round-trip opportunities vs the 10% toll ===`);
for (const thr of [0.10,0.15,0.20,0.30,0.50]) {
  // count distinct swings: from a local low, how often does price rise >= thr before falling back?
  let n=0, ref=P[0].p, dir=0;
  for (const q of P) {
    if (dir<=0 && q.p <= ref) ref = q.p;
    if (dir>=0 && q.p >= ref) ref = ref;
    if (q.p >= ref*(1+thr)) { n++; ref=q.p; }
  }
  console.log(`  upswings of >= ${(thr*100).toFixed(0)}% from a running low: ${n}`);
}
// downswings
for (const thr of [0.10,0.20,0.30]) {
  let n=0, ref=P[0].p;
  for (const q of P) { if (q.p>ref) ref=q.p; if (q.p <= ref*(1-thr)) { n++; ref=q.p; } }
  console.log(`  downswings of >= ${(thr*100).toFixed(0)}% from a running high: ${n}`);
}

// print a coarse daily path so we can SEE the chart
console.log(`\n=== daily path ===`);
const days = new Map();
for (const q of P) { const d=Math.floor(q.t/86400); if(!days.has(d)) days.set(d,{o:q.p,h:q.p,l:q.p,c:q.p,n:0}); const b=days.get(d); b.h=Math.max(b.h,q.p); b.l=Math.min(b.l,q.p); b.c=q.p; b.n++; }
for (const [d,v] of [...days.entries()].sort((a,b)=>a[0]-b[0])) {
  console.log(`  ${new Date(d*86400000).toISOString().slice(0,10)}  o ${v.o.toExponential(3)}  h ${v.h.toExponential(3)}  l ${v.l.toExponential(3)}  c ${v.c.toExponential(3)}  range ${((v.h-v.l)/v.l*100).toFixed(0)}%  trades ${v.n}`);
}
