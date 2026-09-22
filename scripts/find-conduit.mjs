import { parseAbi, getAddress } from "viem";
import { client } from "../lib/protocol.mjs";
const c = client();
const KEY = "0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e";
const abi = parseAbi(["function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)"]);
const CANDIDATES = [
  "0x00000000F9490004C11Cef243f5400493c00Ad63", // Seaport ConduitController (canonical)
  "0x0000000000000068F116a894984e2DB1123eB395", // Seaport 1.6 itself (long shot)
];
for (const addr of CANDIDATES) {
  try {
    const code = await c.getBytecode({ address: getAddress(addr) });
    if (!code || code === "0x") { console.log(addr, "-> no code on this chain"); continue; }
    const r = await c.readContract({ address: getAddress(addr), abi, functionName: "getConduit", args: [KEY] });
    console.log(addr, "-> conduit", r[0], "exists:", r[1]);
  } catch (e) { console.log(addr, "->", (e.shortMessage || e.message).split("\n")[0].slice(0, 90)); }
}
