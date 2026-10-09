// Solana transaction building, offline: a USDC transfer signed by the agent's
// own key with a fixed blockhash. Nothing is sent.

import assert from "node:assert/strict";
import test from "node:test";
import { getBase58Encoder, getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet, solanaSecret } = await import("../src/wallet.js");
const { buildUsdcTransfer, toUnits } = await import("../src/solana.js");

test("USDC amounts convert exactly, and junk is refused", () => {
  assert.equal(toUnits("1"), 1_000_000n);
  assert.equal(toUnits("0.000001"), 1n);
  assert.equal(toUnits("2500.5"), 2_500_500_000n);
  assert.throws(() => toUnits("1.0000001"));
  assert.throws(() => toUnits("-1"));
  assert.throws(() => toUnits("1e3"));
});

test("a transfer is signed by the agent's own wallet, fee payer included", async () => {
  const { solana } = initWallet();
  const blockhash = { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n };
  const to = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const r = await buildUsdcTransfer({ secret: solanaSecret(), to, units: 1_500_000n, blockhash });
  assert.equal(r.from, solana);
  assert.equal(getBase58Encoder().encode(r.signature).length, 64);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(r.wire));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], solana, "the agent pays the fee");
  assert.equal(msg.instructions.length, 2, "create-recipient-account (idempotent) + transferChecked");
});
