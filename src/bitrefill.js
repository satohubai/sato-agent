// Gift cards, eSIMs and top-ups from Bitrefill, paid by the agent's own wallet with
// x402 in USDC on Base. No Bitrefill account and no key: Bitrefill's wallet-only path.
//
//   sign in   POST /x402/connect answers 402 with a "sign-in-with-x" challenge. The kit
//             signs it ONLY if it is an EIP-4361 message for api.bitrefill.com, on Base
//             (chain id 8453), for the agent's own address, with no resources outside
//             api.bitrefill.com and an expiry within the hour (checkSiwxChallenge).
//             Anything else is refused (exit 3). This is the only place the kit ever
//             signs a message. The access token Bitrefill returns is kept in a 0600 file
//             with its expiry, and never printed or logged.
//   search    GET /x402/{gift-cards|esims|topups}/search?q=&country=
//   detail    GET /x402/products/detail?slug=   (the exact package values on offer)
//   invoice   POST /x402/invoice/create         (the price, held about 15 minutes)
//   approve   the price card is the owner's approval intent (purchase setting, src/purchase.js)
//   pay       POST /x402/invoice/pay, through the kit's own x402 payer (src/x402.js) with the
//             price bound to the invoice and the payee pinned to Bitrefill's address
//   deliver   GET /x402/invoice/status until `all_delivered` or a failure
//
// Codes are bearer secrets: anyone holding one can spend it. They are written to a 0600
// file under the agent's folder and printed once, on one clearly labelled line of the
// command's final output. They never go in the ledger, an error message or a log.
//
// No Sato Hub fee is charged on gift cards. Sato Hub may earn Bitrefill's affiliate
// commission instead (BITREFILL_REF below).

import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseSiweMessage } from "viem/siwe";
import { getAddress } from "viem";
import { loadPolicy } from "./policy.js";
import { record } from "./ledger.js";
import { Refused } from "./errors.js";
import { evmAccount } from "./wallet.js";
import { home, ensureHome, readJson, writePrivate } from "./store.js";
import { usdcUnits, unitsToUsd } from "./amount.js";
import { clean } from "./text.js";
import { USER_AGENT } from "./version.js";
import { pay } from "./x402.js";
import { checkLimits, purchaseGate, refuse } from "./purchase.js";

export const BITREFILL_API = "https://api.bitrefill.com";
export const BITREFILL_DOMAIN = "api.bitrefill.com";
/** Bitrefill's x402 payee on Base (its wallet-only docs, and every 402 it served on 2026-10-09). A payment to anyone else is refused. */
export const BITREFILL_PAY_TO = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
/**
 * Sato Hub's Bitrefill affiliate code. Empty until the owner's application is approved. Bitrefill documents `?ref=` only on
 * its MCP URL, and the wallet-only x402 path this kit uses documents no referral parameter, so it is not appended anywhere
 * yet. When Bitrefill documents one for this path, it is added here and only where they document it.
 */
export const BITREFILL_REF = "";
/** The one chain a Bitrefill sign-in is signed for. */
export const SIWX_CHAIN = "eip155:8453";
export const SIWX_CHAIN_ID = 8453;
/** The latest expiry the kit accepts on a sign-in message. */
export const SIWX_MAX_EXPIRY_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 512 * 1024;
const SEARCH_KINDS = { giftcard: "gift-cards", esim: "esims", topup: "topups" };
const FAILED = ["blocked", "denied", "payment_error", "failed", "refunded", "expired", "cancelled", "canceled"];

const sessionFile = () => join(home(), "bitrefill-session.json");
const codesDir = () => join(home(), "giftcards");
export const codesFile = (invoiceId) => join(codesDir(), `${invoiceId}.json`);

function defaults(deps = {}) {
  return {
    ...deps,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    base: deps.base ?? BITREFILL_API,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

// ---------------------------------------------------------------- sign-in (SIWX, EIP-4361)

const isHttpsBitrefill = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && x.hostname === BITREFILL_DOMAIN && x.port === "" && !x.username && !x.password;
  } catch {
    return false;
  }
};
const badText = (s) => typeof s !== "string" || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);

