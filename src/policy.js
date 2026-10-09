// The owner's choices: spending limits, which chain(s) this agent works on,
// whether a Sato Hub check can stop a spend, and whether the agent asks first.
// There are NO defaults for limits or chains: how much the agent may spend, and
// where, is the owner's call. Until they are set, every spend is refused with
// the command that sets them.
//
// A limit of `null` means "no limit", chosen explicitly.
//
// What these choices are, honestly: they are enforced by this program, on the
// same computer that holds the key. The agent itself can run `policy set`, edit
// these files, or write its own code that uses the key. They stop mistakes,
// loops and an agent that follows its rules; they do not stop a compromised
// agent. Every change is written to the ledger, and any change that lets the
// agent do MORE is flagged as a raise. The hard bound is what the owner funds
// the wallet with.

import { isAddress as isEvmAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";
import { paths, readJson, writePrivate } from "./store.js";
import { entries, recordPolicyChange } from "./ledger.js";

export { Refused } from "./errors.js";

export const POLICY_SCHEMA = "sato-agent.policy/v2";
export const CHAINS = ["base", "solana"];
// How strictly a Sato Hub check gates a spend (owner's choice; unset = it only informs).
export const CHECK_GATES = ["off", "no", "caution"]; // "no": refuse on a `no` verdict; "caution": refuse on `caution` or `no`
export const APPROVAL_MODES = ["auto", "ask"]; // "ask": every spend needs the owner's approval of that exact intent
export const UNAVAILABLE_MODES = ["allow", "refuse"]; // when the check cannot be run

/** Parse a limit: a plain positive decimal number of USD, or "none". */
export function parseLimit(raw, flag) {
  if (raw === undefined) throw new Error(`${flag} is required: a USD amount, or "none" for no limit`);
  if (typeof raw !== "string") throw new Error(`${flag} needs a value: a USD amount, or "none"`);
  if (raw.toLowerCase() === "none") return null;
  if (!/^\d+(\.\d+)?$/.test(raw) || !(Number(raw) > 0)) throw new Error(`${flag} must be a positive USD amount like 25 or 0.5, or "none" (got "${raw}")`);
  return Number(raw);
}

function parseChoice(raw, allowed, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw.toLowerCase())) throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
  return raw.toLowerCase();
}

export function parseChains(raw) {
  if (raw === undefined) return undefined;
  const list = [...new Set(String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!list.length || list.some((c) => !CHAINS.includes(c))) throw new Error(`--chains must be one or more of: ${CHAINS.join(", ")} (comma-separated)`);
  return list.sort();
}

/** Validate an allowlist: every entry must be a Base (0x…) or Solana address. */
export function parseAllowlist(list) {
  if (list === undefined || list === null) return list;
  for (const a of list) {
    // strict:false accepts any well-formed 0x address, whatever its letter case (comparison is case-insensitive anyway).
    if (!(isEvmAddress(a, { strict: false }) || isSolanaAddress(a))) throw new Error(`--allow: "${a}" is not a Base or Solana address`);
  }
  return [...new Set(list)];
}

export function loadPolicy() {
  return readJson(paths.policy());
}

const norm = (a) => (a.startsWith("0x") ? a.toLowerCase() : a);
const higher = (next, prev) => (prev === null ? false : next === null ? true : next > prev);
const looser = (order, next, prev) => order.indexOf(next ?? order[0]) < order.indexOf(prev ?? order[0]);

/** Every way a change can let the agent do MORE than before. Empty = not a raise. */
export function raisesBetween(prev, next) {
  if (!prev) return [];
  const r = [];
  if (higher(next.max_usd_per_tx, prev.max_usd_per_tx)) r.push("max_usd_per_tx");
  if (higher(next.max_usd_per_day, prev.max_usd_per_day)) r.push("max_usd_per_day");
  if (Array.isArray(prev.allow_recipients)) {
    if (next.allow_recipients === null) r.push("allow_recipients removed");
    else if (next.allow_recipients.some((a) => !prev.allow_recipients.map(norm).includes(norm(a)))) r.push("allow_recipients widened");
  }
  if (Array.isArray(prev.chains) && (next.chains ?? CHAINS).some((c) => !prev.chains.includes(c))) r.push("chains widened");
  // Gates order strictest-last; a move toward "off" (or unset) loosens.
  if (looser(["off", "no", "caution"], next.check_gate, prev.check_gate)) r.push("check_gate loosened");
  if (prev.approval === "ask" && next.approval !== "ask") r.push("approval: ask -> auto");
  // Unset counts as "refuse" (gateRefusals fails closed), so unset -> allow is a raise too.
  if ((prev.on_check_unavailable ?? "refuse") === "refuse" && next.on_check_unavailable === "allow") r.push("on_check_unavailable: refuse -> allow");
  // Swaps: turning them on, allowing more slippage, or more trades a day all let the agent do more.
  if (swapsEnabled(next) && !swapsEnabled(prev)) r.push("swaps turned on");
  if (swapsEnabled(prev) && swapsEnabled(next)) {
    if (next.max_slippage_bps > prev.max_slippage_bps) r.push("max_slippage_bps");
    if (higher(next.max_trades_per_day, prev.max_trades_per_day)) r.push("max_trades_per_day");
  }
  return r;
}

/** Swaps are off until the owner sets both a slippage cap and a trades-per-24h cap (no defaults). */
export const swapsEnabled = (p) => Boolean(p) && Number.isInteger(p.max_slippage_bps) && p.max_trades_per_day !== undefined;

function parseBps(raw) {
  if (raw === undefined) return undefined;
  if (raw === "off") return "off";
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) throw new Error("--swap-slippage-bps must be a whole number from 1 to 1000 (basis points; 50 = 0.5%), or \"off\" to turn swaps off");
  return Number(raw);
}

