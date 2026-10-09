// v0.1.1 owner controls, offline: chain binding, raises (any loosening), Sato
// Hub checks that can stop a spend, kit-enforced approval, strict amounts,
// pay headers, status rounding, and the ERC-8004 card. A local mock stands in
// for Sato Hub and behaves like the real Preflight: ONE target per call, in its
// precedence order (token before address), and it records what it was asked.
// RPCs point at a closed port, so nothing reaches a chain.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { setPolicy, evaluate, raisesBetween } = await import("../src/policy.js");
const { usdcUnits } = await import("../src/amount.js");
const { registrationUri } = await import("../src/base.js");
const { record } = await import("../src/ledger.js");
const { gateRefusals } = await import("../src/satohub.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const DEAD = "0x000000000000000000000000000000000000dEaD";
let mcp;
let mcpUrl;
let mode = { verdict: "go" }; // what the mock answers
let lastArgs = null; // what the mock was asked
let web;
let webUrl;
let x402Url; // a seller that answers 402
let lastHeaders = null;

// Real Preflight precedence (onchain-agent-app lib/mcp/tools.ts): one target per call.
const ORDER = ["repo", "package", "endpoint", "agent", "token", "skill", "x402", "address"];

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: mcpUrl, SATO_AGENT_BASE_RPC: "http://127.0.0.1:9", SATO_AGENT_SOLANA_RPC: "http://127.0.0.1:9", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  mcp = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      lastArgs = JSON.parse(body).params.arguments;
      if (mode.down) {
        res.writeHead(503);
        return res.end("down");
      }
      const given = ORDER.filter((k) => lastArgs[k] !== undefined);
      const kind = given[0];
      const structured = { verdict: mode.verdict, rule: "A1", target: { kind }, checked_at: "2026-10-09T00:00:00Z" };
      if (given.length > 1) structured.not_checked = given.slice(1);
      const result = { content: [{ type: "text", text: `Preflight ${kind}: ${mode.verdict} (mock)` }] };
      if (!mode.textOnly) result.structuredContent = structured;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${mcp.address().port}/api/mcp`;
  web = createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === "/x402" && !req.headers["payment-signature"]) {
      // A seller that asks for $0.01 of USDC on Base (nothing here ever settles).
      const accepts = [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "http://x/x402" }, accepts }) });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"free":true}');
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  webUrl = `http://127.0.0.1:${web.address().port}/thing`;
  x402Url = `http://127.0.0.1:${web.address().port}/x402`;
});
after(() => {
  mcp.close();
  web.close();
});

test("USDC amounts: never rounded, the same on both chains", () => {
  assert.equal(usdcUnits("1.000001"), 1_000_001n);
  for (const bad of ["1.0000009", "0.0000001", "1.", ".5", "0", "1e3", "-1", " 1"]) assert.throws(() => usdcUnits(bad), undefined, bad);
});

test("any loosening is a raise: allowlist widened, chains widened, gate loosened, ask -> auto", () => {
  const base = { max_usd_per_tx: 5, max_usd_per_day: 10, allow_recipients: [DEAD], chains: ["base"], check_gate: "caution", approval: "ask", on_check_unavailable: "refuse" };
  assert.deepEqual(raisesBetween(base, { ...base }), []);
  assert.deepEqual(raisesBetween(base, { ...base, allow_recipients: [DEAD, "0x0000000000000000000000000000000000000001"] }), ["allow_recipients widened"]);
  assert.deepEqual(raisesBetween(base, { ...base, allow_recipients: [] }), [], "narrowing is not a raise");
  assert.deepEqual(raisesBetween(base, { ...base, chains: ["base", "solana"] }), ["chains widened"]);
  assert.deepEqual(raisesBetween(base, { ...base, check_gate: "no" }), ["check_gate loosened"]);
  assert.deepEqual(raisesBetween(base, { ...base, check_gate: "off" }), ["check_gate loosened"]);
  assert.deepEqual(raisesBetween({ ...base, check_gate: "no" }, { ...base, check_gate: "caution" }), [], "tightening is not a raise");
  assert.deepEqual(raisesBetween(base, { ...base, approval: "auto" }), ["approval: ask -> auto"]);
  assert.deepEqual(raisesBetween(base, { ...base, on_check_unavailable: "allow" }), ["on_check_unavailable: refuse -> allow"]);
});

