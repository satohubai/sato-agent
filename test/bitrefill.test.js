// Gift cards from Bitrefill, offline against a stand-in (test/bitrefill-world.js): the
// sign-in message the kit will and will not sign, the price-first flow, the x402 payment
// bound to the invoice, and the code: printed once, kept in a 0600 file, never in the
// ledger or an error. No test here talks to Bitrefill or creates an account.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { freshHome } from "./helpers.js";
import { CODE, INVOICE, PAY_TO, PIN, TOKEN, bitrefillWorld, siwxInfo } from "./bitrefill-world.js";

const home = freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused, NeedsApproval } = await import("../src/errors.js");
const B = await import("../src/bitrefill.js");
const { entries, spentLast24h } = await import("../src/ledger.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./purchase-preload.js", import.meta.url));
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);
initWallet();
const me = addresses().base;
const chains = [{ chainId: "eip155:8453", type: "eip191" }];
const check = (over, extra = {}) => B.checkSiwxChallenge({ info: siwxInfo(Date.now(), over), supportedChains: extra.supportedChains ?? chains }, { address: extra.address ?? me });

test("SIWX: a Bitrefill sign-in for api.bitrefill.com on Base, for this wallet, builds the EIP-4361 message Bitrefill documents", () => {
  const { message, payload } = check({});
  assert.match(message, /^api\.bitrefill\.com wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\nSign in to Bitrefill/);
  assert.match(message, /\nURI: https:\/\/api\.bitrefill\.com\/x402\/connect\nVersion: 1\nChain ID: 8453\nNonce: a1b2c3d4e5f6a7b8\nIssued At: .*\nExpiration Time: .*\nResources:\n- https:\/\/api\.bitrefill\.com\/x402\/connect$/);
  const p = parseSiweMessage(message);
  assert.equal(p.address, me, "EIP-55 checksummed: Bitrefill refuses a lower-case address");
  assert.equal(p.chainId, 8453);
  assert.equal(payload.chainId, "eip155:8453");
  assert.equal(payload.type, "eip191");
  assert.equal(payload.address, me);
});

