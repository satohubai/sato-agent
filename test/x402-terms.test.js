// `pay` asks the server's price BEFORE the owner is asked, offline. Local servers
// stand in for x402 sellers (v2 header, v1 body, another chain only, a price that
// changes, a free answer) and for Sato Hub. Nothing settles: no facilitator, no
// chain. The agent signs only with its own throwaway test key.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { pay, quoteX402 } = await import("../src/x402.js");
const { entries } = await import("../src/ledger.js");
const { USDC_BASE } = await import("../src/base.js");
const { USER_AGENT } = await import("../src/version.js");
const { SOLANA_NETWORK, USDC_MINT } = await import("../src/x402-solana.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PAY_TO = "0x1111111111111111111111111111111111111111";
const OTHER_PAYEE = "0x2222222222222222222222222222222222222222";
const BASE = "eip155:8453";
const TX = `0x${"ab".repeat(32)}`;

let web;
let origin;
let hub;
let hubUrl;
let hubCalls = []; // what the mock Sato Hub was asked
let solanaFee; // throwaway addresses for a Solana offer
let solanaPayee;
const hits = []; // every request the seller got: { path, method, sig, ua, body, type }
const counts = {}; // unpaid requests per path
let flipAfter = 1; // /flip and /drop: how many unpaid requests get the first price

const base = (amount, extra = {}) => ({ scheme: "exact", network: BASE, asset: USDC_BASE, amount, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...extra });
const solana = (amount) => ({ scheme: "exact", network: SOLANA_NETWORK, asset: USDC_MINT, amount, payTo: solanaPayee, maxTimeoutSeconds: 60, extra: { feePayer: solanaFee } });
const v1 = (amount, extra = {}) => ({ scheme: "exact", network: "base", maxAmountRequired: amount, resource: "http://x/", description: "", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC_BASE, extra: { name: "USD Coin", version: "2" }, ...extra });

// path -> () => { v: 1|2, accepts }
const sellers = {
  "/v2/ok": () => ({ v: 2, accepts: [base("10000")] }),
  "/v1/ok": () => ({ v: 1, accepts: [v1("10000")] }),
  "/multi": () => ({ v: 2, accepts: [base("50000"), solana("1000"), base("20000"), base("7500000")] }),
  "/solana-only": () => ({ v: 2, accepts: [solana("10000")] }),
  "/v1/other-chain": () => ({ v: 1, accepts: [v1("10000", { network: "base-sepolia" })] }),
  "/empty": () => ({ v: 2, accepts: [] }),
  "/bad-payto": () => ({ v: 2, accepts: [base("10000", { payTo: "0x1111\u001b[31m" })] }),
  "/permit2": () => ({ v: 2, accepts: [base("10000", { extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } })] }),
  "/scheme": () => ({ v: 2, accepts: [base("10000", { scheme: "upto" })] }),
  "/pricey": () => ({ v: 2, accepts: [base("20000")] }),
  "/two-payees": () => ({ v: 2, accepts: [base("10000", { payTo: OTHER_PAYEE })] }),
  // The first `flipAfter` unpaid requests (the quote) get one price; after that, another.
  "/flip": (n) => ({ v: 2, accepts: [base(n <= flipAfter ? "10000" : "20000")] }),
  "/drop": (n) => ({ v: 2, accepts: [base(n <= flipAfter ? "20000" : "10000")] }),
  "/post": () => ({ v: 2, accepts: [base("10000")] }),
};

