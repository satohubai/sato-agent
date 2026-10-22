// Tamper evidence for the files that hold the owner's choices and the record of spending.
//
//   ledger.jsonl    every line carries `prev`: the SHA-256 of the line before it (the first chained line carries the hash of
//                   everything written before the chain started, or zeros in a new folder). A line removed, changed, moved or
//                   added by hand breaks the chain.
//   integrity.json  the seal: this folder's wallet (its two addresses), the SHA-256 of policy.json and the ledger's head (how
//                   many lines it has and the hash of the last one). The kit moves it forward with every write it makes.
//
// If anything is missing, cut short, out of order or does not match, every spend is refused (ledger_tampered, policy_tampered,
// wallet_tampered, wallet_missing) until the owner asks for `sato-agent repair`. Deleting a file never unlocks spending: a wallet
// with no seal next to it is refused, never treated as a new install. A repair that cannot see the last 24 hours (a broken
// ledger) pauses spending for 24 hours from the repair, and so does a restore into a folder that never held that wallet.
//
// Honest scope: there is no secret in this. Any key would sit on this same computer, readable by the same user, so a program
// running as this user that recomputes every hash and rewrites the seal leaves a consistent record. What it catches is the
// cheap attack: a deleted or shortened ledger (which used to reset the 24-hour total), a hand-edited policy.json (which used to
// skip the raise log), a swapped wallet file, or a line added by hand.

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { paths, withLockSync, writePrivate } from "./store.js";
import { raisesBetween } from "./policy.js";
import { PlainError } from "./errors.js";

export const ZERO_HASH = "0".repeat(64);
export const INTEGRITY_SCHEMA = "sato-agent.integrity/v1";
/** How long spending stays paused after a repair or a restore that cannot see what the wallet spent before. */
export const PAUSE_MS = 24 * 60 * 60 * 1000;

const LOCK = { name: "ledger" };
const UNREADABLE = Symbol("unreadable");

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const serialize = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
/** policy.json as the kit writes it, so a recorded policy can be compared byte for byte with the file. */
export const policyFileText = (p) => JSON.stringify(p, null, 2) + "\n";

/** Run `fn` holding the ledger lock (re-entrant in this process). Every read that must see a consistent ledger and seal takes it. */
export const withLedgerLock = (fn) => withLockSync(fn, LOCK);

