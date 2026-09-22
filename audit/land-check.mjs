import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root = "C:/Users/skadd/AppData/Local/ms-playwright";
const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory()){const r=walk(p); if(r)return r;} else if(/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name))return p;} return null;};
let exe=null; for(const d of fs.readdirSync(root).filter(x=>x.startsWith("chromium")).sort().reverse()){exe=walk(path.join(root,d)); if(exe)break;}
const base = process.argv[2] || "http://localhost:3188";
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errs=[]; p.on("console",m=>{if(m.type()==="error")errs.push(m.text())}); p.on("pageerror",e=>errs.push("PAGEERROR: "+String(e)));
await p.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForSelector(".hall-scene", { timeout: 30000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: "audit/shots/land.png" });
console.log("landed straight in the hall, no clicks");

// THE BUG: walk to the desk and confirm we are not teleported back to the door.
const before = await p.locator(".hall-char").evaluate(el => ({ l: el.style.left, t: el.style.top }));
for (let i = 0; i < 26; i++) { await p.keyboard.down("w"); await p.waitForTimeout(60); }
await p.keyboard.up("w");
await p.waitForTimeout(900);
const after = await p.locator(".hall-char").evaluate(el => ({ l: el.style.left, t: el.style.top }));
console.log("char before:", before, "after walking:", after);
console.log(before.t === after.t ? "  DID NOT MOVE (bad)" : "  moved (good)");
const near = await p.locator(".hall-prompt.is-near").count();
console.log("prompt armed near the desk:", near ? "yes" : "not yet");
await p.screenshot({ path: "audit/shots/land-walked.png" });
console.log("errors:", errs.length ? errs.slice(0,3) : "none");
await b.close(); process.exit(0);
