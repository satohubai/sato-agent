// Solana mainnet: balances and USDC sends under the limits.
//
// The recipient must be a wallet: a token account or another off-curve address
// is refused, because USDC sent "to" it lands in an account nobody can sign for.
// A send is reserved against the limits first, simulated, and signed here; the
// signature is recorded before broadcast. If the broadcast or the status checks
// fail, the spend stays counted and the command says "do not retry" (Pending).
// The recipient's token account is created if missing (the agent pays that
// rent, about 0.002 SOL, not counted against the USD limits).

import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  isOffCurveAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { loadPolicy } from "./policy.js";
import { record, release, reserve } from "./ledger.js";
import { Pending, Refused, Rejected } from "./errors.js";
import { usdcUnits } from "./amount.js";
import { loadWallet, solanaSecret } from "./wallet.js";
import { USER_AGENT } from "./version.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// From @solana-program/token-2022 0.19.0 (TOKEN_2022_PROGRAM_ADDRESS); confirmed
// executable on mainnet 2026-10-09. (v0.1.x had a wrong id here, so token-2022
// token accounts slipped past the recipient check.)
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LAMPORTS = 1_000_000_000;
export const explorer = (sig) => `https://solscan.io/tx/${sig}`;

export function rpc() {
  const url = process.env.SATO_AGENT_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  return createSolanaRpc(url, { headers: { "user-agent": USER_AGENT } });
}

const withTimeout = (p, ms = 20_000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`Solana RPC timed out after ${ms} ms`)), ms))]);

export async function balances(owner = loadWallet().solana.address, r = rpc()) {
  const [lamports, accounts] = await Promise.all([
    withTimeout(r.getBalance(address(owner)).send()),
    withTimeout(r.getTokenAccountsByOwner(address(owner), { mint: address(USDC_MINT) }, { encoding: "jsonParsed" }).send()),
  ]);
  const usdc = accounts.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString || 0), 0);
  return { address: owner, sol: (Number(lamports.value) / LAMPORTS).toString(), usdc: usdc.toString() };
}

/**
 * Refuse recipients that are not wallets (a policy refusal: exit 3, nothing signed).
 * Returns nothing when `to` is a plausible wallet.
 */
export async function assertWalletRecipient(to, r = rpc()) {
  const notWallet = (message) => new Refused([{ rule: "recipient_not_wallet", limit: "a wallet address", observed: to, message }]);
  if (!isAddress(to)) throw new Error(`not a Solana address: ${to}`);
  if (isOffCurveAddress(address(to))) {
    throw notWallet(`${to} is not a wallet address (it has no private key, e.g. a token account or a program account). USDC sent to it would be lost.`);
  }
  const { value } = await withTimeout(r.getAccountInfo(address(to), { encoding: "base64" }).send());
  if (value && (value.owner === TOKEN_PROGRAM_ADDRESS || value.owner === TOKEN_2022_PROGRAM)) {
    throw notWallet(`${to} is a token account, not a wallet. Ask for the recipient's wallet address; USDC sent to a token account's address would be lost.`);
  }
}

/** Build and sign a USDC transfer. Pure apart from the blockhash it is given. */
export async function buildUsdcTransfer({ secret, to, units, blockhash }) {
  const signer = await createKeyPairSignerFromBytes(secret);
  const mint = address(USDC_MINT);
  const owner = address(to);
  const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner, mint }),
    getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: units, decimals: 6 }),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), from: signer.address };
}

/** Same parser as Base (src/amount.js), kept under its old name for callers. */
export const toUnits = usdcUnits;

/**
 * Dry run of a USDC send: recipient checks, then the same build + simulation a
 * real send runs. Nothing is reserved or sent (the transaction is signed in
 * memory only so the RPC can simulate it, then discarded).
 */
export async function dryRunSendUsdc({ to, amount }, r = rpc()) {
  const units = toUnits(amount);
  await assertWalletRecipient(to, r);
  const { value: blockhash } = await withTimeout(r.getLatestBlockhash({ commitment: "confirmed" }).send());
  const { wire } = await buildUsdcTransfer({ secret: solanaSecret(), to, units, blockhash });
  const sim = await withTimeout(r.simulateTransaction(wire, { encoding: "base64", commitment: "confirmed" }).send());
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return { dry_run: true, chain: "solana", usd: Number(units) / 1e6, to, simulated: true };
}

/** Send USDC on Solana. Throws Refused when the limits say no; nothing is signed then. */
export async function sendUsdc({ to, amount }, r = rpc()) {
  const units = toUnits(amount);
  const usd = Number(units) / 1e6;
  await assertWalletRecipient(to, r);
  const entry = await reserve(loadPolicy(), { kind: "send", chain: "solana", asset: "USDC", usd, to });

  let built;
  try {
    const { value: blockhash } = await withTimeout(r.getLatestBlockhash({ commitment: "confirmed" }).send());
    built = await buildUsdcTransfer({ secret: solanaSecret(), to, units, blockhash });
    const sim = await withTimeout(r.simulateTransaction(built.wire, { encoding: "base64", commitment: "confirmed" }).send());
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  } catch (err) {
    release(entry, "failed before broadcast; nothing sent", { error: String(err.message) });
    throw err;
  }

  const { wire, signature } = built;
  record({ id: entry.id, status: "signed", tx: signature });
  try {
    await withTimeout(r.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  } catch (err) {
    // The RPC's own preflight refusing it means it was never forwarded: release.
    // Anything else (a timeout, a dropped connection) may have gone out: Pending.
    const msg = `${err.message} ${JSON.stringify(err.context ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    if (/PREFLIGHT_FAILURE|preflight|-32002|Blockhash not found|insufficient (funds|lamports)/i.test(msg)) {
      release(entry, "rejected by the RPC preflight; never sent", { tx: signature, error: String(err.message) });
      throw new Rejected(`the RPC refused ${signature}: ${err.message}`);
    }
    throw new Pending(`broadcast of ${signature} reported an error (${err.message}).`, { tx: signature, explorer: explorer(signature) });
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    let s;
    try {
      s = (await withTimeout(r.getSignatureStatuses([signature]).send())).value[0];
    } catch {
      continue; // a flaky status read is not a failed transaction
    }
    if (s?.err) {
      release(entry, "transaction failed onchain", { tx: signature });
      throw new Error(`transaction failed onchain: ${explorer(signature)}`);
    }
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      record({ id: entry.id, status: "confirmed", tx: signature });
      return { tx: signature, explorer: explorer(signature), usd, to };
    }
  }
  throw new Pending(`${signature} was sent but not confirmed within 60 s.`, { tx: signature, explorer: explorer(signature) });
}
