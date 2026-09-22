import { parseAbi } from "viem";
import { ADDR, ABI, client, readPool, readPosition, scanLogs, blocksPerDay, FULL_RANGE, POOL_ID, ethUsd as readEthUsd } from "@/lib/protocol.mjs";
import { DEFAULT_GATES, evaluateRegime, measurePath, explain, makerEdgePerRoundTrip } from "@/lib/strategy.mjs";
import { getSeries } from "@/lib/price-series";
import * as protocol from "@/lib/protocol.mjs";

export type Gate = { gate: string; ok: boolean; status: "met" | "blocking" | "unmeasured"; label: string; detail: string };
export type Friend = {
  id: string; collection: string; generation: number; tier: number;
  activated: boolean; hardwired: boolean; weight: number;
  earnings: number; earningsWeth: number; image: string | null; wallet: string | null;
};
export type Desk = {
  asOf: string; block: string; armed: boolean;
  /** Present when a cached read older than the refresh interval was served while a refresh runs. */
  stale?: boolean; staleSeconds?: number;
  /** The arming rule in one line, for the hall's Trading Floor. */
  rule: string;
  ethUsdSource: string;
  state: "off" | "armed" | "halted";
  headline: string;
  gates: Gate[];
  thresholds: Record<string, number>;
  grid: { step: number; rungs: number; lockBps: number; makerEdge: number };
  market: {
    mid: number; rfUsd: number; ethUsd: number; volume24hWeth: number; trades24h: number;
    drift1h: number | null; drift24h: number | null; drift72h: number | null; drift7d: number | null;
    hourlyVol: number | null; reversals72h: number | null; walkForward7d: number | null; historyHours: number;
    /** How far the self-extending hourly history reaches, and where its tip came from. */
    historyTo: string; historySource: string;
  };
  pool: { lpFee: number; liquidity: string; thirdPartyLiquidity: string; marketOwnsAll: boolean; virtualRf: number; virtualWeth: number; tick: number };
  rewards: {
    nextAllocateTs: number; nextAllocateAt: string; pendingWeth: number; pendingRf: number;
    streamWethPerWeek: number; streamRfPerWeek: number; totalWeight: number;
    hookRewards: string; activationManager: string; hookRewardsOk: boolean;
  };
  reserve: { payoutRf: number; conversionEnabled: boolean | null; floorWeth: number; floorUsd: number };
  genesis: { maxBidUsd: number; convertBelowUsd: number; parts: { floorUsd: number; nextStreamUsd: number; activationUsd: number; marginUsd: number } };
  volumeLoop: { memberWeight: number; memberShare: number; costPerWethRoundTrip: number; inducedMultiple: number | null };
  /** The bank's own pooled totals. deployed:false and every figure null until FRIENDBANK_ADDRESS is set: never a made-up number. */
  bank: {
    deployed: boolean; address: string | null;
    rfIdle: number | null; wethIdle: number | null; rfInAsk: number | null; wethInBid: number | null;
    activeFriends: number | null; holders: number | null; usd: number | null;
    /** Aliases the hall's vault plaque reads: members = holders, rf/weth = idle + committed to ranges. */
    members: number | null; rf: number | null; weth: number | null;
  };
  /** Rewards earned by every activated Friend and not yet claimed, protocol-wide. Null when the read did not finish in time. */
  protocolIdle: { rf: number | null; weth: number | null; usd: number | null; asOf: string | null; block?: string };
  book: { rf: number; weth: number; usd: number };
  friends: Friend[];
  sparkline: number[];
};

/** MEASURED 2026-09-22 (CoinGecko). Used only if every live ETH/USD source is down; the API then says so. */
const ETH_USD_FALLBACK = 2736;
const FOUNDER = "0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF";
/** MEASURED: the pool's first swap and its seed ModifyLiquidity share this block. Nothing earlier has a price. */
const POOL_FIRST_BLOCK = 64_590_343n;
/** How far back the hourly path reaches: a week for the replay plus a day of margin. */
const HISTORY_HOURS = 8 * 24;
const GENESIS_WEIGHT = 2_000_000;          // MEASURED positions() of an active Genesis
const GENESIS_ACTIVATION_RF = 100_000;     // MEASURED rarefriends docs + real activations
const MARGIN_Z = 2;                        // CHOICE: Genesis bid margin = 2 sigma of a one-week RF move

