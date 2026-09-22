import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk = (d) => { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name);
  if (e.isDirectory()) { const r=walk(p); if(r) return r; } else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p; } return null; };
let exe=null; for (const d of fs.readdirSync(root).filter(x=>x.startsWith("chromium")).sort().reverse()) { exe=walk(path.join(root,d)); if(exe) break; }
const b = await chromium.launch({ executablePath: exe });
for (const w of [390, 1280]) {
  const p = await b.newPage({ viewport: { width: w, height: w === 390 ? 900 : 1000 }, deviceScaleFactor: 2 });
  await p.goto("http://localhost:3188/#enrol", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.fill('input[aria-label="Wallet address or ENS name"]', "huntclubhero.eth");
  await p.click('button:has-text("Look up")');
  await p.waitForSelector(".picker-friend", { timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.locator(".picker-friend").first().click();
  await p.waitForTimeout(600);
  await p.locator("#enrol").screenshot({ path: `audit/shots/picker-${w}.png` });
  console.log(`shot picker-${w}.png`);
  await p.close();
}
await b.close(); process.exit(0);
