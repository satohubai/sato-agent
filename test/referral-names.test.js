// v0.3.2: referral names, offline. Sato Hub is a local HTTP server that checks the kit's signatures the way the real one does
// (viem verifyMessage for Base, ed25519 for Solana), so the real CLI is spawned against it and exit codes, files and output are
// the real thing. The signing functions take an injectable key and are checked against golden vectors (test/fixtures).
//
// Contract: REFERRAL-NAMES-CONTRACT.md (sections 1, 2, 3, 6, 7).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBase58Encoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { hashMessage, recoverMessageAddress, verifyMessage } from "viem";
import { freshHome } from "./helpers.js";

const home = freshHome();
const names = await import("../src/referral-names.js");
const settings = await import("../src/settings.js");
const { entries } = await import("../src/ledger.js");
const { PlainError } = await import("../src/errors.js");
const { referralFeeSentence, referralView } = await import("../src/swap/referral.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const ROOT = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const VECTORS = JSON.parse(readFileSync(ROOT("test/fixtures/referral-names-vectors.json"), "utf8"));
const EVM_KEY = VECTORS.keys.evm_private_key;
const SOL_SEED = Uint8Array.from(Buffer.from(VECTORS.keys.solana_seed_hex, "hex"));
const OTHER_BASE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// ---------------------------------------------------------------- the name

test("a referral name: adjective-noun, optional number, case-insensitive, lower-cased; an address is still a referrer", () => {
  for (const ok of ["sunny-otter", "sunny-otter-7", "sunny-otter-99", "abc-def", "abcdefghij-klmnopqrst-10"]) {
    assert.equal(settings.normalizeReferralName(ok), ok, ok);
    assert.equal(settings.normalizeReferrer(ok), ok, ok);
    assert.ok(settings.NAME_RE.test(ok));
  }
  assert.equal(settings.normalizeReferralName("  Sunny-OTTER-7 "), "sunny-otter-7", "case-insensitive, spaces dropped, lower case out");
  assert.equal(settings.normalizeReferrer("SUNNY-otter"), "sunny-otter");
  for (const bad of ["", "sunny", "sunny-", "-otter", "su-otter", "sunny-ot", "sunnyabcdefg-otter", "sunny-otterabcdefg", "sunny-otter-0", "sunny-otter-07", "sunny-otter-100", "sunny-otter-7-8", "sunny_otter", "sunny otter", "sunny-ötter", "sunny-otter-x", "sunny-\notter", "none", null, undefined, 7, {}]) {
    assert.equal(settings.normalizeReferralName(bad), null, JSON.stringify(bad));
  }
  // an address is not a name and a name is not an address
  assert.equal(settings.normalizeAddress("sunny-otter"), null);
  assert.equal(settings.normalizeAddress(OTHER_BASE.toUpperCase().replace("0X", "0x")), OTHER_BASE);
  assert.equal(settings.normalizeReferrer(OTHER_BASE), OTHER_BASE, "an address still works everywhere a referrer is accepted");
  assert.equal(settings.normalizeReferrer(VECTORS.signers.solana), VECTORS.signers.solana);
  assert.equal(settings.normalizeReferrer("none"), null);
  assert.deepEqual(settings.parseReferrerInput("Sunny-Otter"), { referrer: "sunny-otter" });
  assert.deepEqual(settings.parseReferrerInput("NONE"), { clear: true });
  assert.throws(() => settings.parseReferrerInput("sunny"), /--referrer must be a Base address .* a Solana address or a referral name like sunny-otter/);
});

test("a name is shown whole; an address is shortened; the fee sentence reads naturally for a name", () => {
  assert.equal(settings.shortReferrer("sunny-otter-7"), "sunny-otter-7");
  assert.equal(settings.shortReferrer(OTHER_BASE), "0x7099…79c8");
  assert.equal(settings.shortReferrer(VECTORS.signers.solana), "AKnL…RSZ9");
  const view = referralView("sunny-otter", { referrer: "Sunny-Otter", share_of_fee_bps: 3000, payout: "weekly_usdc" }, 15);
  assert.equal(view.recorded, true, "the answer's name is compared normalized");
  assert.equal(referralFeeSentence(view), " 30% of it goes to the referrer sunny-otter (paid weekly in USDC); it is not an extra charge.");
  assert.equal(referralView("sunny-otter", { referrer: "calm-heron", share_of_fee_bps: 3000 }, 15).recorded, false, "another name is not ours");
});

// ---------------------------------------------------------------- the message and the signatures

test("the signed message: exact lines, joined by \\n, no trailing newline", () => {
  const m = names.referralMessage({ action: "create", name: null, signer: "0xaaa", payout: "0xbbb", issuedAt: "2026-10-11T18:04:05.123Z" });
  assert.equal(m, "Sato Hub referral name\naction: create\nname: -\nsigner: 0xaaa\npayout: 0xbbb\nissued_at: 2026-10-11T18:04:05.123Z");
  assert.equal(Buffer.from(m, "utf8").toString("hex").slice(-2), "5a", "ends with the Z, no newline");
  const s = names.referralMessage({ action: "set_payout", name: "sunny-otter", signer: "S", payout: "P", issuedAt: "2026-10-11T18:09:30.007Z" });
  assert.equal(s, "Sato Hub referral name\naction: set_payout\nname: sunny-otter\nsigner: S\npayout: P\nissued_at: 2026-10-11T18:09:30.007Z");
  assert.throws(() => names.referralMessage({ action: "delete", signer: "S", payout: "P", issuedAt: "x" }), /unknown referral action/);
});

test("golden vectors: the injected test keys give the signers, messages and signatures in test/fixtures byte for byte", async () => {
  assert.equal(names.baseSignerAddress(EVM_KEY), VECTORS.signers.base);
  assert.equal(names.solanaSignerAddress(SOL_SEED), VECTORS.signers.solana);
  // the wallet's 64-byte form (seed || public key) is the same key
  const pub = Buffer.from(getBase58Encoder().encode(VECTORS.signers.solana));
  assert.equal(names.solanaSignerAddress(Buffer.concat([Buffer.from(SOL_SEED), pub])), VECTORS.signers.solana);
  assert.equal(VECTORS.cases.length, 6);
  for (const c of VECTORS.cases) {
    const message = names.referralMessage({ action: c.action, name: c.name === "-" ? null : c.name, signer: c.signer, payout: c.payout, issuedAt: c.issued_at });
    assert.equal(message, c.message, `${c.id}: message`);
    const signer = names.makeSigner(c.signer_chain, { evmKey: EVM_KEY, solanaSecret: SOL_SEED });
    assert.equal(signer.address, c.signer, `${c.id}: signer`);
    const signature = await signer.sign(message);
    assert.equal(signature, c.signature, `${c.id}: signature`);
    if (c.signer_chain === "base") {
      assert.match(signature, /^0x[0-9a-f]{130}$/, "0x + 65 bytes");
      assert.equal(await verifyMessage({ address: c.signer, message, signature }), true, `${c.id}: viem verifyMessage`);
      assert.equal((await recoverMessageAddress({ message, signature })).toLowerCase(), c.signer);
      assert.match(hashMessage(message), /^0x[0-9a-f]{64}$/);
    } else {
      const raw = Buffer.from(getBase58Encoder().encode(signature));
      assert.equal(raw.length, 64, "64-byte ed25519 signature");
      // an independent ed25519 (noble) both reproduces and verifies it
      assert.equal(Buffer.from(ed25519.sign(Buffer.from(message, "utf8"), SOL_SEED)).toString("hex"), raw.toString("hex"), `${c.id}: noble signs the same bytes`);
      assert.equal(ed25519.verify(raw, Buffer.from(message, "utf8"), Buffer.from(getBase58Encoder().encode(c.signer))), true);
    }
  }
});

test("the Sato Hub app's own vectors (copied from tests/fixtures/referral-name-vectors.json there): same message, same signature, byte for byte", async () => {
  const v = JSON.parse(readFileSync(ROOT("test/fixtures/referral-name-vectors.json"), "utf8"));
  assert.equal(v.evm.private_key, EVM_KEY, "the same test keys");
  assert.equal(v.solana.seed_hex, VECTORS.keys.solana_seed_hex);
  assert.equal(names.baseSignerAddress(v.evm.private_key), v.evm.address);
  assert.equal(names.solanaSignerAddress(Uint8Array.from(Buffer.from(v.solana.seed_hex, "hex"))), v.solana.public_key);
  assert.ok(v.vectors.length >= 5,"the app ships create and set_payout vectors for both chains");
  assert.deepEqual([...new Set(v.vectors.map((c) => c.signer_chain))].sort(), ["base", "solana"]);
  assert.deepEqual([...new Set(v.vectors.map((c) => c.action))].sort(), ["create", "set_payout"]);
  for (const c of v.vectors) {
    const message = names.referralMessage({ action: c.action, name: c.name === "-" ? null : c.name, signer: c.signer, payout: c.payout, issuedAt: c.issued_at });
    assert.equal(message, c.message, `${c.label}: message`);
    const signer = names.makeSigner(c.signer_chain, { evmKey: v.evm.private_key, solanaSecret: Uint8Array.from(Buffer.from(v.solana.seed_hex, "hex")) });
    assert.equal(signer.address, c.signer, `${c.label}: signer`);
    assert.equal(await signer.sign(message), c.signature, `${c.label}: signature`);
  }
});

// ---------------------------------------------------------------- a local "Sato Hub" that checks signatures

const b58 = getBase58Encoder();
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

async function signatureOk({ signer, signature }, message) {
  if (/^0x/.test(signer)) return verifyMessage({ address: signer, message, signature });
  const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(b58.encode(signer))]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(b58.encode(signature)));
}

