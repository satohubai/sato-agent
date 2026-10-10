// Paying a checkout someone hands the agent, and the `buy` router.
//
//   Solana Pay transfer request   solana:<recipient>?amount=&spl-token=&reference=&label=&message=&memo=
//                                 (https://docs.solanapay.com/spec). USDC or native SOL only. The kit builds
//                                 the transfer itself: TransferChecked (USDC) or a System transfer (SOL), each
//                                 `reference` appended as a read-only, non-signer key, and the memo as an SPL
//                                 Memo instruction placed right before the transfer.
//   Solana Pay transaction request solana:<https link>. GET the label, POST { account }, and treat the returned
//                                 transaction as untrusted (src/purchase-solana.js): allowed programs only, the
//                                 agent as fee payer and the only signature added, simulated balance changes, the
//                                 cost the owner approves is the cost the simulation showed.
//   EIP-681                       ethereum:<USDC>@8453/transfer?address=<to>&uint256=<n>. USDC on Base only; paid
//                                 for the exact amount through the kit's `send` path, with its checks.
//   Coinbase Business checkout    its `x402_url` is an x402 resource: `pay`.
//   Stripe deposit address        an address plus an exact amount: that is `send --amount <exact>`.
//
// A checkout is a purchase: the owner's purchase setting (ask, unless set to auto) and every limit apply.

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress as isSolanaAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { isAddress as isEvmAddress, getAddress } from "viem";
import { loadPolicy } from "./policy.js";
import { release, reserve } from "./ledger.js";
import { Refused } from "./errors.js";
import { addresses, solanaSecret } from "./wallet.js";
import { roundUsd, usdcUnits, unitsToUsd } from "./amount.js";
import { clean } from "./text.js";
import { USER_AGENT } from "./version.js";
import { USDC_BASE } from "./base.js";
import { USDC_MINT, assertWalletRecipient, broadcastAndConfirm, rpc as solanaRpc } from "./solana.js";
import { oraclePrice, PriceUnavailable } from "./price.js";
import { looksLikeAmazon } from "./commerce.js";
import { checkLimits, refuse } from "./purchase.js";
import { MEMO_PROGRAM, SYSTEM_PROGRAM, blockhashValid, decodeWire, inspectPurchaseTx, signWithAgent, simulatePurchaseTx } from "./purchase-solana.js";

const HTTP_TIMEOUT_MS = 15_000;
const MAX_REFERENCES = 10;
const MAX_MEMO_BYTES = 200;

// ---------------------------------------------------------------- buy: what was given?

export const BUY_ACCEPTS = [
  "a Solana Pay request (solana:...): a transfer request or a transaction request link",
  "an Ethereum payment link for USDC on Base (ethereum:0x8335...@8453/transfer?address=...&uint256=...)",
  "an Amazon US product link (amazon.com/.../dp/<ASIN>) or an ASIN",
  "an x402 link, including a Coinbase Business checkout's x402_url",
];

/**
 * What `buy` was given, and where it goes. Changes nothing. { route: "checkout" | "order" | "pay" | null, kind }.
 * Gift cards are bought by name (`giftcard search` / `giftcard buy`), not through `buy`.
 */
export function classifyBuy(input) {
  const s = String(input ?? "").trim();
  if (/^solana:/i.test(s)) {
    const rest = s.slice(7);
    return { route: "checkout", kind: /^https?(:|%3a)/i.test(rest) ? "solana-pay-transaction" : "solana-pay-transfer" };
  }
  if (/^ethereum:/i.test(s)) return { route: "checkout", kind: "eip681" };
  if (looksLikeAmazon(s)) return { route: "order", kind: "amazon" };
  if (/^https:\/\/[^\s]+$/i.test(s)) return { route: "pay", kind: "x402" };
  return { route: null, kind: null };
}

// ---------------------------------------------------------------- Solana Pay: parse

