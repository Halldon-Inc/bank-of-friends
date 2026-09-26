#!/usr/bin/env node
/**
 * Play the hall, in every room shape, and fail if any of it stops working.
 *
 *   node scripts/hall-play.mjs [baseUrl]
 *
 * The layout sweep proves the hall LOOKS right. This proves it WORKS: that you can
 * walk to the desk, that walking up to it does not throw you back to the door, that
 * the desk opens an account and ENDS on the welcome, that the Trading Floor's
 * headline is the same verdict /api/desk returns (the old lever printed TRADED
 * while /docs printed FLAT), and that the vault shows one box per Friend whose
 * assets withdraw separately.
 *
 * The respawn bug is the reason this exists. It was reported as "i walk up to the
 * desk, it restarts me at the beginning", it passed every visual check, and it was
 * caused by a React dependency array. Nothing but playing it catches that.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("C:/Users/skadd/lotus/package.json");
const { chromium } = req("playwright");
const BASE = process.argv[2] ?? "http://localhost:3188";

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

/** Click the destination's own standing spot, published on .hall-scene. */
async function walkTo(page, which) {
  const at = await page.evaluate((w) => {
    const el = document.querySelector(".hall-scene");
    const v = el?.dataset?.[w];
    if (!v) return null;
    const [px, py] = v.split(",").map(Number);
    const r = el.getBoundingClientRect();
    return { x: r.left + (px / 100) * r.width, y: r.top + (py / 100) * r.height };
  }, which);
  if (!at) throw new Error(`no published spot for ${which}`);
  await page.mouse.click(at.x, at.y);
}

