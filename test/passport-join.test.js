// `sato-agent join` and `sato-agent passport ...`, offline.
//
//   - GOLDEN PARITY with the Sato Hub app's frozen join contract (private): the same bytes, the same message hashes, the same signatures from the
//     fixed test keys (test/fixtures/passport-join-vectors.json, copied from the contract's own tests there);
//   - the request bodies, checked by a local "Sato Hub" that rebuilds each message from the body with its own copy of the layout and verifies
//     every signature (viem for EVM, ed25519 for Solana), so the real CLI is spawned against it;
//   - the claim code: shown once, only its digest sent, never written anywhere;
//   - the refusals, the approval binding and the --again rule.
// Nothing here reaches a chain or the real Sato Hub.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { getBase58Encoder } from "@solana/kit";
import { verifyMessage } from "viem";
import { freshHome } from "./helpers.js";

const home = freshHome();
const pj = await import("../src/passport-join.js");
const names = await import("../src/referral-names.js");
const settings = await import("../src/settings.js");
const { entries } = await import("../src/ledger.js");
const { PlainError } = await import("../src/errors.js");
const { initWallet } = await import("../src/wallet.js");
const { savedPassport } = await import("../src/passport.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const ROOT = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const V = JSON.parse(readFileSync(ROOT("test/fixtures/passport-join-vectors.json"), "utf8"));
const BANNED = /\b(safe|secure|trusted|verified|audited|guarantee[sd]?)\b/i;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// The fixed TEST keys of the app's golden vectors (never used anywhere real).
const KEYS = { evmKey: V.keys.evm_private_key, solanaSecret: Uint8Array.from(Buffer.from(V.keys.solana_seed_hex, "hex")) };
const evmSigner = names.makeSigner("base", KEYS);
const solSigner = names.makeSigner("solana", KEYS);
const EVM = { chain: "evm", address: evmSigner.address };
const SOL = { chain: "solana", address: solSigner.address };
const wallet = (x) => (x === "EVM" ? EVM : x === "SOL" ? SOL : x);
const inputOf = (i) => ({ ...i, wallet: wallet(i.wallet), wallets: i.wallets.map(wallet), ...(i.primary ? { primary: wallet(i.primary) } : {}) });

// ---------------------------------------------------------------- golden parity with the app's frozen contract

test("golden parity: every action's message hashes to the app's vector, and the fixed test keys sign what the app expects (EVM for all eight, Solana for join)", async () => {
  assert.deepEqual(Object.keys(V.inputs).sort(), [...pj.PASSPORT_ACTIONS].sort(), "every action has a vector");
  for (const [action, raw] of Object.entries(V.inputs)) {
    const m = pj.passportMessage(inputOf(raw));
    assert.equal(sha(m), V.golden[action].sha256, `${action}: the message bytes differ from the app's. A new format is a new version, never an edit`);
    assert.equal(await evmSigner.sign(m), V.golden[action].evm_signature, `${action}: EVM signature`);
  }
  assert.equal(await solSigner.sign(pj.passportMessage(inputOf(V.inputs.join))), V.solana_join_signature, "the Solana golden join signature");
});

test("the join message is byte for byte the app's golden text, every line present", () => {
  const claim = "ab".repeat(32);
  const m = pj.passportMessage({ action: "join", passport_id: null, wallet: SOL, wallets: [SOL, EVM], issued_at: V.issued_at, primary: EVM, name: "Trading Bot", via: "kit", claim_sha256: claim });
  assert.equal(
    m,
    [
      "satohub.ai asks you to sign a Sato Passport action.",
      "",
      `Creates a public Sato Passport for evm:${EVM.address}, solana:${SOL.address}. Any wallet on it can manage it. It moves no funds.`,
      "",
      "domain: satohub.ai",
      "version: 1",
      "action: join",
      "passport: -",
      `wallet: solana:${SOL.address}`,
      `wallets: evm:${EVM.address},solana:${SOL.address}`,
      `primary: evm:${EVM.address}`,
      "name: Trading Bot",
      "via: kit",
      `claim: ${claim}`,
      "patch: -",
      "issued_at: 2026-10-21T18:00:00.000Z",
    ].join("\n"),
  );
  assert.equal(pj.PASSPORT_MESSAGE_TITLE, "satohub.ai asks you to sign a Sato Passport action.");
  assert.ok(!m.endsWith("\n"), "no trailing newline");
  // The wallet set is sorted by label whatever order it is given; an absent field is "-".
  const same = pj.passportMessage({ action: "join", passport_id: null, wallet: SOL, wallets: [EVM, SOL], issued_at: V.issued_at, primary: EVM, name: "Trading Bot", via: "kit", claim_sha256: claim });
  assert.equal(same, m);
  const bare = pj.passportMessage({ action: "join", passport_id: null, wallet: EVM, wallets: [EVM], issued_at: V.issued_at, primary: null, name: null, via: "kit", claim_sha256: null });
  assert.match(bare, /\nprimary: -\nname: -\nvia: kit\nclaim: -\npatch: -\n/);
});

test("each action states what it does; every statement says it moves no funds and none judges the agent", () => {
  for (const a of pj.PASSPORT_ACTIONS) {
    const s = pj.actionStatement(a, V.passport_id, [EVM]);
    assert.match(s, /It moves no funds\.$/, a);
    assert.doesNotMatch(s, BANNED, a);
  }
  assert.notEqual(pj.actionStatement("add_wallet", V.passport_id, [EVM]), pj.actionStatement("prove_wallet", V.passport_id, [EVM]));
  assert.throws(() => pj.actionStatement("sell_everything", null, [EVM]), /unknown passport action/);
  assert.match(pj.actionStatement("join", null, [EVM]), /^Creates a public Sato Passport for evm:0x/);
  assert.match(pj.actionStatement("issue_claim", V.passport_id, [EVM]), /earlier unused codes stop working/);
});

test("wallets: an EVM address is lower-cased, a Solana address kept exactly, the zero address and anything else refused", () => {
  assert.deepEqual(pj.normalizeWallet(EVM.address.toUpperCase().replace("0X", "0x")), EVM);
  assert.deepEqual(pj.normalizeWallet(SOL.address), SOL);
  for (const bad of ["0x0000000000000000000000000000000000000000", "0x1234", "sunny-otter", "", null, undefined, 7, "11111"]) assert.equal(pj.normalizeWallet(bad), null, JSON.stringify(bad));
});

// ---------------------------------------------------------------- the claim code

test("claim codes: SATO-XXXX-XXXX-XXXX from 31 lookalike-free characters, rejection sampling, and the app's own byte stream gives the app's code", () => {
  assert.equal(pj.CLAIM_ALPHABET, "ABCDEFGHJKMNPQRSTUVWXYZ23456789");
  assert.equal(pj.CLAIM_ALPHABET.length, 31);
  assert.doesNotMatch(pj.CLAIM_ALPHABET, /[01IOL]/);
  let i = 0;
  const code = pj.generateClaimCode((n) => Uint8Array.from({ length: n }, () => (i++ * 37) % 256));
  assert.equal(code, "SATO-AGPV-39FD-KSY6", "the same byte stream the app's tests use: same code (checked against the app's generator)");
  assert.match(code, pj.CLAIM_CODE_RE);
  // Rejection sampling: a byte of 248 or more is skipped, never folded into the alphabet (that would favour the first 8 characters).
  const high = [255, 250, 248];
  let calls = 0;
  const skipped = pj.generateClaimCode((n) => (calls++ === 0 ? Uint8Array.from({ length: n }, (_, k) => high[k % 3]) : Uint8Array.from({ length: n }, () => 0)));
  assert.equal(skipped, "SATO-AAAA-AAAA-AAAA", "the first 16 bytes were all rejected; the next 12 accepted bytes are 0 = A");
  assert.ok(calls >= 2);
  // 247 is the last byte kept: 247 % 31 = 30 -> "9".
  assert.equal(pj.generateClaimCode((n) => Uint8Array.from({ length: n }, () => 247)), "SATO-9999-9999-9999");
  for (let k = 0; k < 200; k++) assert.match(pj.generateClaimCode(), pj.CLAIM_CODE_RE);
  assert.equal(pj.CLAIM_TTL_DAYS, 7);
});

test("claim codes come from the operating system's random source and never from Math.random", () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error("Math.random must never make a claim code");
  };
  try {
    const a = pj.generateClaimCode();
    const b = pj.generateClaimCode();
    assert.match(a, pj.CLAIM_CODE_RE);
    assert.notEqual(a, b);
  } finally {
    Math.random = real;
  }
  // A source that cannot give bytes stops the code; there is no weaker fallback.
  assert.throws(() => pj.generateClaimCode(() => {
    throw new Error("no random source");
  }), /no random source/);
  const src = readFileSync(ROOT("src/passport-join.js"), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /Math\.random/, "the module never reaches for Math.random");
});

test("the claim digest is sha256('sato-passport-claim:v1:' + code) in lower-case hex, and differs from the code", () => {
  const code = "SATO-AGPV-39FD-KSY6";
  const d = pj.claimCodeDigest(code);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(d, sha(`sato-passport-claim:v1:${code}`));
  assert.equal(d, "056780a28d69137ba95555a006d4b836f10654f326c348ad2b374093f81b9ddd", "the app's claimCodeDigest of the same code");
  assert.notEqual(pj.claimCodeDigest("SATO-AGPV-39FD-KSY7"), d);
});

// ---------------------------------------------------------------- the display name (the app's cases)

