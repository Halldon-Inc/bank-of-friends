/**
 * Rare Friends protocol reader, chain-first.
 *
 * Everything here is read from Robinhood Chain (4663) directly. rarefriends.com's
 * API is convenience only and is deliberately NOT a dependency of any assertion:
 * it is unversioned, it renamed every route on 2026-09-19, and it changed a reward
 * formula on 2026-09-20. Chain state is the source of truth.
 */

import {
  createPublicClient, http, defineChain, parseAbi,
  keccak256, encodeAbiParameters, parseAbiParameters, encodePacked, getAddress,
} from "viem";

export const CHAIN = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

/** Pinned 2026-09-21. Cross-checked against rarefriends.com/api/protocol/config by verifyAddresses(). */
export const ADDR = Object.freeze({
  RF: getAddress("0x0779369854d3EcdEA927206718FFD7730C67B71f"),
  WETH: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  Genesis: getAddress("0x116EaA62241751E0c98dA43d458600c6C17cD361"),
  Generations: getAddress("0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D"),
  ActivationManager: getAddress("0xD4A35e11318E3679168d409184B788bcF9F283Ac"),
  Market: getAddress("0x99930E551b6f849bAabC4B491053eF28a700C4F2"),
  Hook: getAddress("0x7A65d0194e6Cc43971C31CE7D1471Da01D42A0cC"),
  PoolManager: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
  Reserve: getAddress("0xA850B2499c064900EfF341745807e1cB0d71a52b"),
  ERC6551Registry: getAddress("0x000000006551c19487814612e58FE06813775758"),
});

/** The one pool. Hook.poolId() is asserted against this by the verifier. */
export const POOL_ID = "0x9116440ebd86be5f0b850524a0d52a97399c68027d3590fa3526e1039dda2240";

/** Uniswap v4: PoolManager._pools is state variable index 6. */
const POOLS_SLOT = 6n;
/** Pool.State: slot0 @0, feeGrowthGlobal0 @1, feeGrowthGlobal1 @2, liquidity @3, ticks @4, tickBitmap @5, positions @6. */
const OFF_LIQUIDITY = 3n;
const OFF_POSITIONS = 6n;
/** The block the Market seeded the pool (its ModifyLiquidity log). Nothing trades before it. */
export const POOL_SEED_BLOCK = 64590343n;
/** Market.seed() uses the full range at tickSpacing 60. */
export const FULL_RANGE = Object.freeze({ tickLower: -887220, tickUpper: 887220 });
/** LPFeeLibrary.DYNAMIC_FEE_FLAG */
export const DYNAMIC_FEE_FLAG = 0x800000;

