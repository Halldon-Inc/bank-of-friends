#!/usr/bin/env node
/**
 * Rasterise docs/media/economy.svg to docs/media/economy.png (the PR embeds the PNG;
 * GitHub does not always render an SVG inside a table cell). Uses the same Playwright
 * Chromium the hall harnesses use.   node scripts/render-economy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
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
const svg = fs.readFileSync("docs/media/economy.svg", "utf8");
const browser = await chromium.launch({ executablePath: findExe() });
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:#eee">${svg}</body></html>`);
await page.screenshot({ path: "docs/media/economy.png", clip: { x: 0, y: 0, width: 1400, height: 820 } });
await browser.close();
console.log("wrote docs/media/economy.png", fs.statSync("docs/media/economy.png").size, "bytes");
