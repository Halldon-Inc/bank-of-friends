import { parseAbi, getAddress } from "viem";
import { client, fmt } from "../lib/protocol.mjs";
import fs from "node:fs";
const c = client();
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
// Derived from Seaport's ConduitController for conduitKey 0x61159fef...,
// NOT the mainnet-OpenSea conduit. Checking the wrong spender reported every bid
// as unfillable, which was obviously false for a collection doing 723 sales/week.
const CONDUIT = getAddress("0x963F00d3ff000064fFCbA824b800c0000000C300");
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)","function allowance(address,address) view returns (uint256)","function decimals() view returns (uint8)","function symbol() view returns (string)"]);

const dec = await c.readContract({address:USDG,abi:erc20,functionName:"decimals"});
const sym = await c.readContract({address:USDG,abi:erc20,functionName:"symbol"});
console.log(`settlement token: ${sym} (${USDG}), ${dec} decimals\n`);

const j = JSON.parse(fs.readFileSync("gen-offers.json","utf8"));
const offers = j.offers
  .map(o => ({ price: Number(o.price.value)/10**(o.price.decimals??6), offerer: getAddress(o.protocol_data.parameters.offerer),
               end: Number(o.protocol_data.parameters.endTime), hash:o.order_hash, type:o.protocol_data.parameters.orderType }))
  .sort((a,b)=>b.price-a.price);

console.log(`${"bid".padStart(9)}  ${"offerer".padEnd(44)}${"USDG bal".padStart(12)}${"approved".padStart(14)}  FILLABLE?`);
console.log("-".repeat(100));
let bestReal = null;
const seen = new Set();
for (const o of offers.slice(0, 14)) {
  const [bal, alw] = await Promise.all([
    c.readContract({address:USDG,abi:erc20,functionName:"balanceOf",args:[o.offerer]}),
    c.readContract({address:USDG,abi:erc20,functionName:"allowance",args:[o.offerer,CONDUIT]}),
  ]);
  const balN = Number(bal)/10**dec, alwN = Number(alw)/10**dec;
  const expired = o.end*1000 < Date.now();
  const ok = !expired && balN >= o.price && alwN >= o.price;
  if (ok && !bestReal) bestReal = o.price;
  console.log(
    `${o.price.toFixed(2).padStart(9)}  ${o.offerer.padEnd(44)}${balN.toFixed(2).padStart(12)}${(alwN>1e12?"unlimited":alwN.toFixed(2)).padStart(14)}  ` +
    (expired ? "EXPIRED" : ok ? "yes" : (balN < o.price ? `NO - short ${(o.price-balN).toFixed(2)} ${sym}` : "NO - not approved"))
  );
}
console.log("-".repeat(100));
console.log(`\nBEST GENUINELY FILLABLE BID: ${bestReal ? bestReal.toFixed(2)+" "+sym : "none in the top 14"}`);

// Reserve payout in USD for comparison
import { readPool, ethUsd } from "../lib/protocol.mjs";
const pool = await readPool(c);
const rfUsd = pool.wethPerRf * ((await ethUsd())?.usd ?? NaN);   // live; NaN rather than a stale constant
console.log(`Reserve pays 900,000 RF = $${(900000*rfUsd).toFixed(2)}`);
console.log(`OpenSea floor (ask)      = 1693.99 ${sym}`);
if (bestReal) {
  console.log(`\nreal spread: bid ${bestReal.toFixed(2)} / ask 1693.99  =  ${(((1693.99-bestReal)/bestReal)*100).toFixed(1)}% wide`);
}