/** A fake Sato Hub: the name registry (create / set_payout / lookup), checking the message bytes and the signature. */
async function fakeHub({ reply } = {}) {
  const state = { names: new Map(), bySigner: new Map(), requests: [], issued: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    state.requests.push({ method: req.method, url: req.url, ua: req.headers["user-agent"], body });
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const override = reply?.(req, body);
    if (override) return send(override.status, override.json);
    const m = /^\/api\/referral\/name\/([^/]+)$/.exec(req.url);
    if (req.method === "GET" && m) return state.names.has(m[1]) ? send(200, { ok: true, name: m[1], active: true }) : send(404, { error: "not_found" });
    if (req.method === "POST" && req.url === "/api/referral/name") {
      const p = JSON.parse(body);
      const message = ["Sato Hub referral name", `action: ${p.action}`, `name: ${p.action === "create" ? "-" : p.name}`, `signer: ${p.signer}`, `payout: ${p.payout}`, `issued_at: ${p.issued_at}`].join("\n");
      if (!(await signatureOk(p, message).catch(() => false))) return send(401, { error: "bad_signature", message: "The signature does not match." });
      if (Math.abs(Date.now() - Date.parse(p.issued_at)) > 10 * 60_000) return send(409, { error: "stale", message: "issued_at is outside the 10 minute window." });
      state.issued.push(p);
      const payoutChain = /^0x/.test(p.payout) ? "base" : "solana";
      if (p.action === "create") {
        const have = state.bySigner.get(p.signer);
        if (have) return send(200, { ok: true, name: have, created: false, payout_chain: state.names.get(have).payout_chain });
        const name = `sunny-otter${state.names.size ? `-${state.names.size + 1}` : ""}`;
        state.names.set(name, { signer: p.signer, payout: p.payout, payout_chain: payoutChain, last: p.issued_at });
        state.bySigner.set(p.signer, name);
        return send(201, { ok: true, name, created: true, payout_chain: payoutChain });
      }
      const n = state.names.get(p.name);
      if (!n) return send(404, { error: "not_found", message: "No such name." });
      if (n.signer !== p.signer) return send(403, { error: "not_owner", message: "That name belongs to another wallet." });
      if (!(p.issued_at > n.last)) return send(409, { error: "stale", message: "That request is older than the last change." });
      const changed = n.payout !== p.payout;
      Object.assign(n, { payout: p.payout, payout_chain: payoutChain, last: p.issued_at });
      return send(200, { ok: true, name: p.name, changed, payout_chain: payoutChain });
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { state, origin, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

/** A fresh agent home with a wallet; returns a `run(args, input)` for the real CLI pointed at `origin`. */
function bot(origin) {
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-names-")), "agent");
  const run = (args, input, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: dir, SATO_AGENT_MCP_URL: `${origin}/api/mcp`, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input ?? "");
    });
  /** The owner's yes: the first run stops with exit 5 and a code; the SAME command with --approve <code> runs. Returns { first, second }. */
  const approved = async (args, env) => {
    const first = await run(args, undefined, env);
    assert.equal(first.status, 5, `expected exit 5, got ${first.status}: ${first.stderr}`);
    const code = /--approve ([0-9a-f]{8})/.exec(first.stderr)?.[1];
    assert.ok(code, first.stderr);
    return { first, code, second: await run([...args, "--approve", code], undefined, env) };
  };
  const file = (f) => join(dir, f);
  const saved = () => JSON.parse(readFileSync(file("settings.json"), "utf8"));
  const ledger = () => (existsSync(file("ledger.jsonl")) ? readFileSync(file("ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, run, approved, file, saved, ledger };
}

const hubs = [];
const newHub = async (opts) => {
  const h = await fakeHub(opts);
  hubs.push(h);
  return h;
};
after(async () => {
  for (const h of hubs) await h.close();
});

// ---------------------------------------------------------------- settings set --referrer <name>

test("lookup: 200 saves, 404 refuses, no answer / a timeout / another status refuse with 'try again'", async () => {
  const ok = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, name: "sunny-otter", active: true }) };
  const seen = [];
  const f = (res) => async (url, init) => (seen.push({ url, init }), typeof res === "function" ? res(init) : res);
  assert.deepEqual(await names.lookupReferralName("sunny-otter", { fetchImpl: f(ok), origin: "https://hub.test" }), { ok: true });
  assert.equal(seen[0].url, "https://hub.test/api/referral/name/sunny-otter");
  assert.equal(seen[0].init.method, "GET");
  assert.match(seen[0].init.headers["user-agent"], /^sato-agent\/\d/, "the kit's own user agent");
  assert.ok(seen[0].init.signal, "a timeout is set");
  const refused = async (res, msg) => {
    await assert.rejects(names.lookupReferralName("sunny-otter", { fetchImpl: f(res), origin: "https://hub.test", timeoutMs: 50 }), (e) => e instanceof PlainError && e.message === msg);
  };
  await refused({ status: 404, text: async () => JSON.stringify({ error: "not_found" }) }, "No referral name sunny-otter at Sato Hub.");
  const again = "Couldn't reach Sato Hub to check the name; try again.";
  await refused(async () => { throw new TypeError("fetch failed"); }, again);
  await refused({ status: 500, text: async () => "boom" }, again);
  await refused({ status: 429, text: async () => "{}" }, again);
  await refused({ status: 400, text: async () => JSON.stringify({ error: "bad_request" }) }, again);
  await refused({ status: 200, text: async () => "not json" }, again);
  // a real timeout: fetch that never answers, aborted by the signal
  await refused((init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))), again);
});

