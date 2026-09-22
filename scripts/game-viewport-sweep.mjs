/**
 * Viewport sweep for the bank.
 *
 * `friendsdk test` proves the game BOOTS. It does not prove the game is legible at
 * 320px or that the desk menu fits on a phone. This drives the real runtime with the
 * mock wallet at every width that matters, opens the one station, pulls the lever,
 * and fails on:
 *
 *   - horizontal overflow in the game frame
 *   - any text node clipped by its own box
 *   - the verdict word or its reason not fitting
 *   - console errors
 *
 * Shots land in audit/shots/vp-<width>.png.
 */
import { testGame } from "@rarefriends/friendsdk/testing";

const VIEWPORTS = [
  { w: 320, h: 640, name: "iphone-se" },
  { w: 360, h: 740, name: "android" },
  { w: 390, h: 844, name: "iphone-12" },
  { w: 430, h: 932, name: "phone-lg" },
  { w: 768, h: 1024, name: "tablet" },
  { w: 1024, h: 768, name: "tablet-ls" },
  { w: 1280, h: 800, name: "laptop" },
  { w: 1680, h: 1050, name: "desktop" },
  { w: 2560, h: 1440, name: "wide" },
];

let checks = 0, failures = 0;
const fail = (vp, msg) => { failures++; console.log(`  FAIL [${vp}] ${msg}`); };
const ok = (vp, msg) => { checks++; console.log(`  ok   [${vp}] ${msg}`); };

for (const vp of VIEWPORTS) {
  const label = `${vp.w} ${vp.name}`;
  const errors = [];
  try {
    await testGame("./games/first-bank", {
      width: vp.w,
      height: vp.h,
      screenshot: `../audit/shots/vp-${vp.w}.png`,
      check: async ({ game, page }) => {
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.waitForTimeout(900);

        // 1. the world frame must not scroll sideways
        const overflow = await game.locator("body").evaluate((b) =>
          b.scrollWidth - b.clientWidth).catch(() => 0);
        checks++;
        if (overflow > 1) fail(label, `frame overflows by ${overflow}px`);
        else ok(label, "no horizontal overflow");

        // 2. open the one station and pull the lever
        const prompt = game.getByRole("button", { name: /The Desk/i });
        await prompt.waitFor({ state: "visible", timeout: 20000 });
        await prompt.click();
        await page.waitForTimeout(500);
        const lever = game.getByRole("button", { name: /Pull the lever|Pull again/i });
        await lever.waitFor({ state: "visible", timeout: 15000 });
        await lever.click();
        await page.waitForTimeout(2400);

        // 3. the verdict must be readable, not clipped
        const verdict = await game.locator(".bank-verdict").evaluate((el) => {
          const word = el.querySelector(".bank-word");
          const why = el.querySelector(".bank-because");
          const r = el.getBoundingClientRect();
          return {
            text: word?.textContent?.trim() ?? "",
            reason: why?.textContent?.trim() ?? "",
            wordClipped: word ? word.scrollWidth > word.clientWidth + 2 : false,
            whyClipped: why ? why.scrollHeight > why.clientHeight + 2 : false,
            inView: r.left >= -1 && r.right <= innerWidth + 1,
          };
        }).catch(() => null);

        checks++;
        if (!verdict) fail(label, "no verdict rendered after pulling the lever");
        else if (verdict.wordClipped) fail(label, `verdict word "${verdict.text}" is clipped`);
        else if (verdict.whyClipped) fail(label, `reason is clipped: "${verdict.reason.slice(0, 40)}"`);
        else if (!verdict.inView) fail(label, "verdict sits outside the frame");
        else ok(label, `verdict "${verdict.text}" readable, reason fits`);

        // 4. nothing else clipped anywhere in the open menu
        const clipped = await game.locator("body").evaluate((b) => {
          const out = [];
          for (const el of b.querySelectorAll("*")) {
            if (el.children.length) continue;
            const t = (el.textContent ?? "").trim();
            if (!t) continue;
            const cs = getComputedStyle(el);
            if (cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.display === "none") continue;
            if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.className || el.tagName}: "${t.slice(0, 30)}"`);
          }
          return out;
        });
        checks++;
        if (clipped.length) fail(label, `${clipped.length} clipped: ${clipped[0]}`);
        else ok(label, "no clipped text in the open desk");

        checks++;
        if (errors.length) fail(label, `console error: ${errors[0].slice(0, 80)}`);
        else ok(label, "no console errors");
      },
    });
  } catch (e) {
    failures++;
    console.log(`  FAIL [${label}] harness: ${String(e.message ?? e).split("\n")[0].slice(0, 110)}`);
  }
}

console.log(`\n${checks} checks, ${failures} failed across ${VIEWPORTS.length} viewports`);
if (checks === 0) { console.error("FATAL: graded nothing"); process.exit(2); }
process.exit(failures > 0 ? 1 : 0);
