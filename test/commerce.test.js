// Amazon orders through Sato Hub's Crossmint proxy, offline: the recipient hash, the
// signed quote, and the checks on the payment transaction Crossmint builds (Base via an
// injected eth_simulateV1, Solana via a fake RPC), then a whole order end to end.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, serializeTransaction, toEventSelector } from "viem";
import { generateKeyPairSigner, address } from "@solana/kit";
import { freshHome } from "./helpers.js";
import { JWKS, SHIP, SHIP_SECRETS, orderQuote, signHub } from "./purchase-helpers.js";
import { ata, buildTx, fakeRpc, usdcSim, usdcTransferIx } from "./purchase-solana-helpers.js";

const home = freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused, NeedsApproval } = await import("../src/errors.js");
const { USDC_BASE } = await import("../src/base.js");
const { setShipTo, loadSettings } = await import("../src/settings.js");
const C = await import("../src/commerce.js");
const { decodeBaseTx, simulateBasePurchase } = await import("../src/purchase-evm.js");

initWallet();
setPolicy({ chains: "base,solana", perTx: "100", perDay: "200", purchases: "auto" });
setShipTo(SHIP);
const agentBase = addresses().base;
const agentSol = addresses().solana;
const MERCHANT = "0x2222222222222222222222222222222222222222";
const OTHER_TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);
const recipient = C.recipientOf(SHIP);
const recipientSha = C.recipientSha256(recipient);

test("recipient_sha256: SHA-256 of the canonical JSON (keys sorted at every level, no whitespace, absent keys left out)", () => {
  const expected = `{"city":"Springfield","country":"US","email":"ada.quartermaine@example.com","line1":"1729 Ramanujan Street","line2":"Apt 42","name":"Ada Quartermaine","postalCode":"62704","state":"IL"}`;
  assert.equal(C.canonicalRecipient(recipient), expected);
  assert.equal(recipientSha, createHash("sha256").update(expected, "utf8").digest("hex"));
  const { line2: _l, ...noLine2 } = SHIP;
  assert.equal(C.canonicalRecipient(C.recipientOf(noLine2)).includes("line2"), false, "an unset line2 is absent, not null or empty");
  assert.equal(C.canonicalRecipient({ b: { d: 1, c: undefined, a: [2, { z: 1, y: 2 }] }, a: "x" }), '{"a":"x","b":{"a":[2,{"y":2,"z":1}],"d":1}}');
});

test("the product: an amazon.com link or an ASIN; another Amazon store is refused", () => {
  assert.deepEqual(C.amazonProduct("https://www.amazon.com/Some-Pencil/dp/B0TESTASIN/ref=sr_1?x=1"), { product: "amazon:B0TESTASIN", asin: "B0TESTASIN" });
  assert.deepEqual(C.amazonProduct("b0testasin"), { product: "amazon:B0TESTASIN", asin: "B0TESTASIN" });
  assert.deepEqual(C.amazonProduct("https://amazon.com/gp/product/B0TESTASIN"), { product: "amazon:B0TESTASIN", asin: "B0TESTASIN" });
  assert.equal(C.amazonProduct("https://a.co/d/abc123").product, "amazon:https://a.co/d/abc123");
  assert.throws(() => C.amazonProduct("https://www.amazon.co.uk/dp/B0TESTASIN"), refused("amazon_us_only"));
  assert.throws(() => C.amazonProduct("https://www.amazon.com/s?k=pencil"), /no product/);
});

const now = () => Date.now();
const verify = (body, over = {}) => C.verifyOrderQuote(body, { chain: "base", payer: agentBase, recipient, jwks: JWKS, ...over });

test("the quote: a signed, matching answer passes", async () => {
  const q = await verify(signHub(orderQuote({ payer: agentBase, recipientSha })));
  assert.equal(q.order_id, "ord_test_0001");
  assert.equal(q.price.total_base_units, 21_500_000n);
  assert.equal(q.title, "Mechanical pencil, 0.5 mm");
});

