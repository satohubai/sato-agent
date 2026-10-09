// Pay for an HTTP resource with x402, in USDC, from the agent's wallet: on Base
// or on Solana, whichever chain the owner's policy allows (see resolvePayChain).
//
// The limits apply twice: as an x402 payment policy (only an option inside the
// limits can be chosen), and again right before signing, where the spend is
// reserved under the spend lock.
//
// A SIGNED payment always stays counted. An x402 payment is a signed message
// that the server can settle until it expires, even if it answers 402 again or
// errors. So the agent also refuses authorizations that would stay valid for
// more than MAX_AUTH_WINDOW_S.
//
// On Base the signed message is an EIP-3009 authorization. Only that transfer
// method is accepted (a permit2 offer has no expiry the agent can bound). After
// signing, its amount, recipient, payer and expiry are compared with what was
// reserved; anything else is not sent, STAYS counted, and the command exits 4.
//
// On Solana the signed message is a transaction. Its fee payer is the server's
// facilitator and its lifetime is its recent blockhash (about a minute). After
// signing, the agent decodes that transaction and sends it only if it is exactly
// one USDC transfer of the reserved amount to the recipient (see x402-solana.js).
// If it is not, nothing is sent, the spend STAYS counted, and the command exits 4.
//
// Everything a server sends (amounts, addresses, receipts, error text) is
// checked or cleaned (src/text.js) before it is printed or written to the ledger.

