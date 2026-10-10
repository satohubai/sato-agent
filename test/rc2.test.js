// v0.3.0-rc.2: fixes from the live round of rc.1 (2026-10-10), one test (or more) each.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generateKeyPairSigner } from "@solana/kit";
import { freshHome } from "./helpers.js";
import { bitrefillWorld } from "./bitrefill-world.js";
import { fakeRpc } from "./purchase-solana-helpers.js";

const home = freshHome();
const { initWallet, evmAccount } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const B = await import("../src/bitrefill.js");
const C = await import("../src/commerce.js");
const baseChain = await import("../src/base.js");
const solana = await import("../src/solana.js");
const { entries, spentLast24h } = await import("../src/ledger.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./purchase-preload.js", import.meta.url));
const ROOT = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);
initWallet();
const fast = { sleep: async () => {}, pollMs: 0 };

// ---------------------------------------------------------------- 1. the gift card price, in explicit units

test("1: Bitrefill's price_usdc is read in explicit units; a base-unit price of 5250000 is $5.25, never $5,250,000", () => {
  const p = (j, terms) => B.invoicePrice(j, terms);
  // As seen live: base units, with Bitrefill's USD figure.
  assert.deepEqual(p({ price_usdc: "5250000", price_usd: 5.25 }), { units: 5_250_000n, usd: 5.25, text: "5.25", form: "usdc_base_units" });
  assert.equal(p({ price_usdc: 5250000, price_usd: 5.25 }).usd, 5.25, "a number too");
  // As documented: a decimal amount.
  assert.equal(p({ price_usdc: "5.25" }).usd, 5.25);
  assert.equal(p({ price_usdc: 5.25, price_usd: "5.25" }).units, 5_250_000n);
  // Whole dollars, settled by price_usd.
  assert.equal(p({ price_usdc: "5", price_usd: 5 }).usd, 5);
  // The x402 terms (base units) are the authority, and settle an integer without price_usd.
  assert.equal(p({ price_usdc: "5250000" }, 5_250_000n).usd, 5.25);
  assert.equal(p({ price_usdc: "5" }, 5_000_000n).usd, 5);
  assert.equal(p({ price_usdc: "5.25" }, 5_250_000n).form, "usdc_decimal");
  // Ambiguous or disagreeing: refused, never guessed.
  assert.throws(() => p({ price_usdc: "5250000" }), refused("giftcard_price_unclear"));
  assert.throws(() => p({ price_usdc: "5.25", price_usd: 9 }), refused("giftcard_price_unclear"));
  assert.throws(() => p({ price_usdc: "5.25" }, 6_000_000n), refused("giftcard_price_unclear"));
  assert.throws(() => p({ price_usdc: "abc", price_usd: 5 }), refused("giftcard_price_unclear"));
});

test("1: a realistic invoice ($5 Amazon.com USA, price_usdc 5250000) is held to the limits as $5.25 in every shape", async () => {
  setPolicy({ chains: "base", perTx: "6", perDay: "10", purchases: "auto" });
  for (const opts of [{ priceShape: "units" }, { priceShape: "units_number" }, { priceShape: "decimal" }, { priceShape: "units", noPriceUsd: true }]) {
    const world = bitrefillWorld({ priceUnits: "5250000", ...opts });
    const r = await B.buyGiftcard({ product: "amazon_com-usa", value: "5", dryRun: true }, { ...fast, fetchImpl: world.fetch });
    assert.equal(r.usd, 5.25, JSON.stringify(opts));
    assert.match(r.card.join("\n"), /Price: 5\.25 USDC on Base/);
    assert.equal(world.log.filter((l) => l.paid).length, 0, "the unpaid terms ask signs nothing");
  }
  // The limits see $5.25: a $5 per-transaction limit refuses it, observing 5.25.
  setPolicy({ perTx: "5" });
  const err = await B.buyGiftcard({ product: "amazon_com-usa", value: "5", dryRun: true }, { ...fast, fetchImpl: bitrefillWorld({ priceUnits: "5250000", priceShape: "units" }).fetch }).catch((e) => e);
  assert.ok(refused("max_usd_per_tx")(err));
  assert.equal(err.refusals[0].observed, 5.25);
  setPolicy({ perTx: "6" });
  // And it pays exactly 5250000 base units.
  const paid = await B.buyGiftcard({ product: "amazon_com-usa", value: "5" }, { ...fast, fetchImpl: bitrefillWorld({ priceUnits: "5250000", priceShape: "units" }).fetch });
  assert.equal(paid.payment.amount_atomic, "5250000");
  assert.equal(paid.payment.usd, 5.25);
  assert.equal(entries().filter((e) => e.kind === "x402").at(-1).usd, 5.25);
});

const cli = (h, args, extra = {}, input) => spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: h, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_TEST_BITREFILL: "{}", SATO_TEST_HUB: "{}", ...extra }, encoding: "utf8", timeout: 60_000, input });
const cliHome = (name, chains = "base", more = []) => {
  const h = join(home, "..", name);
  cli(h, ["init"]);
  const r = cli(h, ["policy", "set", "--chains", chains, "--per-tx", "50", "--per-day", "100", ...more]);
  assert.equal(r.status, 0, r.stderr);
  return h;
};

