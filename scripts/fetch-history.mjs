#!/usr/bin/env node
/**
 * Pull the COMPLETE swap + liquidity history of the RF/WETH pool.
 *
 * The protocol deployed at block 62,624,268 and the chain runs ~0.1 s blocks, so
 * "all of history" is only about 6.7M blocks. We cache to disk and resume, because
 * the public RPC 429s if hammered.
 *
 *   node scripts/fetch-history.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { parseAbi } from "viem";
import { ADDR, POOL_ID, client, LOG_CHUNK } from "../lib/protocol.mjs";

const DEPLOY_BLOCK = 62624268n;
const OUT = path.join(process.cwd(), "data");
fs.mkdirSync(OUT, { recursive: true });
const SWAPS = path.join(OUT, "swaps.json");
const META = path.join(OUT, "history-meta.json");

const pmAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
const swapEvent = pmAbi.find((x) => x.name === "Swap");
const modEvent = pmAbi.find((x) => x.name === "ModifyLiquidity");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = client();

function load() {
  if (!fs.existsSync(SWAPS)) return { swaps: [], mods: [], from: DEPLOY_BLOCK };
  const j = JSON.parse(fs.readFileSync(SWAPS, "utf8"));
  return { swaps: j.swaps ?? [], mods: j.mods ?? [], from: BigInt(j.nextBlock ?? DEPLOY_BLOCK) };
}
function save(swaps, mods, nextBlock) {
  fs.writeFileSync(SWAPS, JSON.stringify({ nextBlock: nextBlock.toString(), swaps, mods }));
}

const state = load();
const head = await c.getBlockNumber();
console.log(`pool ${POOL_ID}`);
console.log(`scanning ${state.from} -> ${head}  (${((Number(head - state.from)) / 1e6).toFixed(2)}M blocks)`);
console.log(`resuming with ${state.swaps.length} swaps already cached\n`);

// Block timestamps are needed for time-bucketing; cache them per chunk boundary.
const tsCache = new Map();
async function tsOf(bn) {
  const k = (bn / 100000n) * 100000n;
  if (!tsCache.has(k)) tsCache.set(k, Number((await c.getBlock({ blockNumber: k })).timestamp));
  return tsCache.get(k);
}

let chunks = 0;
const t0 = Date.now();
for (let from = state.from; from <= head; from += LOG_CHUNK) {
  const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
  let attempt = 0;
  for (;;) {
    try {
      const [sw, md] = await Promise.all([
        c.getLogs({ address: ADDR.PoolManager, event: swapEvent, args: { id: POOL_ID }, fromBlock: from, toBlock: to }),
        c.getLogs({ address: ADDR.PoolManager, event: modEvent, args: { id: POOL_ID }, fromBlock: from, toBlock: to }),
      ]);
      for (const l of sw) {
        state.swaps.push({
          b: Number(l.blockNumber),
          tx: l.transactionHash,
          sender: l.args.sender,
          a0: l.args.amount0.toString(),   // RF delta, pool's perspective
          a1: l.args.amount1.toString(),   // WETH delta, pool's perspective
          sq: l.args.sqrtPriceX96.toString(),
          liq: l.args.liquidity.toString(),
          tick: l.args.tick,
          fee: l.args.fee,
        });
      }
      for (const l of md) {
        state.mods.push({
          b: Number(l.blockNumber), sender: l.args.sender,
          lo: l.args.tickLower, hi: l.args.tickUpper,
          d: l.args.liquidityDelta.toString(), salt: l.args.salt,
        });
      }
      break;
    } catch (err) {
      if (++attempt >= 5) throw new Error(`getLogs ${from}-${to}: ${err.shortMessage ?? err.message}`);
      await sleep(600 * attempt);
    }
  }
  chunks++;
  if (chunks % 25 === 0) {
    const pct = Number(to - DEPLOY_BLOCK) / Number(head - DEPLOY_BLOCK) * 100;
    const rate = chunks / ((Date.now() - t0) / 1000);
    const left = Number((head - to) / LOG_CHUNK) / Math.max(rate, 0.01);
    process.stdout.write(`\r  ${pct.toFixed(1)}%  block ${to}  swaps=${state.swaps.length} mods=${state.mods.length}  eta ${Math.round(left)}s      `);
    save(state.swaps, state.mods, to + 1n);
  }
  await sleep(60);
}
save(state.swaps, state.mods, head + 1n);

// Attach approximate timestamps.
for (const s of state.swaps) if (s.t === undefined) s.t = await tsOf(BigInt(s.b));
save(state.swaps, state.mods, head + 1n);

fs.writeFileSync(META, JSON.stringify({
  poolId: POOL_ID, deployBlock: DEPLOY_BLOCK.toString(), headBlock: head.toString(),
  fetchedAt: new Date().toISOString(), swaps: state.swaps.length, mods: state.mods.length,
}, null, 2));

console.log(`\n\ndone. ${state.swaps.length} swaps, ${state.mods.length} liquidity changes -> data/swaps.json`);