function readText(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function readJsonOr(path) {
  const t = readText(path);
  if (t === null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/** The ledger as written: each line's exact text (hashes are over the bytes, never a re-serialization) and its parsed row. */
export function ledgerLines() {
  const text = readText(paths.ledger()) ?? "";
  const raw = text === "" ? [] : text.split("\n");
  const cut = text !== "" && !text.endsWith("\n");
  if (!cut && raw.length) raw.pop(); // the "" after the final newline
  const rows = raw.map((l) => {
    try {
      const r = JSON.parse(l);
      return r && typeof r === "object" && !Array.isArray(r) ? r : null;
    } catch {
      return null;
    }
  });
  return { text, raw, rows, cut };
}

/**
 * The wallet file's two addresses (and `sealed`: the file says its folder is sealed, see SEALED_WALLET_VERSION), null when there
 * is none, UNREADABLE when it is there but not a wallet.
 */
function walletAddresses() {
  const w = readJsonOr(paths.wallet());
  if (w === null || w === UNREADABLE) return w;
  if (typeof w.evm?.address !== "string" || typeof w.solana?.address !== "string") return UNREADABLE;
  return { evm: w.evm.address, solana: w.solana.address, sealed: Number(w.version) >= SEALED_WALLET_VERSION };
}

/**
 * wallet.json `version` from v0.6.0 on: the folder holding this wallet is sealed. A folder whose wallet says so is never taken for
 * a pre-chain one, so deleting the seal and the ledger cannot pass for an upgrade. (The upgrade stamps an older wallet file.)
 */
export const SEALED_WALLET_VERSION = 2;

/** Mark a pre-v0.6.0 wallet file as sealed, rewriting it atomically with every other field as it was. */
function stampWallet() {
  const w = readJsonOr(paths.wallet());
  if (!w || w === UNREADABLE || Number(w.version) >= SEALED_WALLET_VERSION) return;
  writePrivate(paths.wallet(), JSON.stringify({ ...w, version: SEALED_WALLET_VERSION }, null, 2) + "\n", { atomic: true });
}

export const sameWallet = (a, b) => Boolean(a && b) && a.evm?.toLowerCase() === b.evm?.toLowerCase() && a.solana === b.solana;
const short = (a) => (typeof a === "string" && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));

/** The line of the latest repair of a broken ledger: nothing before it is trusted to say what the limits were. */
const lastLedgerRepair = (rows) => rows.findLastIndex((r) => r?.kind === "integrity" && r.status === "repaired" && typeof r.prefix_sha256 === "string");

/**
 * The last policy the ledger recorded (`to` of the last policy line), or null. Lines before the latest repair of a broken
 * ledger do not count: a line planted in a ledger that no longer matched its seal must not come back as "the owner's limits".
 */
export function lastRecordedPolicy(rows = ledgerLines().rows) {
  for (let i = rows.length - 1; i > lastLedgerRepair(rows); i--) {
    const r = rows[i];
    if (r?.kind === "policy" && r.to && typeof r.to === "object") return r.to;
  }
  return null;
}

/** The wallet the ledger says this folder holds (the last line that names one), or null. Read when the seal is missing. */
export function ledgerWallet(rows = ledgerLines().rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.kind === "wallet" && (r.status === "created" || r.status === "restored") && typeof r.evm === "string" && typeof r.solana === "string") return { evm: r.evm, solana: r.solana };
    if (r?.kind === "integrity" && typeof r.wallet?.evm === "string" && typeof r.wallet?.solana === "string") return { evm: r.wallet.evm, solana: r.wallet.solana };
  }
  return null;
}

/** A chained line, or one that only a version with the chain writes: such a ledger is not a pre-chain one. */
const isChained = (r) => Boolean(r) && (Object.hasOwn(r, "prev") || r.kind === "integrity");

/** Why the ledger does not match its sealed head, or null when it does. */
export function verifyLedger(L, head) {
  if (!head || !Number.isInteger(head.lines) || head.lines < 0 || typeof head.head !== "string") return "the seal has no ledger head";
  const { raw, rows } = L;
  if (L.cut) return "its last line is cut off";
  if (raw.length !== head.lines) return raw.length < head.lines ? `it has ${raw.length} lines, fewer than the ${head.lines} it was sealed with` : `it has ${raw.length} lines, more than the ${head.lines} it was sealed with`;
  if (raw.length === 0) return head.head === ZERO_HASH ? null : "it is empty";
  if (sha256(raw[raw.length - 1]) !== head.head) return `its last line (line ${raw.length}) is not the line that was sealed`;
  // The chain runs from the latest repair (which pins every byte before it) or, without one, from the line that started it.
  let a = lastLedgerRepair(rows);
  const prefix = (i) => raw.slice(0, i).map((l) => l + "\n").join("");
  if (a >= 0) {
    if (sha256(prefix(a)) !== rows[a].prefix_sha256) return `the lines before the repair on line ${a + 1} were changed`;
    if (rows[a].prev !== (a === 0 ? ZERO_HASH : sha256(raw[a - 1]))) return `line ${a + 1} does not follow line ${a}`;
  } else {
    a = rows.findIndex(isChained);
    if (a < 0) return "none of its lines is chained";
    const r = rows[a];
    // A new folder's chain starts on its first line (prev = zeros); a pre-chain ledger's starts on the line that sealed it.
    if (a === 0 ? r.prev !== ZERO_HASH : !(r.kind === "integrity" && r.status === "started")) return `line ${a + 1} is not where the chain starts`;
    if (a > 0 && r.prev !== sha256(prefix(a))) return `the lines before line ${a + 1} were changed`;
  }
  for (let i = a + 1; i < raw.length; i++) {
    if (!rows[i]) return `line ${i + 1} cannot be read`;
    if (rows[i].prev !== sha256(raw[i - 1])) return `line ${i + 1} does not follow line ${i}`;
  }
  return null;
}

