import { createPublicClient, defineChain, fallback, getAddress, http, parseAbi, type Address, type ContractFunctionParameters } from "viem";

/**
 * rarefriends.com retired `/api/protocol/state` on 2026-09-25 (it answers their HTML 404 page). The hall's showcase
 * Friend, the wallet picker and the docs book all read it. Their portfolio page now assembles the same figures
 * from public pieces, and so does this file (ported from rare-friends-cards' lib/upstream.ts, trimmed):
 *
 *   1. `GET /api/protocol/snapshot` (CDN-cached 60 s): prices, the two protocol weights, the two reward streams.
 *   2. `GET /api/protocol/owned-nfts?address=<wallet>`: which Genesis and Generations tokens the wallet holds.
 *   3. Robinhood Chain reads per Friend: `positions`, `earned` (RF and WETH), the token-bound wallet, `generation`
 *      (Generations only: it reverts on a Genesis) and `tokenURI` for the on-chain portrait.
 *
 * The result has the shape the retired endpoint had (`account.friends[]`, `protocol.prices`), so the three callers
 * changed one line each. Addresses match lib/protocol.mjs; the ABI fragments are the calls their live bundle makes.
 */

const SITE = "https://rarefriends.com";
const SNAPSHOT_API = `${SITE}/api/protocol/snapshot`;
const OWNED_API = `${SITE}/api/protocol/owned-nfts`;
const ARTWORK_API = `${SITE}/api/protocol/nft-image`;
/**
 * The chain's own RPC answers `eth_call` well but 403s a machine after a burst of probing (2026-09-25), so every
 * read has public fallbacks (chainlist, chain 4663; the ones that answered aggregates and `tokenURI` that day).
 */
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const PUBLIC_RPCS = ["https://rpc-robinhood.globalstake.io", "https://robinhood-rpc.publicnode.com", "https://robinhood.rpc.blxrbdn.com"];
const UA = "bank-of-friends/1.0 (+https://bank-of-friends-nu.vercel.app)";

const CHAIN_ID = 4663;
const CONTRACTS = {
  ActivationManager: "0xD4A35e11318E3679168d409184B788bcF9F283Ac",
  RF: "0x0779369854d3EcdEA927206718FFD7730C67B71f",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  Genesis: "0x116EaA62241751E0c98dA43d458600c6C17cD361",
  Generations: "0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D",
  Multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
} as const satisfies Record<string, Address>;

/** Most portraits attached per wallet (earning Friends first) and the most bytes of them; one portrait is at most 64 KB. */
const ART_MAX = 24;
const ART_BYTES = 900_000;
const IMG_MAX = 64 * 1024;
const ART_CONCURRENCY = 6;
const OWNED_MAX = 1500;

const AM_ABI = parseAbi([
  "function positions(address collection, uint256 tokenId) view returns (uint8 tier, uint256 weight)",
  "function earned(address asset, address collection, uint256 tokenId) view returns (uint256)",
]);
const NFT_ABI = parseAbi([
  "function tokenBoundAccount(uint256 tokenId) view returns (address)",
  "function generation(uint256 tokenId) view returns (uint8)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

const robinhood = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: { multicall3: { address: CONTRACTS.Multicall3 } },
});
const envRpc = () => process.env.ROBINHOOD_RPC_URL?.trim();
const reads = createPublicClient({
  chain: robinhood,
  transport: fallback([envRpc(), RPC_URL, ...PUBLIC_RPCS].filter((u): u is string => !!u).map((u) => http(u, { timeout: 8_000, retryCount: 0 })), { retryCount: 0 }),
  batch: { multicall: false },
});

export class UpstreamError extends Error {}
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Collection = "Genesis" | "Generations";
type Owned = { collection: Collection; id: bigint };
type Snapshot = { prices: { ethUsd: number; rfUsd: number }; metrics: { genesisWeight: number; generationsWeight: number }; streams: Raw[] };

const units = (wei: bigint) => Number(wei) / 1e18;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

async function readJson(url: string, timeoutMs: number): Promise<unknown> {
  // NEVER send an Origin header and NEVER add a query key other than `address`: their routes 403 on a mismatched
  // Origin and 400 on any extra key.
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA, accept: "application/json" } });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) throw new UpstreamError(`${url.split("?")[0]} answered ${res.status}`);
  return res.json();
}

