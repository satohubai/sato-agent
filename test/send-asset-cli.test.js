// The real CLI, end to end, against a stand-in Base node: `send --asset` of an ordinary token in ask mode (exit 5 with the plain card,
// then the same command with the code), the dry run, what `history` shows, and that a send with no --asset still binds the v0.4.0 intent.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { address as solAddress, getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const ETH_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70".toLowerCase();
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TO = "0x1111111111111111111111111111111111111111";
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const text = (s) => `0x${(32).toString(16).padStart(64, "0")}${s.length.toString(16).padStart(64, "0")}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;

const sent = [];
let server;
let url;
let baseFee = 1_000_000n; // the node's base fee per gas, changed by a test to move the gas reserve
let mcp;
let mcpUrl;
let mcpMode = { verdict: "go" };
let mcpAsked = [];
let sol;
let solUrl;
const solSeen = { simulate: [], send: [] };
let solHeld = []; // the wallet's token accounts, as getTokenAccountsByOwner lists them
before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      const block = { number: hex(100), hash: word(1), parentHash: word(0), timestamp: hex(1_800_000_000), baseFeePerGas: hex(baseFee), gasLimit: hex(30_000_000), gasUsed: "0x0", miner: TO, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, mixHash: word(7), sha3Uncles: word(0), stateRoot: word(0), receiptsRoot: word(0), transactionsRoot: word(0), size: "0x1", transactions: [], uncles: [] };
      const call = (p) => {
        const sel = String(p.data).slice(0, 10);
        // Chainlink's ETH/USD feed on Base: $2,500, updated just now
        if (String(p.to).toLowerCase() === ETH_FEED) {
          if (sel === "0x313ce567") return word(8);
          if (sel === "0xfeaf968c") return `0x${[1n, 2500n * 10n ** 8n, 1n, BigInt(Math.floor(Date.now() / 1000)), 1n].map((n) => n.toString(16).padStart(64, "0")).join("")}`;
        }
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

  // A stand-in for Sato Hub's Preflight: it answers for the ONE target it was asked about, as the real one does.
  mcp = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const args = JSON.parse(raw).params.arguments;
      mcpAsked.push(args);
      const structured = { verdict: mcpMode.verdict, rule: "A1", target: { kind: "address" }, checked_at: "2026-10-12T00:00:00Z" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `Preflight address: ${mcpMode.verdict} (mock evidence line)` }], structuredContent: structured } }));
    });
  });
  await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${mcp.address().port}/api/mcp`;

  // A stand-in Solana node: the reads a send makes, and a record of every transaction handed to it.
  sol = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      const ctx = { slot: 1 };
      const value = {
        getBalance: () => ({ context: ctx, value: 5_000_000_000 }),
        getAccountInfo: () => ({ context: ctx, value: null }),
        getTokenAccountsByOwner: () => ({ context: ctx, value: solHeld }),
        getMinimumBalanceForRentExemption: ([size]) => (size === 0 ? 890_880 : 2_039_280),
        getLatestBlockhash: () => ({ context: ctx, value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000 } }),
        simulateTransaction: ([wire, cfg]) => (solSeen.simulate.push({ wire, cfg }), { context: ctx, value: { err: null, logs: [] } }),
        sendTransaction: ([wire]) => (solSeen.send.push(wire), "ignored"),
        getSignatureStatuses: () => ({ context: ctx, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" }] }),
      }[j.method]?.(j.params);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value === undefined ? { jsonrpc: "2.0", id: j.id, error: { code: -32601, message: `method ${j.method} not found` } } : { jsonrpc: "2.0", id: j.id, result: value }));
    });
  });
  await new Promise((r) => sol.listen(0, "127.0.0.1", r));
  solUrl = `http://127.0.0.1:${sol.address().port}`;
});
after(() => {
  for (const s of [server, mcp, sol]) s?.closeAllConnections?.() ?? s?.close();
});

const run = (...args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_BASE_RPC: url, SATO_AGENT_SOLANA_RPC: solUrl, SATO_AGENT_MCP_URL: mcpUrl } });
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

// ------------------------------------------------------------------ the recipient check and the owner's gate run (no --skip-check)