before(async () => {
  initWallet();
  solanaFee = (await generateKeyPairSigner()).address;
  solanaPayee = (await generateKeyPairSigner()).address;
  web = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      const sig = req.headers["payment-signature"] ?? req.headers["x-payment"] ?? null;
      hits.push({ path, method: req.method, sig, ua: req.headers["user-agent"], body, type: req.headers["content-type"], auth: req.headers.authorization ?? null });
      if (path === "/free") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("hello \u001b[31mfree\u001b[0m");
      }
      if (path === "/garbage402") {
        res.writeHead(402, { "PAYMENT-REQUIRED": "!!not base64!!" });
        return res.end("{}");
      }
      // A seller that validates the body before its paywall: an empty body gets 422, a real one gets terms.
      if (path === "/post-validates" && !sig && body === "{}") {
        res.writeHead(422, { "content-type": "text/plain" });
        return res.end("missing field q");
      }
      const seller = path === "/post-validates" ? sellers["/post"] : sellers[path];
      if (!seller) {
        res.writeHead(404);
        return res.end("nope");
      }
      if (sig) {
        // Take the payment as settled. (The signature is the agent's own, from a throwaway test key.)
        res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: BASE, payer: PAY_TO }), "X-PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: BASE, payer: PAY_TO }) });
        return res.end('{"paid":true}');
      }
      counts[path] = (counts[path] ?? 0) + 1;
      const t = seller(counts[path]);
      if (t.v === 1) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, error: "payment required", accepts: t.accepts }));
      }
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${path}` }, accepts: t.accepts }) });
      res.end("{}");
    });
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${web.address().port}`;
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hubCalls.push(JSON.parse(body).params.arguments);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Preflight x402: go (mock)" }], structuredContent: { verdict: "go", rule: "A1", target: { kind: "x402" }, checked_at: "2026-10-09T00:00:00Z" } } }));
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${hub.address().port}/api/mcp`;
  setPolicy({ chains: "base", perTx: "1", perDay: "5", approval: "auto" });
});
after(() => {
  web.close();
  hub.close();
});

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: hubUrl, SATO_AGENT_BASE_RPC: "http://127.0.0.1:9", SATO_AGENT_SOLANA_RPC: "http://127.0.0.1:9" },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const spends = () => entries().filter((e) => e.kind === "x402");
const approvals = () => entries().filter((e) => e.kind === "approval");
const signed = (path) => hits.filter((h) => h.path === path && h.sig);
const reset = () => {
  hits.length = 0;
  hubCalls = [];
  for (const k of Object.keys(counts)) delete counts[k];
};

test("quote: a v2 server's PAYMENT-REQUIRED header is read; one unpaid request, nothing reserved or signed", async () => {
  reset();
  const before = entries().length;
  const q = await quoteX402(`${origin}/v2/ok`);
  assert.equal(q.status, 402);
  assert.equal(q.free, false);
  assert.deepEqual(q.refusals, []);
  assert.equal(q.offers.length, 1);
  assert.deepEqual({ usd: q.offers[0].usd, pay_to: q.offers[0].pay_to, network: q.offers[0].network, version: q.offers[0].version }, { usd: 0.01, pay_to: PAY_TO, network: BASE, version: 2 });
  assert.equal(hits.length, 1, "exactly one request");
  assert.equal(hits[0].sig, null, "unpaid");
  assert.equal(hits[0].ua, USER_AGENT, "the same user-agent pay uses");
  assert.equal(entries().length, before, "nothing written to the ledger");
});

test("quote: a v1 server's JSON body is read (maxAmountRequired, network \"base\"), reported in canonical form", async () => {
  const q = await quoteX402(`${origin}/v1/ok`);
  assert.equal(q.free, false);
  assert.equal(q.offers.length, 1);
  assert.deepEqual({ usd: q.offers[0].usd, pay_to: q.offers[0].pay_to, network: q.offers[0].network, version: q.offers[0].version }, { usd: 0.01, pay_to: PAY_TO, network: BASE, version: 1 });
});

test("quote: every offer runs through the pay guard; payable offers come cheapest first, the rest are refusals with their rule", async () => {
  const q = await quoteX402(`${origin}/multi`);
  assert.deepEqual(q.offers.map((o) => o.usd), [0.02, 0.05], "cheapest first");
  const rules = q.refusals.map((r) => r.rule).sort();
  assert.deepEqual(rules, ["asset", "max_usd_per_day", "max_usd_per_tx"], "the Solana offer (not this agent's chain) and the $7.50 offer (over both limits)");
  for (const [path, rule] of [["/permit2", "transfer_method"], ["/scheme", "scheme"], ["/bad-payto", "pay_to"], ["/v1/other-chain", "asset"]]) {
    const r = await quoteX402(`${origin}${path}`);
    assert.equal(r.offers.length, 0, path);
    assert.equal(r.refusals[0].rule, rule, path);
  }
  const none = await quoteX402(`${origin}/empty`);
  assert.equal(none.refusals[0].rule, "no_offer");
  const bad = await quoteX402(`${origin}/garbage402`);
  assert.equal(bad.offers.length, 0);
  assert.equal(bad.refusals[0].rule, "terms_unreadable");
});

test("quote: text the server sent is cleaned (no control characters in a refusal)", async () => {
  const q = await quoteX402(`${origin}/bad-payto`);
  assert.doesNotMatch(JSON.stringify(q), /\\u001b|\u001b/);
});

test("quote: a free answer (not 402) is `free: true` with its body; no offers", async () => {
  const q = await quoteX402(`${origin}/free`);
  assert.equal(q.free, true);
  assert.equal(q.status, 200);
  assert.deepEqual(q.offers, []);
  assert.match(q.body, /free/);
  const missing = await quoteX402(`${origin}/missing`);
  assert.equal(missing.free, true);
  assert.equal(missing.status, 404);
});

test("quote: Solana terms are read with no RPC call and nothing signed", async () => {
  setPolicy({ chains: "base,solana" });
  const previous = process.env.SATO_AGENT_SOLANA_RPC;
  process.env.SATO_AGENT_SOLANA_RPC = "http://127.0.0.1:9"; // closed port: any RPC call would fail
  try {
    const q = await quoteX402(`${origin}/solana-only`, { chain: "solana" });
    assert.equal(q.offers.length, 1);
    assert.deepEqual({ usd: q.offers[0].usd, pay_to: q.offers[0].pay_to, network: q.offers[0].network, chain: q.offers[0].chain }, { usd: 0.01, pay_to: solanaPayee, network: SOLANA_NETWORK, chain: "solana" });
    const wrong = await quoteX402(`${origin}/solana-only`, { chain: "base" });
    assert.equal(wrong.offers.length, 0);
    assert.equal(wrong.refusals[0].rule, "asset");
  } finally {
    if (previous === undefined) delete process.env.SATO_AGENT_SOLANA_RPC;
    else process.env.SATO_AGENT_SOLANA_RPC = previous;
    setPolicy({ chains: "base" });
  }
});

test("pay(maxUsd): a server that now asks more is refused as price_changed, nothing reserved or signed", async () => {
  reset();
  const before = spends().length;
  await assert.rejects(pay(`${origin}/pricey`, { maxUsd: 0.01 }), (e) => {
    assert.ok(e instanceof Refused);
    assert.equal(e.refusals[0].rule, "price_changed");
    assert.match(e.message, /now asks \$0\.02, more than the \$0\.01 the owner approved; nothing was signed/);
    return true;
  });
  assert.equal(signed("/pricey").length, 0);
  assert.equal(spends().length, before, "no reservation");
});

test("pay(maxUsd): the same price pays; a higher cap pays; no maxUsd is today's behaviour", async () => {
  reset();
  assert.equal((await pay(`${origin}/v2/ok`, { maxUsd: 0.01 })).settled, true, "same price");
  assert.equal((await pay(`${origin}/pricey`, { maxUsd: 0.5 })).usd, 0.02, "below the cap");
  assert.equal((await pay(`${origin}/pricey`)).usd, 0.02, "no cap given");
  await assert.rejects(pay(`${origin}/v2/ok`, { maxUsd: 0 }), /maxUsd must be a positive number/);
});

test("pay(maxUsd, payTo): another payee is refused as payee_changed, nothing signed", async () => {
  reset();
  const before = spends().length;
  await assert.rejects(pay(`${origin}/two-payees`, { maxUsd: 0.01, payTo: PAY_TO }), (e) => e instanceof Refused && e.refusals[0].rule === "payee_changed");
  assert.equal(signed("/two-payees").length, 0);
  assert.equal(spends().length, before);
  assert.equal((await pay(`${origin}/two-payees`, { maxUsd: 0.01, payTo: OTHER_PAYEE.toUpperCase().replace("0X", "0x") })).settled, true, "the same payee in another letter case");
});

test("CLI, approval mode: the intent carries the quoted price, chain and payee; the same command with the code pays", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const ask = await run(["pay", `${origin}/v2/ok`, "--skip-check", "--json"]);
  assert.equal(ask.code, 5);
  const needs = JSON.parse(ask.stdout).needs_approval;
  assert.equal(needs.intent.price, `0.01 USDC on base to ${PAY_TO}`);
  assert.equal(signed("/v2/ok").length, 0);
  const human = await run(["pay", `${origin}/v2/ok`, "--skip-check"]);
  assert.equal(human.code, 5);
  assert.match(human.stderr, /approval covers the price and payee quoted above/);
  assert.doesNotMatch(human.stderr, /does not fix the price/);
  const yes = await run(["pay", `${origin}/v2/ok`, "--skip-check", "--approve", needs.code, "--json"]);
  assert.equal(yes.code, 0, yes.stderr);
  const r = JSON.parse(yes.stdout);
  assert.equal(r.settled, true);
  assert.equal(r.usd, 0.01);
  setPolicy({ approval: "auto" });
});

test("CLI, approval mode: a server that only takes another chain is refused BEFORE approval (exit 3, no code, no reservation)", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const approvalsBefore = approvals().length;
  const spendsBefore = spends().length;
  for (const path of ["/solana-only", "/v1/other-chain", "/permit2"]) {
    const r = await run(["pay", `${origin}${path}`, "--skip-check"]);
    assert.equal(r.code, 3, `${path}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
    assert.doesNotMatch(r.stderr + r.stdout, /--approve/, "no approval code was offered");
  }
  const asset = await run(["pay", `${origin}/solana-only`, "--skip-check", "--json"]);
  assert.equal(JSON.parse(asset.stdout).refused[0].rule, "asset");
  assert.equal(approvals().length, approvalsBefore, "no approval was requested");
  assert.equal(spends().length, spendsBefore, "nothing reserved");
  assert.equal(hubCalls.length, 0, "Sato Hub was not even asked (--skip-check)");
  setPolicy({ approval: "auto" });
});

