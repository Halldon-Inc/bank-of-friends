# The First Bank of Friends

**[Play it](https://bank-of-friends-nu.vercel.app)** &middot; **[The research](https://bank-of-friends-nu.vercel.app/docs)** &middot; [Vibeathon submission](SUBMISSION.md)

Walk your Rare Friend into a banking hall built on pooled NFT-wallet rewards, and pull
the lever at the desk to watch a real market-making strategy decide, week after week,
that it should not trade.

Built for the [Rare Friends Vibeathon](https://github.com/spokesz/rarefriends-vibeathon).
**No wallet, no signature, no install.** You land inside the hall with a Friend already on the
marble, and can swap to any Friend in your own wallet from the HUD.

**This is deliberately not a FriendSDK game.** `readGenerationEligibility` reads `ownerOf` and
`generation` from the *Generations* contract and requires generation >= 1, so no SDK game can
ever admit a **Genesis** &mdash; and a Genesis holds ~4,500 RF of idle rewards against ~31 RF
across six Gen-3s. The Genesis *is* the bank. The SDK is used here as a **library** under its
Apache-2.0 licence for world rendering and movement; the identity gate and the character are
ours, which is what lets a Genesis walk in.

---

## Why the desk refuses

We set out to build a market maker for $RAREFRIENDS. Before writing it, we measured
whether one could work.

**The pool pays its liquidity providers nothing.** `slot0.lpFee` is `0`, while the hook
takes **5% of every swap** and routes it to `ActivationManager`, which streams it to
activated Friends. The people who supply the liquidity and the people who collect the
fees are different people.

**So nobody supplies it.** Third-party liquidity in that pool is **exactly zero** — the
protocol's own seed position is 100.00% of it, in a market doing ~$37.5k/day. One address
ever tried: `0x58daec31…` opened a concentrated position, closed it **48 seconds later**,
tried again, closed that in 46 seconds, and left.

**Every strategy we tested lost money** on the real tape of 8,777 swaps:

| strategy | result |
| --- | --- |
| Passive full-range LP | −43% to −55% vs holding |
| Grid bot, 5%–30% steps | −39% to −87% |
| Mean reversion (buying the dip) | −63% to −84% |
| Momentum | the only winner, and it won by selling RF and sitting in WETH — still −18% vs just holding WETH |
| Genesis NFT market making | a real 21% bid-ask, but the floor fell **45% in five days** |
| Reserve → OpenSea arbitrage | **does not exist**; the Reserve has no sell path |

The cause is mechanical: **5% in plus 5% out is a ~10% round trip**, so a completed trade
needs a >10% swing *that comes back*. $RAREFRIENDS did not swing, it slid 89%.

So the desk is **flat by default**, and every arming gate is derived from one of those
failures. On the real tape it takes **zero fills** and ends **+0.00% vs hold**.

## The number that reframes it

A grid is two-sided: it needs RF to sell and WETH to buy, and **both** sides must clear the
minimum economic fill. One Friend's idle rewards are 94% WETH / 6% RF, which puts the RF
side at **$4.94** and its slice at **$0.74** — far under the **$8.71** floor.

**A single Friend can buy and can never economically sell.** Minimum viable balanced book
is **$116**.

That is not a hole in the argument. It *is* the argument, as a number instead of a slogan:
one Friend cannot make a market, pooled Friends can, and protocol-wide idle rewards are
roughly $30,000.

## Repository

```
game/        the original FriendSDK build, kept for reference (cannot admit a Genesis)
app/         THE PRODUCT: the hall at /, the research at /docs
contracts/   FriendBank.sol + 20 Foundry tests. NOT DEPLOYED
lib/         protocol reader and the strategy module, shared by everything
scripts/     verification, backtests, parameter derivation, harvester, harnesses
docs/        economics, backtests, strategy results
```

`lib/strategy.mjs` is the single strategy. `app/lib/` and `game/strategy.mjs` are copies so
each target deploys standalone, and `npm run check:lib-sync` / `check:game-sync` fail the
build if they ever drift. **The lever in the game runs that exact module** — when the desk
stands down in the game, it stands down for the reason it would with real money.

## Commands

```sh
npm install

npm run verify           # 37 assertions against live Robinhood Chain state
npm run derive           # every parameter, labelled MEASURED / DERIVED / CHOICE
npm run history          # pull all 8,777 swaps in the pool's history
npm run backtest         # LP / venue / crossing strategies
npm run backtest:chart   # grid, mean reversion, momentum
npm run backtest:gated   # the desk itself: does it correctly stay flat?
npm run sweep            # 40 market regimes x 6 seeds
npm run check:lever      # can the lever ever arm? prints the rate per regime
npm run harvest -- --wallet 0xYOU      # dry-run the auto-harvester

npm run sweep:hall       # the hall at 12 screen sizes: does it FILL them, does anything overlap?
npm run play:hall        # walk to the desk and pull the lever, in each of the three rooms
```

Contracts: see [contracts/README.md](contracts/README.md).
Game: see [game/README.md](game/README.md).

## Checks

| check | result |
| --- | --- |
| `npm run verify` | **37/37** against live chain state |
| `forge test` | **20/20** on the contract safety properties, including Genesis enrolment |
| `npm run backtest:gated` | 0 fills on the real tape; arms on a ranging one |
| `npm run check:lever` | 21% overall arm rate; 0% in dead/falling markets |
| `npm run sweep:hall` | **120/120** across twelve sizes, 320px → 3440px |
| `npm run play:hall` | **26/26**: walks, arrives, opens the desk, pulls the lever, in all three rooms |
| `npm run sweep:game` | **72/72** across nine viewports, 320px → 2560px (SDK build) |
| `node scripts/visual-check.mjs <url>` | **70/70** on the dashboard, 320px → 2560px |

## The hall fits every screen because there are three of them

An isometric room built as a rectangle always projects **3.09 : 1**, whatever its
proportions — for any plane rectangle the horizontal and depth ranges are both
`w + h`. So no single hall can fill both an ultrawide monitor and a phone held
upright: the first version was 390 x 197 inside an 844 tall page, 23% of the screen,
with the HUD sitting on top of the desk sign.

Depth is worth a third of width on screen, so `lib/hall-world.ts` generates **three
rooms from one spec** — a floor you look across (2.40), a hall (1.53) and a corridor
you look down (0.53) — and the component measures the box it actually has and picks
the one that wastes least. Each camera is **solved** from that room's own corners,
prop extents and sign height, so the frame ratio cannot drift from the viewBox.

## Status and honesty

The desk **has never traded**. Contracts are written, tested and **not deployed**.
Deposits from anyone other than the builder are closed until an external audit.

5.6 days of one token in one downtrend is a small and unusual sample. Nothing here is a
forecast; the backtests are evidence of what has happened, not a claim about what will.

## Two SDK limitations we could not work around

- **Genesis holders cannot play any FriendSDK game.** `readGenerationEligibility` reads
  `ownerOf` and `generation` from the **Generations** contract and requires generation ≥ 1.
  Genesis NFTs are a different contract and report generation 0, so they are excluded twice
  over. That locks out the protocol's most valuable holders, and it is why this project left
  the SDK runtime. `contracts/test` proves a Genesis enrols and is collected from exactly like
  a Generations Friend.
- **The Friend picker shows no artwork.** It renders the token label as text, so you choose
  blind between Friends that look nothing alike. The SDK already has a sprite reader; the
  picker does not use it. Ours shows every Friend's on-chain art, which is free: the artwork
  is already served as a data URI.

## Licence

MIT, see [LICENSE](LICENSE). Fonts are SIL OFL; Friend artwork is read from chain and
rendered unmodified.
