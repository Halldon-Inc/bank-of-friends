/**
 * THE BANK, DRAWN.
 *
 * Every number here comes from `hall-world.ts`. This module decides nothing about
 * where anything is; it draws between lines that were already solved, so the camera,
 * the signs and the building can never disagree about how tall the building is.
 *
 * It is a straight-on ELEVATION, not an isometric box, because in this projection a
 * plane of constant depth faces the camera squarely and a plane of constant offset
 * is edge on. Drawing 45-degree boxes into a head-on room is what made the old desk
 * look like it was standing at an impossible angle.
 *
 * The line language is the SDK's own, read from their fishing example: 1px black
 * ink on #eee paper, dotted shading, hard offset shadows, one accent in #ccff00.
 */

import type { Hall } from "./hall-world";

const ACCENT = "#ccff00";
const INK = "#111";
const PAPER = "#eee";

const r2 = (v: number) => Math.round(v * 10) / 10;

/** A filled, stroked rectangle in the house style. */
const rect = (x: number, y: number, w: number, h: number, fill = PAPER, sw = 2) =>
  `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(0, w))}" height="${r2(Math.max(0, h))}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`;

/**
 * One column: a shaft with a base and a capital, plus a couple of flutes. Kept to
 * three strokes because at phone scale a column is about 8px wide and anything more
 * turns into a grey smudge.
 */
function column(cx: number, top: number, bottom: number, w: number) {
  const h = bottom - top;
  const capH = Math.max(3, h * 0.07), baseH = Math.max(3, h * 0.06);
  const flare = w * 0.22;
  const shaft = rect(cx - w / 2, top + capH, w, h - capH - baseH, PAPER, 2);
  const cap = rect(cx - w / 2 - flare, top, w + flare * 2, capH, PAPER, 2);
  const base = rect(cx - w / 2 - flare, bottom - baseH, w + flare * 2, baseH, PAPER, 2);
  const flute = w > 9
    ? `<line x1="${r2(cx)}" y1="${r2(top + capH + h * 0.06)}" x2="${r2(cx)}" y2="${r2(bottom - baseH - h * 0.06)}" stroke="${INK}" stroke-width="1" opacity="0.5"/>`
    : "";
  return cap + shaft + base + flute;
}

/**
 * The vault door: concentric rings, a spoke wheel and a dial. The one piece of
 * colour in the hall, because it is the thing the whole project is about.
 */
function vaultDoor(cx: number, cy: number, r: number) {
  const ring = (rr: number, sw: number, fill: string) =>
    `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr)}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`;
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    const [x0, y0] = [cx + Math.cos(a) * r * 0.2, cy + Math.sin(a) * r * 0.2];
    const [x1, y1] = [cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62];
    return `<line x1="${r2(x0)}" y1="${r2(y0)}" x2="${r2(x1)}" y2="${r2(y1)}" stroke="${INK}" stroke-width="2"/>`;
  }).join("");
  // Bolt heads around the frame read as a vault at any size, where fine detail does not.
  const bolts = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    return `<circle cx="${r2(cx + Math.cos(a) * r * 0.9)}" cy="${r2(cy + Math.sin(a) * r * 0.9)}" r="${r2(Math.max(1, r * 0.045))}" fill="${INK}"/>`;
  }).join("");
  return [
    rect(cx - r * 1.22, cy - r * 1.22, r * 2.44, r * 2.44, PAPER, 2),
    ring(r, 2, PAPER),
    bolts,
    ring(r * 0.72, 2, PAPER),
    spokes,
    ring(r * 0.2, 2, ACCENT),
  ].join("");
}

/**
 * The teller counter: a long run of stone with a lip, divided into windows. Drawn
 * head on, as a counter in a hall photographed from the aisle actually looks.
 */
