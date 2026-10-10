// Amazon US orders, through Sato Hub's Crossmint proxy, paid in USDC from the
// agent's own wallet on Base or Solana.
//
//   quote     POST <Sato Hub>/api/commerce/order { product, chain, payer, recipient }.
//             The recipient (the owner's shipping address, from local settings) is
//             sent in this body and nowhere else. 503 orders_not_enabled = not
//             switched on yet (exit 3).
//   verify    Sato Hub's signature over the answer (the same envelope it signs swap
//             answers with); kind, payer, chain, no Sato fee, a valid unexpired quote;
//             `recipient_sha256` must equal the hash of the address this bot holds; the
//             total within the owner's limits.
//   check     the payment transaction Crossmint built is decoded and simulated: it may
//             move only USDC, at most the quoted total, out of the agent's wallet, plus
//             network fees (src/purchase-evm.js, src/purchase-solana.js).
//   approve   the owner sees the item, tax, shipping, total, and where it ships
//             (purchase setting, src/purchase.js).
//   pay       reserved under the spend lock, signed, recorded, broadcast.
//
// No Sato Hub fee on Amazon orders: an answer with any fee is refused.
// The address never goes to the ledger, another command's output, an error message or
// telemetry; text a server sends back is scrubbed of it before it is shown.

import { createHash } from "node:crypto";
import { MCP_URL } from "./satohub.js";
import { canonicalJson, verifyHubSignature } from "./hub-signature.js";
import { loadPolicy } from "./policy.js";
import { actions, record, release, reserve } from "./ledger.js";
import { Pending, Refused, Rejected } from "./errors.js";
import { addresses } from "./wallet.js";
import { clean } from "./text.js";
import { USER_AGENT } from "./version.js";
import { loadSettings, scrubAddress } from "./settings.js";
import { checkLimits, purchaseChain, purchaseGate, refuse } from "./purchase.js";
import { decodeBaseTx, simulateBasePurchase } from "./purchase-evm.js";
import { TOKEN_ACCOUNT_RENT, blockhashValid, decodeWire, inspectPurchaseTx, signWithAgent, simulatePurchaseTx } from "./purchase-solana.js";
import { broadcastAndConfirm, rpc as solanaRpc } from "./solana.js";
import { clients as baseClients, signAndSend } from "./base.js";

export const ORDER_PATH = "/api/commerce/order";
const HTTP_TIMEOUT_MS = 30_000;
const QUOTE_MAX_AGE_MS = 10 * 60 * 1000;
const MIN_TIME_LEFT_MS = 15_000;

/** Sato Hub's origin: the same place the checks go (SATO_AGENT_MCP_URL moves both). */
export const commerceOrigin = (mcpUrl = MCP_URL) => new URL(mcpUrl).origin;

// ---------------------------------------------------------------- the product

const ASIN = /^(B0[A-Z0-9]{8}|\d{9}[\dX])$/;
const US_HOSTS = ["amazon.com", "www.amazon.com", "smile.amazon.com", "a.co", "amzn.to", "amzn.com", "www.amzn.com"];

