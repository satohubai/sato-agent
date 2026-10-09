// "Ask me before every payment", enforced by the kit (policy `approval: "ask"`).
//
// A spend command run without --approve does NOT spend: it records the exact
// intent under a short random code and exits 5. For `send` that is the chain,
// recipient and amount. For `pay` it is the URL, method, body and header names
// (values hashed) and the price and payee the server quoted before approval
// (a higher price or another payee at pay time is refused); when the server
// would not quote, the per-transaction limit caps the price. The agent
// shows the owner the intent; when the owner says yes, the agent re-runs the
// SAME command with `--approve <code>`. The code is single-use, expires after
// APPROVAL_TTL_MS, and only matches the identical intent.
//
// Honest scope, as with the limits: the agent can type the code itself. This
// stops mistakes and an agent that follows its rules (it cannot spend without
// first surfacing the exact intent), not a compromised agent. Every approval
// request and use is in the ledger.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { home, readJson, withLock, writePrivate } from "./store.js";
import { record } from "./ledger.js";

export const APPROVAL_TTL_MS = 15 * 60 * 1000;
const file = () => join(home(), "approvals.json");

/** Stable JSON: the same intent always serializes the same way. */
export function canonical(intent) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(intent));
}

function prune(all, now = Date.now()) {
  for (const [id, a] of Object.entries(all)) if (a.used || now > a.expires_at) delete all[id];
  return all;
}

export async function requestApproval(intent) {
  return withLock(
    async () => {
      const all = prune(readJson(file()) ?? {});
      const code = randomBytes(4).toString("hex");
      all[code] = { intent: canonical(intent), created_at: Date.now(), expires_at: Date.now() + APPROVAL_TTL_MS, used: false };
      writePrivate(file(), JSON.stringify(all, null, 2) + "\n", { atomic: true });
      record({ kind: "approval", status: "requested", code, intent });
      return { code, expires_at: new Date(all[code].expires_at).toISOString() };
    },
    { name: "approvals" },
  );
}

/** Consume an approval for exactly this intent, or throw with the reason. */
export async function consumeApproval(code, intent) {
  return withLock(
    async () => {
      const all = readJson(file()) ?? {};
      const a = all[code];
      if (!a) throw new Error(`approval ${code} not found (it may have been used already or expired)`);
      if (a.used) throw new Error(`approval ${code} was already used`);
      if (Date.now() > a.expires_at) throw new Error(`approval ${code} expired; ask the owner again`);
      if (a.intent !== canonical(intent)) throw new Error(`approval ${code} was given for a different intent; ask the owner again for this one`);
      a.used = true;
      writePrivate(file(), JSON.stringify(prune(all), null, 2) + "\n", { atomic: true });
      record({ kind: "approval", status: "used", code });
    },
    { name: "approvals" },
  );
}
