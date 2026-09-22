import HallShell from "@/components/HallShell";

/**
 * The front door IS the hall.
 *
 * It used to be a dashboard, and before that a wallet-lookup form, both of which
 * made you read or type before anything happened. You now land already inside,
 * with a Friend on the marble, and swap to your own from the HUD. The research that
 * used to live here is at /docs, which is the right way round: fun in front,
 * evidence behind it.
 */

export const revalidate = 300;

const SHOWCASE = "0x913105f2d2bfb8392f7845ef79e0c2c62f2755df";

/** The showcase Friend AND the prices, from one read. */
async function showcase() {
  try {
    const r = await fetch(`https://rarefriends.com/api/protocol/state?address=${SHOWCASE}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const prices = {
      rfUsd: Number(j?.protocol?.prices?.rfUsd ?? 0),
      ethUsd: Number(j?.protocol?.prices?.ethUsd ?? 0),
    };
    // The Genesis: the Friend FriendSDK will not admit, and the one holding
    // essentially all of the idle rewards. Exactly the right host for the hall.
    const f = (j.account?.friends ?? []).find((x: any) => x.collection === "Genesis" && x.activated)
      ?? (j.account?.friends ?? []).find((x: any) => x.activated);
    if (!f) return null;
    return { prices, friend: {
      id: String(f.id),
      label: f.collection === "Genesis" ? `Genesis #${f.id}` : `Gen-${f.generation} #${f.id}`,
      collection: String(f.collection),
      generation: Number(f.generation ?? 0),
      imageUrl: typeof f.imageUrl === "string" && f.imageUrl.startsWith("data:image/") ? f.imageUrl : null,
      idleRf: Number(f.earnings ?? 0),
      idleWeth: Number(f.earningsWeth ?? 0),
    } };
  } catch {
    return null;
  }
}

/** Measured 2026-09-22; only used if the price read fails. */
const FALLBACK_PRICES = { rfUsd: 0.00156, ethUsd: 2734.86 };

export default async function Page() {
  const s = await showcase();
  const prices = s?.prices?.ethUsd ? s.prices : FALLBACK_PRICES;
  return <HallShell showcase={s?.friend ?? null} rfUsd={prices.rfUsd} ethUsd={prices.ethUsd} />;
}
