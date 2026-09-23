#!/usr/bin/env node
/**
 * The keeper. It prints a plan by default; `--execute` sends the plan.
 *
 *   node scripts/keeper.mjs --wallet huntclubhero.eth               # harvest-only plan for a wallet
 *   node scripts/keeper.mjs --members members.json                  # harvest-only plan for a list
 *   node scripts/keeper.mjs --bank 0xBANK [--bank-from 70000000]    # the Bank's members, from its logs
 *   node scripts/keeper.mjs --bank 0xBANK --wallet 0xABC            # the Bank's members held by one wallet
 *   ... --rpc http://127.0.0.1:8547                                 # a fork, for rehearsals
 *
 * `members.json` is `[{ "collection": "0x...", "tokenId": "259", "owner": "0x..." }]`,
 * where owner is who signed up.
 *
 * Each run does these things, in this order, and each is tied to a fact verified
 * on chain or on a fork:
 *
 *  1. WIRING. If `Hook.rewards()` stops pointing at the ActivationManager, or the
 *     ActivationManager is retired, the 5% is no longer reaching Friends. The owner
 *     key can do either at any time. That is an ALARM, the keeper plans nothing else,
 *     and it exits 4 so a scheduler notices.
 *  2. ALLOCATE. Fees only reach Friends once someone calls `allocate(asset)` after
 *     the running 7-day stream ends. Nobody is obliged to, so the keeper does. (The
 *     Bank's `collect` also tries it; this is the fallback when nothing is collected.)
 *  3a. WITHOUT a Bank: CLAIM. `claimBatch` is permissionless and always pays the
 *     Friend's own wallet. A Friend is claimed for an asset only when its accrual is
 *     worth at least 20x its share of MEASURED batch gas (quant's rule), priced in
 *     WETH, RF at the pool price less the 5% hook fee it pays to become WETH.
 *  3b. WITH a Bank (FriendBankV2, ledger's contract is the source of truth):
 *     - members are indexed from the Bank's own Joined / Left / Suspended logs;
 *     - a Friend whose `ownerOf` or wallet changed since it joined gets
 *       `suspendIfTransferred`, because the wallet and every allowance it granted
 *       now belong to the buyer. `collect` would also suspend it, but nobody should
 *       pay collect gas to find that out;
 *     - a holder more than 256 settle steps behind is skipped by `collect`
 *       (Skipped reason 2), so `settle(holder, n)` goes first;
 *     - `collect` runs for Friends whose collectable value, min(earned + owed, the
 *       day's room, the wallet's allowance) per asset, clears the same 20x bar.
 *       `collect` claims into the Friend's wallet and pulls in one call, so no
 *       separate claimBatch is sent for members. A SWEEP member's available is the
 *       wallet balance above its signup floor plus what the claim adds (ledger:
 *       collectable() does not fold sweep in);
 *     - while the desk is armed (quotingHalted is false) the Bank's price observer
 *       needs a poke every ~5 minutes (a TWAP wants 6 in the last hour), so the
 *       plan includes poke(). Run the keeper on a 5-minute schedule then.
 *  3c. WITH a Bank: THE DESK. The market gates are measured from the pool's price path
 *     (the shipped hourly seed, extended from Swap logs and cached in data/), the
 *     Bank's and desk's state is read from chain, and lib/desk-plan.mjs decides which
 *     of closeAsk / closeBid / placeAsk / placeBid to send. Every desk call is
 *     SIMULATED from the Bank's keeper address, dry run included; a call that would
 *     revert is dropped and the revert is printed. Only the Bank's keeper can place,
 *     so --execute sends desk calls only when HARVESTER_PRIVATE_KEY is that keeper.
 *  4. REPORT. Live ETH/USD for display only. No price in this file is hardcoded.
 *
 * Rehearsal only: `--assume-armed` overrides the three market gates as met, so a local
 * fork can exercise placements the real market does not arm for. It is refused unless
 * --rpc points at localhost.
 */
