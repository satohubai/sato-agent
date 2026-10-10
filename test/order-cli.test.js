// The real CLI, offline (test/purchase-preload.js answers Sato Hub, its signing keys and a
// Base RPC): the shipping address is set and shown by `settings`, sent only in the order
// request, and never reaches the ledger, stderr or another command's output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toEventSelector } from "viem";
import { freshHome } from "./helpers.js";
import { JWKS, SHIP, SHIP_FLAGS, SHIP_SECRETS, orderQuote, signHub } from "./purchase-helpers.js";

const home = freshHome();
const { recipientOf, recipientSha256 } = await import("../src/commerce.js");
const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./purchase-preload.js", import.meta.url));
const baseEnv = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "https://satohub.ai/api/mcp", SATO_AGENT_BASE_RPC: "https://base-rpc.test", SATO_TEST_HUB: "{}" };
const run = (args, hub) => spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...baseEnv, ...(hub ? { SATO_TEST_HUB: JSON.stringify(hub) } : {}) }, encoding: "utf8", timeout: 60_000 });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MERCHANT = "0x2222222222222222222222222222222222222222";
const noAddress = (text, where) => {
  for (const s of SHIP_SECRETS) assert.ok(!String(text).includes(s), `${where} holds "${s}"`);
};
const ledger = () => readFileSync(join(home, "ledger.jsonl"), "utf8");

let agent;
test("setup: wallet, limits, and the shipping address (mode 600, shown back by settings, only 'set' in status)", () => {
  agent = JSON.parse(run(["init", "--json"]).stdout).base;
  assert.equal(run(["policy", "set", "--chains", "base", "--per-tx", "50", "--per-day", "100"]).status, 0);
  assert.equal(run(["settings", "set", "--ship-name", "Ada"]).status, 2, "the first time needs every field");
  const set = run(["settings", "set", ...SHIP_FLAGS]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /1729 Ramanujan Street/);
  assert.equal(statSync(join(home, "settings.json")).mode & 0o777, 0o600);
  assert.match(run(["settings", "show"]).stdout, /Ada Quartermaine\n.*1729 Ramanujan Street\n.*Apt 42\n.*Springfield, IL 62704/);
  const st = run(["status"]);
  assert.match(st.stdout, /shipping address: set/);
  noAddress(st.stdout, "status");
  noAddress(run(["status", "--json"]).stdout, "status --json");
  noAddress(run(["policy", "show"]).stdout, "policy show");
  // Stored in the form Sato Hub hashes: "USA" / "United States" -> "US"; the state only as its two-letter code.
  assert.equal(run(["settings", "set", "--ship-country", "United States"]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).ship_to.country, "US");
  assert.equal(run(["settings", "set", "--ship-country", "Canada"]).status, 2);
  const state = run(["settings", "set", "--ship-state", "Illinois"]);
  assert.equal(state.status, 2);
  assert.match(state.stderr, /two-letter state code, like CA/);
  assert.equal(run(["settings", "set", "--ship-state", "il"]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).ship_to.state, "IL");
  assert.equal(run(["settings", "set", "--ship-name", "Ada‮evil"]).status, 2, "an invisible direction mark is refused");
});

