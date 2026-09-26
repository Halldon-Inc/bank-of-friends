"use client";

/**
 * THE TRADING FLOOR: the swap desk, live.
 *
 * The bank swaps pooled RF and WETH through the pool when a move pays, even after the 5% toll both ways. The board
 * is the LIVE decision from /api/desk (lib/strategy.mjs takerDecision on this hour's price). Below a rule, a
 * clearly stamped SIMULATED week runs the same decision on a made-up price path and ends on a sample receipt.
 */

import { useMemo, useRef, useState } from "react";
import type { ApiBank, ApiIdle } from "./VaultHolds";
import Receipt from "./Receipt";
import { simulateWeek, type SimWeek } from "@/lib/desk-sim";

export type LiveGate = { gate: string; ok: boolean; detail: string; label?: string; status?: "met" | "blocking" | "unmeasured" };
export type LiveTaker = {
  action: "buy" | "sell" | "wait"; reason: string;
  price: number; ema24: number; vsAverage: number; drift72: number | null;
  buyBelow: number; sellAbove: number; collapseGuard: boolean;
  params: { band: number; frac: number; collapse: number; maxRfShare: number; fee: number };
  breakEven: { label: string; share: number; cost: number; swing: number }[];
};
/** The fields of /api/desk the hall reads. Everything else there belongs to /docs. */
export type LiveDesk = {
  asOf: string;
  armed: boolean;
  headline?: string;
  taker?: LiveTaker | null;
  gates: LiveGate[];
  pool?: { virtualRf: number; virtualWeth: number };
  market: { rfUsd: number; volume24hWeth: number; trades24h: number; mid?: number; ethUsd?: number };
  rewards?: { nextAllocateAt?: string | null; streamRfPerWeek?: number; streamWethPerWeek?: number };
  keeper?: { harvested24hRf?: number; harvested24hWeth?: number };
  bank?: ApiBank | null;
  protocolIdle?: ApiIdle | null;
};

/** The word on the board, from the live swap-desk decision. hall-play.mjs asserts it against /api/desk. */
export function floorWord(taker?: LiveTaker | null) {
  if (!taker) return "READING";
  return taker.action === "buy" ? "BUY RF" : taker.action === "sell" ? "SELL RF" : "WAIT";
}

/** One line for the marquee ticker. */
export function tickerLine(taker?: LiveTaker | null) {
  if (!taker) return "swap desk: reading";
  return taker.action === "wait" ? `swap desk waiting: RF ${pct(taker.vsAverage)} vs its 24h average` : `swap desk: ${taker.action === "buy" ? "buying" : "selling"} RF`;
}

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const n = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const SHARES = [
  { label: "just the founder", share: 0.002 },
  { label: "half of all Friends", share: 0.5 },
  { label: "nearly everyone", share: 0.9 },
];