test("the quote: a missing or broken Sato Hub signature is refused", async () => {
  const unsigned = orderQuote({ payer: agentBase, recipientSha });
  await assert.rejects(verify(unsigned), refused("order_unsigned"));
  const tampered = signHub(orderQuote({ payer: agentBase, recipientSha }));
  tampered.price.total_base_units = "1";
  await assert.rejects(verify(tampered), refused("order_unsigned"));
  const nulled = signHub(orderQuote({ payer: agentBase, recipientSha }));
  nulled.meta.signature = null;
  await assert.rejects(verify(nulled), refused("order_unsigned"));
});

test("the quote: recipient_sha256 that is not this bot's address is refused, and the refusal never names the address", async () => {
  const other = C.recipientSha256({ ...recipient, line1: "1 Other Road" });
  const err = await verify(signHub(orderQuote({ payer: agentBase, recipientSha: other }))).catch((e) => e);
  assert.ok(refused("order_quote_refused")(err));
  assert.match(err.message, /not the shipping address this bot holds/);
  for (const s of SHIP_SECRETS) assert.ok(!err.message.includes(s) && !JSON.stringify(err.refusals).includes(s), `leaked ${s}`);
  await assert.rejects(verify(signHub(orderQuote({ payer: agentBase, recipientSha, shipsTo: { city: "Shelbyville", state: "IL", postalCode: "62565" } }))), refused("order_quote_refused"));
});

test("the quote: a fee, another payer or chain, an expired or invalid quote, or a total that does not add up is refused", async () => {
  const cases = [
    orderQuote({ payer: agentBase, recipientSha, fee: 0.5 }),
    orderQuote({ payer: "0x9999999999999999999999999999999999999999", recipientSha }),
    orderQuote({ payer: agentBase, recipientSha, chain: "solana" }),
    orderQuote({ payer: agentBase, recipientSha, expiresInMs: -1000 }),
    orderQuote({ payer: agentBase, recipientSha, quote_status: "item-unavailable" }),
    orderQuote({ payer: agentBase, recipientSha, merchant: "someone" }),
    orderQuote({ payer: agentBase, recipientSha, kind: "swap" }),
    { ...orderQuote({ payer: agentBase, recipientSha }), price: { item_usd: 19.99, tax_usd: 1.51, shipping_usd: 0, total_usd: 25, currency: "usdc", total_base_units: "25000000" } },
    { ...orderQuote({ payer: agentBase, recipientSha }), price: { item_usd: 19.99, tax_usd: 1.51, shipping_usd: 0, total_usd: 21.5, currency: "usdc", total_base_units: "21600000" } },
  ];
  for (const body of cases) await assert.rejects(verify(signHub(body)), refused("order_quote_refused"), JSON.stringify(body).slice(0, 80));
});

// ---------------------------------------------------------------- Base: the payment Crossmint builds

const pad = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const transferLog = (token, from, to, units) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: `0x${BigInt(units).toString(16).padStart(64, "0")}` });
const approvalLog = (token, owner, spender, units) => ({ address: token, topics: [APPROVAL, pad(owner), pad(spender)], data: `0x${BigInt(units).toString(16).padStart(64, "0")}` });
/** An injected eth_simulateV1: `logs` for the payment call; `allowanceLeft` answers any allowance read that follows it. */
const simWith = (logs, { allowanceLeft = 0n, status = "0x1" } = {}) => {
  const seen = [];
  const simulate = async ({ calls }) => {
    seen.push(calls);
    return [{ calls: calls.map((_c, i) => (i === 0 ? { status, logs, returnData: "0x", gasUsed: "0x5208" } : { status: "0x1", logs: [], returnData: encodeAbiParameters([{ type: "uint256" }], [allowanceLeft]), gasUsed: "0x100" })) }];
  };
  return { simulate, seen };
};
const MAX = 21_500_000n;
const transferData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MERCHANT, MAX] });

test("Base: a plain USDC transfer up to the total passes; the payee is read from the simulation", async () => {
  const { simulate } = simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX)]);
  const r = await simulateBasePurchase({ agent: agentBase, to: USDC_BASE, data: transferData, maxUsdcUnits: MAX }, { simulate });
  assert.equal(r.usdc_out, MAX);
  assert.deepEqual(r.payees, [MERCHANT]);
  assert.equal(r.contract_call, false);
});