test("CLI, approval mode: an approved price, then a server that asks more at pay time -> price_changed, nothing signed or reserved", async () => {
  reset();
  setPolicy({ approval: "ask" });
  flipAfter = 2; // the quote of each run sees $0.01; the unpaid request inside pay sees $0.02
  const ask = await run(["pay", `${origin}/flip`, "--skip-check", "--json"]);
  assert.equal(ask.code, 5);
  const { code, intent } = JSON.parse(ask.stdout).needs_approval;
  assert.equal(intent.price, `0.01 USDC on base to ${PAY_TO}`);
  const spendsBefore = spends().length;
  const go = await run(["pay", `${origin}/flip`, "--skip-check", "--approve", code]);
  assert.equal(go.code, 3, go.stdout + go.stderr);
  assert.match(go.stderr, /price_changed/);
  assert.match(go.stderr, /now asks \$0\.02, more than the \$0\.01 the owner approved; nothing was signed/);
  assert.equal(signed("/flip").length, 0, "nothing signed");
  assert.equal(spends().length, spendsBefore, "nothing reserved");
  setPolicy({ approval: "auto" });
});

test("CLI: a server that asks the same or less at pay time is paid, at the price it asked", async () => {
  reset();
  flipAfter = 1; // /drop: the quote sees $0.02, pay's own request sees $0.01
  const r = await run(["pay", `${origin}/drop`, "--skip-check", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.settled, true);
  assert.equal(out.usd, 0.01, "the lower price was charged, never the quoted $0.02 by default");
  const same = await run(["pay", `${origin}/v1/ok`, "--skip-check", "--json"]);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(JSON.parse(same.stdout).usd, 0.01);
});

test("CLI: a free server (HTTP 200) is not paid, asks no approval and uses no payment machinery", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const spendsBefore = spends().length;
  const approvalsBefore = approvals().length;
  const r = await run(["pay", `${origin}/free`]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /The server did not ask for payment \(HTTP 200\)\. Nothing was paid or signed\./);
  assert.match(r.stdout, /response body: untrusted content from 127\.0\.0\.1/);
  assert.doesNotMatch(r.stdout, /\u001b/);
  assert.match(r.stdout, /free/);
  const j = JSON.parse((await run(["pay", `${origin}/free`, "--json"])).stdout);
  assert.deepEqual({ free: j.free, signed: j.signed, settled: j.settled, status: j.status, usd: j.usd }, { free: true, signed: false, settled: false, status: 200, usd: 0 });
  assert.equal(hits.filter((h) => h.sig).length, 0, "no payment header sent");
  assert.equal(hits.length, 2, "one request per run: the quote, and no second request");
  assert.equal(hubCalls.length, 0, "no Sato Hub check for a spend that cannot happen");
  assert.equal(spends().length, spendsBefore);
  assert.equal(approvals().length, approvalsBefore, "no approval asked");
  setPolicy({ approval: "auto" });
});

