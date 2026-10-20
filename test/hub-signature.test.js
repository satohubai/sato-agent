// Offline: a REAL signed Sato Hub swap response (recorded once, kept in
// test/fixtures/hub/) and the JWKS it was signed under. No test here touches
// the network, and none may: every live swap call writes a public record.

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import { HubSignatureError, JWKS_URL, PINNED_HUB_KEYS, canonicalJson, resetJwksCache, verifyHubSignature } from "../src/hub-signature.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/hub/${name}`, import.meta.url), "utf8"));
const real = () => load("swap.json");
const jwks = load("jwks.json");
const signedAtMs = Date.parse(real().meta.signature.signed_at);

beforeEach(() => resetJwksCache());

const fails = (code) => (e) => e instanceof HubSignatureError && e.code === code;
const noNetwork = () => {
  throw new Error("the network must not be touched");
};

test("the real recorded response verifies (injected JWKS, no network)", async () => {
  const r = await verifyHubSignature(real(), { jwks, now: signedAtMs, fetchImpl: noNetwork });
  assert.deepEqual(r, { ok: true, kid: "b04bd38b", signed_at: "2026-10-09T04:48:18.692Z" });
});

test("it also verifies a few seconds later, and key order in the parsed body does not matter", async () => {
  const b = real();
  const shuffled = Object.fromEntries(Object.entries(b).reverse());
  assert.equal((await verifyHubSignature(shuffled, { jwks, now: signedAtMs + 5_000 })).ok, true);
});

test("one changed field fails", async () => {
  for (const mutate of [
    (b) => (b.amount_out = "1"),
    (b) => (b.sato_fee_recipient = "0x000000000000000000000000000000000000dEaD"),
    (b) => (b.meta.extra = "added"),
    (b) => (b.sato_fee_bps = 0),
  ]) {
    const b = real();
    mutate(b);
    await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("bad_signature"));
  }
});

test("a removed or null signature fails as unsigned", async () => {
  const a = real();
  delete a.meta.signature;
  await assert.rejects(verifyHubSignature(a, { jwks, now: signedAtMs }), fails("missing_signature"));
  const b = real();
  b.meta.signature = null; // what Sato Hub sends when it has no signing key
  await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("missing_signature"));
  await assert.rejects(verifyHubSignature({ no: "meta" }, { jwks, now: signedAtMs }), fails("missing_signature"));
  await assert.rejects(verifyHubSignature(null, { jwks, now: signedAtMs }), fails("missing_signature"));
});

test("an unknown kid fails", async () => {
  const b = real();
  b.meta.signature.kid = "deadbeef";
  await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("unknown_kid"));
});

test("a kid that is not the hash of the key it names fails", async () => {
  const lying = { keys: [{ ...jwks.keys[0], kid: "b04bd38c" }] };
  const b = real();
  b.meta.signature.kid = "b04bd38c";
  await assert.rejects(verifyHubSignature(b, { jwks: lying, now: signedAtMs }), fails("unknown_kid"));
});

test("a different key under the right kid label cannot vouch for the response", async () => {
  // A valid Ed25519 public key (RFC 8032 test vector 1) wearing our kid.
  const imposter = { keys: [{ kty: "OKP", crv: "Ed25519", kid: "b04bd38b", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] };
  await assert.rejects(verifyHubSignature(real(), { jwks: imposter, now: signedAtMs }), fails("unknown_kid"));
});

test("too old fails, and the age limit is adjustable", async () => {
  const old = signedAtMs + 11 * 60 * 1000;
  await assert.rejects(verifyHubSignature(real(), { jwks, now: old }), fails("stale"));
  assert.equal((await verifyHubSignature(real(), { jwks, now: old, maxAgeMs: 60 * 60 * 1000 })).ok, true);
  await assert.rejects(verifyHubSignature(real(), { jwks, now: signedAtMs + 61_000, maxAgeMs: 60_000 }), fails("stale"));
});

test("dated in the future fails (a little clock skew is allowed)", async () => {
  await assert.rejects(verifyHubSignature(real(), { jwks, now: signedAtMs - 5 * 60 * 1000 }), fails("future"));
  assert.equal((await verifyHubSignature(real(), { jwks, now: signedAtMs - 10_000 })).ok, true);
});

test("a malformed signature block fails", async () => {
  const b = real();
  b.meta.signature.alg = "RS256";
  await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("bad_signature"));
  const c = real();
  c.meta.signature.sig = "AAAA";
  await assert.rejects(verifyHubSignature(c, { jwks, now: signedAtMs }), fails("bad_signature"));
});

const jwksResponse = (obj = jwks, status = 200) => ({ ok: status === 200, status, json: async () => obj });

test("without an injected JWKS it fetches once, with a timeout and a user-agent, and caches", async () => {
  let calls = 0;
  let seen;
  const fetchImpl = async (url, init) => {
    calls += 1;
    seen = { url, init };
    return jwksResponse();
  };
  assert.equal((await verifyHubSignature(real(), { fetchImpl, now: signedAtMs })).ok, true);
  assert.equal((await verifyHubSignature(real(), { fetchImpl, now: signedAtMs + 1000 })).ok, true);
  assert.equal(calls, 1, "the second check uses the cached keys");
  assert.equal(seen.url, JWKS_URL);
  assert.match(seen.init.headers["user-agent"], /^sato-agent\/\d/);
  assert.ok(seen.init.signal instanceof AbortSignal, "every fetch has a timeout signal");
});