test("Base: a payment that also takes another token, or ETH, is refused", async () => {
  const { simulate } = simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX), transferLog(OTHER_TOKEN, agentBase, MERCHANT, 5)]);
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: "0x5555555555555555555555555555555555555555", data: "0x1234", maxUsdcUnits: MAX }, { simulate }), refused("purchase_tx.other_asset_leaves"));
  const eth = simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX), transferLog("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", agentBase, MERCHANT, 10n ** 15n)]);
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: "0x5555555555555555555555555555555555555555", data: "0x1234", maxUsdcUnits: MAX }, { simulate: eth.simulate }), refused("purchase_tx.other_asset_leaves"));
});

test("Base: a payment that takes more USDC than the quoted total is refused", async () => {
  const { simulate } = simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX + 1n)]);
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: USDC_BASE, data: transferData, maxUsdcUnits: MAX }, { simulate }), refused("purchase_tx.over_total"));
  const none = simWith([]);
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: USDC_BASE, data: transferData, maxUsdcUnits: MAX }, { simulate: none.simulate }), refused("purchase_tx.no_payment"));
  const reverts = simWith([], { status: "0x0" });
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: USDC_BASE, data: transferData, maxUsdcUnits: MAX }, { simulate: reverts.simulate }), refused("purchase_tx.sim_failed"));
});

test("Base: a contract call that leaves an approval behind is refused; one whose allowance ends at 0 passes and is marked a contract call", async () => {
  const PAYMENT_CONTRACT = "0x6666666666666666666666666666666666666666";
  const logs = [approvalLog(USDC_BASE, agentBase, PAYMENT_CONTRACT, MAX * 10n), transferLog(USDC_BASE, agentBase, MERCHANT, MAX)];
  const lingering = simWith(logs, { allowanceLeft: MAX * 9n });
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: PAYMENT_CONTRACT, data: "0xabcdef01", maxUsdcUnits: MAX }, { simulate: lingering.simulate }), refused("purchase_tx.lingering_approval"));
  assert.equal(lingering.seen[1].length, 2, "the second simulation replays the payment, then reads the allowance in the same block");
  const clean = simWith(logs, { allowanceLeft: 0n });
  const r = await simulateBasePurchase({ agent: agentBase, to: PAYMENT_CONTRACT, data: "0xabcdef01", maxUsdcUnits: MAX }, { simulate: clean.simulate });
  assert.equal(r.contract_call, true);
  assert.equal(r.approvals_checked, 1);
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MERCHANT, MAX] });
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: USDC_BASE, data: approve, maxUsdcUnits: MAX }, { simulate: clean.simulate }), refused("purchase_tx.lingering_approval"));
  const forAll = { address: OTHER_TOKEN, topics: [toEventSelector("ApprovalForAll(address,address,bool)"), pad(agentBase), pad(MERCHANT)], data: `0x${"0".repeat(63)}1` };
  await assert.rejects(simulateBasePurchase({ agent: agentBase, to: PAYMENT_CONTRACT, data: "0x01", maxUsdcUnits: MAX }, { simulate: simWith([transferLog(USDC_BASE, agentBase, MERCHANT, 1), forAll]).simulate }), refused("purchase_tx.lingering_approval"));
});

