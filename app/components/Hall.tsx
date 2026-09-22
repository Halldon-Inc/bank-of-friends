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
import { renderBank } from "@/lib/hall-art";
import { loadAccounts, addAccount, removeAccount, accountId, type Account } from "@/lib/accounts";
import AccountPanel from "./AccountPanel";
import VaultPanel from "./VaultPanel";
import FloorPanel, { plainReason, type LiveDesk } from "./FloorPanel";
import { Tick, compact, dollars, plaqueLines, readTotals, weth as wethFmt } from "./VaultHolds";

type Station = "desk" | "floor" | "vault";
const TITLES: Record<Station, string> = { desk: "The Desk", floor: "The Trading Floor", vault: "The Vault" };

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

/**
 * How tall the player stands, in world canvas units. It was 30, which left the
 * Friend a 50px speck on the carpet of a 1920 screen: the product's hero, barely
 * visible. 44 is as tall as the counter is deep and still clears the aisle.
 */
const CHAR_UNITS = 44;

/** How often the floor re-reads the chain. The API caches for 30s itself. */
const LIVE_EVERY_MS = 60_000;

/** How long one keeper round takes, counter to vault and back. */
const KEEPER_ROUND_S = 9;

/**
 * The keeper, drawn as a teller: peaked cap with a visor, face, shoulders and tie,
 * both arms down to a strongbox carried in front, legs. `#` is ink, `o` is paper
 * (so the figure reads on the hatched carpet), `L` is the strongbox's lime lock.
 * 16 wide by 19 tall.
 */
const TELLER = [
  ".....######.....",
  "....########....",
  "..############..",
  "....#oooooo#....",
  "....#o#oo#o#....",
  "....#oo##oo#....",
  ".....######.....",
  ".......##.......",
  "...##########...",
  "..#o#oo##oo#o#..",
  "..#o#oo##oo#o#..",
  "..#o#oooooo#o#..",
  "..############..",
  "..#ooooLLoooo#..",
  "..#ooooLLoooo#..",
  "..############..",
  "....#o#..#o#....",
  "....#o#..#o#....",
  "...###....###...",
];

/* =================================================================== component */

export type HallFriend = {
  id: string; label: string; collection: string; generation: number;
  imageUrl: string | null; idleRf: number; idleWeth: number;
};

export type WalletFriend = HallFriend & { activated: boolean };

