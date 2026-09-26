"use client";

/**
 * THE TRADING FLOOR: is the desk on, right now?
 *
 * The headline is the LIVE verdict from /api/desk and nothing else. The old lever
 * rolled a random week and printed TRADED in the same breath as /docs printing
 * FLAT, so a judge saw a desk that had both traded and not traded. A simulated
 * week still exists, below a rule, worded as a conditional ("would quote") and
 * stamped, so it can never be read as something that happened.
 */

import { useMemo, useRef, useState } from "react";
import { DEFAULT_GATES, evaluateRegime, measurePath } from "@/lib/strategy.mjs";
import type { ApiBank, ApiIdle } from "./VaultHolds";

export type LiveGate = { gate: string; ok: boolean; detail: string; label?: string; status?: "met" | "blocking" | "unmeasured" };
/** The fields of /api/desk the hall reads. Everything else there belongs to /docs. */
export type LiveStanding = {
  mode: "grid" | "edge" | "takeProfit" | "idle";
  reason: string;
  headline: string;
  ask: { lo: number; hi: number; frac: number; aboveMidPct: number } | null;
  edgeVsTakerPct: number | null;
  book?: { label: string; rf: number; usd: number };
  restingUsd: number | null;
  feeToFriendsIfFilledUsd: number | null;
};
/** The word on the board: the grid when it is armed, else the standing order, else off. */
export function floorWord(armed: boolean, standing?: LiveStanding | null) {
  if (armed) return "DESK ON";
  if (standing?.mode === "edge" || standing?.mode === "takeProfit") return "STANDING ORDER";
  return "DESK OFF";
}
export type LiveDesk = {
  asOf: string;
  armed: boolean;
  headline?: string;
  standing?: LiveStanding | null;
  gates: LiveGate[];
  thresholds?: { gridStep?: number; minReversals72h?: number; maxDrift72hSteps?: number };
  grid?: { step?: number; makerEdge?: number };
  market: { rfUsd: number; volume24hWeth: number; trades24h: number };
  rewards?: { nextAllocateAt?: string | null; streamRfPerWeek?: number; streamWethPerWeek?: number };
  keeper?: { harvested24hRf?: number; harvested24hWeth?: number };
  /** FriendBank's own totals; deployed=false until launch. */
  bank?: ApiBank | null;
  /** Rewards earned by activated Friends protocol-wide and not yet claimed. */
  protocolIdle?: ApiIdle | null;
};

/** A measurement that cannot be taken yet is not a market verdict. */
export const isPending = (g: LiveGate) => g.status === "unmeasured" || (g.status === undefined && /not yet measurable|history yet/i.test(g.detail));

const REASONS: Record<string, string> = {
  reversals72h: "The price is not swinging back and forth enough to earn on.",
  drift72h: "The price has trended too far over three days. A range desk waits.",
  walkForward7d: "Replayed over last week, the desk would not have paid.",
  volume24h: "Too quiet. Barely anyone is trading today.",
  trades24h: "Too quiet. Barely anyone is trading today.",
  volFloor: "The price is barely moving, so there is nothing to earn.",
  volCeiling: "Way too wild out there.",
  drift24h: "The price moved too far today.",
  drift1h: "The price is moving too fast right this minute.",
  drift7d: "The price has trended all week. The desk does not lean into a trend.",
  inventory: "The book is already leaning too far to one side.",
  drawdown: "The desk is down. It stops itself until someone checks.",
  breaker: "The breaker is tripped.",
};
const ORDER = ["breaker", "drawdown", "drift72h", "reversals72h", "walkForward7d", "drift7d", "drift24h", "volume24h", "trades24h", "volFloor", "volCeiling", "drift1h", "inventory"];

export function plainReason(gates: LiveGate[]) {
  const blocked = gates.filter((g) => !g.ok && !isPending(g)).map((g) => g.gate);
  for (const g of ORDER) if (blocked.includes(g)) return REASONS[g];
  if (blocked.length) return REASONS[blocked[0]] ?? "Conditions are not right.";
  return "Conditions are not right.";
}