test("1 (CLI): the rc.1 run, again: --value 5 dry run shows $5.25; --value 1 lists the values; search and detail show them", () => {
  const h = cliHome("rc2-gift", "base");
  const priced = { SATO_TEST_BITREFILL: JSON.stringify({ priceUnits: "5250000", priceShape: "units" }) };
  const dry = cli(h, ["giftcard", "buy", "amazon_com-usa", "--value", "5", "--dry-run"], priced);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Price: 5\.25 USDC on Base/);
  const one = cli(h, ["giftcard", "buy", "amazon_com-usa", "--value", "1", "--dry-run"], priced);
  assert.equal(one.status, 1);
  assert.match(one.stderr, /offers 1000, 500, 200, 100, 50, 20, 10, 5/);
  const detail = cli(h, ["giftcard", "detail", "amazon_com-usa"]);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /values: 1000 USD, 500 USD, 200 USD, 100 USD, 50 USD, 20 USD, 10 USD, 5 USD/);
  const search = cli(h, ["giftcard", "search", "amazon"]);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /amazon-us +Amazon \(US\)\n +values: 25, 50/);
  assert.match(search.stdout, /giftcard detail <product id>/);
});

// ---------------------------------------------------------------- 2. checkouts are recorded as checkouts

test("2: an EIP-681 or deposit checkout is recorded as kind checkout with its subtype, counts toward the limits, and shows as checkout:<subtype>", async () => {
  setPolicy({ chains: "base,solana", perTx: "50", perDay: "100" });
  const account = evmAccount();
  const c = {
    account,
    pub: { simulateContract: async () => ({}), sendRawTransaction: async () => "0x", waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash }) },
    wallet: { prepareTransactionRequest: async (x) => ({ ...x, nonce: 0, gas: 60_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 8453, type: "eip1559" }), signTransaction: (p) => account.signTransaction(p) },
  };
  const before = spentLast24h().usd;
  await baseChain.sendUsdc({ to: "0x1111111111111111111111111111111111111111", amount: "1.01", checkout: "eip681" }, c);
  const row = entries().filter((e) => e.status === "submitted").at(-1);
  assert.equal(row.kind, "checkout");
  assert.equal(row.checkout, "eip681");
  assert.equal(spentLast24h().usd, before + 1.01);
  // A plain send is still a send.
  await baseChain.sendUsdc({ to: "0x1111111111111111111111111111111111111111", amount: "0.5" }, c);
  assert.equal(entries().filter((e) => e.status === "submitted").at(-1).kind, "send");
  const env = { ...process.env, SATO_AGENT_HOME: home };
  const hist = spawnSync(process.execPath, [BIN, "history"], { env, encoding: "utf8" });
  assert.match(hist.stdout, /checkout:eip681/);
  assert.match(hist.stdout, /\bsend\b/);
  const st = spawnSync(process.execPath, [BIN, "status"], { env, encoding: "utf8" });
  assert.match(st.stdout, /checkout:eip681/);
});

test("2: a Solana deposit checkout is recorded as checkout:deposit", async () => {
  const merchant = (await generateKeyPairSigner()).address;
  const rpc = fakeRpc({ sim: () => ({ err: null }) });
  await solana.sendUsdc({ to: merchant, amount: "2", checkout: "deposit" }, rpc);
  const row = entries().filter((e) => e.status === "submitted").at(-1);
  assert.equal(row.kind, "checkout");
  assert.equal(row.checkout, "deposit");
  assert.equal(row.chain, "solana");
});

// ---------------------------------------------------------------- 3. one address command

test("3: the no-address refusal points to settings set --stdin, not the flags", async () => {
  const err = await C.placeOrder({ input: "B0TESTASIN", chain: "base" }, { fetchImpl: () => assert.fail("no request without an address") }).catch((e) => e);
  assert.ok(refused("ship_to_not_set")(err));
  assert.match(err.message, /settings set --stdin/);
  assert.doesNotMatch(err.message, /--ship-name/);
});

// ---------------------------------------------------------------- 4. Amazon only when it is on

