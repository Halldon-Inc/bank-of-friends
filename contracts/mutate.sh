#!/usr/bin/env bash
# Plant one bug at a time in the contracts and confirm the offline suite catches each. Restores every file.
# Fork suites are excluded (they need the RPC). Usage: bash mutate.sh
# It edits src/ in place while it runs (restoring on exit), so never run it while someone may commit.
cd "$(dirname "$0")"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
export FOUNDRY_INVARIANT_RUNS=4 FOUNDRY_INVARIANT_DEPTH=1500 FOUNDRY_NO_MATCH_CONTRACT=Fork
BK="$(mktemp -d)"
for f in src/FriendBank.sol src/RangeDesk.sol src/PoolObserver.sol; do cp "$f" "$BK/$(basename "$f")"; done
restore() { for f in src/FriendBank.sol src/RangeDesk.sol src/PoolObserver.sol; do cp "$BK/$(basename "$f")" "$f"; done; }
trap restore EXIT
killed=0; total=0
run() {
  local file="$1" name="$2" from="$3" to="$4"
  restore
  python - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
assert a in s, "pattern not found: " + a
open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))
PY
  total=$((total + 1))
  local out
  local raw
  raw=$("$FORGE" test 2>&1)
  if echo "$raw" | grep -q "Compiler run failed"; then echo "INVALID   $name (mutant does not compile; fix the script)"; return; fi
  out=$(echo "$raw" | grep -E "^\[FAIL" | sed -E 's/\(gas.*//; s/\(runs.*//' | sort -u | head -3)
  if [ -z "$out" ]; then echo "SURVIVED  $name"; else killed=$((killed + 1)); echo "KILLED    $name"; echo "$out" | sed 's/^/            /'; fi
}
B=src/FriendBank.sol; D=src/RangeDesk.sol; O=src/PoolObserver.sol
run $B "no ownership re-check at collect" "        if (!_stillHeld(collection, tokenId, f)) {
            _suspend(collection, tokenId, f);
            return;
        }
        Position storage p" "        Position storage p"
run $B "sweep whole balance instead of claim delta" "available = owed + (afterClaim > before ? afterClaim - before : 0);" "available = afterClaim;"
run $B "holder rounding up at range close" "            v[0] += Math.mulDiv(u, s.x, SCALE);" "            v[0] += Math.mulDiv(u, s.x, SCALE, Math.Rounding.Ceil);"
run $B "owed not forfeited on owner action" "            f.owedRf = 0;
            f.owedWeth = 0;
            f.seenState = st;" "            f.seenState = st;"
run $B "any collection accepted" "if (collection != GENESIS && collection != GENERATIONS) revert UnknownCollection();" ""
run $B "tip uncapped" "tip = Math.min(TIP_GAS_PER_FRIEND * block.basefee * 2, (weth * MAX_TIP_BPS) / BPS);" "tip = TIP_GAS_PER_FRIEND * block.basefee * 2;"
run $B "open step sized from balanceOf (donations count)" "        _openStep(OPEN_ASK, spent, bookR);" "        _openStep(OPEN_ASK, spent, RF.balanceOf(address(this)) + spent);"
run $B "exit does not spend the holder's units" "        if (isAsk) p.a = 0;
        else p.b = 0;" ""
run $B "withdraw gated by halt" "    function _withdraw(uint256 rfAmount, uint256 wethAmount, address to) internal {" "    function _withdraw(uint256 rfAmount, uint256 wethAmount, address to) internal {
        if (quotingHalted) revert DeskHalted();"
run $B "collect depends on the pool" "        try OBSERVER.poke() {} catch {}" "        OBSERVER.poke();"
run $B "stranger may close any time" "            revert NotCloseable();" ""
run $D "ask loss budget not enforced" "if (lossSpentWeth > _lossCap(rfHeld, wethHeld, twap)) revert LossBudgetExceeded();" ""
run $D "bid lock off" "revert LossLocked();" "{}"
run $D "TWAP edge off" "if (isAsk ? lo < twap + twapEdgeTicks : hi > twap - twapEdgeTicks) revert TooCloseToTwap();" ""
run $D "cost basis = last fill, not size-weighted" "            costRf += rOut;
            costWeth += spent;" "            costRf = rOut;
            costWeth = spent;"
run $O "poke not truncated" "            if (spot > lastTick + MAX_TICK_STEP) rec = lastTick + MAX_TICK_STEP;" "            if (false) rec = lastTick + MAX_TICK_STEP;"
echo "killed $killed of $total"