/** True for something that looks like an Amazon link (any country) or an ASIN. */
export function looksLikeAmazon(input) {
  const s = String(input ?? "").trim();
  if (ASIN.test(s.toUpperCase()) && /^[A-Za-z0-9]{10}$/.test(s)) return true;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && (/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname) || ["a.co", "amzn.to", "amzn.com", "www.amzn.com"].includes(u.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * The product as sent to Sato Hub: `amazon:<ASIN>` (an ASIN, or a link with one in its path), else `amazon:<link>`
 * (a short link). Amazon US only; another Amazon store is refused.
 */
export function amazonProduct(input) {
  const s = String(input ?? "").trim();
  if (/^[A-Za-z0-9]{10}$/.test(s) && ASIN.test(s.toUpperCase())) return { product: `amazon:${s.toUpperCase()}`, asin: s.toUpperCase() };
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("give an Amazon link (amazon.com) or a 10-character ASIN");
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("give an Amazon link (amazon.com) or a 10-character ASIN");
  if (!US_HOSTS.includes(host)) {
    if (/(^|\.)amazon\.[a-z.]+$/.test(host)) throw refuse("amazon_us_only", `orders are for Amazon US (amazon.com) only; ${clean(host, 60)} is another Amazon store`);
    throw new Error("give an Amazon link (amazon.com) or a 10-character ASIN");
  }
  const m = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Za-z0-9]{10})(?:[/?]|$)/.exec(u.pathname + (u.pathname.endsWith("/") ? "" : "/"));
  if (m && ASIN.test(m[1].toUpperCase())) return { product: `amazon:${m[1].toUpperCase()}`, asin: m[1].toUpperCase() };
  if (["a.co", "amzn.to"].includes(host)) return { product: `amazon:https://${host}${u.pathname}`, asin: null };
  throw new Error("that Amazon link has no product in it (look for /dp/<ASIN>); send the product page link or its ASIN");
}

// ---------------------------------------------------------------- the recipient

/** The recipient object sent to Sato Hub, from local settings: `line2` only when set. */
export function recipientOf(ship) {
  const o = { name: ship.name, line1: ship.line1, city: ship.city, state: ship.state, postalCode: ship.postalCode, country: ship.country, email: ship.email };
  if (ship.line2) o.line2 = ship.line2;
  return o;
}

/**
 * THE canonical form of a recipient, shared with Sato Hub: JSON with object keys sorted lexicographically at every
 * level, no whitespace, and no undefined (absent) keys. `recipient_sha256` is the SHA-256 hex of this string (UTF-8).
 */
export function canonicalRecipient(recipient) {
  return canonicalJson(recipient);
}

export const recipientSha256 = (recipient) => createHash("sha256").update(canonicalRecipient(recipient), "utf8").digest("hex");

// ---------------------------------------------------------------- Sato Hub

async function hubFetch(url, init, d) {
  let res;
  try {
    res = await d.fetchImpl(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Sato Hub did not answer (${err.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : clean(err.message, 120)}); nothing was ordered or paid`);
  }
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const notEnabled = (h) => h.status === 503 && h.json?.error === "orders_not_enabled";
const NOT_ENABLED = () => refuse("orders_not_enabled", "Amazon orders through Sato Hub are not switched on yet. Nothing was ordered or paid. The bot will be able to place them once Sato Hub turns them on; no update is needed.");

/** Sato Hub's short error code, cleaned and with any piece of the address taken out. */
const hubReason = (h, ship) => (typeof h.json?.error === "string" ? `: ${clean(scrubAddress(h.json.error, ship), 120)}` : "");

/** Ask Sato Hub for an order quote. Returns the raw (still unverified) answer. */
export async function requestOrder({ product, chain, payer, recipient }, deps = {}) {
  const d = { fetchImpl: globalThis.fetch, ...deps };
  const h = await hubFetch(`${d.origin ?? commerceOrigin()}${ORDER_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product, chain, payer, recipient }) }, d);
  if (notEnabled(h)) throw NOT_ENABLED();
  if (h.status !== 200 && h.status !== 201) throw new Error(`Sato Hub could not quote this order (HTTP ${h.status}${hubReason(h, recipient)}); nothing was ordered or paid`);
  if (!h.json || typeof h.json !== "object") throw new Error("Sato Hub's order answer was not JSON; nothing was ordered or paid");
  return h.json;
}

const money = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const samePayer = (chain, a, b) => typeof a === "string" && typeof b === "string" && (chain === "base" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Verify Sato Hub's order answer before anything is shown or signed. ctx: { chain, payer, recipient, now,
 * verifySignature, jwks }. Throws Refused. Returns the fields the kit uses, cleaned.
 */
