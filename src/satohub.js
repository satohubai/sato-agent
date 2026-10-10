// Sato Hub's MCP server (https://satohub.ai/api/mcp): no key, no account.
// Used for the checks the agent runs BEFORE it spends or installs:
//   preflight   dated evidence on an x402 URL, a recipient address, a repo, a package
//   check       what an install command does with keys and money
//   recommend   a stack for a build goal
//
// A check describes; it never says "safe". `unknown` means no record, never
// "something is wrong". Whether a verdict can STOP a spend is the owner's
// choice (policy `check_gate`): "no" refuses on a `no` verdict, "caution"
// refuses on `caution` or `no`, unset/"off" only informs. A `go` never means
// the spend is safe; it means nothing on record stood in the way.

import { USER_AGENT } from "./version.js";

export const DEFAULT_MCP_URL = "https://satohub.ai/api/mcp";
export const MCP_URL = process.env.SATO_AGENT_MCP_URL || DEFAULT_MCP_URL;
/** True when checks go somewhere other than Sato Hub (tests, or a changed environment). Logged on every gated check. */
export const customEndpoint = () => MCP_URL !== DEFAULT_MCP_URL;

export async function callTool(name, args, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop() ?? raw;
  const msg = JSON.parse(data);
  if (msg.error) throw new Error(`Sato Hub: ${msg.error.message}`);
  const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, structured: msg.result?.structuredContent ?? null, isError: Boolean(msg.result?.isError) };
}

export const preflight = (args) => callTool("onchain_agent_preflight", args);
export const checkInstall = (command) => callTool("onchain_agent_check_install", { command });
export const recommend = (goal, chain) => callTool("onchain_agent_recommend_stack", chain ? { goal, chain } : { goal });

const VERDICTS = ["go", "caution", "no", "unknown"];

/**
 * Run a Preflight check before a spend. Never throws: a slow or failing Sato
 * Hub, or a tool error, comes back as { unavailable: true } so the caller can
 * apply the owner's `on_check_unavailable` choice.
 */
export async function runCheck(args, expectKind) {
  try {
    const r = await preflight(args);
    const s = r.structured;
    const verdict = typeof s?.verdict === "string" ? s.verdict.toLowerCase() : null;
    let reason = null;
    if (r.isError) reason = "tool error";
    else if (!VERDICTS.includes(verdict)) reason = "no verdict";
    // The answer must be about the thing we asked about: if Preflight checked a
    // different target, or says it did not check ours, it is not our check.
    else if (Array.isArray(s.not_checked) && s.not_checked.length) reason = `did not check: ${s.not_checked.join(", ")}`;
    else if (expectKind && s.target?.kind !== expectKind) reason = s.target?.kind ? `checked a ${s.target.kind}, not the ${expectKind}` : "the answer names no target";
    if (reason) return { unavailable: true, verdict: null, text: r.text || "Sato Hub returned no verdict", reason };
    return { unavailable: false, verdict, rule: s.rule ?? null, kind: s.target?.kind ?? null, text: r.text, checked_at: s.checked_at ?? null };
  } catch (err) {
    return { unavailable: true, verdict: null, text: `Sato Hub check unavailable (${err.message})`, reason: err.message };
  }
}

/** The refusals a check result causes under the owner's policy (empty = proceed). */
export function gateRefusals(policy, check, { skipped = false } = {}) {
  const gate = policy?.check_gate ?? "off";
  if (gate === "off") return [];
  if (skipped) {
    return [{ rule: "check_required", limit: gate, observed: "skipped", message: "the owner set Sato Hub checks to gate spends, so --skip-check is not allowed" }];
  }
  if (check.unavailable) {
    // With the gate on, the owner chose what happens here (policy set requires it).
    // A v0.1.1 policy written before that rule is treated as "refuse": fail closed.
    return policy.on_check_unavailable === "allow"
      ? []
      : [{ rule: "check_unavailable", limit: policy.on_check_unavailable ?? "refuse", observed: check.reason ?? "unavailable", message: "the Sato Hub check could not run (or did not check this target), and the owner chose to refuse in that case" }];
  }
  const stop = gate === "caution" ? ["no", "caution"] : ["no"];
  if (stop.includes(check.verdict)) {
    return [{ rule: `check_${check.verdict}`, limit: gate, observed: `${check.verdict}${check.rule ? ` (${check.rule})` : ""}`, message: `Sato Hub's check came back "${check.verdict}"${check.rule ? ` under rule ${check.rule}` : ""}, and the owner set checks to stop on that. The evidence lines say why; this is not a judgement of the recipient.` }];
  }
  return [];
}

// ---------------------------------------------------------------- token resolver

/** True for something that is a link (the kit never parses one itself: only Sato Hub's resolver turns a link into a token). */
export const looksLikeLink = (input) => /^\s*(https?:\/\/|[a-z0-9-]+(\.[a-z0-9-]+)+\/)/i.test(String(input ?? ""));

/**
 * Ask Sato Hub what is at an address, a mint or a link (`onchain_agent_resolve_token`). Never throws.
 * Returns { ok: true, token, signature: { ok } | { ok: false, error } } or { ok: false, reason, error? }:
 *   reason "unavailable"   the tool is missing (an older Sato Hub), errored, timed out or sent something unusable
 *   reason "not_resolved"  Sato Hub answered, but could not say what the input is (`error` is its own sentence, `code` its code)
 *
 * The answer is a HINT, not the truth: the caller re-reads decimals and the token program from the chain, and the chain wins.
 * Its price and liquidity are one pool's listing, dated by `sources`; they are shown as such and never used to size a trade.
 */
export async function resolveTokenViaHub(input, { chain, call = callTool, verifySignature } = {}) {
  const args = { input: String(input), ...(chain ? { chain } : {}), response_format: "json" };
  let r;
  try {
    r = await call("onchain_agent_resolve_token", args);
  } catch (err) {
    return { ok: false, reason: "unavailable", error: err.message };
  }
  const s = r?.structured;
  if (r?.isError || !s || typeof s !== "object") return { ok: false, reason: "unavailable", error: String(r?.text ?? "no answer").slice(0, 300) };
  if (s.resolved === false) return { ok: false, reason: "not_resolved", code: s.code ?? null, error: String(s.error ?? "Sato Hub could not resolve this").slice(0, 300) };
  const chainName = String(s.chain ?? "").toLowerCase();
  if (typeof s.address !== "string" || !s.address || !["base", "solana"].includes(chainName)) return { ok: false, reason: "unavailable", error: "the answer names no token" };
  let signature = { ok: false, error: "not checked" };
  try {
    const v = verifySignature ?? (await import("./hub-signature.js")).verifyHubSignature;
    await v(s, { maxAgeMs: 10 * 60 * 1000 });
    signature = { ok: true };
  } catch (err) {
    signature = { ok: false, error: err.message };
  }
  return { ok: true, token: { ...s, chain: chainName }, signature };
}
