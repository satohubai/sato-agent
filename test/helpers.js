import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// None of these read the environment when they load, so importing them here (before freshHome) is fine.
import { RAISE_DELAY_MS, fold } from "../src/policy.js";
import { commitPolicy, policyFileText } from "../src/integrity.js";
import { paths, readJson } from "../src/store.js";

/**
 * A day passes for the raises queued in this home: policy.json is written with every pending raise in force, and sealed. For
 * tests that raise a limit (or add a chain, or turn something on) to set up the next case; the 24-hour wait itself is tested in
 * test/hardening.test.js. Works for a home a CLI test runs in too (it reads SATO_AGENT_HOME).
 */
export function raisesTakeEffect() {
  const stored = readJson(paths.policy());
  if (!stored?.pending) return stored;
  const p = fold(stored, Date.now() + RAISE_DELAY_MS + 1000);
  commitPolicy(policyFileText(p), { kind: "test", status: "raises_in_force" });
  return p;
}

/** setPolicy, then a day passes: any raise it queued is in force. */
export const raisesInForce = (setPolicy) => (opts, o) => {
  const r = setPolicy(opts, o);
  return { ...r, policy: raisesTakeEffect() ?? r.policy };
};

/**
 * Write policy.json as an older kit version left it (a hand-made legacy policy), moving the seal to match, as the upgrade
 * would have sealed it. The upgrade path itself is tested in test/hardening.test.js.
 */
export function writeOldPolicy(policy) {
  commitPolicy(typeof policy === "string" ? policy : JSON.stringify(policy), { kind: "test", status: "policy_written_by_hand" });
}

/** A fresh, empty agent home for one test file. Set before importing anything that reads it. */
export function freshHome() {
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-test-")), "agent");
  process.env.SATO_AGENT_HOME = dir;
  return dir;
}