/** The query string of a payment URI, decoded by RFC 3986 rules ("+" stays "+"). Repeated keys are kept in order. */
function queryPairs(q) {
  const out = [];
  for (const part of String(q ?? "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? "" : part.slice(i + 1);
    try {
      out.push([decodeURIComponent(k), decodeURIComponent(v)]);
    } catch {
      throw new Error(`the payment request has a badly encoded parameter (${clean(part, 60)})`);
    }
  }
  return out;
}

const SINGLE = ["amount", "spl-token", "label", "message", "memo"];

/** Parse a Solana Pay URI. Returns { type: "transfer", ... } or { type: "transaction", link }. Throws on anything malformed. */
export function parseSolanaPay(uri) {
  const s = String(uri ?? "").trim();
  if (!/^solana:/i.test(s)) throw new Error("not a Solana Pay request (it starts with solana:)");
  const rest = s.slice(7);
  if (/^https?(:|%3a)/i.test(rest)) {
    let link = rest;
    if (/^https?%3a/i.test(rest)) {
      try {
        link = decodeURIComponent(rest);
      } catch {
        throw new Error("the transaction request link is badly encoded");
      }
    }
    let u;
    try {
      u = new URL(link);
    } catch {
      throw new Error("the transaction request link is not a URL");
    }
    if (u.protocol !== "https:") throw refuse("checkout_not_https", "a Solana Pay transaction request must use an https link; nothing was fetched");
    if (u.username || u.password) throw refuse("checkout_not_https", "the transaction request link carries a user name or password; nothing was fetched");
    return { type: "transaction", link: u.toString() };
  }
  const q = rest.indexOf("?");
  const recipient = q < 0 ? rest : rest.slice(0, q);
  if (!isSolanaAddress(recipient)) throw new Error("the Solana Pay request's recipient is not a Solana address");
  const pairs = queryPairs(q < 0 ? "" : rest.slice(q + 1));
  const one = {};
  const references = [];
  for (const [k, v] of pairs) {
    if (k === "reference") references.push(v);
    else if (SINGLE.includes(k)) {
      if (k in one) throw new Error(`the Solana Pay request gives ${k} twice`);
      one[k] = v;
    }
  }
  if (references.length > MAX_REFERENCES) throw new Error(`the Solana Pay request has more than ${MAX_REFERENCES} references`);
  for (const ref of references) if (!isSolanaAddress(ref)) throw new Error(`the reference ${clean(ref, 60)} is not a Solana address`);
  if (new Set(references).size !== references.length) throw new Error("the Solana Pay request repeats a reference");
  let token;
  if (one["spl-token"] === undefined) token = "SOL";
  else if (one["spl-token"] === USDC_MINT) token = "USDC";
  else throw refuse("checkout_token", `the request asks to be paid in the token ${clean(one["spl-token"], 60)}; this kit pays Solana Pay requests in USDC or SOL only`, ["USDC", "SOL"], clean(one["spl-token"], 60));
  if (one.amount === undefined) throw new Error("the Solana Pay request has no amount; ask the merchant for a request with the amount in it");
  const decimals = token === "USDC" ? 6 : 9;
  // User units, a plain decimal: no exponent, no sign, no more decimals than the token has.
  const m = /^(\d+)(?:\.(\d+))?$/.exec(one.amount);
  if (!m) throw new Error(`the amount "${clean(one.amount, 30)}" is not a plain decimal number (no scientific notation)`);
  if ((m[2] ?? "").length > decimals) throw new Error(`the amount ${clean(one.amount, 30)} has more than ${decimals} decimals, more than ${token} has`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error("the Solana Pay request's amount is zero");
  const memo = one.memo;
  if (memo !== undefined && Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES) throw new Error(`the memo is longer than ${MAX_MEMO_BYTES} bytes`);
  return {
    type: "transfer",
    recipient,
    token,
    amount: one.amount,
    units,
    references,
    label: one.label === undefined ? null : clean(one.label, 80),
    message: one.message === undefined ? null : clean(one.message, 200),
    memo: memo ?? null,
  };
}

// ---------------------------------------------------------------- Solana Pay: transfer request

const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

/**
 * The instructions for a transfer request, in the order the spec gives: (USDC only) create the recipient's USDC account
 * if it is missing, then the memo (when there is one) right before the transfer, then the transfer with every reference
 * appended as a read-only, non-signer key.
 */
export async function solanaPayInstructions(req, signer) {
  const refs = req.references.map((r) => ({ address: address(r), role: AccountRole.READONLY }));
  const memo = req.memo === null || req.memo === undefined ? [] : [{ programAddress: address(MEMO_PROGRAM), accounts: [], data: new TextEncoder().encode(req.memo) }];
  if (req.token === "USDC") {
    const mint = address(USDC_MINT);
    const owner = address(req.recipient);
    const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [destination] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const transfer = getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: req.units, decimals: 6 });
    return [
      getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner, mint }),
      ...memo,
      { ...transfer, accounts: [...transfer.accounts, ...refs] },
    ];
  }
  const transfer = {
    programAddress: address(SYSTEM_PROGRAM),
    accounts: [{ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer }, { address: address(req.recipient), role: AccountRole.WRITABLE }, ...refs],
    data: new Uint8Array([...u32le(2), ...u64le(req.units)]),
  };
  return [...memo, transfer];
}