import { wrapFetchWithPayment, x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { isAddress } from "viem";
import { evaluate, loadPolicy } from "./policy.js";
import { record, release, reserve, spentLast24h } from "./ledger.js";
import { Pending, Refused } from "./errors.js";
import { evmAccount } from "./wallet.js";
import { USDC_BASE } from "./base.js";
import { unitsToUsd } from "./amount.js";
import { clean, cleanOrNull } from "./text.js";
import { USER_AGENT } from "./version.js";

export const BASE_NETWORK = "eip155:8453";
export const MAX_AUTH_WINDOW_S = 300;
export const PAY_CHAINS = ["base", "solana"];

// Headers the x402 exchange itself uses (v1 and v2), and our own user-agent: a
// caller's value would break or spoof the payment, so they are refused.
export const RESERVED_HEADERS = ["x-payment", "x-payment-response", "payment-signature", "payment-required", "payment-response", "user-agent"];

const CHAIN_RULES = ["limits_not_set", "chains_not_set", "chain_not_allowed"];

/**
 * The chain a payment is made on. The owner's policy decides (chain binding):
 * an explicit chain must be one the policy allows, and with no chain given the
 * policy's ONE chain is used. A policy that allows both chains needs an explicit
 * chain: a missing flag never picks a chain for the owner. Returns
 * `{ chain, refusals }` (refusals: nothing may be reserved). Throws on a chain
 * name this kit does not know, or a missing chain when two are allowed.
 */
export function resolvePayChain(policy, requested) {
  let chain = requested === undefined || requested === null ? undefined : String(requested).toLowerCase();
  if (chain !== undefined && !PAY_CHAINS.includes(chain)) throw new Error(`pay supports --chain ${PAY_CHAINS.join("|")} (got "${requested}")`);
  if (chain === undefined && policy && Array.isArray(policy.chains)) {
    if (policy.chains.length === 1) chain = policy.chains[0];
    else throw new Error(`this agent may spend on ${policy.chains.join(" and ")}: say which with --chain ${policy.chains.join("|")}`);
  }
  const refusals = evaluate(policy, { usd: 1e-6, chain }, { usd: 0, unreadable: [] }).filter((r) => CHAIN_RULES.includes(r.rule));
  return { chain, refusals };
}

// x402 v1 servers say `maxAmountRequired` (not `amount`) and name networks "base" / "solana".
// Every check below runs on a normalized view, so v1 and v2 pass the SAME guard.
const V1_NETWORKS = { base: BASE_NETWORK, solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };

/** The requirement as the guard sees it: canonical CAIP-2 network, atomic amount, same window/asset/payTo. */
export function view(req, version) {
  const v1 = version === 1;
  return {
    network: v1 ? V1_NETWORKS[req.network] : req.network, // v1: only "base" and "solana" are understood
    asset: req.asset,
    amount: v1 ? req.maxAmountRequired : req.amount,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    payTo: req.payTo,
    extra: req.extra,
    raw: req,
  };
}
// The server's amount is atomic USDC (6 decimals): digits only, positive, and small
// enough to convert to dollars exactly (src/amount.js, the same on both chains).
// Anything else is refused, never rounded or coerced.
const MAX_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const unitsOf = (v) => {
  // No leading zeros: the signed value must be the same string the server sent.
  if (typeof v.amount !== "string" || !/^[1-9][0-9]{0,15}$/.test(v.amount)) throw new Error("amount is not a string of digits");
  const units = BigInt(v.amount);
  if (units <= 0n || units > MAX_UNITS) throw new Error("amount is not a positive USDC amount");
  return units;
};
const usdOf = (v) => unitsToUsd(unitsOf(v));
const isBaseUsdc = (v) => v.network === BASE_NETWORK && String(v.asset).toLowerCase() === USDC_BASE.toLowerCase();

// A settlement receipt names a transaction only in that chain's own form.
const TX_ID = { base: /^0x[0-9a-fA-F]{64}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/ };
export const validTxId = (chainName, tx) => (typeof tx === "string" && TX_ID[chainName]?.test(tx) ? tx : null);

/** The receipt as stored and printed: only checked or cleaned fields, never the raw header. */
function settlementView(raw, chainName) {
  if (!raw || typeof raw !== "object") return { success: false, transaction: null, note: "the payment receipt header could not be read" };
  const transaction = validTxId(chainName, raw.transaction);
  return {
    success: raw.success === true,
    transaction,
    network: cleanOrNull(raw.network, 80),
    payer: cleanOrNull(raw.payer, 100),
    ...(raw.transaction !== undefined && raw.transaction !== null && !transaction ? { note: "the receipt's transaction id is not in this chain's form; not shown" } : {}),
  };
}

/** Refusals carry server text in `observed`: keep it short and on one line. */
const cleanObserved = (o) => (typeof o === "string" ? clean(o, 120) : o && typeof o === "object" && !Array.isArray(o) ? clean(JSON.stringify(o), 120) : o);
const cleanRefusals = (list) => list.map((r) => ({ ...r, observed: cleanObserved(r.observed), message: clean(r.message, 400) }));

/** The signed payload was built but is not what was approved. It is NOT sent and NOT released. */
class SignedPayloadRejected extends Error {
  constructor(problems) {
    super(`signed payment did not match what was approved: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Base checks on the requirements alone, before anything is reserved or signed. Returns refusals. */
function basePreSign(v) {
  const out = [];
  // @x402/evm signs a permit2 offer through a payload with no validBefore: it could
  // not be bounded, and would be signed and then counted for nothing. EIP-3009 only.
  const method = v.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") {
    out.push({ rule: "transfer_method", limit: "eip3009", observed: method, message: "the server asks for a transfer method other than an EIP-3009 authorization; this kit signs EIP-3009 authorizations and nothing else" });
  }
  if (typeof v.payTo !== "string" || !isAddress(v.payTo)) {
    out.push({ rule: "pay_to", limit: "a Base address", observed: v.payTo ?? null, message: "the recipient is not a valid Base address" });
  }
  return out;
}

const baseChain = (account, scheme) => ({
  name: "base",
  scheme: scheme ?? new ExactEvmScheme(account),
  schemeV1: scheme ?? new ExactEvmSchemeV1(account),
  v1Network: "base",
  networkPattern: BASE_NETWORK,
  walletUrl: `https://basescan.org/address/${account.address}`,
  asset: USDC_BASE,
  accepts: isBaseUsdc,
  limit: `USDC on ${BASE_NETWORK}`,
  refusal: "only USDC on Base is paid on this chain (use --chain solana to pay on Solana)",
  signedThing: "authorization",
  preSign: basePreSign,
  txUrl: (hash) => `https://basescan.org/tx/${hash}`,
  // Belt and braces: check what was actually signed, before it is sent anywhere.
  async afterSign({ paymentPayload, selectedRequirements }, { units, version }, seen) {
    const req = view(selectedRequirements, version);
    const auth = paymentPayload?.payload?.authorization;
    const problems = [];
    const validBefore = Number(auth?.validBefore);
    const left = validBefore - Date.now() / 1000;
    if (!Number.isFinite(validBefore) || left > MAX_AUTH_WINDOW_S + 30) {
      seen.push({ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: Number.isFinite(left) ? Math.round(left) : "unknown", message: "the signed authorization would stay valid too long (or its expiry could not be read); it was not sent" });
      problems.push(`the signed authorization would stay valid ${Number.isFinite(left) ? `${Math.round(left)} s` : "for an unknown time"} (limit ${MAX_AUTH_WINDOW_S} s)`);
    }
    if (units === null || String(auth?.value) !== units.toString()) problems.push(`the signed authorization is for ${clean(auth?.value ?? "an unknown amount", 40)} atomic units, reserved ${units}`);
    if (typeof auth?.to !== "string" || auth.to.toLowerCase() !== String(req.payTo).toLowerCase()) problems.push("the signed authorization does not pay the recipient that was reserved");
    if (typeof auth?.from !== "string" || auth.from.toLowerCase() !== account.address.toLowerCase()) problems.push("the signed authorization is not from this wallet");
    // Signed, so it stays counted (never released), exactly like a rejected Solana payload.
    if (problems.length) throw new SignedPayloadRejected(problems);
    return {};
  },
});

async function solanaChain({ signer, scheme, rpc, rpcTimeoutMs }) {
  const sol = await import("./x402-solana.js");
  const s = signer ?? (await sol.solanaSigner());
  const owner = s.address;
  return {
    name: "solana",
    // A hung RPC while the scheme builds the transaction aborts the payment (nothing sent, released).
    scheme: scheme ?? sol.solanaScheme(s, rpcTimeoutMs ? { timeoutMs: rpcTimeoutMs } : {}),
    schemeV1: scheme ?? sol.solanaSchemeV1(s, rpcTimeoutMs ? { timeoutMs: rpcTimeoutMs } : {}),
    v1Network: "solana",
    networkPattern: sol.SOLANA_NETWORK,
    asset: sol.USDC_MINT,
    owner,
    accepts: sol.isSolanaUsdc,
    limit: `USDC (${sol.USDC_MINT}) on ${sol.SOLANA_NETWORK}`,
    refusal: "only USDC on Solana mainnet is paid on this chain (use --chain base to pay on Base)",
    signedThing: "transaction",
    preSign: (v) => sol.preSignRefusals(v, owner),
    txUrl: (sig) => `https://solscan.io/tx/${sig}`,
    walletUrl: `https://solscan.io/account/${owner}`,
    // Decode the transaction that was just signed and compare it with what was reserved.
    async afterSign({ paymentPayload, selectedRequirements }, { units, version }) {
      const req = view(selectedRequirements, version);
      // From here on something is signed: ANY failure means "do not send, keep counted".
      let problems;
      let info = null;
      try {
        ({ problems, info } = await sol.inspectSignedTransaction(paymentPayload?.payload?.transaction, { req, owner, units }));
        if (info && !problems.length) {
          try {
            // Bounded: a hung RPC here ends as "signed, not sent, stays counted" (Pending, exit 4).
            problems.push(...(await sol.checkLifetime(info, req, rpc, rpcTimeoutMs ? { timeoutMs: rpcTimeoutMs } : {})));
          } catch (err) {
            problems.push(`could not check the transaction's blockhash (${err.message})`);
          }
        }
      } catch (err) {
        problems = [`could not check the signed transaction (${err.message})`];
      }
      if (problems.length) throw Object.assign(new SignedPayloadRejected(problems.map((p) => clean(p, 300))), { info });
      return info;
    },
  };
}

/**
 * The terms the owner approved, when a price was quoted first (see quoteX402):
 * `maxUsd` is the price the owner saw, `payTo` the payee they saw. A server that
 * asks for more, or names someone else, at pay time is refused before anything
 * is reserved or signed. Undefined = no binding (a call that was never quoted).
 */
function boundTerms({ maxUsd, payTo } = {}) {
  if (maxUsd === undefined) return null;
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || !(maxUsd > 0)) throw new Error("maxUsd must be a positive number of dollars");
  return { maxUsd, maxUnits: BigInt(Math.round(maxUsd * 1e6)), payTo };
}
const samePayee = (a, b) => (String(b).startsWith("0x") ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

// The one guard. `pay` runs it on every offer and again right before reserving;
// `quoteX402` runs it on every offer before anything is asked of the owner, so
// what is quoted can never drift from what would be paid.
function check(policy, raw, chain, version, bound = null) {
  const req = view(raw, version);
  // x402 only pairs an offer with a signer by scheme name; this kit has "exact".
  if (req.raw?.scheme !== "exact") {
    return [{ rule: "scheme", limit: "exact", observed: req.raw?.scheme ?? null, message: "the server asks for a payment scheme other than \"exact\"; this kit signs \"exact\" payments and nothing else" }];
  }
  if (!chain.accepts(req)) {
    return [{ rule: "asset", limit: chain.limit, observed: `${raw.asset} on ${raw.network}`, message: chain.refusal }];
  }
  // Must be a real integer: the signing code computes `now + maxTimeoutSeconds`,
  // and a string "300" would concatenate into an authorization valid for millennia.
  const w = req.maxTimeoutSeconds;
  if (!(typeof w === "number" && Number.isInteger(w) && w > 0 && w <= MAX_AUTH_WINDOW_S)) {
    return [{ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: req.maxTimeoutSeconds, message: `the server asks for a payment authorization valid for ${clean(JSON.stringify(req.maxTimeoutSeconds) ?? "an unknown time", 40)}s; the limit is ${MAX_AUTH_WINDOW_S}s` }];
  }
  const extra = chain.preSign?.(req) ?? [];
  if (extra.length) return extra;
  let usd;
  try {
    usd = usdOf(req);
  } catch {
    return [{ rule: "amount", limit: "positive integer atomic units", observed: req.amount ?? null, message: "the server's amount is not a positive whole number of atomic USDC units that can be counted exactly" }];
  }
  if (bound) {
    if (unitsOf(req) > bound.maxUnits) {
      return [{ rule: "price_changed", limit: bound.maxUsd, observed: usd, message: `the server now asks $${usd}, more than the $${bound.maxUsd} the owner approved; nothing was signed` }];
    }
    if (bound.payTo !== undefined && !samePayee(req.payTo, bound.payTo)) {
      return [{ rule: "payee_changed", limit: bound.payTo, observed: req.payTo, message: "the server now names a different payee than the one the owner approved; nothing was signed" }];
    }
  }
  return evaluate(policy, { usd, to: req.payTo, chain: chain.name }, spentLast24h());
}

/** What `pay` and `quoteX402` both do first: the owner's chain, and a chain object (no network call, nothing signed). */
async function prepare({ chain: requestedChain, headers, account, signer, scheme, rpc, rpcTimeoutMs }) {
  const policy = loadPolicy();
  const { chain: chainName, refusals } = resolvePayChain(policy, requestedChain);
  // No limits, no chains chosen, or a chain the owner did not choose: nothing reserved, nothing fetched.
  if (refusals.length) throw new Refused(refusals);
  const reserved = Object.keys(headers).filter((k) => RESERVED_HEADERS.includes(k.toLowerCase()));
  if (reserved.length) throw new Error(`header ${reserved.join(", ")} is reserved for the payment exchange`);
  const chain = chainName === "solana" ? await solanaChain({ signer, scheme, rpc, rpcTimeoutMs }) : baseChain(account ?? evmAccount(), scheme);
  return { policy, chain };
}

// The request, built the same way for the quote and for the payment.
const requestInit = ({ method, body, headers, timeoutMs }) => ({ method, body, headers: { ...headers, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });

const MAX_OFFERS = 20; // a server's list is capped: only this many offers are read
const MAX_REFUSALS = 10;

/**
 * Ask what `url` would charge, WITHOUT paying: one unpaid request, made the way
 * `pay` makes it (same method, body, headers, user-agent and timeout). Nothing is
 * reserved, nothing is signed.
 *
 * Returns `{ status, free, chain, offers, refusals, ... }`:
 *   - `free: true` when the server did not answer 402 (it did not ask for payment);
 *     then `body` and `content_type` carry its answer (untrusted content).
 *   - `offers`: the 402 offers this agent could pay, cheapest first. Each runs
 *     through the SAME guard `pay` uses (`check`), so an offer on another chain or
 *     asset, over a limit, to a payee the owner did not allow, or with a window
 *     or transfer method the kit will not sign, is not an offer. Each is
 *     `{ usd, pay_to, network, version, chain, amount_atomic }`.
 *   - `refusals`: why the others are not (and, with no offers, why nothing can be paid).
 * The terms are read by x402's own parser (`x402HTTPClient.getPaymentRequiredResponse`,
 * exported by @x402/fetch, the code `pay` runs): the v2 `PAYMENT-REQUIRED` header
 * (decodePaymentRequiredHeader in @x402/core/http), else a v1 JSON body
 * `{ x402Version: 1, accepts }`. Everything the server sent is cleaned (src/text.js).
 */
export async function quoteX402(url, { chain: requestedChain, method = "GET", body, headers = {}, account, signer, scheme, rpc, rpcTimeoutMs, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const { policy, chain } = await prepare({ chain: requestedChain, headers, account, signer, scheme, rpc, rpcTimeoutMs });
  // The quote goes out BEFORE the owner approves. A GET is the request itself (safe to
  // repeat). Any other method could DO something, and its body and headers (an API key)
  // are the owner's to release: so the quote asks with the same method, an empty JSON
  // body and none of the caller's headers. If that does not show the terms, the result is
  // `unquoted` (never `free`), and the real request only goes out after approval.
  const verb = String(method).toUpperCase();
  // PUT, PATCH and DELETE change or remove something on their first request: no unpaid ask
  // at all; the price is unknown until the real request, after approval.
  if (["PUT", "PATCH", "DELETE"].includes(verb)) return { status: null, chain: chain.name, free: false, unquoted: true, offers: [], refusals: [] };
  // A GET with the caller's headers (often an API key) asks WITHOUT them: those headers go
  // out only after the Sato Hub check, the owner's gate and approval. A POST asks with an
  // empty JSON body and none of the caller's headers.
  const probeOnly = verb !== "GET" || Object.keys(headers).length > 0;
  const withBody = verb === "POST";
  const init = probeOnly
    ? requestInit({ method: verb, body: withBody ? "{}" : undefined, headers: withBody ? { "content-type": "application/json" } : {}, timeoutMs })
    : requestInit({ method, body, headers, timeoutMs });
  // Built as a Request, exactly as wrapFetchWithPayment builds the one `pay` sends.
  const res = await fetchImpl(new Request(url, init));
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    text = res.status === 402 ? "" : `(the response body could not be read: ${clean(err.message, 200)})`;
  }
  const base = { status: res.status, chain: chain.name };
  if (res.status !== 402) {
    // An empty-body probe that gets no 402 says nothing about the real request: unquoted, not free.
    if (probeOnly) return { ...base, free: false, unquoted: true, offers: [], refusals: [] };
    return { ...base, free: true, offers: [], refusals: [], content_type: cleanOrNull(res.headers.get("content-type"), 200), body: text };
  }
  const unreadable = (why) => ({ ...base, free: false, offers: [], refusals: [{ rule: "terms_unreadable", limit: "x402 v1 or v2 payment terms", observed: null, message: `the server answered 402 but its payment terms could not be read (${why}); nothing was paid` }] });

  let parsedBody;
  try {
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON: a v2 server carries its terms in the header */
  }
  let required;
  try {
    required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => res.headers.get(name), parsedBody);
  } catch (err) {
    return unreadable(clean(err.message, 120));
  }
  const version = required?.x402Version ?? 2;
  if ((version !== 1 && version !== 2) || !Array.isArray(required.accepts)) return unreadable(version === 1 || version === 2 ? "no list of offers" : `x402 version ${clean(JSON.stringify(version) ?? "unknown", 20)} is not supported`);

  const found = [];
  const refusals = [];
  required.accepts.slice(0, MAX_OFFERS).forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("an offer is not an object");
      const r = check(policy, raw, chain, version);
      if (r.length) return refusals.push(...cleanRefusals(r));
      const req = view(raw, version);
      const units = unitsOf(req);
      found.push({ index, units, offer: { usd: unitsToUsd(units), pay_to: clean(req.payTo, 100), network: req.network, version, chain: chain.name, amount_atomic: units.toString() } });
    } catch (err) {
      refusals.push(...cleanRefusals([{ rule: "terms_unreadable", limit: "x402 v1 or v2 payment terms", observed: null, message: `an offer could not be read (${clean(err.message, 120)})` }]));
    }
  });
  found.sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : a.index - b.index));
  const offers = found.map((f) => f.offer);
  if (!offers.length && !refusals.length) refusals.push({ rule: "no_offer", limit: "at least one offer", observed: 0, message: "the server asked for payment but offered nothing" });
  return { ...base, free: false, version, offers, refusals: refusals.slice(0, MAX_REFUSALS) };
}

