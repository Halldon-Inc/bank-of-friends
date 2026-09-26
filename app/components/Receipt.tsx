"use client";

/**
 * THE RECEIPT: what went into a box and what comes home, per asset.
 *
 *   deposited        your Friend's rewards the bank harvested into your box
 *   swap desk        what the desk's swaps added or cost, net of both tolls
 *   toll rebate      your share of the toll the desk paid, streamed back as WETH rewards
 *   coming home      the sum, paid in kind
 *
 * Used by the vault box, by closing an account, and by the Trading Floor's simulated week.
 */

const n = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v: number, d: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${n(Math.abs(v), d)}`;

export type ReceiptLines = {
  depositedRf: number; depositedWeth: number;
  deskRf: number; deskWeth: number;
  rebateWeth: number;
};

export default function Receipt({ r, title = "Receipt", note, rfUsd, ethUsd, stamp = true }: {
  r: ReceiptLines; title?: string; note?: string; rfUsd?: number; ethUsd?: number; stamp?: boolean;
}) {
  const homeRf = r.depositedRf + r.deskRf;
  const homeWeth = r.depositedWeth + r.deskWeth + r.rebateWeth;
  const usd = rfUsd && ethUsd ? homeRf * rfUsd + homeWeth * ethUsd : null;
  const inUsd = rfUsd && ethUsd ? r.depositedRf * rfUsd + r.depositedWeth * ethUsd : null;
  return (
    <div className="receipt" role="group" aria-label={title}>
      <p className="receipt-head">{title}{stamp && <span className="sim-stamp">simulated</span>}</p>
      <table className="receipt-table">
        <thead><tr><th /><th>RF</th><th>WETH</th></tr></thead>
        <tbody>
          <tr><th>deposited</th><td>{n(r.depositedRf)}</td><td>{n(r.depositedWeth, 5)}</td></tr>
          <tr><th>swap desk</th><td className={r.deskRf < 0 ? "is-neg" : r.deskRf > 0 ? "is-pos" : ""}>{signed(r.deskRf, 0)}</td><td className={r.deskWeth < 0 ? "is-neg" : r.deskWeth > 0 ? "is-pos" : ""}>{signed(r.deskWeth, 5)}</td></tr>
          <tr><th>toll rebate</th><td>0</td><td>{signed(r.rebateWeth, 5)}</td></tr>
          <tr className="receipt-total"><th>coming home</th><td>{n(homeRf)}</td><td>{n(homeWeth, 5)}</td></tr>
        </tbody>
      </table>
      {usd != null && inUsd != null && (
        <p className="receipt-usd">coming home worth ${n(usd, 2)}, against ${n(inUsd, 2)} for what was deposited, both at the same prices</p>
      )}
      {note && <p className="receipt-note">{note}</p>}
    </div>
  );
}