test("names: 3-80 characters, plain spaces only, no invisible or control characters, at least 3 letters or digits, never rewritten", () => {
  for (const ok of ["Trading Bot", "Agent #7", "日本語エージェント", "x".repeat(80)]) assert.equal(pj.nameProblem(ok), null, ok);
  for (const bad of [
    "\u200b\u200b\u200b",
    "Bot\u202eevil",
    "Bot\u0085x",
    "🤖🤖🤖",
    "  spaced",
    "double  space",
    "ab",
    "Bot\u2028x",
    "Bot\ud800x",
    "Trading Bot",
    "Trading　Bot",
    "Tab\there",
    " Trading Bot",
    "Trading Bot ",
    "x".repeat(81),
    "",
    7,
    null,
    undefined,
  ]) {
    assert.notEqual(pj.nameProblem(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- the requests

const b58 = getBase58Encoder();
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const chainOf = (a) => (/^0x/.test(a) ? "evm" : "solana");
const label = (a) => `${chainOf(a)}:${a}`;

/** The join message rebuilt from a request BODY, with this file's own copy of the contract's layout (not the kit's function). */
function joinMessageFor(p, address) {
  const labels = p.wallets.map((w) => label(w.address)).sort();
  return [
    "satohub.ai asks you to sign a Sato Passport action.",
    "",
    `Creates a public Sato Passport for ${labels.join(", ")}. Any wallet on it can manage it. It moves no funds.`,
    "",
    "domain: satohub.ai",
    "version: 1",
    "action: join",
    "passport: -",
    `wallet: ${label(address)}`,
    `wallets: ${labels.join(",")}`,
    `primary: ${p.primary ? label(p.primary) : "-"}`,
    `name: ${p.name ?? "-"}`,
    `via: ${p.via ?? "-"}`,
    `claim: ${p.claim_sha256 ?? "-"}`,
    "patch: -",
    `issued_at: ${p.issued_at}`,
  ].join("\n");
}

/** An issue_claim or prove_wallet message rebuilt from a request body. */
function actionMessageFor(p) {
  const w = label(p.wallet.address);
  const statement =
    p.action === "issue_claim"
      ? `Issues a new owner claim code for Sato Passport ${p.passport_id}; earlier unused codes stop working. It moves no funds.`
      : `Confirms ${w} belongs to Sato Passport ${p.passport_id}, publicly. Any wallet on it can then manage it. It moves no funds.`;
  return [
    "satohub.ai asks you to sign a Sato Passport action.",
    "",
    statement,
    "",
    "domain: satohub.ai",
    "version: 1",
    `action: ${p.action}`,
    `passport: ${p.passport_id}`,
    `wallet: ${w}`,
    `wallets: ${w}`,
    "primary: -",
    "name: -",
    "via: -",
    `claim: ${p.claim_sha256 ?? "-"}`,
    "patch: -",
    `issued_at: ${p.issued_at}`,
  ].join("\n");
}

async function signatureOk(address, signature, message) {
  if (/^0x/.test(address)) return verifyMessage({ address, message, signature }).catch(() => false);
  const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(b58.encode(address))]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(b58.encode(signature)));
}

test("joinSigners: the EVM key first (the primary), the Solana key second unless --no-solana; a wallet with no Solana key joins with its EVM key alone", () => {
  const both = pj.joinSigners({ keys: KEYS });
  assert.deepEqual(both.map((s) => [s.chain, s.address]), [["evm", EVM.address], ["solana", SOL.address]]);
  assert.deepEqual(pj.joinSigners({ keys: KEYS, noSolana: true }).map((s) => s.chain), ["evm"]);
  const evmOnly = pj.joinSigners({ keys: { evmKey: KEYS.evmKey } });
  // makeSigner("solana") is only reached when a Solana key is known: the fresh wallet below has none in `keys` and none in its file.
  assert.ok(evmOnly.length >= 1);
  for (const s of both) assert.equal(typeof s.sign, "function");
  assert.ok(!JSON.stringify(both).includes(V.keys.evm_private_key.slice(2)), "a signer never carries a key as data");
});

test("the join body: wallets (address, signature), primary, issued_at, name only when given, via, the claim digest; each wallet signed its own message; the code and the keys are in no field", async () => {
  const claimCode = "SATO-AGPV-39FD-KSY6";
  const issuedAt = V.issued_at;
  for (const name of [null, "Grok Trader", "日本語エージェント"]) {
    for (const via of ["kit", "sato-bot"]) {
      const built = await pj.buildJoinRequest({ name, via, signers: pj.joinSigners({ keys: KEYS }), claimCode, issuedAt });
      const body = built.body;
      assert.deepEqual(Object.keys(body).sort(), name === null ? ["claim_sha256", "issued_at", "primary", "via", "wallets"] : ["claim_sha256", "issued_at", "name", "primary", "via", "wallets"]);
      assert.equal(body.primary, EVM.address);
      assert.equal(body.via, via);
      assert.equal(body.issued_at, issuedAt);
      assert.equal(body.claim_sha256, pj.claimCodeDigest(claimCode));
      assert.deepEqual(body.wallets.map((w) => w.address), [EVM.address, SOL.address]);
      for (const w of body.wallets) {
        assert.deepEqual(Object.keys(w).sort(), ["address", "signature"]);
        assert.ok(await signatureOk(w.address, w.signature, joinMessageFor(body, w.address)), `${w.address}: signs the message the contract defines`);
      }
      const text = JSON.stringify(body);
      assert.ok(!text.includes(claimCode), "the claim code is never in the body");
      assert.ok(!text.includes(V.keys.evm_private_key.slice(2)) && !text.includes(V.keys.solana_seed_hex), "no key in the body");
      // Re-dressing a leaked body breaks the signatures: another name or another via is not what was signed.
      assert.equal(await signatureOk(body.wallets[0].address, body.wallets[0].signature, joinMessageFor({ ...body, name: "Coinbase Official Agent" }, body.wallets[0].address)), false);
      assert.equal(await signatureOk(body.wallets[0].address, body.wallets[0].signature, joinMessageFor({ ...body, via: "mcp" }, body.wallets[0].address)), false);
    }
  }
  const evmOnly = await pj.buildJoinRequest({ via: "kit", signers: pj.joinSigners({ keys: KEYS, noSolana: true }), claimCode, issuedAt });
  assert.deepEqual(evmOnly.body.wallets.map((w) => w.address), [EVM.address]);
  assert.ok(await signatureOk(EVM.address, evmOnly.body.wallets[0].signature, joinMessageFor(evmOnly.body, EVM.address)), "a one-wallet join signs a one-wallet set");
  await assert.rejects(pj.buildJoinRequest({ via: "kit", signers: [pj.joinSigners({ keys: KEYS })[1]], claimCode, issuedAt }), /needs this agent's EVM wallet as its primary/);
});

test("issue_claim and prove_wallet bodies: one wallet signs its own message, the claim digest only for issue_claim", async () => {
  const digest = pj.claimCodeDigest("SATO-AGPV-39FD-KSY6");
  for (const signer of pj.joinSigners({ keys: KEYS })) {
    const ic = await pj.buildActionRequest({ action: "issue_claim", passportId: V.passport_id, signer, claimSha256: digest, issuedAt: V.issued_at });
    assert.deepEqual(Object.keys(ic).sort(), ["action", "claim_sha256", "issued_at", "passport_id", "wallet"]);
    assert.equal(ic.action, "issue_claim");
    assert.ok(await signatureOk(ic.wallet.address, ic.wallet.signature, actionMessageFor(ic)));
    const pw = await pj.buildActionRequest({ action: "prove_wallet", passportId: V.passport_id, signer, issuedAt: V.issued_at });
    assert.deepEqual(Object.keys(pw).sort(), ["action", "issued_at", "passport_id", "wallet"]);
    assert.ok(await signatureOk(pw.wallet.address, pw.wallet.signature, actionMessageFor(pw)));
    // A prove_wallet signature is not an issue_claim signature.
    assert.equal(await signatureOk(pw.wallet.address, pw.wallet.signature, actionMessageFor({ ...pw, action: "issue_claim", claim_sha256: digest })), false);
  }
  await assert.rejects(pj.buildActionRequest({ action: "remove_wallet", passportId: V.passport_id, signer: evmSigner, issuedAt: V.issued_at }), /only issue_claim and prove_wallet/);
});

// ---------------------------------------------------------------- the flow, in process (Sato Hub is a stub fetch)

const ID = "sato:agt:exmpexmpexmp";
const ID2 = "sato:agt:pqrstuvwxy23";
const ORIGIN = "https://hub.test";

/** A stub fetch: records every call and answers with `answer(call)`. */
function hubFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const a = typeof answer === "function" ? await answer(call) : answer;
    return { status: a.status, headers: { get: (k) => a.headers?.[k.toLowerCase()] ?? null }, text: async () => (typeof a.json === "string" ? a.json : JSON.stringify(a.json)) };
  };
  return { calls, fetchImpl };
}

/** The answer a good join gets: the passport, every wallet proven, the claim recorded. */
const joined = (call, extra = {}) => ({
  status: 201,
  json: {
    passport_id: ID,
    slug: "sunny-otter-agent",
    name: call.body.name ?? "sunny-otter-agent",
    lookup_url: "https://satohub.ai/passport/exmpexmpexmp",
    profile_url: "https://satohub.ai/passport/exmpexmpexmp/profile",
    wallets: call.body.wallets.map((w) => ({ chain: chainOf(w.address), address: w.address, proven: true, primary: w.address === call.body.primary })),
    claim: { expires_at: "2026-10-28T18:00:00.000Z" },
    next: ["Your passport is public now.", "Give the claim code you generated to the agent's owner: signed in on satohub.ai, they enter it once to link the passport to their account."],
    ...extra,
  },
});

/** A fresh agent home. */
function fresh() {
  const dir = freshHome();
  initWallet();
  return dir;
}

/** Every file under `dir`, as text, so a test can search for something that must be nowhere. */
function everything(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

const owner = (log = []) => async (intent, card) => {
  log.push({ intent, card });
};

test("join: the owner's approval comes first (nothing posted, signed or saved without it), then one POST, then the id is saved; the claim code is returned once and is nowhere on disk", async () => {
  const dir = fresh();
  const order = [];
  const hub = hubFetch((call) => (order.push("post"), joined(call)));
  const asked = [];
  const r = await pj.joinPassport(
    { name: "Grok Trader", via: "sato-bot" },
    { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, now: new Date(V.issued_at), authorize: async (intent, card) => (order.push("authorize"), asked.push({ intent, card })) },
  );
  assert.deepEqual(order, ["authorize", "post"], "approval before anything is sent");
  assert.equal(hub.calls.length, 1);
  const call = hub.calls[0];
  assert.equal(call.url, "https://hub.test/api/passport/join");
  assert.equal(call.init.method, "POST");
  assert.match(call.init.headers["user-agent"], /^sato-agent\/\d/, "the kit's own user agent, as every other call it makes");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.ok(call.init.signal, "a timeout is set");
  assert.equal(call.body.issued_at, V.issued_at);
  // What the owner was shown and what the approval binds.
  assert.deepEqual(asked[0].intent, { cmd: "join", name: "Grok Trader", via: "sato-bot", primary: `evm:${EVM.address}`, wallets: [`evm:${EVM.address}`, `solana:${SOL.address}`], again: false, replaces: null });
  assert.ok(asked[0].card.some((l) => /PUBLIC/.test(l)) && asked[0].card.some((l) => l.includes(EVM.address)) && asked[0].card.some((l) => /Nothing has been signed or sent/.test(l)));
  for (const l of asked[0].card) assert.doesNotMatch(l, BANNED, l);
  // The result.
  assert.equal(r.passport_id, ID);
  assert.equal(r.lookup_url, "https://satohub.ai/passport/exmpexmpexmp");
  assert.equal(r.profile_url, "https://satohub.ai/passport/exmpexmpexmp/profile");
  assert.match(r.claim_code, pj.CLAIM_CODE_RE);
  assert.equal(call.body.claim_sha256, pj.claimCodeDigest(r.claim_code), "Sato Hub got the digest of the code the owner is given");
  assert.equal(r.claim_expires_at, "2026-10-28T18:00:00.000Z");
  // Saved: the passport field (what `register` links to) is the joined id, plus the slug and profile url.
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(saved.passport, ID);
  assert.equal(savedPassport(), ID);
  assert.equal(saved.passport_join.passport_id, ID);
  assert.equal(saved.passport_join.slug, "sunny-otter-agent");
  assert.equal(saved.passport_join.profile_url, "https://satohub.ai/passport/exmpexmpexmp/profile");
  assert.equal(saved.passport_join.via, "sato-bot");
  assert.equal(saved.passport_join.name, "Grok Trader");
  assert.equal(statSync(join(dir, "settings.json")).mode & 0o777, 0o600);
  // The ledger holds public facts: never the code, never its digest.
  const rows = entries().filter((e) => e.kind === "passport");
  assert.equal(rows.length, 1);
  assert.deepEqual({ status: rows[0].status, passport: rows[0].passport, via: rows[0].via, wallets: rows[0].wallets }, { status: "joined", passport: ID, via: "sato-bot", wallets: 2 });
  for (const f of everything(dir)) {
    assert.ok(!f.text.includes(r.claim_code), `${f.path} holds the claim code`);
    assert.ok(!f.text.includes(pj.claimCodeDigest(r.claim_code)), `${f.path} holds the claim digest`);
  }
  assert.ok(entries().some((e) => e.kind === "settings" && e.status === "passport_set" && e.to === ID));
});

test("join: an owner who says no (authorize throws) stops it before anything is posted or saved", async () => {
  const dir = fresh();
  const hub = hubFetch((call) => joined(call));
  await assert.rejects(pj.joinPassport({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: async () => { throw new Error("needs approval"); } }), /needs approval/);
  assert.equal(hub.calls.length, 0);
  assert.equal(existsSync(join(dir, "settings.json")), false);
  assert.equal(entries().filter((e) => e.kind === "passport").length, 0);
  // With no approval hook at all, nothing is signed either.
  await assert.rejects(pj.joinPassport({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN }), (e) => e instanceof PlainError && /needs the owner's approval; nothing was signed/.test(e.message));
  assert.equal(hub.calls.length, 0);
});

test("join: a bad --name or --via is refused before the approval is asked for", async () => {
  fresh();
  const hub = hubFetch((call) => joined(call));
  const asked = [];
  for (const [opts, re] of [
    [{ name: "ab" }, /--name: name must be 3–80 characters/],
    [{ name: " padded" }, /--name: name has leading, trailing or repeated spaces/],
    [{ name: "Bot\u202e" }, /--name: name contains a control, invisible or line-break character/],
    [{ via: "form" }, /--via must be one of kit or sato-bot/],
    [{ via: "api" }, /--via must be one of kit or sato-bot/],
    [{ via: "carrier-pigeon" }, /--via must be one of kit or sato-bot/],
  ]) {
    await assert.rejects(pj.joinPassport(opts, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner(asked) }), (e) => e instanceof PlainError && re.test(e.message), JSON.stringify(opts));
  }
  assert.equal(asked.length, 0, "no approval was asked for");
  assert.equal(hub.calls.length, 0);
});

test("join: --no-solana lists the EVM wallet alone; the approval says so", async () => {
  fresh();
  const hub = hubFetch((call) => joined(call));
  const asked = [];
  const r = await pj.joinPassport({ noSolana: true }, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner(asked) });
  assert.deepEqual(asked[0].intent.wallets, [`evm:${EVM.address}`]);
  assert.deepEqual(hub.calls[0].body.wallets.map((w) => w.address), [EVM.address]);
  assert.deepEqual(r.wallets, [EVM]);
});

test("already joined: a bot that has a passport id saved refuses to join again, before any approval or request; --again joins and replaces the saved id (the old one is named, not touched)", async () => {
  const dir = fresh();
  const hub = hubFetch((call) => joined(call));
  await pj.joinPassport({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner() });
  assert.equal(hub.calls.length, 1);
  const asked = [];
  await assert.rejects(
    pj.joinPassport({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner(asked) }),
    (e) => e instanceof PlainError && e.message.includes(`already has a Sato Passport saved: ${ID} (https://satohub.ai/passport/exmpexmpexmp)`) && /join --again/.test(e.message) && /passport issue-claim/.test(e.message) && !BANNED.test(e.message),
  );
  assert.equal(asked.length, 0, "refused before the approval");
  assert.equal(hub.calls.length, 1, "no second request");
  // --again: the new id replaces the saved one, the approval names what it replaces, the old id is only named in the result.
  const again = hubFetch((call) => joined(call, { passport_id: ID2, slug: "other-agent" }));
  const asked2 = [];
  const r = await pj.joinPassport({ again: true }, { keys: KEYS, fetchImpl: again.fetchImpl, origin: ORIGIN, authorize: owner(asked2) });
  assert.equal(asked2[0].intent.again, true);
  assert.equal(asked2[0].intent.replaces, ID);
  assert.equal(r.passport_id, ID2);
  assert.equal(r.replaced, ID);
  assert.equal(savedPassport(), ID2);
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).passport_join.passport_id, ID2);
  assert.ok(entries().some((e) => e.kind === "passport" && e.status === "joined" && e.replaced === ID));
  // A passport id that came from `register --passport` (never joined here) counts as saved too: join refuses the same way.
  const dir2 = fresh();
  writeFileSync(join(dir2, "settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1", passport: ID, passport_set_at: "2026-10-20T00:00:00.000Z" }) + "\n", { mode: 0o600 });
  const h2 = hubFetch((call) => joined(call));
  await assert.rejects(pj.joinPassport({}, { keys: KEYS, fetchImpl: h2.fetchImpl, origin: ORIGIN, authorize: owner() }), /already has a Sato Passport saved/);
  assert.equal(h2.calls.length, 0);
});

