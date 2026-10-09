// The owner's spending limits. There are NO defaults: how much the agent may
// spend is the owner's call, from a few cents to thousands. Until the owner has
// set both limits, every spend is refused with the command that sets them.
//
// A limit of `null` means the owner chose "no limit" explicitly.
//
// Honest scope: these limits are enforced by this program. The agent's machine
// also holds the key, so code that bypasses this program could spend past them.
// The hard bound is what the owner funds the wallet with.

import { paths, readJson, writePrivate } from "./store.js";

export const POLICY_SCHEMA = "sato-agent.policy/v1";

/** Parse a limit the owner typed: a positive number of USD, or "none". */
export function parseLimit(raw, flag) {
  if (raw === undefined) throw new Error(`${flag} is required: a USD amount, or "none" for no limit`);
  if (String(raw).toLowerCase() === "none") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive USD amount or "none" (got "${raw}")`);
  return n;
}

export function loadPolicy() {
  return readJson(paths.policy());
}

/** Set (or change) the limits. Both are required the first time; later calls may change one. */
export function setPolicy({ perTx, perDay, allowRecipients }) {
  const prev = loadPolicy();
  if (!prev && (perTx === undefined || perDay === undefined)) {
    throw new Error("first time: set both --per-tx and --per-day (a USD amount, or \"none\")");
  }
  const next = {
    schema: POLICY_SCHEMA,
    set_at: new Date().toISOString(),
    max_usd_per_tx: perTx === undefined ? prev.max_usd_per_tx : parseLimit(perTx, "--per-tx"),
    max_usd_per_day: perDay === undefined ? prev.max_usd_per_day : parseLimit(perDay, "--per-day"),
    // null = any recipient; a list = only these (lower-cased EVM, exact Solana).
    allow_recipients: allowRecipients === undefined ? (prev?.allow_recipients ?? null) : allowRecipients,
  };
  writePrivate(paths.policy(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

const norm = (a) => (a.startsWith("0x") ? a.toLowerCase() : a);

/**
 * Check one spend against the owner's limits. Returns the refusals (empty = allowed).
 * Each refusal names the rule, the limit and what was observed.
 */
export function evaluate(policy, { usd, to }, spentTodayUsd) {
  if (!policy) {
    return [{ rule: "limits_not_set", limit: null, observed: null, message: "the owner has not set spending limits yet: run `sato-agent policy set --per-tx <usd|none> --per-day <usd|none>`" }];
  }
  const out = [];
  if (!(usd > 0)) out.push({ rule: "amount", limit: ">0", observed: usd, message: "amount must be positive" });
  if (policy.max_usd_per_tx !== null && usd > policy.max_usd_per_tx) {
    out.push({ rule: "max_usd_per_tx", limit: policy.max_usd_per_tx, observed: usd, message: `over the per-transaction limit of $${policy.max_usd_per_tx}` });
  }
  if (policy.max_usd_per_day !== null && spentTodayUsd + usd > policy.max_usd_per_day) {
    out.push({
      rule: "max_usd_per_day",
      limit: policy.max_usd_per_day,
      observed: round(spentTodayUsd + usd),
      message: `would bring today's spend to $${round(spentTodayUsd + usd)}, over the daily limit of $${policy.max_usd_per_day} ($${round(spentTodayUsd)} already spent today, UTC)`,
    });
  }
  if (Array.isArray(policy.allow_recipients) && to && !policy.allow_recipients.map(norm).includes(norm(to))) {
    out.push({ rule: "allow_recipients", limit: policy.allow_recipients, observed: to, message: "recipient is not on the owner's allowlist" });
  }
  return out;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

export class Refused extends Error {
  constructor(refusals) {
    super(refusals.map((r) => `REFUSED ${r.rule}: ${r.message}`).join("\n"));
    this.refusals = refusals;
  }
}
