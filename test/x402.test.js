// A real x402 v2 handshake against a local server, offline: the server answers
// 402 with PAYMENT-REQUIRED, the agent signs a USDC payment authorization
// (EIP-3009) with its own key, and the server checks the PAYMENT-SIGNATURE it
// receives. Nothing settles: no facilitator, no chain.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { verifyTypedData } from "viem";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { pay, MAX_AUTH_WINDOW_S } = await import("../src/x402.js");
const { spentLast24h, entries } = await import("../src/ledger.js");
const { USDC_BASE } = await import("../src/base.js");

const spent = () => spentLast24h().usd;
const PAY_TO = "0x1111111111111111111111111111111111111111";
let server;
let origin;
const seen = [];
let accept = true;

function requirement({ amount, asset = USDC_BASE, network = "eip155:8453", maxTimeoutSeconds = 60 }) {
  return { scheme: "exact", network, asset, amount, payTo: PAY_TO, maxTimeoutSeconds, extra: { name: "USD Coin", version: "2" } };
}
const offers = {
  "/cheap": [requirement({ amount: "10000" })], // $0.01
  "/pricey": [requirement({ amount: "7500000" })], // $7.50
  "/other-asset": [requirement({ amount: "10000", asset: "0x2222222222222222222222222222222222222222" })],
  "/forever": [requirement({ amount: "10000", maxTimeoutSeconds: 1e12 })],
};

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const sig = req.headers["payment-signature"];
    const required = () => encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${path}` }, accepts: offers[path] });
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": required() });
      return res.end("{}");
    }
    const payload = decodePaymentSignatureHeader(sig);
    seen.push({ path, payload, ua: req.headers["user-agent"] });
    if (!accept) {
      res.writeHead(402, { "PAYMENT-REQUIRED": required() });
      return res.end("{}");
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "0xabc", network: "eip155:8453", payer: payload.payload.authorization.from }),
    });
    res.end(JSON.stringify({ data: "paid content" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  initWallet();
});
after(() => server.close());

test("no limits set: nothing is signed", async () => {
  await assert.rejects(pay(`${origin}/cheap`), (e) => e instanceof Refused && e.refusals[0].rule === "limits_not_set");
  assert.equal(seen.length, 0);
});

test("under the limits: pays with a valid EIP-3009 signature from the agent's own key", async () => {
  setPolicy({ perTx: "1", perDay: "2" });
  const r = await pay(`${origin}/cheap`);
  assert.equal(r.status, 200);
  assert.equal(r.settled, true);
  assert.equal(r.usd, 0.01);
  assert.match(r.body, /paid content/);

  const { payload, ua } = seen.at(-1);
  assert.match(ua, /^sato-agent\//);
  const auth = payload.payload.authorization;
  assert.equal(auth.to.toLowerCase(), PAY_TO);
  assert.equal(auth.value, "10000");
  assert.ok(Number(auth.validBefore) - Date.now() / 1000 <= MAX_AUTH_WINDOW_S + 5, "short authorization window");
  const ok = await verifyTypedData({
    address: auth.from,
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: auth,
    signature: payload.payload.signature,
  });
  assert.equal(ok, true, "the signature recovers to the agent's address");
  assert.equal(spent(), 0.01);
});

test("over the per-transaction limit: refused, nothing signed", async () => {
  const n = seen.length;
  await assert.rejects(pay(`${origin}/pricey`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "max_usd_per_tx"));
  assert.equal(seen.length, n);
});

test("a token other than USDC on Base: refused, nothing signed", async () => {
  const n = seen.length;
  await assert.rejects(pay(`${origin}/other-asset`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "asset"));
  assert.equal(seen.length, n);
});

test("an authorization the server wants valid for years: refused, nothing signed", async () => {
  const n = seen.length;
  await assert.rejects(pay(`${origin}/forever`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "authorization_window"));
  assert.equal(seen.length, n);
});

test("the 24 h limit counts earlier payments", async () => {
  setPolicy({ perTx: "10", perDay: "7.5" });
  const n = seen.length;
  await assert.rejects(pay(`${origin}/pricey`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "max_usd_per_day"));
  assert.equal(seen.length, n);
});

test("a signed payment the server answers with 402 STAYS counted (the server could still settle it)", async () => {
  setPolicy({ perTx: "1", perDay: "0.03" }); // room for exactly two more $0.01 payments
  accept = false;
  const before = spent();
  const r = await pay(`${origin}/cheap`);
  assert.equal(r.status, 402);
  assert.equal(r.signed, true);
  assert.equal(r.settled, false);
  assert.equal(spent(), before + 0.01, "a signed payment never leaves the total");
  assert.equal(entries().at(-1).status, "signed_unsettled");
  await pay(`${origin}/cheap`);
  // A server that keeps rejecting cannot drain more than the limit.
  await assert.rejects(pay(`${origin}/cheap`), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "max_usd_per_day"));
  accept = true;
});
