#!/usr/bin/env node
/**
 * Every action in the hall, by TOUCH, on phones held both ways.
 *
 *   node scripts/mobile-touch.mjs [baseUrl] [shotDir]
 *
 * hall-play proves the hall works with a mouse. This one uses the touchscreen only
 * (tap, never click) at 360, 390 and 430 portrait and 844x390 landscape: walk to
 * each destination, open it from its sign, run each flow to its end, close it with
 * the X, and fail on anything a thumb cannot hit (under 44px tall), anything clipped
 * sideways, and any console error. Desktop 1440 runs the same walk with a mouse so
 * a phone fix cannot quietly break the big screen.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const BASE = process.argv[2] ?? "http://localhost:3188";
const SHOTS = process.argv[3] ?? path.resolve("data/mobile-shots");
fs.mkdirSync(SHOTS, { recursive: true });

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
const expect = (cond, m) => (cond ? ok(m) : bad(m));

const VIEWPORTS = [
  { name: "360", w: 360, h: 780, touch: true },
  { name: "390", w: 390, h: 844, touch: true },
  { name: "430", w: 430, h: 932, touch: true },
  { name: "landscape", w: 844, h: 390, touch: true },
  { name: "desktop", w: 1440, h: 900, touch: false },
];

/** Tap (or click, on desktop) the centre of an element. */
async function press(page, vp, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error("nothing to press");
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (vp.touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
}

/** Tap the destination's published standing spot on the floor. */
async function walkTo(page, vp, which) {
  const at = await page.evaluate((w) => {
    const el = document.querySelector(".hall-scene");
    const v = el?.dataset?.[w];
    if (!v) return null;
    const [px, py] = v.split(",").map(Number);
    const r = el.getBoundingClientRect();
    return { x: r.left + (px / 100) * r.width, y: r.top + (py / 100) * r.height };
  }, which);
  if (!at) throw new Error(`no published spot for ${which}`);
  if (vp.touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
}

/** Buttons, links, inputs and summaries in scope that a thumb would struggle with. */
const smallTargets = (page, scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  if (!root) return [];
  const out = [];
  for (const el of root.querySelectorAll("button, a[href], input, summary, select")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // A checkbox is hit through its whole label row, so measure the label.
    let hit = el.matches("input[type=checkbox]") ? (el.closest("label")?.getBoundingClientRect() ?? r) : r;
    // A drawn-small control can answer a bigger tap through an absolutely placed ::after.
    const after = getComputedStyle(el, "::after");
    if (after.content !== "none" && after.position === "absolute") {
      const px = (v) => parseFloat(v) || 0;
      hit = { width: r.width - px(after.left) - px(after.right), height: r.height - px(after.top) - px(after.bottom) };
    }
    if (hit.height < 43.5 || hit.width < 43.5) {
      out.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(hit.width)}x${Math.round(hit.height)}`);
    }
  }
  return out;
}, scope);

/** Anything wider than its panel, or the page itself scrolling sideways. */
const sideways = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  const panel = document.querySelector(".hall-panel");
  if (panel) {
    if (panel.scrollWidth > panel.clientWidth + 1) out.push(`panel scrolls sideways ${panel.scrollWidth} > ${panel.clientWidth}`);
    const pr = panel.getBoundingClientRect();
    for (const el of panel.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      // Clipped by a frame of its own that sits inside the panel: what shows is the frame.
      let clip = el.parentElement, framed = false;
      while (clip && clip !== panel) {
        if (getComputedStyle(clip).overflowX !== "visible") { const c = clip.getBoundingClientRect(); framed = c.left >= pr.left - 1 && c.right <= pr.right + 1; break; }
        clip = clip.parentElement;
      }
      if (framed) continue;
      if (r.right > pr.right + 1 || r.left < pr.left - 1) { out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} spills ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(pr.left)}..${Math.round(pr.right)}`); break; }
    }
  }
  return out;
});

