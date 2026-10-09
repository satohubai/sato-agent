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
// ledger would reset the limits, so it must never be the easy fix.

import { randomUUID } from "node:crypto";
import { appendLine, paths, readLines, withLock } from "./store.js";
import { evaluate } from "./policy.js";
import { Refused } from "./errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function record(entry) {
  const line = { id: entry.id ?? randomUUID(), ts: new Date().toISOString(), ...entry };
  appendLine(paths.ledger(), line);
  return line;
}

export function recordPolicyChange({ from, to, raised }) {
  return record({ kind: "policy", status: raised ? "raised" : "changed", from, to });
}

export function read() {
  return readLines(paths.ledger());
}

export function entries() {
  return read().rows;
}

/** USD reserved in the 24 hours before `now`, minus spends that provably never went out. */
export function spentLast24h(now = Date.now(), ledger = read()) {
  const failed = new Set(ledger.rows.filter((e) => e.status === "failed").map((e) => e.id));
  const usd = ledger.rows
    .filter((e) => e.status === "submitted" && now - Date.parse(e.ts) < DAY_MS && !failed.has(e.id))
    .reduce((sum, e) => sum + (Number(e.usd) || 0), 0);
  return { usd, unreadable: ledger.bad };
}

/**
 * Check a spend against the limits and reserve it, atomically across every
 * process on this machine. Throws Refused (nothing reserved) when the limits say no.
 */
export async function reserve(policy, spend) {
  return withLock(async () => {
    const refusals = evaluate(policy, spend, spentLast24h());
    if (refusals.length) throw new Refused(refusals);
    return record({ status: "submitted", ...spend });
  });
}

/** Take a reservation back out. Only for spends that provably never went out. */
export function release(entry, reason, extra = {}) {
  return record({ id: entry.id, status: "failed", reason, ...extra });
}
