#!/usr/bin/env node
/**
 * A LOCAL-FORK rehearsal of the keeper's desk. Broadcasts nothing to Robinhood Chain.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547      (another terminal)
 *   node scripts/rehearse-desk.mjs setup      deploy FriendBankV2 on the fork, enrol real earning
 *                                             Friends the way a holder would, build a TWAP
 *   node scripts/keeper.mjs --bank <addr> --rpc http://127.0.0.1:8547 [--assume-armed] [--execute]
 *   node scripts/rehearse-desk.mjs push up|down <weth>    an outside trader moves the real pool
 *   node scripts/rehearse-desk.mjs wait <minutes>         warp the fork, poking every 5 minutes
 *
 * Holders are impersonated ONLY on the local fork, exactly as contracts/test/ForkDesk.t.sol
 * does, and never Hunt's wallet or Friend #259 (Hunt ruling). The keeper key is anvil's
 * well-known account 1; the owner is account 0.
 */
import fs from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, encodeFunctionData, getAddress, maxUint256, maxUint128 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN, ABI } from "../lib/protocol.mjs";

const RPC = "http://127.0.0.1:8547";
const STATE = new URL("../data/rehearsal.json", import.meta.url);
const HUNT = getAddress("0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF");
// anvil's published development keys, which exist only on a local node
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KEEPER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9c86dae88a7aff9d4efb2b3b1c2e3f");
const TRADER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const chain = { ...CHAIN, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });
const art = (p) => JSON.parse(fs.readFileSync(new URL(`../contracts/out/${p}`, import.meta.url), "utf8"));

const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function deposit() payable"]);
const NFT = parseAbi(["function ownerOf(uint256) view returns (address)", "function tokenBoundAccount(uint256) view returns (address)"]);
const TBA = parseAbi(["function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)"]);
const BANK = parseAbi([
  "function join(address collection, uint256 tokenId, uint128 capRfPerDay, uint128 capWethPerDay, bool sweep)",
  "function collect(address[] collections, uint256[] tokenIds)",
  "function bookR() view returns (uint256)", "function bookW() view returns (uint256)", "function poke()",
]);
const PUSHER = parseAbi(["function push(bool rfForWeth, uint256 amountIn, int24 limitTick)"]);

