/**
 * Drive the actual game loop with the SDK's mock wallet: walk to the desk, open it,
 * deposit, pull the lever, and screenshot what a player really sees.
 */
import { testGame } from "@rarefriends/friendsdk/testing";

await testGame("./games/first-bank", {
  width: 960,
  screenshot: "../audit/shots/bank-desk-open.png",
  check: async ({ game, page }) => {
    // Open the one station. The prompt is the only interactive world control.
    const prompt = game.getByRole("button", { name: /The Desk/i });
    await prompt.waitFor({ state: "visible", timeout: 20000 });
    await prompt.click();
    await page.waitForTimeout(700);

    const deposit = game.getByRole("button", { name: /Deposit 1 RF/i });
    if (await deposit.count()) { await deposit.click(); await page.waitForTimeout(900); }

    const lever = game.getByRole("button", { name: /Pull the lever|Pull again/i });
    await lever.waitFor({ state: "visible", timeout: 15000 });
    await lever.click();
    await page.waitForTimeout(2600);   // let the roll settle

    const text = await game.locator(".bank-verdict").innerText().catch(() => "(no verdict rendered)");
    console.log("\n--- what the player sees after one pull ---");
    console.log(text);
    const lede = await game.locator(".bank-lede").innerText().catch(() => "");
    console.log("\n--- lede ---\n" + lede);
  },
});
