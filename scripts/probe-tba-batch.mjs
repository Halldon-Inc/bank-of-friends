/**
 * Can a member set the Bank up with ONE signature instead of three?
 * Today it is: join() from the EOA, then approve RF and approve WETH from the TBA.
 * If the ERC-6551 account supports operation=1 (DELEGATECALL), a single execute()
 * can delegatecall a batch helper that does both approvals at once.
 */
import { parseAbi, getAddress, encodeFunctionData } from "viem";
import { ADDR, ABI, client } from "../lib/protocol.mjs";
const c = client();
// Generations #5339, owned by 0x97f29031... (the largest holder). Never Hunt's own
// Friend: simulating execute from its owner is impersonation in spirit.
const TBA = "0x561A3979fb6ab58847bdC40B866a76c82005a8C8";
const OWNER = getAddress("0x97f290319734D0ce22215079417F3fE6A6439932");
const SPENDER = getAddress("0x000000000000000000000000000000000000ba5e");

const approveData = encodeFunctionData({
  abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
  functionName: "approve", args: [SPENDER, (1n << 256n) - 1n],
});

console.log("operation codes on the Friend's token-bound account:");
for (const [op, name] of [[0, "CALL"], [1, "DELEGATECALL"], [2, "CREATE"], [3, "CREATE2"]]) {
  try {
    await c.simulateContract({
      address: TBA, abi: ABI.tba, functionName: "execute",
      args: [ADDR.RF, 0n, approveData, op], account: OWNER,
    });
    console.log(`  op ${op} ${name.padEnd(12)} ALLOWED`);
  } catch (e) {
    const m = (e.shortMessage ?? e.message).split("\n")[0];
    console.log(`  op ${op} ${name.padEnd(12)} blocked: ${m.slice(0, 70)}`);
  }
}
