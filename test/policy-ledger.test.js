import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { evaluate, loadPolicy, parseLimit, setPolicy } = await import("../src/policy.js");
const { record, spentOn } = await import("../src/ledger.js");

test("there are no default limits: nothing is allowed until the owner sets them", () => {
  assert.equal(loadPolicy(), null);
  const r = evaluate(null, { usd: 0.01, to: "0xabc" }, 0);
  assert.equal(r[0].rule, "limits_not_set");
  assert.throws(() => setPolicy({ perTx: "5" }), /both --per-tx and --per-day/);
});

test("any amount is the owner's choice, including no limit", () => {
  assert.equal(parseLimit("none"), null);
  assert.equal(parseLimit("2500"), 2500);
  assert.throws(() => parseLimit("0"), /positive/);
  assert.throws(() => parseLimit("-1"), /positive/);
  assert.throws(() => parseLimit("lots"), /positive/);
  const p = setPolicy({ perTx: "none", perDay: "none" });
  assert.equal(p.max_usd_per_tx, null);
  assert.deepEqual(evaluate(p, { usd: 50_000, to: "0xabc" }, 1_000_000), []);
});

test("per-transaction, per-day and recipient limits each refuse with their rule", () => {
  const p = setPolicy({ perTx: "10", perDay: "25", allowRecipients: ["0xAbC"] });
  assert.deepEqual(evaluate(p, { usd: 10, to: "0xabc" }, 15), []);
  assert.deepEqual(evaluate(p, { usd: 10.01, to: "0xabc" }, 0).map((r) => r.rule), ["max_usd_per_tx"]);
  assert.deepEqual(evaluate(p, { usd: 10, to: "0xabc" }, 15.5).map((r) => r.rule), ["max_usd_per_day"]);
  assert.deepEqual(evaluate(p, { usd: 1, to: "0xdef" }, 0).map((r) => r.rule), ["allow_recipients"]);
  // Changing one limit keeps the other.
  const q = setPolicy({ perDay: "100" });
  assert.equal(q.max_usd_per_tx, 10);
  assert.equal(q.max_usd_per_day, 100);
});

test("today's spend survives restarts, counts submitted spends and drops failed ones", () => {
  const a = record({ status: "submitted", kind: "send", usd: 4 });
  record({ status: "submitted", kind: "x402", usd: 0.25 });
  const b = record({ status: "submitted", kind: "send", usd: 7 });
  record({ id: b.id, status: "failed", reason: "reverted" });
  record({ id: a.id, status: "confirmed", tx: "0x1" });
  assert.equal(spentOn(), 4.25);
  // Yesterday's spends do not count today.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(spentOn(yesterday), 0);
});
