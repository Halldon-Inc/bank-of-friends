"use client";

/**
 * THE VAULT: a wall of safe deposit doors, one per Friend.
 *
 * The wall is always a full wall. Doors with a box behind them are numbered and
 * carry their Friend's portrait; the door of the Friend you are playing as stands
 * open. The rest are drawn as they are: VACANT, or "not yet enrolled" for other
 * activated Friends in a wallet you looked up. Nothing on the wall is invented, so
 * an empty bank looks like an empty bank rather than a crowded one.
 *
 * Each box holds its own RF and its own WETH, in kind. The pooled book above the
 * wall is drawn as TWO bars, one per asset, each made of the boxes' own segments:
 * it is the boxes laid end to end, so it cannot disagree with them. What was
 * deposited and the desk's result are two inks in each box's bars, and withdraw is
 * per asset and always available.
 */

import { useEffect, useMemo, useState } from "react";
import { accountId, boxRf, boxWeth, removeAccount, totals, withdrawAsset, type Account } from "@/lib/accounts";
import CloseAccount from "./CloseAccount";
import type { WalletFriend } from "./Hall";
import { Arrival } from "./AccountPanel";
import { VaultHeadline, type BankTotals, type ProtocolIdle } from "./VaultHolds";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v: number) => `$${n(v, 2)}`;
const signed = (v: number, d: number) => `${v >= 0 ? "+" : "-"}${n(Math.abs(v), d)}`;
const no = (i: number) => String(i + 1).padStart(2, "0");

/** Six across and at least four down, like a real wall of boxes. */
const COLS = 6, MIN_DOORS = 24;

type Door =
  | { kind: "box"; no: string; account: Account }
  | { kind: "pending"; no: string; friend: WalletFriend }
  | { kind: "vacant"; no: string };

