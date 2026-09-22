import Sparkline from "@/components/Sparkline";
import { getDeskData, type Desk } from "@/lib/desk";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const n = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;

/** Called in-process. No self-fetch: an earlier version HTTP-fetched its own API
 *  and guessed the port, so the page silently rendered the error state whenever
 *  the server was not on 3000. */
async function getDesk(): Promise<Desk | null> {
  try {
    return await getDeskData();
  } catch {
    return null;
  }
}

const LABEL: Record<string, string> = {
  volume24h: "volume 24h",
  trades24h: "trades 24h",
  drift24h: "drift 24h",
  drift1h: "drift 1h",
  volFloor: "vol floor",
  volCeiling: "vol ceiling",
  inventory: "inventory",
  drawdown: "drawdown",
  breaker: "breaker",
};

export default async function Page() {
  const d = await getDesk();

  if (!d) {
    return (
      <main className="shell">
        <header className="masthead">
          <h1 className="wordmark">The Bank of Friends</h1>
          <p className="tagline">a desk that is flat until the market pays it</p>
        </header>
        <div className="err">
          <p style={{ margin: 0 }}>
            Cannot reach Robinhood Chain right now, so there is nothing honest to show.
            The desk is flat, as it is by default. Refresh in a moment.
          </p>
        </div>
      </main>
    );
  }

  const blocked = d.gates.filter((g) => !g.ok);
  const passing = d.gates.length - blocked.length;

  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">The Bank of Friends</h1>
        <p className="tagline">a desk that is flat until the market pays it</p>
        <div className="masthead-meta">
          <span>Robinhood Chain 4663</span>
          <span>block {Number(d.block).toLocaleString("en-US")}</span>
          <span>$RAREFRIENDS ${d.market.rfUsd.toPrecision(4)}</span>
          <span>{new Date(d.asOf).toISOString().replace("T", " ").slice(0, 19)}Z</span>
        </div>
      </header>

      {/* ---------------------------------------------------------- status */}
      <section className="status" aria-live="polite">
        <div className="dither" aria-hidden="true" />
        <p className="status-word flat">
          {d.armed ? <span className="status-word armed">ARMED</span> : <span className="blink">FLAT</span>}
        </p>
        <p className="status-sub">
          {d.armed
            ? `all ${d.gates.length} conditions met | the desk is working the grid`
            : `waiting on ${blocked.length} of ${d.gates.length} conditions | ${passing} met`}
        </p>
      </section>

      {/* ----------------------------------------------------------- gates */}
      <section className="panel" style={{ marginBottom: "1.25rem" }}>
        <h2>Arming conditions &mdash; live</h2>
        {d.gates.map((g) => (
          <div key={g.gate} className={`gate${g.ok ? "" : " blocked"}`}>
            <span className={`gate-mark ${g.ok ? "gate-pass" : "gate-fail"}`} aria-hidden="true">
              {g.ok ? "□" : "■"}
            </span>
            <span className="gate-name">{LABEL[g.gate] ?? g.gate}</span>
            <span className="gate-detail">{g.detail}</span>
            <span className="gate-verdict">{g.ok ? "met" : "blocking"}</span>
          </div>
        ))}
        <p className="note">
          Every gate above was derived from a measured failure in the backtests, not chosen by feel.
          Filled squares are blocking. The desk trades only when the column is empty.
        </p>
      </section>

      {/* ------------------------------------------------------- market + book */}
      <div className="grid two" style={{ marginBottom: "1.25rem" }}>
        <section className="panel">
          <h2>The market</h2>
          <Sparkline points={d.sparkline} />
          <dl>
            <div className="stat"><dt>RF / WETH</dt><dd>{d.market.mid.toExponential(4)}</dd></div>
            <div className="stat"><dt>RF / USD</dt><dd>${d.market.rfUsd.toPrecision(5)}</dd></div>
            <div className="stat"><dt>volume 24h</dt><dd>{d.market.volume24hWeth.toFixed(2)} WETH</dd></div>
            <div className="stat"><dt>trades 24h</dt><dd>{n(d.market.trades24h)}</dd></div>
            <div className="stat"><dt>realised vol, hourly</dt><dd>{pct(d.market.hourlyVol)}</dd></div>
            <div className="stat"><dt>pool depth</dt><dd>{d.pool.virtualWeth.toFixed(1)} WETH / {n(d.pool.virtualRf)} RF</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>The book &mdash; idle rewards, founding member</h2>
          <span className="big">${n(d.book.usd, 2)}</span>
          <dl style={{ marginTop: "0.9rem" }}>
            <div className="stat"><dt>unclaimed RF</dt><dd>{n(d.book.rf, 2)}</dd></div>
            <div className="stat"><dt>unclaimed WETH</dt><dd>{d.book.weth.toFixed(8)}</dd></div>
            <div className="stat"><dt>Friends enrolled</dt><dd>{d.friends.filter((f) => f.activated).length}</dd></div>
            <div className="stat"><dt>deposits from others</dt><dd>closed</dd></div>
          </dl>
          <p className="note">
            This is reward money that had not been claimed. It sits in each Friend&rsquo;s own ERC-6551
            wallet, and the Bank can only ever touch what its owner has approved, up to a cap the
            owner sets. Deposits from anyone else stay closed until the contracts are audited by
            someone who is not us.
          </p>
        </section>
      </div>

      {/* --------------------------------------------------------- the finding */}
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
            third-party liquidity in this pool is currently {d.pool.thirdPartyLiquidity === "0" ? "exactly zero" : n(Number(d.pool.thirdPartyLiquidity) / 1e18, 2)}
          </strong>
          . The protocol&rsquo;s own seed position is {d.pool.marketOwnsAll ? "100.00%" : "nearly all"} of it.
        </p>
        <p>
          Every number on this page is read from chain, not from an API.{" "}
          <a href="https://github.com/Halldon-Inc/bank-of-friends">Run <code>npm run verify</code></a> and
          check all 37 assertions yourself.
        </p>
      </section>

      {/* ------------------------------------------------------------ friends */}
      <section className="panel">
        <h2>Founding depositors</h2>
        <div className="friends">
          {d.friends.map((f) => (
            <figure className="friend" key={`${f.collection}-${f.id}`}>
              {f.image ? (
                // A hardwired Generations Friend renders as an isometric WORLD that sits
                // in the middle of its 512x512 SVG, so at tile size the character is an
                // unreadable speck and needs a zoom-crop. A Genesis portrait and an
                // un-hardwired temp Friend are full-bleed pixel art: zooming those cuts
                // their heads off.
                <div
                  className={`friend-art ${
                    f.collection === "Generations" && f.generation >= 1 ? "world" : "portrait"
                  }`}
                >
                  {/* Inline data: URI, so lazy-loading saves nothing and leaves tiles
                      blank below the fold on tall narrow screens. */}
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
                <div className="friend-meta">
                  {f.activated ? `tier ${f.tier} / 4` : "not activated"}
                </div>
                <div className="friend-meta">
                  {f.activated ? `${n(f.earnings, 2)} RF idle` : "—"}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <hr className="rule" />

      <footer>
        <p>
          Nothing here is financial advice and nothing here is a forecast. The desk is currently{" "}
          {d.armed ? "armed" : "flat"} and holds no third-party funds. Backtests cover 8,777 swaps
          across the pool&rsquo;s entire 5.6-day history; that is a short and unusual sample, and it is
          presented as evidence of what has happened, not a claim about what will.
        </p>
        <p>
          Built for the Rare Friends Vibeathon. Source, backtests and the verification harness:{" "}
          <a href="https://github.com/Halldon-Inc/bank-of-friends">github.com/Halldon-Inc/bank-of-friends</a>
        </p>
      </footer>
    </main>
  );
}
