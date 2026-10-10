// Upgrading from v0.2 must not turn swaps on for an owner who had them off.
//
// v0.2's "off" deleted the two caps and left no marker, and v0.2 only turned swaps on by setting a slippage cap. So a policy
// with no `swaps_off` key and no slippage cap is one that never had swaps on: it stays OFF until `--swaps on`. A pre-v0.3
// policy with caps stays on. From v0.3 setPolicy always writes an explicit `swaps_off` boolean.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { evaluate, isLegacySwapsOff, loadPolicy, raisesBetween, setPolicy, swapsEnabled } = await import("../src/policy.js");

const file = join(home, "policy.json");
const base = { schema: "sato-agent.policy/v2", set_at: "2026-10-01T00:00:00Z", max_usd_per_tx: 100, max_usd_per_day: 300, allow_recipients: null, chains: ["base", "solana"], check_gate: "off", approval: "auto", on_check_unavailable: null };
const put = (p) => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(p, null, 2));
};
const swapRules = (p) => evaluate(p, { usd: 10, chain: "base", kind: "swap", slippage_bps: 50 }, { usd: 0, swaps: 0, unreadable: [] }).map((r) => r.rule);

test("a v0.2 policy that had swaps off (no key, no caps) reads as OFF, and stays off through any other change", () => {
  put({ ...base });
  const p = loadPolicy();
  assert.equal(isLegacySwapsOff(p), true);
  assert.equal(swapsEnabled(p), false);
  assert.deepEqual(swapRules(p), ["swaps_not_enabled"]);
  // changing something else does not switch swaps on, and the key is now written explicitly
  const changed = setPolicy({ perDay: "50" });
  assert.equal(changed.policy.swaps_off, true);
  assert.equal(swapsEnabled(loadPolicy()), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).swaps_off, true);
  assert.equal(changed.raised, false);
  // setting a cap alone does not turn them on either: only `--swaps on` does
  const capped = setPolicy({ swapSlippageBps: "100" });
  assert.equal(capped.policy.swaps_off, true);
  assert.deepEqual(swapRules(loadPolicy()), ["swaps_not_enabled"]);
  // `--swaps on` turns them on, and says it is a raise
  const on = setPolicy({ swaps: "on" });
  assert.equal(on.policy.swaps_off, false);
  assert.deepEqual(on.raises, ["swaps turned on"]);
  assert.deepEqual(swapRules(loadPolicy()), []);
});

test("a v0.2 policy that had swaps on (a slippage cap) stays on, and the key is written", () => {
  put({ ...base, max_slippage_bps: 100, max_trades_per_day: 5 });
  const p = loadPolicy();
  assert.equal(isLegacySwapsOff(p), false);
  assert.equal(swapsEnabled(p), true);
  assert.deepEqual(swapRules(p), []);
  const changed = setPolicy({ perDay: "50" });
  assert.equal(changed.policy.swaps_off, false, "an explicit boolean from now on");
  assert.equal(changed.policy.max_slippage_bps, 100);
  assert.equal(changed.raised, false);
  assert.equal(swapsEnabled(loadPolicy()), true);
  // turning them off now writes an explicit true
  assert.equal(setPolicy({ swaps: "off" }).policy.swaps_off, true);
  assert.equal(swapsEnabled(loadPolicy()), false);
});

test("a fresh v0.3 policy has swaps on, with the key written; off is explicit and survives other changes", () => {
  // a new home: no policy file and nothing recorded in a ledger
  const home2 = freshHome();
  assert.notEqual(home2, home);
  assert.equal(loadPolicy(), null);
  const first = setPolicy({ chains: "base", perTx: "100", perDay: "300" });
  assert.equal(first.first, true);
  assert.equal(first.policy.swaps_off, false, "the key is written, and swaps are on once the limits exist");
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(home2, "policy.json"), "utf8")), "swaps_off"), true);
  assert.equal(swapsEnabled(loadPolicy()), true);
  assert.deepEqual(swapRules(loadPolicy()), []);
  // off is explicit, and another change leaves it off
  assert.equal(setPolicy({ swaps: "off" }).policy.swaps_off, true);
  assert.equal(setPolicy({ perDay: "200" }).policy.swaps_off, true);
  assert.equal(swapsEnabled(loadPolicy()), false);
  assert.equal(setPolicy({ swaps: "on" }).policy.swaps_off, false);
});

test("raises: legacy-off to on is a raise; on to off is not", () => {
  const legacyOff = { ...base };
  const on = { ...base, swaps_off: false };
  assert.deepEqual(raisesBetween(legacyOff, on), ["swaps turned on"]);
  assert.deepEqual(raisesBetween(on, { ...base, swaps_off: true }), []);
  assert.deepEqual(raisesBetween({ ...base, swaps_off: true }, on), ["swaps turned on"]);
});