import fs from "node:fs";
import { createWalletClient, createPublicClient, http, getAddress, isAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDR, ABI, CHAIN, POOL_ID, POOL_SEED_BLOCK, client, fmt, scanLogs, blocksPerDay,
  readPool, readStreams, readRewardsWiring, readOwners, ethUsd,
} from "../lib/protocol.mjs";
import { DEFAULT_GATES, measurePath, explain } from "../lib/strategy.mjs";
import { planDesk } from "../lib/desk-plan.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const EXECUTE = has("--execute");
const MEMBERS = val("--members");
const BANK = val("--bank") ? getAddress(val("--bank")) : null;
const RPC = val("--rpc");
const LOCAL_RPC = !!RPC && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
const ASSUME_ARMED = has("--assume-armed");
if (ASSUME_ARMED && !LOCAL_RPC) {
  console.error("--assume-armed is a fork rehearsal switch; it needs --rpc http://127.0.0.1:<port>.");
  process.exit(1);
}
/** quant's rule: a claim or collect must be worth 20x the gas it burns. */
const GAS_MULTIPLE = Number(val("--gas-multiple") ?? 20);
/** RF only becomes WETH through the pool, which takes 5% of the WETH side. */
const RF_HAIRCUT = 0.95;
/** FriendBankV2 skips a holder further behind than this; settle first. */
const MAX_STEPS_BEHIND = 256n;
/** ledger's fork measurement, used ONLY if a collect cannot be estimated. Said so when used. */
const COLLECT_GAS_FALLBACK = 568_000n;
/** The single key that owns every protocol contract today. A change is news. */
const PINNED_OWNER = getAddress("0x1ecbf27dc1f809179b9ef2d382cd76ccba21b6d2");
/** Simulations run from an address that holds nothing, to prove they need no permission. */
const RANDO = getAddress("0x00000000000000000000000000000000deadbeef");

/** FriendBankV2, the harvest side (stable per ledger). */
const BANK_ABI = parseAbi([
  "event Joined(address indexed holder, address indexed collection, uint256 indexed tokenId, address tba, uint256 capRf, uint256 capWeth, bool sweep)",
  "event Left(address indexed holder, address indexed collection, uint256 indexed tokenId, address by)",
  "event Suspended(address indexed holder, address indexed collection, uint256 indexed tokenId, address currentOwner)",
  "function friendOf(address collection, uint256 tokenId) view returns ((address holder, uint64 epochStart, uint64 lastTipAt, bool active, bool sweep, address tba, uint128 capRf, uint128 capWeth, uint128 pulledRf, uint128 pulledWeth, uint128 owedRf, uint128 owedWeth, uint128 floorRf, uint128 floorWeth, uint256 seenState))",
  "function collectable(address collection, uint256 tokenId) view returns (uint256 earnedRf, uint256 earnedWeth, uint256 roomRf, uint256 roomWeth, uint256 allowRf, uint256 allowWeth, uint256 owedRf, uint256 owedWeth)",
  "function stepsBehind(address holder) view returns (uint256)",
  "function collect(address[] collections, uint256[] tokenIds)",
  "function suspendIfTransferred(address collection, uint256 tokenId)",
  "function settle(address holder, uint256 maxSteps) returns (bool)",
  "function quotingHalted() view returns (bool)",
  "function poke()",
  // the desk side
  "function keeper() view returns (address)",
  "function DESK() view returns (address)",
  "function OBSERVER() view returns (address)",
  "function bookR() view returns (uint256)",
  "function bookW() view returns (uint256)",
  "function ask() view returns (bool open, uint64 openedAt, uint256 units)",
  "function bid() view returns (bool open, uint64 openedAt, uint256 units)",
  "function maxRangeBps() view returns (uint256)",
  "function maxDailyTurnoverBps() view returns (uint256)",
  "function usedBpsRf() view returns (uint256)",
  "function usedBpsWeth() view returns (uint256)",
  "function usedModifies() view returns (uint256)",
  "function usedAt() view returns (uint256)",
  "function placeAsk(int24 tickLower, int24 tickUpper, uint256 amount)",
  "function placeBid(int24 tickLower, int24 tickUpper, uint256 amount)",
  "function closeAsk()",
  "function closeBid()",
]);

/** RangeDesk (the Bank's desk) and its PoolObserver: read only. */
const DESK_ABI = parseAbi([
  "function ask() view returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 input, uint256 reserved)",
  "function bid() view returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 input, uint256 reserved)",
  "function costRf() view returns (uint256)",
  "function costWeth() view returns (uint256)",
  "function lastSellWethPerRf() view returns (uint256)",
  "function lastSellAt() view returns (uint256)",
  "function lossSpentWeth() view returns (uint256)",
  "function twapEdgeTicks() view returns (int24)",
  "function TICK_SPACING() view returns (int24)",
]);
const OBS_ABI = parseAbi([
  "function spotTick() view returns (int24)",
  "function twapTick() view returns (int24)",
]);

const c = client(RPC ?? undefined);
const am = (fn, a = []) => c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: fn, args: a });
const nft = (collection) => (getAddress(collection) === ADDR.Genesis ? ABI.genesis : ABI.generations);
const label = (m) => `${getAddress(m.collection) === ADDR.Genesis ? "Genesis" : "Generations"} #${m.tokenId}`;
const pace = () => new Promise((r) => setTimeout(r, 400));   // the public RPC rate-limits if hammered
const min = (...xs) => xs.reduce((a, b) => (b < a ? b : a));

