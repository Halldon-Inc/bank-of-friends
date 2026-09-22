"use client";

/**
 * CLOSE ACCOUNT AND TAKE EVERYTHING HOME.
 *
 * One action. The main view shows only what comes home, per asset, one line about
 * the revokes, and one button. The calls it would sign sit in a collapsed "what
 * this signs". Closing also removes the bank's access to the Friend's wallet in the
 * same step, so there is nothing to remember afterwards.
 */

import { CLOSE_CALLS, CLOSE_SUMMARY, CLOSE_TESTS, type Account } from "@/lib/accounts";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function CloseAccount({ account, onConfirm, onCancel }: {
  account: Account; onConfirm: () => void; onCancel: () => void;
}) {
  // What comes home is the whole box, per asset: deposited plus desk gains (and,
  // on chain, the share of any open order). The demo has no open orders.
  const rows = [
    { asset: "RF", amount: account.boxRf + account.pnlRf, d: 0 },
    { asset: "WETH", amount: account.boxWeth + account.pnlWeth, d: 5 },
  ];
  return (
    <div className="close">
      <p className="acct-kicker">close account <span className="sim-stamp">simulated</span></p>
      <p className="acct-head">Coming home to you</p>
      <table className="close-home">
        <tbody>
          {rows.map((r) => (
            <tr key={r.asset} data-asset={r.asset}>
              <th>{r.asset}</th>
              <td className="close-total">{n(r.amount, r.d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="acct-intro">Closing also removes the bank&rsquo;s access to your Friend&rsquo;s wallet, in the same step.</p>

      <button type="button" className="hall-lever close-go" onClick={onConfirm}>
        Close account and take everything home
      </button>
      <button type="button" className="acct-close acct-center" onClick={onCancel}>Keep my account open</button>

      <details className="acct-signs">
        <summary>What this signs</summary>
        <ol className="acct-steps">
          {CLOSE_CALLS.map((c) => <li key={c}><code>{c}</code></li>)}
        </ol>
        <p className="hall-small" style={{ margin: "4px 0" }}>
          One signature if your wallet can batch calls, otherwise three prompts in a row.
        </p>
        <p className="hall-small" style={{ margin: "4px 0" }}>{CLOSE_SUMMARY}</p>
        <small className="acct-tests">{CLOSE_TESTS.join(" · ")}</small>
      </details>
    </div>
  );
}