test("swaps: off until the owner sets both caps; each cap refuses with its rule; loosening is a raise", () => {
  const p = { max_usd_per_tx: 100, max_usd_per_day: 500, allow_recipients: [DEAD], chains: ["base"] };
  const swap = (extra = {}, swaps = 0) => evaluate({ ...p, ...extra }, { usd: 10, to: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", chain: "base", kind: "swap", slippage_bps: 50 }, { usd: 0, swaps, unreadable: [] }).map((r) => r.rule);
  assert.deepEqual(swap(), ["swaps_not_enabled"]);
  assert.deepEqual(swap({ max_slippage_bps: 100, max_trades_per_day: 3 }), [], "a swap is not held to the payee allowlist");
  assert.deepEqual(swap({ max_slippage_bps: 30, max_trades_per_day: 3 }), ["max_slippage_bps"]);
  assert.deepEqual(swap({ max_slippage_bps: 100, max_trades_per_day: 3 }, 3), ["max_trades_per_day"]);
  assert.deepEqual(swap({ max_slippage_bps: 100, max_trades_per_day: null }, 99), [], "none = no trade cap, the owner's choice");
  const on = { ...p, max_slippage_bps: 50, max_trades_per_day: 3 };
  assert.deepEqual(raisesBetween(p, on), ["swaps turned on"]);
  assert.deepEqual(raisesBetween(on, { ...on, max_slippage_bps: 80 }), ["max_slippage_bps"]);
  assert.deepEqual(raisesBetween(on, { ...on, max_trades_per_day: null }), ["max_trades_per_day"]);
  assert.deepEqual(raisesBetween(on, { ...on, max_slippage_bps: 20, max_trades_per_day: 1 }), [], "tightening is not a raise");
});

test("chains: a spend on a chain the agent is not set for is refused; a v0.1.0 policy must choose first", () => {
  const p = { max_usd_per_tx: null, max_usd_per_day: null, allow_recipients: null, chains: ["base"] };
  assert.deepEqual(evaluate(p, { usd: 1, to: "x", chain: "solana" }, 0).map((r) => r.rule), ["chain_not_allowed"]);
  assert.deepEqual(evaluate(p, { usd: 1, to: "x", chain: "base" }, 0), []);
  const v1 = { schema: "sato-agent.policy/v1", max_usd_per_tx: 5, max_usd_per_day: 5, allow_recipients: null };
  assert.deepEqual(evaluate(v1, { usd: 1, to: "x", chain: "base" }, 0).map((r) => r.rule), ["chains_not_set"]);
});

test("check gating follows the owner's choice; unknown never stops a spend; unavailable fails closed unless the owner chose allow", () => {
  const ok = (p, c) => gateRefusals(p, c).map((r) => r.rule);
  assert.deepEqual(ok({ check_gate: "off" }, { verdict: "no" }), []);
  assert.deepEqual(ok({}, { verdict: "no" }), [], "unset = informs only");
  assert.deepEqual(ok({ check_gate: "no" }, { verdict: "no" }), ["check_no"]);
  assert.deepEqual(ok({ check_gate: "no" }, { verdict: "caution" }), []);
  assert.deepEqual(ok({ check_gate: "caution" }, { verdict: "caution" }), ["check_caution"]);
  assert.deepEqual(ok({ check_gate: "caution" }, { verdict: "unknown" }), []);
  assert.deepEqual(ok({ check_gate: "no", on_check_unavailable: "allow" }, { unavailable: true }), []);
  assert.deepEqual(ok({ check_gate: "no", on_check_unavailable: "refuse" }, { unavailable: true }), ["check_unavailable"]);
  assert.deepEqual(ok({ check_gate: "no" }, { unavailable: true }), ["check_unavailable"], "never chosen: fail closed");
  assert.deepEqual(gateRefusals({ check_gate: "no" }, {}, { skipped: true }).map((r) => r.rule), ["check_required"]);
});

test("policy: turning the gate on requires choosing what happens when the check can't run", async () => {
  // fresh state for this file's CLI tests
  await run(["init"]);
  assert.equal((await run(["policy", "set", "--chains", "base", "--per-tx", "5", "--per-day", "20"])).code, 0);
  const r = await run(["policy", "set", "--check-gate", "no"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /on-check-unavailable/);
  assert.equal((await run(["policy", "set", "--check-gate", "no", "--on-check-unavailable", "allow"])).code, 0);
});

test("CLI: a Base-only agent shows only Base, and refuses a Solana send", async () => {
  const addr = JSON.parse((await run(["address", "--json"])).stdout);
  assert.deepEqual(Object.keys(addr), ["base"]);
  const r = await run(["send", "--chain", "solana", "--to", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "--amount", "1"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /chain_not_allowed/);
});

test("CLI: the Base send check asks about the RECIPIENT (never a token, which would outrank it)", async () => {
  mode = { verdict: "go" };
  await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.equal(lastArgs.address, DEAD);
  assert.equal(lastArgs.chain, "Base");
  assert.equal(lastArgs.token, undefined);
});

test("CLI: with the gate on, `no` (any casing) stops the send before anything is signed; go proceeds", async () => {
  for (const v of ["no", "NO"]) {
    mode = { verdict: v };
    const r = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
    assert.equal(r.code, 3, v);
    assert.match(r.stderr, /check_no/);
  }
  mode = { verdict: "go" };
  const g = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.notEqual(g.code, 3, "a go verdict does not stop it (it then fails on the closed RPC port)");
  const s = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1", "--skip-check"]);
  assert.equal(s.code, 3);
  assert.match(s.stderr, /check_required/);
});

test("CLI: an answer that isn't a check of our target counts as unavailable, and follows the owner's choice", async () => {
  await run(["policy", "set", "--on-check-unavailable", "refuse"]);
  for (const m of [{ down: true }, { verdict: "go", textOnly: true }]) {
    mode = m;
    const r = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
    assert.equal(r.code, 3, JSON.stringify(m));
    assert.match(r.stderr, /check_unavailable/);
  }
  mode = { verdict: "go" };
  assert.match((await run(["status"])).stdout, /checks skipped or unavailable/);
  assert.match((await run(["status"])).stdout, /custom_endpoint/, "a non-default Sato Hub address is logged when the gate is on");
});

test("CLI: approval mode needs the owner's yes for the exact intent, once; --skip-check is part of the intent", async () => {
  await run(["policy", "set", "--approval", "ask"]);
  const ask = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--json"]);
  assert.equal(ask.code, 5, "nothing spent: needs approval");
  const { code } = JSON.parse(ask.stdout).needs_approval;
  const other = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "3", "--approve", code]);
  assert.match(other.stderr, /different intent/);
  const skipping = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--skip-check", "--approve", code]);
  assert.notEqual(skipping.code, 0);
  const yes = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--approve", code]);
  assert.doesNotMatch(yes.stderr, /approval|different intent|REFUSED/, "approved: gets past the approval to the spend");
  const again = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--approve", code]);
  assert.match(again.stderr, /already used|not found/);
  const reg = await run(["register", "--name", "a", "--description", "b"]);
  assert.equal(reg.code, 5, "register asks too in approval mode");
  const over = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "6"]);
  assert.equal(over.code, 3, "over the limit is refused BEFORE asking for approval");
});

