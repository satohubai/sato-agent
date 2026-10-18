import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Every request this package makes names itself. It runs on other people's
// machines, so by default it never claims to be Sato Hub's own tooling.
export const USER_AGENT = `sato-agent/${VERSION}`;

// SATO_AGENT_UA: an operator running their own fleet can name their agents
// instead (for example acme-fleet/1.0), so their calls are counted as theirs.
// The `SatoHub-` prefix is reserved for Sato Hub's own bots (Sato Hub counts it
// as its own traffic), so the public example never uses it. Used for every request the kit makes. Anything that is not a plain
// header value (empty, over 200 characters, control or non-ASCII characters,
// CR/LF) is ignored and the default above is used.
export const MAX_USER_AGENT_LENGTH = 200;

/** The override from `env`, trimmed, or null when it is unset or not a safe header value. */
export function userAgentOverride(env = process.env) {
  const raw = env.SATO_AGENT_UA;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_USER_AGENT_LENGTH) return null;
  if (!/^[\x20-\x7e]+$/.test(v)) return null;
  return v;
}

/** The User-Agent to send: SATO_AGENT_UA when valid, else `sato-agent/<version>`. Read per call. */
export function userAgent(env = process.env) {
  return userAgentOverride(env) ?? USER_AGENT;
}
