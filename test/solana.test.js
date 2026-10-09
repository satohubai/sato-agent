// Solana, offline: transaction building and signing with a fixed blockhash, and
// the recipient checks that stop USDC going to an address nobody can sign for.

import assert from "node:assert/strict";
import test from "node:test";
import { address, getBase58Encoder, getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet, solanaSecret } = await import("../src/wallet.js");
const { assertWalletRecipient, buildUsdcTransfer, toUnits, USDC_MINT } = await import("../src/solana.js");

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const mockRpc = (owner) => ({ getAccountInfo: () => ({ send: async () => ({ value: owner ? { owner } : null }) }) });

test("USDC amounts convert exactly; zero and junk are refused", () => {
  assert.equal(toUnits("1"), 1_000_000n);
  assert.equal(toUnits("0.000001"), 1n);
  assert.equal(toUnits("2500.5"), 2_500_500_000n);
  for (const bad of ["0", "0.0", "1.0000001", "-1", "1e3", "abc"]) assert.throws(() => toUnits(bad), undefined, bad);
});

test("a transfer is signed by the agent's own wallet, which also pays the fee", async () => {
  const { solana } = initWallet();
  const blockhash = { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n };
  const r = await buildUsdcTransfer({ secret: solanaSecret(), to: WALLET, units: 1_500_000n, blockhash });
  assert.equal(r.from, solana);
  assert.equal(getBase58Encoder().encode(r.signature).length, 64);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(r.wire));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], solana);
  assert.equal(msg.instructions.length, 2, "create-recipient-account (idempotent) + transferChecked");
});

test("a wallet address is accepted", async () => {
  await assertWalletRecipient(WALLET, mockRpc(null));
  await assertWalletRecipient(WALLET, mockRpc("11111111111111111111111111111111"));
});

test("a token account is refused: USDC sent to it would be lost", async () => {
  await assert.rejects(assertWalletRecipient(WALLET, mockRpc(TOKEN_PROGRAM_ADDRESS)), /token account/);
  // The real Token-2022 program id (@solana-program/token-2022 0.19.0, executable on mainnet).
  await assert.rejects(assertWalletRecipient(WALLET, mockRpc("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")), /token account/);
});

test("an off-curve address (e.g. an associated token account) is refused before any RPC call", async () => {
  const [ata] = await findAssociatedTokenPda({ owner: address(WALLET), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await assert.rejects(assertWalletRecipient(ata, mockRpc(null)), /not a wallet address/);
  await assert.rejects(assertWalletRecipient("not-an-address", mockRpc(null)), /not a Solana address/);
});
