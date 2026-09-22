/**
 * ACCOUNTS: who has actually opened one, and what they signed.
 *
 * Joining the bank and the bank deciding to trade are TWO DIFFERENT THINGS, and
 * collapsing them was the worst bug in this build. The desk's only action used to
 * be the lever, so a Genesis holder walked up, got "SAT OUT" because the market is
 * quiet, and reasonably read it as the bank refusing to let him in. Nothing about
 * opening an account depends on whether anyone is trading.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 *
 * The mandate below is not invented for the demo. It is what `FriendBank.join`
 * actually does: it records consent and a per-day cap, takes no custody, and
 * cannot move anything until the owner separately approves the Bank FROM the
 * Friend's own ERC-6551 wallet. The three guarantees are each enforced by a test
 * in `contracts/test`.
 *
 * The signature is a real EIP-712 signature when a browser wallet is present. It
 * grants nothing: there is no allowance, no transaction, no gas, and the contract
 * is not deployed. It is a signed statement of intent, and the UI says so. With no
 * wallet you can still open an account, and it is labelled as unsigned rather than
 * dressed up as a signature.
 */

export const STORAGE_KEY = "fbof.accounts.v1";

/** Robinhood Chain. */
export const CHAIN_ID = 4663;

export type Account = {
  id: string;
  label: string;
  collection: string;
  tokenId: string;
  imageUrl: string | null;
  idleRf: number;
  idleWeth: number;
  /** The most the Bank may ever pull from this Friend per day. */
  capPerDayRf: number;
  /** Present only when a wallet actually signed. */
  signature: string | null;
  signer: string | null;
  signedAt: string;
};

export const accountId = (collection: string, tokenId: string) => `${collection}-${tokenId}`;

/** What the member grants. Each line is something `join` + the approval really do. */
export const GRANTS = [
  "Harvest this Friend's rewards from the protocol into its own wallet. Anyone may already do this; it is permissionless and the money lands in your wallet, not the bank's.",
  "Pull up to the daily cap you set below, and no more, to put behind quotes.",
  "Return your share whenever you ask for it.",
] as const;

/** What it cannot do. One Foundry test each, in contracts/test. */
export const GUARANTEES = [
  "The bank never holds your NFT. It stays in your wallet the whole time.",
  "Every collection is bounded by the smallest of your cap, the room left in today's epoch, your allowance and your balance, even if you approve an unlimited amount.",
  "Withdrawal has no timelock, no queue, no pause and no owner check. It works even while the desk is halted.",
] as const;

export const MANDATE_STATEMENT =
  "I authorise The First Bank of Friends to harvest this Friend's rewards and to use up to the daily cap stated here for market making on my behalf. The bank takes no custody of the NFT and I may withdraw at any time.";

const TYPES = {
  Mandate: [
    { name: "friend", type: "string" },
    { name: "capPerDayRf", type: "string" },
    { name: "statement", type: "string" },
    { name: "signedAt", type: "string" },
  ],
} as const;

type Injected = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const injected = (): Injected | null => {
  const e = (globalThis as { ethereum?: Injected }).ethereum;
  return e && typeof e.request === "function" ? e : null;
};

export const hasWallet = () => injected() !== null;

/**
 * Sign the mandate with a browser wallet if there is one.
 * Returns nulls rather than throwing when there is no wallet, so opening an
 * account never depends on having one. Throws only if a wallet is present and
 * the person actively rejects, which the caller should surface as a rejection
 * rather than as a failure.
 */
export async function signMandate(
  friend: string,
  capPerDayRf: number,
  signedAt: string,
): Promise<{ signature: string | null; signer: string | null }> {
  const eth = injected();
  if (!eth) return { signature: null, signer: null };

  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const signer = accounts?.[0];
  if (!signer) return { signature: null, signer: null };

  const payload = JSON.stringify({
    domain: { name: "The First Bank of Friends", version: "1", chainId: CHAIN_ID },
    primaryType: "Mandate",
    types: { EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ], ...TYPES },
    message: {
      friend,
      capPerDayRf: capPerDayRf.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      statement: MANDATE_STATEMENT,
      signedAt,
    },
  });

  const signature = (await eth.request({
    method: "eth_signTypedData_v4",
    params: [signer, payload],
  })) as string;

  return { signature, signer };
}

/* -------------------------------------------------------------------- store */

export function loadAccounts(): Account[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as Account[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === "string") : [];
  } catch {
    return [];
  }
}

function save(list: Account[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

export function addAccount(a: Account): Account[] {
  const next = [...loadAccounts().filter((x) => x.id !== a.id), a];
  save(next);
  return next;
}

export function removeAccount(id: string): Account[] {
  const next = loadAccounts().filter((x) => x.id !== id);
  save(next);
  return next;
}

/**
 * The minimum book that can quote BOTH sides, derived in scripts/derive-parameters.
 * A grid needs RF to sell and WETH to buy and both sides must clear the economic
 * minimum fill, which is why one Friend alone can buy and can never sell.
 */
export const MIN_VIABLE_BOOK_USD = 116;

export function totals(list: Account[], rfUsd: number, ethUsd: number) {
  const rf = list.reduce((a, x) => a + x.idleRf, 0);
  const weth = list.reduce((a, x) => a + x.idleWeth, 0);
  const rfSideUsd = rf * rfUsd;
  const wethSideUsd = weth * ethUsd;
  const usd = rfSideUsd + wethSideUsd;
  return {
    depositors: list.length,
    rf, weth, usd, rfSideUsd, wethSideUsd,
    /** A book is only viable if the SMALLER side can still clear a fill. */
    balancedUsd: Math.min(rfSideUsd, wethSideUsd) * 2,
    progress: Math.min(1, usd / MIN_VIABLE_BOOK_USD),
    viable: Math.min(rfSideUsd, wethSideUsd) * 2 >= MIN_VIABLE_BOOK_USD,
  };
}
