// Fixes from the adversarial review of the purchase lane (2026-10-09), one test (or more) each.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, toEventSelector } from "viem";
import { generateKeyPairSigner } from "@solana/kit";
import { freshHome } from "./helpers.js";
import { CODE, INVOICE, bitrefillWorld } from "./bitrefill-world.js";
import { JWKS, SHIP, orderQuote, signHub } from "./purchase-helpers.js";
import { ata, buildTx, fakeRpc, usdcSim, usdcTransferIx } from "./purchase-solana-helpers.js";

const home = freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy, loadPolicy, purchasesAsk } = await import("../src/policy.js");
const { Refused, NeedsApproval } = await import("../src/errors.js");
const { purchaseGate } = await import("../src/purchase.js");
const B = await import("../src/bitrefill.js");
const C = await import("../src/commerce.js");
const { SIM_GAS } = await import("../src/purchase-evm.js");
const { parseEip681, prepareSolanaPayTransaction } = await import("../src/checkout.js");
const { setShipTo, localHmac } = await import("../src/settings.js");
const { USDC_BASE } = await import("../src/base.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./purchase-preload.js", import.meta.url));
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);
initWallet();
setShipTo(SHIP);
const agentBase = addresses().base;
const agentSol = addresses().solana;
const MERCHANT = "0x2222222222222222222222222222222222222222";
const recipient = C.recipientOf(SHIP);
const recipientSha = C.recipientSha256(recipient);
const MAX = 21_500_000n;

// ---------------------------------------------------------------- 2. the stricter of approval and purchase_approval

test("purchases ask unless BOTH approval and purchase_approval are auto", async () => {
  assert.equal(purchasesAsk({ approval: "ask", purchase_approval: "auto" }), true);
  assert.equal(purchasesAsk({ approval: "auto", purchase_approval: "auto" }), false);
  assert.equal(purchasesAsk({ approval: null, purchase_approval: "auto" }), false);
  assert.equal(purchasesAsk({ approval: "auto", purchase_approval: null }), true);
  setPolicy({ chains: "base,solana", perTx: "100", perDay: "200", approval: "ask", purchases: "auto" });
  await assert.rejects(purchaseGate({ cmd: "checkout", kind: "eip681" }, {}), (e) => e instanceof NeedsApproval);
  // Dropping approval to auto while purchases are auto is a raise for both.
  const r = setPolicy({ approval: "auto" });
  assert.deepEqual(r.raises, ["approval: ask -> auto", "purchases: ask -> auto"]);
  assert.equal(purchasesAsk(loadPolicy()), false);
});

// ---------------------------------------------------------------- 4, 5, 6, 10. orders

const pad = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const transferLog = { address: USDC_BASE, topics: [toEventSelector("Transfer(address,address,uint256)"), pad(agentBase), pad(MERCHANT)], data: `0x${MAX.toString(16).padStart(64, "0")}` };
const simulate = (gasUsed = "0x186a0") => async ({ calls }) => [{ calls: calls.map(() => ({ status: "0x1", logs: [transferLog], returnData: "0x", gasUsed })) }];
const hub = (json) => async () => new Response(JSON.stringify(json), { status: 200 });
const serialized = JSON.stringify({ to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MERCHANT, MAX] }), chainId: 8453 });

test("an order quote for another ASIN (or none) than the one asked for is refused", async () => {
  const verify = (body) => C.verifyOrderQuote(signHub(body), { chain: "base", payer: agentBase, recipient, asin: "B0TESTASIN", jwks: JWKS });
  await verify(orderQuote({ payer: agentBase, recipientSha }));
  await assert.rejects(verify(orderQuote({ payer: agentBase, recipientSha, item: { title: "Something else", asin: "B0OTHERXYZ" } })), refused("order_quote_refused"));
  await assert.rejects(verify(orderQuote({ payer: agentBase, recipientSha, item: { title: "No ASIN" } })), refused("order_quote_refused"));
});

test("a Base order is signed with the simulated gas x 1.3 (capped), never an estimate on the target", async () => {
  assert.equal(C.orderGasLimit(100_000n), 130_000n);
  assert.equal(C.orderGasLimit("0x186a0"), 130_000n);
  assert.equal(C.orderGasLimit(10_000_000n), SIM_GAS);
  assert.equal(C.orderGasLimit(null), SIM_GAS);
  setPolicy({ approval: "auto", purchases: "auto" });
  let sent = null;
  const signAndSend = async (_c, tx, onSigned) => ((sent = tx), onSigned(`0x${"ab".repeat(32)}`), { status: "success", transactionHash: `0x${"ab".repeat(32)}` });
  await C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl: hub(signHub(orderQuote({ payer: agentBase, recipientSha, serialized, encoding: "json" }))), origin: "https://satohub.test", jwks: JWKS, simulate: simulate("0x186a0"), signAndSend, c: {} });
  assert.equal(sent.gas, 130_000n);
});

