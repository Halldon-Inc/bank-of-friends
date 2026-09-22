"use client";

/**
 * THE VAULT HOLDS: the pooled RF and WETH, shown where nobody can miss it.
 *
 * Two sources, never mixed:
 *  - `bank`: the FriendBank contract's own totals. Only once it is deployed.
 *  - `protocolIdle`: rewards Friends have earned and not yet claimed, protocol-
 *    wide, read from chain. Real money, just not in the bank yet.
 *
 * Until launch there is NO pool total anywhere: the plaque shows what Friends have
 * earned and not yet claimed, protocol-wide (it sits in the ActivationManager, not
 * in Friend wallets, and the reader's figure is a slight upper bound), and the
 * vault says it opens at launch. A made-up pool would be
 * the most bullish number on the page and the least true one.
 */

import { useEffect, useRef, useState } from "react";

export type BankTotals = { deployed: boolean; address?: string | null; members?: number; rf: number; weth: number; usd: number };
export type ProtocolIdle = { rf: number; weth: number; usd: number; friends?: number; asOf?: string };

/** What /api/desk actually sends. Any figure may be null while it is unmeasured. */
export type ApiBank = {
  deployed: boolean; address?: string | null;
  rfIdle?: number | null; wethIdle?: number | null; rfInAsk?: number | null; wethInBid?: number | null;
  activeFriends?: number | null; holders?: number | null; usd?: number | null;
  /** The summary quant also serves: idle plus committed, and holders. Preferred when present. */
  rf?: number | null; weth?: number | null; members?: number | null;
};
export type ApiIdle = { rf?: number | null; weth?: number | null; usd?: number | null; friends?: number | null; asOf?: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Read the API's figures into the plaque's, and REFUSE rather than guess: a bank
 * total needs the contract deployed and both assets measured; the idle figure
 * needs both assets measured. Anything else is "not available", and the plaque
 * says the vault opens at launch.
 */
export function readTotals(bank?: ApiBank | null, idle?: ApiIdle | null): { bank: BankTotals | null; idle: ProtocolIdle | null } {
  let b: BankTotals | null = null;
  if (bank?.deployed) {
    const idleRf = num(bank.rfIdle), idleW = num(bank.wethIdle);
    const rf = num(bank.rf) ?? (idleRf !== null ? idleRf + (num(bank.rfInAsk) ?? 0) : null);
    const w = num(bank.weth) ?? (idleW !== null ? idleW + (num(bank.wethInBid) ?? 0) : null);
    if (rf !== null && w !== null) {
      b = {
        deployed: true, address: bank.address ?? null, rf, weth: w,
        usd: num(bank.usd) ?? 0, members: num(bank.members) ?? num(bank.holders) ?? num(bank.activeFriends) ?? 0,
      };
    }
  } else if (bank) {
    b = { deployed: false, rf: 0, weth: 0, usd: 0 };
  }
  const irf = num(idle?.rf), iw = num(idle?.weth);
  const i = irf !== null && iw !== null
    ? { rf: irf, weth: iw, usd: num(idle?.usd) ?? 0, friends: num(idle?.friends) ?? undefined, asOf: idle?.asOf }
    : null;
  return { bank: b, idle: i };
}

/** Compact for the plaque: 83.2M, 12.4K, 5,094. */
export function compact(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}K`;
  return Math.round(v).toLocaleString("en-US");
}
export const weth = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4));
export const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/**
 * A number that counts to its new value instead of jumping. Instant under reduced
 * motion, and it never animates from zero on first paint: it starts where it is.
 */
export function Tick({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current, delta = value - start;
    if (delta === 0) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value; setShown(value); return;
    }
    const t0 = performance.now(), dur = 900;
    let id = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const v = start + delta * e;
      from.current = v; setShown(v);
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [value]);
  return <>{format(shown)}</>;
}

/** What the plaque says, in two short lines. Also used by the marquee. */
export function plaqueLines(bank?: BankTotals | null, idle?: ProtocolIdle | null) {
  if (bank?.deployed) return { kind: "bank" as const, head: "THE VAULT HOLDS", rf: bank.rf, weth: bank.weth, usd: bank.usd };
  if (idle) return { kind: "idle" as const, head: "EARNED, NOT YET CLAIMED", rf: idle.rf, weth: idle.weth, usd: idle.usd };
  return { kind: "none" as const, head: "THE VAULT", rf: 0, weth: 0, usd: 0 };
}

/** The headline of the vault panel. */
export function VaultHeadline({ bank, idle, onGoToDesk }: { bank?: BankTotals | null; idle?: ProtocolIdle | null; onGoToDesk: () => void }) {
  if (bank?.deployed) {
    return (
      <div className="vault-holds is-live">
        <p className="vault-holds-kicker">the vault holds, on chain</p>
        <p className="vault-holds-total">
          <b><Tick value={bank.rf} format={compact} /> RF</b> + <b><Tick value={bank.weth} format={weth} /> WETH</b>
        </p>
        <p className="vault-holds-sub">
          <Tick value={bank.usd} format={dollars} /> across {bank.members ?? 0} {bank.members === 1 ? "Friend" : "Friends"}
        </p>
      </div>
    );
  }
  return (
    <div className="vault-holds is-prelaunch">
      <p className="vault-holds-kicker">the vault opens at launch</p>
      {idle ? (
        <>
          <p className="vault-holds-waiting">Earned by Friends and not yet claimed</p>
          <p className="vault-holds-idle">
            <b><Tick value={idle.rf} format={compact} /> RF</b> + <b><Tick value={idle.weth} format={weth} /> WETH</b>{" "}
            <i>(<Tick value={idle.usd} format={dollars} />)</i>
          </p>
          <p className="vault-holds-sub">
            Protocol-wide, read from chain.{" "}
            <button type="button" className="vault-holds-cta" onClick={onGoToDesk}>Bring yours in</button>
          </p>
        </>
      ) : (
        <p className="vault-holds-sub">The contract is not deployed, so there is no pool yet.</p>
      )}
    </div>
  );
}
