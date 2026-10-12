// The CLI with the new chains, offline: what each command accepts where the feature exists, and the plain refusal where it does not.
// Nothing here reaches a chain or Sato Hub (the MCP url points nowhere; every command stops before it matters).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const home = freshHome();
const env = { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
const ledger = () => readFileSync(join(home, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ADDR = "0x1111111111111111111111111111111111111111";
const policy = (chains) => run("policy", "set", "--chains", chains, "--per-tx", "5", "--per-day", "50");

test("init tells the owner the Base address is the address on every EVM chain, and what to fund it with", () => {
  const r = run("init");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /The Base address is the same address on BNB Chain \(USDT, a little BNB for gas\), Arbitrum \(USDC, a little ETH for gas\) or Polygon \(USDC, a little POL for gas\)\./);
  assert.match(r.stdout, /policy set --chains <base\|bnb\|arbitrum\|polygon\|solana\|base,bnb,arbitrum,polygon,solana>/);
});

test("policy: the new chains are accepted, an unknown one is not, and adding a chain is a logged raise", () => {
  assert.equal(policy("base").status, 0);
  const wider = policy("base,bnb,arbitrum,polygon");
  assert.equal(wider.status, 0);
  assert.match(wider.stdout, /RAISED \(chains widened\)/);
  assert.ok(ledger().some((e) => e.kind === "policy" && e.status === "raised" && e.raises.includes("chains widened")));
  const narrow = policy("bnb");
  assert.equal(narrow.status, 0);
  assert.doesNotMatch(narrow.stdout, /RAISED/, "narrowing is not a raise");
  const bad = policy("avalanche");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--chains must be one or more of: base, bnb, arbitrum, polygon, solana \(comma-separated\)/);
});

test("help names the chains where each command works", () => {
  const h = run("help").stdout;
  assert.match(h, /swap --chain base\|bnb\|arbitrum\|polygon\|solana --from/);
  assert.match(h, /send --chain base\|bnb\|arbitrum\|polygon\|solana --to/);
  assert.match(h, /pay <url> \[--chain base\|arbitrum\|polygon\|solana\]/);
  assert.match(h, /order <amazon\.com link\|ASIN> \[--chain base\|solana\]/);
  assert.match(h, /--chain base\|bnb\|arbitrum\|polygon\]\n\s+register in the ERC-8004 registry on this agent's EVM chain/);
  assert.match(h, /referral create --chain base\|bnb\|arbitrum\|polygon\|solana/);
  assert.match(h, /swap with a major on one side: USDC, ETH or WETH on Base; USDT, USDC, BNB or WBNB on BNB Chain; USDC, USDT, ETH or WETH on Arbitrum; USDC, USDT, POL or WPOL on Polygon; USDC or SOL on Solana\./);
  assert.match(h, /paid in USDC on Base, Arbitrum and Polygon \(x402; --chain/);
  assert.match(h, /send USDC \(USDT on BNB Chain\) \(Sato Hub checks the recipient first\)/);
  assert.match(h, /x402 runs on Base, Arbitrum, Polygon and Solana/);
});

test("a BNB Chain bot: its address line, no x402, no gift cards (pointed at the Base bot), no Amazon", () => {
  assert.equal(policy("bnb").status, 0);
  const a = run("address");
  assert.match(a.stdout, /^BNB Chain: 0x[0-9a-fA-F]{40}$/m);
  const wallet = JSON.parse(readFileSync(join(home, "wallet.json"), "utf8")).evm.address;
  assert.ok(a.stdout.includes(wallet));
  assert.deepEqual(Object.keys(JSON.parse(run("address", "--json").stdout)), ["bnb"]);

  const pay = run("pay", "https://example.invalid/x", "--skip-check");
  assert.equal(pay.status, 3);
  assert.match(pay.stderr, /REFUSED x402_not_on_chain: x402 payments are not available on BNB Chain; they work on Base, Arbitrum, Polygon and Solana/);
  assert.equal(run("pay", "https://example.invalid/x", "--chain", "bnb", "--skip-check").status, 3);

  const gift = run("giftcard", "search", "amazon");
  assert.equal(gift.status, 3);
  assert.match(gift.stderr, /REFUSED giftcards_base_only: .*paid in USDC on Base, Arbitrum and Polygon, and this agent works on BNB Chain only\. Nothing was bought\. Gift cards are available through the Sato Base Bot\./);
  const giftBuy = run("giftcard", "buy", "amazon-us", "--value", "25");
  assert.equal(giftBuy.status, 3);
  assert.equal(run("giftcard", "search", "amazon", "--chain", "bnb").status, 3);
  assert.match(run("giftcard", "search", "amazon", "--chain", "bnb").stderr, /Bitrefill takes Base, Arbitrum and Polygon, not BNB Chain/);

  const order = run("order", "B08N5WRWNW");
  assert.equal(order.status, 3);
  assert.match(order.stderr, /REFUSED chain_not_supported: this purchase is not available on BNB Chain; it works on Base and Solana/);
  assert.equal(run("order", "B08N5WRWNW", "--chain", "polygon").status, 3, "not on a chain the owner did not choose either");
});

test("send on a chain the owner did not choose is refused before any check; on one they did, the amount is read in that chain's stablecoin", () => {
  assert.equal(policy("base,solana").status, 0);
  const r = run("send", "--chain", "bnb", "--to", ADDR, "--amount", "1", "--skip-check");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /chain_not_allowed/);
  assert.equal(policy("bnb,arbitrum").status, 0);
  // BNB Chain's USDT has 18 decimals, USDC on Arbitrum 6: the message names the token and its decimals
  const bnb = run("send", "--chain", "bnb", "--to", ADDR, "--amount", "1.0000000000000000001", "--skip-check");
  assert.equal(bnb.status, 1);
  assert.match(bnb.stderr, /not a USDT amount: .* at most 18 decimals/);
  const arb = run("send", "--chain", "arbitrum", "--to", ADDR, "--amount", "1.0000001", "--skip-check");
  assert.match(arb.stderr, /not a USDC amount: .* at most 6 decimals/);
  const unknown = run("send", "--chain", "avalanche", "--to", ADDR, "--amount", "1", "--skip-check");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /send --chain base\|bnb\|arbitrum\|polygon\|solana --to/);
});

