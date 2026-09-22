// Kept byte-identical to ../../lib by scripts/check-lib-sync.mjs
import { ADDR, ABI, client, readPool, readPosition, scanLogs, blocksPerDay, FULL_RANGE, POOL_ID } from "@/lib/protocol.mjs";
import { DEFAULT_GATES, evaluateRegime, realisedVol, drift } from "@/lib/strategy.mjs";



export type Gate = { gate: string; ok: boolean; detail: string };
export type Friend = {
  id: string; collection: string; generation: number; tier: number;
  activated: boolean; hardwired: boolean; weight: number;
  earnings: number; earningsWeth: number; image: string | null; wallet: string | null;
};
export type Desk = {
  asOf: string; block: string; armed: boolean;
  gates: Gate[];
  thresholds: Record<string, number>;
  market: { mid: number; rfUsd: number; ethUsd: number; volume24hWeth: number; trades24h: number; drift24h: number; drift1h: number; hourlyVol: number };
  pool: { lpFee: number; liquidity: string; thirdPartyLiquidity: string; marketOwnsAll: boolean; virtualRf: number; virtualWeth: number; tick: number };
  book: { rf: number; weth: number; usd: number };
  friends: Friend[];
  sparkline: number[];
};

const ETH_USD_FALLBACK = 2734.86;
const FOUNDER = "0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF";

/** Short-lived cache so a viral moment cannot hammer the public RPC. */
let cache: { at: number; data: Desk } | null = null;
const TTL = 30_000;

async function ethUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: AbortSignal.timeout(6000), next: { revalidate: 300 },
    });
    if (r.ok) {
      const j = await r.json();
      const v = j?.ethereum?.usd;
      if (typeof v === "number" && v > 0) return v;
    }
  } catch { /* fall through */ }
  return ETH_USD_FALLBACK;
}

/** Discovery only. Every value below is read from chain. */
async function founderFriends() {
  try {
    const r = await fetch(`https://rarefriends.com/api/protocol/state?address=${FOUNDER.toLowerCase()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.account?.friends ?? []).map((f: any) => ({
      id: String(f.id),
      collection: f.collection as string,
      generation: Number(f.generation ?? 0),
      tier: Number(f.tier ?? 0),
      activated: !!f.activated,
      hardwired: !!f.hardwired,
      weight: Number(f.weight ?? 0),
      earnings: Number(f.earnings ?? 0),
      earningsWeth: Number(f.earningsWeth ?? 0),
      image: typeof f.imageUrl === "string" ? f.imageUrl : null,
      wallet: f.wallet?.address ?? null,
    }));
  } catch {
    return [];
  }
}

export async function getDeskData() {
  if (cache && Date.now() - cache.at < TTL) return cache.data as Desk;

  const c = client();
  const [pool, price, friends] = await Promise.all([readPool(c), ethUsd(), founderFriends()]);

  const { head, perDay } = await blocksPerDay(c);
  const feeEvent = ABI.hook.find((x: any) => x.type === "event" && x.name === "FeeCollected");
  const swapEvent = ABI.poolManager.find((x: any) => x.type === "event" && x.name === "Swap");

  // A full 24h, not a sample. An earlier version sampled a quarter-day and scaled
  // by 4, which reported 1.11 WETH of volume where the real figure is 13.7.
  // The PoolManager Swap filter REQUIRES the indexed poolId or it fails at any span.
  // scanLogs halves its chunk on failure, so these sizes are a starting point, not
  // a claim about the RPC's limits. Measured: ~700ms for the pair.
  const [feeLogs, swapLogs] = await Promise.all([
    scanLogs(c, { address: ADDR.Hook, event: feeEvent, fromBlock: head - perDay, toBlock: head,
                  chunk: 100_000n, pace: 0, concurrency: 4 }),
    scanLogs(c, { address: ADDR.PoolManager, event: swapEvent, args: { id: POOL_ID },
                  fromBlock: head - perDay, toBlock: head, chunk: 20_000n, pace: 0, concurrency: 8 }),
  ]);

  // Volume is derived from the fee the hook actually took, which captures ALL swaps.
  // The Market router only sees about a quarter of them; the rest hit PoolManager direct.
  const feeWeth = feeLogs.reduce((a: number, l: any) => a + Number(BigInt(l.data)) / 1e18, 0);
  const volume24hWeth = feeWeth / 0.05;
  const trades24h = swapLogs.length;

  // Price path straight from each swap's sqrtPriceX96. No derivation from amounts.
  const mids: number[] = swapLogs
    .map((l: any) => { const sp = Number(l.args?.sqrtPriceX96 ?? 0) / 2 ** 96; return sp * sp; })
    .filter((p: number) => p > 0);
  if (mids.length === 0) mids.push(pool.wethPerRf);

  // Hourly realised vol: scale per-observation vol by observations per hour.
  const perHour = Math.max(mids.length / 24, 1);
  const hourlyVol = mids.length >= 5 ? realisedVol(mids) * Math.sqrt(perHour) : 0;
  const lastHourCount = Math.max(2, Math.round(perHour));

  const marketState = {
    mid: pool.wethPerRf,
    ethUsd: price,
    volume24hWeth,
    trades24h,
    drift24h: drift(mids),
    drift1h: drift(mids.slice(-lastHourCount)),
    hourlyVol,
  };

  // The founding book: idle rewards across the founder's Friends.
  const idleRf = friends.reduce((a: number, f: any) => a + f.earnings, 0);
  const idleWeth = friends.reduce((a: number, f: any) => a + f.earningsWeth, 0);
  const bookValueWeth = idleWeth + idleRf * pool.wethPerRf;
  const book = { rf: idleRf, weth: idleWeth, valueWeth: bookValueWeth, hwmWeth: bookValueWeth, halted: false };

  const regime = evaluateRegime(marketState, book, DEFAULT_GATES);

  // The finding: is third-party liquidity still exactly zero?
  const marketPos = await readPosition(c, ADDR.Market, FULL_RANGE.tickLower, FULL_RANGE.tickUpper);
  const thirdPartyLiquidity = (pool.liquidity - marketPos).toString();

  const data = {
    asOf: new Date().toISOString(),
    block: head.toString(),
    armed: regime.armed,
    gates: regime.checks,
    thresholds: DEFAULT_GATES,
    market: { ...marketState, rfUsd: pool.wethPerRf * price },
    pool: {
      lpFee: pool.lpFee,
      liquidity: pool.liquidity.toString(),
      thirdPartyLiquidity,
      marketOwnsAll: thirdPartyLiquidity === "0",
      virtualRf: pool.virtualRf,
      virtualWeth: pool.virtualWeth,
      tick: pool.tick,
    },
    book: { rf: idleRf, weth: idleWeth, usd: idleWeth * price + idleRf * pool.wethPerRf * price },
    friends,
    sparkline: mids.slice(-120),
  };

  cache = { at: Date.now(), data };
  return data as Desk;
}
