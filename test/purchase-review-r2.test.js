// Low findings from the second review of the purchase lane (2026-10-09), one test each.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";
import { CODE, bitrefillWorld } from "./bitrefill-world.js";

const home = freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const B = await import("../src/bitrefill.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./purchase-preload.js", import.meta.url));
const SETTINGS = fileURLToPath(new URL("../src/settings.js", import.meta.url));
initWallet();
setPolicy({ chains: "base", perTx: "50", perDay: "500", purchases: "auto" });
const fast = { sleep: async () => {}, pollMs: 0 };

// ---------------------------------------------------------------- L1

test("L1: a delivered code that cannot be saved is still returned, with the reason; nothing after the payment throws", async () => {
  rmSync(join(home, "giftcards"), { recursive: true, force: true });
  writeFileSync(join(home, "giftcards"), "not a directory"); // the code folder cannot be made
  const r = await B.buyGiftcard({ product: "amazon-us", value: "25" }, { ...fast, fetchImpl: bitrefillWorld().fetch });
  assert.equal(r.payment.signed, true);
  assert.equal(r.delivery.state, "delivered");
  assert.equal(r.codes_path, null);
  assert.ok(r.codes_save_error);
  assert.ok(!r.codes_save_error.includes(CODE), "the reason never holds the code");
  assert.deepEqual(r.delivery.codes.map((c) => c.code), [CODE]);
  rmSync(join(home, "giftcards"), { force: true });
  // An error while waiting for delivery (after the payment) is reported as "pending", never thrown.
  const boom = { pollMs: 0, sleep: async () => { throw new Error("clock broke"); } };
  const r2 = await B.buyGiftcard({ product: "amazon-us", value: "25" }, { ...boom, fetchImpl: bitrefillWorld({ delivered: 1e9 }).fetch });
  assert.equal(r2.payment.signed, true);
  assert.equal(r2.delivery.state, "pending");
  assert.match(r2.delivery.reason, /clock broke/);
});

const cli = (h, args, extra = {}, input) => spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: h, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_TEST_BITREFILL: "{}", ...extra }, encoding: "utf8", timeout: 60_000, input });

test("L1 (CLI): a code that cannot be saved is still printed as the last line, says so, and exits 4", () => {
  const h = join(home, "..", "l1-cli");
  cli(h, ["init"]);
  assert.equal(cli(h, ["policy", "set", "--chains", "base", "--per-tx", "50", "--per-day", "100", "--purchases", "auto"]).status, 0);
  writeFileSync(join(h, "giftcards"), "not a directory");
  const r = cli(h, ["giftcard", "buy", "amazon-us", "--value", "25"]);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stdout, /Delivered, but the code could NOT be saved/);
  assert.match(r.stdout, /do not buy again/);
  assert.match(r.stdout.trim().split("\n").at(-1), new RegExp(`^GIFT CARD CODE .*code ${CODE}`));
  assert.ok(!r.stderr.includes(CODE));
});

// ---------------------------------------------------------------- L2

test("L2: processes creating the local HMAC key at the same moment all end up with one complete key", async () => {
  const h = join(home, "..", "l2-race");
  mkdirSync(h, { recursive: true, mode: 0o700 });
  const one = () =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", `const { localHmac } = await import(${JSON.stringify(SETTINGS)}); process.stdout.write(localHmac("+15551234567"));`], { env: { ...process.env, SATO_AGENT_HOME: h } });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  const results = await Promise.all(Array.from({ length: 8 }, one));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(new Set(results.map((r) => r.out)).size, 1, "every process used the same key");
  assert.match(readFileSync(join(h, "local-hmac.key"), "utf8"), /^[0-9a-f]{64}\n$/);
});

// ---------------------------------------------------------------- L3

test("L3: settings set --ship-clear cannot be combined with --stdin or a --ship-* flag (exit 2)", () => {
  const h = join(home, "..", "l3");
  assert.equal(cli(h, ["settings", "set", "--ship-clear", "--stdin"], {}, "{}").status, 2);
  assert.equal(cli(h, ["settings", "set", "--ship-clear", "--ship-name", "X"]).status, 2);
  assert.equal(cli(h, ["settings", "set", "--ship-clear"]).status, 0);
});

// ---------------------------------------------------------------- L4

test("L4: the README claims only what the kit does about not buying a card twice", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.doesNotMatch(readme, /never bought twice/);
  assert.match(readme, /exits 4 and says "paid, not delivered yet — do not buy again", so a bot that follows exit codes does not buy it again/);
});