async function buildTransfer(req, signer, blockhash) {
  const instructions = await solanaPayInstructions(req, signer);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}

async function solUsd(lamports, deps) {
  try {
    const p = await (deps.oraclePrice ?? oraclePrice)("SOL");
    return roundUsd((Number(lamports) / 1e9) * p.usd);
  } catch (err) {
    if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent SOL price right now (${clean(err.message, 120)}), so this payment cannot be held to the USD limits; nothing was paid`);
    throw err;
  }
}

const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });

/**
 * Get a transfer request ready to pay: the recipient checked, its USD size, the card, the approval intent, and
 * execute() / dryRun(). deps: rpc, signer, oraclePrice, broadcast.
 */
export async function prepareSolanaPayTransfer(req, deps = {}) {
  const r = deps.rpc ?? solanaRpc();
  checkLimits({ usd: undefined, chain: "solana" });
  await assertWalletRecipient(req.recipient, r); // never a token account: a payment sent to one is lost
  const usd = req.token === "USDC" ? unitsToUsd(usdcUnits(req.amount)) : await solUsd(req.units, deps);
  checkLimits({ usd, chain: "solana", to: req.recipient });
  const card = [
    `Solana Pay: pay ${req.amount} ${req.token} on Solana to ${req.recipient}${req.label ? ` (${req.label})` : ""}${req.token === "SOL" ? `, about $${usd}` : ""}`,
    ...(req.message ? [`Merchant's message: ${req.message}`] : []),
    ...(req.memo ? [`Memo written with the payment: ${clean(req.memo, 200)}`] : []),
    ...(req.references.length ? [`Order reference${req.references.length > 1 ? "s" : ""}: ${req.references.join(", ")}`] : []),
  ];
  const intent = { cmd: "checkout", kind: "solana-pay-transfer", chain: "solana", to: req.recipient, token: req.token, amount: req.amount, references: req.references, memo: req.memo };
  const signerOf = async () => deps.signer ?? (await createKeyPairSignerFromBytes(solanaSecret()));
  const buildAndSimulate = async () => {
    const signer = await signerOf();
    const { value: blockhash } = await withTimeout(r.getLatestBlockhash({ commitment: "confirmed" }).send());
    const built = await buildTransfer(req, signer, blockhash);
    const sim = await withTimeout(r.simulateTransaction(built.wire, { encoding: "base64", commitment: "confirmed" }).send());
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200)}`);
    return built;
  };
  return {
    usd,
    card,
    intent,
    checkArgs: { address: req.recipient, chain: "Solana", from: addresses().solana },
    dryRun: async () => {
      await buildAndSimulate();
      return { dry_run: true, chain: "solana", usd, to: req.recipient, simulated: true };
    },
    execute: async () => {
      const entry = await reserve(deps.policy ?? loadPolicy(), { kind: "checkout", chain: "solana", asset: req.token, usd, to: req.recipient, amount: req.amount, references: req.references, checkout: "solana_pay", request: "transfer" });
      let built;
      try {
        built = await buildAndSimulate();
      } catch (err) {
        release(entry, "failed before broadcast; nothing sent", { error: clean(err.message, 300) });
        throw err;
      }
      const res = await broadcastAndConfirm(entry, built, r, deps.broadcast ?? {});
      return { ...res, usd, to: req.recipient, amount: req.amount, token: req.token };
    },
  };
}

// ---------------------------------------------------------------- Solana Pay: transaction request

async function merchantFetch(link, init, d) {
  let res;
  try {
    res = await d.fetchImpl(link, { ...init, redirect: "error", headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`the merchant's link did not answer (${err.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : clean(err.message, 120)}); nothing was paid`);
  }
  let json = null;
  try {
    const text = await res.text();
    if (text.length <= 64 * 1024) json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Get a transaction request ready: GET the label, POST the agent's account, then check and simulate what came back.
 * deps: fetchImpl, rpc, signer, oraclePrice, broadcast.
 */
export async function prepareSolanaPayTransaction(link, deps = {}) {
  const d = { fetchImpl: globalThis.fetch, ...deps };
  const r = d.rpc ?? solanaRpc();
  checkLimits({ usd: undefined, chain: "solana" });
  const agent = addresses().solana;
  const host = new URL(link).host;
  const g = await merchantFetch(link, { method: "GET" }, d);
  const label = g.status === 200 && typeof g.json?.label === "string" ? clean(g.json.label, 80) : null;
  const p = await merchantFetch(link, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: agent }) }, d);
  if (p.status !== 200 || typeof p.json?.transaction !== "string") throw new Error(`the merchant's link did not return a transaction (HTTP ${p.status}); nothing was paid`);
  const message = typeof p.json.message === "string" ? clean(p.json.message, 200) : null;
  let tx;
  try {
    tx = decodeWire(p.json.transaction, "base64");
  } catch (err) {
    throw refuse("purchase_tx.decode", `the merchant's transaction could not be decoded (${clean(err.message, 120)}); nothing was signed`);
  }
  const facts = await inspectPurchaseTx(tx, { agent, allowSystem: true, requireAgentFeePayer: true }, { rpc: r });
  const sim = await simulatePurchaseTx(tx, facts, { agent }, { rpc: r });
  if (sim.usdc_out <= 0n && sim.lamports_out <= 0n) throw refuse("checkout_no_payment", "in simulation the merchant's transaction pays nothing from this wallet; nothing was signed");
  const usd = roundUsd(unitsToUsd(sim.usdc_out) + (sim.lamports_out > 0n ? await solUsd(sim.lamports_out, d) : 0));
  const payees = [...sim.payees, ...facts.system_payees.filter((x) => !sim.payees.includes(x))];
  checkLimits({ usd, chain: "solana", to: payees[0], payees });
  const sol = (l) => (Number(l) / 1e9).toString();
  const cost = [sim.usdc_out > 0n ? `${unitsToUsd(sim.usdc_out)} USDC` : null, sim.lamports_out > 0n ? `${sol(sim.lamports_out)} SOL` : null].filter(Boolean).join(" + ");
  const card = [
    `Solana Pay request from ${label ? `"${label}" at ` : ""}${host}`,
    ...(message ? [`Merchant's message: ${message}`] : []),
    `Simulated cost: ${cost} (about $${usd}), plus a network fee of ${sol(sim.network_fee)} SOL. The transaction was built by the merchant and checked by this kit (allowed programs only, simulated).`,
    `Paid to: ${payees.length ? payees.join(", ") : "(no recipient seen in the simulation)"}.`,
  ];
  // The owner approves this exact cost, paid to these payees. A new request that costs anything else, or pays someone
  // else, is a new approval.
  const intent = { cmd: "checkout", kind: "solana-pay-transaction", chain: "solana", link, label, usdc_units: sim.usdc_out.toString(), lamports: sim.lamports_out.toString(), payees: [...payees].sort() };
  return {
    usd,
    card,
    intent,
    simulated: sim.simulated,
    checkArgs: null,
    dryRun: async () => ({ dry_run: true, chain: "solana", usd, label, link, simulated: sim.simulated }),
    execute: async () => {
      const entry = await reserve(d.policy ?? loadPolicy(), { kind: "checkout", chain: "solana", asset: sim.usdc_out > 0n ? "USDC" : "SOL", usd, to: payees[0] ?? host, checkout: "solana_pay", request: "transaction", merchant: host });
      let built;
      try {
        if (!(await blockhashValid(facts.blockhash, r))) throw refuse("checkout_expired", "the merchant's transaction expired before it was signed; ask for the payment again (nothing was signed)");
        built = await signWithAgent(tx, d.signer);
      } catch (err) {
        release(entry, "failed before signing; nothing sent", { error: clean(err.message, 300) });
        throw err;
      }
      const res = await broadcastAndConfirm(entry, built, r, d.broadcast ?? {});
      return { ...res, usd, label, merchant: host };
    },
  };
}

