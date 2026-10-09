// Pay for an HTTP resource with x402, in USDC, from the agent's wallet: on Base
// (the default) or on Solana (`chain: "solana"`).
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
// On Solana the signed message is a transaction. Its fee payer is the server's
// facilitator and its lifetime is its recent blockhash (about a minute). After
// signing, the agent decodes that transaction and sends it only if it is exactly
// one USDC transfer of the reserved amount to the recipient (see x402-solana.js).
// If it is not, nothing is sent, the spend STAYS counted, and the command exits 4.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { evaluate, loadPolicy } from "./policy.js";
import { record, release, reserve, spentLast24h } from "./ledger.js";
import { Pending, Refused } from "./errors.js";
import { evmAccount } from "./wallet.js";
import { USDC_BASE } from "./base.js";
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
const unitsOf = (v) => {
  if (typeof v.amount !== "string" || !/^[0-9]+$/.test(v.amount)) throw new Error("amount is not a string of digits");
  return BigInt(v.amount);
};
const usdOf = (v) => Number(unitsOf(v)) / 1e6;
const isBaseUsdc = (v) => v.network === BASE_NETWORK && String(v.asset).toLowerCase() === USDC_BASE.toLowerCase();

/** The signed payload was built but is not what was approved. It is NOT sent and NOT released. */
class SignedPayloadRejected extends Error {
  constructor(problems) {
    super(`signed payment did not match what was approved: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const baseChain = (account) => ({
  name: "base",
  scheme: new ExactEvmScheme(account),
  schemeV1: new ExactEvmSchemeV1(account),
  v1Network: "base",
  networkPattern: BASE_NETWORK,
  walletUrl: `https://basescan.org/address/${account.address}`,
  asset: USDC_BASE,
  accepts: isBaseUsdc,
  limit: `USDC on ${BASE_NETWORK}`,
  refusal: "only USDC on Base is paid on this chain (use --chain solana to pay on Solana)",
  txUrl: (hash) => `https://basescan.org/tx/${hash}`,
  // Belt and braces: check what was actually signed.
  async afterSign({ paymentPayload }, _ctx, seen) {
    const validBefore = Number(paymentPayload?.payload?.authorization?.validBefore);
    const left = validBefore - Date.now() / 1000;
    if (!Number.isFinite(validBefore) || left > MAX_AUTH_WINDOW_S + 30) {
      seen.push({ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: Number.isFinite(left) ? Math.round(left) : "unknown", message: "the signed authorization would stay valid too long (or its expiry could not be read); it was not sent" });
      throw new Error("authorization window check failed; payment not sent");
    }
    return {};
  },
});

async function solanaChain({ signer, scheme, rpc }) {
  const sol = await import("./x402-solana.js");
  const s = signer ?? (await sol.solanaSigner());
  const owner = s.address;
  return {
    name: "solana",
    scheme: scheme ?? sol.solanaScheme(s),
    schemeV1: scheme ?? sol.solanaSchemeV1(s),
    v1Network: "solana",
    networkPattern: sol.SOLANA_NETWORK,
    asset: sol.USDC_MINT,
    owner,
    accepts: sol.isSolanaUsdc,
    limit: `USDC (${sol.USDC_MINT}) on ${sol.SOLANA_NETWORK}`,
    refusal: "only USDC on Solana mainnet is paid on this chain (use --chain base to pay on Base)",
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
            problems.push(...(await sol.checkLifetime(info, req, rpc)));
          } catch (err) {
            problems.push(`could not check the transaction's blockhash (${err.message})`);
          }
        }
      } catch (err) {
        problems = [`could not check the signed transaction (${err.message})`];
      }
      if (problems.length) throw Object.assign(new SignedPayloadRejected(problems), { info });
      return info;
    },
  };
}

