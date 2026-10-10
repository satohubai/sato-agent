// Purchases follow the owner's purchase setting (ask unless set to auto; ask -> auto is
// a raise), and count against the same limits and spend lock as every spend.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy, loadPolicy, purchasesAsk, raisesBetween } = await import("../src/policy.js");
const { NeedsApproval, Refused } = await import("../src/errors.js");
const { purchaseGate, checkLimits, purchaseChain } = await import("../src/purchase.js");
const { executeOrder } = await import("../src/commerce.js");
const { entries, spentLast24h } = await import("../src/ledger.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
const MERCHANT = "0x2222222222222222222222222222222222222222";
initWallet();

test("unset means ask; ask -> auto is a raise and is logged; auto -> ask is not", () => {
  setPolicy({ chains: "base", perTx: "50", perDay: "100" });
  assert.equal(loadPolicy().purchase_approval, null);
  assert.equal(purchasesAsk(loadPolicy()), true, "unset asks");
  const up = setPolicy({ purchases: "auto" });
  assert.deepEqual(up.raises, ["purchases: ask -> auto"]);
  assert.equal(purchasesAsk(up.policy), false);
  assert.equal(entries().filter((e) => e.kind === "policy").at(-1).status, "raised");
  const down = setPolicy({ purchases: "ask" });
  assert.equal(down.raised, false);
  assert.throws(() => setPolicy({ purchases: "sometimes" }), /--purchases must be one of: ask, auto/);
  // A raise is computed against an unset previous value too.
  assert.deepEqual(raisesBetween({ chains: ["base"], max_usd_per_tx: 1, max_usd_per_day: 1 }, { chains: ["base"], max_usd_per_tx: 1, max_usd_per_day: 1, purchase_approval: "auto" }), ["purchases: ask -> auto"]);
  // x402 pay and send keep their own setting: --purchases does not touch `approval`.
  assert.equal(loadPolicy().approval, null);
});

test("ask mode: a purchase stops with exit-5 semantics and its card; the code works once for that exact purchase", async () => {
  setPolicy({ purchases: "ask" });
  const intent = { cmd: "giftcard", chain: "base", product: "amazon-us", value: "25", price_usdc: "25.5" };
  const err = await purchaseGate(intent, { card: ["Gift card: Amazon", "Price: 25.5 USDC"] }).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.deepEqual(err.card, ["Gift card: Amazon", "Price: 25.5 USDC"]);
  assert.doesNotMatch(err.message, /Price: 25.5/, "the card is printed by the CLI on stdout, not in the error text");
  await assert.rejects(purchaseGate({ ...intent, price_usdc: "30" }, { approve: err.approval.code }), /different intent/);
  // A failed match does not burn the code; the right intent consumes it once.
  await purchaseGate(intent, { approve: err.approval.code });
  await assert.rejects(purchaseGate(intent, { approve: err.approval.code }), /not found|already used/);
  // A dry run never asks.
  assert.deepEqual(await purchaseGate(intent, { dryRun: true }), { asked: false });
});

test("auto mode: no approval is asked, the limits still apply", async () => {
  setPolicy({ purchases: "auto" });
  assert.deepEqual(await purchaseGate({ cmd: "order" }, {}), { asked: false });
  assert.throws(() => checkLimits({ usd: 60, chain: "base" }), (e) => e instanceof Refused && e.refusals[0].rule === "max_usd_per_tx");
  assert.throws(() => checkLimits({ usd: 5, chain: "solana" }), (e) => e instanceof Refused && e.refusals[0].rule === "chain_not_allowed");
  assert.throws(() => purchaseChain("solana"), (e) => e instanceof Refused && e.refusals[0].rule === "chain_not_allowed");
  assert.equal(purchaseChain(undefined), "base");
});

test("the recipient allowlist covers every payee a purchase pays, not just the first", () => {
  setPolicy({ allowRecipients: [MERCHANT] });
  checkLimits({ usd: 1, chain: "base", to: MERCHANT, payees: [MERCHANT] });
  assert.throws(() => checkLimits({ usd: 1, chain: "base", to: MERCHANT, payees: [MERCHANT, "0x3333333333333333333333333333333333333333"] }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "allow_recipients"));
  setPolicy({ allowRecipients: null });
});

const quote = (usd) => ({ chain: "base", order_id: `ord_${Math.random().toString(36).slice(2, 10)}`, title: "Test item", expires_at: new Date(Date.now() + 600_000).toISOString(), price: { total_base_units: BigInt(Math.round(usd * 1e6)) } });
const check = { payees: [MERCHANT], prepared: { to: MERCHANT, data: "0x" } };
const okReceipt = (n) => async (_c, _tx, onSigned) => {
  const hash = `0x${String(n).repeat(64).slice(0, 64)}`;
  onSigned(hash);
  return { status: "success", transactionHash: hash };
};

test("an order counts against the per-transaction and 24-hour limits, reserved before anything is signed", async () => {
  setPolicy({ perTx: "50", perDay: "80" });
  const before = spentLast24h().usd;
  let signed = 0;
  const sign = async (...a) => (signed++, okReceipt(1)(...a));
  const r = await executeOrder(quote(40), check, { usd: 40, payer: "0x0", c: {}, signAndSend: sign });
  assert.match(r.explorer, /basescan/);
  assert.equal(spentLast24h().usd, before + 40);
  const row = entries().filter((e) => e.kind === "order").at(-1);
  assert.equal(row.merchant, "crossmint");
  await assert.rejects(executeOrder(quote(55), check, { usd: 55, payer: "0x0", c: {}, signAndSend: sign }), (e) => e instanceof Refused && e.refusals[0].rule === "max_usd_per_tx");
  await assert.rejects(executeOrder(quote(45), check, { usd: 45, payer: "0x0", c: {}, signAndSend: sign }), (e) => e instanceof Refused && e.refusals[0].rule === "max_usd_per_day");
  assert.equal(signed, 1, "nothing is signed for a refused order");
});

test("the spend lock: two orders at once cannot both squeeze under the 24-hour limit", async () => {
  setPolicy({ perTx: "50", perDay: String(spentLast24h().usd + 45) });
  const slow = async (c, tx, onSigned) => {
    await new Promise((res) => setTimeout(res, 50));
    return okReceipt(2)(c, tx, onSigned);
  };
  const results = await Promise.allSettled([
    executeOrder(quote(30), check, { usd: 30, payer: "0x0", c: {}, signAndSend: slow }),
    executeOrder(quote(30), check, { usd: 30, payer: "0x0", c: {}, signAndSend: slow }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const refused = results.find((x) => x.status === "rejected").reason;
  assert.ok(refused instanceof Refused && refused.refusals[0].rule === "max_usd_per_day");
});

test("a reverted order payment is released; an expired quote is refused before anything is reserved", async () => {
  setPolicy({ perDay: "1000" });
  const before = spentLast24h().usd;
  const revert = async (_c, _tx, onSigned) => (onSigned(`0x${"9".repeat(64)}`), { status: "reverted", transactionHash: `0x${"9".repeat(64)}` });
  await assert.rejects(executeOrder(quote(10), check, { usd: 10, payer: "0x0", c: {}, signAndSend: revert }), /reverted/);
  assert.equal(spentLast24h().usd, before);
  const stale = { ...quote(10), expires_at: new Date(Date.now() + 1000).toISOString() };
  await assert.rejects(executeOrder(stale, check, { usd: 10, payer: "0x0", c: {}, signAndSend: revert }), (e) => e instanceof Refused && e.refusals[0].rule === "quote_expired");
});

test("CLI: --purchases is shown, flagged as a raise, and status says whether an address is set (never the address)", () => {
  run("policy", "set", "--purchases", "ask");
  const up = run("policy", "set", "--purchases", "auto");
  assert.equal(up.status, 0);
  assert.match(up.stdout, /RAISED \(purchases: ask -> auto\)/);
  assert.match(up.stdout, /purchases: +buy within the limits/);
  assert.match(run("policy", "set", "--purchases", "ask").stdout, /purchases: +ask the owner first/);
  assert.equal(run("policy", "set", "--purchases", "maybe").status, 1);
  const st = run("status");
  assert.doesNotMatch(st.stdout, /shipping address/, "no address set: no address line (Amazon is off until Sato Hub turns it on)");
  assert.match(st.stdout, /\(gift cards, checkouts, and links paid through buy\)/);
  assert.doesNotMatch(st.stdout, /Amazon/);
  const sj = JSON.parse(run("status", "--json").stdout);
  assert.equal(sj.purchases, "ask");
  assert.equal(sj.shipping_address, "not set");
});