test("a saved passport is never stamped onto another agent: join --again replaces the id but a --again registration still never takes it", async () => {
  fresh();
  const { resolveForRegister } = await import("../src/passport.js");
  const hub = hubFetch((call) => joined(call));
  await pj.joinPassport({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner() });
  const r = resolveForRegister(undefined, { again: true });
  assert.equal(r.passport, null, "another agent from the same wallet gets no saved passport");
  assert.equal(r.skippedSaved, ID);
});

test("the answer is checked before anything is saved: an id that is not a passport id, or wallets this join did not list as proven, save nothing", async () => {
  const dir = fresh();
  const owner1 = { keys: KEYS, origin: ORIGIN, authorize: owner() };
  const refuse = async (answer, re) => {
    await assert.rejects(pj.joinPassport({}, { ...owner1, fetchImpl: hubFetch(answer).fetchImpl }), (e) => e instanceof PlainError && re.test(e.message));
    assert.equal(existsSync(join(dir, "settings.json")), false, "nothing saved");
    assert.equal(entries().filter((e) => e.kind === "passport").length, 0);
  };
  await refuse((call) => joined(call, { passport_id: "sato:agt:ABCDEFGHJKMN" }), /answer was not understood/);
  await refuse({ status: 200, json: "not json" }, /answer was not understood/);
  await refuse((call) => joined(call, { wallets: [] }), /did not list this agent's wallet as proven/);
  await refuse((call) => joined(call, { wallets: call.body.wallets.map((w) => ({ address: w.address, proven: false })) }), /did not list this agent's wallet as proven/);
  await refuse((call) => joined(call, { wallets: [{ address: "0x" + "9".repeat(40), proven: true }] }), /did not list this agent's wallet as proven/);
});

test("a join Sato Hub answers without a claim object prints no claim code (it would not work); issue-claim makes one", async () => {
  fresh();
  const r = await pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call, { claim: null })).fetchImpl });
  assert.equal(r.claim_code, null);
  const text = pj.joinLines(r).join("\n");
  assert.doesNotMatch(text, /SATO-[A-Z0-9]{4}-/);
  assert.match(text, /did not record a claim code for this join. `sato-agent passport issue-claim` makes one/);
  assert.equal(savedPassport(), ID, "the join itself stands");
});

