#!/usr/bin/env node
/**
 * The four screenshots the submission embeds (docs/media/{hall,desk,floor,vault}.png), taken
 * from the deployed site the same way hall-play.mjs walks it.   node scripts/shoot-media.mjs <url>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const BASE = process.argv[2] ?? "https://bank-of-friends-nu.vercel.app";

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
async function walkTo(page, which) {
  const at = await page.evaluate((w) => {
    const el = document.querySelector(".hall-scene");
    const v = el?.dataset?.[w];
    if (!v) return null;
    const [px, py] = v.split(",").map(Number);
    const r = el.getBoundingClientRect();
    return { x: r.left + (px / 100) * r.width, y: r.top + (py / 100) * r.height };
  }, which);
  await page.mouse.click(at.x, at.y);
}
const shot = (page, name, sel) => sel
  ? page.locator(sel).first().screenshot({ path: `docs/media/${name}.png` })
  : page.screenshot({ path: `docs/media/${name}.png` });

const browser = await chromium.launch({ executablePath: findExe() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".hall-char", { timeout: 30_000 });
await page.waitForTimeout(1500);
await shot(page, "hall");

await walkTo(page, "desk");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Desk")', { timeout: 15_000 });
await page.click('.hall-prompt.is-near:has-text("The Desk")');
await page.waitForSelector(".hall-panel", { timeout: 10_000 });
await page.waitForTimeout(600);
await shot(page, "desk", ".hall-panel");
await page.click(".hall-panel header button");

await walkTo(page, "floor");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Trading Floor")', { timeout: 20_000 });
await page.click('.hall-prompt.is-near:has-text("The Trading Floor")');
await page.waitForSelector(".floor-board .floor-word", { timeout: 120_000 });
await page.waitForTimeout(800);
await shot(page, "floor", ".hall-panel");
await page.click(".hall-panel header button");

await walkTo(page, "vault");
await page.waitForSelector('.hall-prompt.is-near:has-text("The Vault")', { timeout: 20_000 });
await page.click('.hall-prompt.is-near:has-text("The Vault")');
await page.waitForSelector(".vault-big", { timeout: 10_000 });
await page.waitForTimeout(600);
await shot(page, "vault", ".hall-panel");
await browser.close();
for (const n of ["hall", "desk", "floor", "vault"]) console.log(n, fs.statSync(`docs/media/${n}.png`).size, "bytes");
