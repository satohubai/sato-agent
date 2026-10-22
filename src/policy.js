// The owner's choices: spending limits, which chain(s) this agent works on,
// whether a Sato Hub check can stop a spend, and whether the agent asks first.
// There are NO defaults for limits or chains: how much the agent may spend, and
// where, is the owner's call. Until they are set, every spend is refused with
// the command that sets them.
//
// A limit of `null` means "no limit", chosen explicitly.
//
// What these choices are, honestly: they are enforced by this program, on the
// same computer that holds the key. They stop mistakes, loops, bad quotes and an
// agent that follows its rules. Since v0.6.0 a change that lets the agent do MORE
// (a raise) waits RAISE_DELAY_MS before it takes effect, is shown as pending in
// `status` and can be cancelled (`policy cancel`); a change that tightens takes
// effect at once. The files are sealed (src/integrity.js), so a hand edit freezes
// spending instead of slipping past the raise log. None of this stops a program
// that takes full control of this computer: it can read the key and sign without
// the kit. The hard bound is what the owner funds the wallet with.

import { isAddress as isEvmAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";
import { randomUUID } from "node:crypto";
import { paths, readJson } from "./store.js";
import { DEFAULT_EVM_CHAIN, chainKeys, chainsWith, evmChainKeys, hasFeature, isEvm, labelList, labelOf, orList, pipeList } from "./chains.js";
import { Refused } from "./errors.js";
import { commitPolicy, inspect, lastRecordedPolicy, pauseRefusal, policyFileText } from "./integrity.js";

export { Refused } from "./errors.js";

/**
 * How long a raise waits before it takes effect: 24 hours. It matches the rolling 24-hour limit, so a raise asked for by
 * anyone but the owner cannot take effect before the owner's next daily look at the chat or `status`, and before it does,
 * the agent can spend at most one more day under the limits the owner set. Shorter would land while the owner sleeps;
 * longer makes a real raise slow without adding a check. There is no way to skip it from this computer: anything the owner
 * could type to skip it, the agent could type too.
 */
export const RAISE_DELAY_MS = 24 * 60 * 60 * 1000;

export const POLICY_SCHEMA = "sato-agent.policy/v2";
// The chains an owner can choose: every chain in the registry (src/chains.js).
export const CHAINS = chainKeys();
/** How `--chains` is written in a message: one chain of the registry, or a comma-separated list ("base|bnb|...|base,bnb,..."). */
export const CHAINS_USAGE = `${pipeList(CHAINS)}|${CHAINS.join(",")}`;
// What a v0.1 policy (no `chains` field) meant: both chains that existed then. Pinned, so a chain added to the registry later
// never becomes allowed by a policy that never chose it.
const LEGACY_CHAINS = Object.freeze(["base", "solana"]);
// How strictly a Sato Hub check gates a spend (owner's choice; unset = it only informs).
export const CHECK_GATES = ["off", "no", "caution"]; // "no": refuse on a `no` verdict; "caution": refuse on `caution` or `no`
export const APPROVAL_MODES = ["auto", "ask"]; // "ask": every spend needs the owner's approval of that exact intent
export const UNAVAILABLE_MODES = ["allow", "refuse"]; // when the check cannot be run
// Purchases (gift cards, Amazon orders, checkouts): "ask" (the default, also when unset) shows the price and waits for the
// owner's yes; "auto" buys within the limits. x402 `pay` and `send` keep following `approval`.
export const PURCHASE_MODES = ["ask", "auto"];

/**
 * True unless BOTH choices are "auto": the stricter of `approval` and `purchase_approval` wins. An unset purchase choice
 * asks, and an owner who chose "ask before every payment" is asked before every purchase too.
 */
export const purchasesAsk = (p) => p?.purchase_approval !== "auto" || p?.approval === "ask";

/** Parse a limit: a plain positive decimal number of USD, or "none". */
export function parseLimit(raw, flag) {
  if (raw === undefined) throw new Error(`${flag} is required: a USD amount, or "none" for no limit`);
  if (typeof raw !== "string") throw new Error(`${flag} needs a value: a USD amount, or "none"`);
  if (raw.toLowerCase() === "none") return null;
  // At most 6 decimals (USDC's precision), the same rule as amounts: a limit is never rounded.
  if (!/^\d+(\.\d{1,6})?$/.test(raw) || !(Number(raw) > 0)) throw new Error(`${flag} must be a positive USD amount like 25 or 0.5 (at most 6 decimals), or "none" (got "${raw}")`);
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

/**
 * The policy in force now: policy.json with every queued raise whose time has come applied. Raises still waiting stay in
 * `pending` ({ part: { values, requested_at, effective_at } }), for `status` to show.
 */
export function loadPolicy({ now = Date.now() } = {}) {
  return fold(readJson(paths.policy()), now);
}

/** Apply the queued raises that are due at `now`. An entry whose time cannot be read never takes effect. */
export function fold(p, now = Date.now()) {
  if (!p || !p.pending || typeof p.pending !== "object") return p;
  const out = { ...p };
  const left = {};
  for (const [key, e] of Object.entries(p.pending)) {
    const part = PARTS.find((x) => x.key === key);
    if (part && e && e.values && typeof e.values === "object" && Date.parse(e.effective_at) <= now) {
      for (const f of part.fields) if (Object.hasOwn(e.values, f)) out[f] = e.values[f];
    } else left[key] = e;
  }
  if (Object.keys(left).length) out.pending = left;
  else delete out.pending;
  return out;
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
  if (Array.isArray(prev.chains) && (next.chains ?? LEGACY_CHAINS).some((c) => !prev.chains.includes(c))) r.push("chains widened");
  // Gates order strictest-last; a move toward "off" (or unset) loosens.
  if (looser(["off", "no", "caution"], next.check_gate, prev.check_gate)) r.push("check_gate loosened");
  if (prev.approval === "ask" && next.approval !== "ask") r.push("approval: ask -> auto");
  // Unset means "ask", so unset -> auto is a raise too.
  if (purchasesAsk(prev) && !purchasesAsk(next)) r.push("purchases: ask -> auto");
  // Unset counts as "refuse" (gateRefusals fails closed), so unset -> allow is a raise too. It only means something while a
  // gate is on before and after: turning a gate on from "off" never lets the agent do more, whatever it does when a check can't run.
  const gateOn = (p) => p.check_gate === "no" || p.check_gate === "caution";
  if (gateOn(prev) && gateOn(next) && (prev.on_check_unavailable ?? "refuse") === "refuse" && next.on_check_unavailable === "allow") r.push("on_check_unavailable: refuse -> allow");
  // Swaps: turning them on, removing or raising a cap all let the agent do more.
  if (swapsEnabled(next) && !swapsEnabled(prev)) r.push("swaps turned on");
  // Bridges (v0.5): turning them on lets the agent do more.
  if (bridgesEnabled(next) && !bridgesEnabled(prev)) r.push("bridges turned on");
  if (swapsEnabled(prev) && swapsEnabled(next)) {
    if (Number.isInteger(prev.max_slippage_bps) && !(Number.isInteger(next.max_slippage_bps) && next.max_slippage_bps <= prev.max_slippage_bps)) r.push("max_slippage_bps");
    if (Number.isInteger(prev.max_trades_per_day) && !(Number.isInteger(next.max_trades_per_day) && next.max_trades_per_day <= prev.max_trades_per_day)) r.push("max_trades_per_day");
  }
  return r;
}

/**
 * Swaps are on once the owner's spending limits exist (owner decision 2026-10-09: the
 * owner is told they can trade any token; slippage and price impact come up per trade,
 * not at setup). `--swaps off` turns them off. The slippage and trades-per-24h caps are
 * optional, and enforced when set.
 */
export const swapsEnabled = (p) => Boolean(p) && p.swaps_off !== true && !isLegacySwapsOff(p);

/**
 * A policy written before v0.3 that had swaps OFF. v0.2's "off" deleted the caps and left no marker, and v0.2 only
 * turned swaps on by setting a slippage cap, so a policy with neither a `swaps_off` key nor a slippage cap is one the
 * owner never turned swaps on for. It stays off until the owner runs `policy set --swaps on` (which is then a raise).
 * From v0.3 on, setPolicy always writes an explicit `swaps_off` boolean.
 */
export const isLegacySwapsOff = (p) => Boolean(p) && !Object.hasOwn(p, "swaps_off") && !Number.isInteger(p.max_slippage_bps);

/**
 * Bridges (a move of the agent's own funds from one of its chains to another, through deBridge) are on once the owner's policy says so:
 * a policy written by v0.5 or later always carries an explicit `bridges_off` (false for a new policy), and `policy set --bridges
 * off|on` changes it. A policy written BEFORE v0.5 has no such key and reads as OFF, like swaps for a pre-v0.3 policy: the owner has
 * never been told bridging exists, so it stays off until they say `policy set --bridges on` (which is then a raise). The same limits
 * (per transaction, per 24 hours) apply as for a swap.
 */
export const bridgesEnabled = (p) => Boolean(p) && p.bridges_off !== true && !isLegacyBridgesOff(p);

/** A policy written before v0.5: it has no `bridges_off` key, so bridging was never offered to its owner and stays off. */
export const isLegacyBridgesOff = (p) => Boolean(p) && !Object.hasOwn(p, "bridges_off");

function parseBps(raw) {
  if (raw === undefined) return undefined;
  if (raw === "off") return "off";
  if (raw === "none") return null;
  // 500 bps (5%) is the most either chain's swap path accepts.
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 500) throw new Error("--swap-slippage-bps must be a whole number from 1 to 500 (basis points; 50 = 0.5%), \"none\" for no cap, or \"off\" to turn swaps off");
  return Number(raw);
}

function parseTrades(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.toLowerCase() === "none") return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) throw new Error("--max-trades-per-day must be a whole number of swaps per 24 hours (1 or more), or \"none\"");
  return Number(raw);
}