/**
 * Check a sign-in-with-x challenge and build the EIP-4361 message the kit would sign. Throws Refused (rule
 * `siwx_refused`) unless the message is for api.bitrefill.com, chain 8453, the agent's own address, only Bitrefill's
 * own resources, and a sane expiry. Returns { message, payload } (payload: the fields Bitrefill expects back, without the
 * signature). Pure: no network, no key.
 */
export function checkSiwxChallenge(challenge, { address, now = Date.now() }) {
  const problems = [];
  const info = challenge?.info;
  if (!info || typeof info !== "object") throw refuse("siwx_refused", "Bitrefill's sign-in challenge could not be read; nothing was signed");
  const me = getAddress(address); // EIP-55: Bitrefill refuses a lower-case address
  if (info.domain !== BITREFILL_DOMAIN) problems.push(`the message is for ${clean(info.domain ?? "no domain", 80)}, not ${BITREFILL_DOMAIN}`);
  if (typeof info.uri !== "string" || !isHttpsBitrefill(info.uri) || badText(info.uri)) problems.push(`its URI ${clean(info.uri ?? "(none)", 120)} is not on https://${BITREFILL_DOMAIN}`);
  if (info.version !== undefined && String(info.version) !== "1") problems.push(`its version is ${clean(info.version, 20)}, not 1`);
  const chains = challenge.supportedChains ?? info.supportedChains ?? [];
  const base = Array.isArray(chains) && chains.find((c) => c && c.chainId === SIWX_CHAIN && (c.type === undefined || c.type === "eip191"));
  if (!base) problems.push("it does not offer Base (eip155:8453) with a personal_sign (eip191) signature");
  if (info.chainId !== undefined && !(info.chainId === SIWX_CHAIN || String(info.chainId) === String(SIWX_CHAIN_ID))) problems.push(`it names chain ${clean(info.chainId, 40)}, not Base`);
  if (info.address !== undefined && (typeof info.address !== "string" || info.address.toLowerCase() !== me.toLowerCase())) problems.push("it names an address that is not this agent's");
  if (typeof info.nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(info.nonce)) problems.push("its nonce is not 8 or more letters and digits");
  if (info.statement !== undefined && info.statement !== null && (badText(info.statement) || info.statement.length > 500)) problems.push("its statement is not one plain line");
  const issued = Date.parse(info.issuedAt);
  if (typeof info.issuedAt !== "string" || badText(info.issuedAt) || !Number.isFinite(issued) || Math.abs(issued - now) > CLOCK_SKEW_MS) problems.push("its issue time is missing or not near now");
  const expires = Date.parse(info.expirationTime);
  if (typeof info.expirationTime !== "string" || badText(info.expirationTime) || !Number.isFinite(expires)) problems.push("it has no expiry");
  else if (expires <= now) problems.push("it has already expired");
  else if (expires - now > SIWX_MAX_EXPIRY_MS) problems.push(`it stays valid until ${clean(info.expirationTime, 40)}, more than ${SIWX_MAX_EXPIRY_MS / 60000} minutes from now`);
  if (info.notBefore !== undefined && (typeof info.notBefore !== "string" || badText(info.notBefore) || !Number.isFinite(Date.parse(info.notBefore)))) problems.push("its not-before time is not a date");
  if (info.requestId !== undefined && (typeof info.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(info.requestId))) problems.push("its request id is not plain text");
  const resources = info.resources ?? [];
  if (!Array.isArray(resources) || resources.length > 10) problems.push("its resources are not a short list");
  else for (const r of resources) if (typeof r !== "string" || badText(r) || !isHttpsBitrefill(r)) problems.push(`it lists a resource outside ${BITREFILL_DOMAIN} (${clean(r, 120)})`);
  if (problems.length) throw new Refused([{ rule: "siwx_refused", limit: `an EIP-4361 sign-in for ${BITREFILL_DOMAIN} on Base, for this agent's address`, observed: clean(problems.join("; "), 400), message: `refused to sign Bitrefill's sign-in message: ${problems.join("; ")}. Nothing was signed.` }]);

  const lines = [`${info.domain} wants you to sign in with your Ethereum account:`, me, ""];
  if (info.statement) lines.push(info.statement, "");
  lines.push(`URI: ${info.uri}`, "Version: 1", `Chain ID: ${SIWX_CHAIN_ID}`, `Nonce: ${info.nonce}`, `Issued At: ${info.issuedAt}`, `Expiration Time: ${info.expirationTime}`);
  if (info.notBefore) lines.push(`Not Before: ${info.notBefore}`);
  if (info.requestId) lines.push(`Request ID: ${info.requestId}`);
  if (resources.length) lines.push("Resources:", ...resources.map((r) => `- ${r}`));
  const message = lines.join("\n");
  // Belt and braces: read the message back the way a verifier would, and check the fields that matter again.
  const p = parseSiweMessage(message);
  if (p.domain !== BITREFILL_DOMAIN || p.address !== me || p.chainId !== SIWX_CHAIN_ID || p.uri !== info.uri || p.nonce !== info.nonce) {
    throw refuse("siwx_refused", "Bitrefill's sign-in message did not read back as the message that was checked; nothing was signed");
  }
  const payload = {
    domain: info.domain,
    address: me,
    ...(info.statement ? { statement: info.statement } : {}),
    uri: info.uri,
    version: "1",
    chainId: SIWX_CHAIN,
    type: "eip191",
    nonce: info.nonce,
    issuedAt: info.issuedAt,
    expirationTime: info.expirationTime,
    ...(info.notBefore ? { notBefore: info.notBefore } : {}),
    ...(info.requestId ? { requestId: info.requestId } : {}),
    resources,
  };
  return { message, payload };
}