/* ================================================== the simulated week */

const RF_PRICE_WETH = 5.7e-7;
const REGIMES = [
  { name: "dead calm", trend: 0, sigma: 0.004, pull: 0.02, volume: 8, trades: 90 },
  { name: "slow bleed", trend: -0.03, sigma: 0.010, pull: 0, volume: 40, trades: 600 },
  { name: "hard dump", trend: -0.10, sigma: 0.020, pull: 0, volume: 70, trades: 900 },
  { name: "quiet chop", trend: 0, sigma: 0.030, pull: 0.22, volume: 30, trades: 400 },
  { name: "live chop", trend: 0, sigma: 0.048, pull: 0.26, volume: 55, trades: 800 },
  { name: "wild chop", trend: 0, sigma: 0.075, pull: 0.30, volume: 90, trades: 1400 },
  { name: "steady climb", trend: 0.03, sigma: 0.028, pull: 0.05, volume: 60, trades: 850 },
  { name: "melt up", trend: 0.10, sigma: 0.045, pull: 0, volume: 120, trades: 1800 },
];

/** 240 hours: the 7-day replay gate needs at least 169 closes, so a 168-hour week could never arm. */
const SIM_HOURS = 240;

function rollWeek(seed: { current: number }) {
  const rnd = () => { seed.current = (Math.imul(seed.current, 1664525) + 1013904223) >>> 0; return (seed.current >>> 8) / 16777216; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const r = REGIMES[Math.floor(rnd() * REGIMES.length)];
  const path: number[] = [];
  let p = RF_PRICE_WETH, anchor = RF_PRICE_WETH;
  const perHour = Math.pow(1 + r.trend, 1 / 24) - 1;
  for (let i = 0; i < SIM_HOURS; i++) {
    anchor *= 1 + perHour;
    p = p * Math.exp(-r.pull * Math.log(p / anchor) + r.sigma * gauss()) * (1 + perHour);
    path.push(p);
  }
  return { regime: r, market: { ...measurePath(path, DEFAULT_GATES), ethUsd: 2734.86 } };
}

function Gates({ gates }: { gates: LiveGate[] }) {
  return (
    <ul className="hall-gates">
      {gates.map((g) => {
        const pending = isPending(g);
        return (
          <li key={g.gate} className={pending ? "pending" : g.ok ? "" : "blocked"}>
            <span aria-hidden="true">{pending ? "·" : g.ok ? "□" : "■"}</span>
            <b>{g.label ?? g.gate}</b>
            <i>{g.detail}</i>
          </li>
        );
      })}
    </ul>
  );
}

export default function FloorPanel({ live, error, bookRf, bookWeth, onBack }: { live: LiveDesk | null; error: string; bookRf: number; bookWeth: number; onBack: () => void }) {
  const [showGates, setShowGates] = useState(false);
  const [week, setWeek] = useState<ReturnType<typeof rollWeek> | null>(null);
  const seed = useRef((Math.random() * 4294967296) >>> 0);

  const sim = useMemo(() => {
    if (!week) return null;
    const rf = bookRf || 3159, weth = bookWeth || 0.029;
    const valueWeth = weth + rf * (week.market.mid ?? RF_PRICE_WETH);
    return evaluateRegime(week.market, { rf, weth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES) as {
      armed: boolean; checks: LiveGate[];
    };
  }, [week, bookRf, bookWeth]);

  const blocking = live ? live.gates.filter((g) => !g.ok && !isPending(g)).length : 0;
  const standingOn = !!live && !live.armed && (live.standing?.mode === "edge" || live.standing?.mode === "takeProfit");
  const word = live ? floorWord(live.armed, live.standing) : "";
  const t = live?.thresholds, step = t?.gridStep ?? live?.grid?.step;
  const rule = t && step
    ? `The desk arms only when the price has swung ${Math.round(step * 100)}% and back at least ${t.minReversals72h} times in 72 hours, has trended less than ${Math.round((t.maxDrift72hSteps ?? 0) * step * 100)}%, and replaying last week would have paid.`
    : "The desk arms only when an objective rule on the last 72 hours and the last week is met.";

  return (
    <div className="floor">
      <p className="acct-kicker">the desk, live from chain</p>

      {!live && !error && <p className="floor-word is-loading">reading the pool…</p>}
      {error && !live && (
        <p className="picker-error" role="alert">
          The live read failed ({error}) and is retrying. Until it answers, the floor shows nothing rather than a guess.
        </p>
      )}

      {live && (
        <>
          <div className={`floor-board${live.armed ? " armed" : ""}${standingOn ? " standing" : ""}`}>
            <p className="floor-mode">maker-only range orders</p>
            <p className="floor-word">{word}</p>
            <p className="hall-because">
              {live.armed ? "The rule is met. A deployed desk would be quoting both sides now." : standingOn ? live.standing!.headline : plainReason(live.gates)}
            </p>
          </div>
          {standingOn && live.standing?.ask && (
            <dl className="floor-order">
              <div><dt>resting</dt><dd>{Math.round(live.standing.ask.frac * 100)}% of {live.standing.book?.label ?? "the RF book"}{live.standing.restingUsd != null ? ` ($${live.standing.restingUsd.toFixed(2)})` : ""}</dd></div>
              <div><dt>from</dt><dd>{live.standing.ask.aboveMidPct.toFixed(1)}% above the market{live.standing.mode === "takeProfit" ? ", a take-profit range" : ""}</dd></div>
              {live.standing.edgeVsTakerPct != null && <div><dt>vs selling as a taker</dt><dd>+{live.standing.edgeVsTakerPct.toFixed(1)}% per RF</dd></div>}
              {live.standing.feeToFriendsIfFilledUsd != null && <div><dt>if it fills</dt><dd>the buyer pays ${live.standing.feeToFriendsIfFilledUsd.toFixed(2)} to every Friend</dd></div>}
            </dl>
          )}
          <p className="acct-intro">
            {standingOn
              ? <>RF in your box is a standing sell order: the bank rests it above the market as a range order and never swaps, so it pays no 5% toll. The buyer who takes it pays the pool&rsquo;s 5% to every activated Friend. To keep your RF, set its cap to 0 or withdraw it; it stays in your Friend&rsquo;s wallet.</>
              : <>By default the Bank only holds. When the desk is on, it rests maker orders on the RF/WETH pool: it never swaps and pays no 5% toll, and your RF or WETH takes part pro rata. Takers who trade against it still pay the pool&rsquo;s 5%, which goes to every activated Friend.</>}
          </p>
          <p className="hall-small" style={{ margin: "0 0 6px" }}>
            {standingOn ? "The two-sided grid (bids too) waits for a two-way market. " : ""}{rule} Read at {new Date(live.asOf).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            {live.armed ? "." : `: ${blocking} ${blocking === 1 ? "condition" : "conditions"} not met.`}
          </p>
          <button type="button" className="hall-why" onClick={() => setShowGates((v) => !v)} aria-expanded={showGates}>
            {showGates ? "hide the grid's conditions" : "show the grid's conditions"}
          </button>
          {showGates && <Gates gates={live.gates} />}
        </>
      )}

      <hr className="acct-rule" />
      <p className="acct-kicker">what if <span className="sim-stamp">simulated week</span></p>
      <p className="acct-intro">
        Roll a made-up week and ask the same rule what it <em>would</em> do. Nothing here happened.
      </p>
      <button type="button" className="hall-lever is-quiet" onClick={() => setWeek(rollWeek(seed))}>
        {week ? "Roll another week" : "Simulate a week"}
      </button>
      {week && sim && (
        <div className={`floor-sim${sim.armed ? " armed" : ""}`}>
          <p className="hall-regime">{week.regime.name}, simulated</p>
          <p className="floor-sim-word">{sim.armed ? "would quote" : "would stay off"}</p>
          {!sim.armed && <p className="hall-because">{plainReason(sim.checks)}</p>}
        </div>
      )}
      <button type="button" className="hall-lever floor-back" onClick={onBack}>Back to the hall</button>
    </div>
  );
}