export const ABI = Object.freeze({
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function transferFrom(address,address,uint256) returns (bool)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]),
  extsload: parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]),
  hook: parseAbi([
    "function FEE_BPS() view returns (uint256)",
    "function FLAGS() view returns (uint160)",
    "function poolId() view returns (bytes32)",
    "function rewards() view returns (address)",
    "function market() view returns (address)",
    "function wethIsCurrency0() view returns (bool)",
    "function owner() view returns (address)",
    "event FeeCollected(uint256 amount)",
    "event RewardsUpdated(address indexed previousRewards,address indexed rewards)",
  ]),
  market: parseAbi([
    "function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
    "function buyExactRF(uint256 rfAmount,uint256 maxWethIn,address recipient,uint256 deadline) returns (uint256)",
    "function swapExactInput(bool buy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline) returns (uint256)",
    "function seedComplete() view returns (bool)",
    "function rewards() view returns (address)",
    "function owner() view returns (address)",
    "event Swapped(address indexed sender,address indexed recipient,bool buy,uint256 amountIn,uint256 amountOut)",
  ]),
  activationManager: parseAbi([
    "function earned(address asset,address collection,uint256 tokenId) view returns (uint256)",
    "function claim(address asset,address collection,uint256 tokenId) returns (uint256)",
    "function claimBatch(address asset,address[] collections,uint256[] tokenIds) returns (uint256)",
    "function positions(address collection,uint256 tokenId) view returns (uint8,uint256)",
    "function totalWeight() view returns (uint256)",
    "function streams(address asset) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
    "function MAX_CLAIM_BATCH() view returns (uint256)",
    "function DURATION() view returns (uint256)",
    "function retired() view returns (bool)",
    "function allocate(address asset)",
    "function owner() view returns (address)",
    "event Claimed(address indexed asset,address indexed collection,uint256 indexed tokenId,address account,uint256 amount)",
    "event Allocated(address indexed asset,uint256 amount,uint256 finish)",
    "event Funded(address indexed asset,address indexed payer,uint256 amount)",
    "event RetiredForMigration(uint256 timestamp)",
    "event RewardsMigrated(address indexed asset,address indexed recipient,uint256 amount)",
  ]),
  reserve: parseAbi([
    "function RF_PER_GENESIS() view returns (uint256)",
    "function DEPOSIT_FEE() view returns (uint256)",
    "function FIFO_FEE() view returns (uint256)",
    "function EXACT_FEE() view returns (uint256)",
    "function inventoryCount() view returns (uint256)",
    "function conversionEnabled() view returns (bool)",
    "function retired() view returns (bool)",
    "function owner() view returns (address)",
  ]),
  ownable: parseAbi(["function owner() view returns (address)"]),
  /** FriendBank (contracts/src/FriendBank.sol). Amounts in wei; friends_ and holders_ are counts. */
  bank: parseAbi([
    "function bankTotals() view returns (uint256 rfIdle, uint256 wethIdle, uint256 rfInAsk, uint256 wethInBid, uint256 friends_, uint256 holders_)",
    // Leave every listed Friend the caller enrolled and still holds, exit its share of any
    // open range, send all idle RF and WETH to `to`. Events: Left, then RangeExited, Withdrawn.
    "function close(address[] collections, uint256[] tokenIds, address to)",
  ]),
  generations: parseAbi([
    "function tokenBoundAccount(uint256 tokenId) view returns (address)",
    "function generation(uint256 tokenId) view returns (uint8)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function totalMinted() view returns (uint256)",
    "function locked(uint256 tokenId) view returns (bool)",
    "function ACCOUNT_REGISTRY() view returns (address)",
    "function accountImplementation() view returns (address)",
  ]),
  genesis: parseAbi([
    "function tokenBoundAccount(uint256 tokenId) view returns (address)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function accountImplementation() view returns (address)",
  ]),
  poolManager: parseAbi([
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ]),
  tba: parseAbi([
    "function owner() view returns (address)",
    "function token() view returns (uint256,address,uint256)",
    "function state() view returns (uint256)",
    "function execute(address to,uint256 value,bytes data,uint8 operation) payable returns (bytes)",
  ]),
});

/**
 * The public RPC answers "Rate Limit Hit, limit will reset in 60 seconds" when
 * pushed, so back off long enough to outlast that window (1.5 s doubling, six
 * tries, about 95 s in all) instead of viem's default 150 ms that gives up in 1 s.
 */
export function client(rpcUrl) {
  return createPublicClient({
    chain: CHAIN,
    transport: http(rpcUrl ?? CHAIN.rpcUrls.default.http[0], { retryCount: 6, retryDelay: 1500 }),
  });
}

/* ------------------------------------------------------------------ pool state */

function poolBaseSlot(poolId = POOL_ID) {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [poolId, POOLS_SLOT]));
}
const addSlot = (base, off) => `0x${((BigInt(base) + off) & ((1n << 256n) - 1n)).toString(16).padStart(64, "0")}`;

/**
 * Decode v4 Slot0: sqrtPriceX96[0..159] | tick[160..183] | protocolFee[184..207] | lpFee[208..231].
 * lpFee is the number that matters here: it is what liquidity providers actually earn.
 */
export function decodeSlot0(word) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24;
  return {
    sqrtPriceX96,
    tick,
    protocolFee: Number((v >> 184n) & ((1n << 24n) - 1n)),
    lpFee: Number((v >> 208n) & ((1n << 24n) - 1n)),
  };
}

export async function readPool(c, poolId = POOL_ID) {
  const base = poolBaseSlot(poolId);
  const [s0, liq] = await Promise.all([
    c.readContract({ address: ADDR.PoolManager, abi: ABI.extsload, functionName: "extsload", args: [base] }),
    c.readContract({ address: ADDR.PoolManager, abi: ABI.extsload, functionName: "extsload", args: [addSlot(base, OFF_LIQUIDITY)] }),
  ]);
  const slot0 = decodeSlot0(s0);
  const liquidity = BigInt(liq);
  const p = Number(slot0.sqrtPriceX96) / 2 ** 96;
  // currency0 = RF, currency1 = WETH, so price = WETH per RF.
  const wethPerRf = p * p;
  // Full-range virtual reserves at the current price.
  const L = Number(liquidity);
  return {
    ...slot0,
    liquidity,
    wethPerRf,
    virtualRf: L / p / 1e18,
    virtualWeth: (L * p) / 1e18,
  };
}