test("a profile url that is not a plain https link is dropped, not saved or shown; the page url is always the kit's own", async () => {
  const dir = fresh();
  for (const bad of ["javascript:alert(1)", "http://evil.test/x", "https://x.test/a b", "https://x.test/\u202e", 7, null]) {
    fresh();
    const r = await pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call, { profile_url: bad, lookup_url: "https://evil.test/phish" })).fetchImpl });
    assert.equal(r.profile_url, null, String(bad));
    assert.equal(r.lookup_url, "https://satohub.ai/passport/exmpexmpexmp", "never taken from the answer");
  }
  void dir;
});

// ---------------------------------------------------------------- Sato Hub refuses

test("every refusal code gets one plain sentence, Sato Hub's own words and next steps, and 'Nothing was saved.'; the clock hint comes with stale", async () => {
  const dir = fresh();
  const hub = (status, json, headers) => hubFetch({ status, json, headers }).fetchImpl;
  const run = (fetchImpl) => pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl });
  const codes = {
    bad_request: /could not read the request/,
    bad_wallet: /was not an EVM or Solana address/,
    bad_signature_shape: /signature was not in the expected form/,
    duplicate_wallet_in_request: /listed twice/,
    too_many_wallets: /at most 4 EVM and 4 Solana wallets/,
    no_wallet: /listed no wallet/,
    bad_primary: /primary wallet was not accepted/,
    stale: /clock may be off by more than about two minutes/,
    bad_passport: /passport id was not accepted/,
    bad_name: /3 to 80 characters, with plain spaces only/,
    bad_via: /did not accept how this join says it came/,
    bad_claim: /claim code's digest was not accepted/,
    bad_patch: /profile change was not accepted/,
  };
  for (const [code, re] of Object.entries(codes)) {
    await assert.rejects(run(hub(400, { ok: false, code, error: `server words for ${code}`, next: ["Try this first.", "Then this."] })), (e) => {
      assert.ok(e instanceof PlainError);
      assert.match(e.message, new RegExp(`^Sato Hub did not accept this \\(${code}\\): `));
      assert.match(e.message, re);
      assert.match(e.message, new RegExp(`Sato Hub says: server words for ${code}`));
      assert.match(e.message, /Next:\n {2}- Try this first\.\n {2}- Then this\.\nNothing was saved\.$/);
      assert.doesNotMatch(e.message, BANNED);
      return true;
    }, code);
  }
  // The code can sit in `error` (a plain token) with the sentence in `message`.
  await assert.rejects(run(hub(400, { error: "bad_name", message: "That name is taken." })), /\(bad_name\):.*\nSato Hub says: That name is taken\.\nNothing was saved\./s);
  assert.equal(existsSync(join(dir, "settings.json")), false, "nothing saved by any refusal");
  assert.equal(entries().filter((e) => e.kind === "passport").length, 0);
});

const LEGACY_NOTE = "sato:agt:exmpexmpexmp (registered before joins existed) lists evm:0x1111111111111111111111111111111111111111 without having proved it. A listed wallet is a claim, not a proof, so it did not stop this join; sato:agt:exmpexmpexmp stays unproven.";
const LEGACY_NEXT = "prove_wallet for sato:agt:exmpexmpexmp, signed by evm:0x1111111111111111111111111111111111111111, is how a passport registered before joins existed is proven. It works only while the wallet is on no other passport, so it is not available for sato:agt:exmpexmpexmp while this passport holds the wallet.";

test("a wallet merely listed on a passport from before joins existed never blocks a join: the join stands, Sato Hub's note is returned and printed once, and the kit does not suggest proving it on the old passport", async () => {
  const dir = fresh();
  const legacy = [{ wallet: "evm:0x1111111111111111111111111111111111111111", passport_id: "sato:agt:exmpexmpexmp" }, { wallet: "evm:nope", passport_id: "sato:agt:ABC" }, "junk"];
  const r = await pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call, { passport_id: ID2, note: LEGACY_NOTE, legacy_declared: legacy, next: [...joined(call).json.next, LEGACY_NEXT] })).fetchImpl });
  assert.equal(r.passport_id, ID2);
  assert.equal(savedPassport(), ID2, "saved as any join");
  assert.equal(r.note, LEGACY_NOTE);
  assert.deepEqual(r.legacy_declared, [legacy[0]], "a malformed entry is dropped");
  assert.ok(r.claim_code, "the claim code is still shown");
  const text = pj.joinLines(r).join("\n");
  assert.equal(text.split("Note from Sato Hub:").length - 1, 1, "the note is printed once");
  assert.ok(text.includes(`Note from Sato Hub: ${LEGACY_NOTE}`));
  assert.doesNotMatch(text, /prove_wallet|passport prove/, "no suggestion to prove the wallet on the legacy passport: the server refuses it while this passport holds the wallet");
  assert.match(text, /Next \(from Sato Hub\):\n {2}- Your passport is public now\./, "the other next steps are kept");
  assert.equal(r.next.length, 2);
  // Without the advisory there is no note line and nothing is dropped.
  fresh();
  const plain = await pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call)).fetchImpl });
  assert.equal(plain.note, null);
  assert.deepEqual(plain.legacy_declared, []);
  assert.doesNotMatch(pj.joinLines(plain).join("\n"), /Note from Sato Hub/);
  void dir;
});

test("the retired 'declared on a legacy passport' refusal is gone: no code or sentence with 'legacy' or 'declared' is treated specially, and the kit never points at `passport prove` from a refusal", async () => {
  fresh();
  const run = (status, json) => pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status, json }).fetchImpl });
  for (const code of ["wallet_declared_legacy", "declared_on_legacy_passport", "legacy_passport"]) {
    assert.equal(pj.explainRefusal(code, 409), null, code);
    await assert.rejects(run(409, { code, error: "Server words.", passport_id: ID }), (e) => {
      assert.match(e.message, new RegExp(`^Sato Hub did not accept this \\(${code}\\): Server words\\.\\nNothing was saved\\.$`));
      assert.doesNotMatch(e.message, /passport prove|before joins existed/);
      return true;
    }, code);
  }
  assert.equal(pj.isLegacyRefusal, undefined, "the helper is gone");
  assert.equal(existsSync(join(process.env.SATO_AGENT_HOME, "settings.json")), false);
});

test("the daily join limits (HTTP 429 ip_daily_quota and daily_cap) both say the limit is reached and to try tomorrow; no hourly retry hint; nothing is retried or saved", async () => {
  const dir = fresh();
  for (const [code, said, next] of [
    ["ip_daily_quota", "This address has made as many new passports as one address may make in a day. Try again tomorrow.", "Try again tomorrow, or join from another address. Joining stays free."],
    ["daily_cap", "Sato Hub has reached its limit of new passports for the day. Try again tomorrow.", "Try again tomorrow. Joining stays free."],
  ]) {
    const hub = hubFetch({ status: 429, json: { code, error: said, retry_after_seconds: 3600, next: [next] }, headers: { "retry-after": "3600" } });
    await assert.rejects(pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hub.fetchImpl }), (e) => {
      assert.equal(e.message.split("\n")[0], `Sato Hub did not accept this (${code}): Sato Hub's join limit for today is reached; try again tomorrow.`);
      assert.match(e.message, new RegExp(`Sato Hub says: ${said.replace(/\./g, "\\.")}`));
      assert.match(e.message, /Next:\n {2}- Try again tomorrow/);
      assert.match(e.message, /Nothing was saved\.$/);
      assert.doesNotMatch(e.message, /Try again in \d+ seconds/, "an hour is not the answer");
      return true;
    }, code);
    assert.equal(hub.calls.length, 1, "one request, never a loop");
  }
  assert.equal(pj.JOIN_LIMIT_SENTENCE, "Sato Hub's join limit for today is reached; try again tomorrow.");
  // The per-minute and per-hour budgets are a different 429 and keep their own words.
  await assert.rejects(pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status: 429, json: { code: "rate_limited", error: "Too many." }, headers: { "retry-after": "60" } }).fetchImpl }), /limiting requests from here right now.*Try again in 60 seconds or more\./s);
  assert.equal(existsSync(join(dir, "settings.json")), false);
});