/** The sign-in-with-x challenge from a 402: the JSON body's `extensions`, else the PAYMENT-REQUIRED header's. */
function challengeOf(res) {
  const pick = (obj) => {
    const ext = obj?.extensions?.["sign-in-with-x"];
    return ext ? { info: ext.info, supportedChains: ext.supportedChains ?? ext.info?.supportedChains ?? obj.supportedChains } : null;
  };
  let c = pick(res.json);
  if (!c) {
    try {
      c = pick(JSON.parse(Buffer.from(String(res.headers.get("payment-required") ?? ""), "base64").toString("utf8")));
    } catch {
      c = null;
    }
  }
  return c;
}

// ---------------------------------------------------------------- HTTP

/** One request to Bitrefill. Never throws with the body in the message. Returns { status, json, headers }. */
async function request(d, method, path, { body, token, siwx } = {}) {
  const headers = { "user-agent": USER_AGENT, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-access-token"] = token;
  if (siwx) headers["sign-in-with-x"] = siwx;
  let res;
  try {
    res = await d.fetchImpl(`${d.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Bitrefill did not answer (${err.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : clean(err.message, 120)})`);
  }
  let json = null;
  try {
    const text = await res.text();
    if (text.length <= MAX_BODY_BYTES) json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

/** Bitrefill's own error code or message, short and cleaned, for an error line (never the body). */
const reasonOf = (r) => {
  const e = r.json?.error ?? r.json?.code ?? r.json?.message;
  return typeof e === "string" ? `: ${clean(e, 120)}` : "";
};

function loadSession(address, now) {
  const s = readJson(sessionFile());
  if (!s || typeof s.token !== "string" || s.address !== address) return null;
  return Date.parse(s.expires_at) - now > 2 * 60 * 1000 ? s.token : null;
}
function clearSession() {
  try {
    fs.rmSync(sessionFile(), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * A Bitrefill access token for the agent's Base address: the saved one while it is valid, else a new sign-in. Throws
 * Refused when the challenge is not one the kit signs, Error when Bitrefill does not answer as documented.
 */
export async function signIn(deps = {}, { fresh = false } = {}) {
  const d = defaults(deps);
  const account = d.account ?? evmAccount();
  const address = getAddress(account.address);
  if (!fresh) {
    const t = loadSession(address, d.now());
    if (t) return t;
  }
  const first = await request(d, "POST", "/x402/connect", { body: {} });
  if (first.status !== 402) throw new Error(`Bitrefill's sign-in answered HTTP ${first.status} instead of asking for a signature${reasonOf(first)}; nothing was signed`);
  const challenge = challengeOf(first);
  if (!challenge) throw refuse("siwx_refused", "Bitrefill's sign-in did not include a sign-in-with-x challenge; nothing was signed");
  const { message, payload } = checkSiwxChallenge(challenge, { address, now: d.now() });
  // The kit's only message signature: an EIP-4361 sign-in that passed every check above.
  const signature = await account.signMessage({ message });
  const header = Buffer.from(JSON.stringify({ ...payload, signature }), "utf8").toString("base64");
  const second = await request(d, "POST", "/x402/connect", { body: {}, siwx: header });
  const token = second.json?.token;
  const ttl = Number(second.json?.expires_in);
  if (second.status !== 200 || typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]{10,8192}$/.test(token)) {
    throw new Error(`Bitrefill did not accept the sign-in (HTTP ${second.status}${reasonOf(second)}); nothing was paid`);
  }
  const expiresAt = new Date(d.now() + (Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 24 * 3600) : 3600) * 1000).toISOString();
  writePrivate(sessionFile(), JSON.stringify({ service: "bitrefill", address, token, expires_at: expiresAt }, null, 2) + "\n", { atomic: true });
  // The signature is in the ledger as an event (what was signed in to, and until when); the token never is.
  record({ kind: "signin", status: "signed_in", service: "bitrefill", domain: BITREFILL_DOMAIN, chain_id: SIWX_CHAIN, address, message_expires_at: payload.expirationTime, session_expires_at: expiresAt });
  return token;
}

/** An authenticated request; a token Bitrefill no longer takes is replaced by one fresh sign-in, once. */
async function authed(d, method, path, opts = {}) {
  let token = await signIn(d);
  let r = await request(d, method, path, { ...opts, token });
  if (r.status === 401 || r.status === 402 || r.status === 403) {
    clearSession();
    token = await signIn(d, { fresh: true });
    r = await request(d, method, path, { ...opts, token });
  }
  if (r.status === 402) throw new Error(`Bitrefill asked to be paid for ${path.split("?")[0]} even after signing in; nothing was paid`);
  return { ...r, token };
}

// ---------------------------------------------------------------- catalogue

const slugOk = (s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s);

/** Search Bitrefill's catalogue. `kind`: giftcard (default), esim or topup. Read-only; nothing is paid. */
export async function searchProducts(q, { country, kind = "giftcard" } = {}, deps = {}) {
  const d = defaults(deps);
  if (!SEARCH_KINDS[kind]) throw new Error("--kind must be giftcard, esim or topup");
  if (typeof q !== "string" || !q.trim() || q.length > 100) throw new Error("search needs a few words, like `amazon` or `steam`");
  if (country !== undefined && !/^[A-Za-z]{2}$/.test(country)) throw new Error("--country must be a two-letter country code, like US");
  const qs = new URLSearchParams({ q: q.trim(), ...(country ? { country: country.toUpperCase() } : {}) });
  const r = await authed(d, "GET", `/x402/${SEARCH_KINDS[kind]}/search?${qs}`);
  if (r.status !== 200 || !Array.isArray(r.json?.products)) throw new Error(`Bitrefill's search answered HTTP ${r.status}${reasonOf(r)}`);
  return r.json.products.slice(0, 25).filter((p) => p && slugOk(p.slug)).map((p) => ({
    slug: p.slug,
    name: clean(p.name ?? p.slug, 80),
    country: typeof p.country === "string" ? clean(p.country, 10) : null,
    in_stock: p.in_stock !== false,
    recipient_type: typeof p.recipient_type === "string" ? clean(p.recipient_type, 30) : null,
  }));
}

/** One product's packages (the exact values on offer). */
export async function productDetail(slug, deps = {}) {
  const d = defaults(deps);
  if (!slugOk(slug)) throw new Error(`"${clean(slug, 60)}" is not a Bitrefill product id (use the id from \`giftcard search\`)`);
  const r = await authed(d, "GET", `/x402/products/detail?${new URLSearchParams({ slug })}`);
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.packages)) throw new Error(`Bitrefill has no product "${clean(slug, 60)}" (HTTP ${r.status}${reasonOf(r)})`);
  const j = r.json;
  return {
    id: slugOk(j.id) ? j.id : slug,
    name: clean(j.name ?? slug, 80),
    in_stock: j.in_stock !== false,
    recipient_required: j.recipient_required === true,
    currency: typeof j.currency === "string" ? clean(j.currency, 10) : null,
    packages: j.packages.filter((p) => p && (typeof p.package_value === "string" || typeof p.package_value === "number")).map((p) => ({ value: String(p.package_value), currency: typeof p.package_currency === "string" ? clean(p.package_currency, 10) : null })),
  };
}

/** Create an invoice: Bitrefill's price for one package, held for a few minutes. */
export async function createInvoice({ product, value, refill }, deps = {}) {
  const d = defaults(deps);
  const item = { product_id: product, package_value: value, ...(refill ? { refill_input: refill } : {}) };
  const r = await authed(d, "POST", "/x402/invoice/create", { body: { items: [item] } });
  const j = r.json ?? {};
  if (r.status !== 200 && r.status !== 201) throw new Error(`Bitrefill could not create the invoice (HTTP ${r.status}${reasonOf(r)}); nothing was paid`);
  if (typeof j.invoice_id !== "string" || !/^[A-Za-z0-9_-]{6,100}$/.test(j.invoice_id)) throw new Error("Bitrefill's invoice has no usable id; nothing was paid");
  const price = String(j.price_usdc ?? "");
  let units;
  try {
    units = usdcUnits(price);
  } catch {
    throw new Error(`Bitrefill's invoice price "${clean(price, 30)}" is not a USDC amount; nothing was paid`);
  }
  const minutes = Number(j.expires_in_minutes);
  return {
    invoice_id: j.invoice_id,
    price_usdc: price,
    usd: unitsToUsd(units),
    price_usd: typeof j.price_usd === "number" || typeof j.price_usd === "string" ? clean(j.price_usd, 30) : null,
    expires_at: new Date(d.now() + (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 60) : 15) * 60_000).toISOString(),
    token: r.token,
  };
}

// ---------------------------------------------------------------- delivery and codes

/** The redemption details in a status answer, as plain one-line strings. Secret: never logged. */
export function codesOf(json) {
  const orders = json?.redemption_info?.orders ?? json?.orders ?? [];
  const out = [];
  for (const o of Array.isArray(orders) ? orders : []) {
    const ri = o?.redemption_info ?? o;
    if (!ri || typeof ri !== "object") continue;
    const one = {};
    for (const k of ["code", "pin", "link"]) if (typeof ri[k] === "string" && ri[k].trim()) one[k] = clean(ri[k], 500);
    if (ri.extra_fields && typeof ri.extra_fields === "object") {
      const extra = Object.entries(ri.extra_fields).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => `${clean(k, 40)} ${clean(v, 300)}`);
      if (extra.length) one.extra = extra.join(", ");
    }
    if (Object.keys(one).length) out.push(one);
  }
  return out;
}

