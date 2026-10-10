// Offline Solana fixtures for the purchase tests: transactions built with @solana/kit
// (nothing is sent), and a fake RPC whose simulation answers with the balances a test sets.

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token";
import { USDC_MINT } from "../src/solana.js";

export const BLOCKHASH = { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1000n };
export const ata = async (owner, mint = USDC_MINT) => (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

/** A USDC TransferChecked from the agent's USDC account to the merchant's, authority = the agent (a noop signer: it is not signed). */
export async function usdcTransferIx(agent, merchant, units, mint = USDC_MINT) {
  return getTransferCheckedInstruction({ source: await ata(agent, mint), mint: address(mint), destination: await ata(merchant, mint), authority: createNoopSigner(address(agent)), amount: BigInt(units), decimals: 6 });
}

/**
 * Build a v0 transaction. `feePayer`: a real KeyPairSigner (it signs: a merchant's or Crossmint's partial signature) or an
 * address string (nobody signs: the agent will). Returns { wire (base64), keys (static account order) }.
 */
export async function buildTx({ feePayer, instructions }) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => (typeof feePayer === "string" ? setTransactionMessageFeePayer(address(feePayer), m) : setTransactionMessageFeePayerSigner(feePayer, m)),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = typeof feePayer === "string" ? compileTransaction(message) : await partiallySignTransactionMessageWithSigners(message);
  const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts.map(String);
  return { wire: getBase64EncodedWireTransaction(tx), keys, tx };
}

/** 165 bytes of a classic SPL token account. */
export function tokenAccountData(mint, owner, { delegate = null, amount = 0n } = {}) {
  const enc = getAddressEncoder();
  const b = Buffer.alloc(165);
  Buffer.from(enc.encode(address(mint))).copy(b, 0);
  Buffer.from(enc.encode(address(owner))).copy(b, 32);
  b.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) {
    b.writeUInt32LE(1, 72);
    Buffer.from(enc.encode(address(delegate))).copy(b, 76);
  }
  b[108] = 1; // initialized
  return b.toString("base64");
}

const send = (value) => ({ send: async () => value });

/**
 * A fake RPC. `sim(keys)` returns the simulation value for the transaction's static keys. Records what it was asked.
 * isBlockhashValid answers `blockhashValid`; sendTransaction / getSignatureStatuses confirm at once.
 */
export function fakeRpc({ sim, blockhashValid = true, recipientOwner = null } = {}) {
  const calls = [];
  return {
    calls,
    simulateTransaction: (wire, cfg) => (calls.push({ m: "simulate", wire, cfg }), send({ value: sim(wire, cfg) })),
    isBlockhashValid: () => send({ value: blockhashValid }),
    getLatestBlockhash: () => send({ value: BLOCKHASH }),
    getAccountInfo: () => send({ value: recipientOwner ? { owner: recipientOwner } : null }),
    sendTransaction: (wire) => (calls.push({ m: "send", wire }), send("sig")),
    getSignatureStatuses: () => send({ value: [{ confirmationStatus: "confirmed", err: null }] }),
  };
}

/**
 * A simulation answer for a USDC payment: the agent's USDC goes from `pre` to `pre - out`, the merchant's from 0 to `out`;
 * the agent pays `fee` lamports. Other token balance changes can be added with `extra` ({ pre, post } token balance rows).
 */
export function usdcSim({ keys, agent, agentAta, merchant, merchantAta, out, pre = 100_000_000n, fee = 5000n, lamports = 1_000_000_000n, delegate = null, extra = { pre: [], post: [] } }) {
  const n = keys.length;
  const preBalances = Array(n).fill(2_039_280);
  const postBalances = [...preBalances];
  const ai = keys.indexOf(agent);
  if (ai >= 0) {
    preBalances[ai] = Number(lamports);
    postBalances[ai] = Number(lamports - fee);
  }
  const tok = (i, owner, amount) => ({ accountIndex: i, mint: USDC_MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const a = keys.indexOf(agentAta);
  const m = keys.indexOf(merchantAta);
  return {
    err: null,
    preBalances,
    postBalances,
    preTokenBalances: [tok(a, agent, pre), tok(m, merchant, 0n), ...extra.pre],
    postTokenBalances: [tok(a, agent, pre - BigInt(out)), tok(m, merchant, BigInt(out)), ...extra.post],
    accounts: [
      { owner: "11111111111111111111111111111111", lamports: Number(lamports - fee), data: ["", "base64"], executable: false, space: 0 },
      { owner: TOKEN_PROGRAM_ADDRESS, lamports: 2_039_280, data: [tokenAccountData(USDC_MINT, agent, { delegate, amount: pre - BigInt(out) }), "base64"], executable: false, space: 165 },
    ],
  };
}

export { AccountRole };