/**
 * Pay for `url`. `chain` is "base" or "solana"; when it is left out, the one
 * chain the owner's policy allows (see resolvePayChain). `account` / `scheme`
 * (Base) and `signer` / `scheme` / `rpc` / `rpcTimeoutMs` (Solana) are for tests;
 * by default they come from the agent's own wallet and SATO_AGENT_SOLANA_RPC.
 */
export async function pay(url, { chain: requestedChain, method = "GET", body, headers = {}, maxUsd, payTo, account, signer, scheme, rpc, rpcTimeoutMs, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const bound = boundTerms({ maxUsd, payTo }); // the price (and payee) the owner approved, if one was quoted first
  const { policy, chain } = await prepare({ chain: requestedChain, headers, account, signer, scheme, rpc, rpcTimeoutMs });

  const seen = [];
  const guard = (version, reqs) =>
    reqs.filter((req) => {
      const r = check(policy, req, chain, version, bound);
      seen.push(...cleanRefusals(r));
      return r.length === 0;
    });

  const client = x402Client.fromConfig({
    schemes: [
      { network: chain.networkPattern, client: chain.scheme },
      { x402Version: 1, network: chain.v1Network, client: chain.schemeV1 }, // v1 servers: same guard, same hooks
    ],
    policies: [guard],
    // A quoted price is a price: when the owner approved one, the cheapest offer inside it is
    // taken (the offer that was quoted), not whichever the server lists first.
    ...(bound ? { paymentRequirementsSelector: (ver, accepts) => accepts.reduce((best, r) => (BigInt(view(r, ver).amount) < BigInt(view(best, ver).amount) ? r : best)) } : {}),
    // x402's built-in controls ($1 default, default assets) run before policies and
    // would answer for the owner. The guard is stricter (USDC on one chain only, short
    // authorization windows) and applies the owner's limits, so it is the only
    // control, and every refusal names its rule.
    spendControls: false,
  });

  let entry = null;
  let units = null; // atomic USDC reserved for the payment being created
  let signedInfo = null; // Solana: the payer signature etc. of the transaction that was signed
  let rejected = null; // the signed payload that did not match; it stays counted
  let signed = false; // the payload was built AND passed the checks: it may be sent, so it must stay counted
  let version = 2; // x402 protocol version of the payment being made
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: raw }) => {
    version = paymentRequired?.x402Version ?? 2;
    const pre = check(loadPolicy(), raw, chain, version, bound);
    if (pre.length) {
      seen.push(...cleanRefusals(pre));
      return { abort: true, reason: pre.map((x) => x.rule).join(",") };
    }
    const req = view(raw, version);
    try {
      entry = await reserve(loadPolicy(), { kind: "x402", chain: chain.name, asset: "USDC", usd: usdOf(req), to: req.payTo, url });
      units = unitsOf(req);
    } catch (err) {
      if (err instanceof Refused) {
        seen.push(...err.refusals);
        return { abort: true, reason: err.refusals.map((x) => x.rule).join(",") };
      }
      throw err;
    }
  });
  client.onAfterPaymentCreation(async (ctx) => {
    // Throwing here fires the failure hook and the payload is never sent.
    try {
      signedInfo = await chain.afterSign(ctx, { units, version }, seen);
    } catch (err) {
      if (err instanceof SignedPayloadRejected && entry) {
        // Signed, so it stays counted: write down what was signed, and do not send it.
        rejected = err;
        signedInfo = err.info ?? null;
        record({ id: entry.id, status: "signed_not_sent", chain: chain.name, reason: clean(err.problems.join("; "), 600), ...signedInfo });
      }
      throw err;
    }
    // Record the signature BEFORE the request that carries the payment is sent.
    if (entry) record({ id: entry.id, status: "signed", chain: chain.name, x402_version: version, ...signedInfo });
    signed = true;
  });
  client.onPaymentCreationFailure(async () => {
    if (rejected) return; // something was signed: it stays counted
    // Nothing was signed: the reservation can be released.
    if (entry) release(entry, "payment could not be created; nothing signed");
    entry = null;
  });

  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  let res;
  try {
    res = await paidFetch(url, requestInit({ method, body, headers, timeoutMs }));
  } catch (err) {
    if (rejected) {
      throw new Pending(`A payment of ${entry.usd} USDC to ${entry.to} was signed, but the signed ${chain.signedThing} did not match what was reserved (${rejected.problems.join("; ")}). It was NOT sent.`, {
        sent: false,
        chain: chain.name,
        usd: entry.usd,
        pay_to: entry.to,
        problems: rejected.problems,
        ...signedInfo,
        explorer: chain.walletUrl,
      });
    }
    if (signed && entry) {
      // Signed and (possibly) sent, then the request failed: a reset connection, a timeout,
      // a dropped answer. The server may have the payment and may still settle it. It stays
      // counted, and the caller must not retry.
      const why = clean(err.message, 300); // fetch/x402 errors can echo server input
      record({ id: entry.id, status: "signed_unconfirmed", chain: chain.name, reason: why });
      throw new Pending(`A payment of ${entry.usd} USDC to ${entry.to} was signed and sent, but the request failed before an answer arrived (${why}).`, {
        chain: chain.name,
        usd: entry.usd,
        pay_to: entry.to,
        ...signedInfo,
        explorer: chain.walletUrl,
      });
    }
    if (!entry && seen.length) throw new Refused(seen);
    // Solana: x402 drops offers on networks other than mainnet before the guard sees them.
    if (!entry && chain.name === "solana" && /No network\/scheme registered/.test(err.message)) {
      throw new Refused([{ rule: "asset", limit: chain.limit, observed: "no offer on this network", message: chain.refusal }]);
    }
    if (err instanceof Error) err.message = clean(err.message, 500); // x402/viem errors can echo server input
    throw err; // nothing was signed
  }

  const receiptHeader = res.headers.get("PAYMENT-RESPONSE") || res.headers.get("X-PAYMENT-RESPONSE");
  let settlement = null;
  if (receiptHeader) {
    let raw = null;
    try {
      raw = decodePaymentResponseHeader(receiptHeader);
    } catch {
      /* unreadable: settlementView says so, and the raw header is never echoed */
    }
    settlement = settlementView(raw, chain.name);
  }
  // Settled only with a success flag AND a transaction id in this chain's own form.
  const settled = Boolean(settlement?.success && settlement?.transaction);
  if (entry) record({ id: entry.id, status: settled ? "confirmed" : "signed_unsettled", chain: chain.name, http_status: res.status, tx: settlement?.transaction ?? null });
  // A body that cannot be read must not turn a signed payment into a plain error.
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch (err) {
    bodyText = `(the response body could not be read: ${clean(err.message, 200)})`;
  }

  return {
    status: res.status,
    chain: chain.name,
    network: chain.networkPattern,
    asset: chain.asset,
    signed: Boolean(entry),
    settled,
    usd: entry?.usd ?? 0,
    amount_atomic: entry && units !== null ? units.toString() : null,
    pay_to: entry?.to ?? null,
    signature: signedInfo?.payer_signature ?? null, // Solana: this wallet's signature on the transaction
    settlement,
    explorer: settled ? chain.txUrl(settlement.transaction) : (entry ? chain.walletUrl ?? null : null),
    content_type: cleanOrNull(res.headers.get("content-type"), 200),
    x402_version: version,
    body: bodyText,
  };
}