/** The one labelled line the codes are printed on. */
export function codesLine(codes) {
  const parts = codes.map((c) => [c.code && `code ${c.code}`, c.pin && `PIN ${c.pin}`, c.link && `link ${c.link}`, c.extra].filter(Boolean).join(", "));
  return `GIFT CARD CODE (secret: for the owner only; never post, log or share it): ${parts.join(" | ")}`;
}

/** Keep the codes in a file only the agent's user can read. Returns the path. */
export function saveCodes(invoiceId, product, codes) {
  ensureHome();
  fs.mkdirSync(codesDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(codesDir(), 0o700);
  const path = codesFile(invoiceId);
  writePrivate(path, JSON.stringify({ invoice_id: invoiceId, product, saved_at: new Date().toISOString(), codes }, null, 2) + "\n", { atomic: true });
  return path;
}

/** The saved codes for an invoice, or null. */
export function savedCodes(invoiceId) {
  return /^[A-Za-z0-9_-]{6,100}$/.test(String(invoiceId)) ? readJson(codesFile(invoiceId))?.codes ?? null : null;
}

/**
 * One status read. Returns { state: "delivered" | "failed" | "pending", invoice_status, delivery_status, codes }. On a
 * failed read it is "pending" with a reason that never carries the body.
 */
export async function invoiceStatus(invoiceId, deps = {}) {
  const d = defaults(deps);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(String(invoiceId))) throw new Error("that is not a Bitrefill invoice id");
  let r;
  try {
    r = await authed(d, "GET", `/x402/invoice/status?${new URLSearchParams({ invoice_id: invoiceId })}`);
  } catch (err) {
    return { state: "pending", invoice_status: null, delivery_status: null, codes: [], reason: clean(err.message, 200) };
  }
  if (r.status !== 200 || !r.json) return { state: "pending", invoice_status: null, delivery_status: null, codes: [], reason: `Bitrefill's status answered HTTP ${r.status}` };
  const inv = typeof (r.json.invoice_status ?? r.json.status) === "string" ? clean(r.json.invoice_status ?? r.json.status, 40) : null;
  const del = typeof r.json.delivery_status === "string" ? clean(r.json.delivery_status, 40) : null;
  const codes = codesOf(r.json);
  if (del === "all_delivered") return { state: "delivered", invoice_status: inv, delivery_status: del, codes };
  if (FAILED.includes(String(inv).toLowerCase()) || ["failed", "partially_failed", "partially_delivered_failed"].includes(String(del).toLowerCase())) {
    return { state: "failed", invoice_status: inv, delivery_status: del, codes };
  }
  return { state: "pending", invoice_status: inv, delivery_status: del, codes };
}