/** `/api/protocol/snapshot`: prices, weights, streams. */
export async function readSnapshot(timeoutMs = 6_000): Promise<Snapshot> {
  const j = await readJson(SNAPSHOT_API, timeoutMs);
  if (!isObj(j) || !isObj(j.prices) || !isObj(j.metrics) || !Array.isArray(j.streams)) throw new UpstreamError("snapshot: unexpected shape");
  const { ethUsd, rfUsd } = j.prices;
  const { genesisWeight, generationsWeight } = j.metrics;
  if (!finite(ethUsd) || !finite(rfUsd) || !finite(genesisWeight) || !finite(generationsWeight)) throw new UpstreamError("snapshot: prices or weights missing");
  return { prices: { ethUsd, rfUsd }, metrics: { genesisWeight, generationsWeight }, streams: j.streams.filter(isObj) };
}

/** `/api/protocol/owned-nfts?address=`: `{ nfts: [{ collection, id }] }`, validated the way their client does. */
async function readOwned(address: Address, timeoutMs: number): Promise<Owned[]> {
  const j = await readJson(`${OWNED_API}?address=${address}`, timeoutMs);
  if (!isObj(j) || !Array.isArray(j.nfts) || j.nfts.length > OWNED_MAX) throw new UpstreamError("owned-nfts: unexpected shape");
  return j.nfts.map((n: unknown): Owned => {
    if (!isObj(n) || (n.collection !== "Genesis" && n.collection !== "Generations") || typeof n.id !== "string" || !/^[1-9][0-9]{0,77}$/.test(n.id)) throw new UpstreamError("owned-nfts: unexpected token");
    return { collection: n.collection, id: BigInt(n.id) };
  });
}

type Call = ContractFunctionParameters;
type Result = { status: "success" | "failure"; result?: unknown; error?: unknown };
/** 8 KB of calldata per aggregate: larger batches made the chain RPC reject the whole call. */
async function multicall(calls: Call[], blockNumber: bigint): Promise<Result[]> {
  if (!calls.length) return [];
  return (await reads.multicall({ contracts: calls, blockNumber, batchSize: 8_192, allowFailure: true })) as Result[];
}
function must<T>(r: Result | undefined, what: string): T {
  if (!r || r.status !== "success") {
    const detail = String((r?.error as { shortMessage?: string; message?: string } | undefined)?.shortMessage ?? (r?.error as Error | undefined)?.message ?? "").split("\n")[0].slice(0, 160);
    throw new UpstreamError(`chain read failed: ${what}${detail ? ` (${detail})` : ""}`);
  }
  return r.result as T;
}

type Position = { owned: Owned; tier: number; weight: bigint; earnedRf: bigint; earnedWeth: bigint; wallet: Address | null; generation: number; hardwired: boolean; activated: boolean };

/** Per Friend: `positions`, both `earned`, the token-bound wallet, and `generation`. `earned` reverts for a temporary Friend; their server reports 0 there, so do we. */
async function readPositions(owned: Owned[], blockNumber: bigint): Promise<Position[]> {
  const calls: Call[] = [];
  const slots: number[][] = [];
  for (const n of owned) {
    const collection = CONTRACTS[n.collection];
    slots.push([
      calls.push({ address: CONTRACTS.ActivationManager, abi: AM_ABI, functionName: "positions", args: [collection, n.id] }) - 1,
      calls.push({ address: CONTRACTS.ActivationManager, abi: AM_ABI, functionName: "earned", args: [CONTRACTS.RF, collection, n.id] }) - 1,
      calls.push({ address: CONTRACTS.ActivationManager, abi: AM_ABI, functionName: "earned", args: [CONTRACTS.WETH, collection, n.id] }) - 1,
      calls.push({ address: collection, abi: NFT_ABI, functionName: "tokenBoundAccount", args: [n.id] }) - 1,
      n.collection === "Generations" ? calls.push({ address: collection, abi: NFT_ABI, functionName: "generation", args: [n.id] }) - 1 : -1,
    ]);
  }
  const r = await multicall(calls, blockNumber);
  return owned.map((n, i) => {
    const [pos, eRf, eWeth, tba, gen] = slots[i];
    const tag = `${n.collection} #${n.id}`;
    const [tier, weight] = must<readonly [number, bigint]>(r[pos], `positions ${tag}`);
    const generation = gen >= 0 ? Number(must<number>(r[gen], `generation ${tag}`)) : 0;
    // Their server's rule: a Genesis is always hardwired, a Generations Friend once its generation is set; a Friend
    // is activated only while hardwired with reward weight above zero.
    const hardwired = n.collection === "Genesis" || generation > 0;
    const soft = <T,>(x: Result | undefined, fb: T) => (x?.status === "success" ? (x.result as T) : fb);
    return {
      owned: n, tier: Number(tier), weight,
      earnedRf: hardwired ? must<bigint>(r[eRf], `earned RF ${tag}`) : soft(r[eRf], 0n),
      earnedWeth: hardwired ? must<bigint>(r[eWeth], `earned WETH ${tag}`) : soft(r[eWeth], 0n),
      wallet: hardwired ? getAddress(must<Address>(r[tba], `wallet ${tag}`)) : soft<Address | null>(r[tba], null),
      generation, hardwired, activated: hardwired && weight > 0n,
    };
  });
}