export default function Hall({ friend, onLeave, rfUsd, ethUsd, walletFriends = [] }: {
  friend: HallFriend; onLeave: () => void; rfUsd: number; ethUsd: number;
  /** The looked-up wallet's Friends, so the vault can show the ones not yet enrolled. */
  walletFriends?: WalletFriend[];
}) {
  const [rows, setRows] = useState<string[] | null>(null);
  const [near, setNear] = useState<null | Station>(null);
  const charRef = useRef<HTMLDivElement | null>(null);
  const nearRef = useRef<null | Station>(null);

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
  /** Which destination is open, if any. */
  const [open, setOpen] = useState<null | Station>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => { setAccounts(loadAccounts()); }, []);
  const account = useMemo(
    () => accounts.find((a) => a.id === accountId(friend.collection, friend.id)) ?? null,
    [accounts, friend.collection, friend.id],
  );
  const [reduced, setReduced] = useState(false);
  const [touch, setTouch] = useState(false);
  const mover = useRef<ReturnType<typeof createWorldMovement> | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const openRef = useRef(false);

  /*
   * THE LIVE DESK. One read feeds the floor's headline, the board's lamp and the
   * ticker, so the three can never disagree with each other or with /docs.
   */
  const [live, setLive] = useState<LiveDesk | null>(null);
  const [liveError, setLiveError] = useState("");
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, fails = 0;
    const read = async () => {
      try {
        const r = await fetch("/api/desk", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
        fails = 0;
        if (alive) { setLive(j as LiveDesk); setLiveError(""); }
      } catch (e) {
        // A cold read of the chain can fail once and succeed a few seconds later,
        // so retry soon rather than leaving the floor dark for a whole minute.
        fails++;
        if (alive) setLiveError(String((e as Error)?.message ?? e).slice(0, 80));
      }
      if (alive) timer = setTimeout(read, fails ? Math.min(30_000, 4_000 * fails) : LIVE_EVERY_MS);
    };
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  /** A clock for the ticker's countdown. Once a second, and only the ticker reads it. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

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
      if (k.toLowerCase() === "e" && nearRef.current) { setOpen(nearRef.current); return; }
      if (k === "Escape") { setOpen(null); return; }
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
        const { viewBox, stations } = hallRef.current;

        // Write the position straight to the node. No setState here: the only React
        // update in the loop is the `near` flag, and only when it flips.
        const el = charRef.current;
        if (el) {
          const [px, py] = project(next.position[0], next.position[1], 0);
          el.style.left = `${((px - viewBox.x) / viewBox.width) * 100}%`;
          el.style.top = `${((py - viewBox.y) / viewBox.height) * 100}%`;
          el.dataset.walking = next.walking ? "true" : "false";
        }

        // Nearest destination within reach, so standing between the two never
        // lights up both signs at once.
        let hit: null | Station = null, best = Infinity;
        for (const t of stations) {
          const d = Math.hypot(next.position[0] - t.position[0], next.position[1] - t.position[1]);
          if (d <= t.reach && d < best) { best = d; hit = t.id; }
        }
        if (hit !== nearRef.current) { nearRef.current = hit; setNear(hit); }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, []);

  /* The scene is STATIC. The player is drawn as a separate layer above it.
     The SDK renders the floor; the building on top of it is ours, because the
     SDK's props are 45-degree boxes and this room is seen head on. */
  const svg = useMemo(() => renderWorld(world as never, {} as never), [world]);
  const bank = useMemo(() => renderBank(hall), [hall]);

  /** Where each destination's STANDING spot is, as a percentage of the frame.
   *  Published on the scene so a harness can walk there without knowing the
   *  room's geometry; the signs sit over the furniture, not on these spots. */
  const spots = useMemo(() => {
    const p = (xy: readonly [number, number]) => {
      const [px, py] = project(xy[0], xy[1], 0);
      return `${(((px - hall.viewBox.x) / hall.viewBox.width) * 100).toFixed(3)},${(((py - hall.viewBox.y) / hall.viewBox.height) * 100).toFixed(3)}`;
    };
    return { desk: p(hall.desk.position), floor: p(hall.floor.position), vault: p(hall.vault.position) };
  }, [hall]);

  /** Signs are pinned in SCREEN space to the artwork they name (see hall-world). */
  const signs = useMemo(
    () => hall.stations.map((t) => ({
      id: t.id, label: t.label, hint: t.hint, below: t.sign.hang === "below", art: t.art,
      left: ((t.sign.x - hall.viewBox.x) / hall.viewBox.width) * 100,
      top: ((t.sign.y - hall.viewBox.y) / hall.viewBox.height) * 100,
    })),
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

  /* Where the keeper walks and where the ticker runs, as percentages of the frame. */
  const pct = useCallback((px: number, py: number) => ({
    left: ((px - hall.viewBox.x) / hall.viewBox.width) * 100,
    top: ((py - hall.viewBox.y) / hall.viewBox.height) * 100,
  }), [hall]);
  const keeperPath = useMemo(() => ({ from: pct(...hall.keeper.from), to: pct(...hall.keeper.to) }), [hall, pct]);

  /*
   * WHERE THE KEEPER STOPS IS MEASURED, NOT ASSUMED. The vault's sign is HTML at a
   * fixed pixel size while the hall scales, so no world coordinate can promise the
   * keeper clears it on every screen: in shots3 it arrived standing on the sign.
   * After layout, read the sign's real box and stop the keeper so its right edge is
   * one body-width left of the sign's left edge, and its feet level with the sign.
   */
  const keeperW = Math.round(charPx * 0.62);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [keeperStop, setKeeperStop] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!frame) return;
    const id = requestAnimationFrame(() => {
      const scene = sceneRef.current;
      const sign = scene?.querySelector<HTMLElement>('.hall-prompt[data-station="vault"]');
      if (!scene || !sign) return;
      const sr = scene.getBoundingClientRect();
      // offsetLeft/Top ignore the pop-in transform, so this is the resting box.
      const left = sign.offsetLeft - sign.offsetWidth / 2;
      const bottom = sign.offsetTop + (sign.classList.contains("is-below") ? sign.offsetHeight : 0);
      const cx = left - keeperW * 1.5;
      setKeeperStop({ left: (cx / sr.width) * 100, top: (bottom / sr.height) * 100 });
    });
    return () => cancelAnimationFrame(id);
  }, [frame, hall, keeperW]);
  const keeperTo = keeperStop ?? keeperPath.to;
  const tickerBox = useMemo(() => {
    const a = pct(hall.ticker.left, hall.ticker.top), b = pct(hall.ticker.right, hall.ticker.bottom);
    return { left: a.left, top: a.top, width: b.left - a.left, height: b.top - a.top };
  }, [hall, pct]);

  const plaqueBox = useMemo(() => {
    const a = pct(hall.plaque.left, hall.plaque.top), b = pct(hall.plaque.right, hall.plaque.bottom);
    return { left: a.left, top: a.top, width: b.left - a.left, height: b.top - a.top };
  }, [hall, pct]);
  const totals = useMemo(() => readTotals(live?.bank, live?.protocolIdle), [live]);
  const plaque = plaqueLines(totals.bank, totals.idle);
  /*
   * Type sized to the plate, never the window: two lines must fit its height and
   * the longer line must fit its width. The plate is a triangle's worth of room on
   * a phone, so this is what keeps both figures legible at 320px.
   */
  const plaqueWide = frame ? (frame.width * plaqueBox.width) / 100 > 220 : false;
  /** Keep the type inside the plate's inner rule: hall-art insets that rule by
   *  max(1.2, 9% of the plate's height) units; add 2.4px of air past it, since
   *  the sweep requires the text to clear the rule by at least 2px. */
  const plaquePad = useMemo(() => {
    if (!frame) return undefined;
    const scale = frame.width / hall.viewBox.width;
    const inset = Math.max(1.2, (hall.plaque.bottom - hall.plaque.top) * 0.09) * scale;
    return `${(inset + 2.4).toFixed(1)}px ${(inset + 2.4).toFixed(1)}px`;
  }, [frame, hall]);
  /*
   * Each line is sized by CSS container units against the plate itself, from its
   * own character count, so it can never be wider than the plate. A pixel estimate
   * here once let both lines spill past the plate on a 320px phone.
   */
  const plaqueHead = plaque.kind === "idle" && !plaqueWide ? "UNCLAIMED" : plaque.head;
  const plaqueFigs = plaque.kind === "none" ? "opens at launch"
    : `${compact(plaque.rf)} RF + ${wethFmt(plaque.weth)} WETH${plaqueWide ? ` ${dollars(plaque.usd)}` : ""}`;

  const bookRf = useMemo(() => accounts.reduce((x, a) => x + a.boxRf + a.pnlRf, 0), [accounts]);
  const bookWeth = useMemo(() => accounts.reduce((x, a) => x + a.boxWeth + a.pnlWeth, 0), [accounts]);

  const tickerItems = useMemo(() => {
    const items: string[] = [];
    const m = live?.market;
    items.push(m ? `RF $${m.rfUsd.toPrecision(4)}` : `RF $${rfUsd.toPrecision(4)}`);
    if (m) items.push(`24h volume ${m.volume24hWeth.toFixed(2)} WETH`, `${m.trades24h} trades`);
    const k = live?.keeper;
    if (k && (k.harvested24hRf !== undefined || k.harvested24hWeth !== undefined)) {
      items.push(`harvested 24h ${Math.round(k.harvested24hRf ?? 0).toLocaleString("en-US")} RF + ${(k.harvested24hWeth ?? 0).toFixed(4)} WETH`);
    } else if (bookRf > 0 || bookWeth > 0) {
      items.push(`in your boxes ${Math.round(bookRf).toLocaleString("en-US")} RF + ${bookWeth.toFixed(4)} WETH (simulated)`);
    } else {
      items.push("keeper round: counter to vault (simulated)");
    }
    if (plaque.kind === "bank") items.push(`the vault holds ${compact(plaque.rf)} RF + ${wethFmt(plaque.weth)} WETH (${dollars(plaque.usd)})`);
    else if (plaque.kind === "idle") items.push(`earned by Friends, not yet claimed: ${compact(plaque.rf)} RF + ${wethFmt(plaque.weth)} WETH (${dollars(plaque.usd)}). bring yours in`);
    const r = live?.rewards;
    if (r?.streamWethPerWeek) items.push(`paying Friends ${r.streamWethPerWeek.toFixed(1)} WETH a week`);
    const next = r?.nextAllocateAt ? Date.parse(r.nextAllocateAt) : NaN;
    if (Number.isFinite(next)) {
      const s = Math.max(0, Math.round((next - now) / 1000));
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      items.push(`next allocate in ${hh ? `${hh}h ` : ""}${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`);
    }
    items.push(live ? (live.armed ? "desk ON" : `desk OFF: ${plainReason(live.gates).replace(/\.$/, "").toLowerCase()}`) : "desk: reading");
    return items;
  }, [live, rfUsd, bookRf, bookWeth, now, plaque]);

  useEffect(() => { openRef.current = open !== null; }, [open]);

  return (
    <div className="hall">
      {/* Chrome is a ROW, not an overlay. As an overlay it sat on top of the desk
          sign the moment the frame got short. */}
      <div className="hall-bar">
        {friend.imageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img className={`hall-portrait ${friend.collection === "Generations" && friend.generation >= 1 ? "world" : "portrait"}`} src={friend.imageUrl} alt="" />
          : null}
        <strong>{friend.label}</strong>
        {/* BOTH sides, always: RF and WETH together are the market-making fund, and
            showing the RF alone hid 90% of its value. */}
        <span className="hall-idle">
          <b>{friend.idleRf.toLocaleString("en-US", { maximumFractionDigits: 0 })} RF</b>
          {" + "}
          <b>{friend.idleWeth.toFixed(4)} WETH</b> idle
          <i> (${Math.round(friend.idleRf * (live?.market.rfUsd || rfUsd) + friend.idleWeth * ethUsd).toLocaleString("en-US")})</i>
        </span>
        <button type="button" onClick={onLeave}>Use my Friend</button>
        <a className="hall-docs" href="/docs">How it works</a>
      </div>

      <div className="hall-stage" ref={stageRef}>
        <div
          ref={sceneRef}
          className="hall-scene"
          data-room={hall.key}
          data-desk={spots.desk}
          data-vault={spots.vault}
          data-floor={spots.floor}
          data-armed={live?.armed ? "true" : "false"}
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

          <svg
            className="hall-bank" viewBox={`${hall.viewBox.x} ${hall.viewBox.y} ${hall.viewBox.width} ${hall.viewBox.height}`}
            preserveAspectRatio="xMidYMid meet" aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: bank }}
          />

          {/* THE VAULT HOLDS, on the brass plate in the pediment. */}
          <div className={`hall-plaque is-${plaque.kind}`} aria-label="The vault holds" style={{
            left: `${plaqueBox.left}%`, top: `${plaqueBox.top}%`, width: `${plaqueBox.width}%`, height: `${plaqueBox.height}%`,
            ["--n1" as string]: plaqueHead.length, ["--n2" as string]: plaqueFigs.length,
            padding: plaquePad,
          }}>
            <span className="hall-plaque-head">{plaqueHead}</span>
            {plaque.kind === "none" ? (
              <span className="hall-plaque-figs">opens at launch</span>
            ) : (
              <span className="hall-plaque-figs">
                <b><Tick value={plaque.rf} format={compact} /> RF</b> + <b><Tick value={plaque.weth} format={wethFmt} /> WETH</b>
                {plaqueWide && <i> <Tick value={plaque.usd} format={dollars} /></i>}
              </span>
            )}
          </div>

          {/* The ticker, in the marquee's lit screen. */}
          <div className="hall-ticker" aria-label="Ticker" style={{
            left: `${tickerBox.left}%`, top: `${tickerBox.top}%`, width: `${tickerBox.width}%`, height: `${tickerBox.height}%`,
            // Type sized to the lit screen it runs in, not to the window.
            fontSize: frame ? `${Math.max(7, Math.min(13, (frame.height * tickerBox.height) / 100 * 0.62)).toFixed(1)}px` : undefined,
          }}>
            <div className={`hall-ticker-run${reduced ? " is-still" : ""}`}>
              {[0, 1].map((k) => (
                <span key={k} aria-hidden={k === 1 ? "true" : undefined}>
                  {tickerItems.map((t, i) => <b key={i}>{t}</b>)}
                </span>
              ))}
            </div>
          </div>

          {/* The keeper: carries a coin from the counter, where rewards come in, to
              the vault. A loop, because the point is that it never stops. */}
          <div className={`hall-keeper${reduced ? " is-still" : ""}`} aria-hidden="true" data-keeper="true" style={{
            ["--kx0" as string]: `${keeperPath.from.left}%`, ["--ky0" as string]: `${keeperPath.from.top}%`,
            ["--kx1" as string]: `${keeperTo.left}%`, ["--ky1" as string]: `${keeperTo.top}%`,
            ["--kround" as string]: `${KEEPER_ROUND_S}s`,
            ["--ksize" as string]: `${keeperW}px`,
          }}>
            <i className="hall-shadow" />
            <svg viewBox="0 0 16 19" shapeRendering="crispEdges">
              {TELLER.map((row, y) => [...row].map((c, x) => c === "." ? null : (
                <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1}
                  fill={c === "#" ? "#111" : c === "L" ? "#ccff00" : "#eee"} />
              )))}
            </svg>
            <span className="keeper-tick">+ harvested</span>
          </div>

          {/* The player, a layer above the static scene. Moved by writing left/top
              in the rAF loop, never by re-rendering the world. */}
          {rows && (
            <div ref={charRef} className="hall-char" data-walking="false">
              {/* A soft shadow, so the Friend stands ON the marble rather than over it. */}
              <i className="hall-shadow" aria-hidden="true" />
              <svg viewBox="0 0 16 16" width={charPx} height={charPx} shapeRendering="crispEdges" aria-hidden="true">
                {rows.map((row, y) => [...row].map((c, x) =>
                  c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null))}
              </svg>
            </div>
          )}

          {signs.map((sg) => (
            <button
              key={sg.id}
              type="button"
              className={`hall-prompt${near === sg.id ? " is-near" : ""}${sg.below ? " is-below" : ""}`}
              data-station={sg.id}
              data-art={sg.art}
              style={{ left: `${sg.left}%`, top: `${sg.top}%` }}
              onClick={() => near === sg.id && setOpen(sg.id as Station)}
              disabled={near !== sg.id}
            >
              <span>{sg.label}</span>
              <small>{near === sg.id ? "E / tap to open" : sg.hint}</small>
            </button>
          ))}
        </div>
      </div>

      <p className="hall-hint">{touch ? "Tap where you want to go." : "Walk with WASD or the arrows, or tap where you want to go."}</p>

      {open && (
        <div className="hall-modal" role="dialog" aria-modal="true" aria-label={TITLES[open]}>
          <div className="hall-panel">
            <header>
              <h2>{TITLES[open]}</h2>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close">&times;</button>
            </header>

            {open === "vault" && (
              <VaultPanel
                accounts={accounts} rfUsd={rfUsd} ethUsd={ethUsd}
                current={accountId(friend.collection, friend.id)}
                walletFriends={walletFriends}
                onGoToDesk={() => setOpen("desk")}
                bank={totals.bank}
                idle={totals.idle}
                onChange={setAccounts}
              />
            )}
            {open === "floor" && <FloorPanel live={live} error={liveError} bookRf={bookRf} bookWeth={bookWeth} onBack={() => setOpen(null)} />}
            {open === "desk" && (
              <AccountPanel
                friend={friend}
                account={account}
                onOpened={(a) => setAccounts(addAccount(a))}
                onClosed={(id) => setAccounts(removeAccount(id))}
                onGoToVault={() => setOpen("vault")}
                rfUsd={live?.market.rfUsd || rfUsd} ethUsd={ethUsd}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
