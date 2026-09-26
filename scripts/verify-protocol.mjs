#!/usr/bin/env node
/**
 * verify-protocol.mjs
 *
 * Every factual claim the Bank of Friends makes about Rare Friends, asserted
 * against live Robinhood Chain state. Run it yourself:
 *
 *     npm run verify
 *
 * Rules this harness follows on purpose:
 *  - Assertions are POSITIVE. "lpFee equals 0" is a check; "no errors occurred" is not.
 *  - A check that cannot be evaluated is SKIP, never PASS.
 *  - The run fails if it graded nothing, so a broken instrument cannot exit 0.
 *  - The check COUNT is printed. A future run with fewer checks and no failures
 *    has lost coverage, which is a defect, not a pass.
 */

import { getAddress, parseAbi, parseEventLogs } from "viem";
import {
  ADDR, ABI, POOL_ID, POOL_SEED_BLOCK, CHAIN, DYNAMIC_FEE_FLAG, FULL_RANGE,
  client, readPool, readPosition, scanLogs, blocksPerDay, fmt,
  readStreams, readRewardsWiring, readOwners, OWNED, readProtocolIdle,
} from "../lib/protocol.mjs";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const c = client();
const results = [];
const RANDO = getAddress("0x00000000000000000000000000000000deadbeef");
/** The pass floor. Raise it whenever checks are added; never lower it to make a run green. */
const MIN_PASS = 59;

function record(status, name, detail) {
  results.push({ status, name, detail });
  const tag = { PASS: "  ok  ", FAIL: " FAIL ", SKIP: " skip " }[status];
  console.log(`${tag} ${name}${detail ? `  ->  ${detail}` : ""}`);
}
const eq = (name, actual, expected, show = String) => {
  const ok = typeof expected === "string" && typeof actual === "string"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
  record(ok ? "PASS" : "FAIL", name, ok ? show(actual) : `expected ${show(expected)}, got ${show(actual)}`);
  return ok;
};
const isTrue = (name, cond, detail) => { record(cond ? "PASS" : "FAIL", name, detail); return cond; };
const skip = (name, why) => record("SKIP", name, why);

/** Custom-error selectors of the Friend wallet implementation (resolved via openchain). */
const ERR = Object.freeze({ InvalidSigner: "0x815e1d64", UnsupportedOperation: "0x9ba6061b" });
/** The 4-byte selector a call reverted with, "none" if it succeeded, null if unreadable. */
async function revertSelector(promise) {
  try { await promise; return "none"; } catch (e) {
    const blob = JSON.stringify(e, (k, v) => (typeof v === "bigint" ? String(v) : v)) + String(e?.message ?? "");
    const m = blob.match(/0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/g);
    return m ? m.find((x) => Object.values(ERR).includes(x.toLowerCase()))?.toLowerCase() ?? m[0].toLowerCase() : null;
  }
}

/* ------------------------------------------------------------------ hook flags */
const HOOK_FLAGS = {
  beforeInitialize: 13, afterInitialize: 12,
  beforeAddLiquidity: 11, afterAddLiquidity: 10,
  beforeRemoveLiquidity: 9, afterRemoveLiquidity: 8,
  beforeSwap: 7, afterSwap: 6,
  beforeDonate: 5, afterDonate: 4,
  beforeSwapReturnsDelta: 3, afterSwapReturnsDelta: 2,
};

