"use client";

/**
 * THE FIRST BANK OF FRIENDS
 *
 * Walk your Rare Friend into a banking hall. Four stations:
 *
 *   Teller window  deposit a simulated RF slip into the Bank
 *   The vault      the pooled book, and why one Friend's rewards are not enough
 *   Trading desk   pull the lever: a market week rolls and the REAL strategy module
 *                  decides whether to trade. Most weeks it refuses, and says why.
 *   The ledger     the findings that produced the gates
 *
 * The trading desk is not a mock. It imports the same lib/strategy.mjs that the
 * backtests and the live keeper use, so standing down here means standing down
 * for the same reason it would with real money.
 *
 * Every balance, price and reward in this game is SIMULATED and labelled as such.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld } from "@rarefriends/friendsdk/world-view";
import { validateWorld } from "@rarefriends/friendsdk/world";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GameSnapshot, type GamePlay } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundKit, type FriendSoundCue } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "@rarefriends/friendsdk/world-view.css";
import "./style.css";

import { BANK_WORLD, SPAWN, STATIONS } from "./world";
// @ts-expect-error - plain ESM, byte-identical to lib/strategy.mjs in the repo root
import { DEFAULT_GATES, evaluateRegime, realisedVol, drift, edgePerRoundTrip, BREAKEVEN_STEP } from "./strategy.mjs";

const world = validateWorld(BANK_WORLD as never);
const rf = (v: bigint) => `${formatGameAmount(v, 18)} RF`;

type Station = (typeof STATIONS)[number]["id"];
type Menu = Station | "settings" | "receipt" | null;

/* ------------------------------------------------------------------ the lever */
/**
 * Roll one simulated week of market and ask the real strategy what it would do.
 * The regimes are drawn from the shapes measured in the sweep, not invented here.
 */
const REGIMES = [
  { name: "dead calm", trend: 0.0, sigma: 0.004, volume: 8, trades: 90 },
  { name: "slow bleed", trend: -0.03, sigma: 0.010, volume: 40, trades: 600 },
  { name: "hard dump", trend: -0.10, sigma: 0.020, volume: 70, trades: 900 },
  { name: "quiet chop", trend: 0.0, sigma: 0.012, volume: 30, trades: 400 },
  { name: "live chop", trend: 0.0, sigma: 0.030, volume: 55, trades: 800 },
  { name: "wild chop", trend: 0.0, sigma: 0.055, volume: 90, trades: 1400 },
  { name: "steady climb", trend: 0.03, sigma: 0.028, volume: 60, trades: 850 },
  { name: "melt up", trend: 0.10, sigma: 0.045, volume: 120, trades: 1800 },
];

function rollWeek(seedRef: { current: number }) {
  const rnd = () => {
    seedRef.current = (seedRef.current * 1664525 + 1013904223) % 4294967296;
    return seedRef.current / 4294967296;
  };
  const regime = REGIMES[Math.floor(rnd() * REGIMES.length)];
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // 168 hourly marks for the week.
  const path: number[] = [];
  let p = 1;
  const perHour = Math.pow(1 + regime.trend, 1 / 24) - 1;
  for (let i = 0; i < 168; i++) { p = p * (1 + perHour) * Math.exp(regime.sigma * gauss()); path.push(p); }
  const lastDay = path.slice(-24);
  return {
    regime,
    market: {
      mid: path[path.length - 1],
      ethUsd: 2734.86,
      volume24hWeth: regime.volume,
      trades24h: regime.trades,
      drift24h: drift(lastDay),
      drift1h: drift(path.slice(-2)),
      drift7d: drift(path),
      hourlyVol: realisedVol(lastDay),
    },
  };
}

