**Project name**

The Bank of Friends

**Builder / contact**

Hunt · GitHub [@huntclubhero](https://github.com/huntclubhero) · wallet `huntclubhero.eth`

**Category**

Economy Potential (also relevant: Character Spotlight)

**One sentence**

The Bank of Friends pools the $RAREFRIENDS and WETH rewards sitting idle in Rare Friends
NFT wallets and runs a regime-gated market-making desk with them, which is flat by
default and tells you, live, exactly which conditions are keeping it flat.

**Source code**

<https://github.com/Halldon-Inc/bank-of-friends> · no FriendSDK. Stack: Next.js 16, viem,
Solidity 0.8.30 + Foundry, plain ESM for the research harnesses.

**Working demo**

<https://bank-of-friends-nu.vercel.app>

No wallet needed to view. It reads Robinhood Chain (4663) directly and shows live desk
status, the arming conditions and how far each one is from its threshold, the pool state,
and the founding member's seven activated Friends rendered from their own on-chain artwork.

---

## What we actually found

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
| volatility floor | a 10% toll needs >10% swings to clear |
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
25 minimum, 145 trades against 200, and hourly realised vol 1.49% against a 4% floor. The
site shows this and updates it.

## How to use it

1. Open <https://bank-of-friends-nu.vercel.app>. No wallet required.
2. The hero reads **FLAT** or **ARMED**. Under it, every arming condition with its live
   value and its threshold. Filled squares are blocking.
3. **The market** panel is the live pool: price, 24h volume and trades measured from the
   hook's own `FeeCollected` events, realised vol, and pool depth.
4. **The book** is the founding member's idle, unclaimed rewards: $86 across seven
   activated Friends, each rendered from its own on-chain artwork.

To run the research yourself:

```sh
npm install
npm run verify           # 37 assertions against live chain state
npm run history          # pull all 8,777 swaps
npm run backtest         # LP / venue / crossing strategies
npm run backtest:chart   # grid, mean reversion, momentum
npm run backtest:gated   # the actual desk: does it correctly stay flat?
npm run harvest -- --wallet 0xYOURWALLET    # dry run the auto-harvester
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
| `node scripts/visual-check.mjs <url>` | **70/70** across 320px → 2560px, against production |
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

## Credits

Friend artwork is each NFT's own on-chain SVG, read unmodified from
`rarefriends.com/api/protocol/state` and rendered at its native resolution. Hardwired
Generations are zoom-cropped to centre the isometric world; Genesis and temp portraits are
not. No third-party assets are used anywhere else: no fonts are bundled, no images are
shipped, and the entire interface is CSS.

Protocol mechanics were read from the contracts themselves via
`rarefriends.com/api/protocol/config`, which ships full ABIs.
