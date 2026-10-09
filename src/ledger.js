// Append-only record of every spend. "Spent today" (UTC) is computed from it, so
// the daily limit survives restarts. A spend is written BEFORE it is broadcast
// (status "submitted"); if it then fails, a "failed" line with the same id
// takes it back out of today's total. A crash between the two errs on the side
// of counting it.

import { randomUUID } from "node:crypto";
import { appendLine, paths, readLines } from "./store.js";

export function record(entry) {
  const line = { id: entry.id ?? randomUUID(), ts: new Date().toISOString(), ...entry };
  appendLine(paths.ledger(), line);
  return line;
}

export function entries() {
  return readLines(paths.ledger());
}

const day = (iso) => iso.slice(0, 10);

/** USD spent on the given UTC day (default today): submitted spends minus the ones that failed. */
export function spentOn(date = new Date().toISOString(), list = entries()) {
  const failed = new Set(list.filter((e) => e.status === "failed").map((e) => e.id));
  return list
    .filter((e) => e.status === "submitted" && day(e.ts) === day(date) && !failed.has(e.id))
    .reduce((sum, e) => sum + (Number(e.usd) || 0), 0);
}