const charBox = (page) => page.evaluate(() => {
  const el = document.querySelector(".hall-char");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

const browser = await chromium.launch({ executablePath: findExe() });

/* Each viewport is chosen to select a different room. */
for (const vp of [
  { w: 1568, h: 717, room: "wide", touch: false },
  { w: 1440, h: 900, room: "mid", touch: false },
  { w: 390, h: 844, room: "tall", touch: true },
]) {
  const label = `${vp.room} @ ${vp.w}x${vp.h}`;
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch, isMobile: vp.touch,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".hall-char", { timeout: 30_000 });
    await page.waitForTimeout(900);

    const start = await charBox(page);
    if (!start) { bad(`${label}: no character`); throw new Error("no character"); }

    // Walk to the published standing spot. Earlier versions aimed at the SDK prop
    // or a fixed offset below the sign; both broke as soon as the furniture moved,
    // and the sign now sits over the counter rather than over the spot you stand on.
    await walkTo(page, "desk");

    // Wait for THE DESK's own sign. Waiting for any lit sign returned instantly
    // whenever you were already standing at one.
    await page.waitForSelector('.hall-prompt.is-near:has-text("The Desk")', { timeout: 15_000 });
    ok(`${label}: walked to the desk and it armed`);

    const arrived = await charBox(page);
    const moved = Math.hypot(arrived.x - start.x, arrived.y - start.y);
    if (moved < 20) bad(`${label}: character never moved (${moved.toFixed(0)}px)`);
    else ok(`${label}: character travelled ${moved.toFixed(0)}px`);

    // THE RESPAWN BUG: arriving must not send you back to where you started.
    const backAtStart = Math.hypot(arrived.x - start.x, arrived.y - start.y) < 12;
    if (backAtStart) bad(`${label}: respawned at the door on arrival`);
    else ok(`${label}: did not respawn on arrival`);

    await page.click('.hall-prompt.is-near:has-text("The Desk")');
    await page.waitForSelector(".hall-panel", { timeout: 10_000 });
    ok(`${label}: the desk opened`);

    // OPENING AN ACCOUNT MUST NOT DEPEND ON THE MARKET, and the desk must not ask
    // the market question at all any more: that is the Trading Floor's job.
    const deskHasLever = await page.locator(".hall-panel .hall-verdict, .hall-panel .floor-board").count();
    const deskText = (await page.textContent(".hall-panel")) ?? "";
    if (deskHasLever || /pull the lever/i.test(deskText)) bad(`${label}: the desk still asks the market question`);
    else ok(`${label}: the desk only opens accounts`);
    const caps = await page.locator(".acct-cap input").count();
    if (caps !== 2) bad(`${label}: expected an RF cap and a WETH cap, found ${caps}`);
    else ok(`${label}: RF and WETH are capped separately`);

    // Every "the bank cannot" line must carry the tests that check it, and the
    // page must say, once and briefly, that the contract is unaudited and not deployed.
    const cannot = await page.locator(".acct-list.is-cannot li").count();
    const tested = await page.locator(".acct-list.is-cannot li .acct-tests").count();
    const says = /unaudited, not deployed/i.test((await page.textContent(".hall-panel")) ?? "");
    if (!cannot || tested !== cannot || !says) bad(`${label}: ${tested}/${cannot} guarantees name a test, unaudited note ${says}`);
    else ok(`${label}: all ${cannot} guarantees name their tests, beside "Unaudited, not deployed."`);

    // DUMMY PROOF: one primary button that says what happens, the calls tucked in
    // a collapsed "what this signs", and the plain line about your own wallet.
    const primary = (await page.locator(".acct > .hall-lever").allTextContents()).map((t) => t.trim());
    const signs = await page.locator('.acct details.acct-signs:not([open]) .acct-steps li').count();
    const signupText = ((await page.textContent(".acct")) ?? "").replace(/\s+/g, " ");
    if (primary.join("|") !== "Open my account") bad(`${label}: desk primary buttons are "${primary.join("|")}"`);
    else if (signs !== 3) bad(`${label}: "what this signs" is not a collapsed list of 3 calls (${signs})`);
    else if (!/Your own wallet approves nothing/.test(signupText)) bad(`${label}: signup does not say your own wallet approves nothing`);
    else ok(`${label}: one primary "Open my account", 3 calls collapsed under "what this signs", own-wallet line shown`);

    await page.click(".acct .hall-lever");
    await page.waitForSelector(".acct-welcome h3", { timeout: 15_000 });
    const welcome = (await page.textContent(".acct-welcome h3"))?.trim();
    if (!/welcome to the first bank of friends/i.test(welcome ?? "")) bad(`${label}: no welcome, got "${welcome}"`);
    else ok(`${label}: account opened -> "${welcome}"`);
    // Today AND on its way: the day-one cap must not make the box look small for no
    // reason. The showcase Genesis holds more than one day's cap, so both must show.
    const arrival = ((await page.textContent(".acct-welcome .arrival")) ?? "").replace(/\s+/g, " ");
    const days = arrival.match(/arriving over (\d+) days?/);
    if (!/in your box today/.test(arrival) || !days) bad(`${label}: welcome lacks today / on its way: "${arrival.slice(0, 90)}"`);
    else ok(`${label}: welcome shows today and on its way (${days[1]} days at the caps)`);

    const afterWelcome = await page.locator(".hall-panel .hall-lever").allTextContents();
    if (afterWelcome.some((t) => /lever|simulate/i.test(t))) bad(`${label}: the welcome is followed by a market action`);
    else ok(`${label}: the desk journey ends on the welcome`);

    // THE TRADING FLOOR: its headline must be the live verdict, not a roll.
    await page.click(".hall-panel header button");
    await walkTo(page, "floor");
    await page.waitForSelector('.hall-prompt.is-near:has-text("The Trading Floor")', { timeout: 20_000 });
    ok(`${label}: walked to the trading floor`);
    await page.click('.hall-prompt.is-near:has-text("The Trading Floor")');
    // The floor reads the chain; a cold read can take the better part of a minute.
    await page.waitForSelector(".floor-board .floor-word", { timeout: 120_000 });
    const liveWord = (await page.textContent(".floor-board .floor-word"))?.trim();
    const api = await page.evaluate(async () => { const j = await (await fetch("/api/desk")).json(); return { armed: j.armed, mode: j.standing?.mode ?? null, ask: !!j.standing?.ask }; });
    // The word is the grid when armed, else the standing sell order, else off: the same rule as FloorPanel.floorWord.
    const expectWord = api.armed ? "DESK ON" : api.mode === "edge" || api.mode === "takeProfit" ? "STANDING ORDER" : "DESK OFF";
    if (liveWord !== expectWord) bad(`${label}: floor says "${liveWord}" but /api/desk armed=${api.armed} standing=${api.mode}`);
    else ok(`${label}: floor headline "${liveWord}" matches /api/desk (armed=${api.armed}, standing=${api.mode})`);
    if (expectWord === "STANDING ORDER") {
      // A standing order on the board must show its price and its edge, read from the same API.
      const order = ((await page.textContent(".floor .floor-order").catch(() => "")) ?? "").replace(/\s+/g, " ");
      if (!api.ask || !/above the market/.test(order) || !/per RF/.test(order)) bad(`${label}: standing order shown without its price and edge: "${order.slice(0, 80)}"`);
      else ok(`${label}: the standing order shows its price above the market and its edge per RF`);
    }

    await page.click(".floor .hall-lever");
    await page.waitForSelector(".floor-sim-word", { timeout: 10_000 });
    const simWord = (await page.textContent(".floor-sim-word"))?.trim();
    const stamp = await page.locator(".floor .sim-stamp").count();
    if (!/^would (quote|stay off)$/.test(simWord ?? "") || !stamp) bad(`${label}: simulated week reads "${simWord}", stamp ${stamp}`);
    else ok(`${label}: simulated week says "${simWord}" and is stamped`);
    const wordAfter = (await page.textContent(".floor-board .floor-word"))?.trim();
    if (wordAfter !== liveWord) bad(`${label}: simulating a week changed the live headline to "${wordAfter}"`);
    else ok(`${label}: the live headline ignores the simulation`);

    const back = await page.locator('.floor .hall-lever:has-text("Back to the hall")').count();
    if (back !== 1) bad(`${label}: the floor has no way back to the hall`);
    else ok(`${label}: the floor ends on "Back to the hall"`);
    await page.click(".hall-why");
    const gates = await page.locator(".floor .hall-gates li").count();
    if (gates < 3) bad(`${label}: only ${gates} conditions shown`);
    else ok(`${label}: ${gates} live conditions listed`);

    // Now the vault: one box, and its assets leave separately.
    await page.click(".hall-panel header button");
    await walkTo(page, "vault");
    await page.waitForSelector('.hall-prompt.is-near:has-text("The Vault")', { timeout: 20_000 });
    ok(`${label}: walked on to the vault`);
    await page.click('.hall-prompt.is-near:has-text("The Vault")');
    await page.waitForSelector(".vault-big", { timeout: 10_000 });
    const book = (await page.textContent(".vault-big"))?.trim() ?? "";
    if (!/^\$[\d,]+\.\d\d$/.test(book)) bad(`${label}: book reads "${book}"`);
    else ok(`${label}: vault book ${book}`);
    // THE VAULT HOLDS must match the API, and must NEVER show a pool total before
    // the contract is deployed. Compare against the same compact format the page uses.
    const compact = (v) => v >= 1e9 ? `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
      : v >= 1e5 ? `${Math.round(v / 1e3)}K` : Math.round(v).toLocaleString("en-US");
    const apiNow = await page.evaluate(async () => (await (await fetch("/api/desk")).json()));
    const headline = ((await page.textContent(".vault-holds")) ?? "").replace(/\s+/g, " ");
    const totals = await page.locator(".vault-holds-total").count();
    // Unclaimed rewards sit in the ActivationManager, not in Friend wallets. The
    // hall must never say otherwise, on the plaque, the marquee or the vault.
    const everywhere = ((await page.textContent(".hall")) ?? "").replace(/\s+/g, " ");
    if (/in friend wallets|claimable by active/i.test(everywhere)) bad(`${label}: the hall says rewards are "in Friend wallets"`);
    else ok(`${label}: nothing claims unclaimed rewards sit in Friend wallets`);
    if (!apiNow.bank?.deployed) {
      if (totals) bad(`${label}: vault shows a pool total while the contract is not deployed`);
      else ok(`${label}: no pool total before launch ("${headline.slice(0, 40)}...")`);
      const idle = apiNow.protocolIdle;
      if (typeof idle?.rf === "number" && typeof idle?.weth === "number") {
        if (!headline.includes(`${compact(idle.rf)} RF`)) bad(`${label}: headline "${headline}" does not show the API's ${compact(idle.rf)} RF earned, unclaimed`);
        else ok(`${label}: headline shows ${compact(idle.rf)} RF earned and not yet claimed, as the API says`);
      } else bad(`${label}: /api/desk has no protocolIdle figures to show`);
    } else {
      const rf = (apiNow.bank.rfIdle ?? 0) + (apiNow.bank.rfInAsk ?? 0);
      if (!totals || !headline.includes(`${compact(rf)} RF`)) bad(`${label}: vault total does not match on-chain ${compact(rf)} RF`);
      else ok(`${label}: vault total matches on-chain ${compact(rf)} RF`);
    }

    const doors = await page.locator(".door-wall .door").count();
    const boxes = await page.locator(".door-wall .door.is-box").count();
    const vacant = await page.locator(".door-wall .door.is-vacant").count();
    if (doors < 24 || boxes !== 1 || vacant !== doors - 1) bad(`${label}: wall has ${doors} doors, ${boxes} boxes, ${vacant} vacant`);
    else ok(`${label}: a full wall of ${doors} doors, 1 box, the rest honestly vacant`);
    const openDoor = await page.locator(".door-wall .door.is-open img").count();
    if (openDoor !== 1) bad(`${label}: the Friend's door is not open with its portrait`);
    else ok(`${label}: the Friend's door stands open with its portrait`);
    // The pooled book is TWO bars, one per asset, each made of the boxes' segments.
    const bars = await page.locator(".pool .pool-bar").count();
    const segs = await page.locator(".pool .pool-bar .pool-seg:not(.is-pending):not(.is-owed)").count();
    if (bars !== 2 || segs !== 2 * boxes) bad(`${label}: pooled book has ${bars} bars and ${segs} box segments for ${boxes} boxes`);
    else ok(`${label}: pooled book is an RF bar and a WETH bar, each built from the boxes`);

    const nums = async () => page.locator(".box .box-asset-num").allTextContents();
    const before = await nums();
    await page.click('.box-actions button:has-text("Take out RF")');
    const after = await nums();
    if (after[0]?.trim() !== "0" || after[1] !== before[1]) bad(`${label}: withdraw RF left ${after.join(" / ")} (was ${before.join(" / ")})`);
    else ok(`${label}: RF withdrew alone, WETH untouched (${after[1]})`);

    // CLOSE ACCOUNT AND TAKE EVERYTHING HOME, from the box: what comes home per
    // asset must equal the box, and "what this signs" must list exactly the three
    // calls in order: close, revoke RF, revoke WETH.
    const home = await page.locator(".box .box-asset-num").allTextContents();
    await page.click(".box .close-open");
    await page.waitForSelector(".close", { timeout: 10_000 });
    const got = await page.locator(".close-home tbody tr .close-total").allTextContents();
    if (got.length !== 2 || got[0].trim() !== home[0].trim() || got[1].trim() !== home[1].trim()) bad(`${label}: close brings home ${got.join(" / ")}, box holds ${home.join(" / ")}`);
    else ok(`${label}: close brings home exactly the box (${got.join(" RF / ")} WETH)`);
    await page.click(".close .acct-signs summary");
    const calls = (await page.locator(".close .acct-signs .acct-steps li").allTextContents()).map((t) => t.trim());
    const want = ["bank.close([collection], [id], you)", "TBA.execute(RF.approve(bank, 0))", "TBA.execute(WETH.approve(bank, 0))"];
    if (calls.join(" | ") !== want.join(" | ")) bad(`${label}: close signs "${calls.join(" | ")}"`);
    else ok(`${label}: close signs exactly close, revoke RF, revoke WETH`);
    const closeText = ((await page.textContent(".close")) ?? "").replace(/\s+/g, " ");
    if (/before you sell|warning|check a friend/i.test(closeText)) bad(`${label}: the close screen carries a warning`);
    else if (!/Closing also removes the bank.s access to your Friend.s wallet, in the same step/.test(closeText)) bad(`${label}: the close screen does not say it removes access in the same step: "${closeText.slice(0, 200)}"`);
    else ok(`${label}: close says it removes access in the same step, and carries no warning`);
    await page.click(".close-go");
    await page.waitForSelector('.vault .hall-lever:has-text("Open my account at the desk")', { timeout: 10_000 });
    ok(`${label}: account closed; the vault's next step is "Open my account at the desk"`);

    if (errors.length) bad(`${label}: console: ${errors[0].slice(0, 70)}`);
    else ok(`${label}: no console errors`);
  } catch (e) {
    bad(`${label}: ${String(e.message ?? e).split("\n")[0].slice(0, 80)}`);
  }
  await ctx.close();
}