/** A pre-chain ledger (written before v0.6.0): rows, none chained, nothing cut off. It is sealed as it is on the next write. */
const isLegacy = (L) => L.raw.length > 0 && !L.cut && !L.rows.some(isChained);

/** What the seal of a pre-chain folder should say about policy.json: its digest, or the recorded policy's when the file allows more. */
function legacyPolicyDigest(L) {
  const text = readText(paths.policy());
  const to = lastRecordedPolicy(L.rows);
  if (!to) return text === null ? null : sha256(text);
  const expected = policyFileText(to);
  if (text === null) return sha256(expected); // deleted before the upgrade: it shows as missing
  if (text === expected) return sha256(text);
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return sha256(expected);
  }
  // No version before v0.6.0 wrote a queued raise: one in a pre-chain file was put there by hand.
  if (!file || typeof file !== "object" || Object.hasOwn(file, "pending")) return sha256(expected);
  // Edited by hand before the upgrade: only an edit that allows MORE than the last recorded change is held against it.
  return raisesBetween(to, file).length ? sha256(expected) : sha256(text);
}

const ledgerProblem = (detail) => ({
  rule: "ledger_tampered",
  limit: null,
  observed: detail,
  message: `spending is frozen: the spend record (ledger.jsonl) does not match its seal: ${detail}. That happens when the ledger is edited, cut short or deleted, or when a Grok Reset brought back an older copy of this computer. Tell the owner. Only the owner can ask for \`sato-agent repair\`; spending then stays paused for 24 hours, because the missing lines could hide spends.`,
});
const policyProblem = (detail) => ({
  rule: "policy_tampered",
  limit: null,
  observed: detail,
  message: `spending is frozen: the limits file (policy.json) ${detail}. Limits change only through \`policy set\`. Tell the owner. Only the owner can ask for \`sato-agent repair\`, which puts back the limits from the last recorded change.`,
});

const walletProblem = (wallet, expected) => {
  if (wallet === UNREADABLE) return { rule: "wallet_tampered", limit: expected?.evm ?? null, observed: "unreadable", message: "spending is frozen: the wallet file (wallet.json) cannot be read. Tell the owner." };
  if (expected && wallet === null) return { rule: "wallet_missing", limit: expected.evm, observed: null, message: `the wallet file is missing (this folder's wallet is ${expected.evm} / ${expected.solana}). Nothing can be signed. If the owner kept the backup, \`sato-agent restore\` puts it back.` };
  if (expected && !sameWallet(wallet, expected)) return { rule: "wallet_tampered", limit: expected.evm, observed: wallet.evm, message: `spending is frozen: the wallet file holds ${wallet.evm} / ${wallet.solana}, but this folder's wallet is ${expected.evm} / ${expected.solana}. A wallet is never replaced. Tell the owner, and never ask anyone to fund the other address. To use this folder's wallet again, the owner restores it from their backup (\`sato-agent restore\`).` };
  return null;
};

/**
 * Everything that stops spending, read under the ledger lock so a write in progress is never mistaken for tampering. Each file
 * is read once; `policyText` and `L` are the very bytes that were checked, for a caller that must act on what was verified.
 */