test("an order's payees are on the price card and bound into the approval", async () => {
  setPolicy({ purchases: "ask" });
  const err = await C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl: hub(signHub(orderQuote({ payer: agentBase, recipientSha, serialized, encoding: "json" }))), origin: "https://satohub.test", jwks: JWKS, simulate: simulate(), c: {} }).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.match(err.card.join("\n"), new RegExp(`Paid to: ${MERCHANT}`, "i"));
  assert.deepEqual(err.intent.payees, [MERCHANT.toLowerCase()]);
});

test("a Solana order's card says rent may be paid for the merchant's USDC account", async () => {
  const crossmint = await generateKeyPairSigner();
  const merchant = (await generateKeyPairSigner()).address;
  const { wire, keys } = await buildTx({ feePayer: crossmint, instructions: [await usdcTransferIx(agentSol, merchant, Number(MAX))] });
  const agentAta = String(await ata(agentSol));
  const merchantAta = String(await ata(merchant));
  const rpc2 = fakeRpc({ sim: () => usdcSim({ keys, agent: agentSol, agentAta, merchant, merchantAta, out: MAX, fee: 0n }) });
  const r = await C.placeOrder({ input: "B0TESTASIN", chain: "solana", dryRun: true }, { fetchImpl: hub(signHub(orderQuote({ chain: "solana", payer: agentSol, recipientSha, serialized: wire, encoding: "base64" }))), origin: "https://satohub.test", jwks: JWKS, rpc: rpc2 });
  assert.match(r.card.join("\n"), /plus network fees and, if the merchant's USDC account must be created, about 0\.002 SOL of rent/);
  assert.match(r.card.join("\n"), new RegExp(`Paid to: ${merchant}`));
});

test("a Solana Pay transaction request's payees are on the card and bound into the approval", async () => {
  const merchant = (await generateKeyPairSigner()).address;
  const { wire, keys } = await buildTx({ feePayer: agentSol, instructions: [await usdcTransferIx(agentSol, merchant, 1_000_000)] });
  const agentAta = String(await ata(agentSol));
  const merchantAta = String(await ata(merchant));
  const fetchImpl = async (_u, init) => new Response(JSON.stringify(init.method === "GET" ? { label: "Shop" } : { transaction: wire }), { status: 200 });
  const p = await prepareSolanaPayTransaction("https://pay.example.com/x", { fetchImpl, rpc: fakeRpc({ sim: () => usdcSim({ keys, agent: agentSol, agentAta, merchant, merchantAta, out: 1_000_000n }) }) });
  assert.deepEqual(p.intent.payees, [merchant]);
  assert.match(p.card.join("\n"), new RegExp(`Paid to: ${merchant}`));
});

// ---------------------------------------------------------------- 7. status text is scrubbed

test("orders: Crossmint's failure message and delivery titles are scrubbed of the address", async () => {
  const status = { kind: "commerce_order_status", order_id: "ord_test_0001", phase: "delivery", payment_status: "completed", delivery: [{ title: `Parcel for ${SHIP.name}`, status: "failed" }], refunded: null, failure: { code: "address_rejected", message: `cannot deliver to ${SHIP.line1}, ${SHIP.city}` }, at: new Date().toISOString(), meta: {} };
  const s = await C.orderStatus("ord_test_0001", { chain: "base", payer: agentBase }, { fetchImpl: hub(signHub(status)), origin: "https://satohub.test", jwks: JWKS });
  const text = C.statusLines(s).join("\n");
  for (const v of [SHIP.name, SHIP.line1, SHIP.city]) assert.ok(!text.includes(v), `leaked ${v}`);
  assert.match(text, /\[address\]/);
});

// ---------------------------------------------------------------- 9, 11, 12. gift cards

test("a top-up number is bound by an HMAC under a random local key (0600), not a plain hash", () => {
  const h = localHmac("+15551234567");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(localHmac("+15551234567"), h, "the key is made once and reused");
  const keyFile = join(home, "local-hmac.key");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
  assert.equal(key.length, 32);
  assert.equal(h, createHmac("sha256", key).update("+15551234567").digest("hex"));
  assert.notEqual(h, createHash("sha256").update("+15551234567").digest("hex"));
});

test("the gift card price is bound in USDC base units: 25.50 and 25.5 are the same price", async () => {
  setPolicy({ chains: "base", purchases: "ask" });
  const deps = { sleep: async () => {}, pollMs: 0 };
  const err = await B.buyGiftcard({ product: "amazon-us", value: "25" }, { ...deps, fetchImpl: bitrefillWorld({ priceText: "25.50" }).fetch }).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.equal(err.intent.price_units, "25500000");
  assert.equal(err.intent.price_usdc, undefined);
  const r = await B.buyGiftcard({ product: "amazon-us", value: "25", approve: err.approval.code }, { ...deps, fetchImpl: bitrefillWorld({ priceText: "25.5" }).fetch });
  assert.equal(r.delivery.state, "delivered");
});

test("delivery polling stops at an overall deadline (about 4 minutes), and --wait shortens it", async () => {
  let clock = 0;
  const world = bitrefillWorld({ delivered: 1e9 });
  const deps = { fetchImpl: world.fetch, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 3000 };
  const st = await B.waitForDelivery(INVOICE, deps);
  assert.equal(st.state, "pending");
  assert.ok(clock <= B.DELIVERY_DEADLINE_MS && clock >= B.DELIVERY_DEADLINE_MS - 3000, `stopped at ${clock} ms`);
  clock = 0;
  const reads = () => world.log.filter((l) => l.path === "/x402/invoice/status").length;
  const before = reads();
  await B.waitForDelivery(INVOICE, { ...deps, waitMs: 0 });
  assert.equal(reads() - before, 1, "--wait 0 is a single read");
  clock = 0;
  await B.waitForDelivery(INVOICE, { ...deps, waitMs: 10 * 60_000 });
  assert.ok(clock <= B.DELIVERY_DEADLINE_MS, "never longer than the overall deadline");
});

test("a server that keeps refusing the token gets at most one re-sign-in per command", async () => {
  const { rmSync } = await import("node:fs");
  rmSync(join(home, "bitrefill-session.json"), { force: true });
  const world = bitrefillWorld({ rejectToken: true });
  await assert.rejects(B.searchProducts("amazon", {}, { fetchImpl: world.fetch }), /at most once more per command/);
  assert.equal(world.log.filter((l) => l.path === "/x402/connect" && l.siwx).length, 2, "the first sign-in and one re-sign-in, no more");
});

// ---------------------------------------------------------------- 13. EIP-681 checksum

test("EIP-681: a mixed-case recipient must carry a correct checksum; all-lower and all-upper are taken as written", () => {
  const good = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const bad = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";
  const link = (to) => `ethereum:${USDC_BASE}@8453/transfer?address=${to}&uint256=1000000`;
  assert.equal(parseEip681(link(good)).to, good);
  assert.equal(parseEip681(link(good.toLowerCase())).to, good);
  assert.equal(parseEip681(link(`0x${good.slice(2).toUpperCase()}`)).to, good);
  assert.throws(() => parseEip681(link(bad)), refused("checkout_checksum"));
});

// ---------------------------------------------------------------- the real CLI, offline

const cli = (h, args, extra = {}, input) => spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: h, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_TEST_BITREFILL: "{}", ...extra }, encoding: "utf8", timeout: 60_000, input });
const setup = (name, policy = []) => {
  const h = join(home, "..", name);
  cli(h, ["init"]);
  const r = cli(h, ["policy", "set", "--chains", "base", "--per-tx", "50", "--per-day", "100", ...policy]);
  assert.equal(r.status, 0, r.stderr);
  return h;
};

