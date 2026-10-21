// The Sato Passport link in the ERC-8004 registration file, offline: the services entry, the file with no passport (byte for byte what it
// was before), a bad id refused before anything is built or sent, no duplicate entry, no call to Sato Hub, and the saved passport
// surviving a later --resume. A stub client stands in for the chain; nothing here reaches a node or Sato Hub.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import { freshHome } from "./helpers.js";

let home = freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { entries } = await import("../src/ledger.js");
const { patchSettings, loadSettings } = await import("../src/settings.js");
const { registerAgent, registrationUri, isLaterAgent, IDENTITY_REGISTRY, identityRegistryAbi } = await import("../src/base.js");
const { PASSPORT_ID_RE, PASSPORT_SERVICE_NAME, parsePassportId, passportService, passportUrl, passportResultLines, resolveForRegister, resolvePassport, savedPassport, savePassport, skippedPassportNote, withPassportService } = await import("../src/passport.js");

const ID = "sato:agt:exmpexmpexmp";
const ID2 = "sato:agt:pqrstuvwxy23";
const card = (uri) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
const settingsFile = () => join(home, "settings.json");

let me;
function reset() {
  home = freshHome();
  me = initWallet().base;
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
}
reset();

/** A stub chain client: step one registers agent `agentId` (99046 unless told), step two (setAgentURI) is accepted. Every prepared request is kept in `sent`. */
function client({ owner, agentId = 99046n } = {}) {
  const state = { sent: [], simulated: 0 };
  const registered = (agent) => ({
    address: IDENTITY_REGISTRY,
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: agent, owner: me } }),
    data: encodeAbiParameters([{ type: "string" }], ["data:application/json;base64,e30="]),
  });
  const c = {
    account: { address: me },
    sleep: async () => {},
    wallet: {
      async prepareTransactionRequest(req) {
        state.sent.push(req);
        return { ...req, nonce: req.nonce ?? 7 };
      },
      async signTransaction(p) {
        return `0x${String(p.nonce).padStart(8, "0")}${keccak256(p.data).slice(2)}`;
      },
    },
    pub: {
      async simulateContract() {
        state.simulated++;
        return {};
      },
      async readContract({ functionName }) {
        if (functionName === "ownerOf") return owner ?? me;
        throw new Error(`unexpected read ${functionName}`);
      },
      async getTransactionReceipt({ hash }) {
        return { transactionHash: hash, status: "success", logs: [] };
      },
      async call() {
        return { data: "0x" };
      },
      async sendRawTransaction() {},
      async waitForTransactionReceipt({ hash }) {
        return { transactionHash: hash, status: "success", logs: state.sent.length === 1 ? [registered(agentId)] : [] };
      },
    },
  };
  return { c, state };
}

/** The data: URI inside a prepared register / setAgentURI request. */
function uriOf(req) {
  const { functionName, args } = decodeFunctionData({ abi: identityRegistryAbi, data: req.data });
  return { functionName, uri: args[args.length - 1] };
}

// ---------------------------------------------------------------- the file itself

test("the id: only sato:agt: plus 12 characters of the passport alphabet; anything else is refused, never fixed up", () => {
  assert.equal(PASSPORT_ID_RE.source, "^sato:agt:[abcdefghjkmnpqrstuvwxyz23456789]{12}$");
  assert.equal(parsePassportId(ID), ID);
  assert.equal(parsePassportId(`  ${ID}\n`), ID, "surrounding spaces are ignored");
  const bad = [
    "", " ", "none-ish", "sato:agt:", "sato:agt:exmpexmpexm", "sato:agt:exmpexmpexmpp", "sato:agt:EXMPEXMPEXMP", "SATO:AGT:exmpexmpexmp",
    "sato:agt:exmpexmpexm1", "sato:agt:exmpexmpexm0", "sato:agt:exmpexmpexmi", "sato:agt:exmpexmpexml", "sato:agt:exmpexmpexmo",
    "sato:agt:exmpexmpexm-", "sato:agt:exmpexmpex m", "sato:usr:exmpexmpexmp", "https://satohub.ai/passport/exmpexmpexmp", "exmpexmpexmp",
    "sato:agt:exmpexmpexmp/../x", `${ID}\n${ID}`, "sato:agt:exmpexmpexmp‮",
  ];
  for (const v of bad) assert.throws(() => parsePassportId(v), /--passport must be a Sato Passport id like sato:agt:/, JSON.stringify(v));
  for (const v of [undefined, null, 12, {}, []]) assert.throws(() => parsePassportId(v), /--passport must be/, String(v));
  assert.throws(() => parsePassportId("x".repeat(5_000)), (e) => e.message.length < 300, "a long value is not echoed whole");
});

