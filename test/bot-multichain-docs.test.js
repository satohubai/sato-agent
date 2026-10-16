import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("BOT.md, README and SKILL.md describe Sato Agent on several chains: shared limits, --chain always, nothing moves between chains", () => {
  const bot = read("BOT.md");
  assert.match(bot, /\*\*CHAIN = several \(Sato Agent\)\.\*\*/);
  assert.match(bot, /\| Sato Agent \| several: the chains the owner chooses \|/);
  assert.match(bot, /### If you work on several chains/);
  assert.match(bot, /policy set --chains base,solana/);
  assert.match(bot, /These limits cover all your chains together\./);
  assert.match(bot, /\$100 a day means \$100 in total, not \$100 on each chain/);
  assert.match(bot, /Pass `--chain <chain>` on every command that takes it/);
  assert.match(bot, /A payment link \(`ethereum:…@<chain id>` or `solana:…`\) names its own chain/);
  assert.match(bot, /Ask the owner which, then run `referral create --chain base` or `--chain solana`/);
  assert.match(bot, /Never guess between EVM chains\./);
  assert.match(bot, /SOL, a Solana mint or a `solana:` link means `--chain solana`/);
  assert.match(bot, /You cannot bridge or move money from one chain to another\./);
  assert.match(bot, /Adding one is logged as a raise\./);

  const readme = read("README.md");
  assert.match(readme, /NAME = agent, CHAIN = several/);
  assert.match(readme, /\| \*\*Sato Agent\*\* \| `NAME = agent, CHAIN = several` \|/);
  assert.match(readme, /Prefer one chain per Bot\?/);

  const skill = read("skills/sato-agent/SKILL.md");
  assert.match(skill, /Sato Agent \(several chains, the owner chooses which\)/);
  assert.match(skill, /never move money between chains/);
});
