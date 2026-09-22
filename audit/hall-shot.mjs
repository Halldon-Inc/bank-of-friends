import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory()){const r=walk(p); if(r)return r;} else if(/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name))return p;} return null;};
let exe=null; for(const d of fs.readdirSync(root).filter(x=>x.startsWith("chromium")).sort().reverse()){exe=walk(path.join(root,d)); if(exe)break;}
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errs=[]; p.on("console",m=>{if(m.type()==="error")errs.push(m.text())}); p.on("pageerror",e=>errs.push(String(e)));
await p.goto("http://localhost:3188/hall", { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(1500);
await p.fill('input[aria-label="Wallet address or ENS name"]', "huntclubhero.eth");
await p.click('button:has-text("Look up")');
await p.waitForSelector(".picker-friend", { timeout: 30000 });
await p.waitForTimeout(900);
await p.screenshot({ path: "audit/shots/hall-pick.png" });
// walk in as the GENESIS, the one the SDK forbids
await p.locator(".picker-friend").first().click();
await p.waitForSelector(".hall-scene", { timeout: 20000 });
await p.waitForTimeout(2200);
await p.screenshot({ path: "audit/shots/hall-genesis.png" });
console.log("console errors:", errs.length ? errs.slice(0,3) : "none");
await b.close(); process.exit(0);