/** Liquidity credited to one (owner, tickLower, tickUpper, salt) position. */
export async function readPosition(c, owner, tickLower = FULL_RANGE.tickLower, tickUpper = FULL_RANGE.tickUpper, salt = `0x${"0".repeat(64)}`, poolId = POOL_ID) {
  const posKey = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [getAddress(owner), tickLower, tickUpper, salt]));
  const mapSlot = addSlot(poolBaseSlot(poolId), OFF_POSITIONS);
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [posKey, mapSlot]));
  const w = await c.readContract({ address: ADDR.PoolManager, abi: ABI.extsload, functionName: "extsload", args: [slot] });
  return BigInt(w);
}

/* ------------------------------------------------------- logs, chunked and polite */

/**
 * The public RPC caps getLogs at 10,000 results and 429s if hammered. 20k-block
 * chunks measured ~10x faster per block than 200k (quant, 2026-09-22: 24h in
 * 0.6 s), and a sparse filter rarely nears the result cap at that size.
 */
export const LOG_CHUNK = 20000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chunked getLogs with three hard-won details:
 *  - `args` is passed through. The PoolManager `Swap` filter FAILS outright unless
 *    the indexed poolId is supplied ("Missing or invalid parameters"), at any span.
 *  - the chunk ADAPTS. This RPC accepts 100k blocks for a sparse filter but fails
 *    around 50k for a busy one, so a single hardcoded size is always wrong somewhere.
 *    On failure we halve and retry rather than pretending to know the limit.
 *  - chunks run `concurrency` at a time, because a day here is ~857k blocks.
 *
 * @param {any} c
 * @param {{ address: any, event: any, args?: any, fromBlock: bigint, toBlock: bigint,
 *           chunk?: bigint, minChunk?: bigint, pace?: number, concurrency?: number,
 *           onChunk?: ((to: bigint, count: number) => void) }} opts
 * @returns {Promise<any[]>}
 */
export async function scanLogs(c, {
  address, event, args = undefined, fromBlock, toBlock,
  chunk = LOG_CHUNK, minChunk = 1000n, pace = 120, concurrency = 1, onChunk = undefined,
}) {
  const ranges = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    ranges.push([from, from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n]);
  }

  async function fetchRange(from, to, size, limited = 0) {
    try {
      const q = { address, event, fromBlock: from, toBlock: to };
      if (args) q.args = args;
      return await c.getLogs(q);
    } catch (err) {
      // A rate limit says nothing about the range. Halving on it turned every 429
      // into two more calls, recursively, and a 2 s scan into a multi-minute hang
      // (quant, 2026-09-22). Wait out the window and retry the SAME range.
      if (isRateLimited(err)) {
        if (limited >= 4) throw new Error(`getLogs ${from}-${to}: still rate-limited after ${limited} waits`);
        await sleep(20000 * (limited + 1));
        return fetchRange(from, to, size, limited + 1);
      }
      const span = to - from + 1n;
      if (span <= minChunk) {
        throw new Error(`getLogs ${from}-${to} failed at minimum chunk: ${err.shortMessage ?? err.message}`);
      }
      const half = span / 2n;
      const a = await fetchRange(from, from + half - 1n, half);
      const b = await fetchRange(from + half, to, half);
      return [...a, ...b];
    }
  }

  const out = [];
  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(([f, t]) => fetchRange(f, t, chunk)));
    for (const g of got) out.push(...g);
    onChunk?.(batch[batch.length - 1][1], out.length);
    if (pace) await sleep(pace);
  }
  return out;
}

/** "Rate Limit Hit" (JSON-RPC 429) or HTTP 429 "Too Many Requests", anywhere in the error chain. */
export function isRateLimited(err) {
  for (let e = err; e; e = e.cause) {
    if (e.status === 429 || e.code === 429) return true;
    if (/Too Many Requests|Rate Limit Hit/i.test(`${e.details ?? ""} ${e.shortMessage ?? ""}`)) return true;
  }
  return false;
}

