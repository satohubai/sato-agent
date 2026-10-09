// The spending limits. There are NO defaults: how much the agent may spend is
// the owner's call, from a few cents to thousands. Until both limits are set,
// every spend is refused with the command that sets them.
//
// A limit of `null` means "no limit", chosen explicitly.
//
// What these limits are, honestly: they are enforced by this program, on the
// same computer that holds the key. The agent itself can run `policy set`, edit
// these files, or write its own code that uses the key. They stop mistakes,
// loops and an agent that follows its rules; they do not stop a compromised
// agent. Every change is written to the ledger so the owner can see it. The hard
// bound is what the owner funds the wallet with.

import { paths, readJson, writePrivate } from "./store.js";
import { recordPolicyChange } from "./ledger.js";

export { Refused } from "./errors.js";

export const POLICY_SCHEMA = "sato-agent.policy/v1";

/** Parse a limit: a plain positive decimal number of USD, or "none". */
export function parseLimit(raw, flag) {
  if (raw === undefined) throw new Error(`${flag} is required: a USD amount, or "none" for no limit`);
  if (typeof raw !== "string") throw new Error(`${flag} needs a value: a USD amount, or "none"`);
  if (raw.toLowerCase() === "none") return null;
  if (!/^\d+(\.\d+)?$/.test(raw) || !(Number(raw) > 0)) throw new Error(`${flag} must be a positive USD amount like 25 or 0.5, or "none" (got "${raw}")`);
  return Number(raw);
}

export function loadPolicy() {
  return readJson(paths.policy());
}

const higher = (next, prev) => (prev === null ? false : next === null ? true : next > prev);

/**
 * Set or change the limits. Both are required the first time; later calls may
 * change one. Returns the new policy and whether any limit went UP (or a
 * recipient allowlist was removed), which the CLI flags loudly.
 */
export function setPolicy({ perTx, perDay, allowRecipients }) {
  const prev = loadPolicy();
  if (!prev && (perTx === undefined || perDay === undefined)) {
    throw new Error("first time: set both --per-tx and --per-day (a USD amount, or \"none\")");
  }
  const next = {
    schema: POLICY_SCHEMA,
    set_at: new Date().toISOString(),
    max_usd_per_tx: perTx === undefined ? prev.max_usd_per_tx : parseLimit(perTx, "--per-tx"),
    // Rolling 24 hours, not a calendar day.
    max_usd_per_day: perDay === undefined ? prev.max_usd_per_day : parseLimit(perDay, "--per-day"),
    // null = any recipient; a list = only these (lower-cased EVM, exact Solana).
    allow_recipients: allowRecipients === undefined ? (prev?.allow_recipients ?? null) : allowRecipients,
  };
  const raised = Boolean(
    prev &&
      (higher(next.max_usd_per_tx, prev.max_usd_per_tx) ||
        higher(next.max_usd_per_day, prev.max_usd_per_day) ||
        (Array.isArray(prev.allow_recipients) && next.allow_recipients === null)),
  );
  writePrivate(paths.policy(), JSON.stringify(next, null, 2) + "\n");
  recordPolicyChange({ from: prev, to: next, raised });
  return { policy: next, raised, first: !prev };
}

const norm = (a) => (a.startsWith("0x") ? a.toLowerCase() : a);

/**
 * Check one spend against the limits. Returns the refusals (empty = allowed).
 * Each refusal names the rule, the limit and what was observed.
 */
export function evaluate(policy, { usd, to }, spent) {
  if (!policy) {
    return [{ rule: "limits_not_set", limit: null, observed: null, message: "no spending limits are set yet: the owner runs `sato-agent policy set --per-tx <usd|none> --per-day <usd|none>`" }];
  }
  const s = typeof spent === "number" ? { usd: spent, unreadable: [] } : spent;
  if (s.unreadable.length) {
    return [{ rule: "ledger_unreadable", limit: null, observed: s.unreadable, message: `the spend ledger has unreadable line(s) ${s.unreadable.join(", ")}; spending is stopped until the owner looks at ${paths.ledger()}` }];
  }
  const out = [];
  if (!(usd > 0)) out.push({ rule: "amount", limit: ">0", observed: usd, message: "amount must be positive" });
  if (policy.max_usd_per_tx !== null && usd > policy.max_usd_per_tx) {
    out.push({ rule: "max_usd_per_tx", limit: policy.max_usd_per_tx, observed: usd, message: `over the per-transaction limit of $${policy.max_usd_per_tx}` });
  }
  if (policy.max_usd_per_day !== null && s.usd + usd > policy.max_usd_per_day) {
    out.push({
      rule: "max_usd_per_day",
      limit: policy.max_usd_per_day,
      observed: round(s.usd + usd),
      message: `would bring the last 24 hours to $${round(s.usd + usd)}, over the limit of $${policy.max_usd_per_day} ($${round(s.usd)} already spent)`,
    });
  }
  if (Array.isArray(policy.allow_recipients) && to && !policy.allow_recipients.map(norm).includes(norm(to))) {
    out.push({ rule: "allow_recipients", limit: policy.allow_recipients, observed: to, message: "recipient is not on the allowlist" });
  }
  return out;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