export async function verifyOrderQuote(body, ctx) {
  const now = ctx.now ?? Date.now();
  try {
    await (ctx.verifySignature ?? verifyHubSignature)(body, { maxAgeMs: QUOTE_MAX_AGE_MS, now, ...(ctx.jwks ? { jwks: ctx.jwks } : {}) });
  } catch (err) {
    throw refuse("order_unsigned", `Sato Hub's order quote could not be shown to come from Sato Hub (${clean(err.message, 200)}); nothing was ordered or paid`);
  }
  const p = [];
  const bad = (m) => p.push(m);
  const { chain, payer } = ctx;
  if (body.kind !== "commerce_order") bad(`it is a "${clean(body.kind ?? "none", 40)}" answer, not an order quote`);
  if (typeof body.order_id !== "string" || !/^[A-Za-z0-9_:-]{4,128}$/.test(body.order_id)) bad("it has no usable order id");
  if (body.chain !== chain) bad(`it is for ${clean(body.chain ?? "no chain", 20)}, not ${chain}`);
  if (!samePayer(chain, body.payer, payer)) bad("it is for a different payer than this wallet");
  if (body.sato_fee_usd !== 0) bad(`it carries a Sato Hub fee (${clean(JSON.stringify(body.sato_fee_usd) ?? "none", 30)}); Amazon orders have none`);
  if (body.merchant !== "crossmint") bad("its merchant is not Crossmint");
  if (body.quote_status !== "valid") bad(`its quote is ${clean(body.quote_status ?? "missing", 40)}, not valid`);
  const expires = Date.parse(body.expires_at);
  if (!Number.isFinite(expires)) bad("it has no expiry");
  else if (expires - now < MIN_TIME_LEFT_MS) bad("its quote has expired (or is about to)");
  if (body.recipient_sha256 !== recipientSha256(ctx.recipient)) bad("the recipient Sato Hub quoted for is not the shipping address this bot holds");
  const st = body.ships_to ?? {};
  const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!eq(st.city, ctx.recipient.city) || !eq(st.state, ctx.recipient.state) || !eq(st.postalCode, ctx.recipient.postalCode)) bad("the place it ships to is not this bot's shipping address");
  const pr = body.price ?? {};
  let units = null;
  if (pr.currency !== "usdc") bad("its price is not in USDC");
  if (!money(pr.item_usd) || !money(pr.tax_usd) || !money(pr.shipping_usd) || !money(pr.total_usd) || !(pr.total_usd > 0)) bad("its price is not a set of USD amounts");
  if (typeof pr.total_base_units !== "string" || !/^[1-9]\d{0,15}$/.test(pr.total_base_units)) bad("its total is not a whole number of USDC units");
  else {
    units = BigInt(pr.total_base_units);
    if (money(pr.total_usd) && Math.abs(Number(units) / 1e6 - pr.total_usd) > 0.000001) bad("its total in USDC units does not match its total in USD");
    // No charge hides outside the lines the owner is shown.
    if (money(pr.item_usd) && money(pr.tax_usd) && money(pr.shipping_usd) && money(pr.total_usd) && Math.abs(pr.item_usd + pr.tax_usd + pr.shipping_usd - pr.total_usd) > 0.01) bad("its item, tax and shipping do not add up to its total");
  }
  const pay = body.payment ?? {};
  if (pay.chain !== chain || !samePayer(chain, pay.payer, payer)) bad("its payment is for another chain or payer");
  if (typeof pay.serialized_transaction !== "string" || !pay.serialized_transaction) bad("it carries no payment transaction");
  if (p.length) {
    throw new Refused([{ rule: "order_quote_refused", limit: null, observed: clean(p.join("; "), 400), message: `refused Sato Hub's order quote: ${p.join("; ")}. Nothing was ordered or paid.` }]);
  }
  const item = body.item ?? {};
  return {
    order_id: body.order_id,
    chain,
    title: clean(item.title ?? "Amazon item", 200),
    asin: typeof item.asin === "string" ? clean(item.asin, 20) : null,
    url: typeof item.url === "string" ? clean(item.url, 300) : null,
    price: { item_usd: pr.item_usd, tax_usd: pr.tax_usd, shipping_usd: pr.shipping_usd, total_usd: pr.total_usd, total_base_units: units },
    expires_at: body.expires_at,
    ships_to: { city: clean(st.city, 80), state: clean(st.state, 40), postalCode: clean(st.postalCode, 20) },
    payment: { encoding: typeof pay.encoding === "string" ? pay.encoding : chain === "base" ? "hex" : "base64", serialized_transaction: pay.serialized_transaction },
  };
}

