import { getAddress, parseAbi } from "viem";
import { ADDR, ABI, client, readPool, scanLogs, blocksPerDay, fmt } from "../lib/protocol.mjs";
const c = client();
const RANDO = getAddress("0x00000000000000000000000000000000deadbeef");
const HUNT  = getAddress("0x913105f2d2bfb8392f7845ef79e0c2c62f2755df");

const fundAbi = parseAbi([
  "function fund(address asset,uint256 amount)",
  "function allocate(address asset)",
  "function streams(address asset) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);

console.log("=== Q1: can ANYONE donate into the reward stream? (ActivationManager.fund) ===");
for (const [who, acct] of [["rando", RANDO], ["hunt", HUNT]]) {
  try {
    await c.simulateContract({ address: ADDR.ActivationManager, abi: fundAbi, functionName: "fund",
      args: [ADDR.RF, 10n ** 18n], account: acct });
    console.log(`  ${who.padEnd(6)} fund(RF, 1e18) -> ALLOWED (needs RF balance+approval, but not permissioned)`);
  } catch (e) {
    const m = (e.shortMessage || e.message).split("\n")[0];
    console.log(`  ${who.padEnd(6)} fund(RF, 1e18) -> ${m.slice(0, 120)}`);
  }
}
try {
  await c.simulateContract({ address: ADDR.ActivationManager, abi: fundAbi, functionName: "allocate", args: [ADDR.RF], account: RANDO });
  console.log("  rando  allocate(RF) -> ALLOWED (anyone can roll pending fees into a stream)");
} catch (e) { console.log("  rando  allocate(RF) ->", (e.shortMessage||e.message).split("\n")[0].slice(0,120)); }

console.log("\n=== Q2: stream struct, decoded ===");
for (const [n, a] of [["RF", ADDR.RF], ["WETH", ADDR.WETH]]) {
  const s = await c.readContract({ address: ADDR.ActivationManager, abi: fundAbi, functionName: "streams", args: [a] });
  console.log(`  ${n}: [${s.map(x=>x.toString()).join(", ")}]`);
}

console.log("\n=== Q3: real gas price + measured swap costs on Robinhood Chain ===");
const gp = await c.getGasPrice();
console.log("  gasPrice:", Number(gp)/1e9, "gwei");
const blk = await c.getBlock({ blockNumber: await c.getBlockNumber() });
console.log("  baseFeePerGas:", blk.baseFeePerGas ? Number(blk.baseFeePerGas)/1e9 + " gwei" : "n/a", " gasLimit:", blk.gasLimit);

// measure actual gas used by real recent swaps + claims
const { head, perDay } = await blocksPerDay(c);
const swapEv = ABI.market.find(x=>x.type==="event"&&x.name==="Swapped");
const logs = await scanLogs(c, { address: ADDR.Market, event: swapEv, fromBlock: head - perDay/4n, toBlock: head });
console.log(`\n  sampling ${Math.min(logs.length,8)} of ${logs.length} real Market swaps for gas used:`);
const ethUsd = 2734.86;
let tot=0n, n=0;
for (const l of logs.slice(-8)) {
  const r = await c.getTransactionReceipt({ hash: l.transactionHash });
  const cost = r.gasUsed * r.effectiveGasPrice;
  tot += r.gasUsed; n++;
  console.log(`    gasUsed ${String(r.gasUsed).padStart(7)}  @ ${(Number(r.effectiveGasPrice)/1e9).toFixed(4)} gwei  = ${(Number(cost)/1e18).toExponential(3)} ETH = $${(Number(cost)/1e18*ethUsd).toFixed(5)}`);
}
if (n) {
  const avg = tot/BigInt(n);
  console.log(`  avg swap gas: ${avg}  => $${(Number(avg*gp)/1e18*ethUsd).toFixed(5)} per swap at current gas price`);
}

const claimEv = ABI.activationManager.find(x=>x.type==="event"&&x.name==="Claimed");
const cl = await scanLogs(c, { address: ADDR.ActivationManager, event: claimEv, fromBlock: head - perDay/4n, toBlock: head });
console.log(`\n  sampling ${Math.min(cl.length,5)} of ${cl.length} real claims for gas used:`);
const seen = new Set();
for (const l of cl.slice(-10)) {
  if (seen.has(l.transactionHash)) continue; seen.add(l.transactionHash);
  const r = await c.getTransactionReceipt({ hash: l.transactionHash });
  console.log(`    claim tx gasUsed ${String(r.gasUsed).padStart(7)} = $${(Number(r.gasUsed*gp)/1e18*ethUsd).toFixed(5)}`);
  if (seen.size >= 5) break;
}

console.log("\n=== Q4: flow direction over 24h (who is buying vs selling?) ===");
const all = await scanLogs(c, { address: ADDR.Market, event: swapEv, fromBlock: head - perDay, toBlock: head });
let buys=0, sells=0, buyWeth=0n, sellWeth=0n;
for (const l of all) { if (l.args.buy) { buys++; buyWeth += l.args.amountIn; } else { sells++; sellWeth += l.args.amountOut; } }
console.log(`  via Market router: ${buys} buys (${fmt.eth(buyWeth)} WETH in), ${sells} sells (${fmt.eth(sellWeth)} WETH out)`);
const imbalance = Number(buyWeth - sellWeth) / Math.max(Number(buyWeth + sellWeth), 1);
console.log(`  net flow imbalance: ${fmt.pct(imbalance)} toward ${imbalance > 0 ? "BUYING RF" : "SELLING RF"}`);
const pool = await readPool(c);
console.log(`\n  pool mid: ${pool.wethPerRf.toExponential(6)} WETH/RF  |  depth ~${pool.virtualWeth.toFixed(1)} WETH a side`);
console.log(`  a 1 WETH market buy moves price ~${((1/pool.virtualWeth)*100).toFixed(3)}% (constant product approximation)`);