async function main() {
  console.log("Bank of Friends :: protocol verification");
  console.log(`chain ${CHAIN.id} via ${CHAIN.rpcUrls.default.http[0]}`);
  console.log(`run at ${new Date().toISOString()}\n`);

  /* ---------------------------------------------------------- 1. identity */
  console.log("-- wiring --");
  eq("chain id is 4663", await c.getChainId(), 4663);

  const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args });
  const [hookPoolId, feeBps, hookRewards, hookMarket, flags] = await Promise.all([
    rd(ADDR.Hook, ABI.hook, "poolId"),
    rd(ADDR.Hook, ABI.hook, "FEE_BPS"),
    rd(ADDR.Hook, ABI.hook, "rewards"),
    rd(ADDR.Hook, ABI.hook, "market"),
    rd(ADDR.Hook, ABI.hook, "FLAGS"),
  ]);
  eq("Hook.poolId() is the pool we model", hookPoolId, POOL_ID);
  eq("Hook.FEE_BPS() is 500 (5% of every swap)", feeBps, 500n, String);
  eq("Hook.rewards() IS the ActivationManager", hookRewards, ADDR.ActivationManager);
  eq("Hook.market() IS the Market", hookMarket, ADDR.Market);

  const key = await rd(ADDR.Market, ABI.market, "poolKey");
  eq("poolKey.currency0 is RF", key.currency0, ADDR.RF);
  eq("poolKey.currency1 is WETH", key.currency1, ADDR.WETH);
  eq("poolKey.hooks is the Hook", key.hooks, ADDR.Hook);
  eq("poolKey.fee is the v4 DYNAMIC_FEE_FLAG", Number(key.fee), DYNAMIC_FEE_FLAG, (v) => `0x${Number(v).toString(16)}`);

  /* ------------------------------------------- 2. the headline: LPs earn zero */
  console.log("\n-- the finding: liquidity providers are not the fee recipients --");
  const pool = await readPool(c);
  isTrue("pool.lpFee is 0: LIQUIDITY PROVIDERS EARN NOTHING",
    pool.lpFee === 0, `lpFee=${pool.lpFee} (${pool.lpFee / 10000}%)`);
  isTrue("pool.protocolFee is 0: nothing is skimmed to a protocol treasury either",
    pool.protocolFee === 0, `protocolFee=${pool.protocolFee}`);
  isTrue("the entire 5% is routed to Friend holders, not to LPs",
    feeBps === 500n && pool.lpFee === 0 && hookRewards.toLowerCase() === ADDR.ActivationManager.toLowerCase(),
    "FEE_BPS=500 -> Hook.rewards=ActivationManager, while lpFee=0");

  /* --------------------------------------- 3. liquidity is structurally ungated */
  console.log("\n-- liquidity is ungated at the protocol level --");
  const f = Number(flags);
  const on = (n) => (f & (1 << HOOK_FLAGS[n])) !== 0;
  isTrue("hook does NOT implement beforeAddLiquidity", !on("beforeAddLiquidity"), `FLAGS=0x${f.toString(16)}`);
  isTrue("hook does NOT implement afterAddLiquidity", !on("afterAddLiquidity"));
  isTrue("hook does NOT implement beforeRemoveLiquidity", !on("beforeRemoveLiquidity"));
  isTrue("hook does NOT implement afterRemoveLiquidity", !on("afterRemoveLiquidity"));
  isTrue("=> PoolManager can never consult the hook on a liquidity change, so liquidity cannot be gated",
    !on("beforeAddLiquidity") && !on("beforeRemoveLiquidity") && !on("afterAddLiquidity") && !on("afterRemoveLiquidity"));
  isTrue("hook DOES implement beforeSwap and afterSwap (that is where the 5% is taken)",
    on("beforeSwap") && on("afterSwap"),
    Object.keys(HOOK_FLAGS).filter(on).join(", "));

  /* ------------------------------------------ 4. nobody has ever used that fact */
  console.log("\n-- and nobody has ever used that fact --");
  const marketPos = await readPosition(c, ADDR.Market, FULL_RANGE.tickLower, FULL_RANGE.tickUpper);
  eq("the Market's full-range position IS the entire pool", marketPos, pool.liquidity, (v) => v.toString());
  isTrue("third-party liquidity in the RF/WETH pool is exactly zero",
    pool.liquidity - marketPos === 0n, `total ${pool.liquidity} - market ${marketPos} = ${pool.liquidity - marketPos}`);
  isTrue("the pool holds real depth, so this is a live market and not an empty one",
    pool.virtualWeth > 10, `~${pool.virtualWeth.toFixed(2)} WETH and ~${fmt.n(pool.virtualRf)} RF at the current price`);

  /* --------------------------------------------- 5. decode sanity vs their site */
  console.log("\n-- decode cross-check against rarefriends.com (their number, our math) --");
  let api = null;
  try {
    // NOT the zero address. Their endpoint resolves an account for whatever you pass
    // and 502s on 0x0, so this check skipped on every run while still reporting
    // "ALL CHECKS PASS": the one assertion tying our slot decode to their published
    // number was never actually made. Ask about an address that exists.
    // 2026-09-25: they retired /api/protocol/state; /api/protocol/snapshot carries the same prices block.
    const r = await fetch("https://rarefriends.com/api/protocol/snapshot", { signal: AbortSignal.timeout(12000) });
    if (r.ok) { const j = await r.json(); if (j?.prices?.rfUsd) api = { protocol: { prices: j.prices } }; }
  } catch { /* their API is unversioned and has 502'd before; never let it fail our run */ }
  if (!api?.protocol?.prices?.rfUsd) {
    skip("slot0 price agrees with rarefriends.com rfUsd", "their API did not answer; chain assertions above stand alone");
  } else {
    const { rfUsd, ethUsd } = api.protocol.prices;
    const ourRfUsd = pool.wethPerRf * ethUsd;
    const drift = Math.abs(ourRfUsd - rfUsd) / rfUsd;
    isTrue("slot0 price agrees with rarefriends.com rfUsd (proves the slot decode)",
      drift < 0.02, `ours $${ourRfUsd.toPrecision(8)} vs theirs $${Number(rfUsd).toPrecision(8)} (${fmt.pct(drift, 3)} drift)`);
  }

  /* ------------------------------------------------ 6. the deposit rail is real */
  console.log("\n-- the deposit rail: ERC-6551 Friend wallets --");
  const [registry, implementation] = await Promise.all([
    rd(ADDR.Generations, ABI.generations, "ACCOUNT_REGISTRY"),
    rd(ADDR.Generations, ABI.generations, "accountImplementation"),
  ]);
  eq("Friend wallets use the canonical ERC-6551 registry", registry, ADDR.ERC6551Registry);
  isTrue("the account implementation is deployed", (await c.getBytecode({ address: implementation }))?.length > 2, implementation);

  // Use a Friend that is known-activated so earned() is meaningful.
  // Generations #5339 belongs to 0x97f29031..., the largest holder by weight. The
  // probe must never be Hunt's own Friend: simulating execute from its owner is
  // impersonation in spirit, even as a read-only eth_call.
  const PROBE = { collection: ADDR.Generations, tokenId: 5339n };
  const tba = await rd(ADDR.Generations, ABI.generations, "tokenBoundAccount", [PROBE.tokenId]);
  const [tbaOwner, nftOwner, tbaToken] = await Promise.all([
    rd(tba, ABI.tba, "owner"),
    rd(ADDR.Generations, ABI.generations, "ownerOf", [PROBE.tokenId]),
    rd(tba, ABI.tba, "token"),
  ]);
  eq(`TBA.owner() tracks the NFT owner (Generations #${PROBE.tokenId})`, tbaOwner, nftOwner);
  isTrue("TBA.token() points back at its own NFT",
    tbaToken[1].toLowerCase() === ADDR.Generations.toLowerCase() && tbaToken[2] === PROBE.tokenId,
    `chain ${tbaToken[0]}, ${tbaToken[1]}, #${tbaToken[2]}`);

  // Owner-only execute: the whole non-custodial design rests on this being true.
  const approveCall = {
    address: tba, abi: ABI.tba, functionName: "execute",
    args: [ADDR.RF, 0n, "0x095ea7b3" + "0".repeat(24) + ADDR.Market.slice(2).toLowerCase() + "f".repeat(64), 0],
  };
  // A refusal only counts if it is the RIGHT refusal. "It reverted" would also be
  // true of a dead RPC, so match the account's own error selector.
  let ownerMay = false;
  try { await c.simulateContract({ ...approveCall, account: nftOwner }); ownerMay = true; } catch { ownerMay = false; }
  const rando = await revertSelector(c.simulateContract({ ...approveCall, account: RANDO }));
  isTrue("the Friend's owner CAN execute from its wallet (so they can approve the Bank)", ownerMay, nftOwner);
  isTrue("a stranger CANNOT execute from it (so an approval is the only power the Bank ever gets)",
    rando === ERR.InvalidSigner, `reverts ${rando ?? "NOTHING"} (InvalidSigner is ${ERR.InvalidSigner})`);

  /* --------------------------------------- 7. harvesting needs nobody's blessing */
  console.log("\n-- harvesting is permissionless --");
  let claimable = null;
  try {
    const sim = await c.simulateContract({
      address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "claim",
      args: [ADDR.RF, PROBE.collection, PROBE.tokenId], account: RANDO,
    });
    claimable = sim.result;
  } catch (e) { claimable = null; }
  isTrue("ActivationManager.claim() succeeds when simulated from an unrelated address",
    claimable !== null, claimable === null ? "reverted" : `would claim ${fmt.eth(claimable)} RF`);
  const earned = await rd(ADDR.ActivationManager, ABI.activationManager, "earned", [ADDR.RF, PROBE.collection, PROBE.tokenId]);
  isTrue("earned() agrees with what the simulated claim would pay", claimable !== null && claimable >= earned,
    `earned ${fmt.eth(earned)} RF, claim returns ${claimable === null ? "n/a" : fmt.eth(claimable)} RF`);

  // A real Claimed log must credit the Friend's wallet, never the caller.
  const { head, perDay, secondsPerBlock: spb } = await blocksPerDay(c);
  const claimLogs = await scanLogs(c, {
    address: ADDR.ActivationManager,
    event: ABI.activationManager.find((x) => x.type === "event" && x.name === "Claimed"),
    fromBlock: head - perDay / 4n, toBlock: head,
  });
  if (claimLogs.length === 0) {
    skip("a real Claimed log credits the Friend's token-bound wallet", "no claims in the sampled window");
  } else {
    const sample = claimLogs[claimLogs.length - 1];
    const coll = getAddress(sample.args.collection);
    const abi = coll === ADDR.Genesis ? ABI.genesis : ABI.generations;
    const expectTba = await rd(coll, abi, "tokenBoundAccount", [sample.args.tokenId]);
    eq(`a real Claimed log credits the Friend's own wallet (#${sample.args.tokenId})`, sample.args.account, expectTba);
  }

  /* ------------------------------------------------- 8. the economics, measured */
  console.log("\n-- the economics, measured over the last 24h --");
  isTrue("block time is measured, not assumed", spb > 0 && spb < 10, `${spb.toFixed(4)} s/block => ${fmt.n(Number(perDay))} blocks/day`);
  const feeLogs = await scanLogs(c, {
    address: ADDR.Hook,
    event: ABI.hook.find((x) => x.type === "event" && x.name === "FeeCollected"),
    fromBlock: head - perDay, toBlock: head,
    onChunk: process.stdout.isTTY
      ? (to, n) => process.stdout.write(`\r       scanning fees... block ${to} (${n} events)   `)
      : undefined,
  });
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");
  const feeWei = feeLogs.reduce((a, l) => a + BigInt(l.data), 0n);
  const feeWeth = Number(feeWei) / 1e18;
  isTrue("the Hook is actively collecting fees right now", feeLogs.length > 0, `${feeLogs.length} FeeCollected events in 24h`);
  isTrue("fee volume is material, so this is a market worth deepening", feeWeth > 0,
    `${feeWeth.toFixed(6)} WETH in fees => ${(feeWeth / 0.05).toFixed(3)} WETH of implied volume at 5%`);

  const [totalWeight, maxBatch, retired] = await Promise.all([
    rd(ADDR.ActivationManager, ABI.activationManager, "totalWeight"),
    rd(ADDR.ActivationManager, ABI.activationManager, "MAX_CLAIM_BATCH"),
    rd(ADDR.ActivationManager, ABI.activationManager, "retired"),
  ]);
  isTrue("ActivationManager is live (not retired)", retired === false);
  isTrue("totalWeight is non-zero, so reward shares are computable", totalWeight > 0n, `${fmt.n(Number(totalWeight) / 1e18)} weight`);
  isTrue("claimBatch can harvest many Friends per transaction", maxBatch >= 10n, `MAX_CLAIM_BATCH=${maxBatch}`);

  /* ------------------------------------- 9. the fee is WETH, both directions */
  console.log("\n-- the 5% is always taken in WETH, on buys AND sells (read from real receipts) --");
  const swapEvent = ABI.poolManager.find((x) => x.type === "event" && x.name === "Swap");
  const swaps = await scanLogs(c, { address: ADDR.PoolManager, event: swapEvent, args: { id: POOL_ID }, fromBlock: head - perDay, toBlock: head });
  isTrue("every swap in the last 24h settled at an LP fee of 0 (the Swap log's own fee field)",
    swaps.length > 0 && swaps.every((l) => Number(l.args.fee) === 0),
    `${swaps.length} swaps, fee fields seen: ${[...new Set(swaps.map((l) => Number(l.args.fee)))].join(", ")}`);

  // Classify real swaps by which token went INTO the PoolManager, then read the
  // Hook's own transfers in the same receipt. Newest first; stop at one of each side.
  const seen = {};
  for (const l of [...swaps].reverse()) {
    if (seen.buy && seen.sell) break;
    const rc = await c.getTransactionReceipt({ hash: l.transactionHash });
    const t = parseEventLogs({ abi: TRANSFER, logs: rc.logs, strict: false })
      .filter((x) => x.args?.from && x.args?.to)
      .map((x) => ({ token: getAddress(x.address), from: getAddress(x.args.from), to: getAddress(x.args.to), v: x.args.value }));
    const fees = parseEventLogs({ abi: ABI.hook, logs: rc.logs.filter((x) => getAddress(x.address) === ADDR.Hook), eventName: "FeeCollected" });
    if (fees.length !== 1) continue;   // several swaps in one transaction; keep the sample clean
    const intoPm = t.filter((x) => x.to === ADDR.PoolManager && x.from !== ADDR.Hook);
    const side = intoPm.some((x) => x.token === ADDR.WETH) ? "buy" : intoPm.some((x) => x.token === ADDR.RF) ? "sell" : null;
    if (!side || seen[side]) continue;
    seen[side] = { tx: l.transactionHash, fee: fees[0].args.amount, t };
  }
  for (const side of ["buy", "sell"]) {
    const x = seen[side];
    if (!x) { skip(`a real ${side}: the fee is WETH`, `no clean ${side} in the last 24h`); continue; }
    const hookRf = x.t.filter((y) => y.token === ADDR.RF && (y.from === ADDR.Hook || y.to === ADDR.Hook));
    const toAm = x.t.filter((y) => y.token === ADDR.WETH && y.from === ADDR.Hook && y.to === ADDR.ActivationManager);
    isTrue(`a real ${side}: the Hook sent WETH, exactly the fee, to the ActivationManager`,
      toAm.length === 1 && toAm[0].v === x.fee, `${fmt.eth(x.fee, 8)} WETH  (tx ${x.tx.slice(0, 12)}...)`);
    isTrue(`a real ${side}: the Hook touched no RF at all`, hookRf.length === 0, `${hookRf.length} RF transfers involving the Hook`);
    // The WETH side of the trade: what the swapper paid in (buy) or the gross WETH out (sell).
    const wethSide = side === "buy"
      ? x.t.filter((y) => y.token === ADDR.WETH && y.to === ADDR.PoolManager && y.from !== ADDR.Hook).reduce((a, y) => a + y.v, 0n)
      : x.t.filter((y) => y.token === ADDR.WETH && y.from === ADDR.PoolManager && y.to !== ADDR.Hook).reduce((a, y) => a + y.v, 0n) + x.fee;
    const share = wethSide > 0n ? Number(x.fee) / Number(wethSide) : 0;
    isTrue(`a real ${side}: the fee is 5.00% of the WETH side`, Math.abs(share - 0.05) < 0.0001,
      `${fmt.pct(share, 4)} of ${fmt.eth(wethSide, 6)} WETH ${side === "buy" ? "paid in" : "gross out"}`);
  }

  /* ------------------------------------------ 10. rewards arrive a week late */
  console.log("\n-- rewards stream a week behind the fees, and someone has to start each week --");
  const st = await readStreams(c);
  const allocEvent = ABI.activationManager.find((x) => x.type === "event" && x.name === "Allocated");
  // finish = the allocate's own timestamp + DURATION, so the last Allocated log sits
  // near a KNOWN block. Scan an hour either side of it, not the pool's whole life:
  // blocks older than ~3 days are very slow on this RPC.
  const lastAllocBlock = (s) => head - BigInt(Math.round((st.now - Number(s.finish - st.duration)) / spb));
  const around = (b) => ({ fromBlock: b - 36000n > POOL_SEED_BLOCK ? b - 36000n : POOL_SEED_BLOCK, toBlock: b + 36000n < head ? b + 36000n : head });
  const allocs = [];
  for (const k of ["RF", "WETH"]) {
    for (const l of await scanLogs(c, { address: ADDR.ActivationManager, event: allocEvent, ...around(lastAllocBlock(st[k])) })) {
      if (!allocs.some((x) => x.transactionHash === l.transactionHash && x.logIndex === l.logIndex)) allocs.push(l);
    }
  }
  allocs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  eq("stream DURATION is 7 days", st.duration, 604800n, String);
  for (const [name, asset, d] of [["RF", ADDR.RF, 0], ["WETH", ADDR.WETH, 4]]) {
    const s = st[name];
    const last = allocs.filter((l) => getAddress(l.args.asset) === asset).at(-1);
    if (!last) { record("FAIL", `${name}: an Allocated log exists for the running stream`, "none found since the pool was seeded"); continue; }
    eq(`${name}: the running stream ends where its last Allocated log said it would`, s.finish, last.args.finish, String);
    isTrue(`${name}: its rate is that allocation spread over DURATION`, s.rate === last.args.amount / st.duration,
      `${fmt.eth(last.args.amount, d)} ${name} / 604800 s = ${s.rate} wei per s`);
    const bal = await rd(asset, ABI.erc20, "balanceOf", [ADDR.ActivationManager]);
    isTrue(`${name}: the ActivationManager holds at least pending + the unstreamed remainder`, bal >= s.pending + s.remaining,
      `holds ${fmt.eth(bal, d)}, owes pending ${fmt.eth(s.pending, d)} + remaining ${fmt.eth(s.remaining, d)}`);
    isTrue(`${name}: allocate() is due exactly when the stream has ended and something is pending`,
      s.allocateDue === (st.now >= Number(s.finish) && s.pending > 0n),
      s.secondsLeft > 0 ? `${(s.secondsLeft / 3600).toFixed(1)} h left; next week ${fmt.eth(s.nextPerWeek, d)} ${name} waiting` : `DUE: ${fmt.eth(s.pending, d)} ${name} waiting`);
  }
  const allocSim = await c.simulateContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "allocate", args: [ADDR.WETH], account: RANDO })
    .then(() => "clean")
    .catch((e) => (/0x764c775e/.test(JSON.stringify(e, (k, v) => (typeof v === "bigint" ? String(v) : v)) + String(e.message)) ? "StreamUnavailable" : `other: ${e.shortMessage}`));
  isTrue("allocate() needs no permission: from a stranger it succeeds, or reverts ONLY because the stream is still running",
    allocSim === "clean" || (allocSim === "StreamUnavailable" && st.WETH.secondsLeft > 0),
    allocSim === "clean" ? "simulates clean" : `reverts ${allocSim} (0x764c775e) with ${(st.WETH.secondsLeft / 3600).toFixed(1)} h left`);

  /* ------------------------------ 10b. the idle pool, derived in three reads */
  console.log("\n-- rewards earned but unclaimed, protocol-wide --");
  const idle = await readProtocolIdle(c);
  // Cross-check the identity against a real sum: every Genesis's earned(), in one
  // Multicall3 pass. Genesis carry ~95% of active weight, so their sum must fit
  // UNDER the identity and make up most of it. Both halves are asserted.
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const gIds = [...Array(1024)].map((_, i) => BigInt(i + 1));
  for (const [name, asset, d] of [["RF", ADDR.RF, 0], ["WETH", ADDR.WETH, 6]]) {
    let sum = 0n, failed = 0;
    for (let i = 0; i < gIds.length; i += 512) {
      const r = await c.multicall({
        contracts: gIds.slice(i, i + 512).map((id) => ({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [asset, ADDR.Genesis, id] })),
        blockNumber: idle.blockNumber, allowFailure: true, multicallAddress: MULTICALL3,
      });
      for (const x of r) x.status === "success" ? (sum += x.result) : failed++;
    }
    const share = Number(sum) / Number(idle[name]);
    isTrue(`${name}: idle = balance - pending - remaining is positive and COVERS every Genesis's earned()`,
      failed === 0 && idle[name] > 0n && sum <= idle[name],
      `idle ${fmt.eth(idle[name], d)} >= sum over 1,024 Genesis ${fmt.eth(sum, d)}${failed ? ` (${failed} reads failed)` : ""}`);
    isTrue(`${name}: Genesis account for most of it (they hold ~95% of active weight)`, share >= 0.8 && share <= 1,
      `${fmt.pct(share, 2)} of the idle pool`);
  }

  /* ---------------------------------------------- 11. who can change all this */
  console.log("\n-- one key owns every protocol contract --");
  const wiring = await readRewardsWiring(c);
  eq("Market.rewards() IS the ActivationManager too", wiring.marketRewards, ADDR.ActivationManager);
  const owners = await readOwners(c);
  isTrue(`all ${OWNED.length} owned protocol contracts share ONE owner`, owners.distinct.length === 1,
    OWNED.map((n) => `${n}=${owners.byContract[n].slice(0, 8)}`).join(" "));
  isTrue("that owner is a plain EOA (no code): one private key, not a multisig or timelock",
    owners.distinct.every((a) => owners.isEoa[a]), owners.distinct.join(", "));
  const [gImpl, nImpl] = await Promise.all([
    rd(ADDR.Genesis, ABI.genesis, "accountImplementation"),
    rd(ADDR.Generations, ABI.generations, "accountImplementation"),
  ]);
  eq("Genesis and Generations wallets run the SAME account implementation", gImpl, nImpl);

  // execute takes a plain call only: no delegatecall, so no batching module can be bolted on.
  const delegate = { ...approveCall, args: [...approveCall.args.slice(0, 3), 1] };
  const ownerDelegate = await revertSelector(c.simulateContract({ ...delegate, account: nftOwner }));
  isTrue("even the Friend's owner CANNOT delegatecall from its wallet (operation 1 is refused)",
    ownerDelegate === ERR.UnsupportedOperation, `reverts ${ownerDelegate ?? "NOTHING"} (UnsupportedOperation is ${ERR.UnsupportedOperation})`);

  /* ----------------------------------------------------------------- verdict */
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${"=".repeat(68)}`);
  console.log(`${results.length} checks graded:  ${pass} pass,  ${fail} fail,  ${skipped} skip`);

  if (results.length === 0) {
    console.error("FATAL: this instrument graded nothing. Treat that as a failure, not a pass.");
    process.exit(2);
  }
  if (pass < MIN_PASS) {
    console.error(`FATAL: only ${pass} checks passed. This harness asserted ${MIN_PASS}+ at its 2026-09-22 revision; fewer checks with no failures means lost coverage.`);
    process.exit(2);
  }
  if (fail > 0) {
    console.error(`\nFAILED checks:\n${results.filter((r) => r.status === "FAIL").map((r) => `  - ${r.name}: ${r.detail}`).join("\n")}`);
    process.exit(1);
  }
  // A skip is not a pass. Saying "ALL CHECKS PASS" over a silent skip is how the
  // rarefriends.com cross-check sat dead for a week while the README claimed 37/37.
  console.log(skipped === 0
    ? "ALL CHECKS PASS"
    : `ALL ${pass} GRADED CHECKS PASS, ${skipped} SKIPPED (named above). Not the same as ${results.length}/${results.length}.`);
  console.log(`${"=".repeat(68)}`);
}

main().catch((e) => { console.error("\nharness crashed:", e); process.exit(3); });
