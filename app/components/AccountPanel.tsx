"use client";

/**
 * THE DESK: opening an account, and nothing else.
 *
 * It does not consult the market at all. Joining and trading are separate: the bank
 * is open whether or not it is quoting this week, and the build that put the lever
 * here made a Genesis holder think he had been turned away because the only action
 * available returned "SAT OUT".
 *
 * DUMMY PROOF: every view has ONE obvious primary button that says what happens.
 * The calls a button signs sit in a collapsed "what this signs", not in the way.
 * Honesty is the SIMULATED stamp plus one short line by the guarantees.
 *
 * Every grant and guarantee is the contract's own wording, with the tests that
 * prove it, from lib/accounts. Nothing here may be broader than the contract.
 */

import { useState } from "react";
import {
  GRANTS, GUARANTEES, SIGNUP_STEPS, SWEEP_GRANT, WALLET_SCOPE, accountId, onItsWay,
  type Account,
} from "@/lib/accounts";
import type { HallFriend } from "./Hall";
import CloseAccount from "./CloseAccount";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v: number) => `$${n(v, 2)}`;

/**
 * Modest starting caps: a quarter of what is idle today, rounded DOWN to one
 * significant figure. A cap is a ceiling you should be comfortable with, and a
 * default of "almost everything" (the old default was 4,800 of 4,823 RF) is not one.
 */
function modest(idle: number, floor: number) {
  const q = idle * 0.25;
  if (q <= floor) return floor;
  const mag = 10 ** Math.floor(Math.log10(q));
  return Math.floor(q / mag) * mag;
}

/** The tests behind a line, small, so anyone can go and read them. */
const Tests = ({ names }: { names: readonly string[] }) => (
  <small className="acct-tests">{names.join(" · ")}</small>
);

/**
 * Today and on its way. The day-one rule is honest (the contract moves at most the
 * cap per asset per day), but on its own it made a $106 Friend open a $24 box and
 * look small for no reason. So both are shown: what is in the box now, and the
 * rest, with how many days it takes at the member's own caps.
 */
export function Arrival({ account, rfUsd, ethUsd }: { account: Account; rfUsd: number; ethUsd: number }) {
  const today = account.boxRf * rfUsd + account.boxWeth * ethUsd;
  const way = onItsWay(account, rfUsd, ethUsd);
  return (
    <dl className="arrival">
      <div>
        <dt>in your box today</dt>
        <dd>{n(account.boxRf)} RF + {account.boxWeth.toFixed(3)} WETH <i>({usd(today)})</i></dd>
      </div>
      {way.days > 0 && (
        <div className="is-coming">
          <dt>on its way</dt>
          <dd>
            the rest of your idle rewards, about <strong>{usd(way.usd)}</strong>, arriving over{" "}
            <strong>{way.days} {way.days === 1 ? "day" : "days"}</strong> at your caps
          </dd>
        </div>
      )}
    </dl>
  );
}