test("CLI: a POST pay sends x402_method to Sato Hub, never the body or headers; the quote (before approval) sends neither the body nor the headers", async () => {
  reset();
  const secret = "Bearer sk-SECRET-TERMS-123";
  const r = await run(["pay", `${origin}/post`, "--method", "post", "--data", '{"q":"hello world"}', "--header", `authorization: ${secret}`, "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hubCalls.length, 1);
  assert.deepEqual(hubCalls[0], { x402: `${origin}/post`, x402_method: "POST" });
  assert.doesNotMatch(JSON.stringify(hubCalls), /hello world|sk-SECRET/);
  const q = hits.find((h) => h.path === "/post");
  assert.equal(q.method, "POST");
  assert.equal(q.body, "{}", "the owner's body is not released before approval");
  assert.equal(q.auth, null, "nor the owner's headers (an API key)");
  assert.equal(q.type, "application/json");
  assert.equal(q.sig, null);
  assert.equal(JSON.parse(r.stdout).terms.usd, 0.01, "the empty-body ask still read the price");
  // A GET sends the URL alone, as before.
  hubCalls = [];
  await run(["pay", `${origin}/v2/ok`, "--dry-run", "--json"]);
  assert.deepEqual(hubCalls[0], { x402: `${origin}/v2/ok` });
});

test("CLI: a POST seller that checks the body before its paywall is unquoted: the approval says the price is not known, and the real body goes out only after it", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const args = ["pay", `${origin}/post-validates`, "--method", "POST", "--data", '{"q":"hello world"}', "--skip-check"];
  const ask = await run(args);
  assert.equal(ask.code, 5, ask.stderr);
  assert.match(ask.stdout + ask.stderr, /not stated before the real request/);
  const before = hits.filter((h) => h.path === "/post-validates");
  assert.deepEqual(before.map((h) => h.body), ["{}"], "only the empty-body ask went out before approval");
  const code = (ask.stdout + ask.stderr).match(/--approve ([0-9a-f]{8})/)[1];
  const go = await run([...args, "--approve", code, "--json"]);
  assert.equal(go.code, 0, go.stderr);
  assert.equal(JSON.parse(go.stdout).settled, true);
  assert.ok(hits.some((h) => h.path === "/post-validates" && h.body === '{"q":"hello world"}'), "the real body went out after approval");
  setPolicy({ approval: "auto" });
});

test("CLI: an unquoted approval says the price and payee are NOT bound, names the cap, and needs a per-transaction limit", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const args = ["pay", `${origin}/post-validates`, "--method", "POST", "--data", '{"q":"x"}', "--skip-check"];
  const ask = await run(args);
  assert.equal(ask.code, 5, ask.stderr);
  const text = ask.stdout + ask.stderr;
  assert.match(text, /NOT bound by this approval/);
  assert.match(text, /up to \$1 \(the per-transaction limit\)/);
  assert.doesNotMatch(text, /the approval covers the price and payee quoted above/, "never the quoted-price note on an unbound price");
  // no per-transaction limit: an unknown price has no cap, so it is refused before anyone is asked
  setPolicy({ perTx: "none" });
  const none = await run(args);
  assert.equal(none.code, 3, none.stderr);
  assert.match(none.stderr, /price_unknown_no_limit/);
  assert.doesNotMatch(none.stdout + none.stderr, /--approve/);
  setPolicy({ perTx: "1", approval: "auto" });
});