/** Accept an address or an ENS name (resolved on Ethereum mainnet, where ENS lives). */
async function resolveWallet(v) {
  if (!v) return null;
  if (isAddress(v)) return getAddress(v);
  const eth = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
  const a = await eth.getEnsAddress({ name: v });
  if (!a) throw new Error(`could not resolve ${v}`);
  return getAddress(a);
}
const WALLET = await resolveWallet(val("--wallet"));

/* ------------------------------------------------------------------ members */

/**
 * Harvest-only discovery from rarefriends.com's state endpoint (both collections
 * in one call). Discovery only: every fact that matters is re-read from chain.
 */
async function membersFromWallet(owner) {
  const r = await fetch(`https://rarefriends.com/api/protocol/state?address=${owner.toLowerCase()}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`discovery failed: rarefriends.com HTTP ${r.status}`);
  const j = await r.json();
  const byName = { Genesis: ADDR.Genesis, Generations: ADDR.Generations };
  return (j.account?.friends ?? [])
    .filter((f) => byName[f.collection])
    .map((f) => ({ collection: byName[f.collection], tokenId: BigInt(f.id), owner }));
}

function membersFromFile(path) {
  return JSON.parse(fs.readFileSync(path, "utf8")).map((m) => ({
    collection: getAddress(m.collection), tokenId: BigInt(m.tokenId), owner: getAddress(m.owner),
  }));
}

/** The Bank's members, from its own logs. Latest event per Friend wins. */
async function membersFromBank(bank, holder) {
  const from = BigInt(val("--bank-from") ?? POOL_SEED_BLOCK);
  const head = await c.getBlockNumber();
  const ev = (n) => BANK_ABI.find((x) => x.type === "event" && x.name === n);
  const logs = [];
  for (const n of ["Joined", "Left", "Suspended"]) {
    logs.push(...await scanLogs(c, { address: bank, event: ev(n), args: holder ? { holder } : undefined, fromBlock: from, toBlock: head, chunk: 1000000n }));
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
  const byKey = new Map();
  for (const l of logs) {
    const k = `${getAddress(l.args.collection)}:${l.args.tokenId}`;
    if (l.eventName === "Joined") byKey.set(k, { collection: getAddress(l.args.collection), tokenId: l.args.tokenId, owner: getAddress(l.args.holder) });
    else byKey.delete(k);
  }
  return [...byKey.values()];
}

/**
 * Everything the plan needs about one Friend, read from chain in one pass.
 * `earned` REVERTS (0xb09bf60e) for a temporary Friend, the weightless token RF
 * auto-mints to any holder of 1 RF, and discovery returns those too. A revert
 * there is "earns nothing", not a crash.
 */
const earnedOrZero = (asset, m) => am("earned", [asset, m.collection, m.tokenId]).catch(() => 0n);
async function readMember(m) {
  const abi = nft(m.collection);
  const [ownerNow, tba, position, earnedRf, earnedWeth] = await Promise.all([
    c.readContract({ address: m.collection, abi, functionName: "ownerOf", args: [m.tokenId] }),
    c.readContract({ address: m.collection, abi, functionName: "tokenBoundAccount", args: [m.tokenId] }),
    am("positions", [m.collection, m.tokenId]),
    earnedOrZero(ADDR.RF, m),
    earnedOrZero(ADDR.WETH, m),
  ]);
  const temp = getAddress(m.collection) === ADDR.Generations
    ? c.readContract({ address: m.collection, abi, functionName: "locked", args: [m.tokenId] })
    : false;
  const bank = BANK
    ? Promise.all([
      c.readContract({ address: BANK, abi: BANK_ABI, functionName: "friendOf", args: [m.collection, m.tokenId] }),
      c.readContract({ address: BANK, abi: BANK_ABI, functionName: "collectable", args: [m.collection, m.tokenId] }),
    ])
    : null;
  const bal = (t) => (BANK ? c.readContract({ address: t, abi: ABI.erc20, functionName: "balanceOf", args: [tba] }) : 0n);
  const [isTemp, bankView, walletRf, walletWeth] = await Promise.all([temp, bank, bal(ADDR.RF), bal(ADDR.WETH)]);
  return {
    ...m, ownerNow: getAddress(ownerNow), tba: getAddress(tba), weight: position[1], isTemp, earnedRf, earnedWeth,
    walletRf, walletWeth, friend: bankView?.[0] ?? null, col: bankView?.[1] ?? null,
  };
}

/* ------------------------------------------------------------------ market */

/**
 * The pool's hourly price path, for the desk's market gates. Same method as the site
 * (app/lib/price-series.ts): seeded from app/lib/price-hourly.json, extended with every
 * Swap log since, one close per hour = the last swap price at or before it. The keeper
 * caches the extended series in data/keeper-series.json so each run scans only new
 * blocks. Rehearsals (--rpc) never read or write the cache: a fork's clock and swaps
 * are not the chain's. The last 74h of swaps are kept too, because hourly closes hide
 * swings inside an hour and the swing gate counts them swap by swap.
 */
const HOUR = 3600, KEEP_HOURS = 9 * 24, SWAP_HOURS = 74;
const CACHE = new URL("../data/keeper-series.json", import.meta.url);
async function marketPath(pool) {
  const seedFile = JSON.parse(fs.readFileSync(new URL("../app/lib/price-hourly.json", import.meta.url), "utf8"));
  const seed = {
    startTs: seedFile.startTs, closes: seedFile.closes, lastTs: seedFile.lastTs, scannedTo: seedFile.lastBlock,
    lastPrice: seedFile.closes[seedFile.closes.length - 1], swaps: [], swapsFrom: null,
  };
  let prev = seed;
  if (!RPC && fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (cached.scannedTo >= seed.scannedTo) prev = cached;
  }
  const { head, secondsPerBlock: spb, headTimestamp: tNow } = await blocksPerDay(c);
  const tOf = (b) => tNow - Number(head - BigInt(b)) * spb;
  const from = BigInt(prev.scannedTo) + 1n;
  const swap = ABI.poolManager.find((x) => x.type === "event" && x.name === "Swap");
  const logs = from > head ? [] : await scanLogs(c, {
    address: ADDR.PoolManager, event: swap, args: { id: POOL_ID }, fromBlock: from, toBlock: head, chunk: 100_000n, pace: 0, concurrency: 4,
  });
  const pts = logs
    .map((l) => { const x = Number(l.args.sqrtPriceX96) / 2 ** 96; return { t: tOf(l.blockNumber), b: Number(l.blockNumber), i: Number(l.logIndex), p: x * x }; })
    .sort((a, b) => (a.b === b.b ? a.i - b.i : a.b - b.b));
  const endTs = Math.floor(tNow / HOUR) * HOUR;
  const closes = [...prev.closes];
  let p = prev.lastPrice, k = 0;
  for (let h = prev.lastTs + HOUR; h <= endTs; h += HOUR) {
    while (k < pts.length && pts[k].t <= h) p = pts[k++].p;
    closes.push(p);
  }
  while (k < pts.length) p = pts[k++].p;
  const drop = Math.max(0, closes.length - KEEP_HOURS);
  const keepFrom = tNow - SWAP_HOURS * HOUR;
  // Swap-level coverage starts where this cache started scanning, never earlier.
  const next = {
    startTs: prev.startTs + drop * HOUR, closes: closes.slice(drop), lastTs: Math.max(endTs, prev.lastTs),
    scannedTo: Number(head), lastPrice: p,
    swaps: [...(prev.swaps ?? []), ...pts].filter((x) => x.t >= keepFrom),
    swapsFrom: Math.max(prev.swapsFrom ?? tOf(from), keepFrom),
    updatedAt: new Date().toISOString(),
  };
  if (!RPC) {
    fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(next));
  }

  // Hourly path ending at the live price, walked back like the site's.
  const at = (t) => (t < next.startTs || t > next.lastTs ? null : next.closes[Math.floor((t - next.startTs) / HOUR)] ?? null);
  const back = [pool.wethPerRf];
  for (let h = 1; h <= 8 * 24; h++) { const q = at(tNow - h * HOUR); if (q == null) break; back.push(q); }
  const t72 = tNow - 72 * HOUR;
  const ticks72 = next.swapsFrom <= t72 && at(t72) != null
    ? [at(t72), ...next.swaps.filter((x) => x.t > t72).map((x) => x.p), pool.wethPerRf]
    : null;
  return {
    measured: measurePath(back.reverse(), DEFAULT_GATES, ticks72),
    newSwaps: pts.length,
    seriesTo: new Date(next.lastTs * 1000).toISOString(),
    swingSource: ticks72 ? "swap by swap" : "on hourly closes (the swap cache is not 72h deep yet; this can only under-count, so it errs toward off)",
  };
}

/* --------------------------------------------------------------------- main */

const members = BANK ? await membersFromBank(BANK, WALLET)
  : MEMBERS ? membersFromFile(MEMBERS)
  : WALLET ? await membersFromWallet(WALLET)
  : null;
if (!members) {
  console.error("keeper needs --bank <address>, --wallet <address|ens> or --members <file.json>.");
  process.exit(1);
}

console.log("Bank of Friends :: keeper");
console.log(`chain ${CHAIN.id}${RPC ? ` via ${RPC}` : ""}   |   ${BANK ? `Bank ${BANK}` : "no Bank (harvest only)"}   |   ${members.length} Friends${WALLET ? ` of ${WALLET}` : ""}   |   mode ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

/* 1. wiring ---------------------------------------------------------------- */
const [wiring, owners] = await Promise.all([readRewardsWiring(c), readOwners(c)]);
console.log("-- wiring --");
console.log(`  Hook.rewards()   ${wiring.hookRewards}${getAddress(wiring.hookRewards) === ADDR.ActivationManager ? "  (ActivationManager)" : "  <-- NOT the ActivationManager"}`);
console.log(`  Market.rewards() ${wiring.marketRewards}${getAddress(wiring.marketRewards) === ADDR.ActivationManager ? "  (ActivationManager)" : "  <-- NOT the ActivationManager"}`);
console.log(`  AM retired       ${wiring.retired}`);
const ownerMoved = owners.distinct.length !== 1 || owners.distinct[0] !== PINNED_OWNER;
console.log(`  protocol owner   ${owners.distinct.join(", ")}${owners.distinct.every((a) => owners.isEoa[a]) ? " (a single EOA key)" : ""}${ownerMoved ? "  <-- CHANGED since pinned" : ""}`);
if (!wiring.ok) {
  console.error("\n  ************************************************************************");
  console.error("  ALARM: the 5% swap fee is no longer reaching Friend holders.");
  console.error("  Either Hook.rewards() was repointed or the ActivationManager was retired.");
  console.error("  Claims may revert and every swap may revert. Plan nothing; page a human.");
  console.error("  ************************************************************************");
  process.exit(4);
}

/* 2. allocate -------------------------------------------------------------- */
const streams = await readStreams(c);
console.log("\n-- streams --");
const allocs = [];
for (const [name, asset, dec] of [["RF", ADDR.RF, 0], ["WETH", ADDR.WETH, 4]]) {
  const s = streams[name];
  const when = s.secondsLeft > 0 ? `ends in ${(s.secondsLeft / 3600).toFixed(1)} h` : "ENDED";
  console.log(`  ${name.padEnd(5)} paying ${fmt.eth(s.perWeek, dec)}/wk, ${when}; next stream ${fmt.eth(s.nextPerWeek, dec)}/wk pending`);
  if (s.allocateDue) {
    try {
      await c.simulateContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "allocate", args: [asset], account: RANDO });
      allocs.push({ asset, name });
      console.log(`        -> allocate(${name}) is DUE and simulates clean from a stranger. Planned.`);
    } catch (e) {
      console.log(`        -> allocate(${name}) looks due but the simulation reverted: ${(e.shortMessage ?? e.message).split("\n")[0]}`);
    }
  }
}

