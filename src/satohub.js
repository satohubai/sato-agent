// Sato Hub's MCP server (https://satohub.ai/api/mcp): no key, no account.
// Used for the checks the agent runs BEFORE it spends or installs:
//   preflight   dated evidence on an x402 URL, a recipient address, a repo, a package
//   check       what an install command does with keys and money
//   recommend   a stack for a build goal
// These answers describe; they never say "safe". `unknown` means no record.

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

/** Run a check, but never let Sato Hub being slow or down block the owner's action. */
export async function advisory(fn) {
  try {
    return (await fn()).text;
  } catch (err) {
    return `Sato Hub check unavailable (${err.message}); continuing without it.`;
  }
}