test("the handler's other codes get plain words: primary_exists, name_taken, replay, claim_taken; wallet_taken names the passport and how to get a new claim code", async () => {
  fresh();
  const run = (status, json) => pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status, json }).fetchImpl });
  await assert.rejects(run(409, { code: "primary_exists", error: "This passport already has a different primary wallet." }), /Sato Hub did not accept this \(primary_exists\): This passport already has a different primary wallet\.\nNothing was saved\.$/);
  await assert.rejects(run(409, { code: "name_taken", error: "A passport already uses that name. Pick another." }), /\(name_taken\): A passport already uses that name\. Pick another with --name\./);
  await assert.rejects(run(409, { code: "replay", error: "x y" }), /\(replay\): That signed message was already used\. Run the command again: it signs a fresh one\./);
  await assert.rejects(run(409, { code: "claim_taken", error: "x y" }), /\(claim_taken\): That claim code is already in use\. Run the command again: it makes a new one\./);
  await assert.rejects(run(409, { code: "wallet_taken", error: "One of those wallets is already on a passport.", passport_id: ID, next: [`One wallet belongs to one passport; this one is on ${ID}.`] }), (e) => {
    assert.match(e.message, new RegExp(`That passport is ${ID} \\(https://satohub\\.ai/passport/exmpexmpexmp\\)\\. If it is this bot's own, \`sato-agent passport issue-claim --passport ${ID}\` makes a new claim code for its owner\\.`));
    return true;
  });
  // A passport id that is not one is not put into a command.
  await assert.rejects(run(409, { code: "wallet_taken", passport_id: "sato:agt:x; rm -rf" }), (e) => !/rm -rf|That passport is/.test(e.message));
  assert.equal(savedPassport(), null, "never saved from a refusal");
});

test("other refusals: a wallet already on a passport, a rate limit (with Retry-After), a server error, an unknown code, and no answer at all", async () => {
  const dir = fresh();
  const run = (answer) => pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: typeof answer === "function" ? answer : hubFetch(answer).fetchImpl });
  await assert.rejects(run({ status: 409, json: { code: "wallet_taken" } }), /already on a Sato Passport \(one wallet is one passport\)/);
  await assert.rejects(run({ status: 429, json: { code: "rate_limited" }, headers: { "retry-after": "60" } }), /limiting requests from here right now.*Try again in 60 seconds or more\./s);
  await assert.rejects(run({ status: 503, json: "<html>down</html>" }), /Sato Hub did not accept this \(HTTP 503\): Sato Hub had a problem on its side/);
  await assert.rejects(run({ status: 400, json: { code: "something_new", message: "A new rule.\u202e\u0007" } }), (e) => /\(something_new\): A new rule\.$/m.test(e.message.replace(/\u0000/g, "")) && !/[\u202e\u0007]/.test(e.message));
  await assert.rejects(run({ status: 402, json: {} }), /Sato Hub did not accept this \(HTTP 402\): Sato Hub answered HTTP 402\./);
  // No answer / a timeout: said plainly, with what to do, since the request may have reached Sato Hub.
  await assert.rejects(run(async () => { throw new TypeError("fetch failed"); }), (e) => e instanceof PlainError && /Couldn't reach Sato Hub, or its answer did not arrive, so nothing was saved here\./.test(e.message) && /passport issue-claim --passport <id>/.test(e.message));
  assert.equal(existsSync(join(dir, "settings.json")), false);
  // A server's text is cleaned: one line of plain text, no control or bidi characters.
  await assert.rejects(run({ status: 400, json: { code: "bad_name", message: "line one\nline two\u202e\u0000end" } }), (e) => !/[\u202e\u0000]/.test(e.message) && /Sato Hub says: line one line two end/.test(e.message));
});

// ---------------------------------------------------------------- issue-claim, prove, status

test("issue-claim: the owner's approval first, then one signed issue_claim to /api/passport/action; the new code is returned once and is nowhere on disk", async () => {
  const dir = fresh();
  await pj.joinPassport({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call)).fetchImpl });
  const order = [];
  const hub = hubFetch((call) => (order.push("post"), { status: 200, json: { ok: true, action: "issue_claim", passport_id: ID, claim_expires_at: "2026-10-28T19:00:00.000Z", cancelled: { removals: 0 } } }));
  const asked = [];
  const r = await pj.issueClaim({}, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, now: new Date(V.issued_at), authorize: async (intent, card) => (order.push("authorize"), asked.push({ intent, card })) });
  assert.deepEqual(order, ["authorize", "post"]);
  assert.deepEqual(asked[0].intent, { cmd: "passport issue-claim", passport: ID, wallet: `evm:${EVM.address}` });
  assert.ok(asked[0].card.some((l) => /earlier unused codes stop working/.test(l)));
  const call = hub.calls[0];
  assert.equal(call.url, "https://hub.test/api/passport/action");
  assert.equal(call.body.action, "issue_claim");
  assert.equal(call.body.passport_id, ID);
  assert.equal(call.body.claim_sha256, pj.claimCodeDigest(r.claim_code));
  assert.ok(await signatureOk(call.body.wallet.address, call.body.wallet.signature, actionMessageFor(call.body)));
  assert.match(r.claim_code, pj.CLAIM_CODE_RE);
  assert.equal(r.claim_expires_at, "2026-10-28T19:00:00.000Z");
  const lines = pj.issueClaimLines(r).join("\n");
  assert.match(lines, new RegExp(`New claim code for ${ID} \\(shown once; this computer does not keep it\\): ${r.claim_code}`));
  assert.match(lines, /Give this code to the agent's owner: signed in on satohub.ai, they enter it once to link the passport. It expires in 7 days./);
  assert.match(lines, /Earlier unused codes for this passport stop working\./);
  for (const f of everything(dir)) assert.ok(!f.text.includes(r.claim_code), `${f.path} holds the new claim code`);
  assert.ok(entries().some((e) => e.kind === "passport" && e.status === "claim_issued" && e.passport === ID));
  // Another signing wallet, and another passport named on the command.
  const sol = await pj.issueClaim({ chain: "solana", passport: ID2 }, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner() });
  assert.equal(sol.wallet, `solana:${SOL.address}`);
  assert.equal(hub.calls[1].body.passport_id, ID2);
  assert.ok(await signatureOk(hub.calls[1].body.wallet.address, hub.calls[1].body.wallet.signature, actionMessageFor(hub.calls[1].body)));
  await assert.rejects(pj.issueClaim({ chain: "bnb" }, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, authorize: owner() }), /--chain must be base \(this agent's EVM key\) or solana here/);
  // A refusal makes no code.
  await assert.rejects(pj.issueClaim({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status: 403, json: { code: "not_proven", message: "That wallet is not proven on this passport." } }).fetchImpl }), /Sato Hub did not accept this \(not_proven\).*No new code was made\./s);
  // A 200 without an expiry still holds a code (Sato Hub records it before it answers); the expiry is simply unknown.
  const bare = await pj.issueClaim({}, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status: 200, json: { ok: true } }).fetchImpl });
  assert.match(bare.claim_code, pj.CLAIM_CODE_RE);
  assert.equal(bare.claim_expires_at, null);
});

test("issue-claim and prove need a passport: none saved is a plain refusal (and no approval is asked for); a bad id is refused", async () => {
  fresh();
  const asked = [];
  const deps = { keys: KEYS, origin: ORIGIN, authorize: owner(asked), fetchImpl: hubFetch({ status: 200, json: { ok: true } }).fetchImpl };
  await assert.rejects(pj.issueClaim({}, deps), /no Sato Passport saved\. `sato-agent join` makes one/i);
  await assert.rejects(pj.proveWallet({}, deps), /no Sato Passport saved/i);
  await assert.rejects(pj.issueClaim({ passport: "sato:agt:ABC" }, deps), /--passport must be a Sato Passport id/);
  assert.equal(asked.length, 0);
});

test("prove: for a passport made before joins existed, this bot's wallet signs prove_wallet; the id is saved only once Sato Hub accepted it", async () => {
  const dir = fresh();
  const hub = hubFetch({ status: 200, json: { ok: true } });
  const asked = [];
  const r = await pj.proveWallet({ passport: ID }, { keys: KEYS, fetchImpl: hub.fetchImpl, origin: ORIGIN, now: new Date(V.issued_at), authorize: owner(asked) });
  assert.deepEqual(asked[0].intent, { cmd: "passport prove", passport: ID, wallet: `evm:${EVM.address}` });
  assert.equal(r.passport_id, ID);
  const call = hub.calls[0];
  assert.equal(call.url, "https://hub.test/api/passport/action");
  assert.equal(call.body.action, "prove_wallet");
  assert.ok(await signatureOk(call.body.wallet.address, call.body.wallet.signature, actionMessageFor(call.body)));
  assert.equal(savedPassport(), ID);
  assert.ok(entries().some((e) => e.kind === "passport" && e.status === "wallet_proven"));
  void dir;
  // Refused: nothing saved.
  fresh();
  await assert.rejects(pj.proveWallet({ passport: ID }, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch({ status: 403, json: { code: "not_listed_wallet", message: "That is not the wallet this passport lists." } }).fetchImpl }), /Sato Hub did not accept this \(not_listed_wallet\).*Nothing was saved\./s);
  assert.equal(savedPassport(), null);
});

