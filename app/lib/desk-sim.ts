/**
 * A SIMULATED week of the swap desk, for the Trading Floor's "what if" button and the sample receipt.
 *
 * It runs the SAME pure decision the backtests, the paper test and /api/desk run (lib/strategy.mjs takerDecision)
 * on a made-up hourly price path through a constant-product pool built from the live pool's virtual reserves, with
 * the full toll on every swap and the members' rebate on the toll at a chosen membership share. Nothing here is a
 * forecast; the regimes are labelled and the result is stamped SIMULATED wherever it is shown.
 */
import { TAKER, takerDecision } from "@/lib/strategy.mjs";

export type SimSwap = { hour: number; action: "buy" | "sell"; rf: number; weth: number; price: number; reason: string };
export type SimWeek = {
  regime: string;
  swaps: SimSwap[];
  start: { rf: number; weth: number };
  end: { rf: number; weth: number };
  /** Toll the desk paid, and the members' share of it streamed back (WETH). */
  tollWeth: number; rebateWeth: number;
  /** Value against holding the same book, both marked at the final price. */
  vsHold: number;
  priceChange: number;
};

const REGIMES = [
  { name: "quiet week", trend: 0, sigma: 0.01, pull: 0.1 },
  { name: "choppy week", trend: 0, sigma: 0.06, pull: 0.35 },
  { name: "wild chop", trend: 0, sigma: 0.10, pull: 0.40 },
  { name: "slow bleed", trend: -0.03, sigma: 0.03, pull: 0 },
  { name: "pump and fade", trend: 0, sigma: 0.08, pull: 0.15, shock: 0.8 },
  { name: "steady climb", trend: 0.04, sigma: 0.04, pull: 0.05 },
];

export function simulateWeek(seed: number, v: { price: number; virtualRf: number; virtualWeth: number }, book: { rf: number; weth: number }, share: number): SimWeek {
  let st = seed >>> 0;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return (st >>> 8) / 16777216; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), w = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
  const r = REGIMES[Math.floor(rnd() * REGIMES.length)] as (typeof REGIMES)[number] & { shock?: number };
  // A path of hourly target prices; the pool is moved to each by an outside taker, then the desk decides.
  let x = v.virtualRf, y = v.virtualWeth;
  const k = x * y, px = () => y / x;
  const moveTo = (target: number) => { const nx = Math.sqrt(k / target); x = nx; y = k / nx; };
  const fee = TAKER.fee;
  let rf = book.rf, weth = book.weth, costRf = book.rf, costWeth = book.rf * v.price, lastSellNet: number | null = null, toll = 0;
  const hist: number[] = [v.price];
  let ema = v.price, target = v.price, anchor = v.price;
  const swaps: SimSwap[] = [];
  const HOURS = 24 * 7, perHour = Math.pow(1 + r.trend, 1 / 24) - 1;
  for (let h = 1; h <= HOURS; h++) {
    anchor *= 1 + perHour;
    target = target * Math.exp(-r.pull * Math.log(target / anchor) + r.sigma * gauss()) * (1 + perHour);
    if (r.shock && h === 30) { target *= 1 + r.shock; anchor = target; }
    moveTo(target);
    const p = px();
    hist.push(p);
    ema = ema + (p - ema) * (2 / (TAKER.emaHours + 1));
    const ago = hist[Math.max(0, hist.length - 73)];
    const quoteBuy = (w: number) => { const dy = w * (1 - fee); return x - k / (y + dy); };
    const quoteSell = (q: number) => (y - k / (x + q)) * (1 - fee);
    const o = takerDecision({ price: p, ema, drift72: p / ago - 1 }, { rf, weth, avgCost: costRf > 0 ? costWeth / costRf : p, lastSellNet },
      { buyPx: (w: number) => w / quoteBuy(w), sellNet: quoteSell });
    if (o.action === "buy") {
      const got = quoteBuy(o.amount);
      y += o.amount * (1 - fee); x = k / y;                      // the desk's own buy moves the pool
      weth -= o.amount; rf += got; costRf += got; costWeth += o.amount; toll += o.amount * fee;
      swaps.push({ hour: h, action: "buy", rf: got, weth: o.amount, price: p, reason: o.reason });
    } else if (o.action === "sell") {
      const net = quoteSell(o.amount), gross = net / (1 - fee);
      x += o.amount; y = k / x;
      const f = o.amount / rf; costRf *= 1 - f; costWeth *= 1 - f;
      rf -= o.amount; weth += net; lastSellNet = net / o.amount; toll += gross * fee;
      swaps.push({ hour: h, action: "sell", rf: o.amount, weth: net, price: p, reason: o.reason });
    }
  }
  const pEnd = px(), rebate = toll * share;
  const value = weth + rebate + rf * pEnd, hold = book.weth + book.rf * pEnd;
  return { regime: r.name, swaps, start: book, end: { rf, weth: weth + rebate }, tollWeth: toll, rebateWeth: rebate, vsHold: value / hold - 1, priceChange: pEnd / v.price - 1 };
}
