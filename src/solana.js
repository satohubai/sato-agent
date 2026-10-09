// Solana mainnet: balances and USDC sends under the owner's limits. Every
// transaction is simulated before it is sent; the recipient's token account is
// created if it does not exist yet (the agent pays that rent, ~0.002 SOL).

import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
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
import { evaluate, loadPolicy, Refused } from "./policy.js";
import { record, spentOn } from "./ledger.js";
import { loadWallet, solanaSecret } from "./wallet.js";
import { USER_AGENT } from "./version.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS = 1_000_000_000;

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

export function toUnits(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 6) throw new Error(`not a USDC amount: ${amount}`);
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** Send USDC on Solana. Refuses (throws Refused) when the owner's limits say no. */
export async function sendUsdc({ to, amount }, r = rpc()) {
  if (!isAddress(to)) throw new Error(`not a Solana address: ${to}`);
  const units = toUnits(amount);
  const usd = Number(units) / 1e6;
  const refusals = evaluate(loadPolicy(), { usd, to }, spentOn());
  if (refusals.length) throw new Refused(refusals);

  const { value: blockhash } = await withTimeout(r.getLatestBlockhash().send());
  const { wire, signature } = await buildUsdcTransfer({ secret: solanaSecret(), to, units, blockhash });
  const sim = await withTimeout(r.simulateTransaction(wire, { encoding: "base64", commitment: "confirmed" }).send());
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  const entry = record({ status: "submitted", kind: "send", chain: "solana", asset: "USDC", usd, to });
  try {
    await withTimeout(r.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  } catch (err) {
    record({ id: entry.id, status: "failed", reason: "not broadcast", error: String(err.message) });
    throw err;
  }
  for (let i = 0; i < 40; i++) {
    const { value } = await withTimeout(r.getSignatureStatuses([signature]).send());
    const s = value[0];
    if (s?.err) {
      record({ id: entry.id, status: "failed", reason: "transaction error", tx: signature });
      throw new Error(`transaction failed: ${signature}`);
    }
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      record({ id: entry.id, status: "confirmed", tx: signature });
      return { tx: signature, explorer: `https://solscan.io/tx/${signature}`, usd, to };
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { tx: signature, explorer: `https://solscan.io/tx/${signature}`, usd, to, note: "sent; not confirmed within 60 s, check the explorer" };
}
