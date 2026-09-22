"use client";

/**
 * Doorway to the hall: look up a wallet, see every Friend with its artwork, walk in.
 *
 * Deliberately NOT the FriendSDK runtime. Its gate requires a Generations NFT of
 * generation >= 1, which excludes Genesis entirely, and the Genesis is where the
 * money is: ~4,462 RF of idle rewards against ~31 RF across six Gen-3s. The
 * vibeathon's rules make the SDK optional for a tool, so the gate here is ours:
 * any ACTIVATED Friend can walk in, because an activated Friend is one with a
 * reward stream, which is the only thing the bank actually cares about.
 */

import { useState } from "react";
import Hall, { type HallFriend } from "./Hall";

type ApiFriend = HallFriend & {
  activated: boolean; bankEligible: boolean; gameEligible: boolean; excludedReason: string | null;
};

const n = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function HallEntry() {
  const [query, setQuery] = useState("");
  const [friends, setFriends] = useState<ApiFriend[] | null>(null);
  const [idleUsd, setIdleUsd] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<HallFriend | null>(null);

  async function look(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setError(""); setFriends(null);
    try {
      const r = await fetch(`/api/friends?address=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Lookup failed (${r.status}).`);
      setFriends(j.friends);
      setIdleUsd(j.idleUsd ?? 0);
      if (!j.friends?.length) setError("No Rare Friends in that wallet yet.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (chosen) return <Hall friend={chosen} onLeave={() => setChosen(null)} />;

  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">The Hall</h1>
        <p className="tagline">walk any Friend into the bank &mdash; Genesis included</p>
      </header>

      <section className="panel">
        <h2>Who is banking today?</h2>
        <form className="picker-form" onSubmit={look}>
          <input
            type="text" autoComplete="off" spellCheck={false}
            placeholder="wallet address or name.eth"
            aria-label="Wallet address or ENS name"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={busy || !query.trim()}>{busy ? "reading…" : "Look up"}</button>
        </form>
        {error && <p className="picker-error" role="alert">{error}</p>}

        {friends && friends.length > 0 && (
          <>
            <p className="note" style={{ marginTop: "0.9rem" }}>
              ${n(idleUsd)} sitting idle. Pick the Friend that walks in. Its idle rewards
              become the book at the desk.
            </p>
            <div className="picker-grid">
              {friends.map((f) => (
                <button
                  type="button" key={`${f.collection}-${f.id}`}
                  className={`picker-friend${f.activated ? "" : " is-inert"}`}
                  disabled={!f.activated}
                  onClick={() => setChosen(f)}
                >
                  {f.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.imageUrl} alt="" className={f.collection === "Generations" && f.generation >= 1 ? "world" : "portrait"} />
                  ) : <span className="picker-noart" aria-hidden="true" />}
                  <span className="picker-label">{f.label}</span>
                  <span className="picker-meta">{f.activated ? `${n(f.idleRf)} RF idle` : "not activated"}</span>
                  {!f.gameEligible && f.activated && <span className="picker-tag">SDK hides this</span>}
                </button>
              ))}
            </div>
            <p className="note">
              Every activated Friend can walk in here. FriendSDK games would show you only
              the Generations ones, which in this wallet is {n(friends.filter((f) => f.idleRf).reduce((a, f) => a + (f.gameEligible ? f.idleRf : 0), 0), 0)} RF
              of the {n(friends.reduce((a, f) => a + f.idleRf, 0), 0)} RF actually sitting there.
            </p>
          </>
        )}
      </section>

      <hr className="rule" />
      <footer>
        <p>
          Everything in the hall is simulated. The desk runs the same strategy module the
          backtests use, so when it stands down it stands down for the reason it would with
          real money. <a href="/">Back to the live desk</a>
        </p>
      </footer>
    </main>
  );
}
