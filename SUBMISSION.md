**Play it: <https://bank-of-friends-nu.vercel.app>** with no wallet, no signature and no install.
You land inside the hall with a Friend already on the marble.

**Project name**

The First Bank of Friends

**Builder / contact**

Hunt &middot; GitHub [@huntclubhero](https://github.com/huntclubhero) &middot; wallet `huntclubhero.eth`

**Category**

Economy Potential (also relevant: Character Spotlight)

**One sentence**

Walk any Rare Friend, **Genesis included**, into a banking hall built on pooled NFT-wallet
rewards, open an account at the desk, and pull the lever to watch a real market-making
strategy decide, week after week, that it should not trade.

**Source code**

<https://github.com/Halldon-Inc/bank-of-friends> &middot; Next.js 16, viem, Solidity 0.8.30 +
Foundry. **FriendSDK is used as a library, not a runtime** (see below).

**Playable demo**

<https://bank-of-friends-nu.vercel.app> &middot; the research and live desk are at
<https://bank-of-friends-nu.vercel.app/docs>.

---

## Why this is not a FriendSDK game

We built one first. Then we measured the wallet.

`readGenerationEligibility` reads `ownerOf` **and** `generation` from the **Generations**
contract and requires `generation >= 1`. A Genesis is a different contract and reports 0, so
**no FriendSDK game can ever admit a Genesis.**

For this project that is fatal rather than annoying:

| | idle rewards |
| --- | --- |
| **Genesis #259** | **~4,500 RF** |
| six Gen-3s, combined | ~31 RF |

The Genesis *is* the bank. Everything else is garnish. A bank that excludes 99% of its own
deposits is not a bank.

The vibeathon rules make the SDK optional for **"a launchpad, tool or agent"**, and a market
maker is a tool. So the SDK is used as a **library** under its Apache-2.0 licence:
`renderWorld` draws the hall, `createWorldMovement` handles walking, collision and pathing,
`project`/`unproject` map world to screen. What we supply is the identity gate and the
character.

**The unlock:** `renderWorld` accepts live actors as `rows` of arbitrary bitmap, not as a
token id. So the character is rasterised from whatever artwork a Friend actually has, which
works for *both* collections where the SDK's sprite reader (Generations families registry
only) cannot. A Genesis walks the marble.

`contracts/test` proves the same thing in Solidity: `test_GenesisCanJoinAndBeCollectedFrom`
enrols a Genesis and collects from it exactly like a Generations Friend, bounded by the same
member cap.

## The hall

You land inside it, with a Friend already on the marble. Walk with WASD, arrows, or tap.
Two destinations: **The Desk** and **The Vault**.

**The desk opens an account, and it does not consult the market to do it.** Joining the
bank and the bank deciding to quote are different questions, and an earlier build
collapsed them: the desk's only action was the lever, so a Genesis holder walked up, got
"SAT OUT" because the market was quiet, and reasonably read it as the bank refusing him.

You see what you grant (harvest, a daily cap you set yourself, return on demand) and what
the bank cannot do, each line of which has a Foundry test behind it. With a browser wallet
present you sign a real **EIP-712** mandate. It grants nothing: no allowance, no
transaction, no gas, and the contract is not deployed. Without a wallet the account still
opens and is labelled **unsigned** rather than dressed up as a signature.

**The vault holds the book**: depositors, pooled RF, pooled WETH, and a bar against the
**$116 minimum viable balanced book**. The founding Genesis reads about **$103 in total but
only about $15 balanced**, because rewards arrive roughly 94% WETH and 6% RF. Watching
that bar fill as Friends join is the whole case for pooling, drawn. Accounts live in this browser
and the panel says so: there is no backend, so a global depositor count would be a lie.

Below a rule at the desk sits **the lever**, which is the bank's trading decision rather
than yours. Pull it and a week of market rolls. The **real strategy module** decides
whether to trade: `lib/strategy.mjs`, the same file the backtests and the keeper use,
guarded by `npm run check:lib-sync`. Most weeks it refuses, and names the gate that
blocked it in one sentence: *"Too quiet. Barely anyone is trading today."* The ten checks
sit behind a disclosure, not in the headline.

Measured arm rate across regimes: **21%** overall, 77% in live chop and **0%** in dead
calm, a slow bleed, or a hard dump. `npm run check:lever` prints that table.

## Why the desk refuses: what the research found