async function send(account, req) {
  const hash = await wallet(account).writeContract({ ...req, chain });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${req.functionName} reverted`);
  return rc;
}
async function as(addr, fn) {
  await test.setBalance({ address: addr, value: 10n ** 18n });
  await test.impersonateAccount({ address: addr });
  try { return await fn({ address: addr, type: "json-rpc" }); } finally { await test.stopImpersonatingAccount({ address: addr }); }
}
async function pokeFor(bank, minutes) {
  for (let m = 0; m < minutes; m += 5) {
    await test.increaseTime({ seconds: 300 });
    await test.mine({ blocks: 1 });
    await send(OWNER, { address: bank, abi: BANK, functionName: "poke" });
  }
}

const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === "setup") {
  const fb = art("FriendBank.sol/FriendBank.json");
  const deployHash = await wallet(OWNER).deployContract({
    abi: fb.abi, bytecode: fb.bytecode.object, chain,
    args: [{ rf: ADDR.RF, weth: ADDR.WETH, activation: ADDR.ActivationManager, genesis: ADDR.Genesis, generations: ADDR.Generations,
      poolManager: ADDR.PoolManager, hook: ADDR.Hook, poolFee: 0x800000, tickSpacing: 60, keeper: KEEPER.address }],
  });
  const bank = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
  await test.setBalance({ address: KEEPER.address, value: 10n ** 18n });   // gas money, on the fork only
  console.log(`FriendBankV2 on the fork: ${bank}   owner ${OWNER.address}   keeper ${KEEPER.address}`);

  // The richest earning Genesis among the first 120, never Hunt's and never #259.
  const found = [];
  for (let i = 1n; i <= 120n; i++) {
    if (i === 259n) continue;
    try {
      const owner = getAddress(await pub.readContract({ address: ADDR.Genesis, abi: NFT, functionName: "ownerOf", args: [i] }));
      if (owner === HUNT) continue;
      const [er, ew] = await Promise.all([ADDR.RF, ADDR.WETH].map((t) =>
        pub.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [t, ADDR.Genesis, i] })));
      found.push({ id: i, owner, er, ew });
    } catch { /* not minted, or not earning */ }
  }
  const pick = found.sort((x, y) => (y.ew > x.ew ? 1 : -1)).slice(0, 8);
  for (const f of pick) {
    const tba = await pub.readContract({ address: ADDR.Genesis, abi: NFT, functionName: "tokenBoundAccount", args: [f.id] });
    await as(f.owner, async (acct) => {
      for (const t of [ADDR.RF, ADDR.WETH]) {
        await send(acct, { address: tba, abi: TBA, functionName: "execute", args: [t, 0n, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [bank, maxUint256] }), 0] });
      }
      await send(acct, { address: bank, abi: BANK, functionName: "join", args: [ADDR.Genesis, f.id, maxUint128, maxUint128, false] });
    });
    console.log(`  enrolled Genesis #${f.id} (earning ${(Number(f.er) / 1e18).toFixed(0)} RF + ${(Number(f.ew) / 1e18).toFixed(5)} WETH)`);
  }
  await send(OWNER, { address: bank, abi: BANK, functionName: "collect", args: [pick.map(() => ADDR.Genesis), pick.map((f) => f.id)] });
  const [r, w] = await Promise.all(["bookR", "bookW"].map((fn) => pub.readContract({ address: bank, abi: BANK, functionName: fn })));
  console.log(`  collected: book ${(Number(r) / 1e18).toFixed(0)} RF + ${(Number(w) / 1e18).toFixed(5)} WETH`);

  const pz = art("ForkDesk.t.sol/Pusher.json");
  const ph = await wallet(OWNER).deployContract({ abi: pz.abi, bytecode: pz.bytecode.object, chain,
    args: [ADDR.PoolManager, { currency0: ADDR.RF, currency1: ADDR.WETH, fee: 0x800000, tickSpacing: 60, hooks: ADDR.Hook }] });
  const pusher = (await pub.waitForTransactionReceipt({ hash: ph })).contractAddress;
  await pokeFor(bank, 70);
  fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ bank, pusher }));
  console.log(`  TWAP built (70 minutes of 5-minute pokes). Pusher ${pusher}.`);
  console.log(`\nnext: node scripts/keeper.mjs --bank ${bank} --rpc ${RPC} --assume-armed`);
} else if (cmd === "push") {
  const { pusher } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const up = a1 === "up";
  const amt = BigInt(Math.round(Number(a2 ?? "1") * 1e18));
  if (up) {
    // an outside buyer: WETH in, RF out, pushes the price UP through asks
    await test.setBalance({ address: TRADER.address, value: amt + 10n ** 18n });
    await send(TRADER, { address: ADDR.WETH, abi: ERC20, functionName: "deposit", value: amt });
    await send(TRADER, { address: ADDR.WETH, abi: ERC20, functionName: "transfer", args: [pusher, amt] });
    await send(TRADER, { address: pusher, abi: PUSHER, functionName: "push", args: [false, amt, 887_000] });
  } else {
    throw new Error("push down needs RF for the pusher; the rehearsal covers it with the keeper's stand-down path instead");
  }
  console.log(`pushed ${a1} with ${a2 ?? 1} WETH`);
} else if (cmd === "wait") {
  const { bank } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  await pokeFor(bank, Number(a1 ?? 60));
  console.log(`warped ${a1 ?? 60} minutes, poking every 5`);
} else {
  console.error("usage: rehearse-desk.mjs setup | push up <weth> | wait <minutes>");
  process.exit(1);
}