function check(policy, raw, chain, version) {
  const req = view(raw, version);
  if (!chain.accepts(req)) {
    return [{ rule: "asset", limit: chain.limit, observed: `${raw.asset} on ${raw.network}`, message: chain.refusal }];
  }
  // Must be a real integer: the signing code computes `now + maxTimeoutSeconds`,
  // and a string "300" would concatenate into an authorization valid for millennia.
  const w = req.maxTimeoutSeconds;
  if (!(typeof w === "number" && Number.isInteger(w) && w > 0 && w <= MAX_AUTH_WINDOW_S)) {
    return [{ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: req.maxTimeoutSeconds, message: `the server asks for a payment authorization valid for ${req.maxTimeoutSeconds}s; the limit is ${MAX_AUTH_WINDOW_S}s` }];
  }
  const extra = chain.preSign?.(req) ?? [];
  if (extra.length) return extra;
  let usd;
  try {
    usd = usdOf(req);
  } catch {
    return [{ rule: "amount", limit: "integer atomic units", observed: req.amount ?? null, message: "the server's amount is not an integer" }];
  }
  return evaluate(policy, { usd, to: req.payTo, chain: chain.name }, spentLast24h());
}

/**
 * Pay for `url`. `chain` is "base" or "solana"; when it is left out, the one
 * chain the owner's policy allows (see resolvePayChain). `account` (Base) and
 * `signer` / `scheme` / `rpc` (Solana) are for tests; by default they come from
 * the agent's own wallet and SATO_AGENT_SOLANA_RPC.
 */
export async function pay(url, { chain: requestedChain, method = "GET", body, headers = {}, account, signer, scheme, rpc, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const policy = loadPolicy();
  const { chain: chainName, refusals } = resolvePayChain(policy, requestedChain);
  // No limits, no chains chosen, or a chain the owner did not choose: nothing reserved, nothing fetched.
  if (refusals.length) throw new Refused(refusals);
  const reserved = Object.keys(headers).filter((k) => RESERVED_HEADERS.includes(k.toLowerCase()));
  if (reserved.length) throw new Error(`header ${reserved.join(", ")} is reserved for the payment exchange`);
  const chain = chainName === "solana" ? await solanaChain({ signer, scheme, rpc }) : baseChain(account ?? evmAccount());

  const seen = [];
  const guard = (version, reqs) =>
    reqs.filter((req) => {
      const r = check(policy, req, chain, version);
      seen.push(...r);
      return r.length === 0;
    });

  const client = x402Client.fromConfig({
    schemes: [
      { network: chain.networkPattern, client: chain.scheme },
      { x402Version: 1, network: chain.v1Network, client: chain.schemeV1 }, // v1 servers: same guard, same hooks
    ],
    policies: [guard],
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
    const pre = check(loadPolicy(), raw, chain, version);
    if (pre.length) {
      seen.push(...pre);
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
        record({ id: entry.id, status: "signed_not_sent", chain: chain.name, reason: err.problems.join("; "), ...signedInfo });
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
    res = await paidFetch(url, { method, body, headers: { ...headers, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (rejected) {
      throw new Pending(`A payment of ${entry.usd} USDC to ${entry.to} was signed, but the signed transaction did not match what was approved (${rejected.problems.join("; ")}). It was NOT sent.`, {
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
      record({ id: entry.id, status: "signed_unconfirmed", chain: chain.name, reason: String(err.message).slice(0, 300) });
      throw new Pending(`A payment of ${entry.usd} USDC to ${entry.to} was signed and sent, but the request failed before an answer arrived (${err.message}).`, {
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
    throw err; // nothing was signed
  }

  const receiptHeader = res.headers.get("PAYMENT-RESPONSE") || res.headers.get("X-PAYMENT-RESPONSE");
  let settlement = null;
  if (receiptHeader) {
    try {
      settlement = decodePaymentResponseHeader(receiptHeader);
    } catch {
      settlement = { raw: receiptHeader };
    }
  }
  const settled = Boolean(settlement?.success && settlement?.transaction);
  if (entry) record({ id: entry.id, status: settled ? "confirmed" : "signed_unsettled", chain: chain.name, http_status: res.status, tx: settlement?.transaction ?? null });
  // A body that cannot be read must not turn a signed payment into a plain error.
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch (err) {
    bodyText = `(the response body could not be read: ${err.message})`;
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
    content_type: res.headers.get("content-type"),
    x402_version: version,
    body: bodyText,
  };
}
