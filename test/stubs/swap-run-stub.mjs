// Test only: stands in for src/swap/run.js in a spawned CLI. SATO_STUB_SWAP picks what the swap does:
//   confirm   (default) the swap is signed and confirmed
//   pending   signed but not confirmed (Pending, exit 4)
//   approval  needs the owner's approval (NeedsApproval, exit 5)
//   fail      an error before anything is signed (exit 1)
import { NeedsApproval, Pending } from "../../src/errors.js";

const mode = process.env.SATO_STUB_SWAP || "confirm";

export const swapLines = () => ["Swap: 1 USDC for ETH (stub)"];
export const describeToken = async () => ({});
export const renderTokenCard = () => [];

export async function runSwap() {
  if (mode === "approval") throw new NeedsApproval({ cmd: "swap", chain: "base" }, { code: "deadbeef", expires_at: "2026-10-12T00:00:00.000Z" });
  if (mode === "fail") throw new Error("the quote failed (stub)");
  const display = { chain: "base", buy: { asset: "ETH" }, sato_fee: {}, confirm_reasons: [] };
  return {
    prepared: {
      display,
      execute: async () => {
        if (mode === "pending") throw new Pending("Signed but not confirmed (stub).", { explorer: "https://basescan.org/tx/0x1" });
        return { explorer: "https://basescan.org/tx/0xabc", tx: "0xabc" };
      },
    },
  };
}