test("without --skip-check the Sato Hub recipient check runs before anything else, and the owner's gate can stop an --asset send", async () => {
  assert.equal((await run("policy", "set", "--check-gate", "caution", "--on-check-unavailable", "refuse")).status, 0);
  const args = ["send", "--chain", "base", "--to", TO, "--amount", "7", "--asset", PEPE];
  mcpMode = { verdict: "caution" };
  mcpAsked = [];
  const stopped = await run(...args);
  assert.equal(stopped.status, 3, stopped.stderr);
  assert.match(stopped.stdout, /Sato Hub check \(dated evidence, not a verdict on anyone\):\nPreflight address: caution \(mock evidence line\)/);
  assert.match(stopped.stderr, /REFUSED check_caution/);
  assert.deepEqual([mcpAsked.length, mcpAsked[0].address, mcpAsked[0].chain], [1, TO, "Base"], "the recipient is the one thing it was asked about");
  assert.doesNotMatch(stopped.stdout + stopped.stderr, /--approve/, "refused before the owner is asked");
  mcpMode = { verdict: "go" };
  const asked = await run(...args);
  assert.equal(asked.status, 5, asked.stderr);
  assert.match(asked.stdout, /Sato Hub check .*\nPreflight address: go[\s\S]*Send 7 PEPE 0x6982…1933 on base/, "the check text comes first, then the plan");
  // the gate off again for the rest
  assert.equal((await run("policy", "set", "--check-gate", "off")).status, 0);
});

// ------------------------------------------------------------------ priced assets by address, and a native all in ask mode

test("a stablecoin by its ADDRESS is priced 1:1; the native placeholder address is the coin, priced from Chainlink", async () => {
  const usdc = await run("send", "--chain", "base", "--to", TO, "--amount", "2.5", "--asset", USDC, "--skip-check", "--dry-run", "--json");
  assert.equal(usdc.status, 0, usdc.stderr);
  const u = JSON.parse(usdc.stdout);
  assert.deepEqual([u.asset, u.usd, u.unpriced, u.asset_address], ["USDC", 2.5, false, USDC]);
  const eth = await run("send", "--chain", "base", "--to", TO, "--amount", "0.001", "--asset", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "--skip-check", "--dry-run", "--json");
  assert.equal(eth.status, 0, eth.stderr);
  const e = JSON.parse(eth.stdout);
  assert.deepEqual([e.asset, e.usd, e.unpriced, e.asset_address], ["ETH", 2.5, false, null]);
  const human = await run("send", "--chain", "base", "--to", TO, "--amount", "0.001", "--asset", "ETH", "--skip-check", "--dry-run");
  assert.match(human.stdout, /Counts as about \$2\.5 against your USD limits \(ETH at \$2500\.00, Chainlink, \d+ s old\)\./);
});

test("a native --amount all in ask mode: the code covers 'all' and at most the units shown; gas that rose still works, gas that fell is refused and the code is kept", async () => {
  const args = ["send", "--chain", "base", "--to", TO, "--amount", "all", "--asset", "ETH", "--skip-check"];
  assert.equal((await run("policy", "set", "--per-tx", "none", "--per-day", "none")).status, 0);
  baseFee = 1_000_000_000n;
  const asked = await run(...args);
  assert.equal(asked.status, 5, asked.stderr);
  const said = asked.stdout + asked.stderr;
  assert.match(said, /An approval of this covers at most 0\.09\d+ ETH/);
  const intent = JSON.parse(/^Intent: (.*)$/m.exec(said)[1]);
  assert.equal(intent.amount, "all");
  const code = /--approve ([0-9a-f]{8})/.exec(said)[1];
  // the owner's yes is for 'all' at most that: cheaper gas would send MORE, so it stops (and the code is still good)
  baseFee = 1_000n;
  const more = await run(...args, "--approve", code);
  assert.equal(more.status, 3, more.stderr);
  assert.match(more.stderr, /REFUSED approval_bound_exceeded: the amount is now larger than the 0\.09\d+ ETH the owner approved/);
  assert.equal(sent.length, 1, "only the token send from before; nothing new went out");
  // dearer gas sends fewer units: it goes through
  baseFee = 5_000_000_000n;
  const fewer = await run(...args, "--approve", code);
  assert.equal(fewer.status, 0, fewer.stderr);
  assert.match(fewer.stdout, /Sent 0\.09\d+ ETH on base/);
  assert.equal(sent.length, 2);
  baseFee = 1_000_000n;
});

// ------------------------------------------------------------------ Solana, in ask mode: nothing signed leaves before the owner says yes

