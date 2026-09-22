#!/usr/bin/env node
/**
 * Sweep the hall across real device sizes and FAIL on anything that looks wrong.
 *
 *   node scripts/hall-sweep.mjs [baseUrl]
 *
 * This checks what a screenshot of one size cannot:
 *
 *   - the page never scrolls, in either axis
 *   - the scene FILLS its frame. This is the one that matters: the hall used to sit
 *     marooned in the middle with dead paper either side because the frame ratio and
 *     the viewBox disagreed, and no single screenshot at my own window size showed it.
 *   - the desk prompt is on screen and reachable
 *   - the character is inside the frame
 *   - no clipped text, no console errors
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const BASE = process.argv[2] ?? "http://localhost:3188";

function findExe() {
  const root = "C:/Users/skadd/AppData/Local/ms-playwright";
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p;
    }
    return null;
  };
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse()) {
    const r = walk(path.join(root, d));
    if (r) return r;
  }
  throw new Error("no playwright chromium installed");
}

const VIEWPORTS = [
  { w: 320, h: 568, dpr: 2, name: "iphone-se", touch: true },
  { w: 360, h: 640, dpr: 3, name: "android-sm", touch: true },
  { w: 390, h: 844, dpr: 3, name: "iphone-14", touch: true },
  { w: 430, h: 932, dpr: 3, name: "iphone-pro-max", touch: true },
  { w: 768, h: 1024, dpr: 2, name: "ipad-portrait", touch: true },
  { w: 1024, h: 768, dpr: 2, name: "ipad-landscape", touch: true },
  { w: 1280, h: 720, dpr: 1, name: "laptop-720" },
  { w: 1440, h: 900, dpr: 2, name: "macbook" },
  { w: 1568, h: 717, dpr: 1, name: "hunts-window" },
  { w: 1920, h: 1080, dpr: 1, name: "desktop-fhd" },
  { w: 2560, h: 1440, dpr: 1, name: "qhd" },
  { w: 3440, h: 1440, dpr: 1, name: "ultrawide" },
];

let checks = 0, failures = 0;
const ok = (vp, m) => { checks++; console.log(`  ok   [${vp}] ${m}`); };
const bad = (vp, m) => { checks++; failures++; console.log(`  FAIL [${vp}] ${m}`); };

const browser = await chromium.launch({ executablePath: findExe() });
fs.mkdirSync("audit/shots/hall", { recursive: true });

for (const vp of VIEWPORTS) {
  const label = `${vp.w}x${vp.h} ${vp.name}`;
  // Real phones report `pointer: coarse`, which is how the hall knows not to
  // advertise WASD to someone holding a screen. Without hasTouch the harness was
  // grading a page no phone would ever see.
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr,
    hasTouch: !!vp.touch, isMobile: !!vp.touch,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".hall-scene", { timeout: 30_000 });
    await page.waitForTimeout(1800);

    // 1. the page must not scroll
    const doc = await page.evaluate(() => ({
      dh: document.documentElement.scrollHeight, vh: innerHeight,
      dw: document.documentElement.scrollWidth, vw: innerWidth,
    }));
    if (doc.dh > doc.vh + 2) bad(label, `scrolls vertically (${doc.dh} in ${doc.vh})`);
    else ok(label, "no vertical scroll");
    if (doc.dw > doc.vw + 2) bad(label, `scrolls horizontally by ${doc.dw - doc.vw}px`);
    else ok(label, "no horizontal scroll");

    // 2. THE ONE THAT MATTERS: does the frame fill the SCREEN?
    //
    // The first version of this sweep only asked whether the drawing filled its
    // frame. It does, always - so it passed 96/96 while a phone was showing a
    // 390x197 slot in an 844 tall page with 77% of the screen blank. Measure the
    // frame against the VIEWPORT, which is the thing a person actually looks at.
    const cover = await page.evaluate(() => {
      const s = document.querySelector(".hall-scene")?.getBoundingClientRect();
      if (!s) return null;
      return { area: (s.width * s.height) / (innerWidth * innerHeight), h: s.height / innerHeight, w: s.width / innerWidth };
    });
    if (!cover) bad(label, "no scene box");
    else if (cover.area < 0.45) bad(label, `frame covers only ${(cover.area * 100).toFixed(0)}% of the screen`);
    else ok(label, `frame covers ${(cover.area * 100).toFixed(0)}% of the screen (${(cover.w * 100).toFixed(0)}% w, ${(cover.h * 100).toFixed(0)}% h)`);

    // 3. Nothing may sit on top of anything else.
    const collisions = await page.evaluate(() => {
      const pick = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null;
      const signs = [...document.querySelectorAll(".hall-prompt")].map((e) => e.getBoundingClientRect());
      const parts = { bar: pick(".hall-bar"), hint: pick(".hall-hint"), char: pick(".hall-char") };
      // Signs must not stack on each other either. The pair of them landed on top
      // of the vault door once and nothing here noticed.
      signs.forEach((r, i) => { parts[`sign${i}`] = r; });
      const hits = [];
      const names = Object.keys(parts);
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = parts[names[i]], b = parts[names[j]];
          if (!a || !b) continue;
          // The character walking behind the desk sign is the scene working, not a
          // layout fault. Everything else overlapping is a fault.
          if (names[i] === "char" || names[j] === "char") continue;
          const ov = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
                   * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (ov > 1) hits.push(`${names[i]} over ${names[j]}`);
        }
      }
      return hits;
    });
    if (collisions.length) bad(label, `overlap: ${collisions.join(", ")}`);
    else ok(label, "chrome does not overlap");

    // 4. does the scene fill its frame?
    const fill = await page.evaluate(() => {
      const scene = document.querySelector(".hall-scene");
      const svg = scene?.querySelector("svg");
      if (!scene || !svg) return null;
      const s = scene.getBoundingClientRect();
      const g = svg.getBBox ? svg.getBBox() : null;
      const vb = svg.viewBox?.baseVal;
      if (!g || !vb || !vb.width) return null;
      // How much of the viewBox the drawn content actually occupies.
      return {
        w: g.width / vb.width, h: g.height / vb.height,
        sceneRatio: s.width / s.height, vbRatio: vb.width / vb.height,
      };
    });
    if (!fill) bad(label, "could not measure the scene");
    else {
      const ratioDrift = Math.abs(fill.sceneRatio - fill.vbRatio) / fill.vbRatio;
      if (ratioDrift > 0.04) bad(label, `frame ${fill.sceneRatio.toFixed(2)} vs viewBox ${fill.vbRatio.toFixed(2)}: scene will letterbox`);
      else ok(label, `frame matches viewBox (${fill.sceneRatio.toFixed(2)})`);
      if (fill.w < 0.7) bad(label, `content fills only ${(fill.w * 100).toFixed(0)}% of the frame width`);
      else ok(label, `content fills ${(fill.w * 100).toFixed(0)}% width, ${(fill.h * 100).toFixed(0)}% height`);
    }

    // 5. BOTH destination signs must be fully on screen.
    const prompts = await page.evaluate(() => [...document.querySelectorAll(".hall-prompt")].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.textContent.trim().slice(0, 12), off: r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1 };
    }));
    if (prompts.length !== 2) bad(label, `expected 2 signs, found ${prompts.length}`);
    else if (prompts.some((p) => p.off)) bad(label, `sign off screen: ${prompts.filter((p) => p.off).map((p) => p.name).join(", ")}`);
    else ok(label, "both signs on screen");

    // 6. the character must be inside the frame
    const chr = await page.evaluate(() => {
      const el = document.querySelector(".hall-char");
      const sc = document.querySelector(".hall-scene");
      if (!el || !sc) return null;
      const a = el.getBoundingClientRect(), b = sc.getBoundingClientRect();
      return { inside: a.left >= b.left - 2 && a.right <= b.right + 2 && a.top >= b.top - 2 && a.bottom <= b.bottom + 2, w: a.width };
    });
    if (!chr) bad(label, "no character rendered");
    else if (!chr.inside) bad(label, "character is outside the frame");
    else ok(label, `character in frame (${chr.w.toFixed(0)}px)`);

    // 7. clipped text
    const clipped = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.children.length) continue;
        const t = (el.textContent ?? "").trim();
        if (!t) continue;
        const cs = getComputedStyle(el);
        if (cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.display === "none") continue;
        if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.className || el.tagName}: "${t.slice(0, 26)}"`);
      }
      return out;
    });
    if (clipped.length) bad(label, `${clipped.length} clipped: ${clipped[0]}`);
    else ok(label, "no clipped text");

    if (errors.length) bad(label, `console: ${errors[0].slice(0, 70)}`);
    else ok(label, "no console errors");

    await page.screenshot({ path: `audit/shots/hall/${vp.w}-${vp.name}.png` });
  } catch (e) {
    bad(label, `harness: ${String(e.message ?? e).split("\n")[0].slice(0, 90)}`);
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${checks} checks, ${failures} failed across ${VIEWPORTS.length} viewports`);
if (checks === 0) { console.error("FATAL: graded nothing"); process.exit(2); }
process.exit(failures > 0 ? 1 : 0);
