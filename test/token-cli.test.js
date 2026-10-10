// `sato-agent token <address|mint|link>` and the token side of `swap`, offline.
//
// A local mock stands in for Sato Hub (the resolver tool, Preflight's token check) and one
// for the chains' JSON-RPC (a Base ERC-20, Solana mints). The real CLI is spawned against
// them, so exit codes, flags and output are the real thing. describeToken is also driven
// directly with injected fakes for the cases that need no process.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters } from "viem";
import { getAddressDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { describeToken, renderTokenCard } = await import("../src/swap/run.js");
const { TOKEN_2022_PROGRAM } = await import("../src/solana.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const PYUSDISH = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const FROZEN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const AUTH_BYTES = Buffer.alloc(32, 9);
const AUTH = getAddressDecoder().decode(AUTH_BYTES); // the freeze authority the mock chain gives BONK
const DATE = "2026-10-09T10:00:00Z";

function mintEntry({ program = TOKEN_PROGRAM_ADDRESS, decimals = 5, freeze = null, mintAuth = null, extensions = [] } = {}) {
  const head = Buffer.alloc(82);
  if (mintAuth) { head.writeUInt32LE(1, 0); mintAuth.copy(head, 4); }
  if (freeze) { head.writeUInt32LE(1, 46); freeze.copy(head, 50); }
  head[44] = decimals;
  head[45] = 1;
  let raw = head;
  if (program === TOKEN_2022_PROGRAM && extensions.length) {
    const tlv = extensions.map(([type, data]) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); });
    raw = Buffer.concat([head, Buffer.alloc(83), Buffer.from([1]), ...tlv]);
  }
  return { owner: program, data: [raw.toString("base64"), "base64"], lamports: 1, executable: false, rentEpoch: 0, space: raw.length };
}

// ---- the mock chains (Base ERC-20 reads; Solana getAccountInfo)
const solMints = {
  [BONK]: mintEntry({ decimals: 5, freeze: AUTH_BYTES }),
  [WIF]: mintEntry({ decimals: 6 }),
  [PYUSDISH]: mintEntry({ program: TOKEN_2022_PROGRAM, decimals: 6, extensions: [[12, Buffer.alloc(32, 7)], [14, Buffer.alloc(64, 7)]] }),
  [FROZEN]: mintEntry({ program: TOKEN_2022_PROGRAM, decimals: 6, extensions: [[9, Buffer.alloc(0)]] }),
};
let chainDecimals = 18;
const rpcAnswer = ({ method, params, id }) => {
  let result;
  if (method === "eth_chainId") result = "0x2105";
  else if (method === "eth_getCode") result = params[0].toLowerCase() === DEGEN.toLowerCase() ? "0x6080604052" : "0x";
  else if (method === "eth_call") {
    const sel = String(params[0].data).slice(0, 10);
    result = sel === "0x313ce567" ? encodeAbiParameters([{ type: "uint8" }], [chainDecimals]) : sel === "0x95d89b41" ? encodeAbiParameters([{ type: "string" }], ["DEGEN"]) : sel === "0x06fdde03" ? encodeAbiParameters([{ type: "string" }], ["Degen"]) : "0x";
  } else if (method === "getAccountInfo") result = { context: { slot: 1 }, value: solMints[params[0]] ?? null };
  else return { jsonrpc: "2.0", id, error: { code: -32601, message: `method ${method} not mocked` } };
  return { jsonrpc: "2.0", id, result };
};

// ---- the mock Sato Hub
let mode = {};
let asked = [];
const resolveBase = () => ({
  chain: "base", address: DEGEN, name: "Degen", symbol: "DEGEN", decimals: chainDecimals, program: "erc20", price_usd: 0.0034, liquidity_usd: 1_200_000,
  main_pool: { venue: "uniswap-v3", labels: ["v3"], address: "0xPool", quote_token: { address: "0xWeth", symbol: "WETH" } },
  sources: [{ field: "price_usd", source: "DexScreener", as_of: DATE }, { field: "liquidity_usd", source: "DexScreener", as_of: DATE }],
  gaps: [], resolved_from: { via: "address" }, checked_at: DATE, caveat: "A listing, not a quote.", meta: { signature: null },
});
const resolveSol = (mint, extra = {}) => ({
  chain: "solana", address: mint, name: "Bonk", symbol: "BONK", decimals: 5, program: "spl", price_usd: 0.00002, liquidity_usd: 4_000_000, main_pool: null,
  mint_authority: { set: false }, freeze_authority: { set: true, address: AUTH }, token2022_extensions: [],
  sources: [{ field: "price_usd", source: "DexScreener", as_of: DATE }], gaps: [{ field: "main_pool", reason: "no pool listed" }], resolved_from: { via: "address" }, checked_at: DATE, caveat: "A listing, not a quote.", meta: { signature: null }, ...extra,
});
const PREFLIGHT_TEXT = "Evidence (dated 2026-10-09):\n- liquidity: $1.2M in the main pool\n- holders: top 10 hold 31%\nNot a verdict on anyone.";
let mcp;
let rpc;
let mcpUrl;
let rpcUrl;