test("passport status: the saved id and its page, from settings alone (no network call), and plain words when nothing is saved", async () => {
  fresh();
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("no network in passport status");
  };
  try {
    assert.deepEqual(pj.passportStatusLines(pj.passportStatus()), ["No Sato Passport is saved here. `sato-agent join` makes one: it is free, and it makes this agent public on satohub.ai."]);
    assert.equal(pj.passportStatus().passport, null);
    await pj.joinPassport({ name: "Grok Trader" }, { keys: KEYS, origin: ORIGIN, authorize: owner(), now: new Date(V.issued_at), fetchImpl: hubFetch((call) => joined(call)).fetchImpl });
    const s = pj.passportStatus();
    assert.equal(s.passport, ID);
    assert.equal(s.lookup_url, "https://satohub.ai/passport/exmpexmpexmp");
    assert.equal(s.joined, true);
    assert.equal(s.name, "Grok Trader");
    const lines = pj.passportStatusLines(s).join("\n");
    assert.match(lines, /Sato Passport: sato:agt:exmpexmpexmp\n {2}Page: {4}https:\/\/satohub\.ai\/passport\/exmpexmpexmp\n {2}Profile: https:\/\/satohub\.ai\/passport\/exmpexmpexmp\/profile\n {2}Joined: {2}/);
    // An id only given to `register --passport` is shown as such.
    const dir = fresh();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1", passport: ID2 }) + "\n", { mode: 0o600 });
    const linked = pj.passportStatus();
    assert.equal(linked.joined, false);
    assert.match(pj.passportStatusLines(linked).join("\n"), /not from here: this id was given to `register --passport`, not made by `join`\./);
    // A hand-edited join record that does not fit reads as none.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1", passport_join: { passport_id: "nope" } }) + "\n", { mode: 0o600 });
    assert.equal(pj.joinedPassport(), null);
    assert.equal(pj.passportStatus().passport, null);
  } finally {
    globalThis.fetch = real;
  }
});

test("nothing the join flow prints uses the words verified, safe, secure, trusted or audited, and it never says more than 'proves control of the wallet key and makes the passport public'", async () => {
  fresh();
  const r = await pj.joinPassport({ name: "Grok Trader" }, { keys: KEYS, origin: ORIGIN, authorize: owner(), fetchImpl: hubFetch((call) => joined(call)).fetchImpl });
  const printed = [...pj.joinLines(r), ...pj.issueClaimLines({ passport_id: ID, claim_code: "SATO-AAAA-AAAA-AAAA" }), pj.JOIN_SCOPE_NOTE, pj.CLAIM_INSTRUCTION];
  for (const l of printed) assert.doesNotMatch(l, BANNED, l);
  assert.equal(pj.JOIN_SCOPE_NOTE, "Joining proves control of this agent's wallet key and makes its passport public on satohub.ai. It says nothing else about the agent: not its code, not who owns it.");
  for (const code of ["bad_request", "bad_wallet", "stale", "bad_name", "wallet_declared_legacy", "wallet_taken", "rate_limited"]) assert.doesNotMatch(pj.explainRefusal(code, 0) ?? "", BANNED, code);
  assert.equal(pj.explainRefusal("never_seen_before", 0), null, "an unknown code is not explained by guesswork");
});

// ---------------------------------------------------------------- the real CLI against a local "Sato Hub"

