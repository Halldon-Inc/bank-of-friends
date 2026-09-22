"use client";

import { useState } from "react";

/**
 * Pick a Friend by looking at it.
 *
 * The FriendSDK picker renders a token id as text, so you choose blind between
 * Friends that look nothing alike. The artwork is already on chain and already
 * served as a data: URI, so there is nothing to host: this is the same approach the
 * meme machine on rare-friends-cards uses.
 *
 * It also shows the Friends the SDK hides. A Genesis cannot be a walking character
 * in an SDK game, but it can bank here, and it is where the money is. Saying that
 * out loud is better than silently dropping it from the list.
 */

type Friend = {
  id: string; collection: string; generation: number; tier: number;
  activated: boolean; label: string; imageUrl: string | null; wallet: string | null;
  idleRf: number; idleWeth: number;
  gameEligible: boolean; bankEligible: boolean; excludedReason: string | null;
};
type Result = {
  address: string; total: number; shown: number; idleUsd: number;
  bankEligible: number; gameEligible: number; friends: Friend[];
};

const n = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function FriendPicker() {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  async function look(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setError(""); setData(null); setPicked(null);
    try {
      const r = await fetch(`/api/friends?address=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Lookup failed (${r.status}).`);
      setData(j as Result);
      if (!j.friends?.length) setError("No Rare Friends in that wallet yet.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = data?.friends.find((f) => f.id === picked) ?? null;

  return (
    <section className="panel" id="enrol">
      <h2>Your Friends: enrol one</h2>

      <form className="picker-form" onSubmit={look}>
        <input
          type="text" inputMode="text" autoComplete="off" spellCheck={false}
          placeholder="wallet address or name.eth"
          aria-label="Wallet address or ENS name"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={busy || !query.trim()}>{busy ? "reading…" : "Look up"}</button>
      </form>

      {error && <p className="picker-error" role="alert">{error}</p>}

      {data && data.friends.length > 0 && (
        <>
          <p className="note" style={{ marginTop: "0.9rem" }}>
            {data.total} Friend{data.total === 1 ? "" : "s"} &middot;{" "}
            <strong>{data.bankEligible} can bank</strong> &middot; {data.gameEligible} can walk into the hall &middot;{" "}
            ${n(data.idleUsd)} sitting idle
          </p>

          <div className="picker-grid">
            {data.friends.map((f) => (
              <button
                type="button"
                key={`${f.collection}-${f.id}`}
                className={`picker-friend${picked === f.id ? " is-picked" : ""}${f.bankEligible ? "" : " is-inert"}`}
                aria-pressed={picked === f.id}
                onClick={() => setPicked(picked === f.id ? null : f.id)}
              >
                {f.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.imageUrl} alt="" className={f.collection === "Generations" && f.generation >= 1 ? "world" : "portrait"} />
                ) : (
                  <span className="picker-noart" aria-hidden="true" />
                )}
                <span className="picker-label">{f.label}</span>
                <span className="picker-meta">
                  {f.bankEligible ? `${n(f.idleRf)} RF idle` : "not activated"}
                </span>
                {!f.gameEligible && f.bankEligible && <span className="picker-tag">bank only</span>}
              </button>
            ))}
          </div>

          {chosen && (
            <div className="picker-detail">
              <h3>{chosen.label}</h3>
              <dl>
                <div className="stat"><dt>idle rewards</dt><dd>{n(chosen.idleRf)} RF + {chosen.idleWeth.toFixed(8)} WETH</dd></div>
                <div className="stat"><dt>Friend wallet</dt><dd>{chosen.wallet ? `${chosen.wallet.slice(0, 10)}…${chosen.wallet.slice(-6)}` : "none"}</dd></div>
                <div className="stat"><dt>can bank</dt><dd>{chosen.bankEligible ? "yes" : "no"}</dd></div>
                <div className="stat"><dt>can walk into the hall</dt><dd>{chosen.gameEligible ? "yes" : "no"}</dd></div>
              </dl>
              {chosen.excludedReason && <p className="note">{chosen.excludedReason}</p>}
              <p className="note">
                Enrolment is <strong>not open</strong>. The contracts are written and tested but
                deliberately undeployed until an external audit, so nothing here can take your
                money yet. When it opens you will sign twice from this Friend&rsquo;s own wallet,
                set your own per-day cap, and be able to revoke in one transaction.
              </p>
            </div>
          )}
        </>
      )}

      {!data && !error && (
        <p className="note" style={{ marginTop: "0.9rem" }}>
          The artwork is on chain, so this shows you what you are choosing. It lists
          <strong> every</strong> Friend, including the Genesis that FriendSDK games hide.
        </p>
      )}
    </section>
  );
}
