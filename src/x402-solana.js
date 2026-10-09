// x402 on Solana: what the agent accepts, and what it checks in the transaction
// it just signed, before that transaction is sent anywhere.
//
// The "exact" Solana scheme works like this: the server names a fee payer (the
// facilitator) in the requirements. The agent builds a transaction with FOUR
// instructions (compute-unit limit, compute-unit price, one USDC
// TransferChecked from its own token account to the recipient's, and a memo),
// signs it as the token owner only, and sends it to the server. The fee payer's
// signature is missing until the facilitator adds it and broadcasts. So the
// agent pays no SOL, and the ONLY thing its signature can move is that one USDC
// transfer. That is why this file checks the signed bytes, not the requirements:
// anything beyond those four instructions, or a different amount, recipient or
// mint, is refused before it leaves this computer.
//
// A Solana transaction does not carry an expiry time; it carries a recent
// blockhash, which the network accepts for at most 150 blocks (about a minute).
// There is no way to make it last longer, except a durable-nonce transaction,
// which needs an advance-nonce instruction. The four-instruction rule rules that
// out. The agent also asks its RPC whether the blockhash is still valid, and
// refuses a server-supplied "last valid block height" that claims a longer life.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import {
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { rpc as defaultRpc, USDC_MINT } from "./solana.js";
import { solanaSecret } from "./wallet.js";
import { clean } from "./text.js";

export const SOLANA_NETWORK = SOLANA_MAINNET_CAIP2; // solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
export { USDC_MINT };

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MAX_MEMO_BYTES = 256;
// The network accepts a blockhash for 150 blocks; one more for the block it is read in.
export const MAX_BLOCKHASH_LIFETIME_BLOCKS = 151;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const isSolanaUsdc = (req) => req.network === SOLANA_NETWORK && req.asset === USDC_MINT;

/** Checks on the requirements alone, before anything is reserved or signed. Returns refusals. */
export function preSignRefusals(req, owner) {
  const out = [];
  const feePayer = req.extra?.feePayer;
  if (typeof feePayer !== "string" || !isAddress(feePayer)) {
    out.push({ rule: "fee_payer", limit: "a Solana address", observed: feePayer ?? null, message: "the server named no valid fee payer (extra.feePayer) for this Solana payment" });
  } else if (feePayer === owner) {
    out.push({ rule: "fee_payer", limit: "not this agent's own wallet", observed: feePayer, message: "the server named this agent's own wallet as the fee payer; the facilitator pays fees, never the agent" });
  }
  if (typeof req.payTo !== "string" || !isAddress(req.payTo)) {
    out.push({ rule: "pay_to", limit: "a Solana address", observed: req.payTo ?? null, message: "the recipient is not a valid Solana address" });
  }
  return out;
}

/** The Solana side of `pay`: the agent's signer, and the x402 scheme that builds the transaction. */
export async function solanaSigner(secret = solanaSecret()) {
  return createKeyPairSignerFromBytes(secret);
}

/** How long one Solana RPC step may take before the payment is given up. */
export const RPC_TIMEOUT_MS = 20_000;