test("Base: the serialized transaction must be for chain 8453 and send no ETH", () => {
  const base = { to: USDC_BASE, data: transferData, gas: 100_000n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" };
  assert.deepEqual(decodeBaseTx(serializeTransaction({ ...base, chainId: 8453 })), { to: USDC_BASE, data: transferData, value: 0n, chain_id: 8453 });
  assert.throws(() => decodeBaseTx(serializeTransaction({ ...base, chainId: 1 })), refused("purchase_tx.chain"));
  assert.throws(() => decodeBaseTx(serializeTransaction({ ...base, chainId: 8453, value: 1n })), refused("purchase_tx.value"));
  assert.throws(() => decodeBaseTx("0xnothex"), refused("purchase_tx.decode"));
  assert.deepEqual(decodeBaseTx(JSON.stringify({ to: USDC_BASE, data: transferData, chainId: 8453 }), "json").to, USDC_BASE);
});

// ---------------------------------------------------------------- Solana: the payment Crossmint builds

test("Solana: Crossmint pays the fee and has signed; the agent is the only signature added; foreign programs, unsigned strangers and over-total payments are refused", async () => {
  const crossmint = await generateKeyPairSigner();
  const merchant = (await generateKeyPairSigner()).address;
  const ix = await usdcTransferIx(agentSol, merchant, 21_500_000);
  const { wire, keys } = await buildTx({ feePayer: crossmint, instructions: [ix] });
  const agentAta = String(await ata(agentSol));
  const merchantAta = String(await ata(merchant));
  const quote = { chain: "solana", price: { total_base_units: MAX }, payment: { encoding: "base64", serialized_transaction: wire } };
  const ok = await C.checkOrderPayment(quote, { payer: agentSol, rpc: fakeRpc({ sim: () => usdcSim({ keys, agent: agentSol, agentAta, merchant, merchantAta, out: MAX, fee: 0n }) }) });
  assert.equal(ok.usdc_out, MAX);
  assert.deepEqual(ok.payees, [merchant]);
  // Over the total.
  await assert.rejects(C.checkOrderPayment(quote, { payer: agentSol, rpc: fakeRpc({ sim: () => usdcSim({ keys, agent: agentSol, agentAta, merchant, merchantAta, out: MAX + 1n, fee: 0n }) }) }), refused("purchase_tx.over_total"));
  // A program outside the list.
  const foreign = { programAddress: address("Stake11111111111111111111111111111111111111"), accounts: [], data: new Uint8Array([1]) };
  const bad = await buildTx({ feePayer: crossmint, instructions: [ix, foreign] });
  await assert.rejects(C.checkOrderPayment({ ...quote, payment: { encoding: "base64", serialized_transaction: bad.wire } }, { payer: agentSol, rpc: fakeRpc() }), refused("purchase_tx.program_allowlist"));
  // A fee payer that has NOT signed would make the agent's signature only one of several still missing.
  const unsigned = await buildTx({ feePayer: crossmint.address, instructions: [ix] });
  await assert.rejects(C.checkOrderPayment({ ...quote, payment: { encoding: "base64", serialized_transaction: unsigned.wire } }, { payer: agentSol, rpc: fakeRpc() }), refused("purchase_tx.signers"));
  // System is not allowed in a Crossmint payment (SOL never pays for an order).
  const sys = { programAddress: address("11111111111111111111111111111111"), accounts: [{ address: address(agentSol), role: 3 }, { address: address(merchant), role: 1 }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
  const withSys = await buildTx({ feePayer: crossmint, instructions: [ix, sys] });
  await assert.rejects(C.checkOrderPayment({ ...quote, payment: { encoding: "base64", serialized_transaction: withSys.wire } }, { payer: agentSol, rpc: fakeRpc() }), refused("purchase_tx.program_allowlist"));
});

// ---------------------------------------------------------------- the whole order

function hubFetch(answer) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const a = typeof answer === "function" ? answer(url, init) : answer;
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  };
  return { fetchImpl, seen };
}
const ORIGIN = "https://satohub.test";
const okSign = async (_c, _tx, onSigned) => (onSigned(`0x${"ab".repeat(32)}`), { status: "success", transactionHash: `0x${"ab".repeat(32)}` });

test("an order end to end (Base, auto): the address goes only in the request body; the ledger and the result never hold it", async () => {
  const serialized = serializeTransaction({ chainId: 8453, to: USDC_BASE, data: transferData, gas: 100_000n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
  const { fetchImpl, seen } = hubFetch({ json: signHub(orderQuote({ payer: agentBase, recipientSha, serialized })) });
  const r = await C.placeOrder({ input: "https://www.amazon.com/dp/B0TESTASIN", chain: "base" }, { fetchImpl, origin: ORIGIN, jwks: JWKS, simulate: simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX)]).simulate, signAndSend: okSign, c: {} });
  assert.equal(seen[0].url, `${ORIGIN}/api/commerce/order`);
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(sent, { product: "amazon:B0TESTASIN", chain: "base", payer: agentBase, recipient });
  assert.match(seen[0].init.headers["user-agent"], /^sato-agent\//);
  assert.match(r.explorer, /basescan/);
  assert.match(r.card.join("\n"), /Item \$19\.99 · tax \$1\.51 · shipping \$0\.00 · total 21\.5 USDC on Base\. No Sato Hub fee\./);
  assert.match(r.card.join("\n"), /Ships to: Ada Quartermaine, Springfield, IL 62704/);
  const ledger = readFileSync(join(home, "ledger.jsonl"), "utf8");
  for (const s of SHIP_SECRETS) assert.ok(!ledger.includes(s), `the ledger holds ${s}`);
  assert.match(ledger, /"kind":"order"/);
  assert.ok(loadSettings().ship_to_id, "the approval binds a local id, not the address");
});

test("an order in ask mode: the card shows the address to the owner; the approval intent (written to the ledger) does not", async () => {
  setPolicy({ purchases: "ask" });
  const serialized = serializeTransaction({ chainId: 8453, to: USDC_BASE, data: transferData, gas: 100_000n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
  const { fetchImpl } = hubFetch({ json: signHub(orderQuote({ payer: agentBase, recipientSha, serialized })) });
  const err = await C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl, origin: ORIGIN, jwks: JWKS, simulate: simWith([transferLog(USDC_BASE, agentBase, MERCHANT, MAX)]).simulate, signAndSend: okSign, c: {} }).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.match(err.card.join("\n"), /Ada Quartermaine/);
  for (const s of SHIP_SECRETS) {
    assert.ok(!err.message.includes(s), `the error text holds ${s}`);
    assert.ok(!JSON.stringify(err.intent).includes(s), `the intent holds ${s}`);
  }
  assert.equal(err.intent.ship_to_id, loadSettings().ship_to_id);
  const ledger = readFileSync(join(home, "ledger.jsonl"), "utf8");
  for (const s of SHIP_SECRETS) assert.ok(!ledger.includes(s), `the ledger holds ${s}`);
  setPolicy({ purchases: "auto" });
});

test("orders not switched on yet: 503 orders_not_enabled is a plain refusal (exit 3), nothing paid", async () => {
  const { fetchImpl } = hubFetch({ status: 503, json: { error: "orders_not_enabled" } });
  await assert.rejects(C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl, origin: ORIGIN, jwks: JWKS }), (e) => refused("orders_not_enabled")(e) && /not switched on yet/.test(e.message));
});

