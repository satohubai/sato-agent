// The last-outcome note (src/last-outcome.js): when a `swap` ends without a swap, the next swap
// quote tells Sato Hub, once, the exit code and the rule ids that stopped it. Nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const home = freshHome();

const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ outcome: req.headers["x-sato-agent-last-outcome"] ?? null, tool: JSON.parse(body || "{}")?.params?.name });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{}" }] } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.SATO_AGENT_MCP_URL = `http://127.0.0.1:${server.address().port}/api/mcp`;

const { recordSwapOutcome, takeSwapOutcome, OUTCOME_HEADER } = await import("../src/last-outcome.js");
const { callTool } = await import("../src/satohub.js");
const note = () => join(home, "last-outcome.json");

test.after(() => server.close());
test.beforeEach(() => { seen.length = 0; takeSwapOutcome(); });

test("the note holds the exit code and rule ids only, is read once, and is deleted", () => {
  recordSwapOutcome({ exit: 3, rules: ["solana_swap.fee_missing", "max_usd_per_tx"] });
  const stored = JSON.parse(readFileSync(note(), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["at", "exit", "rules"]);
  assert.equal(takeSwapOutcome(), "exit=3;rules=solana_swap.fee_missing,max_usd_per_tx");
  assert.equal(existsSync(note()), false);
  assert.equal(takeSwapOutcome(), null, "read once");
});

test("anything that is not a plain rule id is dropped; at most five; duplicates once", () => {
  recordSwapOutcome({ exit: 5, rules: ["price_impact", "Price Impact", "a,b", "x;y", "0xabc DEF", "price_impact", "r1", "r2", "r3", "r4", "r5", "x".repeat(65)] });
  assert.equal(takeSwapOutcome(), "exit=5;rules=price_impact,r1,r2,r3,r4");
  recordSwapOutcome({ exit: 1, rules: [] });
  assert.equal(takeSwapOutcome(), "exit=1");
  // A code with a CamelCase name is lower-cased, not dropped.
  recordSwapOutcome({ exit: 5, rules: ["issuer_power_PermanentDelegate", "solana_swap.route_unbuildable"] });
  assert.equal(takeSwapOutcome(), "exit=5;rules=issuer_power_permanentdelegate,solana_swap.route_unbuildable");
});

test("a note older than a day, from the future, or unreadable is dropped unsent", () => {
  const now = Date.now();
  recordSwapOutcome({ exit: 3, rules: ["a"] }, now - 25 * 3600 * 1000);
  assert.equal(takeSwapOutcome(now), null);
  recordSwapOutcome({ exit: 3, rules: ["a"] }, now + 60_000);
  assert.equal(takeSwapOutcome(now), null);
  writeFileSync(note(), "{not json");
  assert.equal(takeSwapOutcome(), null);
  assert.equal(existsSync(note()), false);
  recordSwapOutcome({ exit: "3", rules: ["a"] });
  assert.equal(existsSync(note()), false, "a non-integer exit is not recorded");
});

test("the next swap quote carries it once; no other tool ever does", async () => {
  recordSwapOutcome({ exit: 3, rules: ["solana_swap.price_impact"] });
  await callTool("onchain_agent_preflight", { url: "https://example.com" });
  await callTool("onchain_agent_swap", { mode: "quote" });
  await callTool("onchain_agent_swap", { mode: "quote" });
  assert.deepEqual(seen, [
    { outcome: null, tool: "onchain_agent_preflight" },
    { outcome: "exit=3;rules=solana_swap.price_impact", tool: "onchain_agent_swap" },
    { outcome: null, tool: "onchain_agent_swap" },
  ]);
  assert.equal(OUTCOME_HEADER, "x-sato-agent-last-outcome");
});

test("the CLI notes a swap that ends without a swap, and only a swap", () => {
  const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" };
  execFileSync(process.execPath, [BIN, "init", "--json"], { env, encoding: "utf8" });
  // A swap with missing arguments: usage error, exit 2.
  const bad = spawnSync(process.execPath, [BIN, "swap", "--chain", "solana"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.equal(takeSwapOutcome(), "exit=2");
  // A swap with no limits set: refused (exit 3), with the rule that stopped it.
  const refused = spawnSync(process.execPath, [BIN, "swap", "--chain", "solana", "--from", "USDC", "--to", "SOL", "--amount", "1"], { env, encoding: "utf8" });
  assert.equal(refused.status, 3, refused.stderr);
  const sent = takeSwapOutcome();
  assert.match(sent ?? "", /^exit=3;rules=[a-z0-9_.-]+(,[a-z0-9_.-]+)*$/);
  // Another command failing leaves no note.
  const other = spawnSync(process.execPath, [BIN, "send", "--chain", "solana"], { env, encoding: "utf8" });
  assert.notEqual(other.status, 0);
  assert.equal(takeSwapOutcome(), null);
});
