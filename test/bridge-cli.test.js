// `sato-agent bridge` through the real CLI, offline: usage, the plain refusals that need no network, the policy switch, and how a
// bridge row reads in `status` and `history`. (The orchestration itself is in bridge-run.test.js.)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 60_000 });
const { record } = await import("../src/ledger.js");

assert.equal(run("init").status, 0);
assert.equal(run("policy", "set", "--chains", "base,arbitrum,bnb,solana", "--per-tx", "100", "--per-day", "300").status, 0);
const bridge = (...rest) => run("bridge", "--chain", "base", "--to-chain", "arbitrum", "--asset", "USDC", "--amount", "5", ...rest);

test("help documents bridge and the --bridges switch", () => {
  const h = run("help").stdout;
  assert.match(h, /bridge --chain base\|arbitrum\|polygon --to-chain /);
  assert.match(h, /bridge status \[--id /);
  assert.match(h, /\[--bridges on\|off\]/);
});

test("a bridge written wrongly is a usage error (exit 2)", () => {
  assert.equal(run("bridge", "--chain", "base").status, 2);
  assert.equal(run("bridge", "--chain", "base", "--to-chain", "base", "--asset", "USDC", "--amount", "5").status, 2);
  const bad = run("bridge", "--chain", "base", "--to-chain", "arbitrum", "--asset", "PEPE", "--amount", "5");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /is none of those/);
  assert.equal(run("bridge", "status", "extra").status, 2);
});

test("BNB Chain and Solana as the source are refused (exit 3) in plain words, with no network", () => {
  const bnb = run("bridge", "--chain", "bnb", "--to-chain", "base", "--asset", "USDT", "--amount", "5");
  assert.equal(bnb.status, 3);
  assert.match(bnb.stderr, /bridge_source_unsupported/);
  assert.match(bnb.stderr, /contract this kit does not read yet/);
  const sol = run("bridge", "--chain", "solana", "--to-chain", "base", "--asset", "USDC", "--amount", "5", "--json");
  assert.equal(sol.status, 3);
  assert.equal(JSON.parse(sol.stdout).refused[0].rule, "bridge_source_unsupported");
});

test("a destination outside the policy is refused (exit 3)", () => {
  const r = run("bridge", "--chain", "base", "--to-chain", "polygon", "--asset", "USDC", "--amount", "5", "--dry-run");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /chain_not_allowed/);
});

test("policy set --bridges off stops bridges (exit 3, nothing asked); turning them on again is flagged as a raise", () => {
  const off = run("policy", "set", "--bridges", "off");
  assert.equal(off.status, 0);
  assert.match(off.stdout, /bridges: {9}off/);
  const r = bridge("--dry-run");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /bridges_not_enabled/);
  const on = run("policy", "set", "--bridges", "on");
  assert.match(on.stdout, /RAISED \(bridges turned on\)/);
  assert.match(on.stdout, /bridges: {9}on/);
  assert.equal(run("policy", "set", "--bridges", "maybe").status, 1);
});

test("bridge status with no bridges, and with an id that is not there", () => {
  assert.match(run("bridge", "status").stdout, /\(no bridges yet\)/);
  assert.deepEqual(JSON.parse(run("bridge", "status", "--json").stdout).bridges, []);
  const none = run("bridge", "status", "--id", "nothing-here");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no bridge in this wallet's ledger matches/);
});

test("a bridge in the ledger reads in status and history: route, amounts, order id, explorer", () => {
  record({ id: "cli-1", kind: "bridge", status: "submitted", chain: "base", chain_out: "arbitrum", usd: 10, asset_in: "USDC", amount_in: "10", asset_out: "USDC", take_amount: "9.5", to: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66" });
  record({ id: "cli-1", status: "sent", tx: `0x${"a".repeat(64)}`, order_id: `0x${"b".repeat(64)}`, order_id_source: "log" });
  const h = run("history").stdout;
  assert.match(h, /bridge +sent +base +\$10 base->arbitrum 10 USDC -> 9\.5 USDC order 0xb{64}/);
  assert.match(h, /basescan\.org\/tx\/0xa{64}/);
  const s = run("status").stdout;
  assert.match(s, /bridge base \$10 base->arbitrum 10 USDC -> 9\.5 USDC order/);
  assert.match(s, /spent in the last 24 hours: \$10/);
});
