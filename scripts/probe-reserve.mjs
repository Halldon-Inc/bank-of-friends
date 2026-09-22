import { parseAbi } from "viem";
import { ADDR, ABI, client, fmt } from "../lib/protocol.mjs";
const c = client();
const cfg = await (await fetch("https://rarefriends.com/api/protocol/config")).json();
const R = cfg.deployment.contracts.Reserve;
const rd = (fn, args=[]) => c.readContract({ address: R.address, abi: R.abi, functionName: fn, args });

// Price from the pool itself, not their API.
import { readPool, ethUsd } from "../lib/protocol.mjs";
const ETH_USD = (await ethUsd())?.usd ?? NaN;   // live; NaN (prints as NaN) rather than a stale constant
const pool = await readPool(c);
const rfUsd = pool.wethPerRf * ETH_USD;

console.log("=== Reserve state ===");
const vals = {};
for (const f of ["RF_PER_GENESIS","DEPOSIT_FEE","EXACT_FEE","FIFO_FEE","BOOTSTRAP_COUNT","inventoryCount","conversionEnabled","retired","head","tail","bootstrapUsed","owner","manager","market"]) {
  try { vals[f] = await rd(f); console.log("  "+f.padEnd(20), vals[f]); } catch(e){ console.log("  "+f.padEnd(20), "ERR "+(e.shortMessage||e.message).slice(0,60)); }
}
const e18 = v => Number(v)/1e18;
console.log("\n=== what a deposit actually pays ===");
const per = e18(vals.RF_PER_GENESIS), dep = e18(vals.DEPOSIT_FEE), fifo = e18(vals.FIFO_FEE), exact = e18(vals.EXACT_FEE);
console.log(`  RF_PER_GENESIS  ${fmt.n(per)} RF  = $${(per*rfUsd).toFixed(2)}`);
console.log(`  DEPOSIT_FEE     ${fmt.n(dep)} RF  = $${(dep*rfUsd).toFixed(2)}`);
console.log(`  NET on deposit  ${fmt.n(per-dep)} RF  = $${((per-dep)*rfUsd).toFixed(2)}   <-- what you receive for handing over a Genesis`);
console.log(`  FIFO_FEE (swap for a random one)   ${fmt.n(fifo)} RF = $${(fifo*rfUsd).toFixed(2)}`);
console.log(`  EXACT_FEE (swap for a chosen one)  ${fmt.n(exact)} RF = $${(exact*rfUsd).toFixed(2)}`);
console.log(`  rfUsd = $${rfUsd}`);

console.log("\n=== is there ANY way to take an NFT OUT for RF? ===");
const fns = R.abi.filter(x=>x.type==="function");
const takesRfGivesNft = fns.filter(f=>/buy|purchase|redeem|withdraw|mint|claim/i.test(f.name));
console.log("  functions matching buy/purchase/redeem/withdraw/mint/claim:", takesRfGivesNft.length ? takesRfGivesNft.map(f=>f.name).join(", ") : "NONE");
console.log("  state-changing fns:", fns.filter(f=>f.stateMutability!=="view"&&f.stateMutability!=="pure").map(f=>f.name).join(", "));
console.log("  => the only way to receive a Genesis from the Reserve is trade()/tradeAny(), which REQUIRE you to put a Genesis in.");

// Can a non-owner call the admin paths?
const RANDO="0x00000000000000000000000000000000dEaDBeef";
for (const [fn,args] of [["migrateAssets",[RANDO,0n,[]]],["initializeInventory",[[1n]]],["bootstrap",[[1n],RANDO]]]) {
  try { await c.simulateContract({address:R.address,abi:R.abi,functionName:fn,args,account:RANDO}); console.log(`  WARNING: ${fn} callable by anyone`); }
  catch(e){ console.log(`  ${fn.padEnd(20)} blocked for non-owner (as expected)`); }
}
