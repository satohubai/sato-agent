// Where the agent keeps its state: one private folder on the machine it runs on.
//
//   wallet.json   the agent's own keys (0600). Never printed, never sent anywhere.
//   policy.json   the spending limits. There are no defaults: until they are set,
//                 every command that spends refuses.
//   ledger.jsonl  one line per spend and per limit change. Spend over the last
//                 24 hours is read from it, so a restart does not reset the limit.
//   spend.lock    held while a spend is checked and reserved, so two commands
//                 running at once cannot both fit under the same limit.
//
// SATO_AGENT_HOME moves the folder (tests use a temp dir; two bots on one
// computer each use their own).

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
  lock: () => join(home(), "spend.lock"),
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
  fs.appendFileSync(path, JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n", { mode: 0o600 });
}

/** Parsed lines, plus the 1-based numbers of any line that would not parse. */
export function readLines(path) {
  if (!fs.existsSync(path)) return { rows: [], bad: [] };
  const rows = [];
  const bad = [];
  fs.readFileSync(path, "utf8")
    .split("\n")
    .forEach((l, i) => {
      if (!l.trim()) return;
      try {
        rows.push(JSON.parse(l));
      } catch {
        bad.push(i + 1);
      }
    });
  return { rows, bad };
}

const STALE_LOCK_MS = 120_000;

/** Run `fn` holding the spend lock (a file created exclusively). Waits up to 30 s. */
export async function withLock(fn, { waitMs = 30_000 } = {}) {
  ensureHome();
  const lock = paths.lock();
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lock);
      } catch {
        /* someone else removed it */
      }
      if (Date.now() - start > waitMs) throw new Error(`another spend is in progress (lock ${lock}); try again`);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}