/** Measured, not assumed: this chain does not run 2-second blocks. */
export async function secondsPerBlock(c, span = 100000n) {
  const head = await c.getBlockNumber();
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head - span }), c.getBlock({ blockNumber: head })]);
  return { head, secondsPerBlock: Number(b.timestamp - a.timestamp) / Number(span), headTimestamp: Number(b.timestamp) };
}

export async function blocksPerDay(c) {
  const { head, secondsPerBlock: spb, headTimestamp } = await secondsPerBlock(c);
  return { head, secondsPerBlock: spb, headTimestamp, perDay: BigInt(Math.round(86400 / spb)) };
}

/* ----------------------------------------------------------------- Friend wallets */

export const COLLECTIONS = Object.freeze({
  [ADDR.Genesis.toLowerCase()]: "Genesis",
  [ADDR.Generations.toLowerCase()]: "Generations",
});

/** Idle, unclaimed rewards for one Friend, plus what already sits in its token-bound wallet. */
export async function readFriendIdle(c, collection, tokenId) {
  const coll = getAddress(collection);
  const isGenesis = coll === ADDR.Genesis;
  const abi = isGenesis ? ABI.genesis : ABI.generations;
  const [tba, earnedRf, earnedWeth] = await Promise.all([
    c.readContract({ address: coll, abi, functionName: "tokenBoundAccount", args: [BigInt(tokenId)] }),
    c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [ADDR.RF, coll, BigInt(tokenId)] }),
    c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "earned", args: [ADDR.WETH, coll, BigInt(tokenId)] }),
  ]);
  const [walletRf, walletWeth] = await Promise.all([
    c.readContract({ address: ADDR.RF, abi: ABI.erc20, functionName: "balanceOf", args: [tba] }),
    c.readContract({ address: ADDR.WETH, abi: ABI.erc20, functionName: "balanceOf", args: [tba] }),
  ]);
  return {
    collection: COLLECTIONS[coll.toLowerCase()] ?? coll,
    tokenId: BigInt(tokenId),
    tba,
    earnedRf, earnedWeth,       // claimable from ActivationManager
    walletRf, walletWeth,       // already claimed, sitting in the Friend's own wallet
    totalRf: earnedRf + walletRf,
    totalWeth: earnedWeth + walletWeth,
  };
}

/* ------------------------------------------------------------- reward streams */

/**
 * Rewards arrive a WEEK LATE, and only if somebody asks. Verified on a fork:
 * `fund()` only adds to `streams(asset).pending`; `allocate(asset)` is permissionless
 * but reverts `StreamUnavailable` until the running stream's `finish` has passed,
 * then streams ALL of `pending` over `DURATION` (604,800 s). If nobody calls it,
 * every Friend's rewards simply stop. So the keeper calls it.
 *
 * `perWeek` is what the running stream pays; `nextPerWeek` is what the next one
 * will pay if allocated now (the whole pending balance over one DURATION).
 */
export async function readStreams(c) {
  const am = (fn, args = []) => c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: fn, args });
  const [block, duration, rf, weth] = await Promise.all([
    c.getBlock(), am("DURATION"), am("streams", [ADDR.RF]), am("streams", [ADDR.WETH]),
  ]);
  const now = block.timestamp;
  const one = ([pending, rate, finish, lastUpdate]) => {
    const running = now < finish;
    return {
      pending, rate, finish, lastUpdate,
      perWeek: rate * duration,
      remaining: running ? rate * (finish - now) : 0n,
      secondsLeft: running ? Number(finish - now) : 0,
      nextPerWeek: pending,
      allocateDue: !running && pending > 0n,
    };
  };
  return { blockNumber: block.number, now: Number(now), duration, RF: one(rf), WETH: one(weth) };
}

/**
 * Where the 5% actually goes. The Hook's owner can repoint `rewards` at ANY
 * contract (verified on a fork), and the ActivationManager's owner can retire it
 * and move every balance out with `migrateRewards`, which also makes every swap
 * revert. Either one ends the product's premise, so read it every run.
 */
export async function readRewardsWiring(c) {
  const [hookRewards, marketRewards, retired] = await Promise.all([
    c.readContract({ address: ADDR.Hook, abi: ABI.hook, functionName: "rewards" }),
    c.readContract({ address: ADDR.Market, abi: ABI.market, functionName: "rewards" }),
    c.readContract({ address: ADDR.ActivationManager, abi: ABI.activationManager, functionName: "retired" }),
  ]);
  const isAm = (a) => getAddress(a) === ADDR.ActivationManager;
  return { hookRewards, marketRewards, retired, ok: isAm(hookRewards) && isAm(marketRewards) && !retired };
}