const reserveAbi = parseAbi([
  "function RF_PER_GENESIS() view returns (uint256)",
  "function DEPOSIT_FEE() view returns (uint256)",
  "function conversionEnabled() view returns (bool)",
]);

/**
 * Stale-while-revalidate. A read younger than TTL is served as is. An older one is
 * STILL served at once, and the caller schedules a refresh after the response (the
 * route uses next/server after()), so only the very first read of a cold instance
 * ever waits on the chain. A refresh that overruns BUILD_BUDGET_MS is abandoned.
 */
let cache: { at: number; data: Desk } | null = null;
const TTL = 60_000;
const BUILD_BUDGET_MS = 25_000;

/**
 * The swap-level price path for the last LIVE_HOURS, kept between requests on a warm
 * instance so each refresh only scans the blocks since the last one. Older hours come
 * from the self-extending series in price-series.ts (seeded by price-hourly.json),
 * because this RPC serves old blocks slowly: on 2026-09-22 the last 24h scanned in
 * 0.6 s in 20k-block chunks, while a 7-day scan did not finish in 170 s.
 */
/** grossWeth: the WETH leg before the hook's 5% (a buy's pool-side input is 95% of it). */
type Tick = { b: bigint; i: number; p: number; pBefore: number; grossWeth: number };
let ticks: { to: bigint; list: Tick[] } | null = null;
const LIVE_HOURS = 74;
/** 100k-block chunks: ~9 requests for a day. Fewer, larger requests hit the rate limit less. */
const LIVE_CHUNK = 100_000n;

let ethCache: { at: number; v: number; source: string } | null = null;
async function ethUsd(): Promise<{ usd: number; source: string }> {
  if (ethCache && Date.now() - ethCache.at < 300_000) return { usd: ethCache.v, source: ethCache.source };
  const live = await readEthUsd().catch(() => null);
  if (live) { ethCache = { at: Date.now(), v: live.usd, source: String(live.source) }; return { usd: live.usd, source: String(live.source) }; }
  if (ethCache) return { usd: ethCache.v, source: `${ethCache.source}, cached` };
  return { usd: ETH_USD_FALLBACK, source: "fallback constant (2026-09-22): every live source was down" };
}

/** Discovery only. Every value below is read from chain. */
async function founderFriends(): Promise<Friend[]> {
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

const toPrice = (sqrtX96: bigint) => { const s = Number(sqrtX96) / 2 ** 96; return s * s; };

async function refreshTicks(c: any, head: bigint, perDay: bigint, fileEndBlock: bigint) {
  // Scan from where the shipped file ends, but always at least 25h (for volume) and
  // never more than LIVE_HOURS (old blocks are slow here).
  const max = (a: bigint, b: bigint) => (a > b ? a : b), min = (a: bigint, b: bigint) => (a < b ? a : b);
  const floor = max(POOL_FIRST_BLOCK, max(head - (perDay * BigInt(LIVE_HOURS)) / 24n, min(fileEndBlock, head - (perDay * 25n) / 24n)));
  const from = ticks && ticks.to >= floor ? ticks.to + 1n : floor;
  const swapEvent = ABI.poolManager.find((x: any) => x.type === "event" && x.name === "Swap");
  const logs = from > head ? [] : await scanLogs(c, {
    address: ADDR.PoolManager, event: swapEvent, args: { id: POOL_ID },
    fromBlock: from, toBlock: head, chunk: LIVE_CHUNK, pace: 0, concurrency: 8,
  });
  const fresh: Tick[] = logs.map((l: any) => {
    const sq = BigInt(l.args.sqrtPriceX96), L = Number(l.args.liquidity), a1 = Number(l.args.amount1);
    const sAfter = Number(sq) / 2 ** 96;
    // The swapper's WETH delta a1 moves sqrtP by a1 / L in a single-range pool, so the
    // price BEFORE the swap is recoverable exactly. It anchors the path's first hour.
    const sBefore = L > 0 ? sAfter + a1 / L : sAfter;
    const grossWeth = (a1 < 0 ? -a1 / 0.95 : a1) / 1e18;   // a1 < 0: the swapper paid WETH (a buy)
    return { b: l.blockNumber as bigint, i: Number(l.logIndex), p: toPrice(sq), pBefore: sBefore * sBefore, grossWeth };
  });
  // Merge, de-duplicate by (block, logIndex) and sort. Two overlapping refreshes once
  // appended the same range twice and out of order, which showed 710 trades where the
  // chain had 266 and counted 12 "swings" inside a 2% range. Never trust append order.
  const seen = new Set<string>(), list: Tick[] = [];
  for (const t of [...(ticks?.list ?? []), ...fresh]) {
    const k = `${t.b}:${t.i}`;
    if (t.b >= floor && !seen.has(k)) { seen.add(k); list.push(t); }
  }
  list.sort((a, b) => (a.b === b.b ? a.i - b.i : a.b < b.b ? -1 : 1));
  if (!ticks || head > ticks.to) ticks = { to: head, list };
  return { list, floor };
}

/** One refresh at a time: a second request waits for the first instead of racing it. */
let inflight: Promise<Desk> | null = null;

/** Start (or join) a refresh, abandoned after BUILD_BUDGET_MS. */
export function refreshDesk(): Promise<Desk> {
  if (!inflight) {
    const budget = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`chain reads took over ${BUILD_BUDGET_MS / 1000}s`)), BUILD_BUDGET_MS));
    inflight = Promise.race([build(), budget]).finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Serve the desk. `schedule` runs work after the response (the route passes next/server
 * after()); when a stale read is served, the refresh goes there instead of in front of
 * the reader. Without a scheduler the refresh is awaited.
 */
