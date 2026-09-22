import { DEFAULT_GATES, evaluateRegime, realisedVol, drift } from "../lib/strategy.mjs";
const MID0=5.7e-7, L=147865.85, ETH_USD=2734.86;
// one benign regime: no trend, decent vol, lots of volume
let s=12345, mid=MID0;
const rnd=()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296;};
const gauss=()=>{const u=Math.max(rnd(),1e-9),v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
const kappa=Math.log(2)/400, sigma=0.008, band=0.35;
const T=[]; const t0=1790000000;
for(let i=0;i<4320;i++){ const dev=Math.log(mid/MID0); mid=mid*Math.exp(-kappa*dev+sigma*gauss());
  mid=Math.min(MID0*(1+band),Math.max(MID0*(1-band),mid)); const sp=Math.sqrt(mid);
  T.push({t:t0+i*60,mid,tradeWeth:0.028,poolWeth:L*sp,poolRf:L/sp}); }

const hist=[],day=[]; const firstT=T[0].t; let warmed=false;
const counts={};
for(const q of T){
  hist.push({t:q.t,mid:q.mid}); while(hist.length&&q.t-hist[0].t>86400) hist.shift();
  day.push({t:q.t,w:q.tradeWeth}); while(day.length&&q.t-day[0].t>86400) day.shift();
  if(!warmed&&q.t-firstT>=86400) warmed=true;
  if(!warmed) continue;
  const lastHour=hist.filter(h=>q.t-h.t<=3600).map(h=>h.mid);
  const market={mid:q.mid,ethUsd:ETH_USD,
    volume24hWeth:day.reduce((a,b)=>a+b.w,0), trades24h:day.length,
    drift24h:drift(hist.map(h=>h.mid)), drift1h:drift(lastHour),
    hourlyVol: lastHour.length>=5 ? realisedVol(lastHour)*Math.sqrt(Math.max(lastHour.length-1,1)) : 0};
  const book={rf:3159.22,weth:0.028987,valueWeth:0.028987+3159.22*q.mid,hwmWeth:0.05,halted:false};
  const r=evaluateRegime(market,book,DEFAULT_GATES);
  for(const c of r.checks) if(!c.ok) counts[c.gate]=(counts[c.gate]||0)+1;
  if(r.armed) counts.__ARMED__=(counts.__ARMED__||0)+1;
}
console.log("ticks evaluated:", T.length-1440);
console.log("blocking counts:", JSON.stringify(counts,null,1));
// sample one tick's full verdict
const q=T[T.length-1];
const lastHour=hist.filter(h=>q.t-h.t<=3600).map(h=>h.mid);
const market={mid:q.mid,ethUsd:ETH_USD,volume24hWeth:day.reduce((a,b)=>a+b.w,0),trades24h:day.length,
  drift24h:drift(hist.map(h=>h.mid)),drift1h:drift(lastHour),
  hourlyVol:realisedVol(lastHour)*Math.sqrt(Math.max(lastHour.length-1,1))};
const book={rf:3159.22,weth:0.028987,valueWeth:0.028987+3159.22*q.mid,hwmWeth:0.05,halted:false};
console.log("\nfinal tick verdict:");
for(const c of evaluateRegime(market,book,DEFAULT_GATES).checks) console.log(" ",(c.ok?"ok   ":"BLOCK"),c.gate.padEnd(12),c.detail);
