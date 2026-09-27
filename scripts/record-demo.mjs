#!/usr/bin/env node
/**
 * The 30-second demo: the real site, walked by a script, with a caption for each step.
 *   node scripts/record-demo.mjs [url]     -> docs/media/demo.webm; ffmpeg then makes demo.mp4 and demo.gif (commands in README)
 * Everything shown is the live UI; the only additions are the caption bar and the end card, injected for the video.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const BASE = process.argv[2] ?? "http://localhost:3199";
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p; } return null; };
let exe = null; for (const d of fs.readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse()) { exe = walk(path.join(root, d)); if (exe) break; }

const OUT = path.resolve("docs/media/rec");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

const CAPTION_CSS = `
#demo-cap { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 99999; max-width: 1100px;
  background: #111; color: #eee; font: 600 24px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 14px 22px; border: 2px solid #ccff00; box-shadow: 4px 4px 0 #ccff00; letter-spacing: 0.01em; text-align: center;
  transition: opacity .25s; pointer-events: none; }
#demo-cap b { color: #ccff00; font-weight: 700; }
#demo-end { position: fixed; inset: 0; z-index: 100000; background: #eee; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111; }
#demo-end h1 { margin: 0; font-size: 54px; letter-spacing: 0.12em; }
#demo-end p { margin: 0; font-size: 24px; }
#demo-end .pill { background: #111; color: #ccff00; padding: 10px 18px; font-size: 22px; }
`;
async function caption(html) {
  await page.evaluate(([css, h]) => {
    if (!document.getElementById("demo-style")) { const s = document.createElement("style"); s.id = "demo-style"; s.textContent = css; document.head.appendChild(s); }
    let el = document.getElementById("demo-cap");
    if (!el) { el = document.createElement("div"); el.id = "demo-cap"; document.body.appendChild(el); }
    el.innerHTML = h;
  }, [CAPTION_CSS, html]);
}
async function walkTo(which) {
  const at = await page.evaluate((w) => {
    const el = document.querySelector(".hall-scene"); const v = el?.dataset?.[w]; if (!v) return null;
    const [px, py] = v.split(",").map(Number); const r = el.getBoundingClientRect();
    return { x: r.left + (px / 100) * r.width, y: r.top + (py / 100) * r.height };
  }, which);
  await page.mouse.click(at.x, at.y);
}
const into = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "center" }), sel);

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hall-char", { timeout: 60_000 });
await wait(800);
await caption("Your Rare Friend walks into <b>the First Bank of Friends</b>");
await wait(2600);

// 1. sign once
await walkTo("desk");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Desk")', { timeout: 20_000 });
await page.click('.hall-prompt.is-near:has-text("The Desk")');
await page.waitForSelector(".acct .hall-lever");
await caption("<b>Sign once</b>: two approvals and a join, from your Friend's own wallet");
await wait(2400);
await into(".acct .hall-lever");
await wait(700);
await page.click(".acct .hall-lever");
await page.waitForSelector(".acct-welcome h3");
await caption("Your Friend's RF and WETH rewards <b>auto-deposit</b> into your own box");
await wait(2600);
await page.click(".hall-panel header button");

// 2. the swap desk
await walkTo("floor");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Trading Floor")', { timeout: 20_000 });
await page.click('.hall-prompt.is-near:has-text("The Trading Floor")');
await page.waitForSelector(".floor-board .floor-word", { timeout: 120_000 });
await caption("The <b>swap desk</b>, live from chain: buys 30% dips, sells 30% rallies, pays the 5% toll");
await wait(2800);
await into(".floor-breakeven");
await caption("The toll comes back to members: <b>every Friend who joins makes every trade cheaper</b>");
await wait(3000);
await page.click('.floor-shares button:has-text("nearly everyone")');
for (let i = 0; i < 15; i++) {
  await page.click(".floor .floor-roll");
  await page.waitForSelector(".floor-sim .receipt");
  // the first week that trades at all, win or lose: the demo does not pick a winning week
  if (await page.locator(".floor-swaps li").count()) break;
}
await into(".floor-sim-word");
await caption("Simulate a week: every swap listed, <b>stamped SIMULATED</b>");
await wait(2400);
await into(".floor-sim .receipt");
await caption("It ends on a <b>receipt</b>: deposited, swap desk, toll rebate, coming home");
await wait(2800);
await page.click(".hall-panel header button");

// 3. the vault and the final receipt
await walkTo("vault");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Vault")', { timeout: 20_000 });
await page.click('.hall-prompt.is-near:has-text("The Vault")');
await page.waitForSelector(".vault .box");
await into(".vault .box .receipt");
await caption("<b>Claim any time</b>: take out RF, WETH, or close in one step");
await wait(2600);
await into(".box .close-open");
await wait(500);
await page.click(".box .close-open");
await page.waitForSelector(".close-go");
await page.click(".close-go");
await page.waitForSelector(".vault-closed .receipt");
await caption("<b>Take everything home</b>, with a receipt");
await wait(2600);

// end card
await page.evaluate((css) => {
  const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  const cap = document.getElementById("demo-cap"); if (cap) cap.remove();
  const el = document.createElement("div"); el.id = "demo-end";
  el.innerHTML = "<h1>THE FIRST BANK OF FRIENDS</h1><p>sign once &middot; auto-deposit &middot; a swap desk whose toll comes back &middot; a receipt</p><span class='pill'>bank-of-friends-nu.vercel.app</span><p style='font-size:16px;color:#666'>Rare Friends Vibeathon &middot; Economy Potential &middot; simulated, not deployed</p>";
  document.body.appendChild(el);
}, CAPTION_CSS);
await wait(3000);

await ctx.close();
await browser.close();
const vid = fs.readdirSync(OUT).find((f) => f.endsWith(".webm"));
fs.renameSync(path.join(OUT, vid), "docs/media/demo.webm");
fs.rmSync(OUT, { recursive: true, force: true });
console.log("wrote docs/media/demo.webm");
