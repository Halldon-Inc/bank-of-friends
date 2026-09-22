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
 *  4. REPORT. Live ETH/USD for display only. No price in this file is hardcoded.
 */
import fs from "node:fs";
import { createWalletClient, createPublicClient, http, getAddress, isAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDR, ABI, CHAIN, POOL_SEED_BLOCK, client, fmt, scanLogs,
  readPool, readStreams, readRewardsWiring, readOwners, ethUsd,
} from "../lib/protocol.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const EXECUTE = has("--execute");
const MEMBERS = val("--members");
const BANK = val("--bank") ? getAddress(val("--bank")) : null;
const RPC = val("--rpc");
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
}

/* 4. report ---------------------------------------------------------------- */
console.log(`\n-- plan --`);
for (const a of allocs) console.log(`  allocate(${a.name})`);
for (const cl of claims) console.log(`  claimBatch(${cl.name}, ${cl.batch.length} Friends)`);
for (const t of bankTx) console.log(`  bank.${t.what}`);
if (!allocs.length && !claims.length && !bankTx.length) console.log("  nothing worth sending this run.");
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
console.log(`\n${ok} confirmed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