function parseTrades(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.toLowerCase() === "none") return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) throw new Error("--max-trades-per-day must be a whole number of swaps per 24 hours (1 or more), or \"none\"");
  return Number(raw);
}

/**
 * Set or change the owner's choices. The first time, both limits and the chains
 * are required (no defaults). Later calls may change any one. Returns the new
 * policy and what (if anything) it loosened, which the CLI flags loudly.
 */
export function setPolicy({ perTx, perDay, allowRecipients, chains, checkGate, approval, onCheckUnavailable, swapSlippageBps, maxTradesPerDay }) {
  const prev = loadPolicy();
  // If policy.json is gone (deleted, or never written after a crash) but the
  // ledger recorded one, compare against that: deleting the file and starting
  // over must still show up as a raise.
  const recorded = prev ? null : [...entries()].reverse().find((e) => e.kind === "policy" && e.to)?.to ?? null;
  if (!prev && (perTx === undefined || perDay === undefined)) {
    throw new Error("first time: set both --per-tx and --per-day (a USD amount, or \"none\")");
  }
  const nextChains = parseChains(chains);
  if (!prev && nextChains === undefined) throw new Error(`first time: set --chains (${CHAINS.join(", ")}): which chain(s) this agent may spend on`);
  const pick = (v, key, fallback = null) => (v === undefined ? (prev?.[key] ?? fallback) : v);
  const next = {
    schema: POLICY_SCHEMA,
    set_at: new Date().toISOString(),
    max_usd_per_tx: perTx === undefined ? prev.max_usd_per_tx : parseLimit(perTx, "--per-tx"),
    // Rolling 24 hours, not a calendar day.
    max_usd_per_day: perDay === undefined ? prev.max_usd_per_day : parseLimit(perDay, "--per-day"),
    // null = any recipient; a list = only these (lower-cased EVM, exact Solana).
    allow_recipients: allowRecipients === undefined ? (prev?.allow_recipients ?? null) : parseAllowlist(allowRecipients),
    // A v1 policy (no chains) keeps working on both chains; `status` says so.
    chains: pick(nextChains, "chains"),
    check_gate: pick(parseChoice(checkGate, CHECK_GATES, "--check-gate"), "check_gate"),
    approval: pick(parseChoice(approval, APPROVAL_MODES, "--approval"), "approval"),
    on_check_unavailable: pick(parseChoice(onCheckUnavailable, UNAVAILABLE_MODES, "--on-check-unavailable"), "on_check_unavailable"),
  };
  // Swaps: off until both caps are set; "--swap-slippage-bps off" turns them off again.
  const bps = parseBps(swapSlippageBps);
  const trades = parseTrades(maxTradesPerDay);
  if (bps === "off") {
    delete next.max_slippage_bps;
    delete next.max_trades_per_day;
  } else {
    const nextBps = bps ?? prev?.max_slippage_bps;
    const nextTrades = trades !== undefined ? trades : prev?.max_trades_per_day;
    if (nextBps !== undefined && nextTrades === undefined) throw new Error("to turn swaps on, set both --swap-slippage-bps and --max-trades-per-day (no defaults)");
    if (nextTrades !== undefined && nextBps === undefined) throw new Error("to turn swaps on, set both --swap-slippage-bps and --max-trades-per-day (no defaults)");
    if (nextBps !== undefined) {
      next.max_slippage_bps = nextBps;
      next.max_trades_per_day = nextTrades;
    }
  }
  if (["no", "caution"].includes(next.check_gate) && !next.on_check_unavailable) {
    throw new Error("with --check-gate on, also choose --on-check-unavailable allow|refuse: what to do when the check can't run (no default)");
  }
  const raises = raisesBetween(prev ?? recorded, next);
  if (!prev && recorded) raises.unshift("policy file was missing; compared with the last recorded policy");
  writePrivate(paths.policy(), JSON.stringify(next, null, 2) + "\n", { atomic: true });
  recordPolicyChange({ from: prev ?? recorded, to: next, raised: raises.length > 0, raises });
  return { policy: next, raised: raises.length > 0, raises, first: !prev && !recorded };
}

