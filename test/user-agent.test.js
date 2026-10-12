// SATO_AGENT_UA: the default user-agent is unchanged; a valid override replaces it on
// the requests the kit makes (Sato Hub's MCP endpoint here); anything that is not a
// plain header value falls back to the default.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshHome } from "./helpers.js";

freshHome();
delete process.env.SATO_AGENT_UA;

const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.headers["user-agent"]);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":true}" }] } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.SATO_AGENT_MCP_URL = `http://127.0.0.1:${server.address().port}/api/mcp`;

const { VERSION, USER_AGENT, userAgent, userAgentOverride, MAX_USER_AGENT_LENGTH } = await import("../src/version.js");
const { callTool } = await import("../src/satohub.js");

test.after(() => server.close());
test.afterEach(() => { delete process.env.SATO_AGENT_UA; });

test("default: sato-agent/<version> when SATO_AGENT_UA is unset", () => {
  assert.equal(USER_AGENT, `sato-agent/${VERSION}`);
  assert.equal(userAgent({}), `sato-agent/${VERSION}`);
  assert.equal(userAgent(), `sato-agent/${VERSION}`);
});

test("a valid override replaces it, trimmed", () => {
  assert.equal(userAgent({ SATO_AGENT_UA: "SatoHub-grok-bot/1.0 (sato-agent/9.9.9)" }), "SatoHub-grok-bot/1.0 (sato-agent/9.9.9)");
  assert.equal(userAgent({ SATO_AGENT_UA: "  my-fleet/2  " }), "my-fleet/2");
  assert.equal(userAgent({ SATO_AGENT_UA: "x".repeat(MAX_USER_AGENT_LENGTH) }), "x".repeat(MAX_USER_AGENT_LENGTH));
});

test("an unusable value falls back to the default", () => {
  const bad = ["", "   ", "\t", "a\r\nx-injected: 1", "a\nb", "a\rb", "x".repeat(MAX_USER_AGENT_LENGTH + 1), "café", "bell\u0007", "tab\tinside", "\u0000"];
  for (const v of bad) {
    assert.equal(userAgentOverride({ SATO_AGENT_UA: v }), null, JSON.stringify(v));
    assert.equal(userAgent({ SATO_AGENT_UA: v }), USER_AGENT, JSON.stringify(v));
  }
});

test("the Sato Hub MCP call sends the default, then the override once it is set (read per call)", async () => {
  seen.length = 0;
  await callTool("onchain_agent_list_chains", {});
  process.env.SATO_AGENT_UA = "SatoHub-grok-bot/1.0 (sato-agent/test)";
  await callTool("onchain_agent_list_chains", {});
  process.env.SATO_AGENT_UA = "bad\r\nvalue";
  await callTool("onchain_agent_list_chains", {});
  assert.deepEqual(seen, [`sato-agent/${VERSION}`, "SatoHub-grok-bot/1.0 (sato-agent/test)", `sato-agent/${VERSION}`]);
});

test("every outbound user-agent in src/ comes from userAgent(), so the override reaches all of them", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".js")) files.push(e.name);
    if (e.isDirectory()) for (const f of readdirSync(new URL(`${e.name}/`, dir))) if (f.endsWith(".js")) files.push(`${e.name}/${f}`);
  }
  for (const f of files.filter((n) => n !== "version.js")) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/USER_AGENT/.test(src), `${f} uses the constant instead of userAgent()`);
    for (const m of src.matchAll(/["']user-agent["']\s*:\s*([^,}]+)/g)) {
      assert.match(m[1].trim(), /^(userAgent\(\)|d\.userAgent)$/, `${f}: ${m[0]}`);
    }
  }
});
