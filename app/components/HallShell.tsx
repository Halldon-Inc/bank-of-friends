"use client";

/**
 * The hall, plus the smallest possible way to swap Friends.
 *
 * You land already inside with a Friend on the marble. Choosing your own is an
 * overlay you open from the HUD, not a form you must complete first: the previous
 * version made you type a wallet before anything moved, which is a lot of work to
 * ask before someone knows whether they care.
 */

import { useCallback, useEffect, useState } from "react";
import Hall, { type HallFriend } from "./Hall";

type ApiFriend = HallFriend & { activated: boolean; gameEligible: boolean };

const n = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** If the showcase read fails we still need someone to stand in the hall. */
const FALLBACK: HallFriend = {
  id: "259", label: "Genesis #259", collection: "Genesis", generation: 0,
  imageUrl: null, idleRf: 4493, idleWeth: 0.0337,
};

export default function HallShell({ showcase }: { showcase: HallFriend | null }) {
  const [friend, setFriend] = useState<HallFriend>(showcase ?? FALLBACK);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [friends, setFriends] = useState<ApiFriend[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (showcase) setFriend(showcase); }, [showcase]);

  const look = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setError(""); setFriends(null);
    try {
      const r = await fetch(`/api/friends?address=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Lookup failed (${r.status}).`);
      setFriends(j.friends);
      if (!j.friends?.length) setError("No Rare Friends in that wallet yet.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [query, busy]);

  return (
    <>
      <Hall friend={friend} onLeave={() => setPicking(true)} />

      {picking && (
        <div className="hall-modal" role="dialog" aria-modal="true" aria-label="Choose a Friend">
          <div className="hall-panel">
            <header>
              <h2>Who is banking?</h2>
              <button type="button" onClick={() => setPicking(false)} aria-label="Close">&times;</button>
            </header>

            <p className="hall-lede">
              Any <strong>activated</strong> Friend can walk in, Genesis included. FriendSDK
              games only admit Generations NFTs, which is why this does not use one.
            </p>

            <form className="picker-form" onSubmit={look} style={{ margin: "0 14px 10px" }}>
              <input
                type="text" autoComplete="off" spellCheck={false}
                placeholder="your wallet or name.eth"
                aria-label="Wallet address or ENS name"
                value={query} onChange={(ev) => setQuery(ev.target.value)}
              />
              <button type="submit" disabled={busy || !query.trim()}>{busy ? "reading…" : "Find"}</button>
            </form>

            {error && <p className="picker-error" style={{ margin: "0 14px" }} role="alert">{error}</p>}

            {friends && friends.length > 0 && (
              <div className="picker-grid" style={{ margin: "10px 14px" }}>
                {friends.map((f) => (
                  <button
                    type="button" key={`${f.collection}-${f.id}`}
                    className={`picker-friend${f.activated ? "" : " is-inert"}`}
                    disabled={!f.activated}
                    onClick={() => { setFriend(f); setPicking(false); }}
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
            )}

            <p className="hall-small" style={{ margin: "0 14px" }}>
              Nothing is signed and nothing is spent. This only reads public state.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
