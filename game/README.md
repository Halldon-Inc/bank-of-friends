# The First Bank of Friends

Walk your Rare Friend into a banking hall and find out why the desk will not trade today.

## Controls

| | |
| --- | --- |
| Walk | WASD, arrow keys, or tap/click a destination |
| Interact | `E` when a window is in reach, or tap the label |
| Close a window | `Esc` or the close control |

## The four windows

**Teller window.** Deposit one simulated slip of 1 RF. The outcome table is below.

**The vault.** The pooled book, and the arithmetic showing why one Friend's idle
rewards cannot make a market: a grid needs RF to sell and WETH to buy, each fill
must clear $8.71 to beat gas, and the RF side of a single Friend's rewards is $4.94.

**Trading desk.** Pull the lever. A week of market rolls and the **real strategy
module** decides whether to trade. It is not a mock: `strategy.mjs` here is
byte-identical to the one the backtests and the live keeper use. Most weeks it
refuses, and it shows you which gate blocked it.

**The ledger.** The five findings that produced those gates.

## Economy, all simulated

| Outcome | Chance | Returns on a 1 RF slip |
| --- | --- | --- |
| Desk stood down, deposit returned | 55% | 1.00 RF |
| Choppy week, the grid worked | 28% | 1.08 RF |
| Volatile chop, the grid ran hot | 10% | 1.20 RF |
| Traded into a turn, small loss | 7% | 0.90 RF |

Expected return **1.0354 RF** per slip. One outcome loses, deliberately: a desk
that cannot lose is a desk that is lying to you. The 55% stand-down rate matches
the regime sweep, where most conditions do not justify trading.

Every balance, price and reward is **simulated** and resets on reload. No RF is
spent, no transaction is signed, and no live contract is touched. Wallet
connection and Friend ownership are verified by the SDK runtime.

## Run it

```sh
npm ci
npm run build
npm run dev:game -- games/first-bank
```

Open the printed URL, connect a wallet holding a hardwired Generations NFT
(generation 1 or higher) on Robinhood mainnet, and pick your Friend.

## Assets

The banking hall is a **custom world** authored in `world.ts` using the SDK's own
scene format: a chamfered ground polygon, marble floor patches, walking paths, and
props drawn from the supplied kit (`terminal` as teller windows, `tank` as the
vault, `pipe` as columns, `bench` and `planter` for the lobby). The Friend is its
own canonical on-chain sprite, unmodified. No third-party assets are used.

The SDK renders light scenery on a dark ground; this game inverts that layer in
CSS for a light-mode hall, which matches rarefriends.com's default appearance.
