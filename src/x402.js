// Pay for an HTTP resource with x402, in USDC on Base, from the agent's wallet.
//
// The owner's limits are applied twice: as an x402 payment policy (so only a
// payment option inside the limits can be chosen) and again right before the
// payment is signed, against a fresh read of today's spend. The spend is written
// to the ledger before the signed payment leaves; if the server answers 402
// again (payment not accepted), it is taken back out.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { evaluate, loadPolicy, Refused } from "./policy.js";
import { record, spentOn } from "./ledger.js";
import { evmAccount } from "./wallet.js";
import { USDC_BASE } from "./base.js";
import { USER_AGENT } from "./version.js";

export const BASE_NETWORK = "eip155:8453";

const usdOf = (req) => Number(req.amount) / 1e6;
const isBaseUsdc = (req) => req.network === BASE_NETWORK && String(req.asset).toLowerCase() === USDC_BASE.toLowerCase();

export async function pay(url, { method = "GET", body, headers = {}, account = evmAccount(), fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const policy = loadPolicy();
  if (!policy) throw new Refused(evaluate(null, {}, 0));

  const seen = [];
  const guard = (_version, reqs) =>
    reqs.filter((req) => {
      if (!isBaseUsdc(req)) {
        seen.push({ rule: "asset", limit: `USDC on ${BASE_NETWORK}`, observed: `${req.asset} on ${req.network}`, message: "only USDC on Base is paid in this version" });
        return false;
      }
      const r = evaluate(policy, { usd: usdOf(req), to: req.payTo }, spentOn());
      seen.push(...r);
      return r.length === 0;
    });

  const client = x402Client.fromConfig({
    schemes: [{ network: BASE_NETWORK, client: new ExactEvmScheme(account) }],
    policies: [guard],
    // x402's built-in controls ($1 default, default assets) run before policies and
    // would answer for the owner. The guard above is stricter (USDC on Base only)
    // and applies the owner's own limits, so it is the only control, and every
    // refusal names the owner's rule.
    spendControls: false,
  });

  let entry = null;
  client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
    const r = evaluate(loadPolicy(), { usd: usdOf(req), to: req.payTo }, spentOn());
    if (r.length) {
      seen.push(...r);
      return { abort: true, reason: r.map((x) => x.rule).join(",") };
    }
    entry = record({ status: "submitted", kind: "x402", chain: "base", asset: "USDC", usd: usdOf(req), to: req.payTo, url });
  });

  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  let res;
  try {
    res = await paidFetch(url, {
      method,
      body,
      headers: { "user-agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A signed payment may already have settled even if the request then failed,
    // so a submitted spend stays counted against today's limit.
    if (!entry && seen.length) throw new Refused(seen);
    throw err;
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
  if (entry && res.status === 402) record({ id: entry.id, status: "failed", reason: "payment not accepted" });
  else if (entry) record({ id: entry.id, status: "confirmed", tx: settlement?.transaction ?? null });

  return {
    status: res.status,
    paid: Boolean(entry) && res.status !== 402,
    usd: entry?.usd ?? 0,
    pay_to: entry?.to ?? null,
    settlement,
    content_type: res.headers.get("content-type"),
    body: await res.text(),
  };
}