function problemsNow() {
  const problems = [];
  const wallet = walletAddresses();
  const integ = readJsonOr(paths.integrity());
  const L = ledgerLines();
  const policyText = readText(paths.policy());
  let adoptable = false;
  // The wallet this folder holds: the seal says, and without a (readable) seal, the ledger's own wallet lines.
  const sealedWallet = integ && integ !== UNREADABLE ? (integ.wallet ?? null) : null;
  const expected = sealedWallet ?? (integ && integ !== UNREADABLE ? null : ledgerWallet(L.rows));
  if (integ === UNREADABLE) problems.push(ledgerProblem("the seal file (integrity.json) cannot be read"));
  else if (integ === null) {
    if (isLegacy(L) && !(wallet && wallet !== UNREADABLE && wallet.sealed)) {
      adoptable = true;
      const digest = legacyPolicyDigest(L);
      if (digest !== (policyText === null ? null : sha256(policyText))) problems.push(policyProblem(policyText === null ? "is missing" : "allows more than the last change recorded in the ledger (it was edited by hand)"));
    } else if (L.raw.length || (wallet && wallet !== UNREADABLE && wallet.sealed)) problems.push(ledgerProblem("the seal file (integrity.json) is missing"));
    else if (wallet !== null) problems.push(ledgerProblem("the wallet is here, but its spend record and seal are missing"));
    // No wallet, no ledger, no seal: a new folder. Nothing here can sign.
  } else {
    const verify = verifyLedger(L, integ.ledger);
    if (verify) problems.push(ledgerProblem(verify));
    const digest = policyText === null ? null : sha256(policyText);
    const want = integ.policy_sha256 ?? null;
    if (digest !== want) problems.push(policyProblem(policyText === null ? "is missing" : want === null ? "appeared outside the kit" : "was changed outside the kit"));
    if (!sealedWallet && wallet !== null && wallet !== UNREADABLE) problems.push({ rule: "wallet_tampered", limit: null, observed: wallet.evm, message: `spending is frozen: a wallet file (${wallet.evm} / ${wallet.solana}) is here that the kit did not create or restore in this folder. Tell the owner. Only the owner can ask for \`sato-agent repair\` to keep it as this folder's wallet; spending then stays paused for 24 hours.` });
  }
  const w = walletProblem(wallet, expected);
  if (w) problems.unshift(w);
  // A repair or a restore that could not see the wallet's last 24 hours pauses spending; a later line never shortens a pause.
  let pausedUntil = null;
  for (const r of L.rows) {
    if ((r?.kind === "integrity" || r?.kind === "wallet") && typeof r.paused_until === "string") {
      const t = Date.parse(r.paused_until);
      if (Number.isFinite(t) && (pausedUntil === null || t > pausedUntil)) pausedUntil = t;
    }
  }
  return { problems, adoptable, sealed: integ !== null && integ !== UNREADABLE, wallet: sealedWallet, expected, pausedUntil, policyText, L, integ, walletNow: wallet };
}

/** The wallet this folder holds or held (its seal, or without a readable seal its ledger's wallet lines), or null. */
export const expectedWallet = () => withLedgerLock(() => problemsNow().expected);

/**
 * One consistent read for a spend: the problems, the pause, and the policy text and ledger rows that were checked, read once each
 * under the ledger lock. reserve() decides on these bytes, so a file swapped between "checked" and "used" cannot slip through.
 */
export function snapshot() {
  return withLedgerLock(() => {
    const s = problemsNow();
    return { problems: s.problems, paused_until: s.pausedUntil === null ? null : new Date(s.pausedUntil).toISOString(), policyText: s.policyText, rows: s.L.rows, raw: s.L.raw };
  });
}

/**
 * The integrity of this folder right now: `problems` (each a refusal: rule, message) stop every spend; `paused_until` (an ISO time
 * or null) is a pause after a repair or a restore. `sealed_wallet` is the wallet this folder was sealed with.
 */
export function inspect({ now = Date.now() } = {}) {
  const s = withLedgerLock(problemsNow);
  const paused = s.pausedUntil !== null && now < s.pausedUntil;
  return { problems: s.problems, adoptable: s.adoptable, sealed: s.sealed, sealed_wallet: s.wallet, paused_until: s.pausedUntil === null ? null : new Date(s.pausedUntil).toISOString(), paused };
}

