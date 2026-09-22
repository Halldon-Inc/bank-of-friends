import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk = (d) => { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name);
  if (e.isDirectory()) { const r=walk(p); if(r) return r; } else if (/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name)) return p; } return null; };
let exe=null; for (const d of fs.readdirSync(root).filter(x=>x.startsWith("chromium")).sort().reverse()) { exe=walk(path.join(root,d)); if(exe) break; }
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
const errs = [];
p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
p.on("pageerror", e => errs.push(String(e)));
await p.goto("https://halldon-inc.github.io/bank-of-friends/", { waitUntil: "networkidle", timeout: 60000 });
await p.waitForTimeout(3000);
const info = await p.evaluate(() => ({
  title: document.title,
  text: (document.body.innerText || "").replace(/\s+/g," ").trim().slice(0, 300),
  hasIframe: !!document.querySelector("iframe"),
  buttons: [...document.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean).slice(0, 8),
}));
console.log(JSON.stringify(info, null, 2));
console.log("console errors:", errs.length ? errs.slice(0,3) : "none");
await p.screenshot({ path: "audit/shots/preview-live.png" });
await b.close(); process.exit(0);
