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
import { HALLS, hallFor, fit, type Hall as HallShape } from "@/lib/hall-world";
import { DEFAULT_GATES, evaluateRegime, realisedVol, drift, edgePerRoundTrip, BREAKEVEN_STEP } from "@/lib/strategy.mjs";

/** Validated once each, at module load, so switching rooms costs nothing. */
const WORLDS = {
  wide: validateWorld(HALLS.wide.world as never),
  mid: validateWorld(HALLS.mid.world as never),
  tall: validateWorld(HALLS.tall.world as never),
} as const;

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

/** How tall the player stands, in world canvas units. */
const CHAR_UNITS = 30;

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
  const [near, setNear] = useState(false);
  const charRef = useRef<HTMLDivElement | null>(null);
  const nearRef = useRef(false);

  /*
   * THE ROOM IS CHOSEN FROM THE BOX IT GETS, NOT FROM THE WINDOW.
   *
   * A rectangular room projects 3.09:1, so on a phone held upright the hall was a
   * 390x197 letterbox inside an 844 tall page - 23% of the screen, with the HUD
   * landing on the desk sign. There is a second, corridor-shaped room for that
   * case. Measuring the stage rather than matching a media query is what makes the
   * choice correct: the right room depends on the space left AFTER the chrome, and
   * a media query cannot see that.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setBox({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hall: HallShape = useMemo(() => (box ? hallFor(box.width / box.height) : HALLS.wide), [box]);
  const world = WORLDS[hall.key];
  const frame = useMemo(() => (box ? fit(hall, box) : null), [hall, box]);
  // The rAF loop is created once and must not be torn down on every resize, so it
  // reads the live room through a ref rather than through its closure.
  const hallRef = useRef(hall);
  useEffect(() => { hallRef.current = hall; }, [hall]);

  /*
   * The character is sized in WORLD units, not screen pixels. At a fixed 44px it
   * was 30 units wide on a laptop and 23 on a phone, so your Friend silently
   * changed size relative to the room depending on the device - and stayed small
   * while the hall grew on a large display.
   */
  const charPx = frame ? Math.max(24, Math.round((CHAR_UNITS * frame.width) / hall.viewBox.width)) : 44;
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState<ReturnType<typeof rollWeek> | null>(null);
  const [rolling, setRolling] = useState(false);
  const [showGates, setShowGates] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [touch, setTouch] = useState(false);
  const mover = useRef<ReturnType<typeof createWorldMovement> | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const seed = useRef((Math.random() * 4294967296) >>> 0);
  const openRef = useRef(false);

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

  /* A phone has no WASD. Telling it about the arrow keys is noise on the one
     screen with the least room for noise. */
  useEffect(() => {
    const m = window.matchMedia("(pointer: coarse)");
    const u = () => setTouch(m.matches); u();
    m.addEventListener("change", u);
    return () => m.removeEventListener("change", u);
  }, []);

  /*
   * Movement is the SDK's own: setKey handles the key-to-direction mapping and
   * facing, moveTo does real pathfinding around the props, and update() clamps a
   * suspended tab to 40ms so a backgrounded page does not teleport you across the
   * hall. Rolling my own would have reimplemented collision badly.
   */
  /*
   * Created ONCE. This effect used to list `near` in its deps, so the instant you
   * got close to the desk it re-ran, built a fresh mover, and respawned you at the
   * door. Walking up to the desk restarted you, every time. `near` is read through
   * a ref instead so the mover survives.
   */
  useEffect(() => {
    mover.current = createWorldMovement(world as never, hall.spawn as never, { speed: 108, radius: 9 });
    const down = (e: KeyboardEvent) => {
      const k = e.key;
      if (k.toLowerCase() === "e" && nearRef.current) { setOpen(true); return; }
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
      mover.current?.stop();
    };
    // Rebuilt only when the ROOM changes, never on resize within one room: the old
    // version listed `near` here, so walking up to the desk built a fresh mover and
    // respawned you at the door, every time.
  }, [world, hall.spawn]);

  useEffect(() => {
    let last = performance.now();
    const tick = (t: number) => {
      // rAF can hand back a timestamp EARLIER than the performance.now() captured
      // outside the loop, and the SDK's update() rejects a negative delta outright.
      const delta = Math.max(0, t - last); last = t;
      const m = mover.current;
      if (m) {
        if (openRef.current) m.stop();
        const next = m.update(delta);
        const { viewBox, desk } = hallRef.current;

        // Write the position straight to the node. No setState here: the only React
        // update in the loop is the `near` flag, and only when it flips.
        const el = charRef.current;
        if (el) {
          const [px, py] = project(next.position[0], next.position[1], 0);
          el.style.left = `${((px - viewBox.x) / viewBox.width) * 100}%`;
          el.style.top = `${((py - viewBox.y) / viewBox.height) * 100}%`;
          el.dataset.walking = next.walking ? "true" : "false";
        }

        const d = Math.hypot(next.position[0] - desk.position[0], next.position[1] - desk.position[1]);
        const isNear = d <= desk.reach;
        if (isNear !== nearRef.current) { nearRef.current = isNear; setNear(isNear); }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, []);

  /* The scene is STATIC. The player is drawn as a separate layer above it. */
  const svg = useMemo(() => renderWorld(world as never, {} as never), [world]);

  const deskScreen = useMemo(
    () => project(hall.desk.position[0], hall.desk.position[1], hall.promptLift),
    [hall],
  );

  /* tap to walk: unproject the click into world space and let the SDK path to it */
  const onPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (open) return;
    const { viewBox } = hallRef.current;
    const r = e.currentTarget.getBoundingClientRect();
    // The scene is sized at exactly the viewBox ratio, so this scale is uniform;
    // the min() keeps it honest if that ever stops being true.
    const scale = Math.min(r.width / viewBox.width, r.height / viewBox.height);
    const offX = (r.width - viewBox.width * scale) / 2, offY = (r.height - viewBox.height * scale) / 2;
    const sx = viewBox.x + (e.clientX - r.left - offX) / scale;
    const sy = viewBox.y + (e.clientY - r.top - offY) / scale;
    const [wx, wy] = unproject(sx, sy);
    // moveTo returns false when the point is unreachable; ignore rather than jump.
    mover.current?.moveTo([wx, wy] as never);
  }, [open]);

  const verdict = useMemo(() => {
    if (!week) return null;
    const bookRf = friend.idleRf || 3159, bookWeth = friend.idleWeth || 0.029;
    const valueWeth = bookWeth + bookRf * RF_PRICE_WETH;
    return evaluateRegime(week.market, { rf: bookRf, weth: bookWeth, valueWeth, hwmWeth: valueWeth, halted: false }, DEFAULT_GATES);
  }, [week, friend.idleRf, friend.idleWeth]);

  useEffect(() => { openRef.current = open; }, [open]);

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
      {/* Chrome is a ROW, not an overlay. As an overlay it sat on top of the desk
          sign the moment the frame got short. */}
      <div className="hall-bar">
        <strong>{friend.label}</strong>
        <span>{friend.idleRf.toLocaleString("en-US", { maximumFractionDigits: 0 })} RF idle</span>
        <button type="button" onClick={onLeave}>Play as yours</button>
        <a className="hall-docs" href="/docs">How it works</a>
      </div>

      <div className="hall-stage" ref={stageRef}>
        <div
          className="hall-scene"
          onPointerDown={onPointer}
          style={frame ? { width: `${frame.width}px`, height: `${frame.height}px` } : { visibility: "hidden" }}
        >
          <div
            className="hall-svg"
            dangerouslySetInnerHTML={{
              // renderWorld returns a complete SVG document we authored the input
              // for. Re-point its viewBox to our camera window.
              __html: svg
                .replace(/viewBox="[^"]*"/, `viewBox="${hall.viewBox.x} ${hall.viewBox.y} ${hall.viewBox.width} ${hall.viewBox.height}"`)
                .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" '),
            }}
          />

          {/* The player, a layer above the static scene. Moved by writing left/top
              in the rAF loop, never by re-rendering the world. */}
          {rows && (
            <div ref={charRef} className="hall-char" data-walking="false">
              <svg viewBox="0 0 16 16" width={charPx} height={charPx} shapeRendering="crispEdges" aria-hidden="true">
                {rows.map((row, y) => [...row].map((c, x) =>
                  c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null))}
              </svg>
            </div>
          )}

          <button
            type="button"
            className={`hall-prompt${near ? " is-near" : ""}`}
            style={{
              left: `${((deskScreen[0] - hall.viewBox.x) / hall.viewBox.width) * 100}%`,
              top: `${((deskScreen[1] - hall.viewBox.y) / hall.viewBox.height) * 100}%`,
            }}
            onClick={() => near && setOpen(true)}
            disabled={!near}
          >
            <span>The Desk</span>
            <small>{near ? "E / tap to open" : "walk over"}</small>
          </button>
        </div>
      </div>

      <p className="hall-hint">{touch ? "Tap where you want to go." : "Walk with WASD or the arrows, or tap where you want to go."}</p>

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
