// v0.1.1 owner controls, offline: chain binding, raises (any loosening), Sato
// Hub checks that can stop a spend, kit-enforced approval, strict amounts,
// pay headers, status rounding, and the ERC-8004 card. A local mock stands in
// for Sato Hub; RPCs point at a closed port, so nothing reaches a chain.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { setPolicy, evaluate, raisesBetween } = await import("../src/policy.js");
const { usdcUnits } = await import("../src/amount.js");
const { registrationUri } = await import("../src/base.js");
const { record } = await import("../src/ledger.js");
const { gateRefusals } = await import("../src/satohub.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const DEAD = "0x000000000000000000000000000000000000dEaD";
let mcp; // mock Sato Hub
let mcpUrl;
let verdict = "go";
let web; // plain HTTP resource for pay headers
let webUrl;
let lastHeaders = null;

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
      if (verdict === "down") {
        res.writeHead(503);
        return res.end("down");
      }
      const result = { content: [{ type: "text", text: `Preflight: ${verdict} (mock)` }], structuredContent: { verdict, rule: "A1", checked_at: "2026-10-09T00:00:00Z" } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${mcp.address().port}/api/mcp`;
  web = createServer((req, res) => {
    lastHeaders = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"free":true}');
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  webUrl = `http://127.0.0.1:${web.address().port}/thing`;
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

test("a spend on a chain the agent is not set for is refused", () => {
  const p = { max_usd_per_tx: null, max_usd_per_day: null, allow_recipients: null, chains: ["base"] };
  assert.deepEqual(evaluate(p, { usd: 1, to: "x", chain: "solana" }, 0).map((r) => r.rule), ["chain_not_allowed"]);
  assert.deepEqual(evaluate(p, { usd: 1, to: "x", chain: "base" }, 0), []);
});

test("check gating follows the owner's choice; unknown never stops a spend", () => {
  const ok = (p, c) => gateRefusals(p, c).map((r) => r.rule);
  assert.deepEqual(ok({ check_gate: "off" }, { verdict: "no" }), []);
  assert.deepEqual(ok({}, { verdict: "no" }), [], "unset = informs only");
  assert.deepEqual(ok({ check_gate: "no" }, { verdict: "no" }), ["check_no"]);
  assert.deepEqual(ok({ check_gate: "no" }, { verdict: "caution" }), []);
  assert.deepEqual(ok({ check_gate: "caution" }, { verdict: "caution" }), ["check_caution"]);
  assert.deepEqual(ok({ check_gate: "caution" }, { verdict: "unknown" }), []);
  assert.deepEqual(ok({ check_gate: "no" }, { unavailable: true }), [], "unavailable: allowed unless the owner chose refuse");
  assert.deepEqual(ok({ check_gate: "no", on_check_unavailable: "refuse" }, { unavailable: true }), ["check_unavailable"]);
  assert.deepEqual(gateRefusals({ check_gate: "no" }, {}, { skipped: true }).map((r) => r.rule), ["check_required"]);
});

test("CLI: a Base-only agent shows only Base, and refuses a Solana send", async () => {
  await run(["init"]);
  assert.equal((await run(["policy", "set", "--chains", "base", "--per-tx", "5", "--per-day", "20"])).code, 0);
  const addr = JSON.parse((await run(["address", "--json"])).stdout);
  assert.deepEqual(Object.keys(addr), ["base"]);
  const r = await run(["send", "--chain", "solana", "--to", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "--amount", "1"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /chain_not_allowed/);
});

test("CLI: with the gate on, a `no` verdict stops the send before anything is signed", async () => {
  await run(["policy", "set", "--check-gate", "no"]);
  verdict = "no";
  const r = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /check_no/);
  verdict = "go";
  const g = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.notEqual(g.code, 3, "a go verdict does not stop it (it then fails on the closed RPC port)");
  const s = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1", "--skip-check"]);
  assert.equal(s.code, 3);
  assert.match(s.stderr, /check_required/);
});

test("CLI: a check that cannot run follows the owner's on-unavailable choice", async () => {
  verdict = "down";
  const allowed = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.notEqual(allowed.code, 3);
  await run(["policy", "set", "--on-check-unavailable", "refuse"]);
  const refused = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "1"]);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /check_unavailable/);
  verdict = "go";
  assert.match((await run(["status"])).stdout, /checks skipped or unavailable/);
});

test("CLI: approval mode needs the owner's yes for the exact intent, once", async () => {
  await run(["policy", "set", "--approval", "ask"]);
  const ask = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--json"]);
  assert.equal(ask.code, 5, "nothing spent: needs approval");
  const { code } = JSON.parse(ask.stdout).needs_approval;
  const other = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "3", "--approve", code]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /different intent/);
  const yes = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--approve", code]);
  assert.ok(![2, 3, 5].includes(yes.code), "approved: proceeds to the spend (then fails on the closed RPC port)");
  const again = await run(["send", "--chain", "base", "--to", DEAD, "--amount", "2", "--approve", code]);
  assert.match(again.stderr, /already used|not found/);
  const back = await run(["policy", "set", "--approval", "auto"]);
  assert.match(back.stdout, /RAISED \(approval: ask -> auto\)/);
});

test("CLI: pay sends --header values and a JSON content-type for JSON bodies", async () => {
  const r = await run(["pay", webUrl, "--method", "POST", "--data", '{"q":1}', "--header", "x-api-tag: sato", "--skip-check"], {});
  // the gate is on in this home, so --skip-check is refused; turn it off and retry
  assert.equal(r.code, 3);
  await run(["policy", "set", "--check-gate", "off"]);
  const ok = await run(["pay", webUrl, "--method", "POST", "--data", '{"q":1}', "--header", "x-api-tag: sato", "--skip-check"]);
  assert.equal(ok.code, 0);
  assert.equal(lastHeaders["x-api-tag"], "sato");
  assert.equal(lastHeaders["content-type"], "application/json");
  assert.equal((await run(["pay", webUrl, "--header", "no-colon", "--skip-check"])).code, 2);
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

test("the ERC-8004 card does not claim x402 acceptance unless asked, and declares services", () => {
  const card = (u) => JSON.parse(Buffer.from(u.split(",")[1], "base64").toString());
  assert.equal(card(registrationUri({ name: "a", description: "b" })).x402Support, false);
  const c = card(registrationUri({ name: "a", description: "b", services: [{ name: "web", endpoint: "https://x.y" }], x402Support: true }));
  assert.equal(c.x402Support, true);
  assert.deepEqual(c.services, [{ name: "web", endpoint: "https://x.y" }]);
});
