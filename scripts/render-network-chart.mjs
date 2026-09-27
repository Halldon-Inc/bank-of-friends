#!/usr/bin/env node
/**
 * docs/media/network.svg + network.png: the swing a round trip must capture, against the share of all Friend
 * weight that banks here. Computed from lib/strategy.mjs takerBreakEven, so the chart cannot drift from the code.
 *   node scripts/render-network-chart.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { takerBreakEven } from "../lib/strategy.mjs";

const W = 1400, H = 700, L = 150, R = 80, T = 150, B = 110;
const pw = W - L - R, ph = H - T - B;
const yMax = 0.12;
const x = (s) => L + s * pw, y = (v) => T + ph - (v / yMax) * ph;
const pts = [];
for (let i = 0; i <= 200; i++) { const s = i / 200; pts.push([x(s), y(takerBreakEven(s).swing)]); }
const path1 = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
const marks = [
  { s: 0.002, label: "one Genesis today", dx: 18, dy: -14, anchor: "start" },
  { s: 0.10, label: "10% of all weight", dx: 14, dy: -16, anchor: "start" },
  { s: 0.50, label: "half of all weight", dx: 14, dy: -16, anchor: "start" },
  { s: 0.90, label: "90%", dx: 0, dy: -22, anchor: "middle" },
];
const ink = "#111", dim = "#666", grid = "#d4d4d4", paper = "#eeeeee", lime = "#ccff00";
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
<rect width="${W}" height="${H}" fill="${paper}"/>
<text x="${L}" y="62" font-size="30" fill="${ink}">Every Friend who joins makes every trade cheaper</text>
<text x="${L}" y="98" font-size="17" fill="${dim}">The swing a swap-desk round trip must capture to break even, paying 5% in and 5% out,</text>
<text x="${L}" y="122" font-size="17" fill="${dim}">when members get back their share of the toll (it is what every activated Friend is paid).</text>
`;
for (let v = 0; v <= yMax + 1e-9; v += 0.02) {
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${grid}" stroke-width="1"/>`;
  svg += `<text x="${L - 14}" y="${y(v) + 6}" font-size="16" fill="${dim}" text-anchor="end">${Math.round(v * 100)}%</text>`;
}
for (const s of [0, 0.25, 0.5, 0.75, 1]) svg += `<text x="${x(s)}" y="${T + ph + 34}" font-size="16" fill="${dim}" text-anchor="middle">${Math.round(s * 100)}%</text>`;
svg += `<text x="${L + pw / 2}" y="${H - 34}" font-size="17" fill="${ink}" text-anchor="middle">share of all Friend weight that banks here</text>`;
svg += `<text transform="translate(44 ${T + ph / 2}) rotate(-90)" font-size="17" fill="${ink}" text-anchor="middle">break-even swing</text>`;
svg += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${ink}" stroke-width="1.5"/>`;
svg += `<path d="${path1}" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
for (const m of marks) {
  const v = takerBreakEven(m.s).swing, cx = x(m.s), cy = y(v);
  svg += `<circle cx="${cx}" cy="${cy}" r="9" fill="${lime}" stroke="${ink}" stroke-width="2.5"/>`;
  svg += `<text x="${cx + m.dx}" y="${cy + m.dy}" font-size="19" fill="${ink}" text-anchor="${m.anchor}"><tspan font-weight="700">${(v * 100).toFixed(1)}%</tspan> ${m.label}</text>`;
}
svg += `<text x="${W - R}" y="${T - 14}" font-size="13" fill="${dim}" text-anchor="end">DERIVED: toll per round trip 0.0975 x (1 - s); lib/strategy.mjs takerBreakEven</text>`;
svg += `</svg>\n`;
fs.writeFileSync("docs/media/network.svg", svg);

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p; } return null; };
let exe = null; for (const d of fs.readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse()) { exe = walk(path.join(root, d)); if (exe) break; }
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
await page.screenshot({ path: "docs/media/network.png", clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();
console.log("wrote docs/media/network.svg and network.png");