/** The chains this policy allows (a v1 policy with no `chains` allows both). */
export const allowedChains = (policy) => (policy && Array.isArray(policy.chains) ? policy.chains : CHAINS);

/**
 * Check one spend against the limits. Returns the refusals (empty = allowed).
 * Each refusal names the rule, the limit and what was observed.
 */
export function evaluate(policy, { usd, to, chain, kind, slippage_bps }, spent) {
  if (!policy) {
    return [{ rule: "limits_not_set", limit: null, observed: null, message: "no spending limits are set yet: the owner runs `sato-agent policy set --chains <base|solana> --per-tx <usd|none> --per-day <usd|none>`" }];
  }
  const s = typeof spent === "number" ? { usd: spent, unreadable: [] } : spent;
  if (s.unreadable.length) {
    return [{ rule: "ledger_unreadable", limit: null, observed: s.unreadable, message: `the spend ledger has unreadable line(s) ${s.unreadable.join(", ")}; spending is stopped until the owner looks at ${paths.ledger()}` }];
  }
  const out = [];
  if (!Array.isArray(policy.chains)) {
    // A v0.1.0 policy never chose its chains. No default: choose before spending.
    return [{ rule: "chains_not_set", limit: null, observed: null, message: "choose which chain(s) this agent may spend on: `sato-agent policy set --chains <base|solana|base,solana>`" }];
  }
  if (chain && !allowedChains(policy).includes(chain)) {
    out.push({ rule: "chain_not_allowed", limit: allowedChains(policy), observed: chain, message: `this agent is set to work on ${allowedChains(policy).join(" and ")} only` });
  }
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
  // A swap pays a pinned router and the output comes back to the agent itself,
  // so the payee allowlist does not apply; its own caps below do.
  if (kind !== "swap" && Array.isArray(policy.allow_recipients) && to && !policy.allow_recipients.map(norm).includes(norm(to))) {
    out.push({ rule: "allow_recipients", limit: policy.allow_recipients, observed: to, message: "recipient is not on the allowlist" });
  }
  if (kind === "swap") {
    if (!swapsEnabled(policy)) {
      out.push({ rule: "swaps_not_enabled", limit: null, observed: null, message: "swaps are off: the owner turns them on with `sato-agent policy set --swap-slippage-bps <1-1000> --max-trades-per-day <n|none>`" });
    } else {
      if (slippage_bps !== undefined && slippage_bps > policy.max_slippage_bps) {
        out.push({ rule: "max_slippage_bps", limit: policy.max_slippage_bps, observed: slippage_bps, message: `slippage of ${slippage_bps} bps is over the owner's cap of ${policy.max_slippage_bps} bps` });
      }
      if (policy.max_trades_per_day !== null && (s.swaps ?? 0) + 1 > policy.max_trades_per_day) {
        out.push({ rule: "max_trades_per_day", limit: policy.max_trades_per_day, observed: (s.swaps ?? 0) + 1, message: `would be swap number ${(s.swaps ?? 0) + 1} in the last 24 hours; the owner's cap is ${policy.max_trades_per_day}` });
      }
    }
  }
  return out;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