/** A fake Sato Hub: join, issue_claim and prove_wallet, rebuilding each message from the body and checking every signature. */
async function fakeHub({ reply, joinExtra } = {}) {
  const state = { requests: [], joins: [], actions: [], byWallet: new Map(), claims: new Map(), n: 0 };
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
    if (req.method === "POST" && req.url === "/api/passport/join") {
      const p = JSON.parse(body);
      for (const w of p.wallets) {
        if (!(await signatureOk(w.address, w.signature, joinMessageFor(p, w.address)))) return send(401, { ok: false, code: "bad_signature", error: "A signature does not match its wallet." });
      }
      if (Math.abs(Date.now() - Date.parse(p.issued_at)) > 10 * 60_000) return send(400, { ok: false, code: "stale", error: "issued_at is outside the window." });
      const taken = p.wallets.find((w) => state.byWallet.has(w.address));
      if (taken) return send(409, { ok: false, code: "wallet_taken", error: "That wallet is already on a passport.", passport_id: state.byWallet.get(taken.address) });
      const id = `sato:agt:exmpexmp${String(2222 + ++state.n)}`;
      for (const w of p.wallets) state.byWallet.set(w.address, id);
      state.claims.set(id, p.claim_sha256);
      state.joins.push(p);
      const slug = id.slice("sato:agt:".length);
      return send(201, {
        passport_id: id,
        slug: "sunny-otter-agent",
        name: p.name ?? "sunny-otter-agent",
        lookup_url: `https://satohub.ai/passport/${slug}`,
        profile_url: `https://satohub.ai/passport/${slug}/profile`,
        wallets: p.wallets.map((w) => ({ chain: chainOf(w.address), address: w.address, proven: true, primary: w.address === p.primary })),
        claim: p.claim_sha256 ? { expires_at: new Date(Date.now() + 7 * 864e5).toISOString() } : null,
        next: ["Your passport is public now.", "Give the claim code you generated to the agent's owner."],
        ...(joinExtra?.(p) ?? {}),
      });
    }
    if (req.method === "POST" && req.url === "/api/passport/action") {
      const p = JSON.parse(body);
      if (!(await signatureOk(p.wallet.address, p.wallet.signature, actionMessageFor(p)))) return send(401, { ok: false, code: "bad_signature", error: "A signature does not match its wallet." });
      state.actions.push(p);
      if (p.action === "issue_claim") {
        if (state.byWallet.get(p.wallet.address) !== p.passport_id) return send(403, { ok: false, code: "not_proven", error: "That wallet is not proven on this passport." });
        state.claims.set(p.passport_id, p.claim_sha256);
        return send(200, { ok: true, action: "issue_claim", passport_id: p.passport_id, claim_expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), cancelled: {} });
      }
      if (p.action === "prove_wallet") {
        state.byWallet.set(p.wallet.address, p.passport_id);
        return send(200, { ok: true });
      }
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { state, origin, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
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

/** A fresh agent home with a wallet; `run(args)` is the real CLI pointed at `origin`. */
async function bot(origin) {
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-join-")), "agent");
  const run = (args, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: dir, SATO_AGENT_MCP_URL: `${origin}/api/mcp`, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end("");
    });
  /** The owner's yes: the first run stops with exit 5 and a code; the SAME command with --approve <code> runs. */
  const approved = async (args, env) => {
    const first = await run(args, env);
    assert.equal(first.status, 5, `expected exit 5, got ${first.status}: ${first.stderr}`);
    const code = /--approve ([0-9a-f]{8})/.exec(first.stderr)?.[1];
    assert.ok(code, first.stderr);
    return { first, code, second: await run([...args, "--approve", code], env) };
  };
  const file = (f) => join(dir, f);
  const saved = () => JSON.parse(readFileSync(file("settings.json"), "utf8"));
  const ledger = () => (existsSync(file("ledger.jsonl")) ? readFileSync(file("ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const wallet = () => JSON.parse(readFileSync(file("wallet.json"), "utf8"));
  assert.equal((await run(["init"])).status, 0);
  return { dir, run, approved, file, saved, ledger, wallet };
}

const claimOf = (stdout) => /Claim code \(shown once; this computer does not keep it\): (SATO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(stdout)?.[1];

test("CLI join: exit 5 with the card and a code (nothing sent, nothing saved); the approved run joins, prints the claim code once, saves the id, and the code is on no disk", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const { first, code, second } = await b.approved(["join", "--name", "Grok Trader", "--via", "sato-bot"]);
  // The ask: the card says what becomes public, the intent names the wallets, and nothing has gone to Sato Hub.
  assert.match(first.stdout, /Join Sato Hub: this makes the agent's Sato Passport PUBLIC on satohub\.ai\./);
  assert.match(first.stdout, new RegExp(`EVM ${b.wallet().evm.address.toLowerCase()}`), "the card names the wallets it would list, in full");
  assert.match(first.stdout, /Nothing has been signed or sent\./);
  assert.match(first.stderr, /Needs the owner's approval\./);
  assert.equal(hub.state.requests.length, 1, "only the approved run reached Sato Hub (one POST)");
  assert.equal(existsSync(b.file("approvals.json")), true);
  // The join.
  assert.equal(second.status, 0, second.stderr);
  const claim = claimOf(second.stdout);
  assert.match(claim, pj.CLAIM_CODE_RE);
  assert.equal(second.stdout.split(claim).length - 1, 1, "the code is printed once");
  assert.match(second.stdout, /Give this code to the agent's owner: signed in on satohub.ai, they enter it once to link the passport. It expires in 7 days./);
  assert.match(second.stdout, /Joined\. This agent's Sato Passport is public now\./);
  assert.match(second.stdout, /Passport: sato:agt:exmpexmp2223/);
  assert.match(second.stdout, /Page: {5}https:\/\/satohub\.ai\/passport\/exmpexmp2223/);
  assert.match(second.stdout, /Wallets: {2}EVM 0x[0-9a-f]{40} \(primary\); Solana /);
  assert.match(second.stdout, /Joining proves control of this agent's wallet key and makes its passport public on satohub.ai\./);
  assert.equal(second.stderr, "");
  // What Sato Hub got: valid, independently checked signatures, the digest of the printed code, the kit's user agent, and nothing secret.
  const join = hub.state.joins[0];
  assert.equal(hub.state.requests[0].ua.startsWith("sato-agent/"), true);
  assert.equal(join.claim_sha256, pj.claimCodeDigest(claim));
  assert.equal(join.name, "Grok Trader");
  assert.equal(join.via, "sato-bot");
  assert.equal(join.primary, b.wallet().evm.address.toLowerCase());
  assert.deepEqual(join.wallets.map((w) => w.address).sort(), [b.wallet().evm.address.toLowerCase(), b.wallet().solana.address].sort());
  assert.ok(!hub.state.requests[0].body.includes(claim), "the code itself never leaves");
  assert.ok(!hub.state.requests[0].body.includes(b.wallet().evm.private_key.slice(2)), "no key leaves");
  // Saved, and the code is nowhere: not in settings, the ledger, the approvals, or any file in the agent's folder.
  const saved = b.saved();
  assert.equal(saved.passport, "sato:agt:exmpexmp2223");
  assert.equal(saved.passport_join.slug, "sunny-otter-agent");
  assert.equal(saved.passport_join.profile_url, "https://satohub.ai/passport/exmpexmp2223/profile");
  assert.equal(statSync(b.file("settings.json")).mode & 0o777, 0o600);
  for (const f of everything(b.dir)) assert.ok(!f.text.includes(claim), `${f.path} holds the claim code`);
  assert.ok(b.ledger().some((e) => e.kind === "passport" && e.status === "joined"));
  // The approval line in the ledger names the intent (wallets and name, all public), not a claim code.
  const approval = b.ledger().find((e) => e.kind === "approval" && e.status === "requested");
  assert.equal(approval.intent.cmd, "join");
  assert.equal(approval.code, code);
});

test("CLI join --json: one JSON answer with the claim code once, and nothing else secret", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const ask = JSON.parse((await b.run(["join", "--json"])).stdout);
  assert.equal(ask.needs_approval.intent.cmd, "join");
  const second = await b.run(["join", "--json", "--approve", ask.needs_approval.code]);
  assert.equal(second.status, 0, second.stderr);
  const j = JSON.parse(second.stdout);
  assert.match(j.claim_code, pj.CLAIM_CODE_RE);
  assert.equal(j.passport_id, "sato:agt:exmpexmp2223");
  assert.equal(j.lookup_url, "https://satohub.ai/passport/exmpexmp2223");
  assert.deepEqual(j.wallets.map((w) => w.chain), ["evm", "solana"]);
  assert.equal(second.stdout.split(j.claim_code).length - 1, 1);
  assert.ok(!second.stdout.includes(b.wallet().evm.private_key.slice(2)));
  const another = JSON.parse((await b.run(["join", "--name", "Other Bot", "--again", "--json"])).stdout);
  assert.equal(another.needs_approval.intent.cmd, "join");
  assert.equal(another.needs_approval.intent.name, "Other Bot");
  assert.equal(another.needs_approval.intent.replaces, "sato:agt:exmpexmp2223");
});

test("CLI join: the approval binds the name, the wallets and --again; a code for one join is no use for another, or for issue-claim", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const ask = await b.run(["join", "--name", "Alpha Bot", "--json"]);
  assert.equal(ask.status, 5);
  const { code, intent } = JSON.parse(ask.stdout).needs_approval;
  assert.equal(intent.cmd, "join");
  assert.equal(intent.name, "Alpha Bot");
  assert.equal(intent.via, "kit");
  assert.equal(intent.primary, `evm:${b.wallet().evm.address.toLowerCase()}`);
  assert.deepEqual(intent.wallets, [`evm:${b.wallet().evm.address.toLowerCase()}`, `solana:${b.wallet().solana.address}`]);
  for (const other of [["join", "--name", "Beta Bot"], ["join"], ["join", "--name", "Alpha Bot", "--no-solana"], ["join", "--name", "Alpha Bot", "--via", "sato-bot"]]) {
    const r = await b.run([...other, "--approve", code]);
    assert.equal(r.status, 1, other.join(" "));
    assert.match(r.stderr, /different intent/);
  }
  assert.equal(hub.state.requests.length, 0, "no request reached Sato Hub");
  assert.equal(existsSync(b.file("settings.json")), false, "nothing saved");
  // The same command with the right code goes ahead; the code works once.
  const ok = await b.run(["join", "--name", "Alpha Bot", "--approve", code]);
  assert.equal(ok.status, 0, ok.stderr);
  const used = await b.run(["join", "--name", "Alpha Bot", "--again", "--approve", code]);
  assert.equal(used.status, 1);
  assert.match(used.stderr, /not found|already used/, "a code works once");
});

test("CLI join: bad usage is exit 2 before any approval code is made; an extra word is a usage error", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  for (const args of [["join", "--name", "ab"], ["join", "--name", " padded"], ["join", "--via", "form"], ["join", "--via", "carrier-pigeon"], ["join", "now"]]) {
    const r = await b.run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^usage: /);
  }
  assert.equal(existsSync(b.file("approvals.json")), false, "no approval code for a usage error");
  assert.equal(hub.state.requests.length, 0);
});

test("CLI join: a bot that already joined is refused (exit 1) before any code or request; --again with a code goes to Sato Hub, which refuses the same wallet; nothing saved changes", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const { second } = await b.approved(["join"]);
  assert.equal(second.status, 0, second.stderr);
  const before = JSON.stringify(b.saved());
  const requests = hub.state.requests.length;
  const approvals = readFileSync(b.file("approvals.json"), "utf8");
  const again = await b.run(["join"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has a Sato Passport saved: sato:agt:exmpexmp2223 \(https:\/\/satohub\.ai\/passport\/exmpexmp2223\)/);
  assert.equal(hub.state.requests.length, requests);
  assert.equal(readFileSync(b.file("approvals.json"), "utf8"), approvals, "no new approval code");
  // --again: the owner's yes is asked for (it names what it would replace), and Sato Hub says the wallet is already on a passport.
  const ask = await b.run(["join", "--again", "--json"]);
  assert.equal(ask.status, 5);
  assert.equal(JSON.parse(ask.stdout).needs_approval.intent.replaces, "sato:agt:exmpexmp2223");
  const { second: refused } = await b.approved(["join", "--again"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Sato Hub did not accept this \(wallet_taken\)/);
  assert.match(refused.stderr, /already on a Sato Passport \(one wallet is one passport\)/);
  assert.match(refused.stderr, /Nothing was saved\./);
  assert.equal(JSON.stringify(b.saved()), before, "what was saved is unchanged");
});

test("CLI join --again on a bot whose saved id came from `register --passport`: the new id replaces it, and the old passport is only named", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  writeFileSync(b.file("settings.json"), JSON.stringify({ schema: "sato-agent.settings/v1", passport: ID, passport_set_at: "2026-10-20T00:00:00.000Z" }) + "\n", { mode: 0o600 });
  const refused = await b.run(["join"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`already has a Sato Passport saved: ${ID}`));
  const { second } = await b.approved(["join", "--again"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`It replaced the saved id ${ID}; that passport was not changed\\.`));
  assert.equal(b.saved().passport, "sato:agt:exmpexmp2223");
  assert.ok(b.ledger().some((e) => e.kind === "passport" && e.replaced === ID));
});

test("CLI join: a passport from before joins existed does not block it; the note is printed once and `passport prove` is not suggested", async () => {
  const hub = await newHub({
    joinExtra: (p) => ({
      note: LEGACY_NOTE,
      legacy_declared: [{ wallet: `evm:${p.primary}`, passport_id: ID }],
      next: ["Your passport is public now.", "Give the claim code you generated to the agent's owner.", LEGACY_NEXT],
    }),
  });
  const b = await bot(hub.origin);
  const { second } = await b.approved(["join"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.split("Note from Sato Hub:").length - 1, 1);
  assert.match(second.stdout, new RegExp(`Note from Sato Hub: ${ID.replace(/:/g, ":")} \\(registered before joins existed\\) lists evm:0x1111`));
  assert.doesNotMatch(second.stdout, /prove_wallet|passport prove/);
  assert.match(second.stdout, /Joined\. This agent's Sato Passport is public now\./);
  assert.equal(b.saved().passport, "sato:agt:exmpexmp2223");
  assert.ok(claimOf(second.stdout), "and the claim code is shown");
  const js = JSON.parse((await b.run(["passport", "status", "--json"])).stdout);
  assert.equal(js.passport, "sato:agt:exmpexmp2223");
});

test("CLI join: Sato Hub's daily join limit (429) is exit 1 with the sentence, one request only, and nothing saved", async () => {
  for (const code of ["ip_daily_quota", "daily_cap"]) {
    const hub = await newHub({ reply: (req) => (req.url === "/api/passport/join" ? { status: 429, json: { code, error: "Try again tomorrow.", retry_after_seconds: 3600, next: ["Try again tomorrow. Joining stays free."] } } : null) });
    const b = await bot(hub.origin);
    const { second } = await b.approved(["join"]);
    assert.equal(second.status, 1, code);
    assert.match(second.stderr, /Sato Hub's join limit for today is reached; try again tomorrow\./);
    assert.match(second.stderr, new RegExp(`\\(${code}\\)`));
    assert.match(second.stderr, /Nothing was saved\./);
    assert.equal(hub.state.requests.length, 1, "the kit asked once and did not retry");
    assert.equal(existsSync(b.file("settings.json")), false);
  }
});

test("CLI join with no wallet yet: exit 1 and the way to make one, before any approval code or request", async () => {
  const hub = await newHub();
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-join-")), "agent");
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "join"], { env: { ...process.env, SATO_AGENT_HOME: dir, SATO_AGENT_MCP_URL: `${hub.origin}/api/mcp` } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end("");
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no wallet yet: run `sato-agent init` first/);
  assert.equal(existsSync(join(dir, "approvals.json")), false);
  assert.equal(hub.state.requests.length, 0);
});

test("CLI join: no answer from Sato Hub is exit 1 with what to do, and nothing is saved", async () => {
  const b = await bot("http://127.0.0.1:9");
  const { second } = await b.approved(["join"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Couldn't reach Sato Hub, or its answer did not arrive, so nothing was saved here\./);
  assert.equal(existsSync(b.file("settings.json")), false);
});

test("CLI passport status: before and after a join, with no network call (the hub is unreachable)", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const none = await b.run(["passport", "status"], { SATO_AGENT_MCP_URL: "http://127.0.0.1:9/api/mcp" });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /No Sato Passport is saved here\./);
  assert.equal(JSON.parse((await b.run(["passport", "status", "--json"])).stdout).passport, null);
  const { second } = await b.approved(["join", "--name", "Grok Trader"]);
  assert.equal(second.status, 0, second.stderr);
  const before = hub.state.requests.length;
  const st = await b.run(["passport", "status"], { SATO_AGENT_MCP_URL: "http://127.0.0.1:9/api/mcp" });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /Sato Passport: sato:agt:exmpexmp2223\n {2}Page: {4}https:\/\/satohub\.ai\/passport\/exmpexmp2223\n/);
  assert.match(st.stdout, /Joined: {2}\d{4}-\d{2}-\d{2}T.* via kit, named "Grok Trader"/);
  const js = JSON.parse((await b.run(["passport", "status", "--json"])).stdout);
  assert.equal(js.passport, "sato:agt:exmpexmp2223");
  assert.equal(js.lookup_url, "https://satohub.ai/passport/exmpexmp2223");
  assert.equal(js.joined, true);
  assert.equal(hub.state.requests.length, before, "status made no request");
  assert.equal((await b.run(["passport", "status", "extra"])).status, 2);
  assert.equal((await b.run(["passport"])).status, 2);
  assert.equal((await b.run(["passport", "nope"])).status, 2);
});

test("CLI passport issue-claim: exit 5 first, then one signed issue_claim; the new code replaces the old one at Sato Hub and is printed once; a bad --passport is exit 2", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const noPassport = await b.run(["passport", "issue-claim"]);
  assert.equal(noPassport.status, 1);
  assert.match(noPassport.stderr, /no Sato Passport saved/i);
  assert.equal(existsSync(b.file("approvals.json")), false, "no approval for a command that cannot run");
  const joinedRun = await b.approved(["join"]);
  const firstClaim = claimOf(joinedRun.second.stdout);
  assert.equal(hub.state.claims.get("sato:agt:exmpexmp2223"), pj.claimCodeDigest(firstClaim));
  const bad = await b.run(["passport", "issue-claim", "--passport", "sato:agt:ABC"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage: --passport must be a Sato Passport id/);
  const { first, second } = await b.approved(["passport", "issue-claim"]);
  assert.match(first.stdout, /earlier unused codes stop working/);
  assert.equal(second.status, 0, second.stderr);
  const m = /New claim code for sato:agt:exmpexmp2223 \(shown once; this computer does not keep it\): (SATO-[A-Z0-9-]+)/.exec(second.stdout);
  assert.ok(m, second.stdout);
  assert.notEqual(m[1], firstClaim);
  assert.equal(hub.state.claims.get("sato:agt:exmpexmp2223"), pj.claimCodeDigest(m[1]), "the old code stopped working");
  assert.match(second.stdout, /Earlier unused codes for this passport stop working\./);
  for (const f of everything(b.dir)) assert.ok(!f.text.includes(m[1]) && !f.text.includes(firstClaim), `${f.path} holds a claim code`);
  assert.equal(hub.state.actions.at(-1).action, "issue_claim");
  // A code given for issue-claim does not join, and one for join does not issue.
  const ask = JSON.parse((await b.run(["passport", "issue-claim", "--json"])).stdout).needs_approval;
  assert.equal(ask.intent.cmd, "passport issue-claim");
  const cross = await b.run(["join", "--again", "--approve", ask.code]);
  assert.equal(cross.status, 1);
  assert.match(cross.stderr, /different intent/);
});

test("CLI passport prove: for a legacy passport named on the command, exit 5 then one signed prove_wallet; the id is saved after Sato Hub accepts it", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const { first, second } = await b.approved(["passport", "prove", "--passport", ID]);
  assert.match(first.stdout, /Prove this agent's wallet on sato:agt:exmpexmpexmp, publicly/);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`Proved evm:${b.wallet().evm.address.toLowerCase()} on ${ID}\\.`));
  assert.equal(hub.state.actions[0].action, "prove_wallet");
  assert.equal(b.saved().passport, ID);
  assert.equal(hub.state.byWallet.get(b.wallet().evm.address.toLowerCase()), ID);
  // The bot's Solana wallet can prove too.
  const sol = await b.approved(["passport", "prove", "--passport", ID2, "--chain", "solana"]);
  assert.equal(sol.second.status, 0, sol.second.stderr);
  assert.match(sol.second.stdout, new RegExp(`Proved solana:${b.wallet().solana.address} on ${ID2}`));
});

test("help documents join and the passport commands in plain words: free, public, wallets, approval, the claim code once; no verified, safe or trusted", async () => {
  const hub = await newHub();
  const b = await bot(hub.origin);
  const h = (await b.run(["help"])).stdout;
  assert.match(h, /join \[--name "<name>"\] \[--via kit\|sato-bot\] \[--no-solana\] \[--again\] \[--approve <code>\]/);
  assert.match(h, /make this agent's Sato Passport public on satohub\.ai\. Free\./);
  assert.match(h, /It always stops with exit 5 and a one-time code, whatever the\s+approval mode/);
  assert.match(h, /prints a claim code ONCE and never saves it/);
  assert.match(h, /refuses to join again\s+unless --again/);
  assert.match(h, /passport status\s+the saved Sato Passport id and its page on satohub\.ai \(no network call\)/);
  assert.match(h, /passport issue-claim \[--passport <id>\] \[--chain base\|solana\] \[--approve <code>\]/);
  assert.match(h, /passport prove \[--passport <id>\] \[--chain base\|solana\] \[--approve <code>\]/);
  assert.match(h, /passport set-wallet --agent-id <n> \[--chain base\|bnb\|arbitrum\|polygon\] \[--dry-run\] \[--approve <code>\]/);
  const start = h.indexOf("  join [--name");
  const end = h.indexOf('  check "<install command>"');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(h.slice(start, end), BANNED);
});

test("the README and BOT.md describe join: free, public, the wallets it lists, the approval, the claim code shown once, proves wallet control only; BOT.md asks the owner once", () => {
  const readme = readFileSync(ROOT("README.md"), "utf8");
  const bot = readFileSync(ROOT("BOT.md"), "utf8");
  const section = readme.slice(readme.indexOf("### Joining Sato Hub: `join` and `passport`"), readme.indexOf("### Build receipts in `check`"));
  assert.ok(section.length > 800, "the README has the section");
  assert.match(section, /Joining proves control of the wallet key and makes the passport public; it says nothing else about the agent/);
  assert.match(section, /free/i);
  assert.match(section, /exit 5/);
  assert.match(section, /claim code[^.]*once/i);
  assert.match(section, /never written to the ledger, `settings\.json` or any file/);
  assert.match(section, /`join --again`/);
  assert.match(section, /`passport set-wallet --agent-id <n>`/);
  assert.match(section, /SATO_BUILDER_CODE/);
  assert.match(section, /Sato Hub's join limit for today is reached; try again tomorrow\./);
  assert.match(section, /never retries a join by itself/);
  assert.match(section, /\*\*A passport from before joins existed\.\*\* A wallet that is merely listed \(never proven\) on such a passport never blocks a join/);
  assert.match(section, /"Note from Sato Hub"/);
  assert.doesNotMatch(section, /told to run `passport prove` instead/, "the retired refusal is not documented");
  assert.match(section, /satohub\.passport/);
  assert.doesNotMatch(section, BANNED);
  assert.match(readme, /\| `join \[--name "<name>"\] \[--via kit\\\|sato-bot\] \[--no-solana\] \[--again\]` \|/);
  assert.match(readme, /`POST \/api\/passport\/join`/);
  const step = bot.slice(bot.indexOf("8. **Public registration, once.**"), bot.indexOf("9. **EVM chains only"));
  assert.ok(step.length > 400, "BOT.md has the step");
  assert.match(step, /Ask the owner once: "Register this bot publicly with Sato Hub\? It's free\."/);
  assert.match(step, /join --via sato-bot/);
  assert.match(step, /exit code 5/);
  assert.match(step, /claim code/);
  assert.match(step, /proves that this bot controls its wallet key and makes the passport public/);
  assert.match(step, /Only the owner's own yes in this chat counts/);
  assert.match(step, /"Note from Sato Hub"/);
  assert.match(step, /do not try `passport prove` for that old passport/);
  assert.match(step, /never retry in a loop/);
  assert.match(step, /join limit for today is reached/);
  assert.doesNotMatch(step.replace(/never (describe|call)[^.]*\./gi, ""), BANNED);
});
