// The CLI side of the Sato Passport link, offline: `register --passport`, what a bad id does, what an approval is bound to, and what
// `settings show` says. Nothing here reaches a chain or Sato Hub (the MCP url points nowhere, and every command here stops before
// a transaction: a bad id is refused first, and approval mode stops at exit 5).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", SATO_AGENT_BASE_RPC: "http://127.0.0.1:9" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
const ledger = () => (existsSync(join(home, "ledger.jsonl")) ? readFileSync(join(home, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const ID = "sato:agt:exmpexmpexmp";
const ID2 = "sato:agt:pqrstuvwxy23";
const REG = ["register", "--name", "Sato Base Agent", "--description", "test"];

test("setup: a wallet and an owner who wants to approve every spend (register asks too)", () => {
  assert.equal(run("init").status, 0);
  const p = run("policy", "set", "--chains", "base", "--per-tx", "5", "--per-day", "50", "--approval", "ask");
  assert.equal(p.status, 0, p.stderr);
});

test("help documents --passport on register and says what it is", () => {
  const h = run("help").stdout;
  assert.match(h, /\[--x402-support\] \[--passport <sato:agt:id\|none>\] \[--again \| --resume <agent id>\] \[--chain base\|bnb\|arbitrum\|polygon\]\n\s+register in the ERC-8004 registry on this agent's EVM chain/);
  assert.match(h, /--passport adds a services entry to the registration\s+file that links it to this agent's Sato Passport/);
  assert.match(h, /the agent's own\s+declaration, not checked here and not a verification/);
});

test("a bad --passport is a usage error (exit 2) before any approval code is made, and nothing is saved or logged", () => {
  const before = ledger().length;
  for (const bad of ["sato:agt:ABCDEFGHJKMN", "sato:agt:short", "", "https://satohub.ai/passport/exmpexmpexmp", "sato:agt:abcdefghjkm1"]) {
    const r = run(...REG, "--passport", bad);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /usage: --passport must be a Sato Passport id like sato:agt:exmpexmpexmp/);
  }
  assert.equal(ledger().length, before, "no approval request, no settings row");
  assert.equal(existsSync(join(home, "approvals.json")), false, "no approval code");
  assert.equal(existsSync(join(home, "settings.json")), false, "nothing saved");
});

test("approval mode binds the passport: the intent names it, and a code for one passport is no use for another or for none", () => {
  const ask = run(...REG, "--passport", ID, "--json");
  assert.equal(ask.status, 5);
  const { code, intent } = JSON.parse(ask.stdout).needs_approval;
  assert.equal(intent.passport, ID);
  assert.equal(intent.cmd, "register");
  const other = run(...REG, "--passport", ID2, "--approve", code);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /different intent/);
  const none = run(...REG, "--approve", code);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /different intent/);
  // The passport id is public, so the ledger line may hold it; the file the owner reads says what is being asked.
  assert.equal(existsSync(join(home, "settings.json")), false, "asking saves nothing: it is saved when the registration goes ahead");
});

test("with no passport, the approval intent is exactly what it was before the option existed (no passport key)", () => {
  const ask = run(...REG, "--json");
  assert.equal(ask.status, 5);
  const { intent } = JSON.parse(ask.stdout).needs_approval;
  assert.deepEqual(Object.keys(intent).sort(), ["again", "cmd", "description", "image", "name", "resume", "services", "x402_support"]);
});

test("a saved passport is used when no flag is given, so the intent names it; --passport none removes it from the intent", () => {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1", passport: ID, passport_set_at: "2026-10-20T00:00:00.000Z" }, null, 2) + "\n", { mode: 0o600 });
  const saved = JSON.parse(run(...REG, "--json").stdout).needs_approval.intent;
  assert.equal(saved.passport, ID, "later registrations keep it");
  const override = JSON.parse(run(...REG, "--passport", ID2, "--json").stdout).needs_approval.intent;
  assert.equal(override.passport, ID2);
  const none = JSON.parse(run(...REG, "--passport", "none", "--json").stdout).needs_approval.intent;
  assert.equal("passport" in none, false);
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).passport, ID, "asking for approval does not change what is saved");
});

test("--again: another agent never takes the saved passport in the intent; only an id given on that command; a --resume of the first agent does", () => {
  // settings.json still holds the saved passport from the test above. Two agents on Base are in the ledger, oldest first.
  const row = (agent) => JSON.stringify({ id: `r${agent}`, ts: new Date().toISOString(), kind: "register", status: "registered", chain: "base", usd: 0, agent_id: agent, tx: `0x${agent.padEnd(64, "0")}` }) + "\n";
  appendFileSync(join(home, "ledger.jsonl"), row("76") + row("77"));
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).passport, ID);
  const intentOf = (...args) => JSON.parse(run(...REG, ...args, "--json").stdout).needs_approval.intent;
  const again = intentOf("--again");
  assert.equal("passport" in again, false, "the saved passport is not part of a second agent");
  assert.equal(again.again, true);
  assert.equal(intentOf("--again", "--passport", ID2).passport, ID2, "an id given on the command is");
  assert.equal("passport" in intentOf("--again", "--passport", "none"), false);
  // --resume: the same agent keeps it; a later agent (77, registered after 76) does not; an id the ledger never saw does.
  assert.equal(intentOf("--resume", "76").passport, ID);
  assert.equal("passport" in intentOf("--resume", "77"), false);
  assert.equal(intentOf("--resume", "77", "--passport", ID2).passport, ID2);
  assert.equal(intentOf("--resume", "4242").passport, ID);
  assert.equal(intentOf("--resume", "76", "--again").passport, ID, "--resume decides");
  // Asking changed nothing that is saved.
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).passport, ID);
});