We started out to build a market maker for $RAREFRIENDS. Before writing it we measured
whether one could work. Every number below is reproducible with `npm run verify`
(37 assertions against live chain state) and `npm run backtest` (all 8,777 swaps in the
pool's history).

**1. The pool pays its liquidity providers nothing.**

```
slot0.lpFee       = 0        liquidity providers earn zero
Hook.FEE_BPS()    = 500      5% of every swap is taken
Hook.rewards()    = 0xD4A3…83Ac   …and sent to ActivationManager, i.e. to Friend holders
```

In Rare Friends, **the people who supply the liquidity and the people who collect the fees
are different people.** That is not a bug, it is the design: the fee is a transfer from
traders to Friend holders, and LPs were never in the split.

**2. So nobody provides liquidity, and we can prove it.**

```
pool total liquidity          147,865,847,752,143,433,133,351
Market's seed position        147,865,847,752,143,433,133,351
third-party liquidity                                       0
```

**100.00%** of the liquidity in a market doing ~$37.5k/day is the protocol's own seed.
Exactly one address ever tried: `0x58daec31…` opened a concentrated position, closed it
**48 seconds later**, tried again, closed that one in 46 seconds, held a small full-range
position about seven hours, and left. The hook has no `beforeAddLiquidity` or
`beforeRemoveLiquidity` flag, so liquidity is ungated *by construction*, not by permission.
Nobody used that fact because doing so loses money.

**3. Every market-making strategy we tested lost money on this tape.**

| strategy | result |
| --- | --- |
| Passive full-range LP | **−43% to −55%** vs holding. `lpFee = 0` means full impermanent loss, zero compensation |
| Acting as a venue, quoting inside the 5% | Profitable, but diverts **68% of Friend rewards** away from Friend holders |
| Grid bot, 5% to 30% steps | **−39% to −87%** vs holding |
| Mean reversion (buy the dip) | **−63% to −84%**. Dip-buying a one-way −89% slide is how desks die |
| Momentum | The only winner, and it won by selling RF and sitting in WETH: still **−18% vs just holding WETH** |
| Genesis NFT making | Real 21% bid-ask, but the asset fell **45% in 5 days** |
| Reserve → OpenSea arbitrage | **Does not exist.** The Reserve has no sell path; `trade`/`tradeAny` require you to hand in a Genesis |

The cause is mechanical: **5% in plus 5% out is a ~10% round trip**, so a completed trade
needs a >10% swing *that comes back*. Over the pool's whole life RF did not swing, it slid.

**4. There is a Laffer curve on the hook fee.**

Any venue cheaper than 5% must multiply volume to keep Friend holders whole:

| venue fee | round trip | volume needed to hold rewards flat |
| --- | --- | --- |
| 1% | 2% | **5.0×** |
| 2% | 4% | 2.5× |
| 3% | 6% | 1.7× |

We cannot prove from 5.6 days where the peak is. We can state the break-even exactly, and
we think it is worth the Rare Friends team knowing that their fee may sit above the
revenue-maximising rate.

## So what did we build

A desk whose **default state is flat**, with every arming gate derived from one of the
failures above rather than chosen by feel.

| gate | derived from |
| --- | --- |
| flat unless ranging (drift bands) | mean reversion lost 76–84% fading a one-way slide |
| minimum 24h volume and trade count | gas on 8,777 fills was $290, i.e. 3.4× the whole book |
| volatility floor | a 10% toll needs >10% swings to clear, and they must arrive often enough to matter |
| grid step ≥ 15% | never quote inside the toll |
| minimum fill size | only 61% of trades were large enough to beat gas |
| inventory cap and auto-flatten | flow ran 84.6% one-way by value |
| drawdown breaker | stays stopped until manually reset |

**The proof it works is that it refuses to trade.** Run `npm run backtest:gated`:

```
RUN 1  real history, the -89% slide
  armed on     0 ticks (0.0%)
  FILLS        0
  vs hold      +0.00%      <- it sat out the entire crash and lost nothing

RUN 2  synthetic ranging tape, volume restored (clearly labelled synthetic)
  armed on     3067 ticks (51.1%)
  FILLS        16
  vs hold      +5.76%      <- given chop and volume, it works the grid
```

Live the desk is **FLAT**. As of **2026-09-22 16:17Z** it was blocked on four of its ten
conditions: 24h volume 9.99 WETH against a 25 minimum, 119 trades against 200, hourly
realised vol 1.43% against the derived 3.27% floor, and a seven-day drift band with less
than seven days of history behind it, which is a missing measurement rather than a market
verdict and is labelled as one. At that volatility a single 15% rung takes about **101
hours** to traverse, i.e. 0.83 round trips a week against a target of 4. Those figures are
read live at <https://bank-of-friends-nu.vercel.app/docs>, so check them rather than trust
them: that is the real reason the desk is flat, stated as a measurement rather than as a
threshold someone invented.

## The parameters are derived, not invented

An earlier draft of this desk carried numbers I had simply chosen and then tuned against
synthetic data my own code generated, which is circular. `npm run derive` now labels every
input **MEASURED**, **DERIVED** or **CHOICE** and shows the algebra, grounded in the standard
dealer-inventory literature (Ho-Stoll 1981, Avellaneda-Stoikov 2008, Grossman-Miller 1988).

It caught three real errors:

| | was | now |
| --- | --- | --- |
| minimum fill | $0.33 | **$8.71**: the old figure was "10x gas" and ignored that a round trip nets 3.79%, not 100%. **26x too low** |
| volatility floor | 4.00%, picked | **3.27%**, derived from the grid step and a stated target of 4 round trips/week |
| inventory cap | 60% fixed | **volatility-scaled**: 40% at today's 1.49%, 10% at 6% |

Two numbers that should have been stated from the start: the **break-even grid step is
10.80%** (`s > 1/(1-f)^2 - 1` at f=5%), and a round trip at a 15% step nets **3.79%, not 15%**
because the fee takes 75% of the gross move.

And the finding that reframes the whole project: a grid is two-sided, so **both** sides must
clear the minimum fill. One Friend's rewards are 94% WETH / 6% RF, which puts the RF side at
**$4.94** and its slice at **$0.74**, far under the $8.71 floor. **A single Friend can buy and
can never economically sell**, so it cannot make a market at all. Minimum viable balanced book
is **$116**.

That is not a hole in the argument. It *is* the argument, as a number rather than a slogan:
one Friend cannot, pooled Friends can. For scale, your own `weekRewardsUsd` puts roughly
**$30,000 a week** of rewards into Friend wallets, with about **$228,000** left in
`streamRemainingUsd` still to stream.

## Run the research yourself

```sh
npm install
npm run verify           # 37 assertions against live chain state
npm run history          # pull all 8,777 swaps
npm run backtest         # LP / venue / crossing strategies
npm run backtest:chart   # grid, mean reversion, momentum
npm run backtest:gated   # the actual desk: does it correctly stay flat?
npm run derive           # every parameter, labelled and derived
npm run sweep            # 40 market regimes x 6 seeds
npm run harvest -- --wallet 0xYOURWALLET    # dry run the auto-harvester
```

Run the hall itself, which is a plain Next.js app and needs no SDK checkout:

```sh
cd app && npm install && npm run dev      # the hall at /, the research at /docs
npm run sweep:hall <url>                  # 120 layout checks across twelve screen sizes
npm run play:hall  <url>                  # walk in, open an account, pull the lever, read the book
```

Both harnesses take a URL, so they can be run against the deployed site rather than only
against localhost. `game/` holds the original FriendSDK build and is kept for reference:
it is the version that cannot admit a Genesis, so it is not what runs at the link above.

## Economy and RF integration

- **The desk's capital is reward flow**, not fresh money: RF and WETH that Friends have
  already earned and left unclaimed in their ERC-6551 wallets.
- **Auto-harvest is live and carries no risk.** `ActivationManager.claim` is permissionless
  and credits the Friend's *own* wallet, never the caller, so the keeper can sweep every
  enrolled Friend while taking custody of nothing. Running it for someone else is a gift of
  gas, never a way to take their rewards.
- **All trading is simulated for this submission.** No desk trade has been executed on
  mainnet. The contracts are written and tested but **not deployed**.
- Costs are modelled from measurements, not assumptions: 5% hook fee per side, ~209k gas
  per swap = **$0.033** at 0.057 gwei, 1% OpenSea fee read from a real order's consideration.

## Safety

Three properties enforced in `FriendBank.sol`, in code, not policy, with a Foundry test each:

1. **The Bank never holds your NFT.** Its only power is an ERC-20 allowance you set from
   your own Friend's wallet. Revoke it and the Bank is powerless instantly.
2. **The Bank can never pull more than you allowed.** You set `capPerEpoch` at join.
   `collect` takes `min(cap, epoch room, allowance, balance)`, proven in a test where the
   member grants an *unlimited* allowance and the Bank still only takes the cap.
3. **Exit is never blocked.** `withdraw` has no timelock, no queue, no pause and no owner
   check. The owner may halt quoting; the owner may not halt leaving. Tested while halted.

The owner cannot move member funds, cannot upgrade (there is no proxy), cannot raise a
member's cap, and can only ratchet risk caps tighter.

## Checks

| check | result |
| --- | --- |
| `npm run verify` | **37/37** assertions against live chain state, none skipped |
| `forge test` | **20/20**, asserting the safety properties above, Genesis enrolment included |
| `npm run backtest:gated` | RUN 1 takes 0 fills on the real tape; RUN 2 arms and trades |
| `npm run sweep:hall <url>` | **120/120** across twelve sizes, 320px to 3440px, run against production |
| `npm run play:hall <url>` | **41/41**: walk in, open an account, pull the lever, read the book, in all three rooms |
| `node scripts/visual-check.mjs <url>` | **70/70** on /docs across 320px to 2560px, against production |
| `npm run check:lib-sync` | app/lib is byte-identical to lib, and every gate has a label |
| `npm run check:game-sync` | the reference SDK build in game/ still matches lib/ |
| `npx tsc --noEmit`, `next build` | clean |

## Known issues and limitations

- **The sample is small and unusual.** 5.6 days, one token, one violent downtrend. A grid
  bot in a *ranging* market genuinely can work; we cannot show that from this data, and the
  synthetic run is labelled synthetic for that reason. Nothing here is a forecast.
- **The desk has never traded.** Contracts are unaudited and undeployed, and deposits from
  anyone other than the builder are closed until an external audit. This is deliberate.
- **The thresholds are judgements.** The gate *shapes* come from measured failures; the
  exact numbers (25 WETH, 200 trades, 4% vol) are a first calibration, set deliberately
  above current conditions, and will need revising with more history.
- The backtest assumes the desk wins any fill it quotes, since any spread under 5% beats
  the only other venue. That is optimistic on capture and realistic on cost.
- Volume is collapsing: 5,018 trades on 2026-09-16 against ~145/day now. If it goes to
  zero the desk simply never arms, which is the correct behaviour but not a business.
- Discovery of a wallet's Friends uses `rarefriends.com/api/protocol/state`. Every *value*
  is read from chain; if their API is down, discovery degrades and the page says so rather
  than inventing numbers.

## Known issues, the hall

- **Accounts are kept in your browser**, in localStorage, because there is no backend. So
  the vault shows your own book and not a global one. A shared depositor count would be a
  lie until the contract is deployed, and we would rather show a small true number.
- The mandate signature is a statement of intent, not an approval. **Nothing on chain
  changes when you sign it**, and the panel says so rather than implying otherwise.
- The lever's market regimes are generated, clearly labelled, and shaped from the measured
  sweep. They are illustrations of the decision, not predictions.
- `game/` still holds the original FriendSDK build and is kept for reference only. It is
  the one that cannot admit a Genesis; at 360px its frame left all four station prompts
  overlapping. The shipped hall has two destinations, three room shapes, and a sweep that
  fails on any overlap.

## Credits

**FriendSDK is used as a library, under its Apache-2.0 licence**: `renderWorld` draws the
scene, `createWorldMovement` handles walking, collision and pathing, `project`/`unproject`
map world to screen. Thank you for shipping those as importable functions.

**The building itself is ours.** `app/lib/hall-art.ts` draws the columned facade, the
pediment, the carved name, the vault door and the teller counter. It had to: in this
projection an offset moves you across the screen and depth moves you down it, so a room
bounded by constant offsets and depths projects to a **plain rectangle seen head on**, while
the SDK's props are drawn as 45-degree isometric boxes. Mixing them put two incompatible
perspectives in one picture. The SDK props are still loaded, **hidden, and kept for
collision only**, so the pathfinder still works and the counter still blocks. The original
SDK-prop world is preserved in `game/world.ts` for reference.

Visual direction was matched against the SDK's own fishing example: `#eee` paper, `#111`
ink, hard `2px 2px 0` offset shadows, 44px square icon buttons inset 18px, mono labels with
`system-ui` display numbers. **The hall and the research page share one palette**, so the
two halves read as one product rather than two.

Friend artwork is each NFT's own on-chain SVG, read unmodified from
`rarefriends.com/api/protocol/state` and rendered at its native resolution. Hardwired
Generations are zoom-cropped to centre the isometric world; Genesis and temp portraits are
not. No third-party assets are used anywhere else: no fonts are bundled (the interface
uses the system mono stack), no images are shipped, and the rest is CSS.

Protocol mechanics were read from the contracts themselves via
`rarefriends.com/api/protocol/config`, which ships full ABIs.
