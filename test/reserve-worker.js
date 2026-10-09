// Child process for the cross-process reserve test: try to reserve $1. Exit 0 if
// it fit under the limit, 3 if refused.
import { loadPolicy } from "../src/policy.js";
import { reserve } from "../src/ledger.js";
import { Refused } from "../src/errors.js";

try {
  await reserve(loadPolicy(), { kind: "send", chain: "base", asset: "USDC", usd: 1, to: "0xabc" });
  process.exit(0);
} catch (err) {
  process.exit(err instanceof Refused ? 3 : 1);
}