export async function getDeskData(schedule?: (fn: () => Promise<unknown>) => void): Promise<Desk> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  if (cache && schedule) {
    schedule(() => refreshDesk().catch(() => undefined));
    return { ...cache.data, stale: true, staleSeconds: Math.round((Date.now() - cache.at) / 1000) };
  }
  try {
    return await refreshDesk();
  } catch (e) {
    if (cache) return { ...cache.data, stale: true, staleSeconds: Math.round((Date.now() - cache.at) / 1000) };
    throw e;
  }
}

/** Resolve within ms or give null; the slow part keeps running and lands in its cache. */
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

const BANK_ADDRESS = process.env.FRIENDBANK_ADDRESS?.trim() || null;
const num = (v: any) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** cartographer's readBankTotals, only when a bank address is configured. */
async function bankTotals(c: any) {
  const read = (protocol as any).readBankTotals;
  if (!BANK_ADDRESS || typeof read !== "function") return null;
  // FriendBank.bankTotals() via cartographer (ABI.bank). Amounts arrive in wei. The ask and
  // bid figures are what was COMMITTED to the open range, not its live mix.
  const r = await read(c, BANK_ADDRESS);
  if (!r) return null;
  const e = (v: any) => Number(v) / 1e18;
  return { rfIdle: e(r.rfIdle), wethIdle: e(r.wethIdle), rfInAsk: e(r.rfInAsk), wethInBid: e(r.wethInBid), activeFriends: Number(r.activeFriends), holders: Number(r.holders) };
}

/**
 * cartographer's readProtocolIdle: earned-but-unclaimed rewards protocol-wide, as
 * ActivationManager balance - pending - remaining stream (three reads, a slight upper
 * bound per its note). Cheap, so it is read live, under a short budget.
 */
const PROTOCOL_IDLE_BUDGET_MS = 3_000;
async function protocolIdle(c: any) {
  const read = (protocol as any).readProtocolIdle;
  if (typeof read !== "function") return null;
  const r = await read(c);
  return r ? { rf: Number(r.RF) / 1e18, weth: Number(r.WETH) / 1e18, block: String(r.blockNumber ?? ""), asOf: r.asOf ? String(r.asOf) : null } : null;
}

