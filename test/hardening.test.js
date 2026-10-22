// v0.6.0 wallet hardening, offline: raises wait 24 hours (queued, shown, cancellable; tightening is instant), the ledger is
// hash-chained and sealed with the policy and the wallet (anything missing, cut short, reordered or edited freezes spending until
// `repair`, which never gives the 24-hour total back), backup and restore, and the approval wait. Nothing reaches a chain.

import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./approval-preload.js", import.meta.url));
freshHome();
const { setPolicy, loadPolicy, cancelPending, evaluate, RAISE_DELAY_MS, PARTS } = await import("../src/policy.js");
const { initWallet, restoreWallet, backupKeys, parseBackup, addresses } = await import("../src/wallet.js");
const { record, reserve, spentLast24h, entries } = await import("../src/ledger.js");
const I = await import("../src/integrity.js");
const { Refused } = await import("../src/errors.js");
const { paths } = await import("../src/store.js");
const { requestApproval, consumeApproval, approvalTiming, APPROVAL_MIN_WAIT_MS } = await import("../src/approvals.js");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 24 * 60 * 60 * 1000;
const rules = (list) => list.map((r) => r.rule);
const frozenRules = () => rules(I.inspect().problems);
/** A new agent folder with a wallet and limits, as after setup. */
function agent(limits = { chains: "base,solana", perTx: "5", perDay: "20" }) {
  const home = freshHome();
  initWallet();
  setPolicy(limits);
  return home;
}
const file = (name) => join(process.env.SATO_AGENT_HOME, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const write = (name, text) => fs.writeFileSync(file(name), text);
const spend = async (usd = 1) => reserve(loadPolicy(), { kind: "send", chain: "base", usd, to: DEAD });
const cli = (args, { home = process.env.SATO_AGENT_HOME, input, env = {} } = {}) =>
  spawnSync(process.execPath, ["--import", PRELOAD, BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/x", SATO_AGENT_BASE_RPC: "http://127.0.0.1:9", SATO_AGENT_SOLANA_RPC: "http://127.0.0.1:9", ...env }, input, encoding: "utf8" });

// ------------------------------------------------------------------ time-lock

test("the raise delay is 24 hours, and there is no way to skip it from the command line", () => {
  assert.equal(RAISE_DELAY_MS, DAY);
  const help = cli(["help"]).stdout;
  assert.doesNotMatch(help, /--now|--skip-delay|--force/);
  assert.match(help, /A raise \(anything that lets the agent do more\) takes effect 24 hours later/);
});

test("a raise is queued, not applied: the old limit holds until the time, then the new one does", () => {
  agent();
  const t0 = Date.now();
  const r = setPolicy({ perDay: "100" });
  assert.equal(r.raised, true);
  assert.deepEqual(r.raises, ["max_usd_per_day"]);
  assert.equal(r.queued.length, 1);
  assert.equal(r.queued[0].part, "per_day");
  assert.equal(r.queued[0].change, "per 24 hours: $20 → $100");
  assert.ok(Math.abs(Date.parse(r.queued[0].effective_at) - (t0 + DAY)) < 5000);
  assert.equal(r.policy.max_usd_per_day, 20, "in force now: the old limit");
  assert.equal(loadPolicy().max_usd_per_day, 20);
  assert.equal(loadPolicy({ now: Date.parse(r.queued[0].effective_at) - 1 }).max_usd_per_day, 20);
  const later = loadPolicy({ now: Date.parse(r.queued[0].effective_at) });
  assert.equal(later.max_usd_per_day, 100);
  assert.equal(later.pending, undefined);
  // The ledger keeps the raise log, with when it takes effect.
  const row = entries().filter((e) => e.kind === "policy").at(-1);
  assert.equal(row.status, "raised");
  assert.deepEqual(row.raises, ["max_usd_per_day"]);
  assert.equal(row.queued[0].effective_at, r.queued[0].effective_at);
  // evaluate (and so every spend) uses the policy in force
  assert.deepEqual(rules(evaluate(loadPolicy(), { usd: 4, chain: "base" }, 18)), ["max_usd_per_day"]);
});

test("every kind of loosening waits; each is its own part", () => {
  agent({ chains: "base", perTx: "5", perDay: "20", allowRecipients: [DEAD], checkGate: "caution", onCheckUnavailable: "refuse", approval: "ask", swapSlippageBps: "100", maxTradesPerDay: "3" });
  setPolicy({ swaps: "off", bridges: "off" });
  const cases = [
    [{ perTx: "none" }, "per_tx"],
    [{ perDay: "none" }, "per_day"],
    [{ chains: "base,solana" }, "chains"],
    [{ allowRecipients: [DEAD, "0x1111111111111111111111111111111111111111"] }, "recipients"],
    [{ allowRecipients: null }, "recipients"],
    [{ checkGate: "no" }, "check_gate"],
    [{ checkGate: "off" }, "check_gate"],
    [{ onCheckUnavailable: "allow" }, "check_gate"],
    [{ approval: "auto" }, "approval"],
    [{ purchases: "auto", approval: "auto" }, "purchases"], // with approval at ask, purchases ask anyway: not a raise on its own
    [{ swaps: "on" }, "swaps"],
    [{ bridges: "on" }, "bridges"],
  ];
  for (const [opts, part] of cases) {
    const r = setPolicy(opts);
    assert.ok(r.queued.some((q) => q.part === part), `${JSON.stringify(opts)} queues ${part}`);
    cancelPending();
  }
  // slippage and trade caps (with swaps on)
  setPolicy({ swaps: "on" }, { now: Date.now() - DAY - 1000 }); // a day ago: in force
  for (const [opts, part] of [[{ swapSlippageBps: "200" }, "slippage"], [{ swapSlippageBps: "none" }, "slippage"], [{ maxTradesPerDay: "none" }, "trades"]]) {
    assert.ok(setPolicy(opts).queued.some((q) => q.part === part), part);
    cancelPending();
  }
  assert.equal(PARTS.length, 11);
});

test("tightening is instant, and drops a raise queued for the same part; a mixed change splits", () => {
  agent();
  setPolicy({ perDay: "100" });
  const down = setPolicy({ perDay: "10" });
  assert.equal(down.raised, false);
  assert.deepEqual(down.queued, []);
  assert.equal(loadPolicy().max_usd_per_day, 10);
  assert.equal(loadPolicy().pending, undefined, "the owner's latest word on the part wins");
  // one command that tightens one part and loosens another
  const mixed = setPolicy({ perTx: "2", perDay: "50", chains: "base" });
  assert.deepEqual(mixed.queued.map((q) => q.part), ["per_day"]);
  const now = loadPolicy();
  assert.equal(now.max_usd_per_tx, 2, "tightened at once");
  assert.deepEqual(now.chains, ["base"], "a chain removed at once");
  assert.equal(now.max_usd_per_day, 10, "the raise waits");
  // a list: the removal is instant, the addition waits
  const swap = setPolicy({ chains: "solana" });
  assert.deepEqual(swap.queued.map((q) => q.part), ["chains"]);
  assert.deepEqual(loadPolicy().chains, [], "base is removed now; solana arrives in 24 hours");
  assert.deepEqual(rules(evaluate(loadPolicy(), { usd: 1, chain: "base" }, 0)), ["chain_not_allowed"]);
});

test("asking again for the same raise keeps its clock; another value restarts it; untouched parts keep theirs", () => {
  agent();
  const t1 = Date.now();
  const a = setPolicy({ perDay: "100" }, { now: t1 });
  const b = setPolicy({ perDay: "100", perTx: "3" }, { now: t1 + 60_000 });
  assert.equal(b.queued[0]?.effective_at ?? loadPolicy({ now: t1 + 60_000 }).pending.per_day.effective_at, a.queued[0].effective_at);
  setPolicy({ chains: "base,solana,bnb" }, { now: t1 + 120_000 });
  assert.equal(loadPolicy({ now: t1 + 120_000 }).pending.per_day.effective_at, a.queued[0].effective_at, "a raise on another part leaves this one's clock");
  const c = setPolicy({ perDay: "150" }, { now: t1 + 180_000 });
  assert.equal(c.queued.find((q) => q.part === "per_day").effective_at, new Date(t1 + 180_000 + DAY).toISOString());
});

test("policy cancel drops every waiting raise and is logged; a raise already in force stays", () => {
  agent();
  setPolicy({ perTx: "50" }, { now: Date.now() - DAY - 1000 }); // queued a day ago: in force
  setPolicy({ perDay: "100", chains: "base,solana,bnb" });
  const c = cancelPending();
  assert.deepEqual(c.cancelled.map((q) => q.part).sort(), ["chains", "per_day"]);
  const p = loadPolicy();
  assert.equal(p.pending, undefined);
  assert.equal(p.max_usd_per_tx, 50);
  assert.equal(p.max_usd_per_day, 20);
  assert.equal(entries().filter((e) => e.kind === "policy").at(-1).status, "cancelled");
  assert.deepEqual(cancelPending().cancelled, [], "nothing left to cancel");
});

test("turning a check gate on from off is never a raise, whatever it does when the check can't run", () => {
  agent();
  const r = setPolicy({ checkGate: "no", onCheckUnavailable: "allow" });
  assert.equal(r.raised, false);
  assert.deepEqual(r.queued, []);
  assert.equal(loadPolicy().check_gate, "no");
});

test("the first policy takes effect at once (there is nothing to raise from)", () => {
  freshHome();
  initWallet();
  const r = setPolicy({ chains: "base", perTx: "none", perDay: "none" });
  assert.equal(r.first, true);
  assert.deepEqual(r.queued, []);
  assert.equal(loadPolicy().max_usd_per_tx, null);
});

test("CLI: a queued raise is announced in words for the owner, shown in status, policy show and before a spend, and policy cancel cancels it", () => {
  agent();
  const set = cli(["policy", "set", "--per-day", "100"]);
  assert.equal(set.status, 0);
  assert.match(set.stdout, /⚠ RAISE QUEUED, not in effect yet \(max_usd_per_day\)/);
  assert.match(set.stdout, /Tell the owner now, in these words: "A change that lets me do more was requested: per 24 hours: \$20 → \$100 \(takes effect /);
  assert.match(set.stdout, /say 'cancel the raise' and I will run policy cancel/);
  assert.match(set.stdout, /per 24 hours: {4}\$20/, "the limit in force is the old one");
  const j = JSON.parse(cli(["policy", "set", "--per-tx", "50", "--json"]).stdout);
  assert.match(j.announce, /per transaction: \$5 → \$50/);
  assert.equal(j.queued[0].part, "per_tx");
  assert.match(cli(["status"]).stdout, /⚠ RAISE PENDING: per 24 hours: \$20 → \$100\. It takes effect at .* \(in 2[34] h \d+ min\)/);
  assert.equal(JSON.parse(cli(["status", "--json"]).stdout).pending.length, 2);
  assert.match(cli(["policy", "show"]).stdout, /RAISE PENDING: per transaction: \$5 → \$50/);
  const sendOut = cli(["send", "--chain", "base", "--to", DEAD, "--amount", "1", "--dry-run"]).stdout;
  assert.match(sendOut, /RAISE PENDING/, "shown before a spend too");
  const c = cli(["policy", "cancel"]);
  assert.match(c.stdout, /Cancelled 2 pending raises/);
  assert.doesNotMatch(cli(["status"]).stdout, /RAISE PENDING/);
  assert.match(cli(["policy", "cancel"]).stdout, /No raise is pending/);
});

// ------------------------------------------------------------------ the seal

test("a new folder is sealed from its first line: wallet, policy digest, ledger head", () => {
  agent();
  const seal = JSON.parse(read("integrity.json"));
  assert.equal(seal.schema, "sato-agent.integrity/v1");
  assert.deepEqual(seal.wallet, { evm: addresses().base, solana: addresses().solana });
  assert.equal(seal.policy_sha256, I.sha256(read("policy.json")));
  const L = I.ledgerLines();
  assert.equal(seal.ledger.lines, L.raw.length);
  assert.equal(seal.ledger.head, I.sha256(L.raw.at(-1)));
  assert.equal(L.rows[0].prev, I.ZERO_HASH);
  for (let i = 1; i < L.raw.length; i++) assert.equal(L.rows[i].prev, I.sha256(L.raw[i - 1]));
  assert.deepEqual(frozenRules(), []);
  assert.ok(entries().every((r) => !Object.hasOwn(r, "prev")), "the chain field stays out of every other reader");
});

const tamperings = {
  "the ledger deleted": () => fs.rmSync(file("ledger.jsonl")),
  "the ledger emptied": () => write("ledger.jsonl", ""),
  "the ledger cut short (last line removed)": () => write("ledger.jsonl", read("ledger.jsonl").split("\n").slice(0, -2).join("\n") + "\n"),
  "the ledger cut short (half a line)": () => write("ledger.jsonl", read("ledger.jsonl").slice(0, -20)),
  "a middle line edited": () => write("ledger.jsonl", read("ledger.jsonl").replace('"usd":1', '"usd":0.01')),
  "two lines swapped": () => {
    const l = read("ledger.jsonl").split("\n");
    [l[1], l[2]] = [l[2], l[1]];
    write("ledger.jsonl", l.join("\n"));
  },
  "a line added by hand": () => fs.appendFileSync(file("ledger.jsonl"), JSON.stringify({ id: "x", ts: new Date().toISOString(), status: "failed" }) + "\n"),
  "a line added with a correct prev but no seal": () => {
    const L = I.ledgerLines();
    fs.appendFileSync(file("ledger.jsonl"), JSON.stringify({ id: "x", status: "failed", prev: I.sha256(L.raw.at(-1)) }) + "\n");
  },
  "a blank line inserted": () => write("ledger.jsonl", read("ledger.jsonl").replace("\n", "\n\n")),
  "the seal deleted": () => fs.rmSync(file("integrity.json")),
  "the seal unreadable": () => write("integrity.json", "{nope"),
  "the ledger and the seal deleted": () => ["ledger.jsonl", "integrity.json"].forEach((f) => fs.rmSync(file(f))),
  "the ledger, the seal and policy.json deleted": () => ["ledger.jsonl", "integrity.json", "policy.json"].forEach((f) => fs.rmSync(file(f))),
};

for (const [what, tamper] of Object.entries(tamperings)) {
  test(`${what}: every spend is refused (ledger_tampered), nothing is reserved`, async () => {
    agent();
    await spend(1);
    await spend(2);
    tamper();
    assert.ok(frozenRules().includes("ledger_tampered"), frozenRules().join(","));
    const before = I.ledgerLines().raw.length;
    await assert.rejects(spend(1), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "ledger_tampered"));
    assert.equal(I.ledgerLines().raw.length, before, "nothing reserved");
    const msg = I.inspect().problems.find((p) => p.rule === "ledger_tampered").message;
    assert.match(msg, /Grok Reset/, "a reset is named as a possible cause");
    assert.match(msg, /Only the owner can ask for `sato-agent repair`/);
    // A frozen ledger stays frozen: kit writes do not move the seal past it.
    record({ kind: "check", status: "skipped" });
    assert.ok(frozenRules().includes("ledger_tampered"));
  });
}

test("policy.json edited by hand, deleted, or added: policy_tampered; limits do not change while frozen", async () => {
  agent();
  write("policy.json", read("policy.json").replace('"max_usd_per_day": 20', '"max_usd_per_day": null'));
  assert.deepEqual(frozenRules(), ["policy_tampered"]);
  assert.match(I.inspect().problems[0].message, /was changed outside the kit/);
  await assert.rejects(spend(1), (e) => e.refusals?.[0]?.rule === "policy_tampered");
  assert.throws(() => setPolicy({ perDay: "5" }), (e) => e instanceof Refused && e.refusals[0].rule === "policy_tampered");
  assert.throws(() => cancelPending(), Refused);
  fs.rmSync(file("policy.json"));
  assert.match(I.inspect().problems[0].message, /is missing/);
  assert.throws(() => loadPolicy(), (e) => e instanceof Refused && e.refusals[0].rule === "policy_tampered", "a spend never reads an unsealed policy");
  assert.deepEqual(rules(evaluate(loadPolicy({ unverified: true }), { usd: 1, chain: "base" }, spentLast24h())), ["policy_tampered"], "frozen, not 'limits not set'");
});

test("a different wallet file: wallet_tampered (it is never accepted); a missing one: wallet_missing", async () => {
  const home = agent();
  const mine = read("wallet.json");
  const other = freshHome();
  initWallet();
  const theirs = fs.readFileSync(join(other, "wallet.json"), "utf8");
  process.env.SATO_AGENT_HOME = home;
  write("wallet.json", theirs);
  assert.deepEqual(frozenRules(), ["wallet_tampered"]);
  assert.match(I.inspect().problems[0].message, /never ask anyone to fund the other address/);
  await assert.rejects(spend(1), (e) => e.refusals?.[0]?.rule === "wallet_tampered");
  assert.throws(() => I.repair(), /never accepts a different wallet/);
  assert.equal(cli(["backup", "--reveal"]).status, 3, "a wallet that is not this folder's is never shown as its backup");
  fs.rmSync(file("wallet.json"));
  assert.deepEqual(frozenRules(), ["wallet_missing"]);
  assert.throws(() => I.repair(), /wallet file is missing/);
  assert.throws(() => initWallet(), /never gets a new one/);
  write("wallet.json", mine);
  assert.deepEqual(frozenRules(), []);
});

// ------------------------------------------------------------------ repair

test("repair after a hand-edited policy: the recorded limits come back, the edit is kept aside, spending works at once", async () => {
  agent();
  await spend(3);
  write("policy.json", read("policy.json").replace('"max_usd_per_tx": 5', '"max_usd_per_tx": 5000'));
  const r = I.repair();
  assert.equal(r.repaired, true);
  assert.equal(r.paused_until, null, "the ledger still matches: no pause");
  assert.ok(fs.readdirSync(process.env.SATO_AGENT_HOME).some((f) => f.startsWith("policy.json.tampered-")));
  assert.equal(loadPolicy().max_usd_per_tx, 5);
  assert.deepEqual(frozenRules(), []);
  assert.equal(spentLast24h().usd, 3, "the 24-hour total is untouched");
  await spend(1);
  assert.equal(I.repair().repaired, false, "nothing left to repair");
});

test("repair after a broken ledger: every line kept and pinned, spending paused 24 hours, never a reset of the total", async () => {
  agent();
  await spend(4);
  const kept = read("ledger.jsonl").split("\n").slice(0, -2).join("\n") + "\n"; // the last spend line removed
  write("ledger.jsonl", kept);
  const t = Date.now();
  const r = I.repair({ now: t });
  assert.equal(r.repaired, true);
  assert.equal(r.paused_until, new Date(t + DAY).toISOString());
  assert.ok(read("ledger.jsonl").startsWith(kept), "nothing before the repair is deleted or rewritten");
  assert.deepEqual(frozenRules(), [], "sealed again");
  const s = I.inspect();
  assert.equal(s.paused, true);
  await assert.rejects(spend(0.01), (e) => e.refusals?.[0]?.rule === "spending_paused");
  assert.match(I.integrityRefusals()[0].message, /paused until/);
  assert.equal(I.inspect({ now: t + DAY }).paused, false, "and over after 24 hours");
  // the lines before the repair are pinned: editing them now freezes again
  write("ledger.jsonl", read("ledger.jsonl").replace('"kind":"wallet"', '"kind":"wallat"'));
  assert.ok(frozenRules().includes("ledger_tampered"));
});

test("repair with a broken ledger AND a changed policy: the limits are removed (set them again), and a raise still waits", () => {
  agent();
  write("ledger.jsonl", "");
  write("policy.json", read("policy.json").replace('"max_usd_per_day": 20', '"max_usd_per_day": 9999'));
  const r = I.repair();
  assert.ok(r.actions.some((a) => /removed the limits/.test(a)));
  assert.equal(loadPolicy(), null);
  assert.deepEqual(frozenRules(), []);
  // nothing recorded is trusted after the repair, and the folder has a history: setting them again waits like a raise
  const again = setPolicy({ chains: "base", perTx: "5", perDay: "20" });
  assert.equal(again.first, false);
  assert.ok(again.queued.some((q) => q.part === "per_tx") && again.queued.some((q) => q.part === "chains"));
  assert.deepEqual(loadPolicy().chains, [], "nothing is allowed until the wait is over");
  assert.ok(I.inspect().paused, "and spending stays paused");
});

test("a wallet, and no ledger or seal next to it, is frozen (never a fresh install); repair then pauses", () => {
  freshHome();
  initWallet();
  ["ledger.jsonl", "integrity.json"].forEach((f) => fs.rmSync(file(f)));
  assert.deepEqual(frozenRules(), ["ledger_tampered"]);
  assert.match(I.inspect().problems[0].message, /the seal file \(integrity\.json\) is missing/, "its wallet file says it was sealed: never a pre-chain folder");
  assert.throws(() => setPolicy({ chains: "base", perTx: "none", perDay: "none" }), Refused, "no limits can be set on it either");
  const r = I.repair();
  assert.ok(r.paused_until);
  assert.deepEqual(frozenRules(), []);
});

test("a forged repair line appended without moving the seal does not unfreeze", () => {
  agent();
  write("ledger.jsonl", read("ledger.jsonl").replace('"kind":"wallet"', '"kind":"x"'));
  const L = I.ledgerLines();
  const forged = { id: "f", ts: new Date().toISOString(), kind: "integrity", status: "repaired", prefix_sha256: I.sha256(L.text), prev: I.sha256(L.raw.at(-1)) };
  fs.appendFileSync(file("ledger.jsonl"), JSON.stringify(forged) + "\n");
  assert.ok(frozenRules().includes("ledger_tampered"));
});

test("CLI: frozen → status says so; policy set is refused (exit 3); repair (exit 0) tells the owner what it found and did", () => {
  agent();
  fs.rmSync(file("ledger.jsonl"));
  const st = cli(["status"]).stdout;
  assert.match(st, /⛔ FROZEN \(ledger_tampered\)/);
  assert.match(st, /^wallet: +0x[0-9a-fA-F]{40} \(Base, BNB Chain, Arbitrum, Polygon\) · Solana /m);
  assert.equal(cli(["policy", "set", "--per-day", "1"]).status, 3);
  assert.equal(cli(["register", "--name", "a", "--description", "b"]).status, 3, "register signs with the key: frozen too");
  const r = cli(["repair"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /What was wrong:\n {2}ledger_tampered/);
  assert.match(r.stdout, /paused spending until /);
  assert.match(r.stdout, /Tell the owner what was wrong and what repair did/);
  assert.match(cli(["status"]).stdout, /⏸ spending paused until/);
  assert.equal(cli(["send", "--chain", "base", "--to", DEAD, "--amount", "1", "--dry-run"]).status, 3);
  assert.match(cli(["repair"]).stdout, /Nothing to repair/);
});

// ------------------------------------------------------------------ upgrading a pre-chain folder

/** A folder as v0.5.4 left it: wallet.json, policy.json and a ledger with no chain, no seal. */
function legacyFolder({ edit } = {}) {
  const home = freshHome();
  initWallet();
  setPolicy({ chains: "base", perTx: "5", perDay: "20" });
  const keep = { wallet: read("wallet.json"), policy: read("policy.json") };
  const rows = entries();
  const legacy = rows.filter((r) => r.kind !== "wallet").map((r) => JSON.stringify(r)).join("\n") + "\n";
  for (const f of fs.readdirSync(home)) fs.rmSync(join(home, f), { recursive: true, force: true });
  write("wallet.json", JSON.stringify({ ...JSON.parse(keep.wallet), version: 1 }, null, 2) + "\n"); // as v0.5.4 wrote it
  write("policy.json", edit ? edit(keep.policy) : keep.policy);
  write("ledger.jsonl", legacy + JSON.stringify({ id: "s1", ts: new Date().toISOString(), kind: "send", status: "submitted", chain: "base", usd: 7, to: DEAD }) + "\n");
  return home;
}

test("upgrade: a pre-chain ledger is sealed as it is on the first read, its 24-hour total kept, its old lines pinned, and spending paused once for 24 hours", async () => {
  legacyFolder();
  assert.deepEqual(frozenRules(), [], "an upgraded folder is not frozen");
  assert.equal(spentLast24h().usd, 7);
  // never free: nothing tells a real pre-chain ledger from one rewritten by hand, so the upgrade pauses spending once
  assert.ok(I.inspect().paused);
  await assert.rejects(spend(1), (e) => e.refusals?.[0]?.rule === "spending_paused");
  assert.match(I.integrityRefusals()[0].message, /the upgrade that sealed this folder/);
  record({ kind: "check", status: "skipped" });
  const L = I.ledgerLines();
  const start = L.rows.findIndex((r) => r.kind === "integrity" && r.status === "started");
  assert.ok(start > 0);
  assert.equal(L.rows[start].prev, I.sha256(L.raw.slice(0, start).map((l) => l + "\n").join("")));
  assert.equal(JSON.parse(read("integrity.json")).wallet.evm, addresses().base);
  assert.equal(spentLast24h().usd, 7);
  write("ledger.jsonl", read("ledger.jsonl").replace('"usd":7', '"usd":0'));
  assert.ok(frozenRules().includes("ledger_tampered"), "an old line edited after the upgrade");
});

test("upgrade: a policy.json hand-edited before the upgrade to allow more than recorded is frozen; a stricter edit is accepted", () => {
  legacyFolder({ edit: (t) => t.replace('"max_usd_per_day": 20', '"max_usd_per_day": null') });
  assert.deepEqual(frozenRules(), ["policy_tampered"]);
  const r = I.repair();
  assert.equal(r.paused_until, null, "the repair itself adds no pause (the upgrade's own pause applies)");
  assert.equal(loadPolicy().pending.per_day.values.max_usd_per_day, 20, "the recorded limit comes back, queued for the end of the upgrade's pause");
  legacyFolder({ edit: (t) => t.replace('"max_usd_per_day": 20', '"max_usd_per_day": 2') });
  assert.deepEqual(frozenRules(), []);
});

test("upgrade: a legacy ledger with the chain stripped by hand (an integrity line left in) is not taken for a pre-chain one", () => {
  agent();
  write("ledger.jsonl", read("ledger.jsonl").replace(/,"prev":"[0-9a-f]{64}"/g, ""));
  fs.rmSync(file("integrity.json"));
  record({ kind: "integrity", status: "started" }); // as if an upgrade had run once
  write("ledger.jsonl", read("ledger.jsonl").replace(/,"prev":"[0-9a-f]{64}"/g, ""));
  assert.ok(frozenRules().includes("ledger_tampered"));
});

// ------------------------------------------------------------------ backup and restore

test("CLI backup: without --reveal no key is printed and nothing is logged; with it, the keys match the wallet and the showing is logged", () => {
  agent();
  const w = JSON.parse(read("wallet.json"));
  const plain = cli(["backup"]);
  assert.equal(plain.status, 0);
  assert.doesNotMatch(plain.stdout, new RegExp(w.evm.private_key.slice(2)));
  assert.match(plain.stdout, /backup --reveal/);
  assert.equal(entries().filter((e) => e.status === "backup_shown").length, 0);
  const shown = cli(["backup", "--reveal"]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, new RegExp(`EVM private key: ${w.evm.private_key}`));
  assert.match(shown.stdout, /They are now in this chat's history too/);
  assert.match(shown.stdout, /Save them outside Grok|save them outside Grok/);
  const k = backupKeys();
  assert.match(shown.stdout, new RegExp(`Solana private key \\(base58\\): ${k.solana_private_key}`));
  const rows = entries().filter((e) => e.status === "backup_shown");
  assert.equal(rows.length, 1);
  assert.doesNotMatch(read("ledger.jsonl"), new RegExp(w.evm.private_key.slice(2)), "the ledger never holds a key");
  assert.doesNotMatch(read("ledger.jsonl"), new RegExp(k.solana_private_key));
  assert.match(cli(["status"]).stdout, /backup: +shown 1 time, last /);
});

test("restore into a new folder: the same addresses come back, spending is paused 24 hours (the past is unknown), and it is logged", async () => {
  const home = agent();
  const text = cli(["backup", "--reveal"], { home }).stdout;
  const before = addresses();
  fs.rmSync(home, { recursive: true }); // a Grok Reset wiped the folder
  const r = cli(["restore"], { home, input: text });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Restored this agent's wallet/);
  assert.match(r.stdout, /Spending is paused until/);
  assert.doesNotMatch(r.stdout + r.stderr, /private key|0x[0-9a-f]{64}/i, "restore never prints a key");
  process.env.SATO_AGENT_HOME = home;
  assert.deepEqual(addresses(), before);
  assert.equal(entries().find((e) => e.kind === "wallet").status, "restored");
  assert.ok(I.inspect().paused);
  setPolicy({ chains: "base", perTx: "none", perDay: "none" });
  await assert.rejects(spend(1), (e) => e.refusals?.[0]?.rule === "spending_paused", "a first policy right after a restore cannot spend either");
  assert.match(cli(["status"]).stdout, /restored from a backup/);
});

test("restore puts back this folder's own wallet file with no pause; a different wallet is never taken", () => {
  const home = agent();
  const text = cli(["backup", "--reveal"]).stdout;
  const other = freshHome();
  initWallet();
  const otherText = cli(["backup", "--reveal"], { home: other }).stdout;
  process.env.SATO_AGENT_HOME = home;
  assert.match(cli(["restore"], { input: text }).stdout, /already here/);
  assert.match(cli(["restore"], { input: otherText }).stderr, /already holds a different wallet/);
  fs.rmSync(file("wallet.json"));
  assert.match(cli(["restore"], { input: otherText }).stderr, /belonged to another wallet/);
  const back = cli(["init", "--import"], { input: text });
  assert.equal(back.status, 0, back.stderr);
  assert.doesNotMatch(back.stdout, /paused/);
  assert.deepEqual(frozenRules(), []);
  assert.equal(I.inspect().paused, false);
});

test("restore refuses a wallet another bot folder on this computer already uses", () => {
  const home = agent();
  const text = cli(["backup", "--reveal"]).stdout;
  const twin = join(home, "..", "twin");
  const r = cli(["restore"], { home: twin, input: text });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already in use on this computer/);
  assert.equal(fs.existsSync(join(twin, "wallet.json")), false);
});

test("parseBackup: the four lines, the bare keys, a 64-number array or a wallet.json; a typo or a mismatched address is refused, never echoed", () => {
  agent();
  const w = JSON.parse(read("wallet.json"));
  const k = backupKeys();
  const a = { evm: w.evm.address, solana: w.solana.address };
  const lines = cli(["backup", "--reveal"]).stdout;
  assert.deepEqual([parseBackup(lines).evm, parseBackup(lines).solana], [a.evm, a.solana]);
  assert.equal(parseBackup(`${k.solana_private_key}\n${k.evm_private_key}`).solana, a.solana);
  const arr = JSON.stringify([...Buffer.from(w.solana.secret_key_b64, "base64")]);
  assert.equal(parseBackup(`${k.evm_private_key} ${arr}`).solana, a.solana);
  assert.equal(parseBackup(read("wallet.json")).evm, a.evm);
  const bad = [
    ["", /standard input/],
    [k.solana_private_key, /No EVM private key/],
    [k.evm_private_key, /No Solana private key/],
    [`${k.evm_private_key}\n${k.solana_private_key.slice(0, -1)}2`, /does not hold together|No Solana private key/],
    [lines.replace(a.evm, "0x" + "1".repeat(40)), /The EVM address in the backup is not the address of its key/],
    [lines.replace(`Solana address: ${a.solana}`, "Solana address: 11111111111111111111111111111111"), /The Solana address in the backup is not the address of its key/],
    [lines.replace(`Solana address: ${a.solana}`, `Solana address: ${k.solana_private_key}`), /The Solana address in the backup is not the address of its key/],
  ];
  for (const [text, re] of bad) {
    assert.throws(() => parseBackup(text), (e) => re.test(e.message) && !e.message.includes(k.evm_private_key.slice(2)) && !e.message.includes(k.solana_private_key));
  }
});

test("restore never reads a key from the command line", () => {
  agent();
  const k = backupKeys();
  assert.equal(cli(["restore", k.evm_private_key]).status, 1, "a positional is ignored; standard input is empty");
});

// ------------------------------------------------------------------ approvals

test("an approval code works only from 10 s after it was asked; a reflex use is refused, the code is kept, and the use records how long it took", async () => {
  agent();
  approvalTiming.minWaitMs = APPROVAL_MIN_WAIT_MS;
  try {
    assert.equal(APPROVAL_MIN_WAIT_MS, 10_000);
    const intent = { cmd: "send", to: DEAD, amount: "1" };
    const { code } = await requestApproval(intent);
    await assert.rejects(consumeApproval(code, intent), /was asked for 0 s ago\. Nothing was spent\. Show the owner the intent and wait for their yes in this chat; a code works from 10 s after it was asked\. Never approve your own request\./);
    // ten seconds later (the request's time moved back, as the clock would)
    const f = join(process.env.SATO_AGENT_HOME, "approvals.json");
    const all = JSON.parse(fs.readFileSync(f, "utf8"));
    all[code].created_at -= 12_000;
    fs.writeFileSync(f, JSON.stringify(all));
    await consumeApproval(code, intent);
    const used = entries().filter((e) => e.kind === "approval" && e.status === "used").at(-1);
    assert.equal(used.after_s, 12);
  } finally {
    approvalTiming.minWaitMs = 0;
  }
});

test("CLI: the exit-5 message says only the owner's yes counts and when the code works; status lists approvals with their timing", () => {
  agent({ chains: "base", perTx: "5", perDay: "20", approval: "ask" });
  const ask = cli(["register", "--name", "a", "--description", "b"]);
  assert.equal(ask.status, 5);
  assert.match(ask.stderr, /Only the owner's yes in this chat counts: never approve your own request\. The code works from 10 s after it was asked\./);
  const code = /--approve ([0-9a-f]{8})/.exec(ask.stderr)[1];
  const reflex = cli(["register", "--name", "a", "--description", "b", "--approve", code], { env: { SATO_TEST_APPROVAL_WAIT: "1" } });
  assert.equal(reflex.status, 1);
  assert.match(reflex.stderr, /was asked for \d+ s ago/);
  cli(["register", "--name", "a", "--description", "b", "--approve", code]); // fails later at the closed RPC; the approval is used
  assert.match(cli(["status"]).stdout, /approvals used \(latest 5\):\n {2}\S+ code [0-9a-f]{8}, \d+ s after it was asked/);
});

// ------------------------------------------------------------------ the chain under concurrency

test("four processes writing at once keep one valid chain", async () => {
  agent();
  const worker = `import { record } from ${JSON.stringify(new URL("../src/ledger.js", import.meta.url).href)}; for (let i = 0; i < 25; i++) record({ kind: "check", status: "skipped", n: i });`;
  await Promise.all(
    [0, 1, 2, 3].map(
      () =>
        new Promise((resolve, reject) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", worker], { env: process.env, stdio: "inherit" });
          p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
        }),
    ),
  );
  assert.deepEqual(frozenRules(), []);
  assert.equal(entries().filter((e) => e.kind === "check").length, 100);
});

// ------------------------------------------------------------------ review round 1: the attacks it reproduced

test("R1 C1: deleting the seal and leaving a one-line ledger is not an upgrade: frozen (the wallet file says it was sealed)", async () => {
  agent();
  await spend(5);
  fs.rmSync(file("integrity.json"));
  write("ledger.jsonl", "{}\n");
  assert.ok(frozenRules().includes("ledger_tampered"));
  await assert.rejects(spend(1), (e) => e.refusals?.some((r) => r.rule === "ledger_tampered"));
  write("policy.json", read("policy.json").replace('"max_usd_per_tx": 5', '"max_usd_per_tx": null'));
  await assert.rejects(spend(500), (e) => e instanceof Refused);
});

test("R1 C1: an upgraded folder's wallet is stamped, so the same trick fails after an upgrade too; a legacy policy with a queued raise is refused", async () => {
  legacyFolder();
  I.inspect(); // the upgrade seals it at the first read
  assert.equal(JSON.parse(read("wallet.json")).version, I.SEALED_WALLET_VERSION);
  fs.rmSync(file("integrity.json"));
  write("ledger.jsonl", "{}\n");
  assert.ok(frozenRules().includes("ledger_tampered"));
  legacyFolder({ edit: (t) => t.replace('"max_usd_per_day": 20', `"max_usd_per_day": 20,\n  "pending": { "per_day": { "values": { "max_usd_per_day": null }, "effective_at": "2020-01-01T00:00:00.000Z" } }`) });
  assert.deepEqual(frozenRules(), ["policy_tampered"]);
});

test("R1 H1: reserve decides on the policy as it is on disk, not only on the caller's copy", async () => {
  agent();
  const loose = { ...loadPolicy(), max_usd_per_tx: null, max_usd_per_day: null };
  await assert.rejects(reserve(loose, { kind: "send", chain: "base", usd: 500, to: DEAD }), (e) => e.refusals?.some((r) => r.rule === "max_usd_per_tx"));
  assert.equal(spentLast24h().usd, 0, "nothing reserved");
});

test("R1 H2: with the seal deleted or unreadable, the ledger still names the folder's wallet: init, restore and repair refuse another", () => {
  const home = agent();
  const mine = addresses();
  const other = freshHome();
  initWallet();
  const otherText = cli(["backup", "--reveal"], { home: other }).stdout;
  for (const seal of ["delete", "corrupt"]) {
    process.env.SATO_AGENT_HOME = home;
    const keep = read("wallet.json");
    if (seal === "delete") fs.rmSync(file("integrity.json"));
    else write("integrity.json", "x");
    fs.rmSync(file("wallet.json"));
    assert.throws(() => initWallet(), new RegExp(`it was ${mine.base}`));
    const r = cli(["restore"], { input: otherText });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /belonged to another wallet/);
    write("wallet.json", JSON.parse(JSON.stringify(fs.readFileSync(join(other, "wallet.json"), "utf8"))));
    assert.ok(frozenRules().includes("wallet_tampered"));
    assert.throws(() => I.repair(), /never accepts a different wallet/);
    write("wallet.json", keep);
    I.repair();
    assert.deepEqual(frozenRules(), []);
  }
});

test("R1 M1: with no seal to vouch for it, a loosened policy.json is not kept by repair", () => {
  agent();
  fs.rmSync(file("integrity.json"));
  write("policy.json", read("policy.json").replace('"max_usd_per_day": 20', '"max_usd_per_day": null'));
  const r = I.repair();
  assert.ok(r.actions.some((a) => /removed the limits/.test(a)));
  assert.equal(loadPolicy(), null);
  assert.ok(r.paused_until);
});

test("R1 M1: a policy line planted before a repair never comes back as 'the last recorded change'", () => {
  agent();
  const loose = { ...loadPolicy(), max_usd_per_tx: null, max_usd_per_day: null };
  fs.appendFileSync(file("ledger.jsonl"), JSON.stringify({ kind: "policy", status: "changed", to: loose }) + "\n");
  I.repair();
  fs.rmSync(file("policy.json"));
  const r = I.repair();
  assert.ok(!r.actions.some((a) => /put back/.test(a)), r.actions.join(" | "));
  assert.equal(loadPolicy(), null);
  assert.equal(I.lastRecordedPolicy(), null);
});

// ------------------------------------------------------------------ v0.6.0 docs

test("v0.6.0: the docs say what the limits protect against (and what not), the backup step comes right after funding, and no claim overstates", () => {
  const ROOT = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
  const bot = fs.readFileSync(ROOT("BOT.md"), "utf8");
  const readme = fs.readFileSync(ROOT("README.md"), "utf8");
  const skill = fs.readFileSync(ROOT("skills/sato-agent/SKILL.md"), "utf8");
  assert.equal(JSON.parse(fs.readFileSync(ROOT("package.json"), "utf8")).version, "0.6.0");
  for (const [name, text] of [["BOT.md", bot], ["README.md", readme]]) {
    assert.match(text, /What the limits protect against/, name);
    assert.match(text, /[Ff]und (it|the wallet) like a spending account/, name);
    assert.match(text, /no secret/, `${name}: the chain's honest scope`);
    assert.doesNotMatch(text, /can(no|')t be (overridden|bypassed)/i, name);
  }
  const fund = bot.indexOf("**Ask the owner to fund the wallet");
  const backup = bot.indexOf("**Back up the wallet, once**");
  const referral = bot.indexOf("**Referral, once**");
  assert.ok(fund > 0 && backup > fund && referral > backup, "backup comes right after funding, before the referral step");
  assert.match(bot, /After upgrading to 0\.6\.0/);
  assert.match(readme, /Upgrading to v0\.6\.0/);
  assert.match(skill, /Upgrading to 0\.6\.0/);
  assert.match(bot, /backup --reveal/);
  assert.match(bot, /restore <<'BACKUP'/);
  assert.match(bot, /policy cancel/);
  assert.match(bot, /Tell the owner now/);
  // the words the owner's copy rules ban, in what this release added
  // (each section up to the next heading: the Rules quote those words in "never call ... safe")
  const section = (text, head) => {
    const from = text.indexOf(head);
    const next = text.indexOf("\n## ", from + head.length);
    return text.slice(from, next < 0 ? undefined : next);
  };
  const added = [section(bot, "## What the limits protect against"), section(readme, "What the limits protect against")].join("\n");
  assert.doesNotMatch(added, /\b(safe|secure|trusted|verified|guaranteed)\b/i);
});

// ------------------------------------------------------------------ review round 2

test("R2 H-A: a sealed folder dressed up as pre-chain (seal deleted, ledger rewritten, wallet version set back to 1) is paused, and its unrecorded policy dropped", async () => {
  agent();
  await spend(5);
  fs.rmSync(file("integrity.json"));
  write("ledger.jsonl", "{}\n");
  write("wallet.json", read("wallet.json").replace(`"version": ${I.SEALED_WALLET_VERSION}`, '"version": 1'));
  write("policy.json", read("policy.json").replace('"max_usd_per_tx": 5', '"max_usd_per_tx": null'));
  const s = I.inspect();
  assert.equal(s.paused, true, "the upgrade is never free");
  assert.equal(loadPolicy(), null, "a policy with no recorded change behind it is not kept");
  await assert.rejects(spend(500), (e) => e instanceof Refused);
  assert.ok(fs.readdirSync(process.env.SATO_AGENT_HOME).some((f) => f.startsWith("policy.json.unrecorded-")), "kept aside, not deleted");
});

test("R2 H-B: a policy.json swapped to approval auto is never acted on: the send is refused, nothing is reserved", () => {
  agent({ chains: "base", perTx: "5", perDay: "20", approval: "ask" });
  write("policy.json", read("policy.json").replace('"approval": "ask"', '"approval": "auto"'));
  const r = cli(["send", "--chain", "base", "--to", DEAD, "--amount", "1", "--skip-check"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /policy_tampered/);
  assert.equal(entries().filter((e) => e.status === "submitted").length, 0);
});

test("R2 H-C: with no seal, a ledger naming a second wallet is frozen, and repair keeps neither", () => {
  agent();
  const other = { evm: "0x1111111111111111111111111111111111111111", solana: "11111111111111111111111111111112" };
  fs.appendFileSync(file("ledger.jsonl"), JSON.stringify({ kind: "wallet", status: "created", ...other }) + "\n");
  fs.rmSync(file("integrity.json"));
  assert.ok(frozenRules().includes("wallet_tampered"));
  assert.match(I.inspect().problems.find((p) => p.rule === "wallet_tampered").message, /names more than one wallet/);
});

test("R2 M-A: after a repair removed the limits, setting them again waits like a raise (never an instant 'first policy')", async () => {
  agent();
  fs.appendFileSync(file("ledger.jsonl"), "{}\n");
  I.repair();
  fs.rmSync(file("policy.json"));
  I.repair();
  const r = setPolicy({ chains: "base", perTx: "none", perDay: "none" });
  assert.equal(r.first, false);
  assert.ok(r.queued.length >= 3, r.queued.map((q) => q.part).join(","));
  assert.match(r.raises[0], /this folder has a history/);
  const p = loadPolicy();
  assert.deepEqual(p.chains, []);
  assert.equal(loadPolicy({ now: Date.now() + DAY + 1000 }).max_usd_per_day, null, "in force a day later");
});

test("R2 M-B: an unreadable line pinned under a repair no longer stops spending once the pause is over", () => {
  agent();
  fs.appendFileSync(file("ledger.jsonl"), "junk\n");
  assert.ok(spentLast24h().unreadable.length);
  const t = Date.now();
  I.repair({ now: t });
  assert.deepEqual(spentLast24h().unreadable, []);
  assert.deepEqual(rules(evaluate(loadPolicy(), { usd: 1, chain: "base" }, { ...spentLast24h(), paused_until: null })), []);
});

test("R2 L-A: a folder wiped and restored from a copy: spending paused, and the first limits wait like a raise", () => {
  const home = agent();
  const copy = read("wallet.json");
  fs.rmSync(home, { recursive: true });
  const r = cli(["restore"], { home, input: copy });
  assert.equal(r.status, 0, r.stderr);
  process.env.SATO_AGENT_HOME = home;
  assert.ok(I.inspect().paused);
  const set = setPolicy({ chains: "base", perTx: "none", perDay: "none" });
  assert.equal(set.first, false);
  assert.deepEqual(loadPolicy().chains, []);
});

// ------------------------------------------------------------------ review round 3

test("R3 M-1: the upgrade keeps nothing in force from an older policy: each part is queued for the end of the pause and shown as pending", () => {
  legacyFolder();
  const old = JSON.parse(read("policy.json"));
  const s = I.inspect(); // sealed at the first read
  assert.ok(s.paused);
  const now = loadPolicy();
  assert.deepEqual(now.chains, [], "nothing allowed during the pause");
  const parts = Object.keys(now.pending).sort();
  assert.ok(parts.includes("per_tx") && parts.includes("per_day") && parts.includes("chains"), parts.join(","));
  for (const e of Object.values(now.pending)) assert.equal(e.effective_at, s.paused_until, "they arrive when the pause ends");
  const after = loadPolicy({ now: Date.parse(s.paused_until) });
  assert.equal(after.max_usd_per_day, old.max_usd_per_day);
  assert.deepEqual(after.chains, old.chains);
  assert.equal(after.pending, undefined);
  assert.match(cli(["status"]).stdout, /RAISE PENDING: per 24 hours: \$0 → \$20/);
  // the older lines no longer count as recorded limits: the upgrade's own line does
  assert.equal(I.lastRecordedPolicy().pending.per_day.values.max_usd_per_day, 20);
});

test("R3 M-1: a hand-written older ledger with a loose policy line gets nothing in force without it showing as pending", () => {
  agent();
  const loose = { ...loadPolicy(), max_usd_per_tx: null, max_usd_per_day: null, approval: "auto" };
  fs.rmSync(file("integrity.json"));
  write("ledger.jsonl", JSON.stringify({ kind: "policy", status: "changed", to: loose }) + "\n");
  write("policy.json", I.policyFileText(loose));
  write("wallet.json", read("wallet.json").replace(`"version": ${I.SEALED_WALLET_VERSION}`, '"version": 1'));
  I.inspect();
  const p = loadPolicy();
  assert.equal(p.max_usd_per_day, 0);
  assert.ok(p.pending.per_day && p.pending.approval, "the loose parts are pending, for the owner to see and cancel");
  cancelPending();
  assert.equal(loadPolicy({ now: Date.now() + 2 * DAY }).max_usd_per_day, 0);
});

// ------------------------------------------------------------------ review round 4

/** An older folder dressed up by hand: no seal, a wallet file in the old format, one recorded policy line and a matching file. */
function handMadeOlderFolder(to) {
  agent();
  fs.rmSync(file("integrity.json"));
  write("wallet.json", read("wallet.json").replace(`"version": ${I.SEALED_WALLET_VERSION}`, '"version": 1'));
  write("ledger.jsonl", JSON.stringify({ kind: "policy", status: "changed", to }) + "\n");
  write("policy.json", I.policyFileText(to));
}

test("R4: a policy with its limits missing reads as 'no limit', so the upgrade queues them (shown as pending), never lets them through unseen", () => {
  handMadeOlderFolder({ chains: ["base"], allow_recipients: null, check_gate: "off", approval: "auto", swaps_off: false, bridges_off: false });
  const s = I.inspect();
  const p = loadPolicy();
  assert.ok(p.pending.per_tx && p.pending.per_day, Object.keys(p.pending).join(","));
  assert.equal(p.pending.per_day.values.max_usd_per_day, null);
  assert.deepEqual(rules(evaluate(loadPolicy({ now: Date.parse(s.paused_until) - 1 }), { usd: 5000, chain: "base", to: DEAD }, 0)).sort(), ["allow_recipients", "chain_not_allowed", "max_usd_per_day", "max_usd_per_tx"].sort(), "nothing allowed during the pause");
  assert.match(cli(["status"]).stdout, /RAISE PENDING: per 24 hours: \$0 → no limit/);
});

test("R4: a limit or list of a shape the kit never writes fails closed: frozen before an upgrade, refused (policy_invalid) by evaluate", () => {
  handMadeOlderFolder({ chains: ["base"], max_usd_per_tx: "5000", max_usd_per_day: "x", allow_recipients: null });
  assert.deepEqual(frozenRules(), ["policy_tampered"]);
  for (const bad of [{ max_usd_per_tx: "5" }, { max_usd_per_day: Number.NaN }, { max_usd_per_day: -1 }, { allow_recipients: "any" }, { chains: "base" }, { approval: "yes" }, { max_trades_per_day: 1.5 }]) {
    const pol = { chains: ["base"], max_usd_per_tx: 5, max_usd_per_day: 20, allow_recipients: null, ...bad };
    assert.deepEqual(rules(evaluate(pol, { usd: 1, chain: "base" }, 0)), ["policy_invalid"], JSON.stringify(bad));
  }
});

test("R4: an older policy with no allowlist key is read as 'any recipient' (no crash on the first read)", () => {
  handMadeOlderFolder({ chains: ["base"], max_usd_per_tx: 5, max_usd_per_day: 20, check_gate: "off", approval: "auto", swaps_off: false, bridges_off: false });
  const s = I.inspect();
  assert.ok(s.paused);
  assert.equal(loadPolicy().pending.recipients.values.allow_recipients, null);
});