export default function AccountPanel({
  friend, account, onOpened, onClosed, onGoToVault, rfUsd, ethUsd,
}: {
  friend: HallFriend;
  account: Account | null;
  onOpened: (a: Account) => void;
  onClosed: (id: string) => void;
  onGoToVault: () => void;
  rfUsd: number;
  ethUsd: number;
}) {
  const [capRf, setCapRf] = useState(() => modest(friend.idleRf, 100));
  const [capWeth, setCapWeth] = useState(() => Number(modest(friend.idleWeth, 0.001).toPrecision(2)));
  const [sweep, setSweep] = useState(false);
  const [welcomed, setWelcomed] = useState(false);
  const [closing, setClosing] = useState(false);

  function open() {
    // The keeper's first visit: what it can claim today, in kind, up to the caps.
    onOpened({
      id: accountId(friend.collection, friend.id),
      label: friend.label,
      collection: friend.collection,
      tokenId: friend.id,
      imageUrl: friend.imageUrl,
      idleRf: friend.idleRf,
      idleWeth: friend.idleWeth,
      capPerDayRf: capRf,
      capPerDayWeth: capWeth,
      boxRf: Math.min(friend.idleRf, capRf),
      boxWeth: Math.min(friend.idleWeth, capWeth),
      owedRf: Math.max(0, friend.idleRf - capRf),
      owedWeth: Math.max(0, friend.idleWeth - capWeth),
      pnlRf: 0,
      pnlWeth: 0,
      sweep,
      openedAt: new Date().toISOString(),
    });
    setWelcomed(true);
  }

  if (account && closing) {
    return (
      <CloseAccount
        account={account}
        onConfirm={() => { setClosing(false); onClosed(account.id); }}
        onCancel={() => setClosing(false)}
      />
    );
  }

  if (account && welcomed) {
    return (
      <div className="acct-welcome">
        <p className="acct-kicker">account opened <span className="sim-stamp">simulated</span></p>
        <h3>Welcome to the First Bank of Friends.</h3>
        <p className="acct-line">
          <strong>{account.label}</strong> has an account in the vault. In the live bank the keeper would
          keep claiming on its own; there is nothing more to sign unless you change or close the account.
        </p>
        <Arrival account={account} rfUsd={rfUsd} ethUsd={ethUsd} />
        <button type="button" className="hall-lever" onClick={onGoToVault}>
          See my box in the vault
        </button>
        <button type="button" className="acct-close acct-center" onClick={() => setWelcomed(false)}>
          account details
        </button>
      </div>
    );
  }

  if (account) {
    return (
      <div className="acct">
        <p className="acct-kicker">your account <span className="sim-stamp">simulated</span></p>
        <dl className="acct-stats">
          <div><dt>Friend</dt><dd>{account.label}</dd></div>
          <div><dt>in your box</dt><dd>{n(account.boxRf + account.pnlRf)} RF · {(account.boxWeth + account.pnlWeth).toFixed(5)} WETH</dd></div>
          <div><dt>daily caps</dt><dd>{n(account.capPerDayRf)} RF · {account.capPerDayWeth} WETH</dd></div>
          <div><dt>also move extras</dt><dd>{account.sweep ? "on" : "off"}</dd></div>
        </dl>
        <button type="button" className="hall-lever" onClick={onGoToVault}>See my box in the vault</button>
        <button type="button" className="acct-close acct-center close-open" onClick={() => setClosing(true)}>
          Close account and take everything home
        </button>
      </div>
    );
  }

  const bankable = friend.idleRf > 0 || friend.idleWeth > 0;

  return (
    <div className="acct">
      <p className="acct-kicker">open an account <span className="sim-stamp">simulated</span></p>
      <p className="acct-intro">
        <strong>Sign up once.</strong> Once deployed, the bank&rsquo;s keeper would claim{" "}
        <strong>{friend.label}</strong>&rsquo;s rewards, today <strong>{n(friend.idleRf)} RF</strong> and{" "}
        <strong>{friend.idleWeth.toFixed(5)} WETH</strong>, into your own account, and keep doing it.
        Genesis included.
      </p>
      <p className="acct-plain">{WALLET_SCOPE}</p>

      <p className="acct-head">Daily caps, each asset on its own</p>
      <label className="acct-cap">
        <span>RF</span>
        <input
          type="number" min={1} step={100} value={capRf}
          onChange={(e) => setCapRf(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          aria-label="Daily cap in RF"
        />
      </label>
      <label className="acct-cap">
        <span>WETH</span>
        <input
          type="number" min={0.0001} step={0.001} value={capWeth}
          onChange={(e) => setCapWeth(Math.max(0.0001, Number(e.target.value) || 0.0001))}
          aria-label="Daily cap in WETH"
        />
      </label>
      <label className="acct-switch">
        <input type="checkbox" checked={sweep} onChange={(e) => setSweep(e.target.checked)} />
        <span>{SWEEP_GRANT.text} <Tests names={SWEEP_GRANT.tests} /></span>
      </label>

      <button type="button" className="hall-lever" onClick={open} disabled={!bankable}>
        Open my account
      </button>
      {!bankable && (
        <p className="picker-error" role="alert">
          This Friend holds no idle rewards, so there is nothing to deposit.
        </p>
      )}

      <details className="acct-signs">
        <summary>What this signs</summary>
        <ol className="acct-steps">
          {SIGNUP_STEPS.map((s) => <li key={s.what}><b>{s.what}</b> <code>{s.call}</code></li>)}
        </ol>
        <p className="hall-small" style={{ margin: "4px 0 8px" }}>
          One signature if your wallet can batch calls, otherwise three prompts in a row. The NFT never
          leaves your wallet.
        </p>
        <p className="acct-head">You let the Bank</p>
        <ul className="acct-list">
          {GRANTS.map((g) => <li key={g.text}>{g.text} <Tests names={g.tests} /></li>)}
        </ul>
      </details>

      <p className="acct-head">The bank cannot</p>
      <ul className="acct-list is-cannot">
        {GUARANTEES.map((g) => <li key={g.text}>{g.text} <Tests names={g.tests} /></li>)}
      </ul>
      <p className="hall-small" style={{ margin: "0 0 4px" }}>Unaudited, not deployed.</p>
    </div>
  );
}