test("CLI: a gift card paid but not delivered exits 4 and says not to buy again (pending and failed)", () => {
  const h = setup("gc-pending", ["--purchases", "auto"]);
  const pending = cli(h, ["giftcard", "buy", "amazon-us", "--value", "25", "--wait", "0"], { SATO_TEST_BITREFILL: JSON.stringify({ delivered: 1e9 }) });
  assert.equal(pending.status, 4, pending.stderr);
  assert.match(pending.stdout, /Paid, not delivered yet — do not buy again; check with `giftcard status inv_test_123456`/);
  assert.ok(!pending.stdout.includes(CODE));
  const failed = cli(h, ["giftcard", "buy", "amazon-us", "--value", "25", "--wait", "0"], { SATO_TEST_BITREFILL: JSON.stringify({ failDelivery: true }) });
  assert.equal(failed.status, 4, failed.stderr);
  assert.match(failed.stdout, /Paid, not delivered yet — do not buy again/);
  assert.match(failed.stdout, /refunds a failed order/);
  const json = cli(h, ["giftcard", "buy", "amazon-us", "--value", "25", "--wait", "0", "--json"], { SATO_TEST_BITREFILL: JSON.stringify({ delivered: 1e9 }) });
  assert.equal(json.status, 4, "exit 4 in --json mode too");
  assert.equal(cli(h, ["giftcard", "buy", "amazon-us", "--value", "25", "--wait", "999"]).status, 2);
});

