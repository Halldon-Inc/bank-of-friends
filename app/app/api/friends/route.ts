import { NextResponse } from "next/server";

/**
 * Every Friend in a wallet, WITH its on-chain artwork, and what each one is allowed
 * to do here.
 *
 * Ported from the picker already running on rare-friends-cards' meme machine: the
 * art is on chain and rarefriends.com already serves it as a data: URI on
 * `imageUrl`, so there is nothing to host and nothing to generate.
 *
 * The important column is `bankEligible` vs `gameEligible`:
 *
 *   gameEligible  FriendSDK games require a GENERATIONS NFT of generation >= 1.
 *                 readGenerationEligibility reads ownerOf and generation from the
 *                 Generations contract, so a Genesis is excluded twice over: wrong
 *                 contract, and it reports generation 0.
 *
 *   bankEligible  The Bank is a tool, not a game. FriendBank.join() calls only
 *                 ownerOf() and tokenBoundAccount(), which Genesis has, and
 *                 contracts/test proves a Genesis enrols and is collected from
 *                 exactly like a Generations Friend.
 *
 * That distinction matters because the money is in the Genesis: one holds ~3,287 RF
 * of idle rewards against ~3.7 RF in a Gen-3.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** A farm wallet can hold hundreds of Gen-6s; keep the payload sane. */
const MAX = 80;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Only ever hand back a data: image we produced from their API. Never a remote URL. */
function safeImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/")) return null;
  if (value.length > 400_000) return null;
  return value;
}

export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get("address") ?? "").trim();
  if (!raw) return json({ error: "Pass ?address= a wallet or ENS name." }, 400);

  let address = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    if (!/\.eth$/i.test(raw)) return json({ error: "That is not a 0x address or a .eth name." }, 404);
    try {
      const { createPublicClient, http, fallback } = await import("viem");
      const { mainnet } = await import("viem/chains");
      const client = createPublicClient({
        chain: mainnet,
        // cloudflare-eth reverts on ENS; these three are the set the cards site settled on.
        transport: fallback([http("https://eth.merkle.io"), http("https://ethereum-rpc.publicnode.com"), http("https://eth.llamarpc.com")]),
      });
      const resolved = await client.getEnsAddress({ name: raw });
      if (!resolved) return json({ error: `${raw} does not resolve to an address.` }, 404);
      address = resolved.toLowerCase();
    } catch {
      return json({ error: "ENS lookup is down. Paste the 0x address instead." }, 503);
    }
  }

  let state: any;
  try {
    // NEVER send an Origin header and NEVER add a query key other than `address`:
    // their route 403s on a mismatched Origin and throws on any extra key.
    const r = await fetch(`https://rarefriends.com/api/protocol/state?address=${address}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return json({ error: `rarefriends.com answered ${r.status}. Try again shortly.` }, 502);
    state = await r.json();
  } catch {
    return json({ error: "rarefriends.com did not answer. Try again in a minute." }, 502);
  }

  const all = Array.isArray(state?.account?.friends) ? state.account.friends : [];
  // Earning Friends first: those are the ones worth enrolling.
  const sorted = [...all].sort(
    (a, b) => Number(!!b.activated && !!b.hardwired) - Number(!!a.activated && !!a.hardwired),
  );

  const friends = sorted.slice(0, MAX).map((f: any) => {
    const generation = Number(f.generation ?? 0);
    const collection = String(f.collection ?? "");
    const activated = !!f.activated && !!f.hardwired;
    return {
      id: String(f.id),
      collection,
      generation,
      tier: Number(f.tier ?? 0),
      activated,
      label: collection === "Genesis" ? `Genesis #${f.id}` : `Gen-${generation} #${f.id}`,
      imageUrl: safeImage(f.imageUrl),
      wallet: typeof f.wallet?.address === "string" ? f.wallet.address : null,
      idleRf: Number(f.earnings ?? 0),
      idleWeth: Number(f.earningsWeth ?? 0),
      gameEligible: collection === "Generations" && generation >= 1,
      bankEligible: activated,
      excludedReason:
        collection === "Genesis"
          ? "FriendSDK games only accept Generations NFTs of generation 1 or higher, so a Genesis cannot be the walking character. It can still bank."
          : generation < 1
            ? "Not hardwired yet, so it earns nothing and cannot play."
            : null,
    };
  });

  const rfUsd = Number(state?.protocol?.prices?.rfUsd ?? 0);
  const ethUsd = Number(state?.protocol?.prices?.ethUsd ?? 0);
  const idleUsd = friends.reduce((a, f) => a + f.idleRf * rfUsd + f.idleWeth * ethUsd, 0);

  return json({
    address,
    total: all.length,
    shown: friends.length,
    idleUsd,
    bankEligible: friends.filter((f) => f.bankEligible).length,
    gameEligible: friends.filter((f) => f.gameEligible).length,
    friends,
  });
}
