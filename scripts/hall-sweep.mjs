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
 *   - all three destination signs (desk, trading floor, vault) are on screen
 *   - the ticker never sits on a sign
 *   - every sign sits on (within a few px of) the artwork it names
 *   - the keeper's stop leaves a body width of air beside the vault's sign
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
      const parts = { bar: pick(".hall-bar"), hint: pick(".hall-hint"), ticker: pick(".hall-ticker"), char: pick(".hall-char") };
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

    // 5. EVERY destination sign must be fully on screen. There are three now, and a
    // count that silently stayed at two would stop grading the third.
    const prompts = await page.evaluate(() => [...document.querySelectorAll(".hall-prompt")].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.textContent.trim().slice(0, 12), off: r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1 };
    }));
    if (prompts.length !== 3) bad(label, `expected 3 signs, found ${prompts.length}`);
    else if (prompts.some((p) => p.off)) bad(label, `sign off screen: ${prompts.filter((p) => p.off).map((p) => p.name).join(", ")}`);
    else ok(label, "all three signs on screen");

    // 5b. EVERY SIGN SITS ON THE THING IT NAMES. Measured, not assumed: on the phone
    // the vault's sign once floated mid-hall and the floor's sat on the frieze, and
    // every other check here passed, because none asked where a sign was relative
    // to its artwork. The gap between the sign's box and the artwork's box must be
    // at most SIGN_SLACK px (0 when they touch or overlap).
    const SIGN_SLACK = 8;
    const pinned = await page.evaluate(() => [...document.querySelectorAll(".hall-prompt[data-art]")].map((el) => {
      const art = document.querySelector(`.hall-bank .art-${el.dataset.art}`);
      if (!art) return { name: el.dataset.station, gap: null };
      const a = el.getBoundingClientRect(), b = art.getBoundingClientRect();
      const dx = Math.max(0, b.left - a.right, a.left - b.right);
      const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      return { name: el.dataset.station, gap: Math.hypot(dx, dy) };
    }));
    const loose = pinned.filter((p) => p.gap === null || p.gap > SIGN_SLACK);
    if (pinned.length !== 3) bad(label, `expected 3 pinned signs, found ${pinned.length}`);
    else if (loose.length) bad(label, `sign off its artwork: ${loose.map((p) => `${p.name} ${p.gap === null ? "no artwork" : `${p.gap.toFixed(0)}px away`}`).join(", ")}`);
    else ok(label, `every sign sits on its artwork (worst gap ${Math.max(...pinned.map((p) => p.gap)).toFixed(0)}px)`);

    // 5c. THE KEEPER STOPS CLEAR OF THE VAULT'S SIGN. It once arrived standing on
    // the sign. Read its stop from the custom properties the component measured,
    // build its box at that stop, and require at least 0.9 of a body width of air
    // between it and the sign.
    const keeperGap = await page.evaluate(() => {
      const k = document.querySelector(".hall-keeper");
      const sign = document.querySelector('.hall-prompt[data-station="vault"]');
      const scene = document.querySelector(".hall-scene");
      if (!k || !sign || !scene) return null;
      const sr = scene.getBoundingClientRect(), cs = getComputedStyle(k);
      const w = k.getBoundingClientRect().width, h = k.getBoundingClientRect().height;
      const x = sr.left + (parseFloat(cs.getPropertyValue("--kx1")) / 100) * sr.width;
      const y = sr.top + (parseFloat(cs.getPropertyValue("--ky1")) / 100) * sr.height;
      const kb = { left: x - w / 2, right: x + w / 2, top: y - 0.92 * h, bottom: y + 0.08 * h };
      const b = sign.getBoundingClientRect();
      const dx = Math.max(0, b.left - kb.right, kb.left - b.right);
      const dy = Math.max(0, b.top - kb.bottom, kb.top - b.bottom);
      return { gap: Math.hypot(dx, dy), w };
    });
    if (!keeperGap) bad(label, "could not measure the keeper's stop");
    else if (keeperGap.gap < keeperGap.w * 0.9) bad(label, `keeper stops ${keeperGap.gap.toFixed(0)}px from the vault sign (body ${keeperGap.w.toFixed(0)}px)`);
    else ok(label, `keeper stops ${keeperGap.gap.toFixed(0)}px clear of the vault sign (body ${keeperGap.w.toFixed(0)}px)`);

    // 5d. THE HUD SHOWS BOTH SIDES OF THE FUND. It once read "5,076 RF idle", hiding
    // the WETH that is most of the value. Require an RF figure AND a WETH figure,
    // and that the figure sits wholly inside the viewport.
    const hud = await page.evaluate(() => {
      const el = document.querySelector(".hall-bar .hall-idle");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent?.replace(/\s+/g, " ").trim() ?? "", fits: r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0 };
    });
    if (!hud) bad(label, "no idle figure in the HUD");
    else if (!/[\d,]+ RF/.test(hud.text) || !/[\d.]+ WETH/.test(hud.text)) bad(label, `HUD shows one side only: "${hud.text}"`);
    else if (!hud.fits) bad(label, `HUD idle figure does not fit: "${hud.text}"`);
    else ok(label, `HUD shows both sides: "${hud.text}"`);

    // 5e. THE VAULT HOLDS PLAQUE shows an RF figure AND a WETH figure, and both lines
    // fit on the plate at every size. The plate is a triangle's worth of room on a
    // phone, so "fits" is measured on each line against the plate, not assumed.
    // The figures arrive with the live read, so wait for them rather than grading
    // the loading state.
    await page.waitForFunction(() => /RF/.test(document.querySelector(".hall-plaque-figs")?.textContent ?? ""), null, { timeout: 90_000 }).catch(() => {});
    const plate = await page.evaluate(() => {
      const el = document.querySelector(".hall-plaque");
      const sc = document.querySelector(".hall-scene");
      if (!el || !sc) return null;
      const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      // The TEXT's own box, via a Range: a flex child's box can be the plate's width
      // while its text spills past both edges, which is how the first version passed.
      // Measure against the plate's INNER RULE, not the outer box: the head once
      // sat on the rule itself and every earlier check here still passed.
      const rule = document.querySelector(".hall-bank .plaque-rule")?.getBoundingClientRect() ?? r;
      const lines = [...el.children].map((c) => {
        const range = document.createRange(); range.selectNodeContents(c);
        const t = range.getBoundingClientRect();
        return {
          // Clear air: the text's box must sit at least 2px inside the rule on every side.
          spill: Math.max(0, rule.left + 2 - t.left, t.right - (rule.right - 2), rule.top + 2 - t.top, t.bottom - (rule.bottom - 2)),
          air: Math.min(t.left - rule.left, rule.right - t.right, t.top - rule.top, rule.bottom - t.bottom),
          text: c.textContent?.trim() ?? "",
        };
      });
      return {
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        inside: r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
        overflow: lines.filter((l) => l.spill > 0).map((l) => `${l.text} (air ${l.air.toFixed(1)}px)`),
        air: Math.min(...lines.map((l) => l.air)),
        smallest: Math.min(...[...el.children].map((c) => parseFloat(getComputedStyle(c).fontSize))),
        tooTall: el.scrollHeight > r.height + 1,
      };
    });
    if (!plate) bad(label, "no vault plaque");
    else if (!/[\d.,]+[KMB]? RF/.test(plate.text) || !/[\d.]+ WETH/.test(plate.text)) bad(label, `plaque lacks an RF and a WETH figure: "${plate.text}"`);
    else if (!plate.inside || plate.overflow.length || plate.tooTall) bad(label, `plaque does not fit: "${plate.text}" ${plate.overflow.join(" | ")}${plate.tooTall ? " (too tall)" : ""}`);
    else if (plate.smallest < 5) bad(label, `plaque type is ${plate.smallest.toFixed(1)}px, too small to read`);
    else ok(label, `plaque reads "${plate.text}" (type >= ${plate.smallest.toFixed(1)}px, air >= ${plate.air.toFixed(1)}px inside the rule)`);

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