// ---------------------------------------------------------------- the payment transaction

/**
 * Decode and simulate the payment Crossmint built. Returns { usdc_out, payees, simulated, prepared } where `prepared`
 * is what `executeOrder` signs. Throws Refused. deps: { simulate, c } (Base), { rpc } (Solana), payer.
 */
export async function checkOrderPayment(quote, { payer, ...deps }) {
  const max = quote.price.total_base_units;
  if (quote.chain === "base") {
    const tx = decodeBaseTx(quote.payment.serialized_transaction, quote.payment.encoding);
    const sim = await simulateBasePurchase({ agent: payer, to: tx.to, data: tx.data, maxUsdcUnits: max }, { ...deps, c: deps.c ?? (deps.simulate ? undefined : baseClients()) });
    return { ...sim, prepared: { chain: "base", to: tx.to, data: tx.data } };
  }
  const rpc = deps.rpc ?? solanaRpc();
  let tx;
  try {
    tx = decodeWire(quote.payment.serialized_transaction, quote.payment.encoding === "base58" ? "base58" : "base64");
  } catch (err) {
    throw refuse("purchase_tx.decode", `the payment transaction could not be decoded (${clean(err.message, 160)}); nothing was signed`);
  }
  const facts = await inspectPurchaseTx(tx, { agent: payer, allowSystem: false, requireAgentFeePayer: false }, { rpc });
  const sim = await simulatePurchaseTx(tx, facts, { agent: payer }, { rpc });
  const problems = [];
  if (sim.usdc_out <= 0n) problems.push({ rule: "purchase_tx.no_payment", limit: null, observed: null, message: "in simulation the transaction moves no USDC out of the wallet, so it would not pay for the order" });
  if (sim.usdc_out > max) problems.push({ rule: "purchase_tx.over_total", limit: max.toString(), observed: sim.usdc_out.toString(), message: `in simulation the transaction takes ${sim.usdc_out} USDC units, more than the quoted total of ${max}` });
  // SOL beyond the network fee: at most the rent of one new token account (the payee's USDC account), never a payment in SOL.
  if (sim.lamports_out > TOKEN_ACCOUNT_RENT) problems.push({ rule: "purchase_tx.other_asset_leaves", limit: TOKEN_ACCOUNT_RENT.toString(), observed: sim.lamports_out.toString(), message: `in simulation the transaction takes ${sim.lamports_out} lamports of SOL beyond the network fee; only USDC may pay for an order` });
  if (problems.length) throw new Refused(problems);
  return { ...sim, contract_call: false, prepared: { chain: "solana", tx, blockhash: facts.blockhash } };
}

