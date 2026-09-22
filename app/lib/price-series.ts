import { unstable_cache } from "next/cache";
import { ADDR, ABI, POOL_ID, client, scanLogs, blocksPerDay } from "@/lib/protocol.mjs";
import SEED from "@/lib/price-hourly.json";

/**
 * The desk's hourly price history, SELF-EXTENDING.
 *
 * The site is deployed by CLI and then left running for a week of judging, so a
 * price file baked in at deploy time would go stale and the 72h and 7-day gates would
 * quietly fall back to "not yet measurable". Instead the history is built one UTC DAY
 * at a time and each finished day is kept in Next's shared data cache:
 *
 *   day(d) = day(d - 1) + the swaps from its tip to the end of day d
 *
 * A finished day never changes, so it is cached with no expiry and computed at most
 * once per deployment's cache. The chain is seeded from price-hourly.json (written by
 * scripts/backtest-gated.mjs --export-hourly), so the recursion never reaches further
 * back than the seed. Each missing day costs ~9 log requests of 100k blocks.
 *
 * Old blocks are slow on this RPC, so a request never waits longer than its budget:
 * if extending is not finished it serves the longest series it has, says how old it
 * is, and the extension keeps going in the background (the route's after()).
 */

export type Series = {
  startTs: number;        // closes[i] is the price at startTs + i*3600
  closes: number[];
  lastTs: number;         // the hour of the last close
  scannedTo: number;      // last block whose swaps are included
  lastPrice: number;      // price after the last swap included
  source: string;         // where the tip came from, for the API
};

const HOUR = 3600, DAY = 86_400;
const KEEP_HOURS = 9 * 24;            // a week for the replay, plus margin
const CHUNK = 100_000n;               // measured: ~9 requests per day of blocks
const SETTLE_S = 600;                 // do not seal a day until 10 min after it ends

const seed: Series = {
  startTs: SEED.startTs,
  closes: SEED.closes,
  lastTs: SEED.lastTs,
  scannedTo: SEED.lastBlock,
  lastPrice: SEED.closes[SEED.closes.length - 1],
  source: `file to ${new Date(SEED.lastTs * 1000).toISOString().slice(0, 16)}Z`,
};

const endOfDay = (d: number) => (d + 1) * DAY - HOUR;   // the day's last hourly close

/** Extend a series with every swap up to the hour `endTs`. Pure apart from the log scan. */
async function extend(prev: Series, endTs: number): Promise<Series> {
  if (endTs <= prev.lastTs) return prev;
  const c = client();
  const { head, secondsPerBlock, headTimestamp } = await blocksPerDay(c);
  const blockAt = (ts: number) => head - BigInt(Math.max(0, Math.round((headTimestamp - ts) / secondsPerBlock)));
  const tOf = (b: bigint) => headTimestamp - Number(head - b) * secondsPerBlock;
  const from = BigInt(prev.scannedTo) + 1n;
  const to = blockAt(endTs + HOUR - 1) < head ? blockAt(endTs + HOUR - 1) : head;
  const swap = ABI.poolManager.find((x: any) => x.type === "event" && x.name === "Swap");
  const logs = to < from ? [] : await scanLogs(c, {
    address: ADDR.PoolManager, event: swap, args: { id: POOL_ID },
    fromBlock: from, toBlock: to, chunk: CHUNK, pace: 0, concurrency: 8,
  });
  const pts = logs
    .map((l: any) => { const s = Number(l.args.sqrtPriceX96) / 2 ** 96; return { t: tOf(l.blockNumber as bigint), b: l.blockNumber as bigint, i: Number(l.logIndex), p: s * s }; })
    .sort((a, b) => (a.b === b.b ? a.i - b.i : a.b < b.b ? -1 : 1));
  const closes = [...prev.closes];
  let p = prev.lastPrice, k = 0;
  for (let h = prev.lastTs + HOUR; h <= endTs; h += HOUR) {
    while (k < pts.length && pts[k].t <= h) p = pts[k++].p;
    closes.push(p);
  }
  while (k < pts.length) p = pts[k++].p;
  const drop = Math.max(0, closes.length - KEEP_HOURS);
  return {
    startTs: prev.startTs + drop * HOUR,
    closes: closes.slice(drop),
    lastTs: endTs,
    scannedTo: Number(to),
    lastPrice: p,
    source: `chain to ${new Date(endTs * 1000).toISOString().slice(0, 16)}Z`,
  };
}

/** One finished UTC day, cached forever. Recurses through the cache to the seed. */
const dayCached: (d: number) => Promise<Series> = unstable_cache(
  async (d: number): Promise<Series> => {
    if (endOfDay(d) <= seed.lastTs) return seed;
    if ((d + 1) * DAY + SETTLE_S > Date.now() / 1000) throw new Error(`day ${d} has not ended`);
    return extend(await dayCached(d - 1), endOfDay(d));
  },
  ["fbof-price-day-v1"],
  { revalidate: false, tags: ["fbof-price"] },
);

let inflight: Promise<Series> | null = null;

/**
 * The longest hourly series available within `budgetMs`: through the end of the last
 * finished UTC day when the cache has it (or can build it in time), otherwise the
 * seed file, with the extension left running for the next request.
 */
export async function getSeries(budgetMs = 6_000): Promise<Series> {
  const now = Date.now() / 1000;
  let d = Math.floor(now / DAY) - 1;
  if ((d + 1) * DAY + SETTLE_S > now) d -= 1;
  if (endOfDay(d) <= seed.lastTs) return seed;
  if (!inflight) inflight = dayCached(d).finally(() => { inflight = null; });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
  const got = await Promise.race([inflight.catch(() => null), timeout]);
  return got ?? { ...seed, source: `${seed.source}; extending in the background` };
}

/** Wait for the extension without a budget. The route calls this in after(). */
export function warmSeries(): Promise<unknown> {
  return getSeries(25_000).catch(() => undefined);
}