test("an unknown kid re-fetches at most once a minute", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jwksResponse({ keys: [] });
  };
  await assert.rejects(verifyHubSignature(real(), { fetchImpl, now: signedAtMs }), fails("unknown_kid"));
  assert.equal(calls, 1, "a fresh fetch is not repeated");
  await assert.rejects(verifyHubSignature(real(), { fetchImpl, now: signedAtMs + 10_000 }), fails("unknown_kid"));
  assert.equal(calls, 1, "within a minute: no new fetch");
  await assert.rejects(verifyHubSignature(real(), { fetchImpl, now: signedAtMs + 70_000 }), fails("unknown_kid"));
  assert.equal(calls, 2, "after a minute: one re-fetch, in case the key rotated");
});

test("a rotated key is picked up by that re-fetch", async () => {
  let served = { keys: [] };
  const fetchImpl = async () => jwksResponse(served);
  await assert.rejects(verifyHubSignature(real(), { fetchImpl, now: signedAtMs - 5_000 }), fails("unknown_kid"));
  served = jwks;
  assert.equal((await verifyHubSignature(real(), { fetchImpl, now: signedAtMs + 60_000 })).ok, true);
});

test("JWKS unavailable: a network error, an HTTP error and a bad body all say so", async () => {
  await assert.rejects(verifyHubSignature(real(), { fetchImpl: async () => { throw new Error("boom"); }, now: signedAtMs }), fails("jwks_unavailable"));
  await assert.rejects(verifyHubSignature(real(), { fetchImpl: async () => jwksResponse({}, 503), now: signedAtMs }), fails("jwks_unavailable"));
  await assert.rejects(verifyHubSignature(real(), { fetchImpl: async () => jwksResponse({ nope: 1 }), now: signedAtMs }), fails("jwks_unavailable"));
  await assert.rejects(
    verifyHubSignature(real(), { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }), now: signedAtMs }),
    fails("jwks_unavailable"),
  );
});

test("canonicalJson matches the server's definition", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, undefined, { z: null, y: undefined }], "é": "x" }), '{"a":[3,null,{"z":null}],"b":1,"é":"x"}');
  assert.equal(canonicalJson("a\"b"), '"a\\"b"');
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson({ f() {}, n: 1.5 }), '{"n":1.5}');
});

// ---- the pinned key set (v0.5.4): the live JWKS can only deliver a key this kit version already knows

/** A second Sato-style signing key and a response signed with it (what a rotation would look like). */
function rotated() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  const kid = createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 8);
  const body = { ...real() };
  body.meta = { ...body.meta };
  delete body.meta.signature;
  const signedAt = new Date(signedAtMs).toISOString();
  const message = Buffer.concat([Buffer.from(signedAt, "utf8"), Buffer.from([0x0a]), Buffer.from(canonicalJson(body), "utf8")]);
  body.meta.signature = { alg: "EdDSA", kid, sig: sign(null, message, privateKey).toString("base64url"), signed_at: signedAt };
  return { body, kid, x, jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] } };
}

test("the kit ships Sato Hub's current key id, and it is the hash of its public key", () => {
  assert.deepEqual(Object.keys(PINNED_HUB_KEYS), ["b04bd38b"]);
  for (const [kid, x] of Object.entries(PINNED_HUB_KEYS)) assert.equal(createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 8), kid);
  assert.equal(PINNED_HUB_KEYS.b04bd38b, jwks.keys[0].x, "the recorded, real JWKS carries the pinned key");
  assert.throws(() => { PINNED_HUB_KEYS.deadbeef = "x"; }, TypeError, "the set cannot be changed at run time");
});

test("a rotated key is refused with a plain 'upgrade the kit' message, and the network is not even asked", async () => {
  const r = rotated();
  assert.notEqual(r.kid, "b04bd38b");
  // a perfectly valid signature by a key that the live JWKS publishes: still not a key this kit version knows
  const err = await verifyHubSignature(r.body, { fetchImpl: noNetwork, now: signedAtMs }).catch((e) => e);
  assert.ok(fails("unknown_kid")(err), String(err));
  assert.match(err.message, new RegExp(`key ${r.kid}, which this version of the kit does not know`));
  assert.match(err.message, /rotated its signing key: upgrade the kit/);
  assert.match(err.message, /Nothing was signed/);
  // the same with the JWKS injected
  await assert.rejects(verifyHubSignature(r.body, { jwks: r.jwks, now: signedAtMs }), fails("unknown_kid"));
  // a later kit release that pins the new key (alongside the old one) accepts it, and still accepts the old key's answers
  const both = { ...PINNED_HUB_KEYS, [r.kid]: r.x };
  assert.equal((await verifyHubSignature(r.body, { jwks: r.jwks, now: signedAtMs, pinned: both })).kid, r.kid);
  assert.equal((await verifyHubSignature(real(), { jwks, now: signedAtMs, pinned: both })).kid, "b04bd38b");
});

test("a published key whose bytes differ from the pinned ones is refused even under the pinned kid", async () => {
  // a key that only has the right 8-hex label is not enough: the pinned key itself is compared
  const imposter = { keys: [{ ...jwks.keys[0], x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] };
  const err = await verifyHubSignature(real(), { jwks: imposter, now: signedAtMs, pinned: { b04bd38b: jwks.keys[0].x } }).catch((e) => e);
  assert.ok(fails("unknown_kid")(err));
  assert.match(err.message, /not the key this version of the kit has pinned/);
  assert.match(err.message, /Upgrade the kit/);
});

test("an inherited property name is not a pinned kid", async () => {
  const b = real();
  b.meta.signature.kid = "constructor";
  await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("unknown_kid"));
  b.meta.signature.kid = "__proto__";
  await assert.rejects(verifyHubSignature(b, { jwks, now: signedAtMs }), fails("unknown_kid"));
});
