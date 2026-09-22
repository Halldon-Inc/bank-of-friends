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
/**
 * `pull` is the mean-reversion strength. Without it a "chop" week is a pure random
 * walk, which over 168 hours at 5.5% hourly drifts about 70% and trips the trend
 * gate every time: the lever then NEVER arms, which is not a game. Chop has to
 * actually chop, so the range-bound regimes pull back toward their anchor.
 */
/** Current RF/WETH mid. The simulated week is anchored here so the strategy sees
 *  inventory in the same units as the book it is given. */
const RF_PRICE_WETH = 5.7e-7;

const REGIMES = [
  { name: "dead calm",    trend: 0.0,   sigma: 0.004, pull: 0.02, volume: 8,   trades: 90 },
  { name: "slow bleed",   trend: -0.03, sigma: 0.010, pull: 0.00, volume: 40,  trades: 600 },
  { name: "hard dump",    trend: -0.10, sigma: 0.020, pull: 0.00, volume: 70,  trades: 900 },
  // Chop sigmas must clear the DERIVED vol floor (3.27% hourly) or the desk can
  // never arm and the lever is a no-op.
  { name: "quiet chop",   trend: 0.0,   sigma: 0.030, pull: 0.22, volume: 30,  trades: 400 },
  { name: "live chop",    trend: 0.0,   sigma: 0.048, pull: 0.26, volume: 55,  trades: 800 },
  { name: "wild chop",    trend: 0.0,   sigma: 0.075, pull: 0.30, volume: 90,  trades: 1400 },
  { name: "steady climb", trend: 0.03,  sigma: 0.028, pull: 0.05, volume: 60,  trades: 850 },
  { name: "melt up",      trend: 0.10,  sigma: 0.045, pull: 0.00, volume: 120, trades: 1800 },
];

