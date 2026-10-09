// Where the agent keeps its state: one private folder on the machine it runs on.
//
//   wallet.json   the agent's own keys (0600). Never printed, never sent anywhere.
//   policy.json   the limits the OWNER chose. There are no defaults: until the
//                 owner sets them, every command that spends refuses.
//   ledger.jsonl  one line per spend, append-only. "Spent today" is read from it,
//                 so a restart does not reset the daily limit.
//
// SATO_AGENT_HOME moves the folder (tests use a temp dir).

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function home() {
  return process.env.SATO_AGENT_HOME || join(homedir(), ".sato-agent");
}

export const paths = {
  wallet: () => join(home(), "wallet.json"),
  policy: () => join(home(), "policy.json"),
  ledger: () => join(home(), "ledger.jsonl"),
};

export function ensureHome() {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.chmodSync(home(), 0o700);
}

/** Write a file only its owner can read. `exclusive` refuses to replace an existing file. */
export function writePrivate(path, text, { exclusive = false } = {}) {
  ensureHome();
  fs.writeFileSync(path, text, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  fs.chmodSync(path, 0o600);
}

export function readJson(path) {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
}

export function appendLine(path, obj) {
  ensureHome();
  fs.appendFileSync(path, JSON.stringify(obj) + "\n", { mode: 0o600 });
}

export function readLines(path) {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
