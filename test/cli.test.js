// The CLI end to end, offline: wallet creation, file permissions, refusals,
// strict flag parsing, and that the private keys never appear in its output.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

test("init creates a private wallet once, and never replaces it", () => {
  const first = JSON.parse(execFileSync(process.execPath, [BIN, "init", "--json"], { env, encoding: "utf8" }));
  assert.equal(first.created, true);
  assert.match(first.base, /^0x[0-9a-fA-F]{40}$/);
  assert.match(first.solana, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const again = JSON.parse(run("init", "--json").stdout);
  assert.equal(again.existing, true);
  assert.equal(again.base, first.base);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "wallet.json")).mode & 0o777, 0o600);
});

test("spending is refused (exit 3) until limits are set", () => {
  const r = run("send", "--chain", "base", "--to", "0x000000000000000000000000000000000000dEaD", "--amount", "1", "--skip-check");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /limits_not_set/);
  assert.equal(run("pay", "https://example.invalid/x", "--skip-check").status, 3);
});

test("flags are parsed strictly: typos, missing values and junk amounts are usage errors (exit 2)", () => {
  assert.equal(run("policy", "set", "--perday", "5", "--per-tx", "5").status, 2, "typo'd flag");
  assert.equal(run("policy", "set", "--per-day", "5", "--per-tx").status, 2, "flag with no value");
  assert.equal(run("send", "--skip-check=false").status, 2, "boolean given a value");
  assert.equal(run("policy", "set", "--per-tx", "0x10", "--per-day", "5").status, 1, "hex amount");
  assert.equal(run("policy", "show", "--json").stdout.trim(), JSON.stringify({ policy: null }, null, 2));
});

test("raising a limit prints a warning and is logged", () => {
  assert.equal(run("policy", "set", "--per-tx", "1", "--per-day", "5").status, 0);
  const up = run("policy", "set", "--per-day", "500");
  assert.match(up.stdout, /LIMITS RAISED/);
  const down = run("policy", "set", "--per-day", "50");
  assert.doesNotMatch(down.stdout, /RAISED/);
  assert.match(run("status").stdout, /raised/);
});

test("no private key ever reaches stdout or stderr", () => {
  const w = JSON.parse(readFileSync(join(home, "wallet.json"), "utf8"));
  const secrets = [w.evm.private_key.slice(2), w.solana.secret_key_b64];
  const outputs = [
    run("init"), run("address"), run("address", "--json"), run("status"), run("status", "--json"),
    run("policy", "show"), run("help"), run("send", "--chain", "solana", "--to", "bad", "--amount", "1", "--skip-check"),
  ];
  for (const o of outputs) for (const s of secrets) {
    assert.ok(!o.stdout.includes(s) && !o.stderr.includes(s), "a private key was printed");
  }
});