/* shared pricing ------------------------------------------------------------ */
const [pool, usd, gasPrice] = await Promise.all([readPool(c), ethUsd(), c.getGasPrice()]);
const rows = [];
for (const m of members) { rows.push(await readMember(m)); await pace(); }
const wethOf = (rf, weth) => Number(weth) / 1e18 + (Number(rf) / 1e18) * pool.wethPerRf * RF_HAIRCUT;
const usdOf = (w) => (usd ? `$${(w * usd.usd).toFixed(2)}` : "(no live ETH/USD)");
const gasWeth = (g) => Number(g * gasPrice) / 1e18;
const MAX_BATCH = Number(await am("MAX_CLAIM_BATCH"));
const bar = `${GAS_MULTIPLE}x gas; gas ${Number(gasPrice) / 1e9} gwei; RF at ${pool.wethPerRf.toExponential(4)} WETH x ${RF_HAIRCUT}`;

/**
 * Per-Friend gas is MEASURED: estimate the whole batch, divide by its size, drop
 * anything under the multiple, re-estimate the smaller batch, until stable.
 */
async function fitBatch(candidates, valueOf, estimate) {
  let batch = candidates;
  for (let round = 0; round < 5 && batch.length; round++) {
    const { gas, measured } = await estimate(batch);
    const per = gasWeth(gas) / batch.length;
    const keep = batch.filter((r) => valueOf(r) >= GAS_MULTIPLE * per);
    if (keep.length === batch.length) return { batch, gas, measured };
    batch = keep;
  }
  return { batch: [], gas: 0n, measured: true };
}

