import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p; } return null; };
let exe = null; for (const d of fs.readdirSync(root).filter(x => x.startsWith("chromium")).sort().reverse()) { exe = walk(path.join(root, d)); if (exe) break; }
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 960, height: 640 } });
p.on("console", m => { if (m.type() === "error") console.log("  console error:", m.text().slice(0, 120)); });
await p.goto("http://127.0.0.1:4173/game.html", { waitUntil: "domcontentloaded", timeout: 45000 });
await p.waitForTimeout(3500);
const info = await p.evaluate(() => {
  const c = document.querySelector("canvas");
  const bank = document.querySelector(".bank");
  const bw = document.querySelector(".bank-world");
  const wv = document.querySelector(".rf-world-view");
  const chain = [];
  let n = c;
  while (n && n !== document.body) { chain.push(`${n.tagName.toLowerCase()}${n.className ? "." + String(n.className).split(" ").join(".") : ""}`); n = n.parentElement; }
  return {
    hasBank: !!bank, hasBankWorld: !!bw, hasWorldView: !!wv, hasCanvas: !!c,
    canvasFilter: c ? getComputedStyle(c).filter : null,
    ancestry: chain.reverse().join(" > "),
    bodyHtml: document.body.innerHTML.slice(0, 200),
  };
});
console.log(JSON.stringify(info, null, 2));
await b.close(); process.exit(0);
