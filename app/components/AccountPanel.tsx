"use client";

/**
 * THE DESK: opening an account.
 *
 * This is deliberately the FIRST thing the desk offers and it does not consult the
 * market at all. Joining and trading are separate: the bank is open whether or not
 * it is quoting this week, and the previous build made a Genesis holder think he
 * had been turned away because the only action available returned "SAT OUT".
 */

import { useState } from "react";
import {
  GRANTS, GUARANTEES, MANDATE_STATEMENT, accountId, hasWallet, signMandate,
  type Account,
} from "@/lib/accounts";
import type { HallFriend } from "./Hall";

const n = (v: number, d = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** A sensible starting cap: today's idle balance, rounded down to something round. */
function suggestedCap(idleRf: number) {
  if (idleRf <= 0) return 100;
  const mag = 10 ** Math.max(1, Math.floor(Math.log10(idleRf)) - 1);
  return Math.max(mag, Math.floor(idleRf / mag) * mag);
}

export default function AccountPanel({
  friend, account, onOpened, onClosed,
}: {
  friend: HallFriend;
  account: Account | null;
  onOpened: (a: Account) => void;
  onClosed: (id: string) => void;
}) {
  const [cap, setCap] = useState(() => suggestedCap(friend.idleRf));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [welcomed, setWelcomed] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true); setNote("");
    const signedAt = new Date().toISOString();
    try {
      const { signature, signer } = await signMandate(friend.label, cap, signedAt);
      onOpened({
        id: accountId(friend.collection, friend.id),
        label: friend.label,
        collection: friend.collection,
        tokenId: friend.id,
        imageUrl: friend.imageUrl,
        idleRf: friend.idleRf,
        idleWeth: friend.idleWeth,
        capPerDayRf: cap,
        signature, signer, signedAt,
      });
      setWelcomed(true);
    } catch (e) {
      // A wallet present and declined is a decision, not a fault.
      const m = String((e as Error)?.message ?? e);
      setNote(/reject|denied|4001/i.test(m) ? "You declined the signature. Nothing was opened." : m.slice(0, 140));
    } finally {
      setBusy(false);
    }
  }

  if (account && welcomed) {
    return (
      <div className="acct-welcome">
        <p className="acct-kicker">account opened</p>
        <h3>Welcome to the First Bank of Friends.</h3>
        <p className="acct-line">
          <strong>{account.label}</strong> is a depositor. Its rewards keep arriving in its own
          wallet, and the bank may draw up to <strong>{n(account.capPerDayRf)} RF a day</strong> from it.
        </p>
        <p className="hall-small" style={{ margin: "10px 0 0" }}>
          {account.signature
            ? <>Signed by <code>{account.signer?.slice(0, 6)}…{account.signer?.slice(-4)}</code>. That signature granted no allowance and spent no gas.</>
            : <>Opened without a wallet signature, so it is recorded in this browser only.</>}
          {" "}Walk to <strong>the vault</strong> to see the book.
        </p>
        <button type="button" className="hall-lever" onClick={() => setWelcomed(false)}>
          See the account
        </button>
      </div>
    );
  }

  if (account) {
    return (
      <div className="acct">
        <p className="acct-kicker">your account</p>
        <dl className="acct-stats">
          <div><dt>Friend</dt><dd>{account.label}</dd></div>
          <div><dt>on deposit</dt><dd>{n(account.idleRf)} RF · {account.idleWeth.toFixed(5)} WETH</dd></div>
          <div><dt>daily cap</dt><dd>{n(account.capPerDayRf)} RF</dd></div>
          <div><dt>mandate</dt><dd>{account.signature ? "signed" : "unsigned, this browser"}</dd></div>
        </dl>
        <p className="hall-small">
          Nothing has actually moved: the contract is written and tested but <strong>not deployed</strong>.
          Closing the account is instant and needs nobody&rsquo;s permission, which is the same property
          the contract gives <code>withdraw</code>.
        </p>
        <button type="button" className="acct-close" onClick={() => onClosed(account.id)}>
          Close the account
        </button>
      </div>
    );
  }

  const bankable = friend.idleRf > 0 || friend.idleWeth > 0;

  return (
    <div className="acct">
      <p className="acct-kicker">open an account</p>
      <p className="hall-lede" style={{ margin: "0 0 10px" }}>
        <strong>{friend.label}</strong> brings <strong>{n(friend.idleRf)} RF</strong> and{" "}
        <strong>{friend.idleWeth.toFixed(5)} WETH</strong> of idle rewards. Genesis included: this is
        not a FriendSDK game, so nothing here turns a Genesis away.
      </p>

      <p className="acct-head">You grant</p>
      <ul className="acct-list">{GRANTS.map((g) => <li key={g}>{g}</li>)}</ul>

      <p className="acct-head">The bank cannot</p>
      <ul className="acct-list is-cannot">{GUARANTEES.map((g) => <li key={g}>{g}</li>)}</ul>

      <label className="acct-cap">
        <span>Most the bank may take per day</span>
        <input
          type="number" min={1} step={100} value={cap}
          onChange={(e) => setCap(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          aria-label="Daily cap in RF"
        />
        <span>RF</span>
      </label>
      <p className="hall-small" style={{ margin: "0 0 10px" }}>
        Set it to the smallest number you are comfortable with. It is a ceiling, not a target,
        and the contract clamps every collection to it.
      </p>

      <button type="button" className="hall-lever" onClick={open} disabled={busy || !bankable}>
        {busy ? "waiting for your wallet…" : hasWallet() ? "Sign the mandate" : "Open the account"}
      </button>
      {!bankable && (
        <p className="picker-error" role="alert">
          This Friend holds no idle rewards, so there is nothing to deposit.
        </p>
      )}
      {note && <p className="picker-error" role="alert">{note}</p>}
      <p className="hall-small">
        {hasWallet()
          ? "An EIP-712 signature of the statement below. No allowance, no transaction, no gas."
          : "No browser wallet found, so this is recorded in this browser and marked unsigned rather than dressed up as a signature."}
        {" "}&ldquo;{MANDATE_STATEMENT}&rdquo;
      </p>
    </div>
  );
}
