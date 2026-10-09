import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { evaluate, loadPolicy, parseLimit, setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { entries, record, release, reserve, spentLast24h } = await import("../src/ledger.js");
const { paths } = await import("../src/store.js");

test("there are no default limits: nothing is allowed until they are set", () => {
  assert.equal(loadPolicy(), null);
  assert.equal(evaluate(null, { usd: 0.01, to: "0xabc" }, 0)[0].rule, "limits_not_set");
  assert.throws(() => setPolicy({ perTx: "5" }), /both --per-tx and --per-day/);
});

test("limits accept any plain amount or 'none', and nothing else", () => {
  assert.equal(parseLimit("none"), null);
  assert.equal(parseLimit("2500"), 2500);
  assert.equal(parseLimit("0.5"), 0.5);
  for (const bad of ["0", "-1", "lots", "0x10", "1e3", " 5", "5 ", "", "Infinity"]) assert.throws(() => parseLimit(bad), undefined, bad);
  assert.throws(() => parseLimit(true), /needs a value/, "a flag given with no value must not become $1");
});

test("'no limit' is the owner's choice", () => {
  const { policy } = setPolicy({ perTx: "none", perDay: "none" });
  assert.deepEqual(evaluate(policy, { usd: 50_000, to: "0xabc" }, 1_000_000), []);
});

test("per-transaction, per-24h and recipient limits each refuse with their rule", () => {
  const { policy: p } = setPolicy({ perTx: "10", perDay: "25", allowRecipients: ["0xAbC"] });
  assert.deepEqual(evaluate(p, { usd: 10, to: "0xabc" }, 15), []);
  assert.deepEqual(evaluate(p, { usd: 10.01, to: "0xabc" }, 0).map((r) => r.rule), ["max_usd_per_tx"]);
  assert.deepEqual(evaluate(p, { usd: 10, to: "0xabc" }, 15.5).map((r) => r.rule), ["max_usd_per_day"]);
  assert.deepEqual(evaluate(p, { usd: 1, to: "0xdef" }, 0).map((r) => r.rule), ["allow_recipients"]);
  const q = setPolicy({ perDay: "100" });
  assert.equal(q.policy.max_usd_per_tx, 10, "changing one limit keeps the other");
});

test("every limit change is logged, and a raise is flagged", () => {
  const lower = setPolicy({ perTx: "5" });
  assert.equal(lower.raised, false);
  const up = setPolicy({ perDay: "none" });
  assert.equal(up.raised, true);
  const removeAllowlist = setPolicy({ allowRecipients: null });
  assert.equal(removeAllowlist.raised, true);
  const changes = entries().filter((e) => e.kind === "policy");
  assert.ok(changes.length >= 5);
  assert.equal(changes.at(-1).status, "raised");
});

test("spend over a rolling 24 h: submitted counts, provably-unsent drops out, older does not count", () => {
  const before = spentLast24h().usd;
  const a = record({ status: "submitted", kind: "send", usd: 4 });
  record({ status: "submitted", kind: "x402", usd: 0.25 });
  const b = record({ status: "submitted", kind: "send", usd: 7 });
  release(b, "simulation failed");
  record({ id: a.id, status: "confirmed", tx: "0x1" });
  assert.equal(spentLast24h().usd - before, 4.25);
  assert.equal(spentLast24h(Date.now() + 25 * 3600 * 1000).usd, 0, "a day later it has rolled off");
});

test("reserve is atomic across processes: three concurrent $1 spends under a $1 limit, one wins", async () => {
  setPolicy({ perTx: "none", perDay: String(spentLast24h().usd + 1) });
  const worker = fileURLToPath(new URL("./reserve-worker.js", import.meta.url));
  const runs = await Promise.all(
    [0, 1, 2].map(
      () =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [worker], { env: { ...process.env, SATO_AGENT_HOME: home } });
          p.on("exit", (code) => resolve(code));
        }),
    ),
  );
  assert.deepEqual(runs.sort(), [0, 3, 3]);
});

test("an unreadable ledger line stops all spending (deleting the ledger must not be the fix)", async () => {
  appendFileSync(paths.ledger(), '{"truncated": \n');
  const p = loadPolicy();
  await assert.rejects(reserve(p, { kind: "send", usd: 0.01, to: "0xabc" }), (e) => e instanceof Refused && e.refusals[0].rule === "ledger_unreadable");
  assert.ok(spentLast24h().unreadable.length === 1);
});
