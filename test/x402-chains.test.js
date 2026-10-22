// x402 on Arbitrum and Polygon (on) and BNB Chain (off): the same guard as Base, with each chain's CAIP-2 network, v1 name, native Circle
// USDC and EIP-712 domain. A local server stands in for the seller and checks the agent's real EIP-3009 signature.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { verifyTypedData } from "viem";
import { freshHome, raisesInForce } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy: setPolicyAt } = await import("../src/policy.js");
const setPolicy = raisesInForce(setPolicyAt); // raises take effect at once here; the 24-hour wait is tested in test/hardening.test.js
const { pay, quoteX402, resolvePayChain, PAY_CHAINS } = await import("../src/x402.js");
const { Refused } = await import("../src/errors.js");
const { evmChain } = await import("../src/chains.js");
const { entries } = await import("../src/ledger.js");

const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = { base: evmChain("base").stables.USDC.address, arbitrum: evmChain("arbitrum").stables.USDC.address, polygon: evmChain("polygon").stables.USDC.address };
const USDT0 = evmChain("arbitrum").stables.USDT.address;
const USDC_E_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const offer = (network, asset, amount = "10000", extra = { name: "USD Coin", version: "2" }) => ({ scheme: "exact", network, asset, amount, payTo: PAY_TO, maxTimeoutSeconds: 60, extra });
const offers = {
  "/arb": [offer("eip155:42161", USDC.arbitrum)],
  "/arb-usdt0": [offer("eip155:42161", USDT0, "10000", { name: "USDT0", version: "1" })],
  "/arb-on-base": [offer("eip155:8453", USDC.arbitrum)],
  "/pol": [offer("eip155:137", USDC.polygon)],
  "/pol-usdce": [offer("eip155:137", USDC_E_POLYGON)],
  "/pol-on-arb": [offer("eip155:42161", USDC.polygon)],
  "/bnb": [offer("eip155:56", evmChain("bnb").stables.USDC.address, "10000000000000000")],
  "/bnb-usdt": [offer("eip155:56", evmChain("bnb").stables.USDT.address, "10000000000000000")],
};
const v1 = { "/v1/arb": { network: "arbitrum", asset: USDC.arbitrum }, "/v1/pol": { network: "polygon", asset: USDC.polygon }, "/v1/arb-as-base": { network: "base", asset: USDC.arbitrum } };
const seen = [];
let server;
let origin;

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/v1/")) {
      const xp = req.headers["x-payment"];
      const v = v1[path];
      if (!xp) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, error: "payment required", accepts: [{ scheme: "exact", network: v.network, maxAmountRequired: "10000", resource: "http://x/", description: "", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: v.asset, extra: { name: "USD Coin", version: "2" } }] }));
      }
      const payload = JSON.parse(Buffer.from(xp, "base64").toString());
      seen.push({ path, payload });
      res.writeHead(200, { "content-type": "application/json", "X-PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: `0x${"de".repeat(32)}`, network: v.network, payer: payload.payload.authorization.from }) });
      return res.end(JSON.stringify({ data: "paid (v1)" }));
    }
    const sig = req.headers["payment-signature"];
    const required = () => encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${path}` }, accepts: offers[path] });
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": required() });
      return res.end("{}");
    }
    const payload = decodePaymentSignatureHeader(sig);
    seen.push({ path, payload });
    res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: `0x${"ab".repeat(32)}`, network: offers[path][0].network, payer: payload.payload.authorization.from }) });
    res.end(JSON.stringify({ data: "paid content" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  initWallet();
});
after(() => server.close());

const typedData = (chainId, verifyingContract, auth, signature) =>
  verifyTypedData({
    address: auth.from,
    domain: { name: "USD Coin", version: "2", chainId, verifyingContract },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: auth,
    signature,
  });

test("x402 runs on Base, Arbitrum, Polygon and Solana; not on BNB Chain", () => {
  assert.deepEqual(PAY_CHAINS, ["base", "arbitrum", "polygon", "solana"]);
});

test("pay on Arbitrum: native Circle USDC on eip155:42161, signed for chain 42161 with the agent's own key, the ledger and explorer say arbitrum", async () => {
  setPolicy({ chains: "arbitrum,base,bnb,polygon", perTx: "1", perDay: "5" });
  const r = await pay(`${origin}/arb`, { chain: "arbitrum" });
  assert.equal(r.status, 200);
  assert.equal(r.settled, true);
  assert.equal(r.chain, "arbitrum");
  assert.equal(r.usd, 0.01);
  assert.match(r.explorer, /^https:\/\/arbiscan\.io\/tx\/0x[0-9a-f]{64}$/);
  const { payload } = seen.at(-1);
  assert.equal(payload.accepted.network, "eip155:42161");
  assert.equal(await typedData(42161, USDC.arbitrum, payload.payload.authorization, payload.payload.signature), true, "a valid EIP-3009 signature for Arbitrum's USDC");
  assert.equal(await typedData(8453, USDC.arbitrum, payload.payload.authorization, payload.payload.signature), false, "and not valid on Base");
  const row = entries().filter((e) => e.kind === "x402").at(-1);
  assert.deepEqual([row.chain, row.asset, row.usd], ["arbitrum", "USDC", 0.01]);
});

test("pay on Polygon: native USDC on eip155:137; the bridged USDC.e and another chain's USDC are refused, nothing signed", async () => {
  const r = await pay(`${origin}/pol`, { chain: "polygon" });
  assert.equal(r.settled, true);
  assert.match(r.explorer, /^https:\/\/polygonscan\.com\/tx\//);
  const { payload } = seen.at(-1);
  assert.equal(payload.accepted.network, "eip155:137");
  assert.equal(await typedData(137, USDC.polygon, payload.payload.authorization, payload.payload.signature), true);
  const n = seen.length;
  await assert.rejects(pay(`${origin}/pol-usdce`, { chain: "polygon" }), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "asset"));
  // another chain's network: the x402 library finds no signer registered for it, which is also a stop (nothing is signed)
  await assert.rejects(pay(`${origin}/pol-on-arb`, { chain: "polygon" }), /No network\/scheme registered|REFUSED/);
  assert.equal(seen.length, n, "nothing was signed");
});

test("pay: Arbitrum's USDT0 (it can sign EIP-3009 too) is not paid, and a Base network is not Arbitrum's", async () => {
  const n = seen.length;
  await assert.rejects(pay(`${origin}/arb-usdt0`, { chain: "arbitrum" }), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "asset"));
  await assert.rejects(pay(`${origin}/arb-on-base`, { chain: "arbitrum" }), /No network\/scheme registered|REFUSED/);
  assert.equal(seen.length, n);
});

test("pay: x402 v1 — polygon's name is signable, arbitrum's is not (the x402 library has no v1 Arbitrum): that offer is refused, v2 is how Arbitrum is paid", async () => {
  const p = await pay(`${origin}/v1/pol`, { chain: "polygon" });
  assert.equal(p.settled, true);
  const n = seen.length;
  await assert.rejects(pay(`${origin}/v1/arb`, { chain: "arbitrum" }), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "asset"));
  await assert.rejects(pay(`${origin}/v1/arb-as-base`, { chain: "arbitrum" }), /No network\/scheme registered|REFUSED/);
  assert.equal(seen.length, n);
});

test("quote on Arbitrum: the offer is listed with its chain; the limits apply in USD", async () => {
  const q = await quoteX402(`${origin}/arb`, { chain: "arbitrum" });
  assert.equal(q.chain, "arbitrum");
  assert.deepEqual(q.offers.map((o) => [o.chain, o.usd, o.network, o.amount_atomic]), [["arbitrum", 0.01, "eip155:42161", "10000"]]);
});

test("BNB Chain: no x402. A bot on BNB (or --chain bnb) is refused with the reason and a way forward; nothing is fetched, reserved or signed", async () => {
  setPolicy({ chains: "bnb", perTx: "1", perDay: "5" });
  const n = seen.length;
  const r = resolvePayChain({ chains: ["bnb"] }, undefined);
  assert.equal(r.chain, "bnb");
  assert.deepEqual(r.refusals.map((x) => x.rule), ["x402_not_on_chain"]);
  assert.match(r.refusals[0].message, /x402 payments are not available on BNB Chain; they work on Base, Arbitrum, Polygon and Solana\. A bot on BNB Chain pays with `send` or `checkout`/);
  for (const path of ["/bnb", "/bnb-usdt"]) {
    await assert.rejects(pay(`${origin}${path}`), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "x402_not_on_chain"), path);
    await assert.rejects(quoteX402(`${origin}${path}`, { chain: "bnb" }), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "x402_not_on_chain"));
  }
  assert.equal(seen.length, n);
  // a bot that works on BNB and Arbitrum must still say which
  assert.throws(() => resolvePayChain({ chains: ["bnb", "arbitrum"] }, undefined), /say which with --chain/);
  assert.deepEqual(resolvePayChain({ chains: ["bnb", "arbitrum"] }, "arbitrum").refusals, []);
  // and a chain the owner did not choose
  assert.deepEqual(resolvePayChain({ chains: ["arbitrum"] }, "polygon").refusals.map((x) => x.rule), ["chain_not_allowed"]);
});