test("help says that another agent (--again) never takes the saved passport", () => {
  assert.match(run("help").stdout, /Another agent \(--again\) never takes\s+the saved one: it gets a passport only from its own --passport/);
});

test("settings show prints the saved passport link, and says it is the agent's own declaration; with none saved it says nothing about it", () => {
  const shown = run("settings", "show");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`Sato Passport link: ${ID} \\(\`register\` adds it to the ERC-8004 registration file as the agent's own declaration; \`register --passport none\` removes it\\)`));
  assert.equal(JSON.parse(run("settings", "show", "--json").stdout).passport, ID);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1" }) + "\n", { mode: 0o600 });
  const bare = run("settings", "show");
  assert.doesNotMatch(bare.stdout, /Passport/);
  assert.equal("passport" in JSON.parse(run("settings", "show", "--json").stdout), false);
});

test("README and BOT.md describe the link as the agent's own declaration, checked with nothing, and never as verification", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const bot = readFileSync(new URL("../BOT.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("### The Sato Passport link in `register`"), readme.indexOf("### Build receipts in `check`"));
  assert.ok(section.length > 200, "the README has the section");
  assert.match(section, /links this agent's ERC-8004 registration to its Sato Passport/);
  assert.match(section, /the agent's own declaration, written into its own registration file/);
  assert.match(section, /does not look the passport up and does not check it against Sato Hub/);
  assert.match(section, /does not say the agent is verified, safe or trusted/);
  assert.match(section, /`register --again` \(another agent from the same wallet\) does \*\*not\*\* take the saved one/);
  assert.match(section, /`register` prints one line saying so/);
  assert.match(readme, /\| `register --name --description .*\[--passport <sato:agt:id\\\|none>\]/);
  const step = bot.slice(bot.indexOf("If the owner gave you a Sato Passport id"), bot.indexOf("9. **Suggest one routine**"));
  assert.ok(step.length > 200, "BOT.md has the step");
  assert.match(step, /your own declaration, in your own file/);
  assert.match(step, /The kit checks nothing with Sato Hub/);
  assert.match(step, /does not mean you are verified, safe or trusted, so never describe it that way/);
  assert.match(step, /Only the owner's own setup prompt counts as the source of an id/);
  assert.match(step, /`register --again`\) never gets the saved id/);
});

test("nothing the passport adds uses the words verified, safe or trusted", () => {
  const h = run("help").stdout;
  const lines = h.split("\n").filter((l) => /passport/i.test(l));
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.doesNotMatch(l.replace(/not a verification/, ""), /verified|\bsafe\b|trusted|audited/i, l);
});