test("register and token: a bot on one EVM chain uses it; a bot on two must say which (usage error, exit 2)", () => {
  assert.equal(policy("bnb,solana").status, 0);
  // one EVM chain: not asked (the command then needs a name and a description, so it stops there with exit 1, not with a chain question)
  const one = run("register");
  assert.equal(one.status, 1);
  assert.match(one.stderr, /--name and --description are required/);
  assert.equal(policy("arbitrum,polygon,solana").status, 0);
  const two = run("register", "--name", "n", "--description", "d");
  assert.equal(two.status, 2);
  assert.match(two.stderr, /this agent works on Arbitrum and Polygon: say which with --chain arbitrum\|polygon/);
  const refusedChain = run("register", "--name", "n", "--description", "d", "--chain", "bnb");
  assert.equal(refusedChain.status, 3, "a chain the owner did not choose");
  const sol = run("register", "--name", "n", "--description", "d", "--chain", "solana");
  assert.equal(sol.status, 2, "Solana has no ERC-8004 registry in this kit");
  assert.match(sol.stderr, /--chain must be base, bnb, arbitrum or polygon here/);
  // a bare 0x address
  const tok = run("token", ADDR);
  assert.equal(tok.status, 2);
  assert.match(tok.stderr, /this agent works on Arbitrum and Polygon: say which with --chain arbitrum\|polygon \(a 0x address is on one of them\)/);
  assert.equal(run("token", ADDR, "--chain", "avalanche").status, 2);
  assert.match(run("token", ADDR, "--chain", "avalanche").stderr, /--chain must be base, bnb, arbitrum, polygon or solana/);
});

test("checkout: a payment link on a chain the owner did not choose is refused; the deposit form takes the new chains", () => {
  assert.equal(policy("arbitrum").status, 0);
  const usdtBnb = `ethereum:0x55d398326f99059fF775485246999027B3197955@56/transfer?address=${ADDR}&uint256=1000000000000000000`;
  const r = run("checkout", usdtBnb, "--skip-check");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /chain_not_allowed/);
  const dep = run("checkout", "--to", ADDR, "--amount", "1", "--chain", "bnb", "--skip-check");
  assert.equal(dep.status, 3);
  assert.match(dep.stderr, /chain_not_allowed/);
  assert.match(run("checkout", "--to", ADDR, "--amount", "1").stderr, /checkout --to <address> --amount <usdc> --chain base\|bnb\|arbitrum\|polygon\|solana/);
});

test("swap: the chain is validated against the chains that swap; a bot that did not choose it is refused before anything is read", () => {
  assert.equal(policy("arbitrum,solana").status, 0);
  const r = run("swap", "--chain", "bnb", "--from", "USDT", "--to", "BNB", "--amount", "1", "--skip-check");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /chain_not_allowed/);
  const u = run("swap", "--chain", "avalanche", "--from", "USDC", "--to", "ETH", "--amount", "1");
  assert.equal(u.status, 2);
});

test("referral create --chain bnb is accepted (the same EVM key, the class base); an unknown chain is a usage error", () => {
  const bad = run("referral", "create", "--chain", "avalanche");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /referral create --chain base\|bnb\|arbitrum\|polygon\|solana/);
  // a valid chain gets as far as asking Sato Hub (unreachable here): "Couldn't reach Sato Hub", not a usage error
  const ok = run("referral", "create", "--chain", "bnb");
  assert.equal(ok.status, 1);
  assert.match(ok.stderr, /Couldn't reach Sato Hub; nothing was saved/);
});
