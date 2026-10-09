// A Solana send to an address that is not a wallet is a policy refusal (exit 3),
// decided before the owner is asked to approve anything. Live test 2026-10-09: it
// was a plain error (exit 1), and in ask mode it came only after the approval.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_AGENT_SOLANA_RPC: "http://127.0.0.1:9", SATO_AGENT_BASE_RPC: "http://127.0.0.1:9" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

// An associated token account address: off the ed25519 curve, so no RPC is needed to refuse it.
const TOKEN_ACCOUNT = "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo";

test("ask mode: a token-account recipient is refused (exit 3) before any approval code", () => {
  assert.equal(run("init").status, 0);
  assert.equal(run("policy", "set", "--chains", "solana", "--per-tx", "3", "--per-day", "25", "--approval", "ask").status, 0);
  for (const extra of [[], ["--dry-run"]]) {
    const r = run("send", "--chain", "solana", "--to", TOKEN_ACCOUNT, "--amount", "0.10", ...extra);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /REFUSED recipient_not_wallet/);
    assert.doesNotMatch(r.stdout + r.stderr, /--approve|approval code/i, "the owner is never asked");
  }
});

test("a chain the policy does not allow is refused first, without looking the recipient up", () => {
  assert.equal(run("policy", "set", "--chains", "base").status, 0);
  const r = run("send", "--chain", "solana", "--to", TOKEN_ACCOUNT, "--amount", "0.10");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /chain_not_allowed/);
  assert.doesNotMatch(r.stderr, /recipient_not_wallet/);
});
