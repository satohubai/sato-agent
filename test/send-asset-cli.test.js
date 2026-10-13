// The real CLI, end to end, against a stand-in Base node: `send --asset` of an ordinary token in ask mode (exit 5 with the plain card,
// then the same command with the code), the dry run, what `history` shows, and that a send with no --asset still binds the v0.4.0 intent.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const TO = "0x1111111111111111111111111111111111111111";
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const text = (s) => `0x${(32).toString(16).padStart(64, "0")}${s.length.toString(16).padStart(64, "0")}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;

const sent = [];
let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      const block = { number: hex(100), hash: word(1), parentHash: word(0), timestamp: hex(1_800_000_000), baseFeePerGas: hex(1_000_000), gasLimit: hex(30_000_000), gasUsed: "0x0", miner: TO, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, mixHash: word(7), sha3Uncles: word(0), stateRoot: word(0), receiptsRoot: word(0), transactionsRoot: word(0), size: "0x1", transactions: [], uncles: [] };
      const call = (p) => {
        const sel = String(p.data).slice(0, 10);
        if (sel === "0x313ce567") return word(18); // decimals
        if (sel === "0x95d89b41") return text("PEPE"); // symbol
        if (sel === "0x06fdde03") return text("Pepe"); // name
        if (sel === "0x70a08231") return word(5_000n * 10n ** 18n); // balanceOf
        throw new Error(`eth_call ${sel}`);
      };
      const ok = (data) => ({ status: "0x1", returnData: data, gasUsed: "0x5208", logs: [] });
      const results = {
        eth_chainId: () => hex(8453),
        eth_getCode: ([a]) => (a.toLowerCase() === PEPE.toLowerCase() ? "0x6080" : "0x"),
        eth_call: ([p]) => call(p),
        eth_getBalance: () => hex(10n ** 17n),
        eth_blockNumber: () => hex(100),
        eth_getBlockByNumber: () => block,
        eth_maxPriorityFeePerGas: () => "0x1",
        eth_gasPrice: () => hex(1_000_000),
        eth_getTransactionCount: () => "0x0",
        eth_simulateV1: ([p]) => [{ calls: p.blockStateCalls[0].calls.map((c, i) => (i === 2 ? { ...ok("0x"), gasUsed: "0xc350" } : ok(word(i === 4 ? 10n ** 21n : 0)))) }],
        eth_sendRawTransaction: ([raw]) => (sent.push(raw), keccak256(raw)),
        eth_getTransactionReceipt: ([h]) => ({ transactionHash: h, status: "0x1", blockNumber: hex(100), blockHash: word(1), transactionIndex: "0x0", from: TO, to: PEPE, gasUsed: "0xc350", cumulativeGasUsed: "0xc350", effectiveGasPrice: hex(1_000_000), logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "0x2", contractAddress: null }),
      };
      let out;
      try {
        out = { jsonrpc: "2.0", id: j.id, result: results[j.method]?.(j.params) };
        if (out.result === undefined) out = { jsonrpc: "2.0", id: j.id, error: { code: -32601, message: `method ${j.method} not found` } };
      } catch (err) {
        out = { jsonrpc: "2.0", id: j.id, error: { code: 3, message: String(err.message) } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

const run = (...args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_BASE_RPC: url, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("setup: a wallet and an owner who asks before every spend", async () => {
  assert.equal((await run("init")).status, 0);
  const set = await run("policy", "set", "--chains", "base", "--per-tx", "5", "--per-day", "50", "--approval", "ask");
  assert.equal(set.status, 0, set.stderr);
});

test("send --asset of an ordinary token in ask mode: exit 5 with the plain card, then the same command with the code sends it", async () => {
  const args = ["send", "--chain", "base", "--to", TO, "--amount", "1000", "--asset", PEPE, "--skip-check"];
  const asked = await run(...args);
  assert.equal(asked.status, 5, asked.stderr);
  assert.match(asked.stdout, /Send 1000 PEPE 0x6982…1933 on base to 0x1111111111111111111111111111111111111111/);
  assert.match(asked.stdout, /Not counted against your USD limits \(no price\)\./);
  assert.match(asked.stdout, /No Sato Hub fee; network gas only\./);
  const intent = JSON.parse(/^Intent: (.*)$/m.exec(asked.stderr)[1]);
  assert.deepEqual([intent.cmd, intent.chain, intent.to, intent.amount, intent.asset, intent.fee], ["send", "base", TO, "1000", PEPE, "No Sato Hub fee; network gas only."]);
  assert.equal(sent.length, 0, "nothing was sent");
  const code = /--approve ([0-9a-f]{8})/.exec(asked.stderr)[1];
  // another asset or amount is another intent
  const other = await run("send", "--chain", "base", "--to", TO, "--amount", "999", "--asset", PEPE, "--skip-check", "--approve", code);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /was given for a different intent/);
  const done = await run(...args, "--approve", code);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Sent 1000 PEPE 0x6982…1933 on base to 0x1111111111111111111111111111111111111111\n  https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}/);
  assert.equal(sent.length, 1, "sent once");
  const hist = await run("history");
  assert.match(hist.stdout, /send\s+confirmed\s+base\s+no price \(1000 PEPE 0x6982…1933\) 0x1111/);
  const status = await run("status");
  assert.match(status.stdout, /spent in the last 24 hours: \$0\n/);
  const j = JSON.parse((await run("history", "--json")).stdout);
  const row = j.actions.find((a) => a.kind === "send");
  assert.deepEqual([row.usd, row.unpriced, row.asset_address, row.amount], [null, true, PEPE, "1000"]);
});

test("send --asset --dry-run needs no approval and signs nothing; --json carries the same facts", async () => {
  const before = sent.length;
  const d = await run("send", "--chain", "base", "--to", TO, "--amount", "all", "--asset", PEPE, "--skip-check", "--dry-run", "--json");
  assert.equal(d.status, 0, d.stderr);
  const j = JSON.parse(d.stdout);
  assert.deepEqual([j.dry_run, j.simulated, j.amount, j.asset, j.unpriced, j.usd, j.sato_fee], [true, true, "5000", "PEPE 0x6982…1933", true, null, "No Sato Hub fee; network gas only."]);
  assert.equal(sent.length, before);
  const human = await run("send", "--chain", "base", "--to", TO, "--amount", "1", "--asset", PEPE, "--skip-check", "--dry-run");
  assert.match(human.stdout, /DRY RUN: the checks and the simulation passed for 1 PEPE 0x6982…1933 on base to 0x1111/);
});

test("a token that is not a token, and an --asset with no value, are plain refusals and usage errors", async () => {
  const none = await run("send", "--chain", "base", "--to", TO, "--amount", "1", "--asset", "0x2222222222222222222222222222222222222222", "--skip-check", "--dry-run");
  assert.equal(none.status, 3);
  assert.match(none.stderr, /REFUSED token_unreadable: there is no contract at/);
  assert.equal((await run("send", "--chain", "base", "--to", TO, "--amount", "1", "--asset", "--skip-check")).status, 2);
});

test("with no --asset and a number, send binds exactly the intent v0.4.0 bound (no asset, no fee line)", async () => {
  const asked = await run("send", "--chain", "base", "--to", TO, "--amount", "1", "--skip-check");
  assert.equal(asked.status, 5, asked.stderr);
  assert.match(asked.stderr, new RegExp(`Intent: \\{"cmd":"send","chain":"base","to":"${TO}","amount":"1","skip_check":true\\}\\n`));
  assert.doesNotMatch(asked.stdout + asked.stderr, /Sato Hub fee/);
});