/** Sign and send a checked order payment under the ledger contract. Returns { tx, explorer }. */
export async function executeOrder(quote, check, { usd, payer, ...deps }) {
  if (Date.parse(quote.expires_at) - Date.now() < MIN_TIME_LEFT_MS) throw refuse("quote_expired", "the order quote expired before it could be paid; run the order again for a new quote (nothing was signed)");
  const entry = await reserve(deps.policy ?? loadPolicy(), {
    kind: "order",
    chain: quote.chain,
    asset: "USDC",
    usd,
    to: check.payees[0] ?? "crossmint",
    order_id: quote.order_id,
    merchant: "crossmint",
    title: quote.title.slice(0, 120),
  });
  if (quote.chain === "base") {
    const c = deps.c ?? baseClients();
    let receipt;
    try {
      receipt = await (deps.signAndSend ?? signAndSend)(c, { to: check.prepared.to, data: check.prepared.data }, (hash) => record({ id: entry.id, status: "signed", tx: hash }));
    } catch (err) {
      if (!(err instanceof Pending)) release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: clean(err.shortMessage || err.message, 300) });
      throw err;
    }
    if (receipt.status !== "success") {
      release(entry, "reverted onchain", { tx: receipt.transactionHash });
      throw new Error(`the payment reverted: https://basescan.org/tx/${receipt.transactionHash}`);
    }
    record({ id: entry.id, status: "confirmed", tx: receipt.transactionHash });
    return { tx: receipt.transactionHash, explorer: `https://basescan.org/tx/${receipt.transactionHash}` };
  }
  const rpc = deps.rpc ?? solanaRpc();
  let built;
  try {
    // Its blockhash cannot be replaced (Crossmint may already have signed it): an expired one is a new quote, not a re-sign.
    if (!(await blockhashValid(check.prepared.blockhash, rpc))) throw refuse("quote_expired", "the order's payment transaction expired before it could be signed; run the order again for a new quote (nothing was signed)");
    built = await signWithAgent(check.prepared.tx, deps.signer);
  } catch (err) {
    release(entry, "failed before signing; nothing sent", { error: clean(err.message, 300) });
    throw err;
  }
  return broadcastAndConfirm(entry, built, rpc, deps.broadcast ?? {});
}

// ---------------------------------------------------------------- the whole order

const usd2 = (n) => `$${Number(n).toFixed(2)}`;

/**
 * `order <amazon link|ASIN>`. Returns { dry_run?, card, quote, ... } or throws Refused / NeedsApproval / Pending.
 * deps: fetchImpl, origin, verifySignature, jwks, simulate, c, rpc, signer, signAndSend, now.
 */
export async function placeOrder({ input, chain: requested, approve, dryRun = false }, deps = {}) {
  const policy = loadPolicy();
  const chain = purchaseChain(requested, ["base", "solana"], policy);
  checkLimits({ usd: undefined, chain }, policy);
  const { product } = amazonProduct(input);
  const settings = loadSettings();
  const ship = settings?.ship_to ?? null;
  if (!ship) throw refuse("ship_to_not_set", "no shipping address is set on this bot. The owner sets it once with `settings set --ship-name ... --ship-line1 ... --ship-city ... --ship-state ... --ship-zip ... --ship-country US --ship-email ...`; it stays on this computer.");
  if (ship.country !== "US") throw refuse("amazon_us_only", "Amazon orders ship to US addresses only, and this bot's shipping address is outside the US");
  const recipient = recipientOf(ship);
  const payer = addresses()[chain];

  const body = await requestOrder({ product, chain, payer, recipient }, deps);
  const quote = await verifyOrderQuote(body, { chain, payer, recipient, now: deps.now?.(), verifySignature: deps.verifySignature, jwks: deps.jwks });
  const usd = Number(quote.price.total_base_units) / 1e6;
  checkLimits({ usd, chain }, policy); // before the transaction is even read
  const check = await checkOrderPayment(quote, { payer, ...deps });
  checkLimits({ usd, chain, to: check.payees[0], payees: check.payees }, policy);

  const p = quote.price;
  const card = [
    `Amazon order: ${quote.title}${quote.asin ? ` (ASIN ${quote.asin})` : ""}`,
    `Item ${usd2(p.item_usd)} · tax ${usd2(p.tax_usd)} · shipping ${usd2(p.shipping_usd)} · total ${usd} USDC on ${chain === "base" ? "Base" : "Solana"}. No Sato Hub fee.`,
    `Ships to: ${clean(ship.name, 80)}, ${quote.ships_to.city}, ${quote.ships_to.state} ${quote.ships_to.postalCode}`,
    `Sold and shipped through Crossmint. Quote valid until ${String(quote.expires_at).replace(/\.\d+Z$/, "Z")}.`,
    `Checked before signing: the payment moves only USDC from this wallet, at most ${usd}, plus network fees (simulated).`,
  ];
  // Bound to the product, total and address (by its local id: the ledger, where intents are written, never holds the address).
  const intent = { cmd: "order", chain, product, title: quote.title.slice(0, 120), total_base_units: quote.price.total_base_units.toString(), ship_to_id: settings.ship_to_id ?? null };
  const summary = { order_id: quote.order_id, chain, title: quote.title, asin: quote.asin, price: { ...p, total_base_units: p.total_base_units.toString() }, expires_at: quote.expires_at, simulated: check.simulated, contract_call: Boolean(check.contract_call) };
  if (dryRun) return { dry_run: true, card, ...summary };
  await purchaseGate(intent, { approve, card }, policy);
  const paid = await executeOrder(quote, check, { usd, payer, policy, ...deps });
  return { card, ...summary, ...paid };
}

