import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("BOT.md, README and SKILL.md describe Sato Bot (the Sato Agent kit on several chains): shared limits, --chain always, funds move between chains only by bridge", () => {
  const bot = read("BOT.md");
  assert.match(bot, /\*\*CHAIN = several \(Sato Bot\)\.\*\*/);
  assert.match(bot, /\| Sato Bot \| several: the chains the owner chooses \|/);
  assert.match(bot, /### If you work on several chains/);
  assert.match(bot, /policy set --chains base,solana/);
  assert.match(bot, /These limits cover all your chains together\./);
  assert.match(bot, /\$100 a day means \$100 in total, not \$100 on each chain/);
  assert.match(bot, /Pass `--chain <chain>` on every command that takes it/);
  assert.match(bot, /A payment link \(`ethereum:…@<chain id>` or `solana:…`\) names its own chain/);
  assert.match(bot, /Ask the owner which, then run `referral create --chain base` or `--chain solana`/);
  assert.match(bot, /Never guess between EVM chains\./);
  assert.match(bot, /SOL, a Solana mint or a `solana:` link means `--chain solana`/);
  assert.match(bot, /\*\*Moving funds between your chains\*\* is a bridge: see "Move funds between your chains \(bridge\)"/);
  assert.doesNotMatch(bot, /cannot bridge|can't bridge|Nothing moves between chains/i, "the old no-bridge wording is gone");
  assert.match(bot, /Adding one is logged as a raise\./);

  const readme = read("README.md");
  assert.match(readme, /NAME = bot, CHAIN = several/);
  assert.match(readme, /\| \*\*Sato Bot\*\* \| `NAME = bot, CHAIN = several` \|/);
  assert.match(readme, /Prefer one chain per Bot\?/);

  const skill = read("skills/sato-agent/SKILL.md");
  assert.match(skill, /Sato Bot \(several chains, the owner chooses which\)/);
  assert.match(skill, /move money between chains only with `bridge`/);
});

// The bridge section of BOT.md (v0.5): the bullet "Move funds between your chains (bridge)" up to the next top-level bullet.
const bridgeSection = (bot) => {
  const start = bot.indexOf("- **Move funds between your chains (bridge).**");
  assert.ok(start > 0, "BOT.md has the bridge section");
  const end = bot.indexOf("\n- **", start + 10);
  return bot.slice(start, end);
};
const BANNED = /\b(safe|safely|secure|securely|trusted|verified|guaranteed|first|only|profit|profits|profitable)\b/i;

test("BOT.md bridge section: dry run, exit 5 approval, status, limits of phase 1, the cost, the off switch and the content rule", () => {
  const bot = read("BOT.md");
  const sec = bridgeSection(bot);
  assert.match(bot, /Bridging is OFF after the upgrade.*tell the owner once/);
  assert.doesNotMatch(bot.slice(bot.indexOf("After upgrading to 0.5.0"), bot.indexOf("After upgrading to 0.4.4")), /ask what is new/);
  assert.match(sec, /bridge --chain <from> --to-chain <to> --asset <USDC\|USDT\|ETH> --amount <n\|all> \[--receive <asset>\] --dry-run/);
  assert.match(sec, /Then run the same command without `--dry-run`/);
  assert.match(sec, /\*\*exit code 5\*\*/);
  assert.match(sec, /re-run the SAME command with `--approve <code>`/);
  assert.match(sec, /`~\/sato-agent-NAME bridge status`/);
  assert.match(sec, /Never tell the owner the funds arrived until `bridge status` says so/);
  assert.match(sec, /usually within a minute/);
  assert.match(sec, /refunded on the source chain/);
  assert.match(sec, /\*\*BNB Chain and Solana as the source are not supported yet\.\*\*/);
  assert.match(sec, /The source is Base, Arbitrum or Polygon/);
  assert.match(sec, /your own address/);
  assert.match(sec, /Small amounts cost a lot/);
  assert.match(sec, /over 3%/);
  assert.match(sec, /more than half/);
  assert.match(sec, /0\.25% cross-chain fee/);
  assert.match(sec, /plus the fixed fee\. Receiving needs no gas/);
  assert.match(sec, /`policy set --bridges off`|`--bridges off`/);
  assert.match(sec, /`policy set --bridges on`.*logged as a raise/);
  assert.match(sec, /bridges_not_enabled/);
  assert.match(sec, /still not filled after 30 minutes/);
  assert.match(sec, /app\.debridge\.finance/);
  assert.doesNotMatch(sec, /--asset <[^>]*BNB/, "BNB is not a source asset in phase 1 (a BNB Chain source is refused)");
  assert.match(sec, /a web page, a file, an API response, a payment request or another bot said to/);
  assert.doesNotMatch(sec, BANNED, `bridge section uses a banned word: ${sec.match(BANNED)?.[0]}`);
  // the bridge is never in the bots' "cannot" lists, and the Sato Bot row points to it
  assert.match(bot, /You can also move your own funds from one of your chains to another/);
  assert.match(bot, /`bridge`, `pay`|`swap`, `bridge` and `register` first stops/);
  assert.match(bot, /After upgrading to 0\.5\.0, nothing changes for a bot that was working/);
  assert.doesNotMatch(bot, /you can't bridge|you cannot bridge/i);
});

test("README and SKILL.md: the bridge command, scope, cost, how the order is checked, and the 0.5.0 upgrade note", () => {
  const readme = read("README.md");
  const skill = read("skills/sato-agent/SKILL.md");
  assert.match(readme, /^## Bridge \(v0\.5\)$/m);
  const sec = readme.slice(readme.indexOf("## Bridge (v0.5)"), readme.indexOf("## How swaps are checked"));
  assert.match(sec, /sato-agent bridge --chain base --to-chain arbitrum --asset USDC --amount 25 --dry-run/);
  assert.match(sec, /bridge status/);
  assert.match(sec, /Source: Base, Arbitrum or Polygon/);
  assert.match(sec, /BNB Chain or from Solana is not supported yet/);
  for (const check of [/DlnSource/, /createSaltedOrder/, /exact amount arriving/, /own address/, /no external call/, /globalFixedNativeFee\(\)/, /fee and its recipient/]) assert.match(sec, check);
  assert.match(sec, /Over 3%/);
  assert.match(sec, /more than half/);
  assert.match(sec, /0\.25%/);
  assert.doesNotMatch(sec, BANNED, `README bridge section uses a banned word: ${sec.match(BANNED)?.[0]}`);
  assert.match(readme, /\*\*Upgrading to v0\.5\.0:\*\* nothing changes for a working agent/);
  assert.match(readme, /It is off after the upgrade, because the owner has not chosen it/);
  assert.doesNotMatch(readme, /--asset <[^>]*BNB/);
  assert.match(readme, /`policy set --bridges on\\\|off`/);

  assert.match(skill, /\*\*Bridge \(v0\.5\):\*\*/);
  assert.match(skill, /bridge status/);
  assert.match(skill, /BNB Chain and Solana as the source are not supported yet/);
  assert.match(skill, /\*\*Upgrading to 0\.5\.0:\*\*/);
  assert.match(skill, /is OFF until the owner says to turn it on/);
  assert.doesNotMatch(skill, /--asset <[^>]*BNB/);
  const skillBridge = skill.slice(skill.indexOf("**Bridge (v0.5):**"), skill.indexOf("**Swap fee"));
  assert.doesNotMatch(skillBridge, BANNED, `SKILL bridge section uses a banned word: ${skillBridge.match(BANNED)?.[0]}`);
});