/** The refusal for a pause, or null. */
export function pauseRefusal(state, now = Date.now()) {
  if (!state.paused_until || now >= Date.parse(state.paused_until)) return null;
  return {
    rule: "spending_paused",
    limit: state.paused_until,
    observed: null,
    message: `spending is paused until ${state.paused_until} (24 hours after a repair or a restore), because the kit cannot see everything this wallet spent before it. Nothing to do but wait; \`status\` shows the time.`,
  };
}

/** Every refusal integrity gives right now (problems first, then a pause). Empty = spending may go on. */
export function integrityRefusals(now = Date.now()) {
  const s = inspect({ now });
  const p = pauseRefusal(s, now);
  return [...s.problems, ...(p ? [p] : [])];
}

function writeSeal(seal) {
  writePrivate(paths.integrity(), JSON.stringify({ schema: INTEGRITY_SCHEMA, ...seal, updated_at: new Date().toISOString() }, null, 2) + "\n", { atomic: true });
}

/** Append one chained line. Returns its text and the ledger's new line count. */
function appendRaw(row, L) {
  const prev = L.raw.length ? sha256(L.raw[L.raw.length - 1]) : ZERO_HASH;
  const text = serialize({ ...row, prev });
  // A line left cut off is closed first, so this one can still be read (the chain is broken there either way).
  fs.appendFileSync(paths.ledger(), `${L.cut ? "\n" : ""}${text}\n`, { mode: 0o600 });
  return { text, lines: L.raw.length + 1 };
}

/** Seal a pre-chain ledger as it is (the one-time step of an upgrade to v0.6.0). */
function adopt(L) {
  const policy = legacyPolicyDigest(L);
  const w = walletAddresses();
  const wallet = w && w !== UNREADABLE ? { evm: w.evm, solana: w.solana } : null;
  const row = { id: randomUUID(), ts: new Date().toISOString(), kind: "integrity", status: "started", legacy_lines: L.raw.length, ...(wallet ? { wallet } : {}) };
  // The first chained line carries the hash of every byte before it, so the old lines cannot change afterwards either.
  const text = serialize({ ...row, prev: sha256(L.text) });
  fs.appendFileSync(paths.ledger(), `${text}\n`, { mode: 0o600 });
  writeSeal({ wallet, policy_sha256: policy, ledger: { lines: L.raw.length + 1, head: sha256(text) } });
  // From now on this folder can never pass for a pre-chain one, even with the seal and the ledger deleted.
  stampWallet();
}

/**
 * Append a ledger line and move the seal forward. A new folder (no seal, no ledger, no wallet) starts its seal here; a pre-chain
 * ledger is sealed first. On a ledger that no longer matches its seal the line is still written (the record matters) but the seal
 * stays where it was, so the freeze holds until a repair. `freshWallet`: the wallet init or restore just wrote, which a new seal
 * may carry.
 */
export function appendRow(row, { freshWallet = null } = {}) {
  return withLedgerLock(() => {
    let integ = readJsonOr(paths.integrity());
    let L = ledgerLines();
    if (integ === null) {
      const wallet = walletAddresses();
      const fresh = L.raw.length === 0 && !L.cut && (wallet === null || (freshWallet && sameWallet(wallet, freshWallet)));
      if (fresh) {
        const policyText = readText(paths.policy());
        const out = appendRaw(row, L);
        writeSeal({ wallet: freshWallet ?? null, policy_sha256: policyText === null ? null : sha256(policyText), ledger: { lines: out.lines, head: sha256(out.text) } });
        return row;
      }
      if (!isLegacy(L)) {
        appendRaw(row, L);
        return row;
      }
      adopt(L);
      integ = readJsonOr(paths.integrity());
      L = ledgerLines();
    }
    if (integ === UNREADABLE) {
      appendRaw(row, L);
      return row;
    }
    const ok = verifyLedger(L, integ.ledger) === null;
    const out = appendRaw(row, L);
    if (ok) writeSeal({ ...strip(integ), ledger: { lines: out.lines, head: sha256(out.text) } });
    return row;
  });
}