// ---------------------------------------------------------------- status

const PHASES = ["quote", "payment", "delivery", "completed"];

/** One order's status from Sato Hub, signature checked. deps: fetchImpl, origin, verifySignature, jwks, now. */
export async function orderStatus(orderId, { chain, payer }, deps = {}) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_:-]{4,128}$/.test(orderId)) throw new Error("that is not an order id");
  const d = { fetchImpl: globalThis.fetch, ...deps };
  const h = await hubFetch(`${d.origin ?? commerceOrigin()}${ORDER_PATH}/${encodeURIComponent(orderId)}?${new URLSearchParams({ payer })}`, { method: "GET" }, d);
  if (notEnabled(h)) throw NOT_ENABLED();
  if (h.status !== 200 || !h.json) throw new Error(`Sato Hub could not read order ${orderId} (HTTP ${h.status}${hubReason(h)})`);
  try {
    await (d.verifySignature ?? verifyHubSignature)(h.json, { maxAgeMs: QUOTE_MAX_AGE_MS, ...(d.now ? { now: d.now() } : {}), ...(d.jwks ? { jwks: d.jwks } : {}) });
  } catch (err) {
    throw refuse("order_unsigned", `Sato Hub's status for order ${orderId} could not be shown to come from Sato Hub (${clean(err.message, 200)})`);
  }
  const s = h.json;
  if (s.kind !== "commerce_order_status" || s.order_id !== orderId) throw refuse("order_unsigned", `Sato Hub's answer is not the status of order ${orderId}`);
  const refunded = s.refunded && typeof s.refunded === "object" ? { amount: clean(s.refunded.amount ?? "", 30), currency: clean(s.refunded.currency ?? "", 10) } : s.refunded === true ? true : null;
  return {
    order_id: orderId,
    chain,
    phase: PHASES.includes(s.phase) ? s.phase : clean(s.phase ?? "unknown", 30),
    payment_status: clean(s.payment_status ?? "unknown", 60),
    delivery: (Array.isArray(s.delivery) ? s.delivery : []).slice(0, 20).map((x) => ({ title: clean(x?.title ?? "item", 120), status: clean(x?.status ?? "unknown", 40) })),
    refunded,
    failure: s.failure ? clean(typeof s.failure === "object" ? `${s.failure.code ?? ""} ${s.failure.message ?? ""}` : s.failure, 200) : null,
    at: s.at ? clean(s.at, 40) : null,
  };
}

/** The orders this wallet paid (from the ledger), newest last: { order_id, chain, usd, title, status, tx }. */
export function localOrders() {
  return actions().filter((a) => a.kind === "order" && a.order_id).map((a) => ({ order_id: a.order_id, chain: a.chain, usd: a.usd, title: a.title ?? null, status: a.status, tx: a.tx ?? null, explorer: a.explorer, first_ts: a.first_ts }));
}

/** An order's status as plain lines. */
export function statusLines(s) {
  const lines = [`Order ${s.order_id} (${s.chain}): ${s.phase}, payment ${s.payment_status}${s.at ? ` (as of ${s.at})` : ""}`];
  for (const x of s.delivery) lines.push(`  ${x.title}: ${x.status}`);
  if (s.refunded) lines.push(`  Refunded${s.refunded === true ? "" : `: ${s.refunded.amount} ${s.refunded.currency}`} (to the paying wallet)`);
  if (s.failure) lines.push(`  Failure: ${s.failure}`);
  return lines;
}