/* ================================================================== component */
export default function FirstBankOfFriends({ friendId, client, paused }: GameComponentProps) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [result, setResult] = useState<GamePlay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [week, setWeek] = useState<ReturnType<typeof rollWeek> | null>(null);
  const [rolling, setRolling] = useState(false);
  const [visits, setVisits] = useState<Record<string, boolean>>({});

  const sound = useRef<FriendSoundKit | null>(null);
  const locked = useRef(false);
  const epoch = useRef(0);
  const seed = useRef(Date.now() % 2147483647);
  const definition = client.definition;

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setMenu(null); setResult(null); setError(""); setMessage("");
    setBusy(false); setMuted(true); setWeek(null); setVisits({}); locked.current = false;
    void client.read()
      .then((v) => { if (version === epoch.current) setSnapshot(v); })
      .catch((c) => { if (version === epoch.current) setError(c instanceof Error ? c.message : "Could not open the bank."); });
    const pref = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(pref.matches);
    update(); pref.addEventListener("change", update);
    return () => { epoch.current++; sound.current?.dispose(); sound.current = null; pref.removeEventListener("change", update); };
  }, [client, friendId]);

  async function act(work: () => Promise<void>, cue?: FriendSoundCue, after?: () => void) {
    if (locked.current || paused) return;
    const version = epoch.current;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    void sound.current?.unlock();
    try {
      await work();
      const v = await client.read();
      if (version === epoch.current) { setSnapshot(v); if (cue) sound.current?.play(cue); after?.(); }
    } catch (c) {
      if (version === epoch.current) setError(c instanceof Error ? c.message : "The simulated action failed.");
    } finally {
      if (version === epoch.current) { locked.current = false; setBusy(false); }
    }
  }

  const go = (next: Menu) => {
    if (busy || paused) return;
    setMenu(next); setError(""); setMessage("");
    if (next) setVisits((v) => ({ ...v, [next]: true }));
  };

  /** The lever. Rolls a week, then asks the real strategy module. */
  function pullLever() {
    if (rolling || busy || paused) return;
    setRolling(true); setWeek(null);
    void sound.current?.unlock();
    const spin = reducedMotion ? 1 : 9;
    let i = 0;
    const tick = () => {
      const w = rollWeek(seed);
      setWeek(w);
      if (++i < spin) { setTimeout(tick, 70 + i * 22); }
      else { setRolling(false); sound.current?.play("reveal-common"); }
    };
    tick();
  }

  const verdict = useMemo(() => {
    if (!week || !snapshot) return null;
    const bookWeth = 0.029, bookRf = 3159;
    const valueWeth = bookWeth + bookRf * 5.7e-7;
    return evaluateRegime(week.market, { rf: bookRf, weth: bookWeth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES);
  }, [week, snapshot]);

  if (!snapshot) {
    return (
      <div className="bank-loading" role={error ? "alert" : "status"}>
        {error || "Opening the bank…"}
        {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => {})}>Retry</button>}
      </div>
    );
  }
  if (snapshot.friendId !== friendId) return <p role="alert">This session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const canDeposit =
    snapshot.rfBalance >= definition.price &&
    snapshot.freeStake >= maxPrize &&
    snapshot.freeStake + definition.price >= maxPrize;
  const pending = snapshot.plays.find((p) => p.outcomeId === null);
  const outcome = result?.outcomeId ? definition.outcomes[result.outcomeId - 1] : null;
  const slips = snapshot.consumables;
  const visited = Object.keys(visits).filter((k) => STATIONS.some((s) => s.id === k)).length;

  const settleWeek = () =>
    act(async () => {
      const version = epoch.current;
      const play = pending ?? (await client.play(1n))[0];
      const settled = await client.settle(play.id);
      if (version === epoch.current) { setResult(settled); setMenu("receipt"); }
    }, "reward");

  const feedback = (
    <p className="bank-feedback" role={error ? "alert" : "status"}>
      {error || message || (busy ? "Waiting for the simulated confirmation…" : "Every balance here is simulated.")}
    </p>
  );

  return (
    <section className="bank" aria-label={definition.name} aria-busy={busy}>
      <div className="bank-world" inert={Boolean(menu) || paused || undefined}>
        <GameWorld
          world={world}
          spawn={SPAWN as unknown as readonly [number, number]}
          interactions={STATIONS as never}
          friendId={friendId}
          paused={Boolean(menu) || paused}
          reducedMotion={reducedMotion}
          onInteract={(id) => go(id as Station)}
        />

        {/* Chrome matched to the fishing example: a bordered card with a hard
            offset shadow top-left, a 44px square icon button top-right at an 18px
            inset, and a small status line low-left. No full-width bar. */}
        <div className="bank-card">
          <small>Preview RF</small>
          <strong>{formatGameAmount(snapshot.rfBalance, 18)}<span>RF</span></strong>
          <em>{slips.toString()} slips</em>
        </div>

        {/* No title overlay. The fishing example has none, and a centred wordmark
            collides with the station prompts, which are the thing you actually read. */}

        <button type="button" className="bank-icon bank-settings" aria-label="Settings" onClick={() => go("settings")}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" />
          </svg>
        </button>

        <p className="bank-status">
          <span className="bank-desktop">WASD or arrows to walk &middot; tap a destination &middot; E at a window</span>
          <span className="bank-mobile">Tap to walk &middot; E or tap at a window</span>
          {visited < STATIONS.length && ` · ${STATIONS.length - visited} of ${STATIONS.length} windows unvisited`}
        </p>
      </div>

      {menu && (
        <GameMenu
          title={
            menu === "teller" ? "Teller window"
            : menu === "vault" ? "The vault"
            : menu === "desk" ? "Trading desk"
            : menu === "ledger" ? "The ledger"
            : menu === "receipt" ? "Your receipt"
            : "Settings"
          }
          onClose={busy ? undefined : () => go(null)}
        >
          {/* ---------------------------------------------------------- TELLER */}
          {menu === "teller" ? (
            <>
              <p>
                Deposit one simulated slip of {rf(definition.price)}. The Bank puts it to work only
                when the desk arms, which is most weeks not at all.
              </p>
              <table>
                <thead><tr><th>What the week did</th><th>Chance</th><th>Returns</th></tr></thead>
                <tbody>
                  {definition.outcomes.map((o) => (
                    <tr key={o.name}>
                      <td>{o.name}</td>
                      <td>{o.chanceBps / 100}%</td>
                      <td>{rf(o.reward)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="bank-small">
                Expected return 1.0354 RF per slip. One outcome loses. A desk that cannot lose is
                a desk that is lying to you.
              </p>
              <button
                type="button" className="rf-frame-primary" disabled={!canDeposit || busy || paused}
                onClick={() => void act(() => client.buy(1n), "purchase", () => setMessage("One simulated slip deposited."))}
              >
                Deposit one slip · {rf(definition.price)}
              </button>
              {!canDeposit && (
                <p>{snapshot.rfBalance < definition.price ? "Not enough simulated RF." : "Deposits pause until there is enough free backing."}</p>
              )}
            </>

          /* ----------------------------------------------------------- VAULT */
          ) : menu === "vault" ? (
            <>
              <p>The pooled book. This is reward money that was sitting unclaimed in Friend wallets.</p>
              <dl className="bank-stats">
                <div><dt>Founding member&rsquo;s idle rewards</dt><dd>$86</dd></div>
                <div><dt>Split</dt><dd>94% WETH / 6% RF</dd></div>
                <div><dt>Your simulated slips</dt><dd>{slips.toString()}</dd></div>
                <div><dt>Minimum viable book</dt><dd>$116 balanced</dd></div>
              </dl>
              <p>
                A grid is two-sided: it needs RF to sell and WETH to buy. At a 15% step each fill
                must clear <strong>$8.71</strong> to beat gas, and the RF side of one Friend&rsquo;s
                rewards is <strong>$4.94</strong>. So a single Friend cannot make a market at all.
              </p>
              <p className="bank-small">
                That is the whole reason this is a bank. Pooled, two or three Friends clear the
                floor. Protocol-wide idle rewards are roughly $30,000, about 250x the minimum.
              </p>
            </>

          /* ------------------------------------------------------------ DESK */
          ) : menu === "desk" ? (
            <>
              <p>
                Roll a week of market. The same strategy module the backtests use decides whether
                to trade. It refuses more often than it trades, and that is the point.
              </p>

              <button type="button" className="rf-frame-primary bank-lever" disabled={rolling || busy || paused} onClick={pullLever}>
                {rolling ? "rolling the week…" : week ? "Roll another week" : "Pull the lever"}
              </button>

              {week && verdict && (
                <div className={`bank-verdict ${verdict.armed ? "armed" : "flat"} ${rolling ? "spinning" : ""}`}>
                  <p className="bank-regime">{week.regime.name}</p>
                  <p className="bank-word">{verdict.armed ? "ARMED" : "FLAT"}</p>
                  {!rolling && (
                    <ul className="bank-gates">
                      {verdict.checks.map((c: { gate: string; ok: boolean; detail: string }) => (
                        <li key={c.gate} className={c.ok ? "ok" : "blocked"}>
                          <span aria-hidden="true">{c.ok ? "□" : "■"}</span>
                          <b>{c.gate}</b>
                          <i>{c.detail}</i>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {week && !rolling && (
                <button type="button" disabled={busy || paused || (!pending && slips === 0n)} onClick={() => void settleWeek()}>
                  {pending ? "Finish the pending week" : slips > 0n ? "Settle a deposit against this week" : "Deposit a slip at the teller first"}
                </button>
              )}

              <p className="bank-small">
                Break-even grid step is {(BREAKEVEN_STEP * 100).toFixed(2)}% because the pool takes 5% each way.
                At a 15% step a completed round trip nets {(edgePerRoundTrip(0.15) * 100).toFixed(2)}%, not 15%.
              </p>
            </>

          /* ---------------------------------------------------------- LEDGER */
          ) : menu === "ledger" ? (
            <>
              <p>What the research found, all of it reproducible from chain.</p>
              <ol className="bank-ledger">
                <li><b>The pool pays its liquidity providers nothing.</b> lpFee is 0, while the hook takes 5% of every swap and sends it to Friend holders.</li>
                <li><b>So nobody provides liquidity.</b> Third-party liquidity is exactly zero; the protocol&rsquo;s own seed is 100% of it.</li>
                <li><b>Every market-making strategy tested lost money</b> on the real tape: passive LP −43% to −55%, grid bots −39% to −87%, buying the dip −63% to −84%.</li>
                <li><b>A 10% round trip needs a &gt;10% swing that comes back.</b> $RAREFRIENDS did not swing, it slid 89%.</li>
                <li><b>So the desk is flat by default</b> and every gate here came from one of those failures.</li>
              </ol>
              <p className="bank-small">
                github.com/Halldon-Inc/bank-of-friends &middot; npm run verify checks 37 assertions
                against live chain state.
              </p>
            </>

          /* --------------------------------------------------------- RECEIPT */
          ) : menu === "receipt" && outcome ? (
            <div className="bank-receipt">
              <span aria-hidden="true">◇</span>
              <h3>{outcome.name}</h3>
              <p>{rf(outcome.reward)} returned on a {rf(definition.price)} slip · {outcome.chanceBps / 100}% chance</p>
              <button type="button" disabled={busy || paused} onClick={() => go(null)}>Keep the receipt</button>
              {outcome.reward > 0n && (
                <button
                  type="button" disabled={busy || paused}
                  onClick={() => void act(() => client.redeem(result!.outcomeId!, 1n), "reward", () => setMessage("Redeemed into your simulated balance."))}
                >
                  Redeem · {rf(outcome.reward)}
                </button>
              )}
            </div>

          /* -------------------------------------------------------- SETTINGS */
          ) : menu === "settings" ? (
            <>
              <button
                type="button" aria-pressed={!muted}
                onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}
              >
                {muted ? "Sound off" : "Sound on"}
              </button>
              <label>
                <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /> Reduce motion
              </label>
              <p className="bank-small">
                Every balance, price and reward in this game is simulated and resets on reload.
                Wallet connection and Friend ownership are verified by the SDK runtime, not by this game.
              </p>
            </>
          ) : null}
          {feedback}
        </GameMenu>
      )}
    </section>
  );
}