/** The image inside an on-chain `tokenURI` (data: JSON with a data: SVG or PNG image). */
function decodeTokenUri(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  const m = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
  if (!m) return undefined;
  try {
    const text = m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
    const image = (JSON.parse(text) as Raw)?.image;
    return typeof image === "string" && image.length <= IMG_MAX && /^data:image\/(svg\+xml|png)[;,]/i.test(image) ? image : undefined;
  } catch {
    return undefined;
  }
}

/** One Friend's portrait: `tokenURI` on chain, else their `nft-image` route. Undefined means no portrait. */
export async function friendArtwork(collection: Collection, id: bigint | number | string, blockNumber?: bigint): Promise<string | undefined> {
  const tokenId = BigInt(id);
  try {
    const uri = await reads.readContract({ address: CONTRACTS[collection], abi: NFT_ABI, functionName: "tokenURI", args: [tokenId], blockNumber });
    const image = decodeTokenUri(uri);
    if (image) return image;
  } catch {
    // fall through to their route
  }
  try {
    const j = await readJson(`${ARTWORK_API}?id=${tokenId}&collection=${collection}&format=json`, 6_000);
    const image = isObj(j) ? j.image : undefined;
    return typeof image === "string" && image.length <= IMG_MAX && /^data:image\/(svg\+xml|png)[;,]/i.test(image) ? image : undefined;
  } catch {
    return undefined;
  }
}

async function readArtwork(order: Owned[], blockNumber: bigint): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = order.slice(0, ART_MAX);
  let bytes = 0;
  const worker = async () => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      if (bytes > ART_BYTES) return;
      const image = await friendArtwork(n.collection, n.id, blockNumber);
      if (image && bytes + image.length <= ART_BYTES) { bytes += image.length; out.set(`${n.collection}:${n.id}`, image); }
    }
  };
  await Promise.all(Array.from({ length: ART_CONCURRENCY }, worker));
  return out;
}

const safeId = (id: bigint) => (id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : String(id));

/**
 * One wallet's state in the shape the retired `/api/protocol/state` returned: `account.friends[]` with id, collection,
 * generation, tier, activated, hardwired, weight, earnings, earningsWeth, wallet.address and imageUrl, plus
 * `protocol.prices`. Throws on a hard failure; portraits are soft (a missing one is null).
 */
export async function assembleState(address: string, timeoutMs = 15_000, withArt = true): Promise<Raw> {
  const addr = getAddress(address);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`upstream read exceeded ${timeoutMs} ms`), { name: "TimeoutError" })), timeoutMs); });
  const run = async () => {
    const [snapshot, owned, block] = await Promise.all([readSnapshot(6_000), readOwned(addr, 8_000), reads.getBlockNumber({ cacheTime: 0 })]);
    const positions = await readPositions(owned, block);
    const ordered = [...positions.filter((p) => p.activated), ...positions.filter((p) => !p.activated)];
    const art = withArt ? await readArtwork(ordered.map((p) => p.owned), block) : new Map<string, string>();
    const friends = ordered.map((p) => ({
      id: safeId(p.owned.id),
      collection: p.owned.collection,
      generation: p.generation,
      tier: p.activated ? p.tier : 0,
      activated: p.activated,
      hardwired: p.hardwired,
      earnings: units(p.earnedRf),
      earningsWeth: units(p.earnedWeth),
      weight: p.activated ? units(p.weight) : 0,
      wallet: p.hardwired && p.wallet ? { address: p.wallet } : null,
      imageUrl: art.get(`${p.owned.collection}:${p.owned.id}`) ?? null,
    }));
    return { account: { address: addr, friends }, protocol: { prices: snapshot.prices, metrics: snapshot.metrics, streams: snapshot.streams }, blockNumber: String(block), timestamp: Date.now() };
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