const claims = [];
const bankTx = [];   // { what, fn, args }
const deskTx = [];   // { fn, args, why }, each simulated clean as the Bank's keeper
let deskKeeper = null;

if (!BANK) {
  /* 3a. claim ---------------------------------------------------------------- */
  console.log(`\n-- claim (worth it only at ${bar}) --`);
  for (const [name, asset, amountOf, valueOf] of [
    ["RF", ADDR.RF, (r) => r.earnedRf, (r) => wethOf(r.earnedRf, 0n)],
    ["WETH", ADDR.WETH, (r) => r.earnedWeth, (r) => wethOf(0n, r.earnedWeth)],
  ]) {
    // Only live memberships: a Friend whose owner changed is no longer ours to spend gas on.
    const eligible = rows.filter((r) => r.ownerNow === r.owner && r.weight > 0n && amountOf(r) > 0n);
    let n = 0, value = 0, gas = 0n;
    for (let i = 0; i < eligible.length; i += MAX_BATCH) {
      const part = await fitBatch(eligible.slice(i, i + MAX_BATCH), valueOf, async (b) => ({
        gas: await c.estimateContractGas({
          address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "claimBatch",
          args: [asset, b.map((r) => r.collection), b.map((r) => r.tokenId)], account: RANDO,
        }),
        measured: true,
      }));
      if (part.batch.length) {
        claims.push({ asset, name, batch: part.batch });
        n += part.batch.length; gas += part.gas; value += part.batch.reduce((a, r) => a + valueOf(r), 0);
      }
    }
    console.log(`  ${name.padEnd(5)} ${n} of ${eligible.length} live Friends with something accrued clear the bar` +
      (n ? `: claims ${value.toFixed(6)} WETH-eq for ${gasWeth(gas).toFixed(8)} WETH gas (${(value / gasWeth(gas)).toFixed(0)}x) ${usdOf(value)}` : ""));
  }
  for (const r of rows) {
    const why = r.ownerNow !== r.owner ? `owner is now ${r.ownerNow}; not ours to claim`
      : r.isTemp ? "a temporary Friend (auto-minted for holding 1 RF); no weight, never earns"
      : r.weight === 0n ? "not active (never activated, or a transfer cleared it)"
      : `accrued ${fmt.eth(r.earnedRf, 2)} RF + ${fmt.eth(r.earnedWeth, 8)} WETH = ${usdOf(wethOf(r.earnedRf, r.earnedWeth))}`;
    console.log(`  ${label(r).padEnd(22)} ${why}`);
  }
} else {
  /* 3b. the Bank ------------------------------------------------------------- */
  console.log(`\n-- Bank members (collect only at ${bar}) --`);
  const live = [];
  const behind = new Map();
  for (const r of rows) {
    const f = r.friend;
    let verdict;
    if (!f || !f.active) {
      verdict = "inactive in the Bank (left or already suspended); nothing to do";
    } else if (r.ownerNow !== getAddress(f.holder) || r.tba !== getAddress(f.tba)) {
      // The wallet, its balances and every allowance it granted now belong to someone else.
      verdict = `SUSPEND: ownerOf is ${r.ownerNow} (joined by ${f.holder})${r.tba !== getAddress(f.tba) ? ", and the wallet moved" : ""}`;
      bankTx.push({ what: `suspendIfTransferred(${label(r)})`, fn: "suspendIfTransferred", args: [r.collection, r.tokenId] });
    } else {
      const [eRf, eWeth, roomRf, roomWeth, allowRf, allowWeth, owedRf, owedWeth] = r.col;
      // Sweep members also hand over what already sits in the wallet above their signup floor.
      const above = (bal, floor) => (bal > floor ? bal - floor : 0n);
      const availRf = f.sweep ? above(r.walletRf, f.floorRf) + eRf : eRf + owedRf;
      const availWeth = f.sweep ? above(r.walletWeth, f.floorWeth) + eWeth : eWeth + owedWeth;
      r.canRf = min(availRf, roomRf, allowRf);
      r.canWeth = min(availWeth, roomWeth, allowWeth);
      r.value = wethOf(r.canRf, r.canWeth);
      const limit = allowRf + allowWeth === 0n ? " (NO allowance from the Friend's wallet yet)"
        : roomRf + roomWeth === 0n ? " (today's cap is used up)" : "";
      verdict = `collectable ${fmt.eth(r.canRf, 2)} RF + ${fmt.eth(r.canWeth, 8)} WETH = ${usdOf(r.value)}${limit}; owed ${fmt.eth(owedRf, 2)} RF ${fmt.eth(owedWeth, 8)} WETH`;
      if (r.value > 0) live.push(r);
      const h = getAddress(f.holder);
      if (!behind.has(h)) behind.set(h, await c.readContract({ address: BANK, abi: BANK_ABI, functionName: "stepsBehind", args: [h] }));
    }
    console.log(`  ${label(r).padEnd(22)} ${verdict}`);
  }
  for (const [h, n] of behind) {
    if (n > MAX_STEPS_BEHIND) {
      console.log(`  holder ${h} is ${n} steps behind (collect skips past ${MAX_STEPS_BEHIND}): settle first`);
      bankTx.push({ what: `settle(${h.slice(0, 10)}, ${n})`, fn: "settle", args: [h, n] });
    }
  }
  for (let i = 0; i < live.length; i += MAX_BATCH) {
    const part = await fitBatch(live.slice(i, i + MAX_BATCH), (r) => r.value, async (b) => {
      try {
        const gas = await c.estimateContractGas({
          address: BANK, abi: BANK_ABI, functionName: "collect",
          args: [b.map((r) => r.collection), b.map((r) => r.tokenId)], account: RANDO,
        });
        return { gas, measured: true };
      } catch {
        return { gas: COLLECT_GAS_FALLBACK * BigInt(b.length), measured: false };
      }
    });
    if (part.batch.length) {
      const value = part.batch.reduce((a, r) => a + r.value, 0);
      console.log(`  collect ${part.batch.length} Friends: ${value.toFixed(6)} WETH-eq for ${gasWeth(part.gas).toFixed(8)} WETH gas` +
        ` (${(value / gasWeth(part.gas)).toFixed(0)}x)${part.measured ? "" : ` [gas NOT measured: estimate failed, used ledger's ${COLLECT_GAS_FALLBACK} per Friend]`}`);
      bankTx.push({ what: `collect(${part.batch.length} Friends)`, fn: "collect", args: [part.batch.map((r) => r.collection), part.batch.map((r) => r.tokenId)] });
    }
  }
  if (!live.length) console.log("  nothing collectable this run.");
  const halted = await c.readContract({ address: BANK, abi: BANK_ABI, functionName: "quotingHalted" }).catch(() => null);
  if (halted === false) {
    console.log("  desk is ARMED: poke() the price observer (needs ~5-minute cadence for its TWAP)");
    bankTx.push({ what: "poke()", fn: "poke", args: [] });
  } else {
    console.log(`  desk ${halted === true ? "halted" : "state unreadable"}: no poke needed`);
  }

  /* 3c. the desk ------------------------------------------------------------- */
  console.log("\n-- desk --");
  const rb = (fn) => c.readContract({ address: BANK, abi: BANK_ABI, functionName: fn });
  const [keeperAddr, deskAddr, obsAddr, bookR, bookW, uAsk, uBid, maxRangeBps, maxDailyTurnoverBps, usedBpsRf, usedBpsWeth, usedModifies, usedAt] =
    await Promise.all(["keeper", "DESK", "OBSERVER", "bookR", "bookW", "ask", "bid", "maxRangeBps", "maxDailyTurnoverBps",
      "usedBpsRf", "usedBpsWeth", "usedModifies", "usedAt"].map(rb));
  const rd = (fn) => c.readContract({ address: deskAddr, abi: DESK_ABI, functionName: fn });
  const [gAsk, gBid, costRf, costWeth, lastSellWethPerRf, lastSellAt, lossSpentWeth, twapEdgeTicks, tickSpacing] =
    await Promise.all(["ask", "bid", "costRf", "costWeth", "lastSellWethPerRf", "lastSellAt", "lossSpentWeth", "twapEdgeTicks", "TICK_SPACING"].map(rd));
  const [spotTick, twapTick, block] = await Promise.all([
    c.readContract({ address: obsAddr, abi: OBS_ABI, functionName: "spotTick" }),
    c.readContract({ address: obsAddr, abi: OBS_ABI, functionName: "twapTick" }).catch(() => null),
    c.getBlock(),
  ]);
  const mk = await marketPath(pool);
  const market = { ...mk.measured, mid: pool.wethPerRf, ethUsd: usd?.usd ?? null };
  if (ASSUME_ARMED) Object.assign(market, { reversals72h: DEFAULT_GATES.minReversals72h, drift72h: 0, walkForward7d: 0.001 });
  const range = (u, g) => ({ open: u[0], openedAt: Number(u[1]), lo: Number(g[0]), hi: Number(g[1]), liquidity: g[2] });
  const desk = planDesk({
    now: Number(block.timestamp), spotTick: Number(spotTick), twapTick: twapTick == null ? null : Number(twapTick),
    tickSpacing: Number(tickSpacing), market,
    bank: {
      halted: halted === true, bookR, bookW, maxRangeBps, maxDailyTurnoverBps, usedBpsRf, usedBpsWeth, usedModifies, usedAt,
      ask: range(uAsk, gAsk), bid: range(uBid, gBid),
    },
    desk: { costRf, costWeth, lastSellWethPerRf, lastSellAt: Number(lastSellAt), lossSpentWeth, twapEdgeTicks: Number(twapEdgeTicks) },
  });
  console.log(`  price path to ${mk.seriesTo} (+${mk.newSwaps} swaps this run); swings counted ${mk.swingSource}`);
  if (ASSUME_ARMED) console.log("  REHEARSAL: --assume-armed set the three market gates as met. Never on a live chain.");
  console.log(`  ${explain(desk.regime)}`);
  for (const g of desk.regime.checks) console.log(`    ${g.status.padEnd(10)} ${g.label.padEnd(20)} ${g.detail}`);
  console.log(`  book ${desk.book.rf.toFixed(2)} RF + ${desk.book.weth.toFixed(6)} WETH = ${desk.book.valueWeth.toFixed(6)} WETH;` +
    ` spot tick ${spotTick}, TWAP ${twapTick ?? "not ready"}`);
  for (const n of desk.notes) console.log(`  . ${n}`);
  deskKeeper = keeperAddr;
  if (/^0x0{40}$/.test(keeperAddr)) {
    console.log("  the Bank has NO keeper: nobody can place ranges (anyone may close them).");
  } else {
    // Every desk call is simulated as the keeper. A run never closes and places the same side.
    for (const a of desk.actions) {
      try {
        await c.simulateContract({ address: BANK, abi: BANK_ABI, functionName: a.fn, args: a.args, account: keeperAddr });
        deskTx.push(a);
        console.log(`  -> ${a.fn}(${a.args.join(", ")}): ${a.why}`);
      } catch (e) {
        console.log(`  x  ${a.fn}(${a.args.join(", ")}) would REVERT as the keeper: ${(e.shortMessage ?? e.message).split("\n")[0]}. Dropped.`);
      }
    }
  }
  if (!desk.actions.length) console.log("  nothing for the desk this run.");
}

/* 4. report ---------------------------------------------------------------- */
console.log(`\n-- plan --`);
for (const a of allocs) console.log(`  allocate(${a.name})`);
for (const cl of claims) console.log(`  claimBatch(${cl.name}, ${cl.batch.length} Friends)`);
for (const t of bankTx) console.log(`  bank.${t.what}`);
for (const t of deskTx) console.log(`  bank.${t.fn}(${t.args.join(", ")})   [keeper only]`);
if (!allocs.length && !claims.length && !bankTx.length && !deskTx.length) console.log("  nothing worth sending this run.");
console.log(`  ETH/USD ${usd ? `${usd.usd} (${usd.source})` : "UNAVAILABLE, USD figures omitted rather than guessed"}`);

if (!EXECUTE) {
  console.log("\ndry run. Nothing sent. `--execute` sends exactly the plan lines above.");
  console.log("Claims and collects are permissionless: rewards go to the Friend's own wallet or its");
  console.log("owner's line in the Bank, never to whoever pays the gas.");
  process.exit(0);
}

/* execute ---------------------------------------------------------------- */
const pk = process.env.HARVESTER_PRIVATE_KEY;
if (!pk) { console.error("\n--execute needs HARVESTER_PRIVATE_KEY in the environment."); process.exit(2); }
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC ?? undefined) });
console.log(`\nkeeper ${account.address} (pays gas only)\n`);