// ---------------------------------------------------------------- EIP-681 (USDC on Base)

/** An EIP-681 `uint256` value: digits, or a decimal with an exponent ("1.5e6") that comes out whole. */
function uintOf(v) {
  if (/^\d+$/.test(v)) return BigInt(v);
  const m = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(v);
  if (!m) return null;
  const frac = m[2] ?? "";
  const exp = Number(m[3]);
  if (exp > 30 || frac.length > exp) return null;
  return BigInt(m[1] + frac) * 10n ** BigInt(exp - frac.length);
}

/**
 * Parse an EIP-681 payment link. Only `ethereum:<USDC on Base>@8453/transfer?address=<to>&uint256=<atomic>` is accepted.
 * Returns { chain: "base", to, units, amount } (amount: the USDC amount as a decimal string). Throws Refused / Error.
 */
export function parseEip681(uri) {
  const s = String(uri ?? "").trim();
  const m = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([A-Za-z0-9_]+))?(?:\?(.*))?$/i.exec(s);
  if (!m) throw new Error("not an EIP-681 payment link this kit can read (ethereum:<token>@8453/transfer?address=...&uint256=...)");
  const [, target, chainId, fn, query] = m;
  if (target.toLowerCase() !== USDC_BASE.toLowerCase()) throw refuse("checkout_token", "this link asks for a payment other than USDC on Base; the kit pays EIP-681 links in USDC on Base only", USDC_BASE, target);
  if (chainId === undefined) throw refuse("checkout_chain", "this link names no chain, which means Ethereum mainnet; the kit pays on Base (chain 8453) only", 8453, "1");
  if (chainId !== "8453") throw refuse("checkout_chain", `this link is for chain ${chainId}; the kit pays on Base (chain 8453) only`, 8453, Number(chainId));
  if (fn !== "transfer") throw refuse("checkout_function", `this link calls ${clean(fn ?? "nothing", 40)}; the kit pays only a USDC transfer`);
  const params = {};
  for (const [k, v] of queryPairs(query ?? "")) {
    if (["gas", "gasLimit", "gasPrice"].includes(k)) continue; // the kit sets its own
    if (!["address", "uint256"].includes(k)) throw new Error(`the link has a parameter this kit does not pay with (${clean(k, 30)})`);
    if (k in params) throw new Error(`the link gives ${k} twice`);
    params[k] = v;
  }
  if (!params.address || !isEvmAddress(params.address, { strict: false })) throw new Error("the link names no valid recipient address");
  // A mixed-case address carries an EIP-55 checksum, and it must be right: a typo in it is caught, not paid.
  // All lower-case and all upper-case carry no checksum and are taken as written.
  const hex = params.address.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && getAddress(params.address) !== params.address) {
    throw refuse("checkout_checksum", "the link's recipient address has a wrong checksum (mixed upper and lower case that does not match): it may have been mistyped or altered; nothing was paid");
  }
  const units = params.uint256 === undefined ? null : uintOf(params.uint256);
  if (units === null || units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("the link's amount (uint256) is not a positive whole number of USDC units");
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return { chain: "base", to: getAddress(params.address), units, amount: frac ? `${whole}.${frac}` : whole.toString() };
}
