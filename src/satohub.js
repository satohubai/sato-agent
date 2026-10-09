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

export const MCP_URL = process.env.SATO_AGENT_MCP_URL || "https://satohub.ai/api/mcp";

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
export async function runCheck(args) {
  try {
    const r = await preflight(args);
    const verdict = r.structured?.verdict;
    if (r.isError || !VERDICTS.includes(verdict)) {
      return { unavailable: true, verdict: null, text: r.text || "Sato Hub returned no verdict", reason: r.isError ? "tool error" : "no verdict" };
    }
    return { unavailable: false, verdict, rule: r.structured?.rule ?? null, text: r.text, checked_at: r.structured?.checked_at ?? null };
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
    return policy.on_check_unavailable === "refuse"
      ? [{ rule: "check_unavailable", limit: "refuse", observed: check.reason ?? "unavailable", message: "the Sato Hub check could not run, and the owner chose to refuse in that case" }]
      : [];
  }
  const stop = gate === "caution" ? ["no", "caution"] : ["no"];
  if (stop.includes(check.verdict)) {
    return [{ rule: `check_${check.verdict}`, limit: gate, observed: `${check.verdict}${check.rule ? ` (${check.rule})` : ""}`, message: `Sato Hub's check came back "${check.verdict}"${check.rule ? ` under rule ${check.rule}` : ""}, and the owner set checks to stop on that. The evidence lines say why; this is not a judgement of the recipient.` }];
  }
  return [];
}
