#!/usr/bin/env node
/**
 * Visual + layout harness for the desk.
 *
 * Sweeps the page across real device widths and FAILS on:
 *   - horizontal overflow (the classic phone defect)
 *   - any text node clipped by its own box
 *   - a broken image (the Friend artwork is the point; a broken tile is fatal)
 *   - any console error
 *
 * Shots land in audit/shots/.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");

const URL_BASE = process.argv[2] ?? "http://localhost:3188";
const OUT = "audit/shots";
fs.mkdirSync(OUT, { recursive: true });

// Resolve whatever Playwright build is actually installed. The directory layout
// changed between builds (chrome-win/headless_shell.exe -> chrome-headless-shell-win64/),
// so never pin a path.
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
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse();
  for (const d of dirs) { const r = walk(path.join(root, d)); if (r) return r; }
  throw new Error("no playwright chromium found");
}

const VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 720 },
  { name: "iphone-12", width: 390, height: 844 },
  { name: "phone-lg", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1680, height: 1050 },
  { name: "wide", width: 2560, height: 1440 },
];

const browser = await chromium.launch({ executablePath: findExe() });
let failures = 0, checks = 0;
const fail = (vp, msg) => { failures++; console.log(`  FAIL [${vp}] ${msg}`); };
const ok = (vp, msg) => { checks++; console.log(`  ok   [${vp}] ${msg}`); };

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL_BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(900);

  // 1. horizontal overflow
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  checks++;
  if (overflow > 1) fail(vp.name, `horizontal overflow of ${overflow}px`); else ok(vp.name, "no horizontal overflow");

  // 2. clipped text
  const clipped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 0) continue;
      const t = (el.textContent ?? "").trim();
      if (!t) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === "hidden" || cs.overflowX === "hidden") continue;
      if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.tagName}.${el.className} "${t.slice(0, 40)}"`);
    }
    return out;
  });
  checks++;
  if (clipped.length) fail(vp.name, `${clipped.length} clipped text node(s): ${clipped[0]}`);
  else ok(vp.name, "no clipped text");

  // 3. broken images: the Friend artwork is the whole Character Spotlight claim
  const imgs = await page.evaluate(() =>
    [...document.images].map((i) => ({ src: i.currentSrc.slice(0, 48), ok: i.complete && i.naturalWidth > 0 })));
  checks++;
  const broken = imgs.filter((i) => !i.ok);
  if (broken.length) fail(vp.name, `${broken.length} broken image(s)`);
  else ok(vp.name, `${imgs.length} images rendered`);

  // 4. console errors
  checks++;
  if (errors.length) fail(vp.name, `console error: ${errors[0].slice(0, 90)}`);
  else ok(vp.name, "no console errors");

  // 5. the status word must actually be on screen and legible
  const statusBox = await page.evaluate(() => {
    const el = document.querySelector(".status-word");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, right: r.right, vw: innerWidth, text: el.textContent?.trim() };
  });
  checks++;
  if (!statusBox) fail(vp.name, "no status word rendered");
  else if (statusBox.left < -1 || statusBox.right > statusBox.vw + 1) fail(vp.name, `status word overflows: ${JSON.stringify(statusBox)}`);
  else ok(vp.name, `status "${statusBox.text}" fits (${Math.round(statusBox.w)}x${Math.round(statusBox.h)})`);

  await page.screenshot({ path: `${OUT}/${vp.width}-${vp.name}.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error("FATAL: graded nothing"); process.exit(2); }
process.exit(failures > 0 ? 1 : 0);