const strip = ({ schema: _s, updated_at: _u, ...rest }) => rest;

/**
 * Write (or, with `text` null, remove) policy.json, record `row` and seal the new digest: one step under the ledger lock. The file
 * goes first, so a crash at any point leaves a file that does not match its seal (a freeze), never a seal that says "tightened"
 * over a file that is not.
 */
export function commitPolicy(text, row) {
  return withLedgerLock(() => {
    if (text === null) fs.rmSync(paths.policy(), { force: true });
    else writePrivate(paths.policy(), text, { atomic: true });
    appendRow(row);
    const integ = readJsonOr(paths.integrity());
    if (integ && integ !== UNREADABLE) writeSeal({ ...strip(integ), policy_sha256: text === null ? null : sha256(text) });
    return row;
  });
}

/** Record `row` for the wallet init or restore just wrote, and make it this folder's sealed wallet. */
export function commitWallet(addresses, row) {
  return withLedgerLock(() => {
    const wallet = { evm: addresses.evm, solana: addresses.solana };
    appendRow(row, { freshWallet: wallet });
    const integ = readJsonOr(paths.integrity());
    if (integ && integ !== UNREADABLE) writeSeal({ ...strip(integ), wallet });
    return row;
  });
}

/** The wallet this folder was sealed with, or null. */
export function sealedWallet() {
  const integ = withLedgerLock(() => readJsonOr(paths.integrity()));
  return integ && integ !== UNREADABLE ? (integ.wallet ?? null) : null;
}

const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, "-");

/**
 * Bring a frozen folder back to a state the kit can seal, without ever giving the 24-hour total back:
 *   - a different, missing or unreadable wallet file is never accepted (restore the original, or use a new NAME);
 *   - a policy.json changed outside the kit is kept aside as policy.json.tampered-<time>; the limits from the last recorded change
 *     are put back when the ledger still matches, otherwise the owner sets them again;
 *   - a ledger that does not match is kept as it is (nothing is deleted), and a repair line pins every byte before it. Spending is
 *     then paused for 24 hours, because the missing lines could hide spends; so is keeping a wallet file the kit did not create.
 * Returns what was found and done. Throws PlainError when only the owner's backup (or a new NAME) can fix it.
 */