let ok = 0, failed = 0;
const send = async (what, req) => {
  try {
    const hash = await wallet.writeContract(req);
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error("reverted");
    console.log(`  ok   ${what}  ${hash}`); ok++;
  } catch (e) {
    console.log(`  FAIL ${what}  ${(e.shortMessage ?? e.message).split("\n")[0].slice(0, 90)}`); failed++;
  }
};
for (const a of allocs) {
  await send(`allocate(${a.name})`, { address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "allocate", args: [a.asset] });
}
for (const cl of claims) {
  await send(`claimBatch(${cl.name}, ${cl.batch.length})`, {
    address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "claimBatch",
    args: [cl.asset, cl.batch.map((r) => r.collection), cl.batch.map((r) => r.tokenId)],
  });
}
// Order matters: suspensions and settles before collect, so collect neither wastes gas nor skips.
for (const fn of ["suspendIfTransferred", "settle", "collect", "poke"]) {
  for (const t of bankTx.filter((x) => x.fn === fn)) {
    await send(`bank.${t.what}`, { address: BANK, abi: BANK_ABI, functionName: t.fn, args: t.args });
  }
}
// The desk last, closes before placements, and only from the Bank's keeper key.
if (deskTx.length) {
  if (getAddress(deskKeeper) !== account.address) {
    console.log(`  skip desk: ${deskTx.length} call(s) need the Bank's keeper ${deskKeeper}; this key is ${account.address}`);
  } else {
    for (const t of [...deskTx.filter((x) => x.fn.startsWith("close")), ...deskTx.filter((x) => x.fn.startsWith("place"))]) {
      await send(`bank.${t.fn}(${t.args.join(", ")})`, { address: BANK, abi: BANK_ABI, functionName: t.fn, args: t.args });
    }
  }
}
console.log(`\n${ok} confirmed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