test("CLI: --approval ask with --purchases auto still asks before a checkout, a deposit payment or a gift card", () => {
  const h = setup("strict", ["--approval", "ask", "--purchases", "auto"]);
  assert.match(cli(h, ["policy", "show"]).stdout, /purchases: +ask the owner first \(because approval is ask/);
  const link = cli(h, ["checkout", `ethereum:${USDC_BASE}@8453/transfer?address=0x1111111111111111111111111111111111111111&uint256=1000000`]);
  assert.equal(link.status, 5, link.stderr);
  const deposit = cli(h, ["checkout", "--to", "0x1111111111111111111111111111111111111111", "--amount", "1.01", "--chain", "base"]);
  assert.equal(deposit.status, 5, deposit.stderr);
  assert.match(deposit.stdout, /Deposit payment: pay exactly 1\.01 USDC on Base to 0x1111111111111111111111111111111111111111/);
  assert.equal(cli(h, ["giftcard", "buy", "amazon-us", "--value", "25"]).status, 5);
  assert.equal(cli(h, ["checkout", "--to", "0x1111111111111111111111111111111111111111", "--amount", "1"]).status, 2, "--chain is required");
});

test("CLI: a link paid through buy is a purchase (price card, owner's yes); the same link through pay keeps pay's own setting", () => {
  const h = setup("via-buy");
  const viaBuy = cli(h, ["buy", "https://x402.test/data"]);
  assert.equal(viaBuy.status, 5, viaBuy.stderr);
  assert.match(viaBuy.stdout, /Pay a link: https:\/\/x402\.test\/data/);
  assert.match(viaBuy.stdout, /Price: 0\.5 USDC on Base, paid to 0x4444444444444444444444444444444444444444/);
  const code = /--approve ([0-9a-f]{8})/.exec(viaBuy.stderr)[1];
  const paid = cli(h, ["buy", "https://x402.test/data", "--approve", code]);
  assert.equal(paid.status, 0, paid.stderr);
  assert.match(paid.stdout, /Paid 0\.5 USDC on base/);
  const direct = cli(h, ["pay", "https://x402.test/data"]);
  assert.equal(direct.status, 0, "pay keeps --approval (auto here)");
});

test("CLI: settings set --stdin reads the address as JSON from stdin, never from argv", () => {
  const h = setup("stdin");
  const body = JSON.stringify({ name: "Grace Hopper", line1: "1 Navy Way", city: "Arlington", state: "va", zip: "22202", country: "United States", email: "grace@example.com" });
  const r = cli(h, ["settings", "set", "--stdin"], {}, body);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(join(h, "settings.json"), "utf8")).ship_to;
  assert.deepEqual(s, { name: "Grace Hopper", line1: "1 Navy Way", city: "Arlington", state: "VA", postalCode: "22202", country: "US", email: "grace@example.com" });
  assert.equal(cli(h, ["settings", "set", "--stdin"], {}, "{\"name\":\"X\",\"phone\":\"1\"}").status, 2, "unknown key");
  assert.equal(cli(h, ["settings", "set", "--stdin", "--ship-name", "X"], {}, body).status, 2, "not both");
  assert.equal(cli(h, ["settings", "set", "--stdin"], {}, "not json").status, 2);
});

test("HELP: dry runs and gift cards are described honestly (sign-in, unpaid invoice, the address sent to Sato Hub)", () => {
  const help = cli(home, ["help"]).stdout;
  assert.doesNotMatch(help, /giftcard buy, order or checkout to run every check/);
  assert.match(help, /giftcard buy --dry-run signs in to Bitrefill \(a sign-in message, not a payment\) and creates an unpaid invoice/);
  assert.match(help, /an order dry run sends the shipping address to Sato Hub and creates a Crossmint quote/);
  assert.match(help, /search and buy \(a dry run too\) sign in to Bitrefill/);
});