test("SIWX: anything but Bitrefill's own domain, Base, this wallet, Bitrefill-only resources and a short expiry is refused (exit 3)", () => {
  const cases = [
    [{ domain: "api.bitrefill.com.evil.example" }],
    [{ domain: "bitrefill.com" }],
    [{ uri: "https://evil.example/x402/connect" }],
    [{ uri: "http://api.bitrefill.com/x402/connect" }],
    [{ uri: "https://api.bitrefill.com:8443/x402/connect" }],
    [{ chainId: "eip155:1" }],
    [{}, { supportedChains: [{ chainId: "eip155:1", type: "eip191" }] }],
    [{}, { supportedChains: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", type: "ed25519" }] }],
    [{ address: "0x1111111111111111111111111111111111111111" }],
    [{ resources: ["https://api.bitrefill.com/x402/connect", "https://evil.example/drain"] }],
    [{ resources: ["ipfs://bafy..."] }],
    [{ expirationTime: new Date(Date.now() + 2 * 3600_000).toISOString() }],
    [{ expirationTime: new Date(Date.now() - 1000).toISOString() }],
    [{ expirationTime: undefined }],
    [{ issuedAt: new Date(Date.now() - 3600_000).toISOString() }],
    [{ nonce: "short" }],
    [{ statement: "line one\nURI: https://evil.example" }],
    [{ version: "2" }],
  ];
  for (const [over, extra] of cases) assert.throws(() => check(over, extra), refused("siwx_refused"), JSON.stringify(over ?? extra));
  // The agent's own address in a different letter case is still the agent's.
  check({ address: me.toLowerCase() });
});

test("the sign-in signs exactly the checked message with the agent's key, keeps the token in a 0600 file, and never logs it", async () => {
  const world = bitrefillWorld();
  const token = await B.signIn({ fetchImpl: world.fetch });
  assert.equal(token, TOKEN);
  const [first, second] = world.log;
  assert.equal(first.siwx, null);
  const sent = JSON.parse(Buffer.from(second.siwx, "base64").toString("utf8"));
  assert.equal(sent.domain, "api.bitrefill.com");
  assert.equal(sent.chainId, "eip155:8453");
  const { message } = B.checkSiwxChallenge({ info: { ...siwxInfo(), issuedAt: sent.issuedAt, expirationTime: sent.expirationTime }, supportedChains: chains }, { address: me });
  assert.equal(await verifyMessage({ address: me, message, signature: sent.signature }), true, "a personal_sign signature by the agent's own key");
  assert.match(first.ua, /^sato-agent\//);
  const file = join(home, "bitrefill-session.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await B.signIn({ fetchImpl: () => assert.fail("a saved token is reused") }), TOKEN);
  const ledger = readFileSync(join(home, "ledger.jsonl"), "utf8");
  assert.match(ledger, /"kind":"signin"/);
  assert.ok(!ledger.includes(TOKEN), "the token is not in the ledger");
});

test("a challenge for another domain is refused and nothing is signed", async () => {
  const { rmSync } = await import("node:fs");
  rmSync(join(home, "bitrefill-session.json"), { force: true });
  const world = bitrefillWorld({ info: { domain: "login.evil.example" } });
  await assert.rejects(B.signIn({ fetchImpl: world.fetch }), refused("siwx_refused"));
  assert.equal(world.log.length, 1, "no signed second request");
});

test("search and detail: read-only, after sign-in, cleaned", async () => {
  const world = bitrefillWorld();
  const list = await B.searchProducts("amazon", { country: "us" }, { fetchImpl: world.fetch });
  assert.deepEqual(list.map((p) => p.slug), ["amazon-us", "steam-usa"]);
  assert.equal(list[1].name, "Steam [31m", "a terminal escape is cleaned out");
  assert.equal(world.log.at(-1).search, "?q=amazon&country=US");
  const d = await B.productDetail("amazon-us", { fetchImpl: world.fetch });
  assert.deepEqual(d.packages.map((p) => p.value), ["25", "50"]);
});

test("buy (ask): the price card first, exit-5 semantics, nothing paid; the owner's yes pays the invoice and returns the code", async () => {
  setPolicy({ chains: "base", perTx: "50", perDay: "100" });
  const world = bitrefillWorld();
  const deps = { fetchImpl: world.fetch, sleep: async () => {}, pollMs: 0 };
  const err = await B.buyGiftcard({ product: "amazon-us", value: "25" }, deps).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.match(err.card.join("\n"), /Price: 25\.5 USDC on Base, paid to Bitrefill \(0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A\)\. No Sato Hub fee\./);
  assert.equal(world.log.filter((l) => l.paid).length, 0);
  assert.equal(spentLast24h().usd, 0);
  const r = await B.buyGiftcard({ product: "amazon-us", value: "25", approve: err.approval.code }, deps);
  assert.equal(r.payment.settled, true);
  assert.equal(r.payment.usd, 25.5);
  assert.equal(r.payment.pay_to, PAY_TO);
  const payReq = world.log.find((l) => l.path === "/x402/invoice/pay" && l.paid);
  assert.equal(payReq.token, TOKEN);
  assert.equal(payReq.payment.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(payReq.payment.payload.authorization.value, "25500000");
  assert.equal(payReq.payment.accepted.network, "eip155:8453", "the Base offer, never the Arbitrum one");
  assert.equal(r.delivery.state, "delivered");
  assert.equal(statSync(r.codes_path).mode & 0o777, 0o600);
  assert.deepEqual(B.savedCodes(INVOICE), [{ code: CODE, pin: PIN }]);
  assert.equal(B.codesLine(r.delivery.codes), `GIFT CARD CODE (secret: for the owner only; never post, log or share it): code ${CODE}, PIN ${PIN}`);
  const row = entries().filter((e) => e.kind === "x402").at(-1);
  assert.equal(row.purchase, "giftcard");
  assert.equal(row.invoice_id, INVOICE);
  const ledger = readFileSync(join(home, "ledger.jsonl"), "utf8");
  assert.ok(!ledger.includes(CODE) && !ledger.includes(PIN), "the code is never in the ledger");
});

test("buy: the price counts against the limits before the owner is asked; a package Bitrefill does not offer is refused", async () => {
  setPolicy({ perTx: "20" });
  const world = bitrefillWorld();
  await assert.rejects(B.buyGiftcard({ product: "amazon-us", value: "25" }, { fetchImpl: world.fetch }), refused("max_usd_per_tx"));
  await assert.rejects(B.buyGiftcard({ product: "amazon-us", value: "30" }, { fetchImpl: world.fetch }), /offers 25, 50/);
  setPolicy({ perTx: "50" });
});

test("buy: a payee other than Bitrefill's at pay time is refused, nothing signed", async () => {
  setPolicy({ purchases: "auto" });
  const world = bitrefillWorld({ payTo: "0x9999999999999999999999999999999999999999" });
  await assert.rejects(B.buyGiftcard({ product: "amazon-us", value: "25" }, { fetchImpl: world.fetch, sleep: async () => {}, pollMs: 0 }), refused("payee_changed"));
  assert.equal(world.log.filter((l) => l.paid).length, 0);
});

test("buy: a failed delivery is reported (Bitrefill refunds to the paying wallet) and no code is saved", async () => {
  const world = bitrefillWorld({ failDelivery: true });
  const r = await B.buyGiftcard({ product: "amazon-us", value: "50" }, { fetchImpl: world.fetch, sleep: async () => {}, pollMs: 0 });
  assert.equal(r.delivery.state, "failed");
  assert.equal(r.codes_path, null);
  setPolicy({ purchases: "ask" });
});

test("a Solana-only agent is told gift cards are on Base for now (exit 3)", () => {
  assert.throws(() => B.assertBaseAgent({ chains: ["solana"] }), refused("giftcards_base_only"));
  B.assertBaseAgent({ chains: ["base", "solana"] });
});

// ---------------------------------------------------------------- the real CLI, offline

const cliHome = join(home, "..", "cli");
const env = { ...process.env, SATO_AGENT_HOME: cliHome, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_TEST_BITREFILL: "{}" };
const run = (args, extra = {}) => spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });

test("CLI: giftcard buy asks first, then prints the code once, as the last line; never in the ledger or on stderr", () => {
  assert.equal(run(["init"]).status, 0);
  assert.equal(run(["policy", "set", "--chains", "base", "--per-tx", "50", "--per-day", "100"]).status, 0);
  const ask = run(["giftcard", "buy", "amazon-us", "--value", "25"]);
  assert.equal(ask.status, 5, ask.stderr);
  assert.match(ask.stdout, /Price: 25\.5 USDC on Base/);
  const code = /--approve ([0-9a-f]{8})/.exec(ask.stderr)[1];
  const paid = run(["giftcard", "buy", "amazon-us", "--value", "25", "--approve", code]);
  assert.equal(paid.status, 0, paid.stderr);
  const lines = paid.stdout.trim().split("\n");
  assert.equal(lines.at(-1), `GIFT CARD CODE (secret: for the owner only; never post, log or share it): code ${CODE}, PIN ${PIN}`);
  assert.equal(lines.filter((l) => l.includes(CODE)).length, 1, "printed once");
  assert.ok(!paid.stderr.includes(CODE) && !ask.stderr.includes(CODE));
  const ledger = readFileSync(join(cliHome, "ledger.jsonl"), "utf8");
  assert.ok(!ledger.includes(CODE) && !ledger.includes(PIN) && !ledger.includes(TOKEN));
  assert.equal(statSync(join(cliHome, "giftcards", `${INVOICE}.json`)).mode & 0o777, 0o600);
  // The status command reads the saved code back, on its last line only.
  const st = run(["giftcard", "status", INVOICE]);
  assert.equal(st.status, 0);
  assert.match(st.stdout.trim().split("\n").at(-1), new RegExp(`code ${CODE}`));
  // Other commands never print it.
  for (const r of [run(["status"]), run(["history"]), run(["proof"]), run(["status", "--json"])]) assert.ok(!r.stdout.includes(CODE) && !r.stderr.includes(CODE));
});

test("CLI: a hostile sign-in challenge is refused with exit 3 and no signature leaves", () => {
  const h = join(home, "..", "cli-evil");
  const e = { SATO_AGENT_HOME: h, SATO_TEST_BITREFILL: JSON.stringify({ info: { domain: "api.bitrefill.com.evil.example" } }) };
  run(["init"], e);
  run(["policy", "set", "--chains", "base", "--per-tx", "50", "--per-day", "100", "--purchases", "auto"], e);
  const r = run(["giftcard", "buy", "amazon-us", "--value", "25"], e);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /siwx_refused/);
  assert.ok(!existsSync(join(h, "bitrefill-session.json")));
});

test("CLI: a Solana-only agent gets a plain explanation for gift cards", () => {
  const h = join(home, "..", "cli-sol");
  run(["init"], { SATO_AGENT_HOME: h });
  run(["policy", "set", "--chains", "solana", "--per-tx", "50", "--per-day", "100"], { SATO_AGENT_HOME: h });
  const r = run(["giftcard", "buy", "amazon-us", "--value", "25"], { SATO_AGENT_HOME: h });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /paid in USDC on Base for now/);
});

test("only the Bitrefill sign-in signs a message anywhere in the kit", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".js"));
  const signing = files.filter((f) => /signMessage\(|signTypedData\(/.test(readFileSync(join(src, f), "utf8")));
  assert.deepEqual(signing, ["bitrefill.js"]);
});