function rollWeek(seedRef: { current: number }) {
  // LCG with the low bits discarded: the bottom bits of a 32-bit LCG have very
  // short periods, and taking `rnd() * REGIMES.length` off them repeats badly.
  const rnd = () => {
    seedRef.current = (Math.imul(seedRef.current, 1664525) + 1013904223) >>> 0;
    return (seedRef.current >>> 8) / 16777216;
  };
  const regime = REGIMES[Math.floor(rnd() * REGIMES.length)];
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // 168 hourly marks, Ornstein-Uhlenbeck around a drifting anchor.
  //
  // START AT THE REAL RF PRICE, not at 1.0. The strategy values inventory as
  // (book.rf * market.mid) / book.valueWeth, so feeding it a normalised index while
  // the book is priced in WETH made the inventory fraction come out at ten million
  // percent and the inventory gate blocked 100% of every regime. The lever could
  // never arm. Units have to match across the boundary.
  const path: number[] = [];
  let p = RF_PRICE_WETH, anchor = RF_PRICE_WETH;
  const perHour = Math.pow(1 + regime.trend, 1 / 24) - 1;
  for (let i = 0; i < 168; i++) {
    anchor *= 1 + perHour;
    const dev = Math.log(p / anchor);
    p = p * Math.exp(-regime.pull * dev + regime.sigma * gauss()) * (1 + perHour);
    path.push(p);
  }
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

/**
 * Turn the blocking gates into ONE sentence a person can act on. The nine-row table
 * is still available behind "why?", but it is not the headline: a list of nine
 * thresholds is a diagnostic, not an answer to "can I play".
 */
/**
 * The drift gates block movement in EITHER direction, so the wording has to follow
 * the sign. A fixed string said "the price has been falling all week" on a STEADY
 * CLIMB, which is the kind of contradiction that makes a player stop trusting the
 * thing entirely.
 */
function reasonFor(gate: string, m: { drift7d: number | null; drift24h: number; drift1h: number }) {
  const up7 = (m.drift7d ?? 0) > 0;
  switch (gate) {
    case "volume24h":
    case "trades24h": return "Too quiet. Barely anyone is trading today.";
    case "drift7d": return up7
      ? "The price has run up all week. The bank does not chase a rally."
      : "The price has fallen all week. Buying now is catching a knife.";
    case "drift24h": return m.drift24h > 0
      ? "The price jumped hard today. Too late to join."
      : "The price dropped hard today.";
    case "drift1h": return "The price is moving too fast right this minute.";
    case "volFloor": return "The price is barely moving, so there is nothing to earn.";
    case "volCeiling": return "Way too wild out there.";
    case "inventory": return "The bank is already holding too much RF.";
    case "drawdown": return "The bank is down. It stops itself until someone checks.";
    case "breaker": return "Someone has paused the desk.";
    default: return "Conditions are not right.";
  }
}
/** Priority order: name the most fundamental problem, not the first in the list. */
const REASON_ORDER = ["breaker", "drawdown", "drift7d", "drift24h", "volume24h", "trades24h", "volFloor", "volCeiling", "drift1h", "inventory"];
function plainReason(checks: { gate: string; ok: boolean }[], m: { drift7d: number | null; drift24h: number; drift1h: number }) {
  const blocked = new Set(checks.filter((c) => !c.ok).map((c) => c.gate));
  for (const g of REASON_ORDER) if (blocked.has(g)) return reasonFor(g, m);
  return "Conditions are not right.";
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
  // Seed from Math.random(), not Date.now(). An LCG seeded from adjacent
  // millisecond values produces correlated first draws, which showed up as the
  // same regime coming back several pulls in a row.
  const seed = useRef((Math.random() * 4294967296) >>> 0);
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
    const valueWeth = bookWeth + bookRf * RF_PRICE_WETH;
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
          <span className="bank-desktop">Walk to the desk. WASD or arrows, or tap where you want to go.</span>
          <span className="bank-mobile">Tap to walk to the desk.</span>
        </p>
      </div>

      {menu && (
        <GameMenu
          title={
            menu === "desk" ? "The Desk"
            : menu === "receipt" ? "Your receipt"
            : "Settings"
          }
          onClose={busy ? undefined : () => go(null)}
        >
          {/* ------------------------------------------------------------ THE DESK */}
          {menu === "desk" ? (
            <>
              <p className="bank-lede">
                Put 1 RF on the counter, then pull the lever. A week of market rolls, and the
                bank decides whether to trade it. <strong>Most weeks it will not.</strong>
              </p>

              <div className="bank-row">
                <button
                  type="button" disabled={!canDeposit || busy || paused}
                  onClick={() => void act(() => client.buy(1n), "purchase", () => setMessage("Deposited. Now pull the lever."))}
                >
                  Deposit 1 RF
                </button>
                <span className="bank-slips">{slips.toString()} on the counter</span>
              </div>
              {!canDeposit && <p className="bank-small">{snapshot.rfBalance < definition.price ? "Not enough simulated RF." : "Deposits pause until there is enough backing."}</p>}

              <button type="button" className="rf-frame-primary bank-lever" disabled={rolling || busy || paused} onClick={pullLever}>
                {rolling ? "rolling the week…" : week ? "Pull again" : "Pull the lever"}
              </button>

              {week && verdict && (
                <div className={`bank-verdict ${verdict.armed ? "armed" : "flat"} ${rolling ? "spinning" : ""}`}>
                  <p className="bank-regime">{week.regime.name}</p>
                  <p className="bank-word">{verdict.armed ? "TRADED" : "SAT OUT"}</p>
                  {!rolling && (
                    <p className="bank-because">
                      {verdict.armed
                        ? "Choppy and busy enough to be worth it."
                        : plainReason(verdict.checks, week.market)}
                    </p>
                  )}
                </div>
              )}

              {week && !rolling && (
                <>
                  <button type="button" disabled={busy || paused || (!pending && slips === 0n)} onClick={() => void settleWeek()}>
                    {pending ? "Finish the week" : slips > 0n ? "Cash out this week" : "Deposit first, then cash out"}
                  </button>
                  <details className="bank-why">
                    <summary>Why? Show the nine checks</summary>
                    <ul className="bank-gates">
                      {verdict!.checks.map((c: { gate: string; ok: boolean; detail: string }) => (
                        <li key={c.gate} className={c.ok ? "ok" : "blocked"}>
                          <span aria-hidden="true">{c.ok ? "□" : "■"}</span><b>{c.gate}</b><i>{c.detail}</i>
                        </li>
                      ))}
                    </ul>
                    <p className="bank-small">
                      The bank pays a 5% toll each way, so it only trades when a swing is big
                      enough to clear 10% and come back. Break-even step is {(BREAKEVEN_STEP * 100).toFixed(1)}%;
                      a round trip nets {(edgePerRoundTrip(0.15) * 100).toFixed(1)}%.
                      These are the real checks, not a mock.
                    </p>
                  </details>
                </>
              )}
            </>
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