export default function FloorPanel({ live, error, bookRf, bookWeth, onBack }: { live: LiveDesk | null; error: string; bookRf: number; bookWeth: number; onBack: () => void }) {
  const [week, setWeek] = useState<SimWeek | null>(null);
  const [share, setShare] = useState(SHARES[1].share);
  const seed = useRef((Math.random() * 4294967296) >>> 0);
  const t = live?.taker ?? null;
  const word = floorWord(t);

  // The simulated week runs on the member's own box when there is one, else a $1,000 book half RF half WETH.
  const simBook = useMemo(() => {
    const mid = live?.market.mid ?? 6e-7, eth = live?.market.ethUsd ?? 2690;
    if (bookRf > 0 || bookWeth > 0) return { rf: bookRf, weth: bookWeth, label: "your box" };
    return { rf: 500 / eth / mid, weth: 500 / eth, label: "a $1,000 demo box" };
  }, [live, bookRf, bookWeth]);

  const roll = () => {
    if (!live) return;
    seed.current = (Math.imul(seed.current, 1664525) + 1013904223) >>> 0;
    const v = { price: live.market.mid ?? 6e-7, virtualRf: live.pool?.virtualRf ?? 1.9e8, virtualWeth: live.pool?.virtualWeth ?? 114 };
    setWeek(simulateWeek(seed.current, v, { rf: simBook.rf, weth: simBook.weth }, share));
  };

  return (
    <div className="floor">
      <p className="acct-kicker">the swap desk, live from chain</p>

      {!live && !error && <p className="floor-word is-loading">reading the pool…</p>}
      {error && !live && (
        <p className="picker-error" role="alert">
          The live read failed ({error}) and is retrying. Until it answers, the floor shows nothing rather than a guess.
        </p>
      )}

      {live && t && (
        <>
          <div className={`floor-board${t.action !== "wait" ? " armed" : ""}`}>
            <p className="floor-mode">swaps pooled RF and WETH, paying the toll</p>
            <p className="floor-word">{word}</p>
            <p className="hall-because">{t.reason}.</p>
          </div>
          <dl className="floor-order">
            <div><dt>RF now</dt><dd>{pct(t.vsAverage)} against its 24h average</dd></div>
            <div><dt>buys below</dt><dd>{pct(-t.params.band, 0)} from the average, unless it is collapsing ({t.collapseGuard ? "it is: guard on" : "guard off"})</dd></div>
            <div><dt>sells above</dt><dd>{pct(t.params.band, 0)} from the average, and only above cost after both tolls</dd></div>
            <div><dt>each trade</dt><dd>{Math.round(t.params.frac * 100)}% of the idle side; RF never above {Math.round(t.params.maxRfShare * 100)}% of the book</dd></div>
          </dl>
          <p className="acct-intro">
            Every swap pays the pool&rsquo;s 5%, in and out. That toll goes to every activated Friend, so the bank&rsquo;s members
            get their share of it back as rewards. The more Friends bank here, the less a round trip really costs:
          </p>
          <table className="floor-breakeven">
            <thead><tr><th>if the bank holds</th><th>toll per round trip</th><th>swing needed</th></tr></thead>
            <tbody>
              {t.breakEven.map((b) => (
                <tr key={b.label}><td>{b.label} ({(b.share * 100).toFixed(b.share < 0.01 ? 2 : 0)}%)</td><td>{(b.cost * 100).toFixed(2)}%</td><td>{(b.swing * 100).toFixed(2)}%</td></tr>
              ))}
            </tbody>
          </table>
          <p className="hall-small" style={{ margin: "6px 0" }}>
            Read at {new Date(live.asOf).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}. Most hours it waits:
            it trades only on a 30% move that is not a collapse. Tested on 16 real pools with a 4% to 6% toll and live on 22 more pools; the results, good and bad, are in docs/TAKER.md and docs/PAPER.md.
          </p>
        </>
      )}

      <hr className="acct-rule" />
      <p className="acct-kicker">what if <span className="sim-stamp">simulated week</span></p>
      <p className="acct-intro">
        Run the same desk on a made-up week, on {simBook.label}, through a pool as deep as the real one. Nothing here happened.
      </p>
      <div className="floor-shares" role="radiogroup" aria-label="How much of all Friend weight banks here">
        {SHARES.map((x) => (
          <button key={x.label} type="button" role="radio" aria-checked={share === x.share} className={share === x.share ? "is-on" : ""} onClick={() => setShare(x.share)}>{x.label}</button>
        ))}
      </div>
      <button type="button" className="hall-lever is-quiet floor-roll" onClick={roll} disabled={!live}>
        {week ? "Roll another week" : "Simulate a week"}
      </button>
      {week && (
        <div className={`floor-sim${week.vsHold > 0 ? " armed" : ""}`}>
          <p className="hall-regime">{week.regime}, simulated: RF {pct(week.priceChange)}</p>
          <p className="floor-sim-word">{week.swaps.length === 0 ? "waited all week" : `${week.swaps.length} swap${week.swaps.length === 1 ? "" : "s"}, ${pct(week.vsHold)} vs holding`}</p>
          {week.swaps.length > 0 && (
            <ol className="floor-swaps">
              {week.swaps.slice(0, 6).map((s, i) => (
                <li key={i}>day {Math.ceil(s.hour / 24)}: {s.action === "buy" ? `bought ${n(s.rf)} RF for ${s.weth.toFixed(4)} WETH` : `sold ${n(s.rf)} RF for ${s.weth.toFixed(4)} WETH`}</li>
              ))}
              {week.swaps.length > 6 && <li>and {week.swaps.length - 6} more</li>}
            </ol>
          )}
          <Receipt
            title="Sample receipt"
            r={{ depositedRf: week.start.rf, depositedWeth: week.start.weth, deskRf: week.end.rf - week.start.rf, deskWeth: week.end.weth - week.rebateWeth - week.start.weth, rebateWeth: week.rebateWeth }}
            rfUsd={live?.market.rfUsd ? live.market.rfUsd * (1 + week.priceChange) : undefined} ethUsd={live?.market.ethUsd}
            note={`Valued at the simulated week's closing price. The desk paid ${week.tollWeth.toFixed(5)} WETH in tolls; ${(share * 100).toFixed(share < 0.01 ? 1 : 0)}% of it came back as rewards. A swap that turns RF into WETH shows as minus RF and plus WETH: a trade, not a loss.`}
          />
        </div>
      )}
      <button type="button" className="hall-lever floor-back" onClick={onBack}>Back to the hall</button>
    </div>
  );
}