/** `p`, or a rejection after `ms`. The timer never keeps the process alive. */
export function withTimeout(p, ms = RPC_TIMEOUT_MS, what = "Solana RPC") {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * The x402 scheme builds the transaction with its own RPC (mint lookup,
 * blockhash), which this kit cannot hand a timeout to. So the whole build is
 * bounded: a hung RPC aborts the payment before anything is signed and sent.
 */
export function bounded(inner, ms = RPC_TIMEOUT_MS) {
  return {
    scheme: inner.scheme,
    findDefaultAsset: inner.findDefaultAsset?.bind(inner),
    createPaymentPayload: (...args) => withTimeout(inner.createPaymentPayload(...args), ms, "building the Solana payment (RPC)"),
  };
}

export function solanaScheme(signer, { rpcUrl = process.env.SATO_AGENT_SOLANA_RPC || undefined, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  return bounded(new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined), timeoutMs);
}

/** The same, for x402 v1 servers (network "solana", amount in `maxAmountRequired`). */
export function solanaSchemeV1(signer, { rpcUrl = process.env.SATO_AGENT_SOLANA_RPC || undefined, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  return bounded(new ExactSvmSchemeV1(signer, rpcUrl ? { rpcUrl } : undefined), timeoutMs);
}

const u64le =(bytes, at) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readBigUInt64LE(at);

function verifyEd25519(owner, message, signature) {
  try {
    const raw = Buffer.from(getBase58Encoder().encode(owner));
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Decode the transaction the agent signed and compare it with what was reserved.
 * Pure and offline. Returns { problems, info }: no problems means the signed
 * bytes are exactly one USDC TransferChecked of `units` from this wallet's USDC
 * account to the recipient's, with the server's fee payer and nothing else.
 */
export async function inspectSignedTransaction(transactionB64, { req, owner, units }) {
  const problems = [];
  let tx;
  let msg;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(transactionB64));
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return { problems: ["the signed transaction could not be decoded"], info: null };
  }

  const accounts = msg.staticAccounts ?? [];
  if (msg.version !== 0) problems.push(`transaction version is ${msg.version}, expected 0`);
  if ((msg.addressTableLookups?.length ?? 0) !== 0) problems.push("transaction uses address lookup tables");
  if (msg.header.numSignerAccounts !== 2) problems.push(`transaction needs ${msg.header.numSignerAccounts} signatures, expected 2 (fee payer + this wallet)`);
  if (accounts[0] !== req.extra?.feePayer) problems.push(`fee payer is ${accounts[0]}, not the one the server named`);
  if (accounts[0] === owner) problems.push("this wallet is the fee payer");
  if (accounts[1] !== owner) problems.push("the second signer is not this wallet");

  const ours = tx.signatures?.[owner];
  if (!ours) problems.push("this wallet's signature is missing");
  else if (!verifyEd25519(owner, tx.messageBytes, ours)) problems.push("this wallet's signature does not verify");

  const ixs = msg.instructions ?? [];
  const program = (ix) => accounts[ix.programAddressIndex];
  const acct = (ix) => (ix.accountIndices ?? []).map((i) => accounts[i]);
  if (ixs.length !== 4) problems.push(`transaction has ${ixs.length} instructions, expected 4 (compute limit, compute price, USDC transfer, memo)`);
  else {
    const [limit, price, transfer, memo] = ixs;
    if (program(limit) !== COMPUTE_BUDGET_PROGRAM || acct(limit).length !== 0 || limit.data?.length !== 5 || limit.data[0] !== 2) problems.push("instruction 1 is not a compute-unit limit");
    if (program(price) !== COMPUTE_BUDGET_PROGRAM || acct(price).length !== 0 || price.data?.length !== 9 || price.data[0] !== 3) problems.push("instruction 2 is not a compute-unit price");
    if (program(memo) !== MEMO_PROGRAM || acct(memo).length !== 0 || (memo.data?.length ?? 0) > MAX_MEMO_BYTES) problems.push("instruction 4 is not a plain memo");

    if (program(transfer) !== TOKEN_PROGRAM_ADDRESS) problems.push("instruction 3 is not an SPL Token instruction");
    else {
      const a = acct(transfer);
      const d = transfer.data;
      if (a.length !== 4 || d?.length !== 10 || d[0] !== 12) problems.push("instruction 3 is not a TransferChecked");
      else {
        const [source, mint, destination, authority] = a;
        // Derive both token accounts here, independently of the library that built the transaction.
        // (The recipient's token account is derived whether or not it exists yet.)
        let expectedSource, expectedDestination;
        try {
          [expectedSource] = await findAssociatedTokenPda({ owner, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
          [expectedDestination] = await findAssociatedTokenPda({ owner: req.payTo, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        } catch {
          problems.push("could not derive the expected USDC token accounts");
        }
        if (mint !== USDC_MINT) problems.push(`transfer is of mint ${mint}, not USDC`);
        if (authority !== owner) problems.push("the transfer is not authorized by this wallet");
        if (expectedSource && source !== expectedSource) problems.push("the transfer does not come from this wallet's USDC account");
        if (expectedDestination && destination !== expectedDestination) problems.push("the transfer does not go to the recipient's USDC account");
        if (u64le(d, 1) !== units) problems.push(`transfer amount is ${u64le(d, 1)}, reserved ${units}`);
        if (d[9] !== 6) problems.push(`transfer decimals is ${d[9]}, expected 6`);
      }
    }
  }

  const info = {
    payer_signature: ours ? getBase58Decoder().decode(ours) : null,
    message_hash: createHash("sha256").update(tx.messageBytes).digest("hex"),
    fee_payer: accounts[0] ?? null,
    blockhash: msg.lifetimeToken ?? null,
  };
  return { problems, info };
}

/**
 * Ask the RPC whether the signed blockhash is still valid, and bound its life.
 * Returns problems (empty = fine) and adds the block-height ceiling to `info`.
 */
export async function checkLifetime(info, req, r = defaultRpc(), { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const problems = [];
  // Bounded: a hung RPC throws here, which the caller turns into "signed, not sent, stays counted".
  const [valid, height] = await Promise.all([
    withTimeout(r.isBlockhashValid(info.blockhash, { commitment: "confirmed" }).send(), timeoutMs, "isBlockhashValid"),
    withTimeout(r.getBlockHeight({ commitment: "confirmed" }).send(), timeoutMs, "getBlockHeight"),
  ]);
  const now = Number(height);
  const ceiling = now + MAX_BLOCKHASH_LIFETIME_BLOCKS;
  if (!valid.value) problems.push("the transaction's blockhash is not valid on the network (it could not land)");
  const claimed = req.extra?.lastValidBlockHeight;
  if (claimed !== undefined && claimed !== null) {
    const n = Number(claimed);
    if (!Number.isSafeInteger(n) || n > ceiling) problems.push(`the server claims the transaction stays valid until block ${clean(claimed, 40)}; the network allows at most ${ceiling}`);
    else info.last_valid_block_height = n;
  }
  info.last_valid_block_height ??= ceiling; // the latest block the network could accept it in
  return problems;
}
