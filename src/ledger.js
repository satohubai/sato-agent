// The record of every spend and every limit change. Spend over the last 24
// hours (rolling) is computed from it, so a restart does not reset the limit.
//
// A spend is RESERVED (status "submitted") under the spend lock, before anything
// is signed. After that it only leaves the total if it provably never went out:
// "failed" is written only when nothing was signed or broadcast (a refused
// simulation, a payment that could not be created) or when the chain says the
// transaction reverted. Anything signed whose fate is unclear stays counted.
//
// An unreadable line stops all spending until the owner looks: deleting the
// ledger would reset the limits, so it must never be the easy fix. Since v0.6.0
// every line is also chained to the one before it and sealed (src/integrity.js):
// a ledger that is missing, cut short, reordered or edited freezes spending.

import { randomUUID } from "node:crypto";
import { withLock } from "./store.js";
import { evaluate, fold } from "./policy.js";
import { Refused } from "./errors.js";
import { DEFAULT_EVM_CHAIN, explorerTx, isKnownChain } from "./chains.js";
import { appendRow, lastLedgerRepair, ledgerLines, snapshot, withLedgerLock } from "./integrity.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function record(entry) {
  const line = { id: entry.id ?? randomUUID(), ts: new Date().toISOString(), ...entry };
  appendRow(line);
  return line;
}

/** A Sato Hub check that was skipped or could not run before a spend: the owner sees it in `status`. */
export function recordCheckEvent(entry) {
  return record({ kind: "check", ...entry });
}

const noPrev = (r) => (r && typeof r === "object" && Object.hasOwn(r, "prev") ? (({ prev: _p, ...rest }) => rest)(r) : r);

/** The ledger's rows (without the chain's `prev` field, which only src/integrity.js reads), plus the numbers of unreadable lines. */
export function read() {
  return rowsOf(ledgerLines());
}

/** read() over the very lines integrity.js checked: rows of the lines that parse, and the 1-based numbers of the others. */
function rowsOf(s) {
  const rows = [];
  const bad = [];
  // A line that cannot be read but is pinned under a repair of the ledger is covered by that repair (and its pause): it no longer stops spending.
  const pinned = lastLedgerRepair(s.rows);
  s.raw.forEach((l, i) => {
    if (!l.trim()) return;
    if (s.rows[i]) rows.push(noPrev(s.rows[i]));
    else if (i > pinned) bad.push(i + 1);
  });
  return { rows, bad };
}

export function entries() {
  return read().rows;
}

/**
 * USD reserved in the 24 hours before `now`, minus spends that provably never went out. `frozen` lists what stops every spend
 * (a ledger, policy or wallet that does not match its seal) and `paused_until` a pause after a repair or a restore: evaluate()
 * refuses on either.
 */
export function spentLast24h(now = Date.now(), ledger) {
  // One read: the totals come from the same lines the seal check looked at (unless the caller hands its own rows).
  const s = snapshot();
  return totals(ledger ?? rowsOf(s), now, s);
}

function totals(ledger, now, s) {
  const failed = new Set(ledger.rows.filter((e) => e.status === "failed").map((e) => e.id));
  const live = ledger.rows.filter((e) => e.status === "submitted" && now - Date.parse(e.ts) < DAY_MS && !failed.has(e.id));
  // Summed in whole micro-dollars (USDC's 6 decimals), so ten $0.001 spends are exactly $0.01.
  const usd = live.reduce((sum, e) => sum + Math.round((Number(e.usd) || 0) * 1e6), 0) / 1e6;
  // Swaps reserved in the window (same rule: a swap that provably never went out drops out).
  const swaps = live.filter((e) => e.kind === "swap").length;
  const paused = s.paused_until !== null && now < Date.parse(s.paused_until);
  return { usd, swaps, unreadable: ledger.bad, frozen: s.problems, paused_until: paused ? s.paused_until : null };
}

/**
 * Check a spend against the limits and reserve it, atomically across every
 * process on this machine. Throws Refused (nothing reserved) when the limits say no.
 */
export async function reserve(policy, spend) {
  return withLock(async () =>
    withLedgerLock(() => {
      // Everything the decision rests on is read once, under the ledger lock, and checked against the seal: the 24-hour total and
      // the owner's policy.json as it is on disk. The spend must fit BOTH that policy and the one the caller planned with, so a file
      // swapped between a command's first read and this moment changes nothing.
      const now = Date.now();
      const s = snapshot();
      const spent = totals(rowsOf(s), now, s);
      let onDisk = null;
      try {
        onDisk = s.policyText === null ? null : fold(JSON.parse(s.policyText), now);
      } catch {
        throw new Refused([{ rule: "policy_unreadable", limit: null, observed: null, message: "the limits file (policy.json) cannot be read; nothing is spent until the owner looks" }]);
      }
      const refusals = [...evaluate(policy, spend, spent)];
      if (s.policyText !== null || policy) for (const r of evaluate(onDisk, spend, spent)) if (!refusals.some((x) => x.rule === r.rule)) refusals.push(r);
      if (refusals.length) throw new Refused(refusals);
      return record({ status: "submitted", ...spend });
    }),
  );
}

/** Kinds that move value: shown in `status`, `history` and `proof`. "order" and "checkout" are purchases; "bridge" moves the agent's own funds to its other chain (it shares the 24-hour limit). */
export const VALUE_KINDS = ["send", "x402", "swap", "bridge", "order", "checkout"];
const SPEND_KINDS = [...VALUE_KINDS, "register", "register_sent", "register_uri"];

/**
 * One row per action (its ledger lines share an id; later lines update it),
 * oldest first. Every row that reached a chain carries its tx and explorer link,
 * so the owner (or anyone they show) can check it onchain.
 */
export function actions(ledger = read()) {
  const byId = new Map();
  for (const e of ledger.rows) {
    if (!SPEND_KINDS.includes(e.kind) && !(e.id && byId.has(e.id))) continue;
    const prev = byId.get(e.id) ?? {};
    byId.set(e.id, { ...prev, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined)), first_ts: prev.first_ts ?? e.ts });
  }
  // A row for a token with no price keeps its `usd: null` (the merge above drops nulls): "unknown", not "left out".
  return [...byId.values()].map((a) => ({ ...a, ...(a.unpriced === true ? { usd: null } : {}), explorer: explorerFor(a) }));
}

export function explorerFor(a) {
  const tx = Array.isArray(a.tx) ? a.tx[0] : a.tx;
  if (!tx || typeof tx !== "string") return null;
  // A row with no (or an unknown) chain is read as the EVM chain every v0.1 row was on.
  return explorerTx(isKnownChain(a.chain) ? a.chain : DEFAULT_EVM_CHAIN, tx);
}

/** Take a reservation back out. Only for spends that provably never went out. */
export function release(entry, reason, extra = {}) {
  return record({ id: entry.id, status: "failed", reason, ...extra });
}