before(async () => {
  mcp = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { params } = JSON.parse(body);
      asked.push({ name: params.name, args: params.arguments });
      const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result })); };
      if (params.name === "onchain_agent_resolve_token") {
        if (mode.noResolver) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: onchain_agent_resolve_token" } })); }
        const out = mode.resolve ? mode.resolve(params.arguments) : resolveBase();
        return reply({ content: [{ type: "text", text: "resolved" }], structuredContent: out });
      }
      if (params.name === "onchain_agent_preflight") {
        if (mode.noPreflight) return reply({ isError: true, content: [{ type: "text", text: "preflight is down" }] });
        return reply({ content: [{ type: "text", text: PREFLIGHT_TEXT }], structuredContent: { verdict: mode.verdict ?? "go", rule: "token.basic", target: { kind: "token" }, checked_at: DATE, not_checked: [] } });
      }
      res.writeHead(404);
      res.end();
    });
  });
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(rpcAnswer) : rpcAnswer(msg)));
    });
  });
  await Promise.all([new Promise((r) => mcp.listen(0, "127.0.0.1", r)), new Promise((r) => rpc.listen(0, "127.0.0.1", r))]);
  mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  const init = await run(["init"]);
  assert.equal(init.code, 0);
  const pol = await run(["policy", "set", "--chains", "base,solana", "--per-tx", "100", "--per-day", "300"]);
  assert.equal(pol.code, 0, pol.stderr);
});
after(() => { mcp.close(); rpc.close(); });

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: home, SATO_AGENT_MCP_URL: mcpUrl, SATO_AGENT_BASE_RPC: rpcUrl, SATO_AGENT_SOLANA_RPC: rpcUrl, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const reset = (m = {}) => { mode = m; asked = []; chainDecimals = 18; };

