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
    "event FeeCollected(uint256 amount)",
  ]),
  market: parseAbi([
    "function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
    "function buyExactRF(uint256 rfAmount,uint256 maxWethIn,address recipient,uint256 deadline) returns (uint256)",
    "function swapExactInput(bool buy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline) returns (uint256)",
    "function seedComplete() view returns (bool)",
    "function rewards() view returns (address)",
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
    "event Claimed(address indexed asset,address indexed collection,uint256 indexed tokenId,address account,uint256 amount)",
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
  ]),
  tba: parseAbi([
    "function owner() view returns (address)",
    "function token() view returns (uint256,address,uint256)",
    "function state() view returns (uint256)",
    "function execute(address to,uint256 value,bytes data,uint8 operation) payable returns (bytes)",
  ]),
});

export function client(rpcUrl) {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrl ?? CHAIN.rpcUrls.default.http[0]) });
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

/** The public RPC caps getLogs at 10,000 results and 429s if hammered. */
export const LOG_CHUNK = 6000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scanLogs(c, { address, event, fromBlock, toBlock, chunk = LOG_CHUNK, pace = 120, onChunk }) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n;
    let attempt = 0;
    for (;;) {
      try {
        out.push(...(await c.getLogs({ address, event, fromBlock: from, toBlock: to })));
        break;
      } catch (err) {
        if (++attempt >= 4) throw new Error(`getLogs ${from}-${to} failed after ${attempt}: ${err.shortMessage ?? err.message}`);
        await sleep(500 * attempt);
      }
    }
    onChunk?.(to, out.length);
    await sleep(pace);
  }
  return out;
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

export const fmt = {
  eth: (v, d = 6) => (Number(v) / 1e18).toFixed(d),
  n: (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }),
  usd: (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  pct: (v, d = 2) => `${(v * 100).toFixed(d)}%`,
};