/** Poll until delivered or failed (or `maxPolls` reads). */
export async function waitForDelivery(invoiceId, deps = {}) {
  const d = defaults(deps);
  let last = null;
  for (let i = 0; i < (d.maxPolls ?? 60); i++) {
    if (i > 0) await d.sleep(d.pollMs ?? 3000);
    last = await invoiceStatus(invoiceId, d);
    if (last.state !== "pending") return last;
  }
  return last;
}

// ---------------------------------------------------------------- buy

/** Gift cards are paid on Base. A Solana-only agent gets a plain explanation (exit 3). */
export function assertBaseAgent(policy = loadPolicy()) {
  if (policy && Array.isArray(policy.chains) && !policy.chains.includes("base")) {
    throw refuse("giftcards_base_only", "gift cards, eSIMs and top-ups are paid in USDC on Base for now, and this agent works on Solana only. Nothing was bought.", ["base"], policy.chains);
  }
}

const sha16 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

/**
 * Buy one package of one product. Returns the outcome; the caller prints it (and the codes, on one line, last).
 * `refill`: the phone number or account a top-up goes to (only where Bitrefill says the product needs one).
 * deps: fetchImpl, base, account, now, sleep, pollMs, maxPolls, payImpl (tests).
 */
export async function buyGiftcard({ product, value, refill, approve, dryRun = false }, deps = {}) {
  const d = defaults(deps);
  const policy = loadPolicy();
  assertBaseAgent(policy); // a Solana-only agent gets the plain reason, not a chain refusal
  checkLimits({ usd: undefined, chain: "base" }, policy); // limits and chains first, before any network
  if (!slugOk(product)) throw new Error(`"${clean(product, 60)}" is not a Bitrefill product id (use the id from \`giftcard search\`)`);
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) throw new Error("--value must be one of the product's package values, like 25");
  if (refill !== undefined && (badText(refill) || refill.length > 100)) throw new Error("--refill must be one plain line");

  const detail = await productDetail(product, d);
  const pkg = detail.packages.find((p) => p.value === value);
  if (!pkg) throw new Error(`${detail.name} has no package of ${value}; it offers ${detail.packages.map((p) => p.value).join(", ") || "none right now"}`);
  if (!detail.in_stock) throw refuse("out_of_stock", `${detail.name} is out of stock at Bitrefill right now; nothing was bought`);
  if (detail.recipient_required && !refill) throw new Error(`${detail.name} needs the phone number or account it goes to: add --refill <it>`);

  const inv = await createInvoice({ product: detail.id, value: pkg.value, refill: detail.recipient_required ? refill : undefined }, d);
  checkLimits({ usd: inv.usd, chain: "base", to: BITREFILL_PAY_TO }, policy);
  const currency = pkg.currency ?? detail.currency ?? "";
  const card = [
    `Gift card: ${detail.name} (${detail.id}), value ${pkg.value}${currency ? ` ${currency}` : ""}${detail.recipient_required ? " (goes to the number or account given)" : ""}`,
    `Price: ${inv.price_usdc} USDC on Base, paid to Bitrefill (${BITREFILL_PAY_TO}). No Sato Hub fee.`,
    `Price held until ${inv.expires_at.replace(/\.\d+Z$/, "Z")} (invoice ${inv.invoice_id}).`,
    "The code is shown to you once Bitrefill delivers it, and kept in a private file on this computer.",
  ];
  // The owner approves this product, value and price, paid to this payee. A new run that gets another price asks again.
  const intent = { cmd: "giftcard", chain: "base", product: detail.id, value: pkg.value, price_usdc: inv.price_usdc, pay_to: BITREFILL_PAY_TO, ...(refill ? { refill_sha256: sha16(refill) } : {}) };
  if (dryRun) return { dry_run: true, card, invoice_id: inv.invoice_id, price_usdc: inv.price_usdc, usd: inv.usd, expires_at: inv.expires_at, product: detail.id, value: pkg.value };
  await purchaseGate(intent, { approve, card }, policy);

  // Paid through the kit's own x402 payer: the price is bound to the invoice and the payee pinned. The access token goes
  // in its own header (Bitrefill's), never in the ledger.
  const r = await (d.payImpl ?? pay)(`${d.base}/x402/invoice/pay`, {
    chain: "base",
    method: "POST",
    body: JSON.stringify({ invoice_id: inv.invoice_id }),
    headers: { "content-type": "application/json", "x-access-token": inv.token },
    maxUsd: inv.usd,
    payTo: BITREFILL_PAY_TO,
    tag: { purchase: "giftcard", invoice_id: inv.invoice_id, product: detail.id },
    ...(d.account ? { account: d.account } : {}),
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
  });
  if (!r.signed) throw new Error(`Bitrefill did not ask for payment of invoice ${inv.invoice_id} (HTTP ${r.status}); nothing was paid`);

  const st = await waitForDelivery(inv.invoice_id, d);
  let codesPath = null;
  if (st.state === "delivered" && st.codes.length) {
    codesPath = saveCodes(inv.invoice_id, detail.id, st.codes);
    record({ kind: "giftcard", status: "delivered", invoice_id: inv.invoice_id, product: detail.id, codes_saved: true });
  } else if (st.state === "failed") {
    record({ kind: "giftcard", status: "failed", invoice_id: inv.invoice_id, product: detail.id, invoice_status: st.invoice_status, delivery_status: st.delivery_status });
  }
  return { card, invoice_id: inv.invoice_id, product: detail.id, value: pkg.value, price_usdc: inv.price_usdc, payment: r, delivery: st, codes_path: codesPath };
}
