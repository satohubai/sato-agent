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
  for (const bad of ["0", "-1", "lots", "0x10", "1e3", " 5", "5 ", "", "Infinity", "0.0099996", "1.", ".5"]) assert.throws(() => parseLimit(bad), undefined, bad);
  assert.equal(parseLimit("0.000001"), 0.000001, "six decimals is USDC's precision");
  assert.throws(() => parseLimit(true), /needs a value/, "a flag given with no value must not become $1");
});

test("'no limit' is the owner's choice", () => {
  assert.throws(() => setPolicy({ perTx: "none", perDay: "none" }), /--chains/, "chains are the owner's choice too: no default");
  const { policy } = setPolicy({ chains: "base,solana", perTx: "none", perDay: "none" });
  assert.deepEqual(evaluate(policy, { usd: 50_000, to: "0xabc" }, 1_000_000), []);
});

test("per-transaction, per-24h and recipient limits each refuse with their rule", () => {
  const A = "0x000000000000000000000000000000000000aBc1";
  const { policy: p } = setPolicy({ perTx: "10", perDay: "25", allowRecipients: [A] });
  assert.deepEqual(evaluate(p, { usd: 10, to: A.toLowerCase() }, 15), []);
  assert.deepEqual(evaluate(p, { usd: 10.01, to: A }, 0).map((r) => r.rule), ["max_usd_per_tx"]);
  assert.deepEqual(evaluate(p, { usd: 10, to: A }, 15.5).map((r) => r.rule), ["max_usd_per_day"]);
  assert.deepEqual(evaluate(p, { usd: 1, to: "0x000000000000000000000000000000000000dEaD" }, 0).map((r) => r.rule), ["allow_recipients"]);
  assert.throws(() => setPolicy({ allowRecipients: ["0xAbC"] }), /not a Base or Solana address/);
  const q = setPolicy({ perDay: "100" });
  assert.equal(q.policy.max_usd_per_tx, 10, "changing one limit keeps the other");
});

test("sub-cent spends add up exactly: the spend that reaches the daily limit is allowed, one more is refused", () => {
  const { policy: p } = setPolicy({ perTx: "none", perDay: "0.01" });
  const nine = [...Array(9)].reduce((s) => s + 0.001, 0); // 0.009000000000000001 in floats
  assert.deepEqual(evaluate(p, { usd: 0.001 }, nine), [], "the 10th $0.001 reaches $0.01 exactly");
  assert.deepEqual(evaluate(p, { usd: 0.001 }, 0.01).map((r) => r.rule), ["max_usd_per_day"]);
  // A hand-edited limit with more decimals rounds down, never up.
  assert.deepEqual(evaluate({ ...p, max_usd_per_day: 0.0099996 }, { usd: 0.01 }, 0).map((r) => r.rule), ["max_usd_per_day"]);
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
  setPolicy({ perTx: "none", perDay: (spentLast24h().usd + 1).toFixed(6) });
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

test("a stale lock from a dead process is cleared; a live process's lock is never taken", async () => {
  const { writeFileSync, utimesSync, existsSync } = await import("node:fs");
  const { withLock } = await import("../src/store.js");
  const old = new Date(Date.now() - 10 * 60_000);
  // Dead PID, old: cleared, and the work runs.
  writeFileSync(paths.lock("t1"), "999999 2026-01-01T00:00:00Z\n");
  utimesSync(paths.lock("t1"), old, old);
  assert.equal(await withLock(async () => "ran", { name: "t1", waitMs: 2000 }), "ran");
  assert.equal(existsSync(paths.lock("t1")), false);
  // Our own (live) PID, old: never cleared, so the caller times out instead.
  writeFileSync(paths.lock("t2"), `${process.pid} 2026-01-01T00:00:00Z\n`);
  utimesSync(paths.lock("t2"), old, old);
  await assert.rejects(withLock(async () => "ran", { name: "t2", waitMs: 400 }), /in progress/);
  assert.equal(existsSync(paths.lock("t2")), true);
});

test("an unreadable ledger line stops all spending (deleting the ledger must not be the fix)", async () => {
  appendFileSync(paths.ledger(), '{"truncated": \n');
  const p = loadPolicy();
  await assert.rejects(reserve(p, { kind: "send", usd: 0.01, to: "0xabc" }), (e) => e instanceof Refused && e.refusals[0].rule === "ledger_unreadable");
  assert.ok(spentLast24h().unreadable.length === 1);
});