/** Smallest font on screen inside scope, in px. */
const smallestFont = (page, scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  let min = Infinity, who = "";
  for (const el of root?.querySelectorAll("*") ?? []) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < min) { min = fs; who = `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${el.textContent.trim().slice(0, 20)}"`; }
  }
  return { min, who };
}, scope);

async function waitOpen(page, title) {
  await page.waitForSelector(`.hall-modal[aria-label="${title}"]`, { timeout: 8000 });
}

/** Scrolls inside the panel, if it is taller than the screen, and proves it moved. */
async function panelScrolls(page) {
  return page.evaluate(() => {
    const p = document.querySelector(".hall-panel");
    if (!p) return { need: false, moved: false };
    const need = p.scrollHeight > p.clientHeight + 1;
    const fits = p.getBoundingClientRect().bottom <= window.innerHeight + 1 && p.getBoundingClientRect().top >= -1;
    p.scrollTop = 0; const before = p.scrollTop; p.scrollTop = 99999; const moved = p.scrollTop > before; p.scrollTop = 0;
    return { need, moved, fits };
  });
}

/** Tap the sign itself from wherever you stand: it should walk you over and open. */
async function viaSign(page, vp, which, title) {
  await press(page, vp, page.locator(`.hall-prompt[data-station="${which}"]`));
  await page.waitForSelector(`.hall-modal[aria-label="${title}"]`, { timeout: 15_000 });
}

async function openStation(page, vp, which, title) {
  await walkTo(page, vp, which);
  await page.waitForSelector(`.hall-prompt.is-near[data-station="${which}"]`, { timeout: 10000 });
  await page.waitForTimeout(260);
  await press(page, vp, page.locator(`.hall-prompt[data-station="${which}"]`));
  await waitOpen(page, title);
}

async function closePanel(page, vp) {
  const x = page.locator(".hall-panel header button[aria-label='Close']");
  const b = await x.boundingBox();
  if (vp.touch) expect(b && b.width >= 43.5 && b.height >= 43.5, `close X is a 44px target (${b ? `${Math.round(b.width)}x${Math.round(b.height)}` : "missing"})`);
  await press(page, vp, x);
  await page.waitForSelector(".hall-modal", { state: "detached", timeout: 4000 }).then(() => ok("X closes the panel"), () => bad("X did not close the panel"));
}

async function panelChecks(page, vp, tag) {
  const s = await sideways(page);
  expect(!s.length, `${tag}: nothing clipped sideways${s.length ? ` (${s.join("; ")})` : ""}`);
  const small = await smallTargets(page, ".hall-panel");
  expect(!small.length || !vp.touch, `${tag}: every tap target >= 44px${small.length ? ` (${small.join("; ")})` : ""}`);
  const f = await smallestFont(page, ".hall-panel");
  expect(f.min >= 10 || !vp.touch, `${tag}: smallest text ${f.min.toFixed(1)}px ${f.who}`);
  const sc = await panelScrolls(page);
  expect(sc.fits, `${tag}: panel sits inside the screen`);
  if (sc.need) expect(sc.moved, `${tag}: panel scrolls internally`);
}