const limitText = (v) => (v === null || v === undefined ? "no limit" : `$${v}`);
const gateText = (p) => (p.check_gate === "no" || p.check_gate === "caution" ? `stop on "${p.check_gate === "caution" ? "caution or no" : "no"}"${p.on_check_unavailable ? ` (if a check can't run: ${p.on_check_unavailable})` : ""}` : "inform only");
const listText = (l) => (Array.isArray(l) ? l.join(", ") : "any");

/**
 * The parts of the policy a raise can loosen, with the fields each covers. A change that loosens a part is queued for
 * RAISE_DELAY_MS in `pending`; until then the part keeps its old value (for a list, only what stays on it: removing an address
 * or a chain is a tightening and applies at once). A change that tightens a part, or sets it again, applies at once and drops
 * anything queued for that part: the owner's latest word on it wins. `raise` names the raisesBetween() lines that belong to it.
 */
export const PARTS = [
  { key: "per_tx", fields: ["max_usd_per_tx"], opts: ["perTx"], raise: ["max_usd_per_tx"], text: (c, n) => `per transaction: ${limitText(c.max_usd_per_tx)} → ${limitText(n.max_usd_per_tx)}` },
  { key: "per_day", fields: ["max_usd_per_day"], opts: ["perDay"], raise: ["max_usd_per_day"], text: (c, n) => `per 24 hours: ${limitText(c.max_usd_per_day)} → ${limitText(n.max_usd_per_day)}` },
  {
    key: "recipients",
    fields: ["allow_recipients"],
    opts: ["allowRecipients"],
    raise: ["allow_recipients removed", "allow_recipients widened"],
    meet: (n, c) => ({ allow_recipients: n.allow_recipients === null ? c.allow_recipients : c.allow_recipients.filter((a) => n.allow_recipients.map(norm).includes(norm(a))) }),
    text: (c, n) => `recipients: ${listText(c.allow_recipients)} → ${listText(n.allow_recipients)}`,
  },
  {
    key: "chains",
    fields: ["chains"],
    opts: ["chains"],
    raise: ["chains widened"],
    meet: (n, c) => ({ chains: c.chains.filter((x) => (n.chains ?? LEGACY_CHAINS).includes(x)) }),
    text: (c, n) => `chains: ${listText(c.chains)} → ${listText(n.chains)}`,
  },
  { key: "check_gate", fields: ["check_gate", "on_check_unavailable"], opts: ["checkGate", "onCheckUnavailable"], raise: ["check_gate loosened", "on_check_unavailable: refuse -> allow"], text: (c, n) => `Sato Hub checks: ${gateText(c)} → ${gateText(n)}` },
  { key: "approval", fields: ["approval"], opts: ["approval"], raise: ["approval: ask -> auto"], text: (c, n) => `approval: ${c.approval ?? "auto"} → ${n.approval ?? "auto"}` },
  { key: "purchases", fields: ["purchase_approval"], opts: ["purchases"], raise: ["purchases: ask -> auto"], text: (c, n) => `purchases: ${c.purchase_approval ?? "ask"} → ${n.purchase_approval ?? "ask"}` },
  { key: "swaps", fields: ["swaps_off"], opts: ["swaps"], raise: ["swaps turned on"], meet: (_n, c) => ({ swaps_off: !swapsEnabled(c) }), text: () => "swaps: off → on" },
  { key: "slippage", fields: ["max_slippage_bps"], opts: ["swapSlippageBps"], raise: ["max_slippage_bps"], text: (c, n) => `swap slippage cap: ${c.max_slippage_bps ?? "none"} bps → ${Number.isInteger(n.max_slippage_bps) ? `${n.max_slippage_bps} bps` : "no cap"}` },
  { key: "trades", fields: ["max_trades_per_day"], opts: ["maxTradesPerDay"], raise: ["max_trades_per_day"], text: (c, n) => `swaps per 24 hours: ${c.max_trades_per_day ?? "no cap"} → ${Number.isInteger(n.max_trades_per_day) ? n.max_trades_per_day : "no cap"}` },
  { key: "bridges", fields: ["bridges_off"], opts: ["bridges"], raise: ["bridges turned on"], meet: (_n, c) => ({ bridges_off: !bridgesEnabled(c) }), text: () => "bridges: off → on" },
];

const pickFields = (p, fields) => Object.fromEntries(fields.map((f) => [f, p?.[f] ?? null]));
const canon = (v) => JSON.stringify(v, (_k, x) => (Array.isArray(x) ? [...x].map((a) => (typeof a === "string" ? norm(a) : a)).sort() : x));
const iso = (ms) => new Date(ms).toISOString();

/**
 * Each raise still waiting in `p.pending`, described against the policy in force now:
 * [{ part, change: "per 24 hours: $10 → $100", requested_at, effective_at }].
 */
export function pendingRaises(p) {
  if (!p?.pending) return [];
  return Object.entries(p.pending).map(([key, e]) => {
    const part = PARTS.find((x) => x.key === key);
    const change = part && e?.values ? part.text(p, { ...p, ...e.values }) : key;
    return { part: key, change, requested_at: e?.requested_at ?? null, effective_at: e?.effective_at ?? null };
  });
}

/** Spending is frozen (src/integrity.js): the owner repairs first; no choice changes until then. */
function assertNotFrozen() {
  const { problems } = inspect();
  if (problems.length) throw new Refused(problems);
}

/**
 * Set or change the owner's choices. The first time, both limits and the chains
 * are required (no defaults). Later calls may change any one. A change that lets
 * the agent do more (a raise) is queued for RAISE_DELAY_MS and returned in
 * `queued`, for the agent to tell the owner; the rest applies at once. Returns the
 * policy in force, what (if anything) the change loosened, and what was queued.
 */
export function setPolicy(opts, { now = Date.now() } = {}) {
  const { perTx, perDay, allowRecipients, chains, checkGate, approval, onCheckUnavailable, swapSlippageBps, maxTradesPerDay, swaps, purchases, bridges } = opts;
  assertNotFrozen();
  const stored = readJson(paths.policy());
  // If policy.json is gone (removed by a repair, or never written after a crash) but the
  // ledger recorded one, compare against that: starting over must still show up as a raise,
  // and wait like one.
  const recorded = stored ? null : lastRecordedPolicy();
  const base = stored ?? recorded;
  const prev = base ? fold(base, now) : null;
  if (!prev && (perTx === undefined || perDay === undefined)) {
    throw new Error("first time: set both --per-tx and --per-day (a USD amount, or \"none\")");
  }
  const nextChains = parseChains(chains);
  if (!prev && nextChains === undefined) throw new Error(`first time: set --chains (${CHAINS.join(", ")}): which chain(s) this agent may spend on`);
  const pick = (v, key, fallback = null) => (v === undefined ? (prev?.[key] ?? fallback) : v);
  const next = {
    schema: POLICY_SCHEMA,
    set_at: iso(now),
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
    // null = never chosen, which asks (purchasesAsk).
    purchase_approval: pick(parseChoice(purchases, PURCHASE_MODES, "--purchases"), "purchase_approval"),
  };
  // Swaps: on unless the owner turned them off (`--swaps off`, or the older `--swap-slippage-bps off`).
  // The two caps are optional; "none" removes one (a raise).
  const swapsChoice = parseChoice(swaps, ["on", "off"], "--swaps");
  const bps = parseBps(swapSlippageBps);
  const trades = parseTrades(maxTradesPerDay);
  // Unchanged by a change to something else: a policy that had swaps off (explicitly, or a pre-v0.3 one that never had them on)
  // keeps them off until `--swaps on`. A first policy has them on. The key is always written, so "off" is never implied by absence.
  const before = prev;
  const off = swapsChoice === "off" || bps === "off" ? true : swapsChoice === "on" ? false : before ? !swapsEnabled(before) : false;
  next.swaps_off = off;
  // Bridges: on for a new policy, off for one written before v0.5 until the owner says so. The key is always written, so "off" is never implied by absence.
  const bridgesChoice = parseChoice(bridges, ["on", "off"], "--bridges");
  next.bridges_off = bridgesChoice === "off" ? true : bridgesChoice === "on" ? false : before ? !bridgesEnabled(before) : false;
  const nextBps = bps === "off" ? undefined : bps !== undefined ? bps : prev?.max_slippage_bps;
  const nextTrades = trades !== undefined ? trades : prev?.max_trades_per_day;
  if (Number.isInteger(nextBps)) next.max_slippage_bps = nextBps;
  if (Number.isInteger(nextTrades)) next.max_trades_per_day = nextTrades;
  // "If a check can't run" only means something while a check can stop a spend. With the gate
  // off it is cleared, so status never shows a choice that does nothing (live test, 2026-10-09),
  // and turning the gate back on asks for it again (no default).
  if (!["no", "caution"].includes(next.check_gate)) next.on_check_unavailable = null;
  if (["no", "caution"].includes(next.check_gate) && !next.on_check_unavailable) {
    throw new Error("with --check-gate on, also choose --on-check-unavailable allow|refuse: what to do when the check can't run (no default)");
  }
  const raises = raisesBetween(prev, next);
  // Which parts loosen. "purchases: ask -> auto" with no change to the purchase choice itself is the approval part's doing.
  const loosened = new Set();
  for (const r of raises) {
    const part = PARTS.find((x) => x.raise.includes(r));
    if (!part) continue;
    if (part.key === "purchases" && next.purchase_approval === prev.purchase_approval) loosened.add("approval");
    else loosened.add(part.key);
  }
  if (!stored && recorded) raises.unshift("policy file was missing; compared with the last recorded policy");
  const touched = new Set(PARTS.filter((x) => x.opts.some((o) => opts[o] !== undefined)).map((x) => x.key));
  if (swapSlippageBps === "off") touched.add("swaps");
  const pending = { ...(prev?.pending ?? {}) };
  const out = { ...next };
  for (const part of PARTS) {
    if (loosened.has(part.key)) {
      const values = pickFields(next, part.fields);
      // Asking again for the same raise keeps its clock; anything else starts a new one.
      if (!(pending[part.key] && canon(pending[part.key].values) === canon(values))) pending[part.key] = { values, requested_at: iso(now), effective_at: iso(now + RAISE_DELAY_MS) };
      Object.assign(out, part.meet ? part.meet(next, prev) : pickFields(prev, part.fields));
    } else if (touched.has(part.key)) delete pending[part.key];
  }
  if (Object.keys(pending).length) out.pending = pending;
  else delete out.pending;
  const queued = pendingRaises(out).filter((q) => loosened.has(q.part));
  commitPolicy(policyFileText(out), {
    id: randomUUID(),
    ts: iso(now),
    kind: "policy",
    status: raises.length ? "raised" : "changed",
    raises,
    ...(queued.length ? { queued: queued.map(({ part, change, effective_at }) => ({ part, change, effective_at })) } : {}),
    from: base,
    to: out,
  });
  // The policy in force when this returns (a raise queued just now is not in it yet).
  return { policy: fold(out, Date.now()), raised: raises.length > 0, raises, queued, first: !prev };
}

/** Cancel every raise still waiting. Raises already in effect stay; tighten them with `policy set`. */
export function cancelPending({ now = Date.now() } = {}) {
  assertNotFrozen();
  const stored = readJson(paths.policy());
  const cur = fold(stored, now);
  const cancelled = pendingRaises(cur);
  if (!cancelled.length) return { policy: cur, cancelled };
  const out = { ...cur };
  delete out.pending;
  commitPolicy(policyFileText(out), { id: randomUUID(), ts: iso(now), kind: "policy", status: "cancelled", cancelled: cancelled.map(({ part, change, effective_at }) => ({ part, change, effective_at })), from: stored, to: out });
  return { policy: out, cancelled };
}

/** The chains this policy allows (a v1 policy with no `chains` allows both). */
export const allowedChains = (policy) => (policy && Array.isArray(policy.chains) ? policy.chains : LEGACY_CHAINS);

/**
 * Which EVM chain a command is about when the owner may have chosen several: `requested` (`--chain`) if given, else the owner's one
 * EVM chain that has `feature` (a registry feature: "register", "swap", ...; none = any EVM chain). A bot that works on two EVM
 * chains must say which; one that works on no EVM chain, or has no policy yet, gets the default (Base), as in v0.3.
 * Throws a plain Error (a usage problem) or Refused (the owner's choices, or the chain, rule it out).
 */
export function evmChainFor(requested, feature, policy = loadPolicy()) {
  const has = (k) => isEvm(k) && (feature === undefined || hasFeature(k, feature));
  const chains = policy && Array.isArray(policy.chains) ? policy.chains : null;
  const wanted = requested === undefined || requested === null ? undefined : String(requested).toLowerCase();
  if (wanted !== undefined) {
    if (!isEvm(wanted)) throw new Error(`--chain must be ${orList(evmChainKeys())} here`);
    if (!has(wanted)) throw new Refused([{ rule: "chain_no_feature", limit: chainsWith(feature), observed: wanted, message: `${feature} is not available on ${labelOf(wanted)}; it works on ${labelList(chainsWith(feature).filter(isEvm))}` }]);
    if (chains && !chains.includes(wanted)) throw new Refused([{ rule: "chain_not_allowed", limit: chains, observed: wanted, message: `this agent is set to work on ${chains.join(" and ")} only` }]);
    return wanted;
  }
  if (!chains) return DEFAULT_EVM_CHAIN;
  const mine = chains.filter(isEvm);
  const usable = mine.filter(has);
  if (usable.length === 1) return usable[0];
  if (usable.length > 1) throw new Error(`this agent works on ${labelList(usable)}: say which with --chain ${usable.join("|")}`);
  if (mine.length) throw new Refused([{ rule: "chain_no_feature", limit: chainsWith(feature), observed: mine, message: `${feature} is not available on ${labelList(mine)}; it works on ${labelList(chainsWith(feature).filter(isEvm))}` }]);
  return DEFAULT_EVM_CHAIN; // an agent with no EVM chain: the command's own check says so
}

/**
 * Check one spend against the limits. Returns the refusals (empty = allowed).
 * Each refusal names the rule, the limit and what was observed.
 */
export function evaluate(policy, spend, spent) {
  const { to, chain, kind, slippage_bps } = spend;
  // A token with no price (a send of an ordinary token) counts $0: the limits cannot measure it, and it is never refused for lacking a price.
  const usd = spend.unpriced === true ? 0 : spend.usd;
  const s = typeof spent === "number" ? { usd: spent, unreadable: [] } : spent;
  // An unreadable ledger line, or a ledger, policy or wallet that does not match its seal, stops everything before any other
  // rule (a deleted policy.json is "tampered", not "not set yet"); so does a pause after a repair or a restore.
  const stops = [
    ...(s.unreadable.length ? [{ rule: "ledger_unreadable", limit: null, observed: s.unreadable, message: `the spend ledger has unreadable line(s) ${s.unreadable.join(", ")}; spending is stopped until the owner looks at ${paths.ledger()}` }] : []),
    ...(s.frozen ?? []),
  ];
  if (stops.length) return stops;
  if (s.paused_until) return [pauseRefusal({ paused_until: s.paused_until }, 0)];
  if (!policy) {
    return [{ rule: "limits_not_set", limit: null, observed: null, message: "no spending limits are set yet: the owner runs `sato-agent policy set --chains <" + CHAINS_USAGE + "> --per-tx <usd|none> --per-day <usd|none>`" }];
  }
  const out = [];
  if (!Array.isArray(policy.chains)) {
    // A v0.1.0 policy never chose its chains. No default: choose before spending.
    return [{ rule: "chains_not_set", limit: null, observed: null, message: "choose which chain(s) this agent may spend on: `sato-agent policy set --chains <" + CHAINS_USAGE + ">`" }];
  }
  if (chain && !allowedChains(policy).includes(chain)) {
    out.push({ rule: "chain_not_allowed", limit: allowedChains(policy), observed: chain, message: `this agent is set to work on ${allowedChains(policy).join(" and ")} only` });
  }
  if (!(usd > 0) && spend.unpriced !== true) out.push({ rule: "amount", limit: ">0", observed: usd, message: "amount must be positive" });
  if (policy.max_usd_per_tx !== null && usd > policy.max_usd_per_tx) {
    out.push({ rule: "max_usd_per_tx", limit: policy.max_usd_per_tx, observed: usd, message: `over the per-transaction limit of $${policy.max_usd_per_tx}` });
  }
  // Compared in whole micro-dollars, so a spend that exactly reaches the limit is allowed.
  // The limit is rounded DOWN (a hand-edited policy with more decimals can only get stricter).
  if (policy.max_usd_per_day !== null && micro(s.usd) + micro(usd) > Math.floor(policy.max_usd_per_day * 1e6 + 1e-7)) {
    out.push({
      rule: "max_usd_per_day",
      limit: policy.max_usd_per_day,
      observed: round(s.usd + usd),
      message: `would bring the last 24 hours to $${round(s.usd + usd)}, over the limit of $${policy.max_usd_per_day} ($${round(s.usd)} already spent)`,
    });
  }
  // A swap pays a pinned router and the output comes back to the agent itself, and a bridge pays a pinned contract and the funds go to
  // the agent's own address on its other chain, so the payee allowlist does not apply to either; their own caps below do.
  if (kind !== "swap" && kind !== "bridge" && Array.isArray(policy.allow_recipients) && to && !policy.allow_recipients.map(norm).includes(norm(to))) {
    out.push({ rule: "allow_recipients", limit: policy.allow_recipients, observed: to, message: "recipient is not on the allowlist" });
  }
  if (kind === "swap") {
    if (!swapsEnabled(policy)) {
      out.push({ rule: "swaps_not_enabled", limit: null, observed: null, message: "the owner turned swaps off; they turn them back on with `sato-agent policy set --swaps on`" });
    } else {
      if (slippage_bps !== undefined && Number.isInteger(policy.max_slippage_bps) && slippage_bps > policy.max_slippage_bps) {
        out.push({ rule: "max_slippage_bps", limit: policy.max_slippage_bps, observed: slippage_bps, message: `slippage of ${slippage_bps} bps is over the owner's cap of ${policy.max_slippage_bps} bps` });
      }
      if (Number.isInteger(policy.max_trades_per_day) && (s.swaps ?? 0) + 1 > policy.max_trades_per_day) {
        out.push({ rule: "max_trades_per_day", limit: policy.max_trades_per_day, observed: (s.swaps ?? 0) + 1, message: `would be swap number ${(s.swaps ?? 0) + 1} in the last 24 hours; the owner's cap is ${policy.max_trades_per_day}` });
      }
    }
  }
  if (kind === "bridge" && !bridgesEnabled(policy)) {
    out.push({ rule: "bridges_not_enabled", limit: null, observed: null, message: "bridges are off for this agent; the owner turns them on with `sato-agent policy set --bridges on`" });
  }
  return out;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const micro = (n) => Math.round(n * 1e6);
