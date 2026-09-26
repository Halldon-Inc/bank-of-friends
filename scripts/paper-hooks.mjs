#!/usr/bin/env node
/**
 * Which hook (and so which launchpad) sits behind a Uniswap v4 pool id on Robinhood Chain.
 * Reads the pool's Initialize event on the PoolManager.   node scripts/paper-hooks.mjs <poolId> [...]
 * Read-only. Uses the public RPC whose log index copes with wide ranges (globalstake), then the official one.
 */
import { createPublicClient, http, fallback, parseAbiItem } from "viem";
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const INIT = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const KNOWN = {
  "0xe5e7": "Pons v2 (PonsV2MemeHook)", "0x4e34": "Doppler multicurve initializer (Long.xyz and others)",
  "0x48b8": "Clanker V2", "0x75a5": "CashCat", "0x0310": "LaunchHook", "0x7a65": "Rare Friends", "0xa11b": "Project Mars (DRILL)",
  "0x0000": "no hook",
};
const c = createPublicClient({ transport: fallback([http("https://rpc-robinhood.globalstake.io", { timeout: 30_000 }), http("https://rpc.mainnet.chain.robinhood.com", { timeout: 30_000 })]) });
const head = await c.getBlockNumber();
for (const id of process.argv.slice(2)) {
  let found = null;
  // Walk back in 2M-block chunks (about 2.3 days each) until the pool's Initialize shows up.
  for (let to = head; to > 60_000_000n && !found; to -= 2_000_000n) {
    const from = to - 2_000_000n + 1n;
    try {
      const logs = await c.getLogs({ address: PM, event: INIT, args: { id }, fromBlock: from, toBlock: to });
      if (logs.length) found = logs[0];
    } catch (e) { console.log(`${id.slice(0, 10)} chunk ${from}-${to} failed: ${String(e.shortMessage ?? e.message).slice(0, 80)}`); }
  }
  if (!found) { console.log(`${id}  Initialize not found`); continue; }
  const a = found.args, hk = String(a.hooks).toLowerCase();
  const label = KNOWN[hk.slice(0, 6)] ?? "unknown hook";
  console.log(`${id}  hook ${a.hooks}  ${label}  lpFee ${a.fee === 0x800000 ? "dynamic" : a.fee / 1e4 + "%"}  spacing ${a.tickSpacing}  block ${found.blockNumber}`);
}