const browser = await chromium.launch({ executablePath: findExe() });

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.w}x${vp.h}${vp.touch ? ", touch" : ""})`);
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch, isMobile: vp.touch, deviceScaleFactor: vp.touch ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().slice(0, 90)}`); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${vp.name}-${n}.png`) });

  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForSelector(".hall-char", { timeout: 20_000 });
    await page.waitForTimeout(600);
    await shot("hall");
    const s = await sideways(page);
    expect(!s.length, `hall: no sideways scroll${s.length ? ` (${s.join("; ")})` : ""}`);
    if (vp.touch) {
      const small = await smallTargets(page, ".hall-bar");
      expect(!small.length, `HUD: tap targets >= 44px${small.length ? ` (${small.join("; ")})` : ""}`);
      const hint = await page.locator(".hall-hint").textContent();
      expect(/Tap a sign to go there/.test(hint ?? ""), `hint reads "${hint}"`);
    }

    // The harvested tag must not sit on the keeper it rises from.
    const tagClear = await page.evaluate(async () => {
      const k = document.querySelector(".hall-keeper");
      const tag = k?.querySelector(".keeper-tick");
      const svg = k?.querySelector("svg");
      if (!tag || !svg) return { ok: false, why: "missing" };
      // Freeze the tag at its most visible frame and compare boxes.
      tag.style.animation = "none"; tag.style.opacity = "1"; tag.style.transform = "translate(-50%, 0)";
      const a = tag.getBoundingClientRect(), b = svg.getBoundingClientRect();
      tag.style.animation = ""; tag.style.opacity = ""; tag.style.transform = "";
      return { ok: a.bottom <= b.top + 0.5, why: `tag bottom ${a.bottom.toFixed(1)} vs keeper top ${b.top.toFixed(1)}` };
    });
    expect(tagClear.ok, `"+ harvested" clears the keeper (${tagClear.why})`);

    // DESK: open an account, end on the welcome, go to the vault from it.
    await openStation(page, vp, "desk", "The Desk");
    ok("walked to the desk and opened it from its sign");
    await shot("desk");
    await panelChecks(page, vp, "desk");
    await press(page, vp, page.getByRole("button", { name: "Open my account" }));
    await page.waitForSelector(".acct-welcome", { timeout: 4000 }).then(() => ok("desk: Open my account ends on the welcome"), () => bad("desk: no welcome"));
    await shot("desk-welcome");
    await panelChecks(page, vp, "desk welcome");
    await press(page, vp, page.getByRole("button", { name: "See my box in the vault" }));
    await waitOpen(page, "The Vault").then(() => ok("desk: See my box opens the vault"), () => bad("desk: See my box did nothing"));
    await page.waitForSelector(".box", { timeout: 4000 }).then(() => ok("vault: the new box is open with its receipt"), () => bad("vault: no box"));
    await shot("vault-box");
    await panelChecks(page, vp, "vault");
    await press(page, vp, page.getByRole("button", { name: "Take out RF" }));
    await page.waitForSelector("button:has-text('RF taken out')", { timeout: 3000 }).then(() => ok("vault: Take out RF works"), () => bad("vault: Take out RF did nothing"));
    await press(page, vp, page.locator(".box .close-open"));
    await page.waitForSelector(".close", { timeout: 3000 });
    await shot("vault-close");
    await panelChecks(page, vp, "close account");
    const confirm = page.locator(".close .hall-lever").first();
    await press(page, vp, confirm);
    await page.waitForSelector(".vault-closed", { timeout: 3000 }).then(() => ok("vault: closing ends on a receipt"), () => bad("vault: closing did not end on a receipt"));
    await shot("vault-receipt");
    await panelChecks(page, vp, "closed receipt");
    await press(page, vp, page.getByRole("button", { name: "Back to the vault" }));
    await closePanel(page, vp);

    // FLOOR: the simulated week, at each share.
    await viaSign(page, vp, "floor", "The Trading Floor").then(() => ok("tapping the Trading Floor sign from afar walks there and opens it"), async () => {
      bad("tapping the Trading Floor sign from afar did not open it");
      await openStation(page, vp, "floor", "The Trading Floor");
    });
    await page.waitForSelector(".floor-board", { timeout: 20_000 }).catch(() => {});
    await shot("floor");
    await panelChecks(page, vp, "floor");
    await press(page, vp, page.getByRole("radio", { name: "nearly everyone" }));
    expect(await page.getByRole("radio", { name: "nearly everyone" }).getAttribute("aria-checked") === "true", "floor: share buttons respond to a tap");
    await press(page, vp, page.getByRole("button", { name: "Simulate a week" }));
    await page.waitForSelector(".floor-sim .receipt", { timeout: 5000 }).then(() => ok("floor: Simulate a week ends on a sample receipt"), () => bad("floor: simulate did nothing"));
    await page.locator(".floor-sim").scrollIntoViewIfNeeded();
    await shot("floor-sim");
    await panelChecks(page, vp, "floor with a week");
    await press(page, vp, page.getByRole("button", { name: "Roll another week" }));
    ok("floor: Roll another week tapped");
    await closePanel(page, vp);

    // VAULT from the hall, empty now.
    await viaSign(page, vp, "vault", "The Vault").then(() => ok("tapping the Vault sign from afar walks there and opens it"), async () => {
      bad("tapping the Vault sign from afar did not open it");
      await openStation(page, vp, "vault", "The Vault");
    });
    await shot("vault-empty");
    await panelChecks(page, vp, "empty vault");
    await closePanel(page, vp);

    await viaSign(page, vp, "desk", "The Desk").then(() => ok("tapping the Desk sign from afar walks there and opens it"), () => bad("tapping the Desk sign from afar did not open it"));
    await closePanel(page, vp);

    // USE MY FRIEND and HOW IT WORKS.
    await press(page, vp, page.getByRole("button", { name: "Use my Friend" }));
    await page.waitForSelector('.hall-modal[aria-label="Choose a Friend"]', { timeout: 3000 }).then(() => ok("Use my Friend opens the picker"), () => bad("Use my Friend did nothing"));
    await shot("picker");
    await panelChecks(page, vp, "picker");
    // A read-only lookup of the showcase wallet the page itself reads on every load.
    await press(page, vp, page.getByRole("textbox", { name: "Wallet address or ENS name" }));
    await page.keyboard.type("0x913105f2d2bfb8392f7845ef79e0c2c62f2755df");
    await press(page, vp, page.getByRole("button", { name: "Find" }));
    await page.waitForSelector(".picker-friend, .picker-error", { timeout: 60_000 }).then(() => ok("picker: Find answers"), () => bad("picker: Find never answered"));
    expect(await page.locator(".hall-modal").count() === 1, "picker: typing the wallet opened nothing behind it");
    const zoomed = await page.evaluate(() => window.visualViewport ? window.visualViewport.scale : 1);
    expect(zoomed <= 1.01, `picker: typing did not zoom the page (scale ${zoomed})`);
    await shot("picker-friends");
    await panelChecks(page, vp, "picker with friends");
    const pick = page.locator(".picker-friend:not(.is-inert)").first();
    if (await pick.count()) {
      await press(page, vp, pick);
      await page.waitForSelector('.hall-modal[aria-label="Choose a Friend"]', { state: "detached", timeout: 4000 }).then(() => ok("picker: tapping a Friend brings it into the hall"), () => bad("picker: tapping a Friend did nothing"));
    } else {
      await closePanel(page, vp);
    }
    await press(page, vp, page.getByRole("link", { name: "How it works" }));
    await page.waitForURL(/\/docs/, { timeout: 30_000 }).then(() => ok("How it works goes to /docs"), () => bad("How it works did not navigate"));
    await page.waitForLoadState("networkidle").catch(() => {});
    const docsWide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(docsWide <= 1, `docs: no sideways scroll (${docsWide}px over)`);
    await shot("docs");

    // DEEP LINKS.
    for (const [q, title] of [["floor", "The Trading Floor"], ["desk", "The Desk"], ["vault", "The Vault"]]) {
      await page.goto(`${BASE}/?open=${q}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitOpen(page, title).then(() => ok(`?open=${q} opens ${title}`), () => bad(`?open=${q} did not open`));
    }
  } catch (e) {
    bad(`flow crashed: ${e.message.split("\n")[0]}`);
    await shot("crash").catch(() => {});
  }
  const real = errors.filter((e) => !/favicon/i.test(e));
  expect(!real.length, `no console errors${real.length ? ` (${real.slice(0, 3).join(" | ")})` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(`\n${checks} checks, ${failures} failed. Screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);
