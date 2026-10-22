// The CLI end to end, offline: wallet creation, file permissions, refusals,
// strict flag parsing, and that the private keys never appear in its output.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome, raisesTakeEffect } from "./helpers.js";

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
  // On a shared computer the wallet found here may be another bot's: init says so, and what a new bot does instead.
  assert.equal(again.name, "agent");
  assert.equal(again.notice, `A wallet already exists for agent (address ${first.base}). If you are a new bot, do not use it: pick a new NAME (for example agent-2), write a new launcher, and run init there. Never replace, move or delete another bot's wallet.`);
  const human = run("init");
  assert.equal(human.status, 0);
  assert.ok(human.stdout.startsWith(again.notice), "the notice is the first thing it prints");
  assert.ok(human.stdout.includes(first.base) && human.stdout.includes(first.solana));
  assert.equal(JSON.parse(readFileSync(join(home, "wallet.json"), "utf8")).evm.address, first.base, "the wallet is untouched");
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
  assert.equal(run("policy", "set", "--per-tx", "1", "--per-day", "5").status, 1, "the first set needs --chains: no defaults");
  assert.equal(run("policy", "set", "--chains", "base", "--per-tx", "1", "--per-day", "5").status, 0);
  const up = run("policy", "set", "--per-day", "500");
  assert.match(up.stdout, /RAISE QUEUED, not in effect yet \(max_usd_per_day\)/);
  assert.match(up.stdout, /per 24 hours: \$5 → \$500: takes effect at /);
  raisesTakeEffect(); // a day later
  const down = run("policy", "set", "--per-day", "50");
  assert.doesNotMatch(down.stdout, /RAISE/);
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

test("init on an existing wallet with no SATO_AGENT_HOME names no folder: there is no NAME to suggest a '-2' of (HOME is a temp folder; ~/.sato-agent is never touched)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "sato-agent-nohome-"));
  const { SATO_AGENT_HOME: _unset, ...rest } = env;
  const bare = { ...rest, HOME: fakeHome };
  const first = JSON.parse(execFileSync(process.execPath, [BIN, "init", "--json"], { env: bare, encoding: "utf8" }));
  const again = JSON.parse(execFileSync(process.execPath, [BIN, "init", "--json"], { env: bare, encoding: "utf8" }));
  assert.equal(again.existing, true);
  assert.equal(again.name, null);
  assert.equal(again.notice, `A wallet already exists here (address ${first.base}). If you are a new bot, do not use it: pick a new NAME, write a new launcher, and run init there. Never replace, move or delete another bot's wallet.`);
  assert.doesNotMatch(again.notice, /\.sato-agent|-2/);
  assert.ok(statSync(join(fakeHome, ".sato-agent", "wallet.json")).isFile());
});