test("CLI: a GET with the owner's headers asks its price without them; they go out only after the check and approval", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const secret = "Bearer OWNER-KEY-123";
  const ask = await run(["pay", `${origin}/free`, "--header", `authorization: ${secret}`, "--skip-check"]);
  assert.equal(ask.code, 5, "a 200 to a header-less ask is not proof the real request is free: the owner is asked");
  assert.deepEqual(hits.filter((h) => h.path === "/free").map((h) => h.auth), [null], "the key did not go out before approval");
  // a quoted GET with headers: the ask carried no key, and the price is bound
  reset();
  const q = await run(["pay", `${origin}/v2/ok`, "--header", `authorization: ${secret}`, "--skip-check"]);
  assert.equal(q.code, 5);
  assert.match(q.stdout + q.stderr, /the approval covers the price and payee quoted above/);
  assert.equal(hits.find((h) => h.path === "/v2/ok").auth, null);
  setPolicy({ approval: "auto" });
});

test("CLI: PUT, PATCH and DELETE send nothing before approval (they act on their first request)", async () => {
  reset();
  setPolicy({ approval: "ask" });
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    const r = await run(["pay", `${origin}/post`, "--method", m, "--skip-check"]);
    assert.equal(r.code, 5, `${m}: ${r.stderr}`);
  }
  assert.equal(hits.filter((h) => h.path === "/post").length, 0, "no request reached the server");
  setPolicy({ approval: "auto" });
});

