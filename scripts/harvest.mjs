#!/usr/bin/env node
/**
 * The auto-harvester.
 *
 * `ActivationManager.claim` is PERMISSIONLESS and credits the Friend's own
 * token-bound wallet, never the caller. That means the Bank can sweep every
 * member's rewards on a schedule while taking no custody of anything and
 * carrying no risk to the member. It is the one half of this product that is
 * strictly good for a member whether or not the desk ever trades.
 *
 *   node scripts/harvest.mjs --dry-run              # show what it would claim
 *   node scripts/harvest.mjs --wallet 0xABC...      # every Friend owned by a wallet
 *   node scripts/harvest.mjs --execute              # actually send the claims
 *
 * --execute needs HARVESTER_PRIVATE_KEY in the environment. The key pays gas and
 * nothing else: it cannot receive rewards, because the protocol sends them to the
 * NFT's wallet regardless of who calls.
 */
import { createWalletClient, http, parseAbi, getAddress, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, ABI, CHAIN, client, fmt } from "../lib/protocol.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const EXECUTE = has("--execute");
const WALLET = val("--wallet");
/**
 * What a claim costs, measured: ~209k gas at 0.057 gwei = $0.033 a transaction, and
 * a Friend needs one per asset. The threshold is DERIVED from that, not picked.
 *
 * It used to be a flat $0.05 with a comment about not spending $0.03 to claim $0.01,
 * while the script's own model put a Friend's gas at $0.066. So it cleared Friends
 * holding $0.06 and lost money on them. Same error the derive script caught in
 * minFillUsd: a threshold that does not know its own costs. Two times cost, so a
 * claim is worth making rather than merely break-even.
 */
const GAS_USD_PER_TX = 0.033;
const TXS_PER_FRIEND = 2;
const GAS_USD_PER_FRIEND = GAS_USD_PER_TX * TXS_PER_FRIEND;
const MIN_USD = Number(val("--min-usd") ?? GAS_USD_PER_FRIEND * 2);

const c = client();

/* --------------------------------------------------- discover a wallet's Friends */
/**
 * Read owned Friends from Transfer logs filtered on the account, the same way the
 * SDK does. Never scan the collection or enumerate token IDs.
 */
async function friendsOf(wallet) {
  const owner = getAddress(wallet);
  // rarefriends.com's own state endpoint does this discovery correctly and cheaply,
  // and returns BOTH collections in a single call. Use it for discovery only; every
  // VALUE below is read from chain.
  const r = await fetch(`https://rarefriends.com/api/protocol/state?address=${owner.toLowerCase()}`);
  if (!r.ok) throw new Error(`discovery failed: HTTP ${r.status}`);
  const j = await r.json();
  const byName = { Genesis: ADDR.Genesis, Generations: ADDR.Generations };
  const out = [];
  for (const f of j.account?.friends ?? []) {
    const collection = byName[f.collection];
    if (!collection) continue;
    if (!f.activated || !f.hardwired) continue;   // nothing to claim otherwise
    out.push({ collection, collectionName: f.collection, tokenId: BigInt(f.id) });
  }
  return out;
}

/* ------------------------------------------------------------------ main */
const targets = WALLET ? await friendsOf(WALLET) : [];
if (targets.length === 0) {
  console.error("nothing to harvest. Pass --wallet <address>.");
  process.exit(1);
}

const pool = await (await import("../lib/protocol.mjs")).readPool(c);
const ETH_USD = 2734.86;
const rfUsd = pool.wethPerRf * ETH_USD;

console.log(`Bank of Friends :: auto-harvest`);
console.log(`chain ${CHAIN.id}   |   ${targets.length} activated Friends   |   mode ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

let totalRf = 0n, totalWeth = 0n;
const plan = [];
for (const t of targets) {
  const [rf, weth] = await Promise.all([
    c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [ADDR.RF, t.collection, t.tokenId] }),
    c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [ADDR.WETH, t.collection, t.tokenId] }),
  ]);
  const usd = (Number(rf) / 1e18) * rfUsd + (Number(weth) / 1e18) * ETH_USD;
  totalRf += rf; totalWeth += weth;
  plan.push({ ...t, rf, weth, usd });
  console.log(
    `  ${(t.collectionName + " #" + t.tokenId).padEnd(24)}` +
    `${fmt.eth(rf, 4).padStart(12)} RF ` +
    `${fmt.eth(weth, 8).padStart(14)} WETH ` +
    `= $${usd.toFixed(2).padStart(8)}` +
    (usd < MIN_USD ? "   (below threshold, skipping)" : "")
  );
}

const worth = plan.filter((p) => p.usd >= MIN_USD);
const totalUsd = (Number(totalRf) / 1e18) * rfUsd + (Number(totalWeth) / 1e18) * ETH_USD;
console.log(`\n  claimable total: ${fmt.eth(totalRf, 4)} RF + ${fmt.eth(totalWeth, 8)} WETH = $${totalUsd.toFixed(2)}`);
console.log(`  worth claiming:  ${worth.length} of ${plan.length} Friends (threshold $${MIN_USD.toFixed(3)} = 2x the $${GAS_USD_PER_FRIEND.toFixed(3)} a Friend costs to claim)`);

// One claim per asset, so two transactions a Friend.
const txCount = worth.length * TXS_PER_FRIEND;
const gasUsd = txCount * GAS_USD_PER_TX;
const worthUsd = worth.reduce((a, p) => a + p.usd, 0);
console.log(`  estimated gas:   ${txCount} txs x ~$${GAS_USD_PER_TX} = $${gasUsd.toFixed(2)}`);
// Compare gas against what is actually being claimed. Comparing it against the
// whole plan let one large Friend hide a batch of losing ones behind it.
if (gasUsd >= worthUsd) {
  console.log(`\n  WARNING: gas ($${gasUsd.toFixed(2)}) costs more than the $${worthUsd.toFixed(2)} being claimed. Not economic right now.`);
}

if (!EXECUTE) {
  console.log(`\ndry run. Nothing sent. Re-run with --execute to claim.`);
  console.log(`Every claim credits the FRIEND's own wallet, not the caller's, so running this`);
  console.log(`for someone else is a gift of gas, never a way to take their rewards.`);
  process.exit(0);
}

const pk = process.env.HARVESTER_PRIVATE_KEY;
if (!pk) { console.error("\n--execute needs HARVESTER_PRIVATE_KEY in the environment."); process.exit(2); }
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http() });
console.log(`\nharvester ${account.address} (pays gas only)\n`);

let ok = 0, failed = 0;
for (const p of worth) {
  for (const [asset, label, amount] of [[ADDR.RF, "RF", p.rf], [ADDR.WETH, "WETH", p.weth]]) {
    if (amount === 0n) continue;
    try {
      const hash = await wallet.writeContract({
        address: ADDR.ActivationManager, abi: ABI.activationManager,
        functionName: "claim", args: [asset, p.collection, p.tokenId],
      });
      const rc = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error("reverted");
      console.log(`  ok   ${p.collectionName} #${p.tokenId} ${label}  ${hash}`);
      ok++;
    } catch (e) {
      console.log(`  FAIL ${p.collectionName} #${p.tokenId} ${label}  ${(e.shortMessage ?? e.message).split("\n")[0].slice(0, 90)}`);
      failed++;
    }
  }
}
console.log(`\n${ok} claims confirmed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
