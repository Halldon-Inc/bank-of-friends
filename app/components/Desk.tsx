"use client";

import { useEffect, useRef, useState } from "react";
import Sparkline from "./Sparkline";
import type { Desk } from "@/lib/desk";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null, d = 2) => (v == null ? "not yet measurable" : `${(v * 100).toFixed(d)}%`);
const usd = (v: number) => `$${n(v, 2)}`;

/** Gate names come from the strategy (GATE_LABELS) via the API; this only covers a stale cache. */
const LABEL: Record<string, string> = {
  reversals72h: "swings in 72h", drift72h: "trend over 72h", walkForward7d: "last week replayed",
  inventory: "inventory", drawdown: "drawdown", breaker: "breaker",
};
const VERDICT = { met: "met", blocking: "blocking", unmeasured: "not yet" } as const;
const MARK = { met: "□", blocking: "■", unmeasured: "◌" } as const;

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

/** "in 21h 40m" until the next allocate() is callable, "now" once it is. */
function until(ts: number, now: number) {
  const s = ts - now / 1000;
  if (s <= 0) return "callable now";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `in ${h}h ${m}m`;
}

export default function DeskView() {
  const [d, setD] = useState<Desk | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boot, setBoot] = useState(0);          // how many gates have resolved on screen
  const [pulse, setPulse] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  async function load(isRefresh = false) {
    try {
      const r = await fetch("/api/desk", { cache: "no-store" });
      if (!r.ok) throw new Error(`the desk API answered ${r.status}`);
      const j = (await r.json()) as Desk;
      setD(j); setErr(null); setNow(Date.now());
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
          The desk is off, as it is by default. It retries every minute.
        </p>
      </div>
    );
  }

  if (!d) {
    return (
      <section className="docs-hero" aria-busy="true">
        <p className="docs-hero-line"><span className="blink">Reading the chain</span></p>
        <p className="status-sub">robinhood chain 4663 &middot; a week of swaps</p>
      </section>
    );
  }

  const status = (g: Desk["gates"][number]) => g.status ?? (g.ok ? "met" : "blocking");
  const active = d.friends.filter((f) => f.activated);
  const rw = d.rewards, vl = d.volumeLoop;
  const deskWord = d.state === "armed" ? "Quoting" : d.state === "halted" ? "Halted" : "Off";

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

      {!rw.hookRewardsOk && (
        <p className="docs-alarm" role="alert">
          ALARM: the hook now sends its 5% to {rw.hookRewards}, not to the ActivationManager
          ({rw.activationManager}). Friends are no longer the fee recipients. Everything below
          assumes they are.
        </p>
      )}

      <section className={`docs-hero${pulse ? " pulse" : ""}`} aria-live="polite">
        <div className="docs-hero-cell">
          <span className="docs-hero-label">the book</span>
          <span className="docs-hero-value"><Count value={d.book.usd} decimals={2} prefix="$" /></span>
          <span className="docs-hero-sub">
            {n(d.book.rf, 0)} RF and {d.book.weth.toFixed(4)} WETH, held in kind: the founding
            member&rsquo;s unclaimed rewards across {active.length} Friends
          </span>
        </div>
        <div className="docs-hero-cell">
          <span className="docs-hero-label">depositors</span>
          <span className="docs-hero-value">0 on chain</span>
          <span className="docs-hero-sub">
            the contract is written and tested, not deployed. Accounts opened in the hall are
            kept in your own browser.
          </span>
        </div>
        <div className="docs-hero-cell">
          <span className="docs-hero-label">the desk</span>
          <span className="docs-hero-value docs-desk-state">{deskWord}</span>
          <span className="docs-hero-sub">{d.headline}</span>
        </div>
      </section>

      <section className="panel docs-block">
        <h2>Arming conditions: live</h2>
        {d.gates.map((g, i) => {
          const s = status(g);
          return (
            <div key={g.gate} className={`gate${s === "blocking" ? " blocked" : ""}${s === "unmeasured" ? " unmeasured" : ""}${i < boot ? " in" : " pending"}`}>
              <span className="gate-mark" aria-hidden="true">{i < boot ? MARK[s] : "·"}</span>
              <span className="gate-name">{g.label ?? LABEL[g.gate] ?? g.gate}</span>
              <span className="gate-detail">{i < boot ? g.detail : "reading…"}</span>
              <span className="gate-verdict">{i < boot ? VERDICT[s] : ""}</span>
            </div>
          );
        })}
        <p className="note">
          The desk would quote only when every row is met. A row that is not yet measurable has too
          little history to judge; it never counts as met, and it is not a failure either.
          One ask and one bid at most, each a {d.grid.step * 100}% band, loss-lock {d.grid.lockBps / 100}%
          (a round trip nets at least {(d.grid.makerEdge * 100).toFixed(2)}% before gas).
        </p>
      </section>

      <div className="grid two docs-block">
        <section className="panel">
          <h2>The market, hourly</h2>
          <Sparkline points={d.sparkline} />
          <dl>
            <div className="stat"><dt>RF / WETH</dt><dd>{d.market.mid.toExponential(4)}</dd></div>
            <div className="stat"><dt>volume 24h</dt><dd><Count value={d.market.volume24hWeth} decimals={2} /> WETH</dd></div>
            <div className="stat"><dt>trades 24h</dt><dd><Count value={d.market.trades24h} decimals={0} /></dd></div>
            <div className="stat"><dt>trend 24h / 72h</dt><dd>{pct(d.market.drift24h, 1)} / {pct(d.market.drift72h, 1)}</dd></div>
            <div className="stat"><dt>completed swings, 72h</dt><dd>{d.market.reversals72h ?? "not yet measurable"}</dd></div>
            <div className="stat"><dt>pool depth</dt><dd>{d.pool.virtualWeth.toFixed(1)} WETH / {n(d.pool.virtualRf)} RF</dd></div>
            <div className="stat"><dt>price history</dt><dd>{(d.market.historyHours / 24).toFixed(1)} days</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>Where rewards come from, and when</h2>
          <dl>
            <div className="stat"><dt>streaming now</dt><dd>{rw.streamWethPerWeek.toFixed(2)} WETH + {n(rw.streamRfPerWeek)} RF / week</dd></div>
            <div className="stat"><dt>queued for next week</dt><dd>{rw.pendingWeth.toFixed(2)} WETH + {n(rw.pendingRf)} RF</dd></div>
            <div className="stat"><dt>next allocate()</dt><dd>{until(rw.nextAllocateTs, now)}</dd></div>
            <div className="stat"><dt>total reward weight</dt><dd>{n(rw.totalWeight)}</dd></div>
            <div className="stat"><dt>hook fee goes to</dt><dd>{rw.hookRewardsOk ? "the ActivationManager, as expected" : "SOMEWHERE ELSE"}</dd></div>
          </dl>
          <p className="note">
            Fees are paid a week late: the hook funds a queue, and allocate() streams the whole
            queue over the next seven days. This week&rsquo;s rewards are last week&rsquo;s
            trading, so a yield quoted off them is quoting the past.
          </p>
        </section>
      </div>

      <section className="finding docs-block">
        <h2>Why this desk exists</h2>
        <p>
          The $RAREFRIENDS market is a Uniswap v4 pool whose hook takes <strong>5% of every swap</strong>{" "}
          and routes it to activated Friends. The pool&rsquo;s own <strong>lpFee is {d.pool.lpFee}</strong>,
          so whoever supplies liquidity earns nothing. Third-party liquidity is{" "}
          <strong>{d.pool.thirdPartyLiquidity === "0" ? "exactly zero" : n(Number(d.pool.thirdPartyLiquidity) / 1e18, 2)}</strong>:
          the protocol&rsquo;s own seed is {d.pool.marketOwnsAll ? "100.00%" : "nearly all"} of it.
        </p>
        <p>
          The hook has no liquidity callbacks, so liquidity never pays the toll. The desk would quote
          only as <strong>range orders inside the pool</strong>: it would become the outside liquidity
          the pool never had, it never swaps, and so it never pays 5%. Every taker who crosses its
          ranges still pays 5% to every activated Friend.
        </p>
        <p>
          Every number on this page is read from chain.{" "}
          <a href="https://github.com/Halldon-Inc/bank-of-friends">Run <code>npm run verify</code></a>{" "}
          to check the protocol assertions yourself.
        </p>
      </section>

      <section className="panel docs-block docs-truth">
        <h2>Volume and rewards: the truth</h2>
        <p>
          Rewards are the 5%, so more volume pays every Friend more. That does not mean the bank
          should make volume. <strong>Takers who cross the bank&rsquo;s quotes pay 5% to every
          activated Friend; the bank never pays the toll itself.</strong> If it traded to paint the chart, a
          round trip of V WETH would pay 0.0975V in fees and members would get back only their
          share s of all reward weight:
        </p>
        <p className="docs-formula">net to members = &minus;0.0975 &times; V &times; (1 &minus; s)</p>
        <table className="docs-table">
          <thead><tr><th>member share s</th><th>cost per 1 WETH round trip</th><th>outside volume needed to break even</th></tr></thead>
          <tbody>
            <tr>
              <td>founding member today, {(vl.memberShare * 100).toFixed(3)}%</td>
              <td>{vl.costPerWethRoundTrip.toFixed(4)} WETH</td>
              <td>{vl.inducedMultiple == null ? "n/a" : `${n(vl.inducedMultiple, 0)}x`}</td>
            </tr>
            {[0.01, 0.1, 0.5].map((s) => (
              <tr key={s}><td>{s * 100}%</td><td>{(0.0975 * (1 - s)).toFixed(4)} WETH</td><td>{((1.95 * (1 - s)) / s).toFixed(1)}x</td></tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          It is never positive for the payer, and at any realistic share it is a transfer from
          members to every other Friend. It is also wash trading. The bank does not do it.
        </p>
      </section>

      <div className="grid two docs-block">
        <section className="panel">
          <h2>The book: idle rewards, founding member</h2>
          <span className="big"><Count value={d.book.usd} decimals={2} prefix="$" /></span>
          <dl style={{ marginTop: "0.9rem" }}>
            <div className="stat"><dt>unclaimed RF</dt><dd><Count value={d.book.rf} decimals={2} /></dd></div>
            <div className="stat"><dt>unclaimed WETH</dt><dd>{d.book.weth.toFixed(8)}</dd></div>
            <div className="stat"><dt>Friends that could deposit</dt><dd>{active.length} of {d.friends.length}</dd></div>
            <div className="stat"><dt>deposited so far</dt><dd>nothing, contract not deployed</dd></div>
          </dl>
          <p className="note">
            Reward money that has been earned but not claimed. It waits in the ActivationManager, a
            claim always pays it into the Friend&rsquo;s own ERC-6551 wallet, and the bank only ever
            moves what its own claim delivered, up to caps the owner sets. Each Friend keeps its own
            box, in kind: no shares, no pooled unit.
          </p>
        </section>

        <section className="panel">
          <h2>The Genesis floor (research, not in the contract)</h2>
          <dl>
            <div className="stat"><dt>Reserve pays per Genesis</dt><dd>{n(d.reserve.payoutRf)} RF{d.reserve.conversionEnabled === false ? " (conversion OFF)" : ""}</dd></div>
            <div className="stat"><dt>that RF sold through the pool (F)</dt><dd>{usd(d.reserve.floorUsd)}</dd></div>
            <div className="stat"><dt>convert below</dt><dd>{usd(d.genesis.convertBelowUsd)}</dd></div>
            <div className="stat"><dt>max bid to buy and activate</dt><dd>{usd(d.genesis.maxBidUsd)}</dd></div>
          </dl>
          <p className="note">
            Max bid = F {usd(d.genesis.parts.floorUsd)} + one queued stream&rsquo;s share{" "}
            {usd(d.genesis.parts.nextStreamUsd)} &minus; the 100,000 RF activation{" "}
            {usd(d.genesis.parts.activationUsd)} &minus; a two-sigma week of RF risk{" "}
            {usd(d.genesis.parts.marginUsd)}. Any Genesis offered above it is not worth buying to the
            bank; one offered below F is worth more to the Reserve than to its seller.
          </p>
        </section>
      </div>

      <section className="panel docs-block">
        <h2>The Friends behind the book</h2>
        <p className="note" style={{ marginTop: 0 }}>
          The founding member&rsquo;s <strong>activated</strong> Friends: the ones earning rewards,
          and so the ones that could fund a box. Nothing has been deposited yet.
        </p>
        <div className="friends">
          {active.map((f, i) => (
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
                <div className="friend-meta">{n(f.earnings, 2)} RF + {f.earningsWeth.toFixed(4)} WETH idle</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </>
  );
}
