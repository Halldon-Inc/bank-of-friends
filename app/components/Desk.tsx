"use client";

import { useEffect, useRef, useState } from "react";
import Sparkline from "./Sparkline";
import type { Desk } from "@/lib/desk";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;

const LABEL: Record<string, string> = {
  volume24h: "volume 24h", trades24h: "trades 24h", drift24h: "drift 24h",
  drift1h: "drift 1h", drift7d: "drift 7d", volFloor: "vol floor",
  volCeiling: "vol ceiling", inventory: "inventory", drawdown: "drawdown",
  breaker: "breaker",
};

/** Counts a number up on first paint. The figure lands rather than just being there. */
function Count({ value, decimals = 2, prefix = "" }: { value: number; decimals?: number; prefix?: string }) {
  const [shown, setShown] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    const t0 = performance.now(), DUR = 900;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / DUR);
      setShown(value * (1 - Math.pow(1 - k, 3)));   // ease-out cubic
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [value]);
  return <>{prefix}{n(shown, decimals)}</>;
}

export default function DeskView() {
  const [d, setD] = useState<Desk | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boot, setBoot] = useState(0);          // how many gates have resolved on screen
  const [pulse, setPulse] = useState(false);

  async function load(isRefresh = false) {
    try {
      const r = await fetch("/api/desk", { cache: "no-store" });
      if (!r.ok) throw new Error(`the desk API answered ${r.status}`);
      const j = (await r.json()) as Desk;
      setD(j); setErr(null);
      if (isRefresh) { setPulse(true); setTimeout(() => setPulse(false), 700); }
      else setBoot(0);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => { load(); const id = setInterval(() => load(true), 60_000); return () => clearInterval(id); }, []);

  // Resolve the gates one at a time so the desk reads as thinking, not as a table.
  useEffect(() => {
    if (!d || boot >= d.gates.length) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setBoot(d.gates.length); return; }
    const id = setTimeout(() => setBoot((b) => b + 1), boot === 0 ? 240 : 95);
    return () => clearTimeout(id);
  }, [d, boot]);

  if (err && !d) {
    return (
      <div className="err">
        <p style={{ margin: 0 }}>
          Cannot reach the chain right now, so there is nothing honest to show: {err}.
          The desk is flat, as it is by default. It retries every minute.
        </p>
      </div>
    );
  }

  if (!d) {
    return (
      <section className="status">
        <div className="dither" aria-hidden="true" />
        <p className="status-word"><span className="blink">READING CHAIN</span></p>
        <p className="status-sub">robinhood chain 4663 &middot; 24 hours of swaps</p>
      </section>
    );
  }

  const blocked = d.gates.filter((g) => !g.ok);
  const passing = d.gates.length - blocked.length;

  return (
    <>
      <div className="masthead-meta">
        <span>Robinhood Chain 4663</span>
        <span>block {Number(d.block).toLocaleString("en-US")}</span>
        <span>$RAREFRIENDS ${d.market.rfUsd.toPrecision(4)}</span>
        <span className={pulse ? "pulse" : ""}>
          {new Date(d.asOf).toISOString().replace("T", " ").slice(0, 19)}Z
        </span>
      </div>

      <section className={`status${pulse ? " pulse" : ""}`} aria-live="polite">
        <div className="dither" aria-hidden="true" />
        <p className="status-word">
          {d.armed ? <span className="armed-box">ARMED</span> : <span className="blink">FLAT</span>}
        </p>
        <p className="status-sub">
          {d.armed
            ? `all ${d.gates.length} conditions met | the desk is working the grid`
            : `waiting on ${blocked.length} of ${d.gates.length} conditions | ${passing} met`}
        </p>
      </section>

      <section className="panel" style={{ marginBottom: "1.25rem" }}>
        <h2>Arming conditions: live</h2>
        {d.gates.map((g, i) => (
          <div
            key={g.gate}
            className={`gate${g.ok ? "" : " blocked"}${i < boot ? " in" : " pending"}`}
          >
            <span className="gate-mark" aria-hidden="true">{i < boot ? (g.ok ? "□" : "■") : "·"}</span>
            <span className="gate-name">{LABEL[g.gate] ?? g.gate}</span>
            <span className="gate-detail">{i < boot ? g.detail : "reading…"}</span>
            <span className="gate-verdict">{i < boot ? (g.ok ? "met" : "blocking") : ""}</span>
          </div>
        ))}
        <p className="note">
          Every gate above was derived from a measured failure in the backtests, not chosen by feel.
          Filled squares are blocking. The desk trades only when the column is empty.
        </p>
      </section>

      <div className="grid two" style={{ marginBottom: "1.25rem" }}>
        <section className="panel">
          <h2>The market</h2>
          <Sparkline points={d.sparkline} />
          <dl>
            <div className="stat"><dt>RF / WETH</dt><dd>{d.market.mid.toExponential(4)}</dd></div>
            <div className="stat"><dt>RF / USD</dt><dd>${d.market.rfUsd.toPrecision(5)}</dd></div>
            <div className="stat"><dt>volume 24h</dt><dd><Count value={d.market.volume24hWeth} decimals={2} /> WETH</dd></div>
            <div className="stat"><dt>trades 24h</dt><dd><Count value={d.market.trades24h} decimals={0} /></dd></div>
            <div className="stat"><dt>realised vol, hourly</dt><dd>{pct(d.market.hourlyVol)}</dd></div>
            <div className="stat"><dt>pool depth</dt><dd>{d.pool.virtualWeth.toFixed(1)} WETH / {n(d.pool.virtualRf)} RF</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>The candidate book: idle rewards, founding member</h2>
          <span className="big"><Count value={d.book.usd} decimals={2} prefix="$" /></span>
          <dl style={{ marginTop: "0.9rem" }}>
            <div className="stat"><dt>unclaimed RF</dt><dd><Count value={d.book.rf} decimals={2} /></dd></div>
            <div className="stat"><dt>unclaimed WETH</dt><dd>{d.book.weth.toFixed(8)}</dd></div>
            <div className="stat"><dt>Friends that could deposit</dt><dd>{d.friends.filter((f) => f.activated).length} of {d.friends.length}</dd></div>
            <div className="stat"><dt>deposited so far</dt><dd>nothing, contract not deployed</dd></div>
          </dl>
          <p className="note">
            This is reward money that had not been claimed. It sits in each Friend&rsquo;s own ERC-6551
            wallet, and the Bank can only ever touch what its owner has approved, up to a cap the
            owner sets. Deposits from anyone else stay closed until the contracts are audited by
            someone who is not us.
          </p>
        </section>
      </div>

      <section className="finding">
        <h2>Why this desk exists</h2>
        <p>
          The $RAREFRIENDS market is a Uniswap v4 pool whose hook takes <strong>5% of every swap</strong>{" "}
          and routes it to the ActivationManager, which streams it to activated Friends. The pool&rsquo;s
          own <strong>lpFee is {d.pool.lpFee}</strong>.
        </p>
        <p>
          So the people who supply the liquidity and the people who collect the fees are different
          people. Nobody outside the protocol has ever had a reason to provide liquidity, and
          measurably, almost nobody has:{" "}
          <strong>
            third-party liquidity in this pool is currently{" "}
            {d.pool.thirdPartyLiquidity === "0" ? "exactly zero" : n(Number(d.pool.thirdPartyLiquidity) / 1e18, 2)}
          </strong>
          . The protocol&rsquo;s own seed position is {d.pool.marketOwnsAll ? "100.00%" : "nearly all"} of it.
        </p>
        <p>
          Every number on this page is read from chain, not from an API.{" "}
          <a href="https://github.com/Halldon-Inc/bank-of-friends">Run <code>npm run verify</code></a>{" "}
          and check all 37 assertions yourself.
        </p>
      </section>

      <section className="panel">
        <h2>The Friends behind that number</h2>
        <p className="note" style={{ marginTop: 0 }}>
          These are the founding member&rsquo;s <strong>activated</strong> Friends, which are the ones
          holding idle rewards and so the ones that could fund a book. They are
          <strong> not depositors</strong>: nothing has been deposited, because the contract is written,
          tested and not deployed. An earlier version of this page listed every Friend in the wallet
          under &ldquo;founding depositors&rdquo;, unactivated ones included, and that was simply untrue.
        </p>
        <div className="friends">
          {d.friends.filter((f) => f.activated).map((f, i) => (
            <figure className="friend" key={`${f.collection}-${f.id}`} style={{ animationDelay: `${i * 60}ms` }}>
              {f.image ? (
                <div className={`friend-art ${f.collection === "Generations" && f.generation >= 1 ? "world" : "portrait"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.image} alt={`${f.collection} #${f.id}`} />
                </div>
              ) : (
                <div className="friend-art portrait" style={{ border: "1px dotted var(--line)" }} />
              )}
              <figcaption>
                <div className="friend-id">
                  {f.collection === "Genesis" ? "GENESIS" : `GEN-${f.generation}`} #{f.id}
                </div>
                <div className="friend-meta">tier {f.tier} / 4</div>
                <div className="friend-meta">{n(f.earnings, 2)} RF idle</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </>
  );
}