test("token <address>: the card has the chain's facts, Sato Hub's dated price and liquidity, and Sato Hub's evidence labelled as evidence", async () => {
  reset();
  const r = await run(["token", DEGEN]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Degen \(DEGEN 0x4ed4…efed\) on Base/, "a token is always shown with its short address");
  assert.match(r.stdout, new RegExp(`Address:  ${DEGEN}`));
  assert.match(r.stdout, /Decimals: 18 \(read from the chain\)/);
  assert.match(r.stdout, /Program:  ERC-20/);
  assert.match(r.stdout, /Price:    \$0\.0034 \(DexScreener, 2026-10-09T10:00:00Z; one pool's listing, not a quote\)/);
  assert.match(r.stdout, /Liquidity: \$1200000 listed in the main pool \(uniswap-v3 0xPool, against WETH\) \(DexScreener, 2026-10-09T10:00:00Z; that pool only\)/);
  assert.match(r.stdout, /Sato Hub's token check \(dated evidence, 2026-10-09T10:00:00Z; not a verdict on anyone\):\nEvidence \(dated 2026-10-09\):\n- liquidity: \$1\.2M in the main pool/);
  // Sato Hub was asked the resolver, then the token check for the address the chain gave back
  assert.deepEqual(asked.map((a) => a.name), ["onchain_agent_resolve_token", "onchain_agent_preflight"]);
  assert.deepEqual(asked[0].args, { input: DEGEN, response_format: "json" });
  assert.deepEqual(asked[1].args, { token: DEGEN, chain: "Base" });
  assert.doesNotMatch(r.stdout, /\b(safe|secure|trusted|guaranteed|verified|audited)\b/i);
});

test("token --json gives the structured card", async () => {
  reset();
  const r = await run(["token", DEGEN, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const card = JSON.parse(r.stdout);
  assert.deepEqual([card.chain, card.address, card.name, card.symbol, card.decimals, card.program], ["base", DEGEN, "Degen", "DEGEN", 18, "ERC-20"]);
  assert.deepEqual(card.price, { usd: 0.0034, source: "DexScreener", as_of: DATE });
  assert.equal(card.liquidity.usd, 1_200_000);
  assert.equal(card.liquidity.main_pool.venue, "uniswap-v3");
  assert.deepEqual([card.sato_hub_check.available, card.sato_hub_check.verdict, card.sato_hub_check.rule], [true, "go", "token.basic"]);
  assert.match(card.sato_hub_check.text, /\n- holders: top 10 hold 31%/, "the evidence keeps its lines");
  assert.equal(card.sato_hub_resolver.used, true);
  assert.equal(card.sato_hub_resolver.signature_checked, false, "the mock does not sign");
  assert.match(card.notes.join(" "), /could not be shown to be signed by Sato Hub/);
  assert.deepEqual(card.disagreements, []);
});

test("the chain wins: where Sato Hub's decimals differ, the card uses the chain's and says so", async () => {
  reset();
  chainDecimals = 6; // the chain says 6
  mode.resolve = () => ({ ...resolveBase(), decimals: 18 }); // Sato Hub says 18
  const r = await run(["token", DEGEN]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Decimals: 6 \(read from the chain\)/);
  assert.match(r.stdout, /Note: Sato Hub says 18 decimals; the chain says 6\. The chain's value is used\./);
  const j = JSON.parse((await run(["token", DEGEN, "--json"])).stdout);
  assert.equal(j.decimals, 6);
  assert.deepEqual(j.disagreements, ["Sato Hub says 18 decimals; the chain says 6. The chain's value is used."]);
});

test("Sato Hub's resolver missing: a bare address is read from the chain alone, with its token check still run", async () => {
  reset({ noResolver: true });
  const r = await run(["token", DEGEN]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Degen \(DEGEN 0x4ed4…efed\) on Base \(name per the contract/);
  assert.match(r.stdout, /Decimals: 18 \(read from the chain\)/);
  assert.match(r.stdout, /Price:    unknown/);
  assert.match(r.stdout, /Liquidity: unknown/);
  assert.match(r.stdout, /Note: Sato Hub's token resolver gave no answer \(Sato Hub: Unknown tool/);
  assert.match(r.stdout, /Sato Hub's token check \(dated evidence/);
  assert.deepEqual(asked.map((a) => a.name), ["onchain_agent_resolve_token", "onchain_agent_preflight"]);
});

test("Sato Hub's resolver missing: a link says so and asks for the contract address (and reads no chain)", async () => {
  reset({ noResolver: true });
  const r = await run(["token", "https://dexscreener.com/base/0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Sato Hub could not resolve this link right now; send the contract address instead/);
  assert.equal(asked.some((a) => a.name === "onchain_agent_preflight"), false);
  // the same for swap
  const s = await run(["swap", "--chain", "base", "--from", "USDC", "--to", "https://dexscreener.com/base/0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa", "--amount", "5", "--dry-run"]);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /Sato Hub could not resolve this link right now; send the contract address instead/);
});

test("swap: a link whose resolver answer is not signed by Sato Hub decides nothing (exit 3, resolver_unsigned)", async () => {
  reset(); // the mock answers, but unsigned (meta.signature is null)
  const s = await run(["swap", "--chain", "base", "--from", "USDC", "--to", "https://dexscreener.com/base/0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa", "--amount", "5", "--dry-run"]);
  assert.equal(s.code, 3, s.stderr);
  assert.match(s.stderr, /resolver_unsigned/);
  assert.match(s.stderr, /send the contract address instead/);
  assert.deepEqual(asked.map((a) => a.name), ["onchain_agent_resolve_token"], "nothing else was asked of Sato Hub");
});

test("a link Sato Hub resolves becomes the address only when its answer is signed; the chain is read for it", async () => {
  // the token card for a link: an unsigned answer decides nothing (the owner trades the card's address)
  reset(); // the mock answers, but unsigned (meta.signature is null)
  const r = await run(["token", "https://dexscreener.com/base/0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa", "--json"]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout + r.stderr, /resolver_unsigned/);
  assert.match(r.stdout + r.stderr, /send the contract address instead/);
  assert.equal(asked.length, 1, "no token check for an address the kit did not accept");
  // signed: the link's token becomes the card's address, read from the chain and checked by that address
  const card = await describeToken("https://dexscreener.com/base/0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa", {}, {
    resolveHub: async () => ({ ok: true, token: resolveBase(), signature: { ok: true } }),
    resolveBaseToken: async (a) => ({ address: a, decimals: chainDecimals, symbol: "DEGEN", name: "Degen", major: false }),
    runCheck: async (args) => ({ available: true, args }),
  });
  assert.equal(card.address, DEGEN);
  assert.equal(card.sato_hub_resolver.signature_checked, true);
  // a link Sato Hub answers "not found" for is not guessed at
  reset({ resolve: () => ({ resolved: false, code: "pair_unresolved", error: "that pool has no base token on record" }) });
  const miss = await run(["token", "https://dexscreener.com/base/0xdead"]);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /Sato Hub could not resolve this link \(that pool has no base token on record\); send the contract address instead/);
});

test("token on Solana: authorities and extensions in plain words, issuer powers as per-trade approvals, and Sato Hub's disagreement noted", async () => {
  reset({ resolve: (a) => resolveSol(a.input) });
  const bonk = await run(["token", BONK]);
  assert.equal(bonk.code, 0, bonk.stderr);
  assert.match(bonk.stdout, /Bonk \(BONK DezX…B263\) on Solana/);
  assert.match(bonk.stdout, /Needs your approval on every trade: a freeze authority is set: it can freeze this wallet's account/);
  assert.match(bonk.stdout, /Decimals: 5 \(read from the chain\)/);
  assert.match(bonk.stdout, /Program:  Token \(read from the chain\)/);
  assert.match(bonk.stdout, /Mint authority:   none \(no more can be created\)/);
  assert.match(bonk.stdout, new RegExp(`Freeze authority: set, to ${AUTH}`), "the chain's freeze authority");
  assert.match(bonk.stdout, /a frozen account cannot sell/);
  assert.match(bonk.stdout, /Token-2022 extensions: none/);
  assert.deepEqual(asked[1].args, { token: BONK, chain: "Solana" });

  reset({ resolve: (a) => resolveSol(a.input, { program: "token-2022", decimals: 6 }) });
  const powers = await run(["token", PYUSDISH]);
  assert.equal(powers.code, 0, powers.stderr);
  assert.match(powers.stdout, /Program:  Token-2022/);
  assert.match(powers.stdout, /Token-2022 extensions: PermanentDelegate, TransferHook/);
  assert.match(powers.stdout, /Needs your approval on every trade: PermanentDelegate: the issuer can move or burn this token in your wallet\./);
  assert.match(powers.stdout, /Needs your approval on every trade: TransferHook: the issuer's program runs on every transfer and can block a sale\./);
  assert.match(powers.stdout, /Note: Sato Hub lists the Token-2022 extensions none; the chain lists PermanentDelegate, TransferHook\. The chain's list is used\./);
  assert.doesNotMatch(powers.stdout, /Not tradable/);

  const stuck = await run(["token", FROZEN, "--json"]);
  assert.equal(stuck.code, 0, stuck.stderr);
  const card = JSON.parse(stuck.stdout);
  assert.match(card.solana.refused.join(" "), /NonTransferable/);
  assert.match((await run(["token", FROZEN])).stdout, /Not tradable by this kit: .*NonTransferable/);
  // the chain says Token-2022 where Sato Hub says the classic Token program
  reset({ resolve: (a) => resolveSol(a.input, { program: "spl", decimals: 6, token2022_extensions: ["PermanentDelegate", "TransferHook"] }) });
  const prog = await run(["token", PYUSDISH]);
  assert.match(prog.stdout, /Note: Sato Hub says the Token program; the chain says Token-2022\. The chain's value is used\./);
});

test("token needs an address and a real chain; an address that is not a token is refused; the check that cannot run is said so", async () => {
  reset();
  assert.equal((await run(["token"])).code, 2);
  assert.equal((await run(["token", DEGEN, "--chain", "eth"])).code, 2);
  const wrongChain = await run(["token", DEGEN, "--chain", "solana"]);
  assert.equal(wrongChain.code, 1);
  assert.match(wrongChain.stderr, /that is a base address, but --chain is solana/);
  const nothing = await run(["token", "0x000000000000000000000000000000000000dEaD"]);
  assert.equal(nothing.code, 3);
  assert.match(nothing.stderr, /token_unreadable.*no contract at/);
  const notMint = await run(["token", "11111111111111111111111111111111"]);
  assert.equal(notMint.code, 3);
  assert.match(notMint.stderr, /token_not_a_mint/);
  reset({ noPreflight: true });
  const down = await run(["token", DEGEN]);
  assert.equal(down.code, 0, "the card still prints");
  assert.match(down.stdout, /Sato Hub's token check did not run:/);
  assert.equal(JSON.parse((await run(["token", DEGEN, "--json"])).stdout).sato_hub_check.available, false);
});

test("describeToken and renderTokenCard, with injected fakes: no resolver, a name that tries to look like something else, an evil line", async () => {
  const chainOnly = {
    resolveHub: async () => ({ ok: false, reason: "unavailable", error: "Unknown tool" }),
    resolveBaseToken: async () => ({ address: DEGEN, symbol: "USDC‮", name: "Real\nUSDC", decimals: 6, native: false, major: false }),
    runCheck: async () => ({ unavailable: false, verdict: "caution", rule: "r1", text: "line one\n\u001b[31mline two", checked_at: DATE }),
  };
  const card = await describeToken(DEGEN, {}, chainOnly);
  assert.equal(card.sato_hub_check.verdict, "caution");
  const text = renderTokenCard(card).join("\n");
  assert.doesNotMatch(text, /\u001b|‮/, "outside text is cleaned");
  assert.match(text, /line one\n\[31mline two/);
  assert.match(text, /Price:    unknown/);
  await assert.rejects(describeToken("https://example.com/x", {}, chainOnly), /Sato Hub could not resolve this link right now; send the contract address instead/);
  await assert.rejects(describeToken("", {}, chainOnly), /token needs an address/);
});

// ---- the token side of swap, through the real CLI

test("swap: a token for a token is refused (exit 3), and --amount all is only for a token (exit 1)", async () => {
  reset();
  const tt = await run(["swap", "--chain", "solana", "--from", BONK, "--to", WIF, "--amount", "5", "--dry-run"]);
  assert.equal(tt.code, 3, tt.stderr);
  assert.match(tt.stderr, /token_to_token: one side of a swap must be USDC or SOL/);
  const all = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", BONK, "--amount", "all", "--dry-run"]);
  assert.equal(all.code, 1);
  assert.match(all.stderr, /--amount all sells the whole balance of a token/);
  const sym = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", "BONK", "--amount", "5", "--dry-run"]);
  assert.equal(sym.code, 1);
  assert.match(sym.stderr, /swaps USDC, SOL, or a token by its mint address/);
});

test("swap: a token that stops a sale is refused before anything is asked; high slippage stops for the owner in auto mode (exit 5) before any quote", async () => {
  reset();
  const refused = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", FROZEN, "--amount", "5", "--dry-run"]);
  assert.equal(refused.code, 3, refused.stderr);
  assert.match(refused.stderr, /token_extension_refused.*NonTransferable/);
  assert.equal(asked.length, 0, "Sato Hub was not asked");
  // 400 bps is above 300: the owner is asked, in auto mode, and no quote is built (nothing was asked of Sato Hub or Jupiter)
  const r = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", BONK, "--amount", "5", "--slippage-bps", "400", "--json"]);
  assert.equal(r.code, 5, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.needs_approval.intent.confirm_reasons, ["freeze_authority_set", "slippage_over_300_bps"], "BONK's mock mint has a freeze authority: that asks too");
  assert.deepEqual([out.needs_approval.intent.from_id, out.needs_approval.intent.to_id, out.needs_approval.intent.slippage_bps], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", BONK, 400]);
  assert.match(out.needs_approval.reasons[0], /the slippage is 400 bps, above 300 bps/);
  assert.equal(asked.length, 0, "no quote before the owner says yes");
  // an issuer power asks the same way, with its plain sentence
  const power = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", PYUSDISH, "--amount", "5", "--json"]);
  assert.equal(power.code, 5, power.stderr);
  const p = JSON.parse(power.stdout);
  assert.deepEqual(p.needs_approval.intent.confirm_reasons, ["issuer_power_PermanentDelegate", "issuer_power_TransferHook"]);
  assert.match(p.needs_approval.reasons.join(" "), /the issuer can move or burn this token in your wallet/);
  // and not in --json: the human text says why
  const human = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", PYUSDISH, "--amount", "5"]);
  assert.equal(human.code, 5);
  assert.match(human.stderr, /needs the owner's approval even though the agent acts within its limits, because:/);
  // a code that fits no swap is an error, not a way in
  const bad = await run(["swap", "--chain", "solana", "--from", "USDC", "--to", PYUSDISH, "--amount", "5", "--approve", "deadbeef"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /approval deadbeef not found/);
});

test("help lists the token command, the swap forms and the per-trade rules", async () => {
  const r = await run(["help"]);
  assert.match(r.stdout, /token <address\|mint\|link> \[--chain base\|solana\]/);
  assert.match(r.stdout, /--amount <n\|all>/);
  assert.match(r.stdout, /Slippage is picked\s+per trade/);
});