/**
 * Rewards Friends have EARNED but not claimed, protocol-wide, per asset, in three reads:
 *
 *     idle = ActivationManager balance - pending (not yet streamed) - remaining (this stream, not yet dripped)
 *
 * Everything the ActivationManager holds is one of those three, so this is the owed
 * pool without touching 12,000 positions. Measured 2026-09-22 (block 69889198) against
 * a multicall sum of earned() over all 1,024 Genesis plus every ACTIVE Generations:
 * the identity was 0.43% (RF) and 0.44% (WETH) higher. That gap is what the sum could
 * not see: earnings frozen on Friends whose activation a transfer cleared (they stay
 * claimable, but those ids were not in the list), plus per-weight rounding dust. So
 * read it as exact accounting and a slight UPPER bound on what current Friends can claim.
 * A direct token donation (a transfer without fund()) would also land here.
 */
export async function readProtocolIdle(c) {
  const [st, rf, weth] = await Promise.all([
    readStreams(c),
    c.readContract({ address: ADDR.RF, abi: ABI.erc20, functionName: "balanceOf", args: [ADDR.ActivationManager] }),
    c.readContract({ address: ADDR.WETH, abi: ABI.erc20, functionName: "balanceOf", args: [ADDR.ActivationManager] }),
  ]);
  const idle = (bal, s) => (bal > s.pending + s.remaining ? bal - s.pending - s.remaining : 0n);
  return {
    blockNumber: st.blockNumber,
    asOf: new Date(st.now * 1000).toISOString(),
    RF: idle(rf, st.RF),
    WETH: idle(weth, st.WETH),
    balances: { RF: rf, WETH: weth },
    streams: st,
  };
}

/**
 * The Bank's own pooled totals, from FriendBank.bankTotals(), in ONE call. Null
 * when no Bank address is configured, so a page can show "not deployed" rather
 * than a zero. Amounts are wei (bigint). Per ledger: `rfInAsk` / `wethInBid` are
 * units DEPOSITED into the open ranges, not their live mix (a part-filled ask
 * holds some WETH), so "the vault holds" = idle + in-range per asset.
 */
export async function readBankTotals(c, bankAddress) {
  if (!bankAddress) return null;
  const [rfIdle, wethIdle, rfInAsk, wethInBid, friends, holders] = await c.readContract({
    address: getAddress(bankAddress), abi: ABI.bank, functionName: "bankTotals",
  });
  return {
    rfIdle, wethIdle, rfInAsk, wethInBid,
    activeFriends: Number(friends), holders: Number(holders),
    vaultRf: rfIdle + rfInAsk, vaultWeth: wethIdle + wethInBid,
  };
}

/** Every protocol contract that has an owner, and who it is. One key owns them all today. */
export const OWNED = Object.freeze(["Hook", "Market", "ActivationManager", "Reserve", "Genesis", "Generations"]);

export async function readOwners(c) {
  const owners = await Promise.all(OWNED.map((n) =>
    c.readContract({ address: ADDR[n], abi: ABI.ownable, functionName: "owner" })));
  const byContract = Object.fromEntries(OWNED.map((n, i) => [n, getAddress(owners[i])]));
  const distinct = [...new Set(Object.values(byContract))];
  const code = await Promise.all(distinct.map((a) => c.getBytecode({ address: a })));
  return {
    byContract,
    distinct,
    // An owner with no code is a single private key, not a multisig or a timelock.
    isEoa: Object.fromEntries(distinct.map((a, i) => [a, !code[i] || code[i] === "0x"])),
  };
}

/**
 * The Genesis floor inputs: a Genesis can always be turned into RF at the Reserve,
 * RF_PER_GENESIS minus DEPOSIT_FEE (900,000 net, the 100,000 fee funds RF rewards).
 * There is no path the other way.
 */
export async function readReserveFloor(c) {
  const r = (fn) => c.readContract({ address: ADDR.Reserve, abi: ABI.reserve, functionName: fn });
  const [perGenesis, depositFee, fifoFee, exactFee, inventory, enabled, retired] = await Promise.all([
    r("RF_PER_GENESIS"), r("DEPOSIT_FEE"), r("FIFO_FEE"), r("EXACT_FEE"), r("inventoryCount"), r("conversionEnabled"), r("retired"),
  ]);
  return {
    perGenesis, depositFee, fifoFee, exactFee, inventory,
    netRfPerGenesis: perGenesis - depositFee,
    open: enabled && !retired,
  };
}

