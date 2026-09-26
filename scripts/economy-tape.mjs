/**
 * OHLC bars -> taker-intent tape for the endogenous pool model (data/tokens/*.json).
 *
 * Each bar is walked open -> nearer extreme -> farther extreme -> close, and every leg
 * becomes the one trade that moves a full-range pool of liquidity Lm to that price (the
 * same construction as syntheticTape in backtest-engine.mjs). The implied volume is the
 * MINIMUM flow that draws the bar; real volume is higher, and swings inside an hour are
 * invisible. Prices are in QUOTE per token; "weth" in the tape means the quote token.
 */
import fs from "node:fs";
import { makePool } from "./backtest-engine.mjs";

/** Full-range liquidity implied by a USD TVL at the current price: quote reserve y = TVL/2, L = y / sqrt(p). */
export const lFromTvl = (tvlUsd, pQuote, quoteUsd) => (tvlUsd / 2 / quoteUsd) / Math.sqrt(pQuote);
/** One-way quote flow that moves a full-range pool by +m at price p. */
export const flowToMove = (L, p, m) => L * Math.sqrt(p) * (Math.sqrt(1 + m) - 1);

export function buildTape(bars, dt, Lm) {
  const pool = makePool(bars[0][1], Lm);
  const tape = [];
  let impliedQuote = 0;
  const go = (t, target) => {
    if (!(target > 0)) return;
    const before = pool.price(), sT = Math.sqrt(target), L = pool.Lm;
    if (Math.abs(sT / pool.s - 1) < 1e-12) return;
    if (sT > pool.s) { const dy = L * (sT - pool.s); pool.wethIn(dy); impliedQuote += dy; tape.push({ t, buy: true, weth: dy, rf: 0, px: pool.price(), pxBefore: before }); }
    else { const dx = L * (1 / sT - 1 / pool.s); const out = pool.rfIn(dx); impliedQuote += out; tape.push({ t, buy: false, weth: 0, rf: dx, px: pool.price(), pxBefore: before }); }
  };
  for (const [t, o, h, l, c] of bars) {
    go(t, o);
    const hiFirst = Math.abs(h - o) < Math.abs(o - l);
    go(t + dt * 0.25, hiFirst ? h : l);
    go(t + dt * 0.5, hiFirst ? l : h);
    go(t + dt * 0.9, c);
  }
  return { tape, impliedQuote };
}

/** Every token in data/tokens, as { meta, tape, Lm, quoteUsd, daysOfBars, volUsdPerDay, flow5Usd }. */
export function loadTokens(dir = "data/tokens", { skipHours = 24 } = {}) {
  const man = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
  return man.tokens.map((t) => {
    const d = JSON.parse(fs.readFileSync(`${dir}/${t.label}.json`, "utf8"));
    const bars = d.ohlcv_quote.filter((b) => b[1] > 0 && b[4] > 0 && b[2] > 0 && b[3] > 0).slice(skipHours);
    const quoteUsd = d.quote_price_usd;
    const Lm = lFromTvl(d.reserve_in_usd, d.base_price_quote, quoteUsd);
    const { tape } = buildTape(bars, 3600, Lm);
    const days = (bars.at(-1)[0] - bars[0][0]) / 86400;
    const volUsdPerDay = (d.vol_usd ?? []).reduce((a, v) => a + v, 0) / Math.max((d.ohlcv_quote.at(-1)[0] - d.ohlcv_quote[0][0]) / 86400, 1);
    return {
      meta: { ...t, name: d.name, tvlUsd: d.reserve_in_usd },
      tape, Lm, quoteUsd, days, volUsdPerDay,
      flow5Usd: flowToMove(Lm, d.base_price_quote, 0.05) * quoteUsd,
    };
  });
}