/* Rotating a phone swaps the room. It must not leave a broken scene behind. */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".hall-char", { timeout: 30_000 });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(1200);
    const fitted = await page.evaluate(() => {
      const s = document.querySelector(".hall-scene")?.getBoundingClientRect();
      const svg = document.querySelector(".hall-scene svg");
      const vb = svg?.viewBox?.baseVal;
      if (!s || !vb?.width) return null;
      return { drift: Math.abs(s.width / s.height - vb.width / vb.height) / (vb.width / vb.height), fits: s.width <= innerWidth + 1 && s.height <= innerHeight + 1 };
    });
    if (!fitted) bad("rotate: no scene after rotating");
    else if (fitted.drift > 0.04) bad(`rotate: frame no longer matches its viewBox (${(fitted.drift * 100).toFixed(0)}% off)`);
    else if (!fitted.fits) bad("rotate: scene overflows the viewport");
    else ok("rotate: re-fitted to the new room");
    if (errors.length) bad(`rotate: ${errors[0].slice(0, 70)}`);
    else ok("rotate: no errors");
  } catch (e) {
    bad(`rotate: ${String(e.message ?? e).split("\n")[0].slice(0, 80)}`);
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error("FATAL: graded nothing"); process.exit(2); }
process.exit(failures > 0 ? 1 : 0);