test("4: order --available reads GET <origin>/api/commerce/order; only exactly \"on\" is on", async () => {
  const seen = [];
  const answer = (status, body) => async (url, init) => (seen.push({ url, init }), new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  assert.deepEqual(await C.ordersAvailable({ fetchImpl: answer(200, { orders: "on" }), origin: "https://satohub.test" }), { on: true });
  assert.equal(seen[0].url, "https://satohub.test/api/commerce/order");
  assert.equal(seen[0].init.method, "GET");
  assert.match(seen[0].init.headers["user-agent"], /^sato-agent\//);
  for (const [status, body] of [[200, { orders: "off" }], [200, { orders: "ON" }], [200, { orders: true }], [200, "not json"], [404, { error: "not found" }], [503, { error: "orders_not_enabled" }]]) {
    assert.deepEqual(await C.ordersAvailable({ fetchImpl: answer(status, body), origin: "https://satohub.test" }), { on: false }, `${status} ${JSON.stringify(body)}`);
  }
  await assert.rejects(C.ordersAvailable({ fetchImpl: answer(500, {}), origin: "https://satohub.test" }), /did not answer|HTTP 500/);
  await assert.rejects(C.ordersAvailable({ fetchImpl: async () => { throw new TypeError("fetch failed"); }, origin: "https://satohub.test" }), /did not answer/);
});

test("4 (CLI): order --available prints on/off and exits 0, 1 when Sato Hub does not answer; status says nothing about Amazon without an address; help keeps order", () => {
  const h = cliHome("rc2-amazon");
  const env = (available) => ({ SATO_AGENT_MCP_URL: "https://satohub.ai/api/mcp", SATO_TEST_HUB: JSON.stringify({ available }) });
  const on = cli(h, ["order", "--available"], env({ json: { orders: "on" } }));
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout.trim(), "Amazon orders: on");
  const off = cli(h, ["order", "--available"], env({ json: { orders: "off" } }));
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), "Amazon orders: off (not switched on yet)");
  assert.equal(cli(h, ["order", "--available", "--json"], env({ json: { orders: "on" } })).stdout.trim(), JSON.stringify({ orders: "on" }, null, 2));
  const down = cli(h, ["order", "--available"], env("down"));
  assert.equal(down.status, 1);
  assert.match(down.stderr, /did not answer/);
  const st = cli(h, ["status"]);
  assert.doesNotMatch(st.stdout, /Amazon|shipping address/);
  const set = cli(h, ["settings", "set", "--stdin"], {}, JSON.stringify({ name: "Ada", line1: "1 Main St", city: "Springfield", state: "IL", postalCode: "62704", country: "US", email: "a@example.com" }));
  assert.equal(set.status, 0, set.stderr);
  assert.match(cli(h, ["status"]).stdout, /shipping address: set/);
  const help = cli(h, ["help"]).stdout;
  assert.match(help, /order --available/);
  assert.match(help, /when Sato Hub has switched/);
});

// ---------------------------------------------------------------- 5. docs

test("5: the docs say both legs of a round trip count, describe Amazon by availability, and never point at v0.2", () => {
  const bot = readFileSync(ROOT("BOT.md"), "utf8");
  const readme = readFileSync(ROOT("README.md"), "utf8");
  const skill = readFileSync(ROOT("skills/sato-agent/SKILL.md"), "utf8");
  assert.match(bot, /Both legs of a round trip count toward the 24-hour limit/);
  assert.match(readme, /both legs of a round trip count/);
  assert.match(bot, /order --available/);
  assert.match(bot, /Only if it printed "Amazon orders: on"/);
  assert.doesNotMatch(bot, /once Sato Hub switches (it|them) on/, "Amazon is not offered as a capability before it is on");
  for (const [name, text] of [["BOT.md", bot], ["README.md", readme], ["SKILL.md", skill]]) {
    assert.doesNotMatch(text, /v0\.2\.\d|#v0\.2/, `${name} points at v0.2`);
  }
  assert.match(bot, /#v0\.3\.1/);
  assert.doesNotMatch(bot, /#v0\.3\.0\b/, "BOT.md pins the current version only");
});

// ---------------------------------------------------------------- 6. retests from the Solana report

let server;
let origin;
before(async () => {
  server = createServer((req, res) => {
    const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
    res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `http://x${req.url}` }, accepts }) });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("6: a Solana-only agent in ask mode is refused (exit 3) by a Base-only x402 server BEFORE any approval is asked", async () => {
  const h = join(home, "..", "rc2-sol-ask");
  const env = { ...process.env, SATO_AGENT_HOME: h, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_AGENT_SOLANA_RPC: "http://127.0.0.1:9" };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN, ...args], { env });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  assert.equal((await run(["init"])).code, 0);
  assert.equal((await run(["policy", "set", "--chains", "solana", "--per-tx", "3", "--per-day", "25", "--approval", "ask"])).code, 0);
  const r = await run(["pay", `${origin}/base-only`, "--skip-check", "--json"]);
  assert.equal(r.code, 3, r.err);
  assert.equal(JSON.parse(r.out).refused[0].rule, "asset");
  assert.doesNotMatch(r.out + r.err, /--approve|needs_approval/);
  const ledger = readFileSync(join(h, "ledger.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"kind":"approval"/, "no approval was requested");
});

test("6: a Solana send to a token account is a refusal (exit 3, recipient_not_wallet), covered by test/send-precheck.test.js", () => {
  const src = readFileSync(fileURLToPath(new URL("./send-precheck.test.js", import.meta.url)), "utf8");
  assert.match(src, /assert\.equal\(r\.status, 3, r\.stderr\);\n\s+assert\.match\(r\.stderr, \/REFUSED recipient_not_wallet\//);
});
