// An offline stand-in for Bitrefill's wallet-only x402 API (https://api.bitrefill.com),
// shaped after its docs and the 402s it served on 2026-10-09. Used in-process by
// test/bitrefill.test.js and, through test/purchase-preload.js, by the real CLI.
// Nothing here talks to Bitrefill; no account is ever created.

import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";

export const BASE = "https://api.bitrefill.com";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
export const TOKEN = "eyJ0ZXN0Ijp0cnVlfQ.test-access-token.sig";
export const CODE = "AMZN-SECRET-CODE-9876-XYZ";
export const PIN = "4321-PIN-SECRET";
export const INVOICE = "inv_test_123456";
/** The catalogue the stand-in sells. amazon_com-usa has the values Bitrefill listed live on 2026-10-10. */
export const PRODUCTS = {
  "amazon-us": { id: "amazon-us", name: "Amazon", values: ["25", "50"] },
  "amazon_com-usa": { id: "amazon_com-usa", name: "Amazon.com USA", values: ["1000", "500", "200", "100", "50", "20", "10", "5"] },
};

/** The sign-in challenge's info, relative to `now`. `over` replaces fields (a test of what the kit refuses). */
export function siwxInfo(now = Date.now(), over = {}) {
  return {
    domain: "api.bitrefill.com",
    uri: "https://api.bitrefill.com/x402/connect",
    statement: "Sign in to Bitrefill to buy gift cards with this wallet.",
    version: "1",
    nonce: "a1b2c3d4e5f6a7b8",
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 5 * 60_000).toISOString(),
    resources: ["https://api.bitrefill.com/x402/connect"],
    ...over,
  };
}

async function norm(input, init) {
  if (input instanceof Request) return { url: new URL(input.url), method: input.method, headers: input.headers, body: await input.text() };
  return { url: new URL(String(input)), method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers ?? {}), body: init?.body ?? "" };
}
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A fetch that answers as Bitrefill. opts: info (sign-in info overrides), supportedChains, priceUnits, payTo, delivered
 * (status reads before it says all_delivered), failDelivery, echoCodeInError. Returns { fetch, log }.
 */
export function bitrefillWorld(opts = {}) {
  const log = [];
  let statusReads = 0;
  const priceUnits = opts.priceUnits ?? "25500000";
  const fetch = async (input, init) => {
    const r = await norm(input, init);
    if (r.url.origin !== BASE) throw new Error(`offline test: no network to ${r.url.origin}`);
    const path = r.url.pathname;
    log.push({ method: r.method, path, search: r.url.search, ua: r.headers.get("user-agent"), token: r.headers.get("x-access-token"), siwx: r.headers.get("sign-in-with-x"), paid: Boolean(r.headers.get("payment-signature")), body: r.body });
    if (path === "/x402/connect" && r.method === "POST") {
      const h = r.headers.get("sign-in-with-x");
      if (!h) return json(402, { x402Version: 2, error: "Sign-in required", extensions: { "sign-in-with-x": { info: siwxInfo(Date.now(), opts.info), supportedChains: opts.supportedChains ?? [{ chainId: "eip155:8453", type: "eip191" }, { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", type: "ed25519" }] } } });
      return json(200, { token: TOKEN, token_header: "X-Access-Token", expires_in: 7200 });
    }
    if (r.headers.get("x-access-token") !== TOKEN || opts.rejectToken) return json(opts.rejectToken ? 401 : 402, { x402Version: 2, error: "Payment required", accepts: [] });
    if (path === "/x402/gift-cards/search") return json(200, { products: [{ slug: "amazon-us", name: "Amazon", country: "US", recipient_type: "none", in_stock: true }, { slug: "steam-usa", name: "Steam\u001b[31m", country: "US", in_stock: false }] });
    if (path === "/x402/products/detail") {
      const p = PRODUCTS[r.url.searchParams.get("slug")];
      if (!p) return json(404, { error: "PRODUCT_NOT_FOUND" });
      return json(200, { id: p.id, name: p.name, recipient_type: "none", recipient_required: false, in_stock: true, packages: p.values.map((v) => ({ package_value: v, package_currency: "USD" })) });
    }
    if (path === "/x402/invoice/create" && r.method === "POST") {
      const item = JSON.parse(r.body).items?.[0];
      if (!PRODUCTS[item?.product_id]?.values.includes(item?.package_value)) return json(500, { error: "INTERNAL" });
      // price_usdc shapes: "decimal" ("25.5", the default), "units" ("5250000": base units, as seen live 2026-10-10),
      // "units_number" (5250000), "whole" ("5": whole dollars). priceText overrides it outright.
      const shapes = { decimal: (Number(priceUnits) / 1e6).toString(), units: priceUnits, units_number: Number(priceUnits), whole: String(Number(priceUnits) / 1e6) };
      const body = { invoice_id: INVOICE, price_usdc: opts.priceText ?? shapes[opts.priceShape ?? "decimal"], expires_in_minutes: 15, next_step: { url: "/x402/invoice/pay" } };
      if (!opts.noPriceUsd) body.price_usd = Number(priceUnits) / 1e6;
      return json(200, body);
    }
    if (path === "/x402/invoice/pay" && r.method === "POST") {
      const sig = r.headers.get("payment-signature");
      const accepts = [
        { scheme: "exact", network: "eip155:8453", amount: priceUnits, asset: USDC, payTo: opts.payTo ?? PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        { scheme: "exact", network: "eip155:42161", amount: priceUnits, asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
      ];
      if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${BASE}/x402/invoice/pay` }, accepts }) } });
      const payload = decodePaymentSignatureHeader(sig);
      log.at(-1).payment = payload;
      return json(200, { success: true, status: "payment_confirmed", transaction: `0x${"cd".repeat(32)}` }, { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453", payer: payload.payload.authorization.from }) });
    }
    if (path === "/x402/invoice/status") {
      statusReads++;
      if (opts.failDelivery) return json(200, { invoice_status: "payment_error", delivery_status: "failed" });
      if (statusReads <= (opts.delivered ?? 0)) return json(200, { invoice_status: "payment_confirmed", delivery_status: "pending" });
      return json(200, { invoice_status: "complete", delivery_status: "all_delivered", redemption_info: { orders: [{ redemption_info: { code: CODE, pin: PIN, extra_fields: {} } }] } });
    }
    return json(404, { error: "NOT_FOUND" });
  };
  return { fetch, log };
}