function Portrait({ src, collection }: { src: string | null; collection: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" className={collection === "Generations" ? "world" : "portrait"} />
    : <span className="door-noart" aria-hidden="true" />;
}

/** One asset's bar inside a box: deposited in solid ink, the desk's result hatched. */
function AssetBar({ deposited, pnl, owed = 0, max, asset, digits }: { deposited: number; pnl: number; owed?: number; max: number; asset: string; digits: number }) {
  const scale = (v: number) => `${max > 0 ? Math.min(100, (Math.max(0, v) / max) * 100) : 0}%`;
  const kept = pnl < 0 ? deposited + pnl : deposited;
  return (
    <div className="box-asset">
      <span className="box-asset-name">{asset}</span>
      <span className="box-bar" role="img"
        aria-label={`${asset}: deposited ${n(deposited, digits)}, desk ${pnl < 0 ? "loss" : "gain"} ${signed(pnl, digits)}`}>
        <span className="box-deposited" style={{ width: scale(kept) }} />
        {pnl > 0 && <span className="box-pnl" style={{ width: scale(pnl) }} />}
        {pnl < 0 && <span className="box-loss" style={{ width: scale(-pnl) }} />}
        {owed > 0 && <span className="box-owed" style={{ width: scale(owed) }} />}
      </span>
      <span className="box-asset-num">{n(deposited + pnl, digits)}</span>
    </div>
  );
}

/**
 * The pooled book for ONE asset: a ruled bar made of each box's segment, numbered
 * like its door, followed by the hatched amount that not-yet-enrolled Friends in
 * the looked-up wallet are holding idle. Never one solid slab.
 */
function PoolBar({ asset, digits, parts, pending, owed = 0 }: {
  asset: string; digits: number;
  parts: { no: string; amount: number; mine: boolean }[];
  pending: number;
  /** Already committed by enrolled Friends and on its way at their caps. */
  owed?: number;
}) {
  const banked = parts.reduce((a, p) => a + p.amount, 0);
  const whole = banked + owed + pending;
  const pct = (v: number) => `${whole > 0 ? (v / whole) * 100 : 0}%`;
  return (
    <div className="pool-row">
      <span className="pool-name">{asset}</span>
      <span className="pool-bar" role="img"
        aria-label={`${asset}: ${n(banked, digits)} banked across ${parts.length} boxes${pending > 0 ? `, ${n(pending, digits)} unclaimed by Friends not yet enrolled` : ""}`}>
        {parts.map((p) => p.amount > 0 && (
          <span key={p.no} className={`pool-seg${p.mine ? " is-mine" : ""}`} style={{ width: pct(p.amount) }}>
            <b>{p.no}</b>
          </span>
        ))}
        {owed > 0 && <span className="pool-seg is-owed" style={{ width: pct(owed) }} />}
        {pending > 0 && <span className="pool-seg is-pending" style={{ width: pct(pending) }} />}
      </span>
      <span className="pool-num">{n(banked, digits)}</span>
    </div>
  );
}

export default function VaultPanel({
  accounts, rfUsd, ethUsd, onGoToDesk, onChange, current, walletFriends, bank, idle,
}: {
  bank: BankTotals | null;
  idle: ProtocolIdle | null;
  accounts: Account[];
  rfUsd: number;
  ethUsd: number;
  onGoToDesk: () => void;
  onChange: (next: Account[]) => void;
  /** The box id of the Friend being played. Its door stands open. */
  current: string;
  walletFriends: WalletFriend[];
}) {
  const t = totals(accounts, rfUsd, ethUsd);

  const doors: Door[] = useMemo(() => {
    const list: Door[] = accounts.map((a, i) => ({ kind: "box", no: no(i), account: a }));
    const enrolled = new Set(accounts.map((a) => a.id));
    for (const f of walletFriends) {
      if (!f.activated || enrolled.has(accountId(f.collection, f.id))) continue;
      list.push({ kind: "pending", no: no(list.length), friend: f });
    }
    const size = Math.max(MIN_DOORS, Math.ceil(list.length / COLS) * COLS);
    while (list.length < size) list.push({ kind: "vacant", no: no(list.length) });
    return list;
  }, [accounts, walletFriends]);

  const [picked, setPicked] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  useEffect(() => {
    if (picked && accounts.some((a) => a.id === picked)) return;
    setPicked(accounts.find((a) => a.id === current)?.id ?? accounts[0]?.id ?? null);
  }, [accounts, current, picked]);
  const open = accounts.find((a) => a.id === picked) ?? null;
  const openNo = doors.find((d) => d.kind === "box" && d.account.id === picked)?.no ?? "";

  const pendingRf = doors.reduce((a, d) => a + (d.kind === "pending" ? d.friend.idleRf : 0), 0);
  const pendingWeth = doors.reduce((a, d) => a + (d.kind === "pending" ? d.friend.idleWeth : 0), 0);
  const boxes = doors.filter((d): d is Extract<Door, { kind: "box" }> => d.kind === "box");

  // Bars inside a box share one scale per asset across the wall, so boxes compare.
  const maxRf = Math.max(0, ...accounts.map((a) => Math.max(a.boxRf, boxRf(a)) + a.owedRf));
  const maxWeth = Math.max(0, ...accounts.map((a) => Math.max(a.boxWeth, boxWeth(a)) + a.owedWeth));

  const closingAcct = accounts.find((a) => a.id === closing);
  if (closingAcct) {
    return (
      <CloseAccount
        account={closingAcct}
        onConfirm={() => { setClosing(null); onChange(removeAccount(closingAcct.id)); }}
        onCancel={() => setClosing(null)}
      />
    );
  }

  return (
    <div className="vault">
      <VaultHeadline bank={bank} idle={idle} onGoToDesk={onGoToDesk} />
      <p className="acct-kicker">{bank?.deployed ? "your boxes" : "demo book"}, in this browser <span className="sim-stamp" title="Boxes are kept in this browser. The contract is not deployed.">simulated</span></p>
      {t.depositors === 0 ? (
        <>
          <p className="vault-big">empty</p>
          <p className="vault-sub">Every door is vacant. Each Friend that joins gets its own box here, holding its own RF and its own WETH.</p>
        </>
      ) : (
        <>
          <p className="vault-big">{usd(t.usd)}</p>
          <p className="vault-sub">
            {n(t.rf)} RF and {t.weth.toFixed(5)} WETH in <strong>{t.depositors}</strong> {t.depositors === 1 ? "box" : "boxes"}.
            No shares: each box is paid out in kind.
          </p>
          <div className="pool">
            <PoolBar asset="RF" digits={0} pending={pendingRf} owed={t.owedRf}
              parts={boxes.map((d) => ({ no: d.no, amount: boxRf(d.account), mine: d.account.id === current }))} />
            <PoolBar asset="WETH" digits={4} pending={pendingWeth} owed={t.owedWeth}
              parts={boxes.map((d) => ({ no: d.no, amount: boxWeth(d.account), mine: d.account.id === current }))} />
            <p className="pool-key">
              {(t.owedRf > 0 || t.owedWeth > 0) && <><span className="pool-seg is-owed" /> on its way at the members&rsquo; caps</>}
              {(pendingRf > 0 || pendingWeth > 0) && <><span className="pool-seg is-pending" /> unclaimed by Friends not yet enrolled</>}
            </p>
          </div>
        </>
      )}

      <ul className="door-wall" aria-label="Safe deposit boxes">
        {doors.map((d) => {
          if (d.kind === "vacant") {
            return <li key={d.no} className="door is-vacant"><span className="door-no">{d.no}</span><span className="door-lock" /><span className="door-tag">vacant</span></li>;
          }
          if (d.kind === "pending") {
            return (
              <li key={d.no} className="door is-pending" title={`${d.friend.label}: not yet enrolled`}>
                <span className="door-no">{d.no}</span>
                <Portrait src={d.friend.imageUrl} collection={d.friend.collection} />
                <span className="door-tag">not yet enrolled</span>
              </li>
            );
          }
          const isOpen = d.account.id === picked;
          return (
            <li key={d.no} className={`door is-box${isOpen ? " is-open" : ""}${d.account.id === current ? " is-mine" : ""}`}>
              <button type="button" onClick={() => setPicked(d.account.id)} aria-pressed={isOpen} aria-label={`Box ${d.no}, ${d.account.label}`}>
                <span className="door-no">{d.no}</span>
                <Portrait src={d.account.imageUrl} collection={d.account.collection} />
                <span className="door-tag">{d.account.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {open ? (
        <div className="box">
          <div className="box-door">
            <Portrait src={open.imageUrl} collection={open.collection} />
            <span className="box-name">Box {openNo}: {open.label}</span>
            <span className="box-meta">daily caps {n(open.capPerDayRf)} RF · {open.capPerDayWeth} WETH</span>
          </div>
          <AssetBar asset="RF" deposited={open.boxRf} pnl={open.pnlRf} owed={open.owedRf} max={maxRf} digits={0} />
          <AssetBar asset="WETH" deposited={open.boxWeth} pnl={open.pnlWeth} owed={open.owedWeth} max={maxWeth} digits={5} />
          <Arrival account={open} rfUsd={rfUsd} ethUsd={ethUsd} />
          <p className="box-pnl-line">
            your share of desk gains: {signed(open.pnlRf, 0)} RF, {signed(open.pnlWeth, 5)} WETH{open.pnlRf === 0 && open.pnlWeth === 0 ? " (the desk has never traded)" : ""}
          </p>
          <div className="box-actions">
            <button type="button" onClick={() => onChange(withdrawAsset(open.id, "rf"))} disabled={boxRf(open) <= 0}>
              {boxRf(open) > 0 ? "Take out RF" : "RF taken out"}
            </button>
            <button type="button" onClick={() => onChange(withdrawAsset(open.id, "weth"))} disabled={boxWeth(open) <= 0}>
              {boxWeth(open) > 0 ? "Take out WETH" : "WETH taken out"}
            </button>
          </div>
          <p className="hall-small" style={{ margin: "4px 0 0" }}>Taking one out keeps your account open.</p>
          <button type="button" className="hall-lever close-open" onClick={() => setClosing(open.id)}>
            Close account and take everything home
          </button>
          <p className="vault-legend">
            <span className="box-deposited" /> deposited
            <span className="box-pnl" /> desk gain
            <span className="box-loss" /> desk loss
            <span className="box-owed" /> on its way
          </p>
        </div>
      ) : (
        <button type="button" className="hall-lever" onClick={onGoToDesk}>Open my account at the desk</button>
      )}
    </div>
  );
}