test("CLI: pay in approval mode never stores or prints header values, and says the approval covers the quoted price and payee", async () => {
  await run(["policy", "set", "--check-gate", "off"]);
  const r = await run(["pay", x402Url, "--header", "Authorization: Bearer sk-SECRET123", "--skip-check"]);
  assert.equal(r.code, 5);
  assert.doesNotMatch(r.stdout + r.stderr, /sk-SECRET123/);
  assert.match(r.stderr, /0\.01 USDC on /);
  assert.match(r.stderr, /approval covers the price and payee quoted above/);
  assert.doesNotMatch(r.stderr, /does not fix the price/);
  for (const f of ["ledger.jsonl", "approvals.json"]) assert.doesNotMatch(readFileSync(join(home, f), "utf8"), /sk-SECRET123/, f);
  assert.equal((await run(["pay", webUrl, "--header", "X-Payment: x", "--skip-check"])).code, 2, "payment headers are reserved");
  const back = await run(["policy", "set", "--approval", "auto"]);
  assert.match(back.stdout, /RAISED \(approval: ask -> auto\)/);
});

test("CLI: pay sends --header values and a JSON content-type for JSON bodies", async () => {
  const ok = await run(["pay", webUrl, "--method", "POST", "--data", '{"q":1}', "--header", "x-api-tag: sato", "--skip-check"]);
  assert.equal(ok.code, 0);
  assert.equal(lastHeaders["x-api-tag"], "sato");
  assert.equal(lastHeaders["content-type"], "application/json");
  assert.equal((await run(["pay", webUrl, "--header", "no-colon", "--skip-check"])).code, 2);
});

