# The Bank of Friends

A regime-gated market-making desk funded by the rewards sitting idle in Rare Friends
NFT wallets.

**Its default state is flat.** It does not try to make money in every market. It waits
for conditions that pay for the risk, works a wide grid, and stands down again. On the
only history that exists, it refuses to trade — and that is the point.

## Why it is built this way

Every gate came from a measured failure, not a hunch. See `docs/ECONOMICS.md` and
`docs/BACKTEST.md`.

| what was tested | result |
| --- | --- |
| Passive LP in the RF/WETH pool | **-43% to -55%.** `lpFee = 0`: LPs earn nothing and eat full impermanent loss |
| Quoting a spread as a venue | Profitable, but diverts **68% of Friend rewards** away from Friend holders |
| Chart bots (grid, mean-reversion, momentum) | Every configuration **lost to simply holding WETH** |
| Genesis NFT market making | 21% bid-ask, but the asset fell **45% in 5 days** |
| Reserve to OpenSea arbitrage | **Does not exist.** The Reserve has no sell path |

## The verified finding underneath it

The RF/WETH market is a Uniswap v4 pool whose hook takes **5% of every swap** and sends
it to `ActivationManager`, which streams it to activated Friends. The pool's own
`lpFee` is **0**.

So the people who provide the liquidity and the people who collect the fees are
different people. Nobody outside the protocol has ever had a reason to provide
liquidity, and measurably, almost nobody has: the Market's seed position is
**100.00%** of all liquidity in the pool.

Run `npm run verify` to check all 37 assertions against live chain state yourself.

## Commands

```sh
npm install
npm run verify          # 37 assertions against Robinhood Chain. Refuses to pass if it grades nothing.
npm run history         # pull the complete swap history of the pool
npm run backtest        # venue / LP / crossing strategies
npm run backtest:chart  # chart-trading strategies
npm run backtest:gated  # the actual desk: does it correctly stay flat?
```

## Status

Research and strategy complete and reproducible. Contracts and keeper in progress.
Nothing is deployed. No third-party funds are accepted.