test("order: not switched on yet (503) is a plain exit 3; nothing in the ledger or stderr names the address", () => {
  const r = run(["order", "https://www.amazon.com/dp/B0TESTASIN"], { order: { status: 503, json: { error: "orders_not_enabled" } } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /not switched on yet/);
  noAddress(r.stderr, "stderr");
  noAddress(ledger(), "the ledger");
});

test("order: an error that echoes the address is scrubbed on stderr", () => {
  const r = run(["order", "B0TESTASIN"], { order: { status: 422, json: { error: `cannot ship to ${SHIP.line1}, ${SHIP.name} <${SHIP.email}>` } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 422/);
  noAddress(r.stderr, "stderr");
});

test("order: an unsigned quote is refused (exit 3)", () => {
  const body = orderQuote({ payer: agent, recipientSha: recipientSha256(recipientOf(SHIP)) });
  const r = run(["order", "B0TESTASIN"], { order: { json: body }, jwks: JWKS });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /order_unsigned/);
});

test("order: a quote for another address is refused (exit 3) without naming either address", () => {
  const body = signHub(orderQuote({ payer: agent, recipientSha: recipientSha256({ ...recipientOf(SHIP), line1: "9 Elsewhere Lane" }) }));
  const r = run(["order", "B0TESTASIN"], { order: { json: body }, jwks: JWKS });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /not the shipping address this bot holds/);
  noAddress(r.stderr, "stderr");
  assert.ok(!r.stderr.includes("Elsewhere"));
});

test("order (ask): the card on stdout shows the recipient to the owner; stderr and the ledger never hold the address; a dry run signs nothing", () => {
  const pad = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
  const simLogs = [{ address: USDC, topics: [toEventSelector("Transfer(address,address,uint256)"), pad(agent), pad(MERCHANT)], data: `0x${(21_500_000).toString(16).padStart(64, "0")}` }];
  const serialized = JSON.stringify({ to: USDC, data: "0xa9059cbb", chainId: 8453 });
  const body = signHub(orderQuote({ payer: agent, recipientSha: recipientSha256(recipientOf(SHIP)), serialized, encoding: "json" }));
  const hub = { order: { json: body }, jwks: JWKS, simLogs };
  const ask = run(["order", "https://www.amazon.com/dp/B0TESTASIN"], hub);
  assert.equal(ask.status, 5, ask.stderr);
  assert.match(ask.stdout, /Amazon order: Mechanical pencil, 0\.5 mm/);
  assert.match(ask.stdout, /Item \$19\.99 · tax \$1\.51 · shipping \$0\.00 · total 21\.5 USDC on Base\. No Sato Hub fee\./);
  assert.match(ask.stdout, /Ships to: Ada Quartermaine, Springfield, IL 62704/);
  noAddress(ask.stderr, "stderr");
  noAddress(ledger(), "the ledger");
  const askJson = run(["order", "B0TESTASIN", "--json"], hub);
  assert.equal(askJson.status, 5);
  noAddress(JSON.stringify(JSON.parse(askJson.stdout).needs_approval.intent), "the approval intent");
  const dry = run(["order", "B0TESTASIN", "--dry-run"], hub);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  noAddress(ledger(), "the ledger");
  assert.ok(!ledger().includes('"kind":"order"'), "a dry run reserves nothing");
});

test("buy routes an Amazon link to order and explains anything it cannot pay", () => {
  const r = run(["buy", "https://www.amazon.com/dp/B0TESTASIN"], { order: { status: 503, json: { error: "orders_not_enabled" } } });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /Reading this as an Amazon product/);
  const junk = run(["buy", "a nice lamp"]);
  assert.equal(junk.status, 2);
  assert.match(junk.stderr, /Solana Pay request/);
  assert.match(junk.stderr, /giftcard search/);
  assert.doesNotMatch(junk.stderr, /recommend|suggest/i, "never suggests what to buy");
});

test("checkout: a link for another token is refused (exit 3); a Solana Pay request on a Base-only agent is refused; anything else is a usage error", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const other = run(["checkout", `ethereum:0x2222222222222222222222222222222222222222@8453/transfer?address=${to}&uint256=1000000`]);
  assert.equal(other.status, 3);
  assert.match(other.stderr, /checkout_token/);
  const sol = run(["checkout", "solana:So11111111111111111111111111111111111111112?amount=1"]);
  assert.equal(sol.status, 3);
  assert.match(sol.stderr, /chain_not_allowed/);
  assert.equal(run(["checkout", "bitcoin:bc1qxyz"]).status, 2);
});

test("settings set --ship-clear removes the address", () => {
  assert.equal(run(["settings", "set", "--ship-clear"]).status, 0);
  assert.doesNotMatch(run(["status"]).stdout, /shipping address/, "with no address set, status says nothing about it");
  const r = run(["order", "B0TESTASIN"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /ship_to_not_set/);
});