async function build(): Promise<Desk> {

  const c = client();
  const bankP = within(bankTotals(c), 3_000), idleP = within(protocolIdle(c), PROTOCOL_IDLE_BUDGET_MS);
  const [pool, eth, friends, bpd, HISTORY] = await Promise.all([readPool(c), ethUsd(), founderFriends(), blocksPerDay(c), getSeries()]);
  const price = eth.usd;
  const { head, perDay, secondsPerBlock, headTimestamp } = bpd;
  const tOf = (b: bigint) => headTimestamp - Number(head - b) * secondsPerBlock;

  // Point reads run alongside the log scan; neither waits for the other.
  // Rewards: what is streaming now, what is queued, and whether the fee still goes to Friends.
  const am = ADDR.ActivationManager;
  const rd = (address: any, abi: any, functionName: string, args: any[] = []) => c.readContract({ address, abi, functionName, args });
  const activated = friends.filter((f) => f.activated);
  const readsP = Promise.all([
    rd(am, ABI.activationManager, "streams", [ADDR.WETH]),
    rd(am, ABI.activationManager, "streams", [ADDR.RF]),
    rd(am, ABI.activationManager, "totalWeight"),
    rd(ADDR.Hook, ABI.hook, "rewards"),
    readPosition(c, ADDR.Market, FULL_RANGE.tickLower, FULL_RANGE.tickUpper),
    rd(ADDR.Reserve, reserveAbi, "RF_PER_GENESIS").catch(() => null),
    rd(ADDR.Reserve, reserveAbi, "DEPOSIT_FEE").catch(() => null),
    rd(ADDR.Reserve, reserveAbi, "conversionEnabled").catch(() => null),
    ...activated.map((f) => rd(am, ABI.activationManager, "positions",
      [f.collection === "Genesis" ? ADDR.Genesis : ADDR.Generations, BigInt(f.id)]).catch(() => null)),
  ]) as Promise<any[]>;
  const { list, floor } = await refreshTicks(c, head, perDay, BigInt(HISTORY.scannedTo) + 1n);

  // Volume from the PoolManager Swap events, which every swap emits whatever router it
  // used. Gross WETH, i.e. what the hook took 5% of (MEASURED: the hook's FeeCollected
  // total over the pool's life matched 5% of this within 2%). One scan, not two.
  const dayAgo = head - perDay;
  const day = list.filter((t) => t.b > dayAgo);
  const volume24hWeth = day.reduce((a, t) => a + t.grossWeth, 0);
  const trades24h = day.length;

  // Hourly closes, newest first, walked back until an hour nobody can price. The last
  // LIVE_HOURS come from the swaps just scanned (before the first swap in the window the
  // price is that swap's pre-swap price, or slot0 if nothing traded). Older hours come
  // from the shipped file. A gap between the two, or the pool's birth, ends the path, and
  // the gates that need more history then say "not yet measurable" rather than guess.
  const tLive = tOf(floor), tNow = headTimestamp;
  const liveAt = (h: number) => {
    let p: number | null = null;
    for (const t of list) { if (tOf(t.b) <= h) p = t.p; else break; }
    return p ?? list[0]?.pBefore ?? pool.wethPerRf;
  };
  const fileAt = (h: number) => {
    if (h < HISTORY.startTs || h > HISTORY.lastTs) return null;
    return HISTORY.closes[Math.floor((h - HISTORY.startTs) / 3600)] ?? null;
  };
  const back: number[] = [pool.wethPerRf];          // the path ends at the live slot0 price
  for (let k = 1; k <= HISTORY_HOURS; k++) {
    const h = tNow - k * 3600;
    const p = h >= tLive ? (floor === POOL_FIRST_BLOCK && h < tOf(POOL_FIRST_BLOCK) ? null : liveAt(h)) : fileAt(h);
    if (p == null) break;
    back.push(p);
  }
  const hourly = back.reverse();
  const t72 = tNow - 72 * 3600;
  // Swings over 72h: swap by swap where the live scan reaches, hourly closes from the
  // file before that. Hourly closes can only UNDER-count swings, so the mix errs toward off.
  const start72 = t72 >= tLive ? liveAt(t72) : fileAt(t72);
  const fileHours: number[] = [];
  for (let h = Math.ceil(t72 / 3600) * 3600; h < tLive; h += 3600) { const p = fileAt(h); if (p != null) fileHours.push(p); }
  const ticks72 = start72 == null ? null
    : [start72, ...fileHours, ...list.filter((t) => tOf(t.b) > Math.max(t72, tLive)).map((t) => t.p), pool.wethPerRf];
  const measured = measurePath(hourly, DEFAULT_GATES, ticks72);

  const marketState = {
    mid: pool.wethPerRf,
    ethUsd: price,
    volume24hWeth,
    trades24h,
    drift1h: measured.drift1h,
    drift24h: measured.drift24h,
    drift72h: measured.drift72h,
    drift7d: measured.drift7d,
    hourlyVol: measured.hourlyVol,
    reversals72h: measured.reversals72h,
    walkForward7d: measured.walkForward7d,
    historyHours: measured.historyHours,
    historyTo: new Date(HISTORY.lastTs * 1000).toISOString(),
    historySource: HISTORY.source,
  };

  // The founding book: idle rewards across the founder's Friends.
  const idleRf = friends.reduce((a, f) => a + f.earnings, 0);
  const idleWeth = friends.reduce((a, f) => a + f.earningsWeth, 0);
  const bookValueWeth = idleWeth + idleRf * pool.wethPerRf;
  const book = { rf: idleRf, weth: idleWeth, valueWeth: bookValueWeth, hwmWeth: bookValueWeth, halted: false };

  const regime = evaluateRegime(marketState, book, DEFAULT_GATES);

  const [sWeth, sRf, totalWeightRaw, hookRewards, marketPos, perGenesis, depositFee, convEnabled, ...positions] = await readsP;

  const e18 = (v: any) => Number(v) / 1e18;
  const totalWeight = e18(totalWeightRaw);
  const finish = Number(sWeth[2]);
  const rewards = {
    nextAllocateTs: finish,
    nextAllocateAt: new Date(finish * 1000).toISOString(),
    pendingWeth: e18(sWeth[0]),
    pendingRf: e18(sRf[0]),
    streamWethPerWeek: e18(sWeth[1]) * 604_800,
    streamRfPerWeek: e18(sRf[1]) * 604_800,
    totalWeight,
    hookRewards: String(hookRewards),
    activationManager: am,
    hookRewardsOk: String(hookRewards).toLowerCase() === am.toLowerCase(),
  };

  // Reserve floor F: deposit a Genesis, take the net RF, sell it through the pool
  // (constant product on the pool's virtual reserves, then the 5% hook fee).
  const payoutRf = perGenesis != null && depositFee != null ? e18(perGenesis) - e18(depositFee) : 900_000;
  const dumpWeth = (rf: number) => (pool.virtualWeth - (pool.virtualRf * pool.virtualWeth) / (pool.virtualRf + rf)) * 0.95;
  const floorWeth = dumpWeth(payoutRf);
  const reserve = { payoutRf, conversionEnabled: convEnabled == null ? null : Boolean(convEnabled), floorWeth, floorUsd: floorWeth * price };

  // Genesis band (research panel, not in the contract). MaxBid = F + one queued stream's
  // share at dump value - the activation burn - a 2-sigma one-week RF margin on F.
  const share = totalWeight > 0 ? GENESIS_WEIGHT / totalWeight : 0;
  const nextStreamUsd = (rewards.pendingWeth + dumpWeth(rewards.pendingRf)) * share * price;
  const activationUsd = (GENESIS_ACTIVATION_RF * pool.wethPerRf / 0.95) * price;
  const marginUsd = MARGIN_Z * (measured.hourlyVol ?? 0) * Math.sqrt(168) * reserve.floorUsd;
  const maxBidUsd = reserve.floorUsd + nextStreamUsd - activationUsd - marginUsd;
  // No sale price on purpose: OpenSea's events API answered once without a key and has
  // returned 401 since, so a "last sale" here would be a number we cannot keep honest.
  // The panel shows the two thresholds; a reader compares them to the market.
  const genesis = {
    maxBidUsd, convertBelowUsd: reserve.floorUsd * 0.97,   // CHOICE: 3% margin for RF drift between buy and sale
    parts: { floorUsd: reserve.floorUsd, nextStreamUsd, activationUsd, marginUsd },
  };

  // The volume loop at the founding member's share: a round trip of V costs 0.0975 V (1 - s).
  const memberWeight = positions.reduce((a: number, p: any) => a + (p ? e18(p[1]) : 0), 0);
  const s = totalWeight > 0 ? memberWeight / totalWeight : 0;
  const volumeLoop = { memberWeight, memberShare: s, costPerWethRoundTrip: 0.0975 * (1 - s), inducedMultiple: s > 0 ? (1.95 * (1 - s)) / s : null };

  const thirdPartyLiquidity = (pool.liquidity - marketPos).toString();

  const [bk, idle] = await Promise.all([bankP, idleP]) as [any, any];
  const toUsd = (rfAmt: number | null, wethAmt: number | null) =>
    rfAmt == null && wethAmt == null ? null : ((wethAmt ?? 0) + (rfAmt ?? 0) * pool.wethPerRf) * price;
  const bankOut: Desk["bank"] = bk
    ? {
        deployed: true, address: BANK_ADDRESS,
        rfIdle: num(bk.rfIdle), wethIdle: num(bk.wethIdle), rfInAsk: num(bk.rfInAsk), wethInBid: num(bk.wethInBid),
        activeFriends: num(bk.activeFriends), holders: num(bk.holders),
        usd: toUsd((num(bk.rfIdle) ?? 0) + (num(bk.rfInAsk) ?? 0), (num(bk.wethIdle) ?? 0) + (num(bk.wethInBid) ?? 0)),
        members: num(bk.holders),
        rf: (num(bk.rfIdle) ?? 0) + (num(bk.rfInAsk) ?? 0),
        weth: (num(bk.wethIdle) ?? 0) + (num(bk.wethInBid) ?? 0),
      }
    : { deployed: BANK_ADDRESS != null, address: BANK_ADDRESS, rfIdle: null, wethIdle: null, rfInAsk: null, wethInBid: null, activeFriends: null, holders: null, usd: null, members: null, rf: null, weth: null };
  const idleOut: Desk["protocolIdle"] = idle
    ? { rf: idle.rf, weth: idle.weth, usd: toUsd(idle.rf, idle.weth), asOf: idle.asOf ?? new Date().toISOString(), block: idle.block }
    : { rf: null, weth: null, usd: null, asOf: null };
  // bank.usd values committed range amounts at the pool price, not at their range's mark.

  const data: Desk = {
    asOf: new Date().toISOString(),
    block: head.toString(),
    armed: regime.armed,
    state: book.halted ? "halted" : regime.armed ? "armed" : "off",
    headline: headline(regime, marketState),
    rule: `arms only when the market has made ${DEFAULT_GATES.minReversals72h} swings of ${DEFAULT_GATES.gridStep * 100}% in 72 hours, has trended less than ${DEFAULT_GATES.maxDrift72hSteps * DEFAULT_GATES.gridStep * 100}% over them, and the same grid would have beaten holding over the last 7 days`,
    ethUsdSource: eth.source,
    gates: regime.checks,
    thresholds: { ...DEFAULT_GATES },
    grid: { step: DEFAULT_GATES.gridStep, rungs: DEFAULT_GATES.rungs, lockBps: DEFAULT_GATES.lockBps, makerEdge: makerEdgePerRoundTrip(DEFAULT_GATES.gridStep, DEFAULT_GATES.lockBps / 10_000) },
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
    rewards, reserve, genesis, volumeLoop,
    bank: bankOut, protocolIdle: idleOut,
    book: { rf: idleRf, weth: idleWeth, usd: idleWeth * price + idleRf * pool.wethPerRf * price },
    friends,
    sparkline: hourly.slice(-168),
  };

  cache = { at: Date.now(), data };
  return data;
}