test("with a passport, the registration file gets one SatoPassport entry (name, endpoint, version) after the others", () => {
  const c = card(registrationUri({ agentId: 7, name: "Sato Base Agent", description: "test", services: [{ name: "web", endpoint: "https://x.y" }], x402Support: true, passport: ID }));
  assert.deepEqual(c.services, [
    { name: "web", endpoint: "https://x.y" },
    { name: "SatoPassport", endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" },
  ]);
  // Nothing else in the file moved.
  assert.equal(c.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(c.x402Support, true);
  assert.equal(c.active, true);
  assert.deepEqual(c.registrations, [{ agentId: 7, agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` }]);
  assert.deepEqual(Object.keys(c), ["type", "name", "description", "image", "services", "x402Support", "active", "registrations"]);
  // The entry alone, and the helpers it is built from.
  assert.deepEqual(passportService(ID), { name: PASSPORT_SERVICE_NAME, endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" });
  assert.equal(passportUrl(ID), "https://satohub.ai/passport/exmpexmpexmp");
  const only = card(registrationUri({ name: "a", description: "b", passport: ID2 }));
  assert.deepEqual(only.services, [{ name: "SatoPassport", endpoint: "https://satohub.ai/passport/pqrstuvwxy23", version: "1" }]);
});

test("the entry says nothing about verification, safety or trust: three keys, and the link is the whole claim", () => {
  const entry = passportService(ID);
  assert.deepEqual(Object.keys(entry), ["name", "endpoint", "version"]);
  assert.doesNotMatch(JSON.stringify(entry), /verif|safe|trust|audit|score/i);
});

test("without a passport the file is byte for byte what it was before the option existed", () => {
  // These three data: URIs were produced by registrationUri at v0.5.4, before this change.
  const GOLDEN_SERVICES =
    "data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJTYXRvIEJhc2UgQWdlbnQiLCJkZXNjcmlwdGlvbiI6InRlc3QiLCJpbWFnZSI6IiIsInNlcnZpY2VzIjpbeyJuYW1lIjoid2ViIiwiZW5kcG9pbnQiOiJodHRwczovL3gueSJ9XSwieDQwMlN1cHBvcnQiOnRydWUsImFjdGl2ZSI6dHJ1ZSwicmVnaXN0cmF0aW9ucyI6W3siYWdlbnRJZCI6NywiYWdlbnRSZWdpc3RyeSI6ImVpcDE1NTo4NDUzOjB4ODAwNEExNjlGQjRhMzMyNTEzNkVCMjlmQTBjZUI2RDJlNTM5YTQzMiJ9XX0=";
  const GOLDEN_BARE =
    "data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJTYXRvIEJhc2UgQWdlbnQiLCJkZXNjcmlwdGlvbiI6InRlc3QiLCJpbWFnZSI6IiIsInNlcnZpY2VzIjpbXSwieDQwMlN1cHBvcnQiOmZhbHNlLCJhY3RpdmUiOnRydWUsInJlZ2lzdHJhdGlvbnMiOltdfQ==";
  const GOLDEN_ARB =
    "data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJTYXRvIEFyYml0cnVtIEJvdCIsImRlc2NyaXB0aW9uIjoiR3JvayBCb3Qgb25jaGFpbiBhZ2VudCIsImltYWdlIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9pLnBuZyIsInNlcnZpY2VzIjpbXSwieDQwMlN1cHBvcnQiOmZhbHNlLCJhY3RpdmUiOnRydWUsInJlZ2lzdHJhdGlvbnMiOlt7ImFnZW50SWQiOjk5MDQ2LCJhZ2VudFJlZ2lzdHJ5IjoiZWlwMTU1OjQyMTYxOjB4ODAwNEExNjlGQjRhMzMyNTEzNkVCMjlmQTBjZUI2RDJlNTM5YTQzMiJ9XX0=";
  assert.equal(registrationUri({ agentId: 7, name: "Sato Base Agent", description: "test", services: [{ name: "web", endpoint: "https://x.y" }], x402Support: true }), GOLDEN_SERVICES);
  assert.equal(registrationUri({ name: "Sato Base Agent", description: "test" }), GOLDEN_BARE);
  assert.equal(registrationUri({ agentId: 99046, name: "Sato Arbitrum Bot", description: "Grok Bot onchain agent", image: "https://example.com/i.png", chain: "arbitrum" }), GOLDEN_ARB);
  // An absent passport is the same thing however it is spelled.
  for (const passport of [undefined, null]) {
    assert.equal(registrationUri({ name: "Sato Base Agent", description: "test", passport }), GOLDEN_BARE);
  }
  // The caller's own list is returned as it was given (same array), so nothing about it can change.
  const list = [{ name: "web", endpoint: "https://x.y" }];
  assert.equal(withPassportService(list, undefined), list);
  assert.equal(withPassportService(list, null), list);
});

test("no duplicate entry: a SatoPassport entry the caller passed (any case) is replaced, the other services stay", () => {
  const given = [
    { name: "web", endpoint: "https://x.y" },
    { name: "SatoPassport", endpoint: "https://elsewhere.example/p/zzz", version: "9" },
    { name: " satopassport ", endpoint: "https://elsewhere.example/q" },
    { name: "MCP", endpoint: "https://mcp.example/", version: "2025-06-18" },
  ];
  const before = JSON.stringify(given);
  const c = card(registrationUri({ name: "a", description: "b", services: given, passport: ID }));
  assert.deepEqual(c.services, [
    { name: "web", endpoint: "https://x.y" },
    { name: "MCP", endpoint: "https://mcp.example/", version: "2025-06-18" },
    { name: "SatoPassport", endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" },
  ]);
  assert.equal(c.services.filter((s) => /satopassport/i.test(s.name)).length, 1);
  assert.equal(JSON.stringify(given), before, "the caller's list is not changed");
  // Run twice over its own output: still one.
  const again = card(registrationUri({ name: "a", description: "b", services: c.services, passport: ID2 }));
  assert.equal(again.services.filter((s) => /satopassport/i.test(s.name)).length, 1);
  assert.equal(again.services.at(-1).endpoint, "https://satohub.ai/passport/pqrstuvwxy23");
  // With no passport the caller's own entry is left alone (the option is the only thing that touches it).
  assert.deepEqual(card(registrationUri({ name: "a", description: "b", services: given })).services, given);
});

test("an invalid id throws a plain error before the file is built", () => {
  for (const passport of ["", "sato:agt:short", "sato:agt:ABCDEFGHJKMN", "nope", 5]) {
    assert.throws(() => registrationUri({ name: "a", description: "b", passport }), /--passport must be a Sato Passport id/, String(passport));
  }
});

// ---------------------------------------------------------------- registering

test("register --passport: both transactions carry the entry, the id is saved, and Sato Hub is never called", async () => {
  reset();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    throw new Error("no network in this test");
  };
  try {
    const { c, state } = client();
    const r = await registerAgent({ name: "Sato Base Agent", description: "test", services: [{ name: "web", endpoint: "https://x.y" }], passport: ID }, c);
    assert.equal(fetched, 0, "register made no network call of its own (the chain is the stub)");
    assert.equal(r.agent_id, "99046");
    assert.equal(r.passport, ID);
    assert.equal(r.passport_url, "https://satohub.ai/passport/exmpexmpexmp");
    assert.equal(state.sent.length, 2);
    const [one, two] = state.sent.map(uriOf);
    assert.equal(one.functionName, "register");
    assert.equal(two.functionName, "setAgentURI");
    for (const { uri } of [one, two]) {
      const s = card(uri).services;
      assert.deepEqual(s, [{ name: "web", endpoint: "https://x.y" }, { name: "SatoPassport", endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" }]);
    }
    assert.deepEqual(card(two.uri).registrations, [{ agentId: 99046, agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` }], "the final file names the new agent id");
    // Saved in settings.json (beside the policy) and logged as a settings change.
    const saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
    assert.equal(saved.passport, ID);
    assert.equal(saved.schema, "sato-agent.settings/v1");
    assert.equal(savedPassport(), ID);
    assert.ok(entries().some((e) => e.kind === "settings" && e.status === "passport_set" && e.to === ID && e.from === null));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("register with no passport anywhere: the same two files as before, nothing saved, no passport in the result", async () => {
  reset();
  const { c, state } = client();
  const r = await registerAgent({ name: "Sato Base Agent", description: "test" }, c);
  assert.deepEqual(Object.keys(r), ["agent_id", "registry", "tx", "explorer"]);
  assert.equal(state.sent.length, 2);
  for (const req of state.sent) {
    assert.equal(card(uriOf(req).uri).services.length, 0);
    assert.equal(uriOf(req).uri, registrationUri({ agentId: uriOf(req).functionName === "register" ? undefined : 99046, name: "Sato Base Agent", description: "test" }));
  }
  assert.throws(() => readFileSync(settingsFile(), "utf8"), /ENOENT/, "settings.json was not even created");
  assert.equal(entries().filter((e) => e.kind === "settings").length, 0);
});

test("an invalid id stops register before anything is simulated, signed or saved", async () => {
  reset();
  for (const passport of ["sato:agt:ABCDEFGHJKMN", "sato:agt:abc", "", "https://satohub.ai/passport/exmpexmpexmp"]) {
    const { c, state } = client();
    await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test", passport }, c), /--passport must be a Sato Passport id/, JSON.stringify(passport));
    assert.equal(state.sent.length, 0, "nothing prepared or sent");
    assert.equal(state.simulated, 0, "not even simulated");
  }
  assert.throws(() => readFileSync(settingsFile(), "utf8"), /ENOENT/, "nothing saved");
  assert.equal(entries().filter((e) => e.kind !== "policy").length, 0, "nothing in the ledger but the policy set up above");
  // Same on a --resume.
  const { c, state } = client();
  await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test", resume: 4242, passport: "nope" }, c), /--passport must be/);
  assert.equal(state.sent.length, 0);
});

test("a registration that is refused before signing does not save the passport", async () => {
  reset();
  // The owner chose Base only: BNB Chain is refused by the policy check.
  const a = client();
  await assert.rejects(registerAgent({ name: "x", description: "y", chain: "bnb", passport: ID }, a.c), /set to work on base only/);
  assert.equal(a.state.sent.length, 0);
  // A --resume for an agent this wallet does not own.
  const b = client({ owner: "0x9999999999999999999999999999999999999999" });
  await assert.rejects(registerAgent({ name: "x", description: "y", resume: 5151, passport: ID }, b.c), /belongs to 0x9999.*nothing was signed/s);
  assert.equal(b.state.sent.length, 0);
  assert.equal(savedPassport(), null, "neither refusal saved it");
  assert.throws(() => readFileSync(settingsFile(), "utf8"), /ENOENT/);
  // This wallet already registered an agent and did not say --again.
  const ok = client();
  await registerAgent({ name: "x", description: "y", passport: ID }, ok.c);
  await assert.rejects(registerAgent({ name: "x", description: "y", passport: ID2 }, client().c), /already registered agent id 99046; add --again/);
  assert.equal(savedPassport(), ID, "the refused call did not replace the saved passport");
});

test("the saved passport survives the update path: a later --resume with no --passport writes the same entry", async () => {
  reset();
  const first = client();
  await registerAgent({ name: "Sato Base Agent", description: "test", passport: ID }, first.c);
  // Later, in a new process in real life (settings.json is the only thing carried over): finish or refresh the file with --resume.
  const later = client();
  const r = await registerAgent({ name: "Sato Base Agent", description: "test", resume: 99046 }, later.c);
  assert.equal(later.state.sent.length, 1, "only setAgentURI");
  const { functionName, uri } = uriOf(later.state.sent[0]);
  assert.equal(functionName, "setAgentURI");
  assert.deepEqual(card(uri).services, [{ name: "SatoPassport", endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" }]);
  assert.equal(r.passport, ID);
  assert.equal(r.passport_url, "https://satohub.ai/passport/exmpexmpexmp");
  assert.equal(entries().filter((e) => e.status === "passport_set").length, 1, "an unchanged passport is not logged again");
});

test("a failed step two leaves the passport saved, so the --resume the error names writes it", async () => {
  reset();
  const { c, state } = client();
  c.pub.call = async () => {
    throw Object.assign(new Error("Execution reverted for an unknown reason."), { shortMessage: "Execution reverted for an unknown reason." });
  };
  await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test", passport: ID }, c), /registered as agent 99046, but writing its registration file failed.*--resume 99046/s);
  assert.equal(state.sent.length, 1, "only step one was sent");
  assert.equal(card(uriOf(state.sent[0]).uri).services.at(-1).name, "SatoPassport", "step one already carried it");
  assert.equal(savedPassport(), ID);
  const retry = client();
  await registerAgent({ name: "Sato Base Agent", description: "test", resume: 99046 }, retry.c);
  assert.equal(card(uriOf(retry.state.sent[0]).uri).services.at(-1).endpoint, "https://satohub.ai/passport/exmpexmpexmp");
});

test("a new --passport replaces the saved one; none drops it and later files carry no entry", async () => {
  reset();
  await registerAgent({ name: "n", description: "d", passport: ID }, client().c);
  const swap = client();
  await registerAgent({ name: "n", description: "d", resume: 99046, passport: ID2 }, swap.c);
  assert.equal(card(uriOf(swap.state.sent[0]).uri).services.at(-1).endpoint, "https://satohub.ai/passport/pqrstuvwxy23");
  assert.equal(savedPassport(), ID2);
  const drop = client();
  const r = await registerAgent({ name: "n", description: "d", resume: 99046, passport: null }, drop.c);
  assert.deepEqual(card(uriOf(drop.state.sent[0]).uri).services, []);
  assert.equal(r.passport, undefined);
  assert.equal(savedPassport(), null);
  assert.equal("passport" in JSON.parse(readFileSync(settingsFile(), "utf8")), false);
  const after = client();
  await registerAgent({ name: "n", description: "d", resume: 99046 }, after.c);
  assert.deepEqual(card(uriOf(after.state.sent[0]).uri).services, [], "nothing saved, nothing added");
  assert.deepEqual(entries().filter((e) => e.kind === "settings").map((e) => [e.status, e.from, e.to]), [
    ["passport_set", null, ID],
    ["passport_set", ID, ID2],
    ["passport_cleared", ID2, null],
  ]);
});

// ---------------------------------------------------------------- another agent from the same wallet (--again)

/** The services of the file in each prepared request (register, then setAgentURI). */
const servicesSent = (state) => state.sent.map((req) => card(uriOf(req).uri).services);
const PASSPORT_ENTRY = { name: "SatoPassport", endpoint: "https://satohub.ai/passport/exmpexmpexmp", version: "1" };
const PASSPORT_ENTRY_2 = { name: "SatoPassport", endpoint: "https://satohub.ai/passport/pqrstuvwxy23", version: "1" };

/** Agent 99046 registered with the first passport (saved), as every --again test below starts. */
async function firstAgentWithPassport() {
  reset();
  await registerAgent({ name: "First", description: "d", passport: ID }, client().c);
  assert.equal(savedPassport(), ID);
}

test("--again with no --passport: the second agent's file has no SatoPassport entry, the saved one is left alone, and the result says it was skipped", async () => {
  await firstAgentWithPassport();
  const settingsBefore = readFileSync(settingsFile(), "utf8");
  const rowsBefore = entries().filter((e) => e.kind === "settings").length;
  const second = client({ agentId: 99047n });
  const r = await registerAgent({ name: "Second", description: "d", again: true }, second.c);
  assert.equal(r.agent_id, "99047");
  assert.equal(second.state.sent.length, 2);
  for (const services of servicesSent(second.state)) assert.deepEqual(services, [], "no SatoPassport entry in either transaction");
  assert.equal(r.passport, undefined);
  assert.equal(r.passport_url, undefined);
  assert.equal(r.passport_skipped, ID, "the saved id that was left out is named, so the caller can say so");
  assert.equal(readFileSync(settingsFile(), "utf8"), settingsBefore, "settings.json is byte for byte as it was");
  assert.equal(entries().filter((e) => e.kind === "settings").length, rowsBefore, "no settings row");
  // The one line printed for it.
  const note = skippedPassportNote(r.passport_skipped);
  assert.equal(note.includes("\n"), false, "one line");
  assert.ok(note.includes(ID));
  assert.match(note, /not added to this registration file/);
  assert.match(note, /--again/);
  assert.match(note, /a passport belongs to one agent/);
  assert.doesNotMatch(note, /verif|safe|trust/i);
});

test("--again with --passport: that entry, for that file alone (not saved; the saved passport stays)", async () => {
  await firstAgentWithPassport();
  const rowsBefore = entries().filter((e) => e.kind === "settings").length;
  const second = client({ agentId: 99047n });
  const r = await registerAgent({ name: "Second", description: "d", again: true, passport: ID2 }, second.c);
  for (const services of servicesSent(second.state)) assert.deepEqual(services, [PASSPORT_ENTRY_2]);
  assert.equal(r.passport, ID2);
  assert.equal(r.passport_url, "https://satohub.ai/passport/pqrstuvwxy23");
  assert.equal(r.passport_skipped, undefined, "nothing was skipped: no note");
  assert.equal(savedPassport(), ID, "the first agent's passport is still the saved one");
  assert.equal(entries().filter((e) => e.kind === "settings").length, rowsBefore, "and nothing was logged as a change");
});

test("--again with --passport none: no entry, no skipped note (it was asked for), the saved passport is not dropped", async () => {
  await firstAgentWithPassport();
  const second = client({ agentId: 99047n });
  const r = await registerAgent({ name: "Second", description: "d", again: true, passport: null }, second.c);
  for (const services of servicesSent(second.state)) assert.deepEqual(services, []);
  assert.equal(r.passport, undefined);
  assert.equal(r.passport_skipped, undefined);
  assert.equal(savedPassport(), ID);
});

test("--again with a bad --passport is refused before anything is sent, like any other bad id", async () => {
  await firstAgentWithPassport();
  const second = client({ agentId: 99047n });
  await assert.rejects(registerAgent({ name: "Second", description: "d", again: true, passport: "sato:agt:nope" }, second.c), /--passport must be a Sato Passport id/);
  assert.equal(second.state.sent.length, 0);
  assert.equal(second.state.simulated, 0);
});

test("--resume keeps the saved entry for the wallet's first agent, also after a second agent was registered; --resume with --again is still --resume", async () => {
  await firstAgentWithPassport();
  await registerAgent({ name: "Second", description: "d", again: true }, client({ agentId: 99047n }).c);
  // The first agent (99046): the saved passport, as before.
  const resumeFirst = client();
  const r = await registerAgent({ name: "First", description: "d", resume: 99046 }, resumeFirst.c);
  assert.deepEqual(servicesSent(resumeFirst.state), [[PASSPORT_ENTRY]]);
  assert.equal(r.passport, ID);
  assert.equal(r.passport_skipped, undefined);
  // The same with --again on the command: a --resume is the same agent, so --resume decides.
  const both = client();
  await registerAgent({ name: "First", description: "d", resume: 99046, again: true }, both.c);
  assert.deepEqual(servicesSent(both.state), [[PASSPORT_ENTRY]]);
  // An id the ledger has never seen behaves as it always did: the saved passport.
  const unknown = client();
  await registerAgent({ name: "Other", description: "d", resume: 4242 }, unknown.c);
  assert.deepEqual(servicesSent(unknown.state), [[PASSPORT_ENTRY]]);
});

test("--resume of the second agent does not take the saved passport either: only an id given on that command, used for that file alone", async () => {
  await firstAgentWithPassport();
  await registerAgent({ name: "Second", description: "d", again: true }, client({ agentId: 99047n }).c);
  const bare = client();
  const r = await registerAgent({ name: "Second", description: "d", resume: 99047 }, bare.c);
  assert.deepEqual(servicesSent(bare.state), [[]], "no entry");
  assert.equal(r.passport_skipped, ID);
  const own = client();
  const r2 = await registerAgent({ name: "Second", description: "d", resume: 99047, passport: ID2 }, own.c);
  assert.deepEqual(servicesSent(own.state), [[PASSPORT_ENTRY_2]]);
  assert.equal(r2.passport, ID2);
  assert.equal(savedPassport(), ID, "the first agent's saved passport was neither replaced nor dropped");
  assert.equal(entries().filter((e) => e.kind === "settings").length, 1, "one settings row in all: the first agent's");
});

test("a second agent whose step two fails: the --resume the error names carries its own passport, and none when it had none", async () => {
  await firstAgentWithPassport();
  const failing = (agentId) => {
    const x = client({ agentId });
    x.c.pub.call = async () => {
      throw Object.assign(new Error("Execution reverted for an unknown reason."), { shortMessage: "Execution reverted for an unknown reason." });
    };
    return x;
  };
  await assert.rejects(registerAgent({ name: "Second", description: "d", again: true, passport: ID2 }, failing(99047n).c), /registered as agent 99047, but writing its registration file failed.*--resume 99047 --name \.\.\. --description \.\.\. --passport sato:agt:pqrstuvwxy23$/s);
  await assert.rejects(registerAgent({ name: "Third", description: "d", again: true }, failing(99048n).c), (e) => /--resume 99048 --name \.\.\. --description \.\.\.$/.test(e.message) && !/--passport/.test(e.message.split("Finish with:")[1]));
  // The id named is the one used for that file, whichever it is.
  await assert.rejects(registerAgent({ name: "x", description: "y", again: true, passport: ID2 }, failing(99049n).c), /--passport sato:agt:pqrstuvwxy23$/);
  assert.equal(savedPassport(), ID);
});

test("what register prints under its result: the link line (saved or not), or the one skipped line, never both for the same call", async () => {
  const lines = (r, save) => passportResultLines(r, { save });
  // A first registration that saves its passport.
  reset();
  const fresh = await registerAgent({ name: "First", description: "d", passport: ID }, client().c);
  assert.deepEqual(lines(fresh, true), [`Registration file links to Sato Passport ${ID}: https://satohub.ai/passport/exmpexmpexmp (this agent's own declaration, not checked by the kit; saved here so --resume keeps it).`]);
  // --again with no flag: exactly the skipped note, nothing about a link.
  const skipped = await registerAgent({ name: "Second", description: "d", again: true }, client({ agentId: 99047n }).c);
  assert.deepEqual(lines(skipped, false), [skippedPassportNote(ID)]);
  // --again with its own id: the link line, said not to be saved.
  const own = await registerAgent({ name: "Third", description: "d", again: true, passport: ID2 }, client({ agentId: 99048n }).c);
  assert.deepEqual(lines(own, false), [`Registration file links to Sato Passport ${ID2}: https://satohub.ai/passport/pqrstuvwxy23 (this agent's own declaration, not checked by the kit; for this registration file only, not saved).`]);
  // No passport anywhere: nothing printed.
  reset();
  assert.deepEqual(lines(await registerAgent({ name: "Plain", description: "d" }, client().c), false), []);
  for (const l of [...lines(fresh, true), ...lines(skipped, false), ...lines(own, false)]) assert.doesNotMatch(l, /verified|\bsafe\b|trusted|audited/i, l);
});

test("resolveForRegister and isLaterAgent: the rules in one table", () => {
  reset();
  savePassport(ID);
  const r = (input, o) => resolveForRegister(input, o);
  // A first registration, or a --resume of the same agent: as resolvePassport (the saved one unless one is given).
  assert.deepEqual(r(undefined, {}), { passport: ID, save: false, skippedSaved: null, another: false });
  assert.deepEqual(r(ID2, {}), { passport: ID2, save: true, skippedSaved: null, another: false });
  assert.deepEqual(r(null, {}), { passport: null, save: true, skippedSaved: null, another: false });
  assert.deepEqual(r(undefined, { resume: 5 }), { passport: ID, save: false, skippedSaved: null, another: false });
  assert.deepEqual(r(undefined, { again: true, resume: 5 }), { passport: ID, save: false, skippedSaved: null, another: false }, "--resume decides");
  // Another agent: --again (no resume), or a resume of a later one. Never the saved one, never saved.
  assert.deepEqual(r(undefined, { again: true }), { passport: null, save: false, skippedSaved: ID, another: true });
  assert.deepEqual(r(ID2, { again: true }), { passport: ID2, save: false, skippedSaved: null, another: true });
  assert.deepEqual(r(null, { again: true }), { passport: null, save: false, skippedSaved: null, another: true });
  assert.deepEqual(r(undefined, { resume: 5, laterAgent: true }), { passport: null, save: false, skippedSaved: ID, another: true });
  assert.deepEqual(r(ID2, { resume: 5, laterAgent: true }), { passport: ID2, save: false, skippedSaved: null, another: true });
  // With no saved passport there is nothing to skip.
  savePassport(null);
  assert.deepEqual(r(undefined, { again: true }), { passport: null, save: false, skippedSaved: null, another: true });
  // A bad id is refused in every case.
  assert.throws(() => r("nope", { again: true }), /--passport must be/);
  // isLaterAgent: only an agent the ledger lists after the first.
  assert.equal(isLaterAgent(99047, ["99046", "99047"]), true);
  assert.equal(isLaterAgent("99047", ["99046", "99047"]), true);
  assert.equal(isLaterAgent(99046, ["99046", "99047"]), false, "the first");
  assert.equal(isLaterAgent(4242, ["99046", "99047"]), false, "unknown to the ledger");
  assert.equal(isLaterAgent(99046, []), false);
  assert.equal(isLaterAgent(undefined, ["99046", "99047"]), false);
  assert.equal(isLaterAgent("0x10", ["99046", "99047"]), false, "not an agent id");
});

// ---------------------------------------------------------------- what is saved

test("settings: saving and clearing the passport leaves the other settings (referral, shipping) alone", () => {
  reset();
  patchSettings((s) => ({ ...s, referrer: "sunny-otter", ship_to_id: "abc123" }));
  assert.equal(savePassport(ID), true);
  assert.equal(savePassport(ID), false, "unchanged");
  let s = loadSettings();
  assert.equal(s.referrer, "sunny-otter");
  assert.equal(s.ship_to_id, "abc123");
  assert.equal(s.passport, ID);
  assert.match(s.passport_set_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(savePassport(null), true);
  assert.equal(savePassport(null), false);
  s = loadSettings();
  assert.equal(s.referrer, "sunny-otter");
  assert.equal(s.ship_to_id, "abc123");
  assert.equal("passport" in s, false);
  assert.equal("passport_set_at" in s, false);
});

test("a hand-edited value that is not a passport id reads as none", () => {
  reset();
  for (const v of ["sato:agt:ABCDEFGHJKMN", "junk", 5, null, ["sato:agt:exmpexmpexmp"]]) {
    patchSettings((s) => ({ ...s, passport: v }));
    assert.equal(savedPassport(), null, JSON.stringify(v));
    assert.equal(resolvePassport(undefined).passport, null);
  }
});

test("resolvePassport: nothing given uses the saved one; none, off and clear mean no passport; an id is checked", () => {
  reset();
  assert.deepEqual(resolvePassport(undefined), { passport: null, explicit: false });
  savePassport(ID);
  assert.deepEqual(resolvePassport(undefined), { passport: ID, explicit: false });
  for (const v of ["none", "NONE", " off ", "clear", null]) assert.deepEqual(resolvePassport(v), { passport: null, explicit: true }, String(v));
  assert.deepEqual(resolvePassport(ID2), { passport: ID2, explicit: true });
  assert.throws(() => resolvePassport("sato:agt:nope"), /--passport must be/);
  assert.equal(savedPassport(), ID, "resolving writes nothing");
});
