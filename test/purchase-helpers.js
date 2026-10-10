// Shared by the purchase tests: a throwaway Sato Hub signing key (the same scheme as
// src/hub-signature.js), a signed order quote, and the shipping address used throughout.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "../src/hub-signature.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const x = publicKey.export({ format: "jwk" }).x;
const kid = createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 8);
export const JWKS = { keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] };

/** Sign a body the way Sato Hub does (detached Ed25519 over signed_at + "\n" + canonical JSON without meta.signature). */
export function signHub(body, signedAt = new Date().toISOString()) {
  const b = JSON.parse(JSON.stringify(body));
  b.meta = { ...(b.meta ?? {}) };
  delete b.meta.signature;
  const msg = Buffer.concat([Buffer.from(signedAt, "utf8"), Buffer.from([0x0a]), Buffer.from(canonicalJson(b), "utf8")]);
  b.meta.signature = { alg: "EdDSA", kid, sig: sign(null, msg, privateKey).toString("base64url"), signed_at: signedAt };
  return b;
}

/** The shipping address the tests use, as `settings set` flags and as stored. */
export const SHIP = { name: "Ada Quartermaine", line1: "1729 Ramanujan Street", line2: "Apt 42", city: "Springfield", state: "IL", postalCode: "62704", country: "US", email: "ada.quartermaine@example.com" };
export const SHIP_FLAGS = ["--ship-name", SHIP.name, "--ship-line1", SHIP.line1, "--ship-line2", SHIP.line2, "--ship-city", SHIP.city, "--ship-state", SHIP.state, "--ship-zip", SHIP.postalCode, "--ship-country", SHIP.country, "--ship-email", SHIP.email];
/** The address values that must never show up in a ledger, stderr or error (the short state code is not distinctive). */
export const SHIP_SECRETS = [SHIP.name, SHIP.line1, SHIP.line2, SHIP.email, "Ramanujan", "Quartermaine"];

/** An order quote as Sato Hub would answer it (unsigned; sign with signHub). */
export function orderQuote({ chain = "base", payer, recipientSha, totalUnits = "21500000", serialized = "0x", encoding = "hex", fee = 0, expiresInMs = 10 * 60_000, shipsTo = { city: SHIP.city, state: SHIP.state, postalCode: SHIP.postalCode }, ...over } = {}) {
  return {
    kind: "commerce_order",
    order_id: "ord_test_0001",
    chain,
    payer,
    item: { title: "Mechanical pencil, 0.5 mm", asin: "B0TESTASIN", url: "https://www.amazon.com/dp/B0TESTASIN" },
    price: { item_usd: 19.99, tax_usd: 1.51, shipping_usd: 0, total_usd: Number(totalUnits) / 1e6, currency: "usdc", total_base_units: totalUnits },
    sato_fee_usd: fee,
    quote_status: "valid",
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    payment: { chain, payer, serialized_transaction: serialized, encoding },
    recipient_sha256: recipientSha,
    ships_to: shipsTo,
    merchant: "crossmint",
    sources: [{ source: "crossmint", as_of: new Date().toISOString() }],
    meta: { schema: "commerce_order/v1" },
    ...over,
  };
}