/** The desk's state in one sentence a member can read. */
function headline(regime: ReturnType<typeof evaluateRegime>, m: { historyHours: number }) {
  if (regime.armed) return "The desk is quoting both sides with range orders. It never pays the 5% toll; every taker who crosses it pays 5% to every Friend.";
  const by = Object.fromEntries(regime.checks.map((c: any) => [c.gate, c]));
  const why: string[] = [];
  if (by.reversals72h?.status === "blocking") why.push(`the market has swung back ${by.reversals72h.detail.split(" ")[0]} times in 72 hours and the desk needs ${DEFAULT_GATES.minReversals72h}`);
  if (by.drift72h?.status === "blocking") why.push(`it has trended ${by.drift72h.detail.split(" ")[0]} over 72 hours, beyond the ${DEFAULT_GATES.maxDrift72hSteps * DEFAULT_GATES.gridStep * 100}% a grid survives`);
  if (by.walkForward7d?.status === "blocking") why.push("replaying the grid on the last week loses to holding");
  for (const k of ["inventory", "drawdown", "breaker"]) if (by[k]?.status === "blocking") why.push(`${by[k].label}: ${by[k].detail}`);
  const unmeasured = regime.checks.filter((c: any) => c.status === "unmeasured").map((c: any) => c.label);
  let s = why.length ? `The desk is off: ${why.join("; ")}.` : "The desk is off.";
  if (unmeasured.length) s += ` Not yet measurable: ${unmeasured.join(", ")} (${(m.historyHours / 24).toFixed(1)} days of price history so far).`;
  return s;
}

/** The one-line machine summary, for logs. */
export const deskSummary = explain;