/* ------------------------------------------------------------- price history */

/**
 * The public RPC keeps only ~5,000 to 10,000 blocks of state (measured
 * 2026-09-22: 5,000 back answered, 10,000 back "historical state ... is not
 * available"), about 15 minutes at 0.1 s a block. So an old price CANNOT be read
 * from slot0 at an old block. Every PoolManager `Swap` log carries the post-swap
 * sqrtPriceX96 instead, so the price at block B is the last swap at or before B.
 * Walks backwards window by window and gives up after `maxWindows`.
 */
export async function priceAt(c, block, { window = 100000n, maxWindows = 30 } = {}) {
  const event = ABI.poolManager.find((x) => x.type === "event" && x.name === "Swap");
  let to = BigInt(block);
  for (let i = 0; i < maxWindows && to >= POOL_SEED_BLOCK; i++) {
    const from = to - window + 1n > POOL_SEED_BLOCK ? to - window + 1n : POOL_SEED_BLOCK;
    const logs = await scanLogs(c, { address: ADDR.PoolManager, event, args: { id: POOL_ID }, fromBlock: from, toBlock: to, chunk: window, pace: 0 });
    if (logs.length) return swapPrice(logs[logs.length - 1]);
    to = from - 1n;
  }
  return null;
}

/** The first swap the pool ever printed, for spans that reach back past launch. */
async function firstSwap(c, { window = 100000n, maxWindows = 30 } = {}) {
  const event = ABI.poolManager.find((x) => x.type === "event" && x.name === "Swap");
  for (let i = 0, from = POOL_SEED_BLOCK; i < maxWindows; i++, from += window) {
    const logs = await scanLogs(c, { address: ADDR.PoolManager, event, args: { id: POOL_ID }, fromBlock: from, toBlock: from + window - 1n, chunk: window, pace: 0 });
    if (logs.length) return swapPrice(logs[0]);
  }
  return null;
}

function swapPrice(log) {
  const p = Number(log.args.sqrtPriceX96) / 2 ** 96;
  return { block: log.blockNumber, tx: log.transactionHash, sqrtPriceX96: log.args.sqrtPriceX96, tick: log.args.tick, wethPerRf: p * p };
}

/**
 * Cheap price drift: the last swap before `days` ago against slot0 now. The pool
 * is younger than a week (seeded 2026-09-16), so a span that reaches past launch
 * is CLAMPED to the first swap and `spanDays` says how long it really covers.
 * Never report a 7-day number over 6 days of data without saying so.
 */
export async function priceDrift(c, days = 7) {
  const [{ head, perDay, secondsPerBlock: spb }, now] = await Promise.all([blocksPerDay(c), readPool(c)]);
  const target = head - perDay * BigInt(days);
  const clamped = target < POOL_SEED_BLOCK;
  const then = clamped ? await firstSwap(c) : await priceAt(c, target);
  if (!then) return null;
  return {
    days, clamped,
    spanDays: (Number(head - then.block) * spb) / 86400,
    then, nowWethPerRf: now.wethPerRf,
    drift: now.wethPerRf / then.wethPerRf - 1,
  };
}

/* ------------------------------------------------------------------ ETH / USD */

/**
 * Live ETH/USD, never a constant. A hardcoded 2734.86 sat in the harvester long
 * after it was true. Returns null if no source answers: callers must then say so,
 * not fall back to a stale number. Thresholds should be priced in WETH anyway;
 * USD is for display.
 */
export async function ethUsd() {
  const sources = [
    ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j?.ethereum?.usd],
    ["rarefriends.com", "https://rarefriends.com/api/protocol/prices", (j) => (j?.usdAvailable && !j?.usdStale ? j.ethUsd : null)],
  ];
  for (const [source, url, pick] of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const usd = Number(pick(await r.json()));
      if (usd > 0) return { usd, source };
    } catch { /* try the next one */ }
  }
  return null;
}

export const fmt = {
  eth: (v, d = 6) => (Number(v) / 1e18).toFixed(d),
  n: (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }),
  usd: (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  pct: (v, d = 2) => `${(v * 100).toFixed(d)}%`,
};
