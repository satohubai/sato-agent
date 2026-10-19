// Why the last `swap` did not finish, told to Sato Hub once, on the next swap quote.
//
// On 2026-10-19 a bot failed about a dozen kit sells in four minutes, then sold the
// same amount outside the kit, without the Sato Hub fee and without the kit's checks.
// Sato Hub saw only the quotes, never why the kit stopped. So the kit keeps one small
// note about its LAST swap that ended without a swap: the exit code and the rule ids
// that stopped it (e.g. "max_usd_per_tx", "solana_swap.price_impact"), never amounts,
// addresses, tokens, error text or anything the owner typed. The next swap quote sends
// it once in the `x-sato-agent-last-outcome` header and the note is deleted. A note
// older than a day is dropped unsent. README "What is reported" says the same.

import fs from "node:fs";
import { join } from "node:path";
import { home, writePrivate } from "./store.js";

export const OUTCOME_HEADER = "x-sato-agent-last-outcome";

/** A rule id or approval code: lower-case words, dots, dashes and digits. Anything else is dropped, never sent. */
const RULE = /^[a-z0-9_.-]{1,64}$/;
const MAX_RULES = 5;
const MAX_AGE_MS = 24 * 3600 * 1000;

const file = () => join(home(), "last-outcome.json");
const cleanRules = (rules) => [...new Set((rules ?? []).map(String).filter((r) => RULE.test(r)))].slice(0, MAX_RULES);

/** Note how the last swap ended (exit code + rule ids). Never throws: a note that cannot be written is simply not sent. */
export function recordSwapOutcome({ exit, rules }, now = Date.now()) {
  if (!Number.isInteger(exit)) return;
  try {
    writePrivate(file(), `${JSON.stringify({ exit, rules: cleanRules(rules), at: now })}\n`, { atomic: true });
  } catch {
    /* no state folder yet, or read-only: nothing to report */
  }
}

/**
 * Read and delete the note: the header value to send ("exit=3;rules=a,b"), or null when there
 * is none, it is older than a day, or it cannot be read. Never throws.
 */
export function takeSwapOutcome(now = Date.now()) {
  try {
    if (!fs.existsSync(file())) return null;
    const raw = fs.readFileSync(file(), "utf8");
    fs.unlinkSync(file());
    const o = JSON.parse(raw);
    if (!o || !Number.isInteger(o.exit) || o.exit < 0 || o.exit > 255 || typeof o.at !== "number" || now - o.at > MAX_AGE_MS || now < o.at) return null;
    const rules = cleanRules(o.rules);
    return `exit=${o.exit}${rules.length ? `;rules=${rules.join(",")}` : ""}`;
  } catch {
    return null;
  }
}
