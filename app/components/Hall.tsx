"use client";

/**
 * THE HALL - our own runtime, not FriendSDK's.
 *
 * WHY WE LEFT THE SDK RUNTIME
 * FriendSDK games require a GENERATIONS NFT of generation >= 1. A Genesis is a
 * different contract and reports generation 0, so every SDK game excludes it. For
 * this project that is fatal rather than annoying: one Genesis holds ~4,462 RF of
 * idle rewards against ~31 RF across six Gen-3s, so the Genesis IS the bank and the
 * rest are garnish. The vibeathon's own rules say FriendSDK is optional for a tool,
 * and a market maker is a tool.
 *
 * So the SDK is used here as a LIBRARY (Apache-2.0): `renderWorld` draws the scene,
 * `createWorldMovement` handles walking and collision, `project`/`unproject` map
 * between world and screen. What we supply ourselves is the identity gate and the
 * character, because `renderWorld` accepts live actors as arbitrary bitmap rows
 * rather than a token id. That one fact is what lets a Genesis walk in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderWorld, project, unproject, validateWorld } from "@rarefriends/friendsdk/world";
import { createWorldMovement } from "@rarefriends/friendsdk/movement";
import { HALL, SPAWN, DESK, VIEWBOX } from "@/lib/hall-world";
import { DEFAULT_GATES, evaluateRegime, realisedVol, drift, edgePerRoundTrip, BREAKEVEN_STEP } from "@/lib/strategy.mjs";

const world = validateWorld(HALL as never);

/* ------------------------------------------------------------------ character */

/**
 * Turn a Friend's on-chain artwork into bitmap rows the world renderer can draw.
 * Works for BOTH collections, which the SDK's own sprite reader cannot: it reads the
 * Generations families registry only. Rasterising the SVG each Friend already serves
 * is collection-agnostic.
 */
async function bitmapFromArt(dataUrl: string, size: number): Promise<string[]> {
  const img = new Image();
  img.decoding = "sync";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("artwork failed to decode"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = data[i + 3];
      // The art is one-bit: ink on black. Treat anything bright and opaque as ink.
      const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      row += a > 40 && lum > 0.45 ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The world renderer requires live actors to be EXACTLY 16 rows of 16 pixels, so
 * whatever we sample has to be resampled to that. A Genesis portrait is 8x8 and a
 * Generations tile is sampled at 48x48 before cropping; both land here.
 */
function toSixteen(rows: string[]): string[] {
  const h = rows.length, w = rows[0]?.length ?? 0;
  if (h === 16 && w === 16) return rows;
  if (!h || !w) return Array.from({ length: 16 }, () => ".".repeat(16));
  const out: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    const sy = Math.min(h - 1, Math.floor((y * h) / 16));
    for (let x = 0; x < 16; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / 16));
      row += rows[sy][sx] === "#" ? "#" : ".";
    }
    out.push(row);
  }
  return out;
}