export function repair({ now = Date.now() } = {}) {
  return withLedgerLock(() => {
    const s = problemsNow();
    const found = s.problems;
    if (!found.length) return { repaired: false, problems: [], actions: [], paused_until: null };
    const wallet = s.walletNow;
    const integ = s.integ;
    // The wallet this folder holds or held: its seal, or (without a readable seal) its ledger's wallet lines.
    const sealed = s.expected;
    if (wallet === UNREADABLE) throw new PlainError("The wallet file (wallet.json) cannot be read, and repair never touches a wallet. If the owner kept the backup, move nothing and ask them: `sato-agent restore` needs the wallet file gone first, so this needs a new NAME (a new launcher and folder) and a restore there.");
    if (sealed && wallet === null) throw new PlainError(`This folder's wallet file is missing (it was ${sealed.evm} / ${sealed.solana}). Repair never makes or replaces a wallet. If the owner kept the backup, run \`sato-agent restore\` and paste it; otherwise this folder cannot sign again (use a new NAME).`);
    if (sealed && !sameWallet(wallet, sealed)) throw new PlainError(`The wallet file holds ${wallet.evm} / ${wallet.solana}, but this folder's wallet is ${sealed.evm} / ${sealed.solana}. Repair never accepts a different wallet. Tell the owner, and never ask anyone to fund the other address. If the owner kept the backup of this folder's wallet, a new NAME and \`restore\` there brings it back.`);
    const L = s.L;
    const ledgerBroken = found.some((p) => p.rule === "ledger_tampered");
    const policyBroken = found.some((p) => p.rule === "policy_tampered");
    // A wallet file no seal and no ledger line names (a pre-chain folder's wallet is recorded by the upgrade's seal instead).
    const walletUnrecorded = !sealed && wallet !== null && !s.adoptable;
    // policy.json is trusted only when a readable seal vouches for it; a recorded policy only while the ledger matches.
    const policyTrusted = Boolean(integ) && integ !== UNREADABLE && !policyBroken;
    const actions = [];
    let policyText = s.policyText;
    if (policyBroken || (ledgerBroken && !policyTrusted && policyText !== null)) {
      if (policyText !== null) {
        writePrivate(`${paths.policy()}.tampered-${stamp(now)}`, policyText);
        actions.push(`kept the policy.json it found as policy.json.tampered-${stamp(now)}`);
      }
      const to = ledgerBroken ? null : lastRecordedPolicy(L.rows);
      if (to) {
        policyText = policyFileText(to);
        actions.push(`put back the limits from the last recorded change (${to.set_at ?? "time not recorded"})`);
      } else {
        policyText = null;
        actions.push("removed the limits, because nothing the kit can still vouch for says what they were: the owner sets them again with `policy set`");
      }
    }
    const pause = ledgerBroken || walletUnrecorded;
    const pausedUntil = pause ? new Date(Math.max(now + PAUSE_MS, s.pausedUntil ?? 0)).toISOString() : null;
    if (ledgerBroken) actions.push("kept the ledger as it was and sealed it from here; every line before the repair is pinned");
    if (walletUnrecorded) actions.push(`kept ${wallet.evm} / ${wallet.solana} as this folder's wallet`);
    if (pause) actions.push(`paused spending until ${pausedUntil}`);
    const sealWallet = sealed ?? (wallet && wallet !== UNREADABLE ? { evm: wallet.evm, solana: wallet.solana } : null);
    const row = {
      id: randomUUID(),
      ts: new Date(now).toISOString(),
      kind: "integrity",
      status: "repaired",
      problems: found.map((p) => ({ rule: p.rule, observed: p.observed })),
      actions,
      ...(sealWallet ? { wallet: sealWallet } : {}),
      ...(pausedUntil ? { paused_until: pausedUntil } : {}),
    };
    if (policyText !== s.policyText) {
      if (policyText === null) fs.rmSync(paths.policy(), { force: true });
      else writePrivate(paths.policy(), policyText, { atomic: true });
    }
    const policy = policyText === null ? null : sha256(policyText);
    if (ledgerBroken) {
      // The repair line pins every byte before it; a line left cut off is closed first.
      if (L.cut) fs.appendFileSync(paths.ledger(), "\n", { mode: 0o600 });
      const before = ledgerLines();
      const text = serialize({ ...row, prefix_sha256: sha256(before.text), prev: before.raw.length ? sha256(before.raw[before.raw.length - 1]) : ZERO_HASH });
      fs.appendFileSync(paths.ledger(), `${text}\n`, { mode: 0o600 });
      writeSeal({ wallet: sealWallet, policy_sha256: policy, ledger: { lines: before.raw.length + 1, head: sha256(text) } });
    } else {
      // The ledger matches (or is a pre-chain one, sealed by this write): an ordinary line, then the seal's wallet and digest.
      appendRow(row);
      const now2 = readJsonOr(paths.integrity());
      writeSeal({ ...(now2 && now2 !== UNREADABLE ? strip(now2) : {}), wallet: sealWallet, policy_sha256: policy });
    }
    stampWallet();
    return { repaired: true, problems: found, actions, paused_until: pausedUntil };
  });
}

export { short as shortAddress };