test("CLI: settings set --referrer <name> checks the name first; 200 saves it (lower-cased), 404 and no answer save nothing", async () => {
  const hub = await newHub();
  hub.state.names.set("sunny-otter", { signer: "x", payout: "y", payout_chain: "base", last: "" });
  const b = bot(hub.origin);
  const set = await b.run(["settings", "set", "--referrer", "Sunny-Otter"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Referral name saved: sunny-otter/);
  assert.match(set.stdout, /30% of its swap fee/);
  assert.equal(b.saved().referrer, "sunny-otter");
  assert.equal(statSync(b.file("settings.json")).mode & 0o777, 0o600);
  const lookups = hub.state.requests.filter((r) => r.method === "GET");
  assert.deepEqual(lookups.map((r) => r.url), ["/api/referral/name/sunny-otter"]);
  assert.match(lookups[0].ua, /^sato-agent\//);
  assert.deepEqual(b.ledger().filter((r) => r.kind === "settings").map((r) => [r.status, r.from, r.to]), [["referrer_set", null, "sunny-otter"]]);
  assert.match((await b.run(["settings", "show"])).stdout, /Referral name: sunny-otter/);
  assert.equal(JSON.parse((await b.run(["settings", "show", "--json"])).stdout).referrer, "sunny-otter");
  assert.match((await b.run(["status"])).stdout, /referral name: sunny-otter/);

  // unknown name: refused, the saved one is untouched
  const nope = await b.run(["settings", "set", "--referrer", "calm-heron"]);
  assert.equal(nope.status, 1);
  assert.equal(nope.stderr.trim(), "No referral name calm-heron at Sato Hub.");
  assert.equal(b.saved().referrer, "sunny-otter");
  // via --stdin with a ship address: the lookup refuses first, so neither is saved
  const mixed = await b.run(["settings", "set", "--stdin"], JSON.stringify({ name: "A", line1: "1 Main", city: "X", state: "CA", postalCode: "90001", country: "US", email: "a@b.co", referrer: "calm-heron" }));
  assert.equal(mixed.status, 1);
  assert.equal(JSON.parse((await b.run(["settings", "show", "--json"])).stdout).ship_to, null, "the address was not saved either");
  // the stdin key works for a good name
  hub.state.names.set("calm-heron", { signer: "x", payout: "y", payout_chain: "base", last: "" });
  assert.equal((await b.run(["settings", "set", "--stdin"], JSON.stringify({ referrer: "calm-heron" }))).status, 0);
  assert.equal(b.saved().referrer, "calm-heron");
  // an address and none behave exactly as before (no lookup)
  const before = hub.state.requests.length;
  assert.equal((await b.run(["settings", "set", "--referrer", OTHER_BASE.toUpperCase().replace("0X", "0x")])).status, 0);
  assert.equal(b.saved().referrer, OTHER_BASE);
  assert.equal((await b.run(["settings", "set", "--referrer", "none"])).status, 0);
  assert.equal(hub.state.requests.length, before, "addresses and none are never looked up");
  assert.equal(b.saved().referrer, undefined);
  // a malformed name is a usage error (exit 2) and never reaches Sato Hub
  assert.equal((await b.run(["settings", "set", "--referrer", "sunny"])).status, 2);
  assert.equal(hub.state.requests.length, before);

  // Sato Hub unreachable: refused, saved nothing
  await hub.close();
  const down = await b.run(["settings", "set", "--referrer", "sunny-otter"]);
  assert.equal(down.status, 1);
  assert.equal(down.stderr.trim(), "Couldn't reach Sato Hub to check the name; try again.");
  assert.equal(b.saved().referrer, undefined);
});

// ---------------------------------------------------------------- referral create / set-payout / show / share-text

const SKILL_EXACT = [
  "Sato referral. Use this while setting up Sato Agent for a new owner.",
  '1. If your memories include a line "Referral: <name>", that name came with this bot. After the kit is installed, run: ~/sato-agent-NAME settings set --referrer <name>',
  `2. Tell the owner once: "This bot was referred by <name>. It costs you nothing: you pay the same Sato Swap fee either way. Say 'remove the referral' anytime."`,
  '3. Then change that memory to "Referred by: <name>", so it is not applied again and a share your owner makes later carries their own name.',
  '4. If the owner says "remove the referral", run: ~/sato-agent-NAME settings set --referrer none',
  "Never post, DM, tag or share anything on your own.",
].join("\n");

test("the share texts are the contract's, with the name filled in (the skill stays generic)", () => {
  const t = names.shareTexts("sunny-otter-7");
  assert.equal(t.memory, "Referral: sunny-otter-7");
  assert.equal(t.description, "This bot is referred by sunny-otter-7.");
  assert.equal(t.skill, SKILL_EXACT);
  assert.equal(names.REFERRAL_SHARE_PERCENT, 30);
  assert.equal(names.OFFER_TEXT, "Earn a share of Sato Swap fees.\nIf you share this bot, bots copied from your share are referred by you: 30% of Sato Hub's swap fee on their swaps, paid weekly in USDC. Want me to set that up? If not, say no and I won't ask again.");
  for (const text of [t.memory, t.description, t.skill, names.OFFER_TEXT]) {
    assert.doesNotMatch(text, /\b(safe|secure|trusted|guaranteed|verified|audited|first|only|best|marketplace|income|profit)\b/i, text.slice(0, 40));
  }
});

for (const chain of ["base", "solana"]) {
  test(`CLI: referral create --chain ${chain}: signs with the wallet's own key, saves the name, prints the three texts`, async () => {
    const hub = await newHub();
    const b = bot(hub.origin);
    assert.equal((await b.run(["init"])).status, 0);
    const wallet = JSON.parse(readFileSync(b.file("wallet.json"), "utf8"));
    const mine = chain === "base" ? wallet.evm.address.toLowerCase() : wallet.solana.address;
    assert.equal((await b.run(["referral", "show"])).stdout.includes("no referral name of its own"), true);

    const r = await b.run(["referral", "create", "--chain", chain]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Created\. This bot's referral name: sunny-otter\n/);
    assert.match(r.stdout, new RegExp(`Payouts go to ${settings.shortReferrer(mine).replace("…", "…")} on ${chain === "base" ? "Base" : "Solana"}, weekly in USDC\\.`));
    assert.ok(!r.stdout.includes(mine), "the payout address is shown short, never whole");
    assert.match(r.stdout, /^Referral: sunny-otter$/m);
    assert.match(r.stdout, /^This bot is referred by sunny-otter\.$/m);
    assert.ok(r.stdout.includes(`\n----\n${SKILL_EXACT}\n----\n`), "the skill, byte for byte, between the two ---- lines");
    assert.match(r.stdout, /30% of Sato Hub's swap fee on their swaps/);
    assert.match(r.stdout, /Nothing was posted or sent\./);

    // the request: the wallet's own address signed it, the message and signature verified (by the fake hub, like the real one)
    const posted = hub.state.requests.filter((x) => x.method === "POST");
    assert.equal(posted.length, 1);
    assert.match(posted[0].ua, /^sato-agent\//);
    const p = JSON.parse(posted[0].body);
    assert.deepEqual(Object.keys(p).sort(), ["action", "issued_at", "payout", "signature", "signer"], "create sends no name");
    assert.equal(p.action, "create");
    assert.equal(p.signer, mine);
    assert.equal(p.payout, mine, "the payout defaults to the signing wallet");
    assert.match(p.issued_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(Math.abs(Date.now() - Date.parse(p.issued_at)) < 60_000, true);
    assert.ok(!posted[0].body.includes(wallet.evm.private_key.slice(2)) && !posted[0].body.includes(wallet.solana.secret_key_b64), "no key leaves the machine");

    // saved
    const s = b.saved();
    assert.equal(s.referral_name, "sunny-otter");
    assert.equal(s.referral_payout, mine);
    assert.equal(s.referral_chain, chain);
    assert.equal(s.referral_last_signed_at, p.issued_at);
    assert.equal(statSync(b.file("settings.json")).mode & 0o777, 0o600);
    const row = b.ledger().find((x) => x.status === "referral_name_created");
    assert.equal(row.kind, "settings");
    assert.equal(row.name, "sunny-otter");
    assert.ok(!JSON.stringify(row).includes(mine), "the ledger does not hold the payout address");

    // show / share-text
    const show = await b.run(["referral", "show"]);
    assert.match(show.stdout, /This bot's referral name: sunny-otter/);
    assert.match(show.stdout, new RegExp(`Payouts go to ${settings.shortReferrer(mine)} on ${chain === "base" ? "Base" : "Solana"}`));
    assert.match(show.stdout, /Referred by: nobody/);
    assert.match(show.stdout, /Offer: not needed/);
    const sj = JSON.parse((await b.run(["referral", "show", "--json"])).stdout);
    assert.equal(sj.name, "sunny-otter");
    assert.equal(sj.payout, settings.shortReferrer(mine));
    assert.equal(sj.signing_chain, chain);
    assert.equal(sj.referred_by, null);
    assert.equal(sj.offer.state, "has_name");
    const st = await b.run(["referral", "share-text"]);
    assert.equal(st.status, 0);
    assert.match(st.stdout, /^Referral: sunny-otter$/m);
    assert.ok(st.stdout.includes(`\n----\n${SKILL_EXACT}\n----`));
    assert.deepEqual(JSON.parse((await b.run(["referral", "share-text", "--json"])).stdout).share_text, names.shareTexts("sunny-otter"));

    // a second create from the same wallet returns the same name; the payout is not changed by it
    const { second: again } = await b.approved(["referral", "create", "--chain", chain, "--payout", OTHER_BASE]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already had a referral name: sunny-otter/);
    assert.equal(b.saved().referral_payout, mine, "a repeat create keeps what was known (Sato Hub keeps its payout too)");
  });
}

test("CLI: referral create with --payout: another address (either chain) is the payout; a name or junk is refused locally", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  const bad = await b.run(["referral", "create", "--chain", "base", "--payout", "sunny-otter"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--payout must be a Base address .* or a Solana address\./);
  assert.equal((await b.run(["referral", "create", "--chain", "base", "--payout", `0x${"0".repeat(40)}`])).status, 1, "the zero address");
  assert.equal(hub.state.requests.length, 0, "nothing was sent");
  assert.equal(existsSync(b.file("settings.json")), false, "nothing was saved");
  // another address than the signing wallet's own needs the owner's yes: exit 5, nothing sent, nothing saved, the full address in the intent
  const stop = await b.run(["referral", "create", "--chain", "base", "--payout", VECTORS.signers.solana]);
  assert.equal(stop.status, 5);
  assert.ok(stop.stderr.includes(VECTORS.signers.solana), "the intent names the new payout in full");
  assert.match(stop.stderr, /--approve [0-9a-f]{8}/);
  assert.equal(hub.state.requests.length, 0, "nothing was sent");
  assert.equal(existsSync(b.file("settings.json")), false, "nothing was saved");
  const requested = b.ledger().find((x) => x.kind === "approval" && x.status === "requested");
  assert.equal(requested.intent.payout, "AKnL…RSZ9", "the ledger holds the payout short");
  assert.ok(!JSON.stringify(b.ledger()).includes(VECTORS.signers.solana));
  const code = /--approve ([0-9a-f]{8})/.exec(stop.stderr)[1];
  // a code is for this exact intent: another payout, or another chain, is refused
  const other = await b.run(["referral", "create", "--chain", "base", "--payout", OTHER_BASE, "--approve", code]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /different intent/);
  const ok = await b.run(["referral", "create", "--chain", "base", "--payout", VECTORS.signers.solana, "--approve", code]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((await b.run(["referral", "create", "--chain", "base", "--payout", VECTORS.signers.solana, "--approve", code])).status, 1, "the code works once");
  assert.equal(JSON.parse(hub.state.requests[0].body).payout, VECTORS.signers.solana, "a Solana payout for a Base signer");
  assert.equal(b.saved().referral_payout, VECTORS.signers.solana);
  assert.match(ok.stdout, /Payouts go to AKnL…RSZ9 on Solana/);
  // usage
  assert.equal((await b.run(["referral", "create"])).status, 2);
  assert.equal((await b.run(["referral", "create", "--chain", "ethereum"])).status, 2);
  assert.equal((await b.run(["referral", "nope"])).status, 2);
});

test("CLI: create errors print Sato Hub's message, exit 1, and save nothing", async () => {
  for (const [status, json, want] of [
    [401, { error: "bad_signature", message: "The signature does not match." }, /Sato Hub: The signature does not match\. \(bad_signature\)/],
    [409, { error: "stale", message: "Your clock is off." }, /Your clock is off\./],
    [429, { error: "rate_limited", message: "Slow down." }, /Slow down\./],
    [503, { error: "unavailable" }, /Sato Hub: unavailable/],
    [400, { error: "payout_invalid", message: "That payout address is not allowed." }, /That payout address is not allowed\./],
  ]) {
    const hub = await newHub({ reply: (req) => (req.method === "POST" ? { status, json } : null) });
    const b = bot(hub.origin);
    await b.run(["init"]);
    const r = await b.run(["referral", "create", "--chain", "solana"]);
    assert.equal(r.status, 1, `${status}`);
    assert.match(r.stderr, want);
    assert.match(r.stderr, /Nothing was saved\./);
    assert.equal(existsSync(b.file("settings.json")), false, `${status}: nothing saved`);
    assert.equal(b.ledger().some((x) => x.status === "referral_name_created"), false);
  }
  // a 200 with an unusable body, then no answer at all
  const odd = await newHub({ reply: (req) => (req.method === "POST" ? { status: 200, json: { ok: true, name: "NOT A NAME!" } } : null) });
  const b1 = bot(odd.origin);
  await b1.run(["init"]);
  const r1 = await b1.run(["referral", "create", "--chain", "base"]);
  assert.equal(r1.status, 1);
  assert.equal(existsSync(b1.file("settings.json")), false);
  const gone = await fakeHub();
  const origin = gone.origin;
  await gone.close();
  const b2 = bot(origin);
  await b2.run(["init"]);
  const r2 = await b2.run(["referral", "create", "--chain", "base"]);
  assert.equal(r2.status, 1);
  assert.equal(r2.stderr.trim(), "Couldn't reach Sato Hub; nothing was saved. Try again.");
  assert.equal(existsSync(b2.file("settings.json")), false);
  // no wallet yet
  const b3 = bot(origin);
  const r3 = await b3.run(["referral", "create", "--chain", "base"]);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /no wallet yet/);
});

test("CLI: referral set-payout signs set_payout with the saved name and chain; updates settings and the ledger; errors save nothing", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  const early = await b.run(["referral", "set-payout", OTHER_BASE]);
  assert.equal(early.status, 1);
  assert.equal(early.stderr.trim(), "Run referral create first.");
  assert.equal((await b.run(["referral", "share-text"])).stderr.trim(), "Run referral create first.");

  await b.run(["referral", "create", "--chain", "solana"]);
  const first = b.saved();
  const addr = OTHER_BASE.toUpperCase().replace("0X", "0x");
  const postsBefore = hub.state.requests.filter((r) => r.method === "POST").length;
  const { first: stopped, second: set } = await b.approved(["referral", "set-payout", addr]);
  assert.ok(stopped.stderr.includes(OTHER_BASE), "the intent names the new payout in full (normalized)");
  assert.equal(hub.state.requests.filter((r) => r.method === "POST").length, postsBefore + 1, "nothing was signed or sent until the approved re-run");
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Payouts for sunny-otter now go to 0x7099…79c8 on Base, weekly in USDC\./);
  const p = hub.state.issued.at(-1);
  assert.equal(p.action, "set_payout");
  assert.equal(p.name, "sunny-otter");
  assert.equal(p.signer, first.referral_payout, "signed with the saved chain (Solana) key");
  assert.equal(p.payout, OTHER_BASE, "normalized");
  assert.ok(p.issued_at > first.referral_last_signed_at, "later than the last signed change");
  const s = b.saved();
  assert.equal(s.referral_payout, OTHER_BASE);
  assert.equal(s.referral_last_signed_at, p.issued_at);
  assert.equal(s.referral_name, "sunny-otter");
  assert.deepEqual(b.ledger().filter((x) => x.status === "referral_payout_changed").map((x) => [x.name, x.payout_chain, x.to]), [["sunny-otter", "base", "0x7099…79c8"]]);
  assert.ok(!JSON.stringify(b.ledger()).includes(OTHER_BASE), "the ledger never holds the payout address whole");
  assert.equal(s.referral_payout_changed_at, p.issued_at);
  assert.match((await b.run(["referral", "show"])).stdout, new RegExp(`Last payout change: ${p.issued_at}`));
  assert.equal(JSON.parse((await b.run(["referral", "show", "--json"])).stdout).payout_changed_at, p.issued_at);
  assert.match((await b.run(["referral", "show"])).stdout, /Payouts go to 0x7099…79c8 on Base \(signed with this bot's Solana wallet\)/);

  // the same payout again: unchanged
  const { second: same } = await b.approved(["referral", "set-payout", OTHER_BASE]);
  assert.equal(same.status, 0);
  assert.match(same.stdout, /already go to 0x7099…79c8\. Nothing changed\./);

  // junk address: refused locally; Sato Hub refusing: nothing saved
  const before = JSON.stringify(b.saved());
  const junk = await b.run(["referral", "set-payout", "sunny-otter"]);
  assert.equal(junk.status, 1);
  assert.match(junk.stderr, /needs a Base address .* or a Solana address/);
  const down = await newHub({ reply: (req) => (req.method === "POST" ? { status: 403, json: { error: "not_owner", message: "That name belongs to another wallet." } } : null) });
  const { second: refused } = await b.approved(["referral", "set-payout", VECTORS.signers.solana], { SATO_AGENT_MCP_URL: `${down.origin}/api/mcp` });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /That name belongs to another wallet\. \(not_owner\)/);
  assert.equal(JSON.stringify(b.saved()), before, "nothing changed");
  assert.equal((await b.run(["referral", "set-payout"])).status, 2);
});

test("referral set-payout never signs a time earlier than the last signed change, even if the clock went back", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  await b.run(["referral", "create", "--chain", "base"]);
  const s = b.saved();
  const future = new Date(Date.parse(s.referral_last_signed_at) + 3_600_000).toISOString();
  writeFileSync(b.file("settings.json"), JSON.stringify({ ...s, referral_last_signed_at: future }));
  const { second: set } = await b.approved(["referral", "set-payout", OTHER_BASE]);
  // the fake hub (like the real one) requires issued_at > last signed: the kit signed one millisecond after the saved time
  assert.equal(JSON.parse(hub.state.requests.filter((r) => r.method === "POST").at(-1).body).issued_at, new Date(Date.parse(future) + 1).toISOString());
  assert.equal(set.status, 1, "Sato Hub's own window would still refuse a time an hour ahead, and nothing is saved");
  assert.equal(b.saved().referral_payout, s.referral_payout);
});

// ---------------------------------------------------------------- the offer

test("CLI: referral offer prints once per `when`, records it, and prints nothing after (exit 0)", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  const a = await b.run(["referral", "offer", "--when", "setup"]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, `${names.OFFER_TEXT}\n`, "exactly the offer");
  assert.ok(b.saved().referral_offers.setup_at);
  const again = await b.run(["referral", "offer", "--when", "setup"]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "", "once per when");
  // the other `when` is its own
  assert.equal((await b.run(["referral", "offer", "--when", "swap"])).stdout, `${names.OFFER_TEXT}\n`);
  assert.equal((await b.run(["referral", "offer", "--when", "swap"])).stdout, "");
  const js = JSON.parse((await b.run(["referral", "offer", "--when", "swap", "--json"])).stdout);
  assert.deepEqual(js, { when: "swap", offer: null });
  assert.match((await b.run(["referral", "show"])).stdout, /Offer: shown at setup and swap/);
  // bad `when`
  assert.equal((await b.run(["referral", "offer"])).status, 2);
  assert.equal((await b.run(["referral", "offer", "--when", "pay"])).status, 2);
});

test("CLI: referral decline stops every offer; an own name stops them too; a referrer does not", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  const d = await b.run(["referral", "decline"]);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /will not come up again/);
  assert.ok(b.saved().referral_offers.declined_at);
  assert.equal((await b.run(["referral", "offer", "--when", "setup"])).stdout, "");
  assert.equal((await b.run(["referral", "offer", "--when", "swap"])).stdout, "");
  assert.match((await b.run(["referral", "decline"])).stdout, /Already noted/);
  assert.match((await b.run(["referral", "show"])).stdout, /Offer: declined/);

  const c = bot(hub.origin);
  await c.run(["init"]);
  hub.state.names.set("calm-heron", { signer: "x", payout: "y", payout_chain: "base", last: "" });
  await c.run(["settings", "set", "--referrer", "calm-heron"]);
  assert.equal((await c.run(["referral", "offer", "--when", "setup"])).stdout, `${names.OFFER_TEXT}\n`, "being referred does not stop the offer: copies get both offers");
  assert.match((await c.run(["referral", "show"])).stdout, /Referred by: calm-heron/);
  assert.equal(JSON.parse((await c.run(["referral", "show", "--json"])).stdout).referred_by, "calm-heron");

  const e = bot(hub.origin);
  await e.run(["init"]);
  await e.run(["referral", "create", "--chain", "base"]);
  assert.equal((await e.run(["referral", "offer", "--when", "setup"])).stdout, "", "not after an own name");
  assert.equal((await e.run(["referral", "offer", "--when", "swap"])).stdout, "");
});

test("in process: takeOffer / swapOffer are once-ever, never throw from swapOffer, and honour a decline and an own name", () => {
  const file = join(home, "settings.json");
  assert.equal(names.offerEligible("swap"), true);
  assert.equal(names.swapOffer(), names.OFFER_TEXT);
  assert.equal(names.swapOffer(), null, "once ever");
  assert.equal(names.takeOffer("setup"), names.OFFER_TEXT);
  assert.equal(names.takeOffer("setup"), null);
  assert.equal(names.takeOffer("nonsense"), null);
  assert.ok(Number.isFinite(Date.parse(JSON.parse(readFileSync(file, "utf8")).referral_offers.swap_at)));
  // a settings file that cannot be read must not break a swap: swapOffer returns null
  writeFileSync(file, "{ not json");
  assert.equal(names.swapOffer(), null);
  writeFileSync(file, JSON.stringify({ schema: "sato-agent.settings/v1", referral_name: "sunny-otter" }));
  assert.equal(names.swapOffer(), null, "an own name: no offer");
  writeFileSync(file, JSON.stringify({ schema: "sato-agent.settings/v1", referral_name: "NOT A NAME" }));
  assert.equal(names.ownReferral().name, null, "a hand-edited bad name reads as none");
  writeFileSync(file, JSON.stringify({ schema: "sato-agent.settings/v1", referral_offers: { declined_at: "2026-10-11T00:00:00.000Z" } }));
  assert.equal(names.swapOffer(), null);
  assert.equal(names.declineOffer(), false, "already declined");
  writeFileSync(file, JSON.stringify({ schema: "sato-agent.settings/v1", ship_to: { name: "x" } }));
  assert.equal(names.declineOffer(), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).ship_to.name, "x", "other settings are kept");
  assert.equal(entries().length >= 0, true);
});

// ---------------------------------------------------------------- where the offer may and may not appear (the wiring)

test("the swap prints the offer only after a confirmed swap; no other command can print it", () => {
  const src = readFileSync(ROOT("bin/sato-agent.js"), "utf8");
  // exactly one call site, and it is in the swap case, after execute() and after the dry-run return
  assert.equal([...src.matchAll(/swapOffer\(/g)].length, 1, "one call site");
  assert.equal([...src.matchAll(/takeOffer\(/g)].length, 1, "and one for the explicit `referral offer`");
  const swapCase = src.slice(src.indexOf('case "swap": {'), src.indexOf('case "token": {'));
  const at = swapCase.indexOf("swapOffer(");
  assert.ok(at > swapCase.indexOf("await prepared.execute()"), "after the swap was executed (a failure, exit 4 or exit 5 throws before this line)");
  assert.ok(at > swapCase.indexOf('if (flags["dry-run"]) {'), "after the dry-run branch, which returns");
  assert.match(swapCase, /referral_offer: offer/, "the JSON carries the field");
  assert.match(swapCase, /offer \? `\\n\\n\$\{offer\}` : ""/, "the text is appended");
  // every other command that spends or buys has no offer in its case
  for (const c of ["pay", "send", "register", "buy", "checkout", "giftcard", "order", "orders", "token", "check"]) {
    const start = src.indexOf(`case "${c}": {`);
    assert.ok(start > 0, c);
    const next = src.indexOf("\n    case ", start + 10);
    assert.doesNotMatch(src.slice(start, next), /swapOffer|takeOffer|OFFER_TEXT|referral_offer/, `no offer in ${c}`);
  }
  // swapOffer is wrapped: it cannot throw into the swap
  const lib = readFileSync(ROOT("src/referral-names.js"), "utf8");
  const fn = lib.slice(lib.indexOf("export function swapOffer"), lib.indexOf("/** The owner said no"));
  assert.match(fn, /try \{[\s\S]*takeOffer\("swap"/);
  assert.match(fn, /catch \{\s*return null;/);
});

// ---------------------------------------------------------------- the swap offer, driven through the real CLI

const STUB = `--import=${pathToFileURL(ROOT("test/stubs/register.mjs")).href}`;
const RESULT = "Swap: 1 USDC for ETH (stub)\nSwapped. https://basescan.org/tx/0xabc";
const SWAP = ["swap", "--chain", "base", "--from", "USDC", "--to", "ETH", "--amount", "1"];

test("CLI swap (chain module stubbed): only a confirmed swap prints the offer, once; a dry run, a failure, exit 4 and exit 5 do not and do not use it up", async () => {
  const b = bot("http://127.0.0.1:9"); // Sato Hub is never called by a swap with no referrer
  const swap = (mode, extra = []) => b.run([...SWAP, ...extra], undefined, { NODE_OPTIONS: STUB, SATO_STUB_SWAP: mode });
  const offered = (r) => r.stdout.includes("Earn a share of Sato Swap fees.");

  const dry = await swap("confirm", ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!offered(dry), "a dry run");
  const pending = await swap("pending");
  assert.equal(pending.status, 4);
  assert.ok(!offered(pending) && !offered({ stdout: pending.stderr }), "signed but not confirmed (exit 4)");
  const approval = await swap("approval");
  assert.equal(approval.status, 5);
  assert.ok(!offered(approval) && !offered({ stdout: approval.stderr }), "needs approval (exit 5)");
  const failed = await swap("fail");
  assert.equal(failed.status, 1);
  assert.ok(!offered(failed) && !offered({ stdout: failed.stderr }), "a failure");
  assert.equal(existsSync(b.file("settings.json")), false, "none of those recorded the offer as shown");

  // the confirmed swap: the result first, then the offer, once
  const first = await swap("confirm");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\nSwapped\. https:\/\/basescan\.org\/tx\/0xabc\n\nEarn a share of Sato Swap fees\.\nIf you share this bot/);
  assert.ok(first.stdout.endsWith(`${names.OFFER_TEXT}\n`));
  assert.ok(b.saved().referral_offers.swap_at);
  const second = await swap("confirm");
  assert.equal(second.status, 0);
  assert.ok(!offered(second), "once ever");
  assert.equal(second.stdout.trim(), RESULT);

  // --json carries the field once, on a fresh bot
  const c = bot("http://127.0.0.1:9");
  const j = await c.run([...SWAP, "--json"], undefined, { NODE_OPTIONS: STUB, SATO_STUB_SWAP: "confirm" });
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).referral_offer, names.OFFER_TEXT);
  const j2 = await c.run([...SWAP, "--json"], undefined, { NODE_OPTIONS: STUB, SATO_STUB_SWAP: "confirm" });
  assert.ok(!("referral_offer" in JSON.parse(j2.stdout)));

  // a bot that has said no, or has its own name, never gets it; the exit code and result are the same
  const d = bot("http://127.0.0.1:9");
  await d.run(["referral", "decline"]);
  const dd = await d.run(SWAP, undefined, { NODE_OPTIONS: STUB, SATO_STUB_SWAP: "confirm" });
  assert.equal(dd.status, 0);
  assert.equal(dd.stdout.trim(), RESULT);
  // an unwritable settings file must not change the swap
  const e = bot("http://127.0.0.1:9");
  mkdirSync(e.dir, { recursive: true });
  writeFileSync(e.file("settings.json"), "{ not json");
  const broken = await e.run(SWAP, undefined, { NODE_OPTIONS: STUB, SATO_STUB_SWAP: "confirm" });
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stdout, /\nSwapped\./);
});

// ---------------------------------------------------------------- review fixes: approval, guards

test("payout changes need the owner's yes in every approval mode: set-payout always, create --payout only for another address", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  await b.run(["policy", "set", "--chains", "base", "--per-tx", "10", "--per-day", "10", "--approval", "auto"]);
  // the signing wallet's own address (spelled out) needs no approval
  const wallet = JSON.parse(readFileSync(b.file("wallet.json"), "utf8"));
  const own = await b.run(["referral", "create", "--chain", "base", "--payout", wallet.evm.address]);
  assert.equal(own.status, 0, own.stderr);
  const posts = () => hub.state.requests.filter((r) => r.method === "POST").length;
  assert.equal(posts(), 1);
  // set-payout: stopped even with approval = auto, the intent names the address in full, nothing is sent
  const stop = await b.run(["referral", "set-payout", VECTORS.signers.solana, "--json"]);
  assert.equal(stop.status, 5);
  const j = JSON.parse(stop.stdout);
  assert.equal(j.needs_approval.intent.payout, VECTORS.signers.solana);
  assert.equal(j.needs_approval.intent.name, "sunny-otter");
  assert.equal(posts(), 1);
  assert.equal(b.saved().referral_payout, wallet.evm.address.toLowerCase());
  // a code for one payout does not work for another, and an expired/unknown one is refused
  const wrong = await b.run(["referral", "set-payout", OTHER_BASE, "--approve", j.needs_approval.code]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /different intent/);
  assert.equal((await b.run(["referral", "set-payout", OTHER_BASE, "--approve", "00000000"])).status, 1);
  assert.equal(posts(), 1);
  // the right code works once
  const go = await b.run(["referral", "set-payout", VECTORS.signers.solana, "--approve", j.needs_approval.code]);
  assert.equal(go.status, 0, go.stderr);
  assert.equal(posts(), 2);
  assert.equal((await b.run(["referral", "set-payout", VECTORS.signers.solana, "--approve", j.needs_approval.code])).status, 1);
  assert.equal(b.saved().referral_payout, VECTORS.signers.solana);
});

test("a bot has one name: create on the other chain is refused and saves nothing; the same chain returns the same name", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  assert.equal((await b.run(["referral", "create", "--chain", "base"])).status, 0);
  const before = JSON.stringify(b.saved());
  const posts = hub.state.requests.length;
  const other = await b.run(["referral", "create", "--chain", "solana"]);
  assert.equal(other.status, 1);
  assert.equal(other.stderr.trim(), "This bot already has the referral name sunny-otter (signed with its Base wallet). See `referral show`.");
  assert.equal(JSON.stringify(b.saved()), before);
  assert.equal(hub.state.requests.length, posts, "nothing was signed or sent");
  assert.equal((await b.run(["referral", "create", "--chain", "base"])).status, 0);
});

test("a bot cannot be referred by its own name (settings set --referrer refuses; nothing is looked up or saved)", async () => {
  const hub = await newHub();
  const b = bot(hub.origin);
  await b.run(["init"]);
  await b.run(["referral", "create", "--chain", "base"]);
  const gets = () => hub.state.requests.filter((r) => r.method === "GET").length;
  for (const args of [["settings", "set", "--referrer", "sunny-otter"], ["settings", "set", "--referrer", "Sunny-Otter"], ["settings", "set", "--stdin"]]) {
    const r = await b.run(args, args[2] === "--stdin" ? JSON.stringify({ referrer: "sunny-otter" }) : undefined);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr.trim(), "That is this bot's own referral name; a bot can't be referred by itself.");
  }
  assert.equal(gets(), 0);
  assert.equal(b.saved().referrer, undefined);
  // another name is fine
  hub.state.names.set("calm-heron", { signer: "x", payout: "y", payout_chain: "base", last: "" });
  assert.equal((await b.run(["settings", "set", "--referrer", "calm-heron"])).status, 0);
  assert.equal(b.saved().referrer, "calm-heron");
  assert.equal(b.saved().referral_name, "sunny-otter");
});