/** Crop a mostly-empty isometric world tile down to the character standing in it. */
function cropToSubject(rows: string[]): string[] {
  let top = rows.length, bottom = -1, left = rows[0]?.length ?? 0, right = -1;
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c !== "#") return;
      if (y < top) top = y; if (y > bottom) bottom = y;
      if (x < left) left = x; if (x > right) right = x;
    });
  });
  if (bottom < 0) return rows;
  const h = bottom - top + 1, w = right - left + 1;
  const side = Math.max(h, w);
  const padY = Math.floor((side - h) / 2), padX = Math.floor((side - w) / 2);
  const out: string[] = [];
  for (let y = 0; y < side; y++) {
    let row = "";
    for (let x = 0; x < side; x++) {
      const sy = top + y - padY, sx = left + x - padX;
      row += sy >= 0 && sy < rows.length && sx >= 0 && sx < (rows[sy]?.length ?? 0) && rows[sy][sx] === "#" ? "#" : ".";
    }
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------- the week */

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

function rollWeek(seed: { current: number }) {
  const rnd = () => { seed.current = (Math.imul(seed.current, 1664525) + 1013904223) >>> 0; return (seed.current >>> 8) / 16777216; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const r = REGIMES[Math.floor(rnd() * REGIMES.length)];
  const path: number[] = [];
  let p = RF_PRICE_WETH, anchor = RF_PRICE_WETH;
  const perHour = Math.pow(1 + r.trend, 1 / 24) - 1;
  for (let i = 0; i < 168; i++) {
    anchor *= 1 + perHour;
    p = p * Math.exp(-r.pull * Math.log(p / anchor) + r.sigma * gauss()) * (1 + perHour);
    path.push(p);
  }
  const lastDay = path.slice(-24);
  return {
    regime: r,
    market: {
      mid: path[path.length - 1], ethUsd: 2734.86,
      volume24hWeth: r.volume, trades24h: r.trades,
      drift24h: drift(lastDay), drift1h: drift(path.slice(-2)), drift7d: drift(path),
      hourlyVol: realisedVol(lastDay),
    },
  };
}

const REASON_ORDER = ["breaker", "drawdown", "drift7d", "drift24h", "volume24h", "trades24h", "volFloor", "volCeiling", "drift1h", "inventory"];
function reasonFor(gate: string, m: { drift7d: number | null; drift24h: number }) {
  const up = (m.drift7d ?? 0) > 0;
  switch (gate) {
    case "volume24h": case "trades24h": return "Too quiet. Barely anyone is trading today.";
    case "drift7d": return up ? "The price has run up all week. The bank does not chase a rally."
      : "The price has fallen all week. Buying now is catching a knife.";
    case "drift24h": return m.drift24h > 0 ? "The price jumped hard today. Too late to join." : "The price dropped hard today.";
    case "drift1h": return "The price is moving too fast right this minute.";
    case "volFloor": return "The price is barely moving, so there is nothing to earn.";
    case "volCeiling": return "Way too wild out there.";
    case "inventory": return "The bank is already holding too much RF.";
    case "drawdown": return "The bank is down. It stops itself until someone checks.";
    default: return "Conditions are not right.";
  }
}
function plainReason(checks: { gate: string; ok: boolean }[], m: { drift7d: number | null; drift24h: number }) {
  const blocked = new Set(checks.filter((c) => !c.ok).map((c) => c.gate));
  for (const g of REASON_ORDER) if (blocked.has(g)) return reasonFor(g, m);
  return "Conditions are not right.";
}

/* =================================================================== component */

export type HallFriend = {
  id: string; label: string; collection: string; generation: number;
  imageUrl: string | null; idleRf: number; idleWeth: number;
};

export default function Hall({ friend, onLeave }: { friend: HallFriend; onLeave: () => void }) {
  const [rows, setRows] = useState<string[] | null>(null);
  const [pos, setPos] = useState<[number, number]>([SPAWN[0], SPAWN[1]]);
  const [near, setNear] = useState(false);
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState<ReturnType<typeof rollWeek> | null>(null);
  const [rolling, setRolling] = useState(false);
  const [showGates, setShowGates] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [walking, setWalking] = useState(false);
  const mover = useRef<ReturnType<typeof createWorldMovement> | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const seed = useRef((Math.random() * 4294967296) >>> 0);

  /* character artwork, from whichever collection the Friend belongs to */
  useEffect(() => {
    let live = true;
    if (!friend.imageUrl) { setRows(null); return; }
    // Genesis art is an 8x8 portrait; a Generations tile is a 512px world with the
    // character in the middle, so it is sampled larger and then cropped to subject.
    const size = friend.collection === "Genesis" ? 16 : 48;
    bitmapFromArt(friend.imageUrl, size)
      .then((r) => { if (live) setRows(toSixteen(friend.collection === "Genesis" ? r : cropToSubject(r))); })
      .catch(() => { if (live) setRows(null); });
    return () => { live = false; };
  }, [friend.imageUrl, friend.collection]);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const u = () => setReduced(m.matches); u();
    m.addEventListener("change", u);
    return () => m.removeEventListener("change", u);
  }, []);

  /*
   * Movement is the SDK's own: setKey handles the key-to-direction mapping and
   * facing, moveTo does real pathfinding around the props, and update() clamps a
   * suspended tab to 40ms so a backgrounded page does not teleport you across the
   * hall. Rolling my own would have reimplemented collision badly.
   */
  useEffect(() => {
    mover.current = createWorldMovement(world as never, SPAWN as never, { speed: 96, radius: 9 });
    const down = (e: KeyboardEvent) => {
      const k = e.key;
      if (k.toLowerCase() === "e" && near) { setOpen(true); return; }
      if (k === "Escape") { setOpen(false); return; }
      if (mover.current?.setKey(k, true)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { mover.current?.setKey(e.key, false); };
    const blur = () => mover.current?.stop();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", blur);
    return () => {
      window.removeEventListener("keydown", down); window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", blur);
    };
  }, [near]);

  useEffect(() => {
    let last = performance.now();
    const tick = (t: number) => {
      // rAF can hand back a timestamp EARLIER than the performance.now() captured
      // outside the loop, and the SDK's update() rejects a negative delta outright.
      const delta = Math.max(0, t - last); last = t;
      const m = mover.current;
      if (m) {
        if (open) m.stop();
        const next = m.update(delta);
        setPos([next.position[0], next.position[1]]);
        setWalking(next.walking);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [open]);

  useEffect(() => {
    const d = Math.hypot(pos[0] - DESK.position[0], pos[1] - DESK.position[1]);
    setNear(d <= DESK.reach);
  }, [pos]);

  /* scene */
  const svg = useMemo(() => {
    const actors = rows
      ? [{ x: pos[0], y: pos[1], rows, pixelScale: 3 }]
      : [];
    return renderWorld(world as never, { actors } as never);
  }, [pos, rows, friend.collection]);

  const deskScreen = useMemo(() => project(DESK.position[0], DESK.position[1], 132), []);

  /* tap to walk: unproject the click into world space and let the SDK path to it */
  const onPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (open) return;
    const box = e.currentTarget.getBoundingClientRect();
    // The SVG is letterboxed by preserveAspectRatio, so map through the rendered
    // box rather than assuming it fills the element.
    const scale = Math.min(box.width / VIEWBOX.width, box.height / VIEWBOX.height);
    const drawW = VIEWBOX.width * scale, drawH = VIEWBOX.height * scale;
    const offX = (box.width - drawW) / 2, offY = (box.height - drawH) / 2;
    const sx = VIEWBOX.x + (e.clientX - box.left - offX) / scale;
    const sy = VIEWBOX.y + (e.clientY - box.top - offY) / scale;
    const [wx, wy] = unproject(sx, sy);
    mover.current?.moveTo([wx, wy] as never);
  }, [open]);

  const verdict = useMemo(() => {
    if (!week) return null;
    const bookRf = friend.idleRf || 3159, bookWeth = friend.idleWeth || 0.029;
    const valueWeth = bookWeth + bookRf * RF_PRICE_WETH;
    return evaluateRegime(week.market, { rf: bookRf, weth: bookWeth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES);
  }, [week, friend.idleRf, friend.idleWeth]);

  function pull() {
    if (rolling) return;
    setRolling(true); setShowGates(false);
    const spins = reduced ? 1 : 8;
    let i = 0;
    const step = () => {
      setWeek(rollWeek(seed));
      if (++i < spins) setTimeout(step, 70 + i * 26);
      else setRolling(false);
    };
    step();
  }

  return (
    <div className="hall">
      <div className="hall-scene" onPointerDown={onPointer}>
        <div
          className="hall-svg"
          style={{ ["--vb" as string]: `${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}` }}
          dangerouslySetInnerHTML={{
            // renderWorld returns a complete SVG document we authored the input for.
            // Re-point its viewBox to our camera window.
            __html: svg.replace(/viewBox="[^"]*"/, `viewBox="${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}"`)
              .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" '),
          }}
        />

        <button
          type="button"
          className={`hall-prompt${near ? " is-near" : ""}`}
          style={{
            left: `${((deskScreen[0] - VIEWBOX.x) / VIEWBOX.width) * 100}%`,
            top: `${((deskScreen[1] - VIEWBOX.y) / VIEWBOX.height) * 100}%`,
          }}
          onClick={() => near && setOpen(true)}
          disabled={!near}
        >
          <span>The Desk</span>
          <small>{near ? "E / tap to open" : "walk over"}</small>
        </button>

        <div className="hall-hud">
          <strong>{friend.label}</strong>
          <span>{friend.idleRf.toLocaleString("en-US", { maximumFractionDigits: 2 })} RF idle</span>
          <button type="button" onClick={onLeave}>Change Friend</button>
        </div>

        <p className="hall-hint">Walk with WASD or the arrows, or tap where you want to go.</p>
      </div>

      {open && (
        <div className="hall-modal" role="dialog" aria-modal="true" aria-label="The Desk">
          <div className="hall-panel">
            <header>
              <h2>The Desk</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close">&times;</button>
            </header>

            <p className="hall-lede">
              Your Friend&rsquo;s idle rewards are the book. Pull the lever: a week of market
              rolls and the bank decides whether to trade it. <strong>Most weeks it will not.</strong>
            </p>

            <button type="button" className="hall-lever" onClick={pull} disabled={rolling}>
              {rolling ? "rolling the week…" : week ? "Pull again" : "Pull the lever"}
            </button>

            {week && verdict && (
              <div className={`hall-verdict${verdict.armed ? " armed" : ""}${rolling ? " spinning" : ""}`}>
                <p className="hall-regime">{week.regime.name}</p>
                <p className="hall-word">{verdict.armed ? "TRADED" : "SAT OUT"}</p>
                {!rolling && (
                  <p className="hall-because">
                    {verdict.armed ? "Choppy and busy enough to be worth it." : plainReason(verdict.checks, week.market)}
                  </p>
                )}
              </div>
            )}

            {week && !rolling && (
              <>
                <button type="button" className="hall-why" onClick={() => setShowGates((v) => !v)} aria-expanded={showGates}>
                  {showGates ? "hide the nine checks" : "why? show the nine checks"}
                </button>
                {showGates && (
                  <ul className="hall-gates">
                    {verdict!.checks.map((c: { gate: string; ok: boolean; detail: string }) => (
                      <li key={c.gate} className={c.ok ? "" : "blocked"}>
                        <span aria-hidden="true">{c.ok ? "□" : "■"}</span><b>{c.gate}</b><i>{c.detail}</i>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="hall-small">
                  The pool takes 5% each way, so a round trip only clears above{" "}
                  {(BREAKEVEN_STEP * 100).toFixed(2)}%. At a 15% step it nets{" "}
                  {(edgePerRoundTrip(0.15) * 100).toFixed(2)}%. These are the real checks, not a mock.
                  Every balance here is simulated.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