function counterRun(x0: number, x1: number, top: number, bottom: number) {
  const w = x1 - x0, h = bottom - top;
  const lip = Math.max(3, h * 0.18);
  const windows = Math.max(1, Math.round(w / Math.max(46, h * 1.5)));
  const parts = [rect(x0, top + lip, w, h - lip, PAPER, 2), rect(x0 - 2, top, w + 4, lip, PAPER, 2)];
  for (let i = 1; i < windows; i++) {
    const x = x0 + (w * i) / windows;
    parts.push(`<line x1="${r2(x)}" y1="${r2(top + lip)}" x2="${r2(x)}" y2="${r2(bottom)}" stroke="${INK}" stroke-width="2"/>`);
  }
  // A grille over each window, which is what makes it read as a teller rather than a wall.
  for (let i = 0; i < windows; i++) {
    const cx = x0 + (w * (i + 0.5)) / windows;
    const gw = Math.min((w / windows) * 0.42, h * 0.5);
    for (let k = -1; k <= 1; k++) {
      const x = cx + (k * gw) / 2;
      parts.push(`<line x1="${r2(x)}" y1="${r2(top + lip + h * 0.16)}" x2="${r2(x)}" y2="${r2(bottom - h * 0.16)}" stroke="${INK}" stroke-width="1" opacity="0.55"/>`);
    }
  }
  return parts.join("");
}

/**
 * Draw the building. Returned as a string and injected once: like the floor, it
 * never changes, so it must never re-render with the character.
 */
export function renderBank(hall: Hall): string {
  const f = hall.facade, c = hall.counter;
  const out: string[] = [];

  /* --- the facade ------------------------------------------------------- */
  out.push(rect(f.left, f.top, f.width, f.F, PAPER, 2));

  // Pediment: a triangle across the full front, with a dotted tympanum.
  out.push(
    `<polygon points="${r2(f.left)},${r2(f.pedBottom)} ${r2((f.left + f.right) / 2)},${r2(f.top)} ${r2(f.right)},${r2(f.pedBottom)}" fill="url(#bankDots)" stroke="${INK}" stroke-width="2"/>`,
  );

  // Entablature, carrying the name.
  const entabH = f.entabBottom - f.entabTop;
  out.push(rect(f.left, f.entabTop, f.width, entabH, PAPER, 2));
  const size = Math.min(entabH * 0.62, f.width / 26);
  if (size >= 4.2) {
    out.push(
      `<text class="bank-name" x="${r2((f.left + f.right) / 2)}" y="${r2(f.entabTop + entabH * 0.5)}"` +
      ` text-anchor="middle" dominant-baseline="central" font-size="${r2(size)}"` +
      ` letter-spacing="${r2(size * 0.24)}" fill="${INK}">THE FIRST BANK OF FRIENDS</text>`,
    );
  }

  // Colonnade, left and right of the central bay.
  const bayL = (f.left + f.right) / 2 - f.bay / 2, bayR = (f.left + f.right) / 2 + f.bay / 2;
  const colW = Math.max(6, f.colH * 0.15);
  for (const [from, to] of [[f.left, bayL], [bayR, f.right]] as [number, number][]) {
    const span = to - from;
    const count = Math.max(2, Math.min(5, Math.round(span / (colW * 3.1))));
    for (let i = 0; i < count; i++) {
      out.push(column(from + (span * (i + 0.5)) / count, f.colTop, f.colBot, colW));
    }
  }

  // The bay itself, then the door in it, then the plinth the whole thing stands on.
  out.push(rect(bayL, f.colTop, f.bay, f.colBot - f.colTop, PAPER, 2));
  out.push(vaultDoor(f.door.cx, f.door.cy, f.door.r));
  out.push(rect(f.left, f.colBot, f.width, f.plinthH, "url(#bankDots)", 2));

  /* --- the counter ------------------------------------------------------ */
  for (const [x0, x1] of c.runs) out.push(counterRun(x0, x1, c.top, c.y));

  return `<defs>
    <pattern id="bankDots" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="${PAPER}"/>
      <circle cx="1" cy="1" r="0.7" fill="${INK}"/>
    </pattern>
  </defs>${out.join("")}`;
}
