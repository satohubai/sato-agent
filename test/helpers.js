import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh, empty agent home for one test file. Set before importing anything that reads it. */
export function freshHome() {
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-test-")), "agent");
  process.env.SATO_AGENT_HOME = dir;
  return dir;
}