test("CLI: a Base-only agent refuses `pay --chain solana` before anything is reserved", async () => {
  const before = readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter((l) => l.includes('"submitted"')).length;
  const r = await run(["pay", webUrl, "--chain", "solana", "--skip-check"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /chain_not_allowed/);
  const after = readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter((l) => l.includes('"submitted"')).length;
  assert.equal(after, before, "nothing reserved");
});

test("deleting policy.json and starting over is still flagged as a raise", async () => {
  rmSync(join(home, "policy.json"));
  const r = await run(["policy", "set", "--chains", "base,solana", "--per-tx", "none", "--per-day", "none"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RAISED \(policy file was missing/);
  assert.match(r.stdout, /chains widened/);
});

test("status rounds money and lists one row per spend", async () => {
  const a = record({ status: "submitted", kind: "send", chain: "base", usd: 0.1, to: DEAD });
  record({ id: a.id, status: "signed", tx: "0xaaa" });
  record({ id: a.id, status: "confirmed", tx: "0xaaa" });
  record({ status: "submitted", kind: "send", chain: "base", usd: 0.2, to: DEAD });
  const s = JSON.parse((await run(["status", "--json"])).stdout);
  assert.equal(String(s.spent_24h_usd).length <= 8, true, "no float noise");
  const rows = s.recent.filter((e) => e.to === DEAD);
  assert.equal(rows.filter((e) => e.id === a.id).length, 1);
  assert.equal(rows.find((e) => e.id === a.id).status, "confirmed");
});

test("pay --dry-run runs the check and pays nothing; history and proof show every action with its explorer link", async () => {
  lastHeaders = null;
  const d = await run(["pay", x402Url, "--chain", "base", "--dry-run", "--json"]); // the policy allows both chains, so pay must name one
  assert.equal(d.code, 0);
  const dry = JSON.parse(d.stdout);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.terms.usd, 0.01, "the quoted price is shown");
  assert.ok(lastHeaders, "a dry run asks the server its price (one unpaid request)");
  assert.equal(lastHeaders["payment-signature"], undefined, "and never sends a payment");
  const x = record({ status: "submitted", kind: "x402", chain: "base", usd: 0.001, to: DEAD, url: "https://example.com/r" });
  record({ id: x.id, status: "confirmed", tx: "0x" + "ab".repeat(32) });
  record({ kind: "register", status: "registered", chain: "base", usd: 0, agent_id: "4242", tx: "0x" + "cd".repeat(32) });
  const h = JSON.parse((await run(["history", "--since", "24h", "--json"])).stdout);
  const paid = h.actions.find((a) => a.id === x.id);
  assert.equal(paid.status, "confirmed");
  assert.equal(paid.explorer, `https://basescan.org/tx/0x${"ab".repeat(32)}`);
  assert.equal((await run(["history", "--since", "1y"])).code, 2);
  const p = await run(["proof"]);
  assert.match(p.stdout, /ERC-8004 agent: 4242/);
  assert.match(p.stdout, new RegExp(`basescan.org/tx/0x${"ab".repeat(32)}`));
  assert.match(p.stdout, /Check it yourself/);
});

test("status prints ledger fields cleaned: no control or bidi characters from a server reach the terminal", async () => {
  const a = record({ status: "submitted", kind: "x402", chain: "base", usd: 0.01, to: "0xEVIL\u001b[2J‮", url: "http://x" });
  record({ id: a.id, status: "signed_unsettled\nFAKE LINE", tx: "0x\u001b]0;pwned\u0007" });
  const s = await run(["status"]);
  assert.equal(s.code, 0);
  assert.doesNotMatch(s.stdout, /[\u001b\u0007‮]/);
  assert.doesNotMatch(s.stdout, /\nFAKE LINE/);
});

test("the ERC-8004 card does not claim x402 acceptance unless asked, and declares services", () => {
  const card = (u) => JSON.parse(Buffer.from(u.split(",")[1], "base64").toString());
  assert.equal(card(registrationUri({ name: "a", description: "b" })).x402Support, false);
  const c = card(registrationUri({ name: "a", description: "b", services: [{ name: "web", endpoint: "https://x.y" }], x402Support: true }));
  assert.equal(c.x402Support, true);
  assert.deepEqual(c.services, [{ name: "web", endpoint: "https://x.y" }]);
});

void writeFileSync;
