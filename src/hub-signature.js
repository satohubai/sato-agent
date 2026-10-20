// Check that a Sato Hub swap/quote response really came from Sato Hub, and was
// not changed on the way, BEFORE this kit signs anything inside it.
//
// WHY: the response carries the transaction the agent is about to sign. The
// transport is TLS, but the body also passes through proxies, MCP clients,
// caches and log pipelines. Sato Hub signs the body with an Ed25519 key it
// publishes at /.well-known/jwks.json, so the kit can check the exact `tx` it
// is holding is the one Sato Hub produced, and how old it is.
//
// WHAT A VALID SIGNATURE MEANS: origin and integrity, and a time. It does not
// say the transaction is a good idea and it does not say the owner approved
// it. The owner's limits and the kit's own checks still apply after this.
//
// THE SCHEME (Sato Hub lib/signing.ts + lib/signedJson.ts, pinned at
// https://satohub.ai/.well-known/sato-signing.json):
//
//   message = utf8(meta.signature.signed_at) || 0x0A
//             || utf8(canonicalJson(body with meta.signature removed))
//   signature = Ed25519 over message, raw 64 bytes, base64url, detached
//   kid = first 8 hex chars of sha256(raw 32-byte public key)
//
// The `meta` object itself stays in the signed form (only `meta.signature` is
// deleted). `meta.signature` is null when Sato Hub has no signing key set; a
// verifier must treat that as unsigned, which is what this does.
//
// Only node:crypto is used. Every network call has a timeout and names itself.

import { createHash, createPublicKey, verify } from "node:crypto";
import { userAgent } from "./version.js";

export const JWKS_URL = "https://satohub.ai/.well-known/jwks.json";
/**
 * The Sato Hub signing keys THIS version of the kit trusts, by kid, each with its raw public key (the JWK `x`). The live JWKS is
 * only ever used to FETCH one of these: a signature under any other kid, or a published key whose bytes differ from the pinned
 * ones, is refused, so a changed JWKS (a hijacked response, a cache, a proxy) cannot make the kit trust a new key. A kid is only
 * 8 hex characters of the key's hash, so the key itself is pinned too. When Sato Hub rotates its key, a new kit release adds the
 * new kid here (keep the old one while answers signed with it can still be in flight); an older kit refuses, and says to upgrade.
 * Checked 2026-10-19 against https://satohub.ai/.well-known/jwks.json (active_kid in sato-signing.json: b04bd38b).
 */
export const PINNED_HUB_KEYS = Object.freeze({
  b04bd38b: "O6p4TLC9-KCD0JOA8Uga4cpX5G56DhgOEE884qIk7Zg",
});
const FETCH_TIMEOUT_MS = 15_000;
// A signed_at slightly ahead of our clock is clock skew, not a forged future.
const CLOCK_SKEW_MS = 30_000;
// An unknown kid triggers ONE re-fetch (a key may have rotated), but never
// more than once a minute, so a stream of bad responses cannot hammer the endpoint.
const REFETCH_MIN_INTERVAL_MS = 60_000;
const JWKS_TTL_MS = 60 * 60_000; // the server sends max-age=3600

/**
 * For tests only: the pinned set that trusts exactly the keys of an injected JWKS (`{ keys: [{ kid, x }] }`). Production code never
 * injects a JWKS, so it is always held to PINNED_HUB_KEYS; the order-quote code passes this alongside the `jwks` it is given.
 */
export const pinnedFromJwks = (jwks) => Object.fromEntries((Array.isArray(jwks) ? jwks : jwks?.keys ?? []).filter((k) => k && typeof k.kid === "string" && typeof k.x === "string").map((k) => [k.kid, k.x]));

/** Why a response could not be shown to come from Sato Hub. `code` is stable; the message is for people. */
export class HubSignatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HubSignatureError";
    this.code = code;
  }
}

/**
 * canonicalJson, ported from Sato Hub lib/signing.ts `canonicalJson`. The two
 * MUST produce identical strings or nothing verifies:
 *   - object keys sorted by code point (the default string sort),
 *   - arrays keep their order (undefined inside an array becomes null),
 *   - no whitespace anywhere,
 *   - undefined and function values are dropped from objects,
 *   - scalars are exactly JSON.stringify's output.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const b64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// One JWKS per process. { keys, fetchedAt } or null.
let cache = null;

/** Forget the cached JWKS. Tests use this; the kit never needs to. */
export function resetJwksCache() {
  cache = null;
}

