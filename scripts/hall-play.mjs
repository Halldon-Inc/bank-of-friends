#!/usr/bin/env node
/**
 * Play the hall, in every room shape, and fail if any of it stops working.
 *
 *   node scripts/hall-play.mjs [baseUrl]
 *
 * The layout sweep proves the hall LOOKS right. This proves it WORKS: that you can
 * walk to the desk, that walking up to it does not throw you back to the door, that
 * the desk opens and the lever returns a real verdict from the strategy module.
 *
 * The respawn bug is the reason this exists. It was reported as "i walk up to the
 * desk, it restarts me at the beginning", it passed every visual check, and it was
 * caused by a React dependency array. Nothing but playing it catches that.
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

let checks = 0, failures = 0;
const ok = (m) => { checks++; console.log(`  ok   ${m}`); };
const bad = (m) => { checks++; failures++; console.log(`  FAIL ${m}`); };

const charBox = (page) => page.evaluate(() => {
  const el = document.querySelector(".hall-char");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

const browser = await chromium.launch({ executablePath: findExe() });

/* Each viewport is chosen to select a different room. */
for (const vp of [
  { w: 1568, h: 717, room: "wide", touch: false },
  { w: 1440, h: 900, room: "mid", touch: false },
  { w: 390, h: 844, room: "tall", touch: true },
]) {
  const label = `${vp.room} @ ${vp.w}x${vp.h}`;
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch, isMobile: vp.touch,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".hall-char", { timeout: 30_000 });
    await page.waitForTimeout(900);

    const start = await charBox(page);
    if (!start) { bad(`${label}: no character`); throw new Error("no character"); }

    // Tap the floor just in front of the desk itself. Aiming a fixed distance
    // below the SIGN does not work: the sign floats a different height above the
    // desk in each room, so the same offset landed on the floor in one and off the
    // reachable area in another.
    const desk = await page.locator('.world-prop[data-prop="terminal"]').boundingBox();
    if (!desk) { bad(`${label}: no desk prop`); throw new Error("no desk"); }
    await page.mouse.click(desk.x + desk.width / 2, desk.y + desk.height + 16);

    // Give the walk time, then confirm arrival rather than assuming it.
    await page.waitForSelector(".hall-prompt.is-near", { timeout: 15_000 });
    ok(`${label}: walked to the desk and it armed`);

    const arrived = await charBox(page);
    const moved = Math.hypot(arrived.x - start.x, arrived.y - start.y);
    if (moved < 20) bad(`${label}: character never moved (${moved.toFixed(0)}px)`);
    else ok(`${label}: character travelled ${moved.toFixed(0)}px`);

    // THE RESPAWN BUG: arriving must not send you back to where you started.
    const backAtStart = Math.hypot(arrived.x - start.x, arrived.y - start.y) < 12;
    if (backAtStart) bad(`${label}: respawned at the door on arrival`);
    else ok(`${label}: did not respawn on arrival`);

    await page.click(".hall-prompt");
    await page.waitForSelector(".hall-panel", { timeout: 10_000 });
    ok(`${label}: the desk opened`);

    await page.click(".hall-lever");
    await page.waitForSelector(".hall-verdict:not(.spinning) .hall-word", { timeout: 20_000 });
    const word = (await page.textContent(".hall-word"))?.trim();
    if (word !== "TRADED" && word !== "SAT OUT") bad(`${label}: lever gave "${word}"`);
    else ok(`${label}: lever returned ${word}`);

    const because = (await page.textContent(".hall-because"))?.trim() ?? "";
    if (because.length < 12) bad(`${label}: no reason given`);
    else ok(`${label}: reason "${because.slice(0, 44)}..."`);

    // The nine checks must be real, not decoration.
    await page.click(".hall-why");
    const gates = await page.locator(".hall-gates li").count();
    if (gates < 8) bad(`${label}: only ${gates} gates shown`);
    else ok(`${label}: ${gates} gates listed`);

    if (errors.length) bad(`${label}: console: ${errors[0].slice(0, 70)}`);
    else ok(`${label}: no console errors`);
  } catch (e) {
    bad(`${label}: ${String(e.message ?? e).split("\n")[0].slice(0, 80)}`);
  }
  await ctx.close();
}

/* Rotating a phone swaps the room. It must not leave a broken scene behind. */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".hall-char", { timeout: 30_000 });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(1200);
    const fitted = await page.evaluate(() => {
      const s = document.querySelector(".hall-scene")?.getBoundingClientRect();
      const svg = document.querySelector(".hall-scene svg");
      const vb = svg?.viewBox?.baseVal;
      if (!s || !vb?.width) return null;
      return { drift: Math.abs(s.width / s.height - vb.width / vb.height) / (vb.width / vb.height), fits: s.width <= innerWidth + 1 && s.height <= innerHeight + 1 };
    });
    if (!fitted) bad("rotate: no scene after rotating");
    else if (fitted.drift > 0.04) bad(`rotate: frame no longer matches its viewBox (${(fitted.drift * 100).toFixed(0)}% off)`);
    else if (!fitted.fits) bad("rotate: scene overflows the viewport");
    else ok("rotate: re-fitted to the new room");
    if (errors.length) bad(`rotate: ${errors[0].slice(0, 70)}`);
    else ok("rotate: no errors");
  } catch (e) {
    bad(`rotate: ${String(e.message ?? e).split("\n")[0].slice(0, 80)}`);
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error("FATAL: graded nothing"); process.exit(2); }
process.exit(failures > 0 ? 1 : 0);
