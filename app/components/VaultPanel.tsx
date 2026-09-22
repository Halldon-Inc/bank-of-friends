"use client";

/**
 * THE VAULT: the book, and the one number that justifies the whole project.
 *
 * A grid quotes BOTH sides, so it needs RF to sell and WETH to buy, and each side
 * has to clear the minimum economic fill. That is why the headline here is not the
 * total but the BALANCED total: one Friend's rewards are ~94% WETH and ~6% RF, so
 * its RF side is a few dollars and it can buy and can never economically sell.
 *
 * Watching that bar cross $116 as Friends join is the argument for a bank, as a
 * number instead of a slogan.
 */

import { MIN_VIABLE_BOOK_USD, totals, type Account } from "@/lib/accounts";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v: number) => `$${n(v, 2)}`;

export default function VaultPanel({
  accounts, rfUsd, ethUsd, onGoToDesk,
}: {
  accounts: Account[];
  rfUsd: number;
  ethUsd: number;
  onGoToDesk: () => void;
}) {
  const t = totals(accounts, rfUsd, ethUsd);

  if (t.depositors === 0) {
    return (
      <div className="vault">
        <p className="acct-kicker">the book</p>
        <p className="vault-big">empty</p>
        <p className="hall-lede" style={{ margin: "0 0 12px" }}>
          Nobody has opened an account yet. The vault shows the real idle rewards of the Friends
          that join, so it stays empty until one does.
        </p>
        <button type="button" className="hall-lever" onClick={onGoToDesk}>Open the first account</button>
      </div>
    );
  }

  return (
    <div className="vault">
      <p className="acct-kicker">the book</p>
      <p className="vault-big">{usd(t.usd)}</p>
      <p className="vault-sub">
        across <strong>{t.depositors}</strong> {t.depositors === 1 ? "depositor" : "depositors"}
      </p>

      <dl className="acct-stats">
        <div><dt>pooled RF</dt><dd>{n(t.rf)} <i>{usd(t.rfSideUsd)}</i></dd></div>
        <div><dt>pooled WETH</dt><dd>{t.weth.toFixed(5)} <i>{usd(t.wethSideUsd)}</i></dd></div>
      </dl>

      <p className="acct-head">Can this book quote both sides?</p>
      <div className="vault-bar" role="img"
        aria-label={`Balanced book ${usd(t.balancedUsd)} of the ${usd(MIN_VIABLE_BOOK_USD)} needed`}>
        <span style={{ width: `${Math.min(100, (t.balancedUsd / MIN_VIABLE_BOOK_USD) * 100).toFixed(1)}%` }} />
      </div>
      <p className={`vault-verdict${t.viable ? " is-viable" : ""}`}>
        {t.viable
          ? `Yes. ${usd(t.balancedUsd)} balanced, over the ${usd(MIN_VIABLE_BOOK_USD)} floor.`
          : `Not yet. ${usd(t.balancedUsd)} balanced, against a ${usd(MIN_VIABLE_BOOK_USD)} floor.`}
      </p>
      <p className="hall-small">
        A market maker quotes <strong>both</strong> sides, so what counts is the smaller one. These
        rewards arrive roughly 94% WETH and 6% RF, which is why a single Friend can buy and can
        never economically sell, and why pooling is the point rather than a nicety.
      </p>

      <p className="acct-head">Depositors</p>
      <ul className="vault-list">
        {accounts.map((a) => (
          <li key={a.id}>
            {a.imageUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={a.imageUrl} alt="" className={a.collection === "Generations" ? "world" : "portrait"} />
              : <span className="picker-noart" aria-hidden="true" />}
            <span className="vault-name">{a.label}</span>
            <span className="vault-meta">{n(a.idleRf)} RF · {a.idleWeth.toFixed(5)} WETH</span>
            <span className="vault-meta">{a.signature ? "mandate signed" : "unsigned"}</span>
          </li>
        ))}
      </ul>

      <p className="hall-small">
        Every balance here is read from chain for that Friend. The accounts themselves are kept in
        this browser and <strong>nothing has moved</strong>: the contract is written, tested at 20/20
        and not deployed, and deposits from anyone but the builder stay closed until an outside audit.
      </p>
    </div>
  );
}
