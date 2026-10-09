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
const { Pending, Refused } = await import("../src/errors.js");
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
  // A string concatenates in `now + maxTimeoutSeconds`: "300" would mean ~56,800 years.
  "/string-window": [requirement({ amount: "10000", maxTimeoutSeconds: "300" })],
  "/hangup": [requirement({ amount: "10000" })],
};

// x402 v1 servers: `maxAmountRequired`, network "base", the payment in X-PAYMENT.
function requirementV1({ amount = "10000", asset = USDC_BASE, network = "base", maxTimeoutSeconds = 60 } = {}) {
  return { scheme: "exact", network, maxAmountRequired: amount, resource: "http://x/", description: "", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds, asset, extra: { name: "USD Coin", version: "2" } };
}
const offersV1 = {
  "/v1/ok": [requirementV1()],
  "/v1/pricey": [requirementV1({ amount: "7500000" })],
  "/v1/other-asset": [requirementV1({ asset: "0x2222222222222222222222222222222222222222" })],
  "/v1/long-window": [requirementV1({ maxTimeoutSeconds: 301 })],
  "/v1/forever": [requirementV1({ maxTimeoutSeconds: 1e12 })],
  "/v1/string-window": [requirementV1({ maxTimeoutSeconds: "300" })],
  "/v1/fractional-window": [requirementV1({ maxTimeoutSeconds: 59.5 })],
  "/v1/other-network": [requirementV1({ network: "base-sepolia" })],
  "/v1/caip-network": [requirementV1({ network: "eip155:8453" })],
  "/v1/hex-amount": [requirementV1({ amount: "0x2710" })],
};
const seenV1 = [];

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const sig = req.headers["payment-signature"];
    if (path.startsWith("/v1/")) {
      const xp = req.headers["x-payment"];
      if (!xp) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, error: "payment required", accepts: offersV1[path] }));
      }
      const payload = JSON.parse(Buffer.from(xp, "base64").toString());
      seenV1.push({ path, payload });
      res.writeHead(200, { "content-type": "application/json", "X-PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "0xdef", network: "base", payer: payload.payload.authorization.from }) });
      return res.end(JSON.stringify({ data: "paid content (v1)" }));
    }
    if (path === "/hangup" && sig) return void req.socket.destroy(); // took the payment, never answers
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
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
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

test("a window sent as a string (\"300\") is refused, nothing signed", async () => {
  const n = seen.length;
  await assert.rejects(pay(`${origin}/string-window`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "authorization_window"));
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

test("the CLI exits 4 (do not retry) for a signed-but-unsettled payment, in --json mode too", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  setPolicy({ perTx: "1", perDay: "100" });
  accept = false;
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, "pay", `${origin}/cheap`, "--skip-check", "--json"], { env: process.env, stdio: "ignore" });
    p.on("exit", resolve);
  });
  accept = true;
  assert.equal(code, 4);
});

// ---------------------------------------------------------------- a payment that was sent, then the connection died

test("signed and sent, then the connection is reset: Pending (exit 4), stays counted, do not retry", async () => {
  setPolicy({ perTx: "1", perDay: "100" });
  const before = spent();
  const n = entries().length;
  await assert.rejects(pay(`${origin}/hangup`), (e) => e instanceof Pending && /Do NOT retry/.test(e.message) && /stays counted/.test(e.message) && e.details.chain === "base");
  assert.equal(spent(), before + 0.01, "the payment may have landed: it stays counted");
  const added = entries().slice(n).map((r) => r.status);
  assert.deepEqual(added, ["submitted", "signed", "signed_unconfirmed"], "never released");
});

test("the CLI exits 4 when the connection dies after the payment was sent", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const out = [];
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, "pay", `${origin}/hangup`, "--skip-check", "--json"], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (c) => out.push(c));
    p.on("exit", resolve);
  });
  assert.equal(code, 4);
  assert.ok(JSON.parse(Buffer.concat(out).toString()).pending, "--json says pending");
});

test("a payment refused before signing is still an ordinary refusal (exit 3), not Pending", async () => {
  await assert.rejects(pay(`${origin}/forever`), (e) => e instanceof Refused);
});

// ---------------------------------------------------------------- x402 v1 servers, through the same guard

test("v1: a valid 402 (maxAmountRequired, network \"base\") is paid with a valid signature, inside the same window", async () => {
  setPolicy({ perTx: "1", perDay: "100" });
  const before = spent();
  const r = await pay(`${origin}/v1/ok`);
  assert.equal(r.status, 200);
  assert.equal(r.x402_version, 1);
  assert.equal(r.settled, true);
  assert.equal(r.usd, 0.01);
  assert.equal(r.amount_atomic, "10000");
  assert.equal(r.network, "eip155:8453");
  assert.equal(spent(), before + 0.01);
  const { payload } = seenV1.at(-1);
  assert.equal(payload.x402Version, 1);
  assert.equal(payload.network, "base");
  const auth = payload.payload.authorization;
  assert.equal(auth.value, "10000");
  assert.ok(Number(auth.validBefore) - Date.now() / 1000 <= MAX_AUTH_WINDOW_S + 5);
  const ok = await verifyTypedData({
    address: auth.from,
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: auth,
    signature: payload.payload.signature,
  });
  assert.equal(ok, true);
});

test("v1: the same refusals as v2 (asset, window, network, amount, limits); nothing signed", async () => {
  const n = seenV1.length;
  const rows = entries().length;
  const cases = {
    "/v1/other-asset": "asset",
    "/v1/long-window": "authorization_window",
    "/v1/forever": "authorization_window",
    "/v1/string-window": "authorization_window",
    "/v1/fractional-window": "authorization_window",
    "/v1/pricey": "max_usd_per_tx",
    "/v1/hex-amount": "amount",
  };
  for (const [path, rule] of Object.entries(cases)) {
    await assert.rejects(pay(`${origin}${path}`), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule), path);
  }
  // Networks the v1 client does not know, or v2-style names on a v1 offer: dropped before anything is signed.
  for (const path of ["/v1/other-network", "/v1/caip-network"]) {
    await assert.rejects(pay(`${origin}${path}`), (e) => !(e instanceof Pending), path);
  }
  assert.equal(seenV1.length, n, "no v1 payment was ever sent");
  assert.equal(entries().length, rows, "nothing was reserved");
});