test("an error that echoes the address back is scrubbed before it is shown", async () => {
  const { fetchImpl } = hubFetch({ status: 400, json: { error: `cannot ship to 1729 Ramanujan Street for Ada Quartermaine` } });
  const err = await C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl, origin: ORIGIN, jwks: JWKS }).catch((e) => e);
  assert.match(err.message, /HTTP 400/);
  for (const s of SHIP_SECRETS) assert.ok(!err.message.includes(s), `leaked ${s}`);
});

test("orders: a signed status with delivery and a refund; an unsigned one is refused", async () => {
  const status = { kind: "commerce_order_status", order_id: "ord_test_0001", phase: "delivery", payment_status: "completed", delivery: [{ title: "Mechanical pencil", status: "failed" }], refunded: { amount: "21.5", currency: "usdc" }, failure: null, at: new Date().toISOString(), meta: {} };
  const { fetchImpl, seen } = hubFetch({ json: signHub(status) });
  const s = await C.orderStatus("ord_test_0001", { chain: "base", payer: agentBase }, { fetchImpl, origin: ORIGIN, jwks: JWKS });
  assert.equal(seen[0].url, `${ORIGIN}/api/commerce/order/ord_test_0001?payer=${agentBase}`);
  assert.match(C.statusLines(s).join("\n"), /Refunded: 21\.5 usdc/);
  assert.match(C.statusLines(s).join("\n"), /Mechanical pencil: failed/);
  await assert.rejects(C.orderStatus("ord_test_0001", { chain: "base", payer: agentBase }, { fetchImpl: hubFetch({ json: status }).fetchImpl, origin: ORIGIN, jwks: JWKS }), refused("order_unsigned"));
});

test("no address set: an order is refused with the command that sets it", async () => {
  const { clearShipTo } = await import("../src/settings.js");
  clearShipTo();
  await assert.rejects(C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl: () => assert.fail("no request without an address") }), refused("ship_to_not_set"));
  setShipTo(SHIP);
});
