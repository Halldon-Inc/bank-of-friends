#!/usr/bin/env node
/**
 * The auto-harvester grew into the keeper (scripts/keeper.mjs), which claims
 * with `claimBatch` instead of one transaction per asset per Friend, prices its
 * threshold from measured gas instead of a hardcoded ETH price of 2734.86, calls
 * `allocate` when a stream ends, and alarms if the fee stops reaching Friends.
 *
 * This file stays so `npm run harvest` keeps working. Same flags:
 *
 *   node scripts/harvest.mjs --wallet 0xABC...             # dry run
 *   node scripts/harvest.mjs --wallet 0xABC... --execute   # needs HARVESTER_PRIVATE_KEY
 */
await import("./keeper.mjs");
