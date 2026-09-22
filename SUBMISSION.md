**Try it now: <https://halldon-inc.github.io/bank-of-friends/>**
Requires a browser wallet holding a hardwired Rare Friends Generations NFT, generation 1 or
higher, on Robinhood mainnet. Everything in it is simulated.

**Project name**

The First Bank of Friends

**Builder / contact**

Hunt · GitHub [@huntclubhero](https://github.com/huntclubhero) · wallet `huntclubhero.eth`

**Category**

Economy Potential (also relevant: Character Spotlight)

**One sentence**

Walk your Rare Friend into a banking hall built on pooled NFT-wallet rewards, and pull the
lever at the trading desk to watch a real market-making strategy decide, week after week,
that it should not trade.

**Source code**

<https://github.com/Halldon-Inc/bank-of-friends> · **FriendSDK v0.1.2**, plus Next.js 16,
viem and Solidity 0.8.30 + Foundry for the research and contracts.

**Playable preview**

<https://halldon-inc.github.io/bank-of-friends/> (GitHub Pages, static build from
`friendsdk build`). A live data dashboard also runs at
<https://bank-of-friends-nu.vercel.app>, which needs no wallet.

---

## The game

A banking hall on the SDK's ground plane, authored as a **custom world** because the supplied
presets are gardens, rooftops and caverns and none of them is a bank. Four windows:

| Window | What happens |
| --- | --- |
| **Teller** | Deposit a simulated 1 RF slip |
| **The vault** | The pooled book, and the arithmetic showing why one Friend cannot make a market |
| **Trading desk** | **Pull the lever.** A week of market rolls and the real strategy decides |
| **The ledger** | The five findings that produced the gates |

**The trading desk is not a mock.** `game/strategy.mjs` is byte-identical to the
`lib/strategy.mjs` the backtests and keeper use, and `npm run check:game-sync` fails the build
if that stops being true. When the desk stands down in the game, it stands down for exactly
the reason it would with real money, and it names the gate that blocked it.

Walk with WASD, arrows, or tap. Press `E` at a window.

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

Live right now the desk is **FLAT**, blocked on three gates: 24h volume 13.7 WETH against a
25 minimum, 145 trades against 200, and hourly realised vol 1.49% against the derived 3.27%
floor. At today's volatility a single 15% rung takes about **101 hours** to traverse, i.e.
0.83 round trips a week against a target of 4. That is the real reason the desk is flat,
stated as a measurement rather than a threshold someone invented.

## The parameters are derived, not invented

An earlier draft of this desk carried numbers I had simply chosen and then tuned against
synthetic data my own code generated, which is circular. `npm run derive` now labels every
input **MEASURED**, **DERIVED** or **CHOICE** and shows the algebra, grounded in the standard
dealer-inventory literature (Ho-Stoll 1981, Avellaneda-Stoikov 2008, Grossman-Miller 1988).

It caught three real errors:

| | was | now |
| --- | --- | --- |
| minimum fill | $0.33 | **$8.71** — the old figure was "10x gas" and ignored that a round trip nets 3.79%, not 100%. **26x too low** |
| volatility floor | 4.00%, picked | **3.27%**, derived from the grid step and a stated target of 4 round trips/week |
| inventory cap | 60% fixed | **volatility-scaled**: 40% at today's 1.49%, 10% at 6% |

Two numbers that should have been stated from the start: the **break-even grid step is
10.80%** (`s > 1/(1-f)^2 - 1` at f=5%), and a round trip at a 15% step nets **3.79%, not 15%**
— the fee takes 75% of the gross move.

And the finding that reframes the whole project: a grid is two-sided, so **both** sides must
clear the minimum fill. One Friend's rewards are 94% WETH / 6% RF, which puts the RF side at
**$4.94** and its slice at **$0.74**, far under the $8.71 floor. **A single Friend can buy and
can never economically sell**, so it cannot make a market at all. Minimum viable balanced book
is **$116**.

That is not a hole in the argument. It *is* the argument, as a number rather than a slogan:
one Friend cannot, pooled Friends can, and protocol-wide idle rewards are roughly $30,000.

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

To run the game locally, from a FriendSDK v0.1.2 checkout:

```sh
npm ci && npm run build
npx friendsdk dev ./games/first-bank      # after copying game/ into games/first-bank
```

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
   `collect` takes `min(cap, epoch room, allowance, balance)` — proven in a test where the
   member grants an *unlimited* allowance and the Bank still only takes the cap.
3. **Exit is never blocked.** `withdraw` has no timelock, no queue, no pause and no owner
   check. The owner may halt quoting; the owner may not halt leaving. Tested while halted.

The owner cannot move member funds, cannot upgrade (there is no proxy), cannot raise a
member's cap, and can only ratchet risk caps tighter.

## Checks

| check | result |
| --- | --- |
| `npm run verify` | **37/37** assertions against live chain state |
| `forge test` | **18/18**, asserting the safety properties above |
| `npm run backtest:gated` | RUN 1 takes 0 fills on the real tape; RUN 2 arms and trades |
| `npx friendsdk check` | **valid**; expected reward 1.0354 RF, max 1.2 RF |
| `npx friendsdk test` | **PASS** at 960px and at 360px |
| `node scripts/visual-check.mjs <url>` | **70/70** across 320px → 2560px, against production |
| `npm run check:game-sync` | game/ matches the SDK working copy, and its strategy matches lib/ |
| `npx tsc --noEmit`, `next build` | clean |
| `npm run check:lib-sync` | app/lib is byte-identical to lib |

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

## Known issues, game

- At 360px the SDK frame is only about 240px tall, so all four station prompts are visible at
  once and overlap. Only the one in reach activates, but it is busy. Not yet solved.
- The preview requires a wallet with an eligible Friend, as the SDK mandates, so it cannot be
  tried by someone who holds none. The Vercel dashboard needs no wallet and shows the same
  live data.
- The lever's market regimes are generated, clearly labelled, and shaped from the measured
  sweep. They are illustrations of the decision, not predictions.

## Credits

The banking hall is a **custom world** in `game/world.ts`, authored in the SDK's own scene
format from its supplied prop kit (`terminal` as teller windows, `tank` as the vault, `pipe`
as columns, `bench` and `planter` for the lobby). Visual direction was matched against the
SDK's own fishing example: `#eee` paper, `#111` ink, hard `2px 2px 0` offset shadows, 44px
square icon buttons inset 18px, mono labels with `system-ui` display numbers.

Friend artwork is each NFT's own on-chain SVG, read unmodified from
`rarefriends.com/api/protocol/state` and rendered at its native resolution. Hardwired
Generations are zoom-cropped to centre the isometric world; Genesis and temp portraits are
not. No third-party assets are used anywhere else: no fonts are bundled, no images are
shipped, and the entire interface is CSS.

Protocol mechanics were read from the contracts themselves via
`rarefriends.com/api/protocol/config`, which ships full ABIs.
