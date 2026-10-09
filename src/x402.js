// Pay for an HTTP resource with x402, in USDC on Base, from the agent's wallet.
//
// The limits apply twice: as an x402 payment policy (only an option inside the
// limits can be chosen), and again right before signing, where the spend is
// reserved under the spend lock.
//
// A SIGNED payment always stays counted. An x402 payment is a signed EIP-3009
// authorization that the server can settle until it expires, even if it
// answers 402 again or errors. So the agent also refuses authorizations that
// would stay valid for more than MAX_AUTH_WINDOW_S.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { evaluate, loadPolicy } from "./policy.js";
import { record, release, reserve, spentLast24h } from "./ledger.js";
import { Refused } from "./errors.js";
import { evmAccount } from "./wallet.js";
import { USDC_BASE } from "./base.js";
import { USER_AGENT } from "./version.js";

export const BASE_NETWORK = "eip155:8453";
export const MAX_AUTH_WINDOW_S = 300;

const usdOf = (req) => Number(BigInt(req.amount)) / 1e6;
const isBaseUsdc = (req) => req.network === BASE_NETWORK && String(req.asset).toLowerCase() === USDC_BASE.toLowerCase();

function check(policy, req) {
  if (!isBaseUsdc(req)) {
    return [{ rule: "asset", limit: `USDC on ${BASE_NETWORK}`, observed: `${req.asset} on ${req.network}`, message: "only USDC on Base is paid in this version" }];
  }
  // Must be a real integer: the signing code computes `now + maxTimeoutSeconds`,
  // and a string "300" would concatenate into an authorization valid for millennia.
  const w = req.maxTimeoutSeconds;
  if (!(typeof w === "number" && Number.isInteger(w) && w > 0 && w <= MAX_AUTH_WINDOW_S)) {
    return [{ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: req.maxTimeoutSeconds, message: `the server asks for a payment authorization valid for ${req.maxTimeoutSeconds}s; the limit is ${MAX_AUTH_WINDOW_S}s` }];
  }
  let usd;
  try {
    usd = usdOf(req);
  } catch {
    return [{ rule: "amount", limit: "integer atomic units", observed: req.amount, message: "the server's amount is not an integer" }];
  }
  return evaluate(policy, { usd, to: req.payTo }, spentLast24h());
}

export async function pay(url, { method = "GET", body, headers = {}, account = evmAccount(), fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const policy = loadPolicy();
  if (!policy) throw new Refused(evaluate(null, {}, 0));

  const seen = [];
  const guard = (_version, reqs) =>
    reqs.filter((req) => {
      const r = check(policy, req);
      seen.push(...r);
      return r.length === 0;
    });

  const client = x402Client.fromConfig({
    schemes: [{ network: BASE_NETWORK, client: new ExactEvmScheme(account) }],
    policies: [guard],
    // x402's built-in controls ($1 default, default assets) run before policies and
    // would answer for the owner. The guard is stricter (USDC on Base only, short
    // authorization windows) and applies the owner's limits, so it is the only
    // control, and every refusal names its rule.
    spendControls: false,
  });

  let entry = null;
  client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
    const pre = check(loadPolicy(), req);
    if (pre.length) {
      seen.push(...pre);
      return { abort: true, reason: pre.map((x) => x.rule).join(",") };
    }
    try {
      entry = await reserve(loadPolicy(), { kind: "x402", chain: "base", asset: "USDC", usd: usdOf(req), to: req.payTo, url });
    } catch (err) {
      if (err instanceof Refused) {
        seen.push(...err.refusals);
        return { abort: true, reason: err.refusals.map((x) => x.rule).join(",") };
      }
      throw err;
    }
  });
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    // Belt and braces: check what was actually signed. Throwing here fires the
    // failure hook (which releases the reservation) and the payload is never sent.
    const validBefore = Number(paymentPayload?.payload?.authorization?.validBefore);
    const left = validBefore - Date.now() / 1000;
    if (!Number.isFinite(validBefore) || left > MAX_AUTH_WINDOW_S + 30) {
      seen.push({ rule: "authorization_window", limit: MAX_AUTH_WINDOW_S, observed: Number.isFinite(left) ? Math.round(left) : "unknown", message: "the signed authorization would stay valid too long (or its expiry could not be read); it was not sent" });
      throw new Error("authorization window check failed; payment not sent");
    }
    if (entry) record({ id: entry.id, status: "signed" });
  });
  client.onPaymentCreationFailure(async () => {
    // Nothing was signed: the reservation can be released.
    if (entry) release(entry, "payment could not be created; nothing signed");
    entry = null;
  });

  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  let res;
  try {
    res = await paidFetch(url, { method, body, headers: { "user-agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!entry && seen.length) throw new Refused(seen);
    throw err; // if a payment was signed and sent, it stays counted
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
  if (entry) record({ id: entry.id, status: settled ? "confirmed" : "signed_unsettled", http_status: res.status, tx: settlement?.transaction ?? null });

  return {
    status: res.status,
    signed: Boolean(entry),
    settled,
    usd: entry?.usd ?? 0,
    pay_to: entry?.to ?? null,
    settlement,
    content_type: res.headers.get("content-type"),
    body: await res.text(),
  };
}