async function fetchJwks(fetchImpl, now) {
  let res;
  try {
    res = await fetchImpl(JWKS_URL, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new HubSignatureError("jwks_unavailable", `could not fetch Sato Hub's signing keys (${err.message}); nothing was signed`);
  }
  if (!res.ok) throw new HubSignatureError("jwks_unavailable", `Sato Hub's signing keys answered HTTP ${res.status}; nothing was signed`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new HubSignatureError("jwks_unavailable", "Sato Hub's signing keys were not valid JSON; nothing was signed");
  }
  if (!json || !Array.isArray(json.keys)) throw new HubSignatureError("jwks_unavailable", "Sato Hub's signing keys had no `keys` list; nothing was signed");
  cache = { keys: json.keys, fetchedAt: now };
  return json.keys;
}

async function findJwk(kid, { jwks, fetchImpl, now }) {
  const pick = (keys) => keys.find((k) => k && k.kid === kid);
  if (jwks) return pick(Array.isArray(jwks) ? jwks : jwks.keys ?? []);
  let keys = cache && now - cache.fetchedAt < JWKS_TTL_MS ? cache.keys : await fetchJwks(fetchImpl, now);
  let jwk = pick(keys);
  if (!jwk && cache.fetchedAt !== now && now - cache.fetchedAt >= REFETCH_MIN_INTERVAL_MS) {
    keys = await fetchJwks(fetchImpl, now); // a key may have rotated since we cached
    jwk = pick(keys);
  }
  return jwk;
}

/**
 * Verify `body` (a parsed swap/quote response, or an MCP `structuredContent`)
 * against Sato Hub's published key. Returns { ok: true, kid, signed_at } or
 * throws HubSignatureError (codes: missing_signature, unknown_kid,
 * bad_signature, stale, future, jwks_unavailable).
 *
 * `jwks` (a { keys } object) skips the network entirely; `now` and `fetchImpl`
 * exist so tests are offline and deterministic.
 */
export async function verifyHubSignature(body, { fetchImpl = fetch, now = Date.now(), maxAgeMs = 10 * 60 * 1000, jwks, pinned = PINNED_HUB_KEYS } = {}) {
  const sig = body?.meta?.signature;
  if (!sig || typeof sig !== "object") {
    throw new HubSignatureError("missing_signature", "this response is not signed by Sato Hub (meta.signature is missing or null); refusing to use it");
  }
  if (sig.alg !== "EdDSA" || typeof sig.kid !== "string" || typeof sig.sig !== "string" || typeof sig.signed_at !== "string") {
    throw new HubSignatureError("bad_signature", "the signature block is malformed (expected alg EdDSA with kid, sig and signed_at)");
  }

  // Only a key this kit version knows (before any network call). A rotated key is a reason to upgrade, never to trust the new one.
  const pinnedX = pinned && Object.hasOwn(pinned, sig.kid) ? pinned[sig.kid] : null;
  if (typeof pinnedX !== "string") {
    throw new HubSignatureError("unknown_kid", `the response was signed with key ${sig.kid}, which this version of the kit does not know (it knows ${Object.keys(pinned ?? {}).join(", ") || "none"}). Sato Hub may have rotated its signing key: upgrade the kit before swapping or bridging. Nothing was signed.`);
  }

  const jwk = await findJwk(sig.kid, { jwks, fetchImpl, now });
  if (!jwk) throw new HubSignatureError("unknown_kid", `the response was signed with key ${sig.kid}, which is not in Sato Hub's published keys`);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new HubSignatureError("unknown_kid", `key ${sig.kid} in the published keys is not an Ed25519 key`);
  }
  if (jwk.x !== pinnedX) {
    throw new HubSignatureError("unknown_kid", `the published key ${sig.kid} is not the key this version of the kit has pinned for that id; Sato Hub's published keys changed. Upgrade the kit before swapping or bridging. Nothing was signed.`);
  }
  // A kid is a label. It must also be the hash of the key it names.
  if (createHash("sha256").update(b64u(jwk.x)).digest("hex").slice(0, 8) !== sig.kid) {
    throw new HubSignatureError("unknown_kid", `key ${sig.kid} does not match its own public key`);
  }

  const { signature: _removed, ...metaRest } = body.meta;
  const message = Buffer.concat([Buffer.from(sig.signed_at, "utf8"), Buffer.from([0x0a]), Buffer.from(canonicalJson({ ...body, meta: metaRest }), "utf8")]);
  const raw = b64u(sig.sig);
  let good = false;
  try {
    good = raw.length === 64 && verify(null, message, createPublicKey({ key: jwk, format: "jwk" }), raw); // Ed25519: the algorithm argument is null
  } catch {
    good = false;
  }
  if (!good) throw new HubSignatureError("bad_signature", "the signature does not match this response: it was changed after Sato Hub signed it, or it did not come from Sato Hub");

  // Fresh enough? The signature itself never expires, so the kit enforces it.
  const signedAtMs = Date.parse(sig.signed_at);
  if (!Number.isFinite(signedAtMs)) throw new HubSignatureError("bad_signature", `signed_at is not a date: ${sig.signed_at}`);
  if (signedAtMs - now > CLOCK_SKEW_MS) throw new HubSignatureError("future", `the response is dated in the future (${sig.signed_at}); check this machine's clock`);
  if (now - signedAtMs > maxAgeMs) {
    throw new HubSignatureError("stale", `the response was signed ${Math.round((now - signedAtMs) / 1000)} s ago (limit ${Math.round(maxAgeMs / 1000)} s); ask for a new quote`);
  }
  return { ok: true, kid: sig.kid, signed_at: sig.signed_at };
}