test("CLI: --dry-run shows the quoted price, chain and payee, signs nothing and needs no approval", async () => {
  reset();
  setPolicy({ approval: "ask" });
  const spendsBefore = spends().length;
  const human = await run(["pay", `${origin}/multi`, "--dry-run"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Sato Hub check/);
  assert.match(human.stdout, new RegExp(`DRY RUN: the server asks 0\\.02 USDC on base to ${PAY_TO}`));
  assert.match(human.stdout, /Nothing was paid or signed/);
  const j = JSON.parse((await run(["pay", `${origin}/multi`, "--dry-run", "--json"])).stdout);
  assert.equal(j.dry_run, true);
  assert.deepEqual({ usd: j.terms.usd, chain: j.terms.chain, pay_to: j.terms.pay_to, network: j.terms.network, x402_version: j.terms.x402_version }, { usd: 0.02, chain: "base", pay_to: PAY_TO, network: BASE, x402_version: 2 });
  assert.deepEqual(j.terms.offers.map((o) => o.usd), [0.02, 0.05]);
  assert.equal(j.sato_hub_check.verdict, "go");
  assert.equal(hits.filter((h) => h.sig).length, 0);
  assert.equal(spends().length, spendsBefore);
  setPolicy({ approval: "auto" });
});

test("CLI: the price is checked against the limits BEFORE the owner is asked", async () => {
  reset();
  setPolicy({ approval: "ask", perTx: "0.015" });
  const r = await run(["pay", `${origin}/pricey`, "--skip-check"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /max_usd_per_tx/);
  assert.doesNotMatch(r.stderr, /--approve/);
  setPolicy({ approval: "auto", perTx: "1" });
});

test("the ledger and approvals never hold the header values", () => {
  for (const f of ["ledger.jsonl", "approvals.json"]) {
    let text = "";
    try {
      text = readFileSync(join(home, f), "utf8");
    } catch {
      /* no such file yet */
    }
    assert.doesNotMatch(text, /sk-SECRET-TERMS-123/, f);
  }
});