test("Solana in ask mode: the plan simulates an unsigned copy, exit 5 shows the card, and only the approved run signs and broadcasts", async () => {
  assert.equal((await run("policy", "set", "--chains", "base,solana")).status, 0);
  const me = JSON.parse((await run("init", "--json")).stdout).solana;
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const [pubkey] = await findAssociatedTokenPda({ owner: solAddress(me), mint: solAddress(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  solHeld = [{ pubkey, account: { data: { parsed: { info: { tokenAmount: { amount: "50000000" } } } } } }];
  const TO_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const unsignedWire = (wire) => Object.values(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures).every((x) => x === null || Buffer.from(x).every((b) => b === 0));
  const args = ["send", "--chain", "solana", "--to", TO_SOL, "--amount", "3", "--asset", "USDC", "--skip-check"];

  const dry = await run(...args, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  const asked = await run(...args);
  assert.equal(asked.status, 5, asked.stderr);
  assert.match(asked.stdout, /Send 3 USDC on solana to 9xQe/);
  assert.match(asked.stdout, /pays about 0\.00203928 SOL in rent to create it/);
  assert.equal(solSeen.simulate.length, 2, "one simulation per plan");
  assert.ok(solSeen.simulate.every((x) => unsignedWire(x.wire) && x.cfg.sigVerify === false && x.cfg.replaceRecentBlockhash === true), "every wire the node saw before the yes was unsigned");
  assert.equal(solSeen.send.length, 0, "nothing was broadcast");
  // with no --asset (v0.4.0's send) the ask-mode run builds and sends the node nothing at all before the yes
  const legacy = await run("send", "--chain", "solana", "--to", TO_SOL, "--amount", "3", "--skip-check");
  assert.equal(legacy.status, 5, legacy.stderr);
  assert.equal(solSeen.simulate.length, 2);
  assert.equal(solSeen.send.length, 0);
  const code = /--approve ([0-9a-f]{8})/.exec(asked.stderr)[1];
  const done = await run(...args, "--approve", code);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Sent 3 USDC on solana to 9xQe/);
  assert.equal(solSeen.send.length, 1);
  assert.ok(!unsignedWire(solSeen.send[0]), "the broadcast transaction is signed");
  assert.equal(solSeen.simulate.length, 3, "the approved run planned once more (unsigned) and then signed");
  assert.ok(unsignedWire(solSeen.simulate[2].wire));
});

test("the v0.4.0 Solana USDC dry run (no --asset) sends the node an unsigned transaction too", async () => {
  const before = solSeen.simulate.length;
  const TO_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const d = await run("send", "--chain", "solana", "--to", TO_SOL, "--amount", "1", "--skip-check", "--dry-run");
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^DRY RUN: the checks and the simulation passed for 1 USDC on solana/);
  assert.equal(solSeen.simulate.length, before + 1);
  const { wire, cfg } = solSeen.simulate.at(-1);
  assert.ok(Object.values(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures).every((x) => x === null || Buffer.from(x).every((b) => b === 0)));
  assert.equal(cfg.sigVerify, false);
});

test("auto mode: a token with NO price still stops for the owner's yes (exit 5); a priced stablecoin does not (owner ruling 2026-10-15)", async () => {
  assert.equal((await run("policy", "set", "--approval", "auto")).status, 0);
  const before = sent.length;
  const asked = await run("send", "--chain", "base", "--to", TO, "--amount", "10", "--asset", PEPE, "--skip-check");
  assert.equal(asked.status, 5, asked.stderr);
  assert.match(asked.stdout, /Not counted against your USD limits \(no price\)\./);
  assert.equal(sent.length, before, "nothing was sent");
  const code = /--approve ([0-9a-f]{8})/.exec(asked.stderr)[1];
  const dry = JSON.parse((await run("send", "--chain", "base", "--to", TO, "--amount", "10", "--asset", PEPE, "--skip-check", "--dry-run", "--json")).stdout);
  assert.equal(dry.would_need_approval, true);
  const human = await run("send", "--chain", "base", "--to", TO, "--amount", "10", "--asset", PEPE, "--skip-check", "--dry-run");
  assert.match(human.stdout, /it will stop for the owner's yes \(exit 5\): a token with no price always does/);
  const done = await run("send", "--chain", "base", "--to", TO, "--amount", "10", "--asset", PEPE, "--skip-check", "--approve", code);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(sent.length, before + 1, "sent once, after the yes");
  // A priced stablecoin in auto mode acts within the limits, as before.
  const usdc = await run("send", "--chain", "base", "--to", TO, "--amount", "1", "--asset", USDC, "--skip-check");
  assert.equal(usdc.status, 0, usdc.stderr);
  assert.equal(sent.length, before + 2);
  assert.equal((await run("policy", "set", "--approval", "ask")).status, 0);
});
