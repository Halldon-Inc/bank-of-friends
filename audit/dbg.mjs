import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const root="C:/Users/skadd/AppData/Local/ms-playwright";
const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory()){const r=walk(p); if(r)return r;} else if(/^(chrome|chrome-headless-shell|headless_shell)\.exe$/i.test(e.name))return p;} return null;};
let exe=null; for(const d of fs.readdirSync(root).filter(x=>x.startsWith("chromium")).sort().reverse()){exe=walk(path.join(root,d)); if(exe)break;}
const b=await chromium.launch({executablePath:exe});
const p=await b.newPage({viewport:{width:390,height:844}});
await p.goto("http://localhost:3188",{waitUntil:"domcontentloaded",timeout:45000});
await p.waitForTimeout(2500);
const bad=await p.evaluate(()=>{
  const vw=document.documentElement.clientWidth, out=[];
  for(const el of document.querySelectorAll("body *")){
    const r=el.getBoundingClientRect();
    if(r.right>vw+1||r.left<-1){
      const cs=getComputedStyle(el);
      out.push({tag:el.tagName,cls:String(el.className).slice(0,34),
        left:Math.round(r.left),right:Math.round(r.right),w:Math.round(r.width),
        ov:cs.overflow,tf:cs.transform.slice(0,24)});
    }
  }
  return out.slice(0,10);
});
console.log("viewport 390 | scrollWidth:", await p.evaluate(()=>document.documentElement.scrollWidth));
for(const x of bad) console.log(" ",JSON.stringify(x));
await b.close();
process.exit(0);
