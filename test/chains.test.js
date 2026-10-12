// The chain registry (src/chains.js): its shape, that Base's entry holds exactly the values v0.3 hard-coded (a pin
// that moved in the refactor would fail here, by address), the helpers, decimal-aware amounts, and the guard that
// keeps every other source file free of chain literals, so a new chain stays a registry entry plus its tests.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.js";

freshHome();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const chains = await import("../src/chains.js");
const {
  DEFAULT_EVM_CHAIN, NATIVE_PLACEHOLDER, chainKeys, chainlinkFeed, chainsWith, defaultStable, evmChain, evmChainById, evmChainKeys, explorerAddress, explorerTx,
  getChain, hasFeature, isEvm, isKnownChain, isSolana, isStableSymbol, kyberApiBase, labelList, labelOf, lockName, majorTokens, oracleChainOf, orList,
  pipeList, rpcUrl, stableByAddress, stableBySymbol, stableSymbols, stablesOf,
} = chains;
const amount = await import("../src/amount.js");

// ---------------------------------------------------------------- the v0.3 constants, written out once more

/** What v0.3 hard-coded for Base. Typed here on purpose: the registry is checked against it, not against itself. */
const V03 = {
  chainId: 8453,
  caip2: "eip155:8453",
  rpcDefault: "https://mainnet.base.org",
  rpcEnv: "SATO_AGENT_BASE_RPC",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  native: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  executor: "0x8F10B468b06c6FD214B65F87778827F7D113f996",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  ethFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  solFeed: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D",
  kyberApi: "https://aggregator-api.kyberswap.com/base/api/v1",
  solanaNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaUsdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

test("the registry today: base and solana, in that order, base the default EVM chain", () => {
  assert.deepEqual(chainKeys(), ["base", "solana"]);
  assert.deepEqual(evmChainKeys(), ["base"]);
  assert.equal(DEFAULT_EVM_CHAIN, "base");
  assert.equal(isEvm("base"), true);
  assert.equal(isEvm("solana"), false);
  assert.equal(isSolana("solana"), true);
});

test("every EVM entry has the full shape", () => {
  const address = /^0x[0-9a-fA-F]{40}$/;
  for (const key of evmChainKeys()) {
    const c = evmChain(key);
    assert.equal(c.key, key);
    assert.equal(c.kind, "evm");
    assert.ok(c.label && typeof c.label === "string");
    assert.equal(c.viem.id, c.chainId, "viem's chain id is the entry's");
    assert.equal(c.caip2, `eip155:${c.chainId}`);
    assert.equal(c.x402.caip2, c.caip2);
    assert.ok(c.x402.v1Name);
    assert.ok(c.hubName);
    assert.match(c.rpcEnv, /^SATO_AGENT_[A-Z]+_RPC$/);
    assert.ok(c.rpcDefaults.length >= 1 && c.rpcDefaults.every((u) => /^https:\/\//.test(u)));
    assert.match(c.explorer.url, /^https:\/\//);
    assert.ok(c.explorer.tx.startsWith("/") && c.explorer.address.startsWith("/"));
    for (const k of ["symbol", "name", "decimals", "oracle"]) assert.ok(c.native[k] !== undefined, `native.${k}`);
    for (const k of ["symbol", "name", "address", "decimals"]) assert.ok(c.wrappedNative[k] !== undefined, `wrappedNative.${k}`);
    assert.match(c.wrappedNative.address, address);
    assert.ok(Object.keys(c.stables).length >= 1);
    for (const [symbol, s] of Object.entries(c.stables)) {
      assert.equal(s.symbol, symbol);
      assert.match(s.address, address);
      assert.ok(Number.isInteger(s.decimals) && s.decimals > 0 && s.decimals <= 36);
      assert.equal(typeof s.eip3009, "boolean");
    }
    assert.ok(c.stables[c.defaultStable], "defaultStable names one of its stables");
    for (const k of ["address", "maxAgeS", "tolerancePct"]) assert.ok(c.chainlink.native[k] !== undefined, `chainlink.native.${k}`);
    assert.match(c.chainlink.native.address, address);
    for (const k of ["slug", "router", "executor"]) assert.ok(c.kyber[k], `kyber.${k}`);
    assert.match(c.kyber.router, address);
    assert.match(c.kyber.executor, address);
    assert.match(c.erc8004Registry, address);
    assert.ok(Number.isInteger(c.simulation.blockTimeS) && c.simulation.blockTimeS > 0);
    assert.equal(typeof c.simulation.tipFallbackWei, "bigint");
    assert.equal(typeof c.simulation.prevRandao, "boolean");
    for (const f of ["send", "swap", "x402", "giftcards", "register", "checkout"]) assert.equal(typeof c.features[f], "boolean", `features.${f}`);
  }
});

test("the registry cannot be changed at run time", () => {
  const c = evmChain("base");
  assert.throws(() => {
    c.kyber.router = "0x0000000000000000000000000000000000000001";
  }, TypeError);
  assert.throws(() => {
    c.stables.USDC.decimals = 18;
  }, TypeError);
  assert.equal(c.kyber.router, V03.router);
});

// ---------------------------------------------------------------- Base equals what v0.3 pinned

test("base: every pin equals the v0.3 constant, by address", () => {
  const b = evmChain("base");
  assert.equal(b.chainId, V03.chainId);
  assert.equal(b.caip2, V03.caip2);
  assert.equal(b.rpcEnv, V03.rpcEnv);
  assert.deepEqual([...b.rpcDefaults], [V03.rpcDefault]);
  assert.equal(b.explorer.url, "https://basescan.org");
  assert.equal(b.label, "Base");
  assert.equal(b.hubName, "Base");
  assert.equal(b.viem.name, "Base");
  assert.equal(b.native.symbol, "ETH");
  assert.equal(b.native.decimals, 18);
  assert.equal(b.native.oracle, "ETH");
  assert.equal(b.wrappedNative.address, V03.weth);
  assert.equal(b.wrappedNative.symbol, "WETH");
  assert.equal(b.wrappedNative.decimals, 18);
  assert.deepEqual(Object.keys(b.stables), ["USDC"]);
  assert.equal(b.stables.USDC.address, V03.usdc);
  assert.equal(b.stables.USDC.decimals, 6);
  assert.equal(b.stables.USDC.eip3009, true);
  assert.equal(b.defaultStable, "USDC");
  assert.equal(b.kyber.slug, "base");
  assert.equal(b.kyber.router, V03.router);
  assert.equal(b.kyber.executor, V03.executor);
  assert.equal(b.erc8004Registry, V03.identityRegistry);
  assert.equal(b.x402.v1Name, "base");
  assert.equal(b.x402.caip2, V03.caip2);
  assert.equal(b.chainlink.native.address, V03.ethFeed);
  assert.equal(b.chainlink.native.maxAgeS, 2 * 3600);
  assert.equal(b.chainlink.native.tolerancePct, 3);
  assert.equal(b.chainlink.other.SOL.address, V03.solFeed);
  assert.equal(b.chainlink.other.SOL.maxAgeS, 26 * 3600);
  assert.equal(b.chainlink.other.SOL.tolerancePct, 5);
  assert.equal(b.simulation.blockTimeS, 2);
  assert.equal(b.simulation.tipFallbackWei, 1_000_000n);
  assert.equal(b.simulation.prevRandao, true);
  assert.deepEqual({ ...b.features }, { send: true, swap: true, x402: true, giftcards: true, register: true, checkout: true, amazon: true });
  assert.equal(NATIVE_PLACEHOLDER, V03.native);
});

test("solana: the pins match the Solana modules' own constants", async () => {
  const s = getChain("solana");
  const { USDC_MINT } = await import("../src/solana.js");
  const { SOLANA_NETWORK } = await import("../src/x402-solana.js");
  assert.equal(s.caip2, SOLANA_NETWORK);
  assert.equal(s.caip2, V03.solanaNetwork);
  assert.equal(s.x402.caip2, SOLANA_NETWORK);
  assert.equal(s.stables.USDC.mint, USDC_MINT);
  assert.equal(s.stables.USDC.mint, V03.solanaUsdcMint);
  assert.equal(s.stables.USDC.decimals, 6);
  assert.equal(s.native.symbol, "SOL");
  assert.equal(s.native.decimals, 9);
  assert.equal(s.x402.v1Name, "solana");
  assert.equal(s.hubName, "Solana");
  assert.equal(oracleChainOf("solana"), "base", "SOL/USD is read through Base's feeds");
  assert.equal(oracleChainOf("base"), "base");
});

test("the names every module still exports for Base are the registry's values", async () => {
  const base = await import("../src/base.js");
  const evm = await import("../src/swap/evm.js");
  const price = await import("../src/price.js");
  const x402 = await import("../src/x402.js");
  const policy = await import("../src/policy.js");
  const bitrefill = await import("../src/bitrefill.js");
  assert.equal(base.USDC_BASE, V03.usdc);
  assert.equal(base.IDENTITY_REGISTRY, V03.identityRegistry);
  assert.equal(evm.WETH_BASE, V03.weth);
  assert.equal(evm.NATIVE_PLACEHOLDER, V03.native);
  assert.equal(evm.KYBER_ROUTER_BASE, V03.router);
  assert.equal(evm.KYBER_EXECUTOR_BASE, V03.executor);
  assert.equal(evm.BASE_CHAIN_ID, V03.chainId);
  assert.equal(evm.KYBER_API_BASE, V03.kyberApi);
  assert.deepEqual(evm.LATER_BLOCK, [{ blocks: 1, seconds: 2 }, { blocks: 2, seconds: 4 }]);
  assert.deepEqual(
    Object.entries(evm.TOKENS).map(([k, t]) => [k, t.symbol, t.name, t.address, t.decimals, t.native, t.major]),
    [
      ["USDC", "USDC", "USD Coin", V03.usdc, 6, false, true],
      ["WETH", "WETH", "Wrapped Ether", V03.weth, 18, false, true],
      ["ETH", "ETH", "Ether", V03.native, 18, true, true],
    ],
  );
  assert.deepEqual(price.FEEDS, { ETH: { address: V03.ethFeed, maxAgeS: 7200 }, SOL: { address: V03.solFeed, maxAgeS: 93_600 } });
  assert.deepEqual(price.ORACLE_TOLERANCE_PCT, { ETH: 3, SOL: 5 });
  assert.equal(x402.BASE_NETWORK, V03.caip2);
  assert.deepEqual(x402.PAY_CHAINS, ["base", "solana"]);
  assert.deepEqual(policy.CHAINS, ["base", "solana"]);
  assert.equal(bitrefill.SIWX_CHAIN, V03.caip2);
  assert.equal(bitrefill.SIWX_CHAIN_ID, V03.chainId);
});

test("a v0.1 policy with no chains still means exactly base and solana, whatever the registry grows into", async () => {
  const { allowedChains } = await import("../src/policy.js");
  assert.deepEqual([...allowedChains({ schema: "sato-agent.policy/v1" })], ["base", "solana"]);
  assert.deepEqual([...allowedChains(null)], ["base", "solana"]);
  assert.deepEqual(allowedChains({ chains: ["solana"] }), ["solana"]);
});

test("lock names keep v0.3's, so a running v0.3 bot interlocks with this one", () => {
  assert.equal(lockName("base", "nonce"), "base-nonce");
  assert.equal(lockName("base", "swap"), "base-swap");
});

// ---------------------------------------------------------------- helpers

test("lookups: unknown and wrong-kind keys throw, known ones answer", () => {
  assert.equal(getChain("base").key, "base");
  assert.throws(() => getChain("nope"), /unknown chain "nope"/);
  assert.throws(() => getChain("__proto__"), /unknown chain/);
  assert.throws(() => getChain(undefined), /unknown chain/);
  assert.throws(() => evmChain("solana"), /Solana is not an EVM chain/);
  assert.throws(() => evmChain("nope"), /unknown chain/);
  assert.equal(isKnownChain("base"), true);
  assert.equal(isKnownChain("nope"), false);
  assert.equal(isKnownChain("constructor"), false);
  assert.equal(isEvm("nope"), false);
  assert.equal(isEvm(undefined), false);
  assert.equal(labelOf("base"), "Base");
  assert.equal(labelOf("solana"), "Solana");
});

test("evmChainById: a number or a digit string, and only a chain the registry has", () => {
  assert.equal(evmChainById(8453).key, "base");
  assert.equal(evmChainById("8453").key, "base");
  assert.equal(evmChainById(1), null);
  assert.equal(evmChainById("0x2105"), null);
});

test("features: which chains offer what", () => {
  assert.deepEqual(chainsWith("swap"), ["base", "solana"]);
  assert.deepEqual(chainsWith("x402"), ["base", "solana"]);
  assert.deepEqual(chainsWith("giftcards"), ["base"]);
  assert.deepEqual(chainsWith("register"), ["base"]);
  assert.deepEqual(chainsWith("nonsense"), []);
  assert.equal(hasFeature("solana", "giftcards"), false);
  assert.equal(hasFeature("base", "giftcards"), true);
  assert.equal(hasFeature("nope", "swap"), false);
});

test("explorer links and sentences", () => {
  const h = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTx("base", h), `https://basescan.org/tx/${h}`);
  assert.equal(explorerAddress("base", "0x1111111111111111111111111111111111111111"), "https://basescan.org/address/0x1111111111111111111111111111111111111111");
  assert.equal(explorerTx("solana", "sig"), "https://solscan.io/tx/sig");
  assert.equal(explorerAddress("solana", "Abc"), "https://solscan.io/account/Abc");
  assert.equal(labelList(["base"]), "Base");
  assert.equal(labelList(["base", "solana"]), "Base and Solana");
  assert.equal(labelList(["base", "solana", "base"]), "Base, Solana and Base");
  assert.equal(orList(["USDC", "ETH", "WETH"]), "USDC, ETH or WETH");
  assert.equal(orList(["base", "solana"]), "base or solana");
  assert.equal(orList(["base"]), "base");
  assert.equal(pipeList(chainKeys()), "base|solana");
});

test("rpcUrl: the owner's variable wins, the public default otherwise", () => {
  assert.equal(rpcUrl("base", {}), V03.rpcDefault);
  assert.equal(rpcUrl("base", { SATO_AGENT_BASE_RPC: "http://127.0.0.1:8545" }), "http://127.0.0.1:8545");
  assert.equal(rpcUrl("base", { SATO_AGENT_BASE_RPC: "" }), V03.rpcDefault);
  assert.throws(() => rpcUrl("solana", {}), /not an EVM chain/);
});

test("stables: by address (any letter case) and by symbol, the symbols the fee tier calls stable", () => {
  assert.equal(stableByAddress("base", V03.usdc.toLowerCase()).symbol, "USDC");
  assert.equal(stableByAddress("base", V03.usdc.toUpperCase().replace("0X", "0x")).symbol, "USDC");
  assert.equal(stableByAddress("base", V03.weth), null);
  assert.equal(stableByAddress("base", "not an address"), null);
  assert.equal(stableBySymbol("base", "usdc").decimals, 6);
  assert.equal(stableBySymbol("base", "USDT"), null);
  assert.equal(isStableSymbol("base", "USDC"), true);
  assert.equal(isStableSymbol("base", "WETH"), false);
  assert.equal(isStableSymbol("solana", "USDC"), true);
  assert.deepEqual(stableSymbols(), ["USDC"]);
  assert.deepEqual(stableSymbols("base"), ["USDC"]);
  assert.deepEqual(stablesOf("solana").map(([s]) => s), ["USDC"]);
  assert.equal(defaultStable("base").address, V03.usdc);
});

test("majorTokens: every stable, the wrapped native and the native coin, frozen", () => {
  const t = majorTokens("base");
  assert.deepEqual(Object.keys(t), ["USDC", "WETH", "ETH"]);
  assert.equal(Object.isFrozen(t), true);
  assert.equal(Object.isFrozen(t.USDC), true);
  assert.equal(t.ETH.native, true);
  assert.equal(t.ETH.address, NATIVE_PLACEHOLDER);
  assert.equal(t.WETH.native, false);
});

test("chainlinkFeed: the chain's native feed, its other feeds, nothing else", () => {
  assert.equal(chainlinkFeed("base", "ETH").address, V03.ethFeed);
  assert.equal(chainlinkFeed("base", "SOL").address, V03.solFeed);
  assert.equal(chainlinkFeed("base", "DOGE"), null);
  assert.throws(() => chainlinkFeed("solana", "SOL"), /not an EVM chain/);
});

test("kyberApiBase: the chain's slug in KyberSwap's public API", () => {
  assert.equal(kyberApiBase("base"), V03.kyberApi);
});

// ---------------------------------------------------------------- decimal-aware amounts

test("amounts: USDC's 6 decimals by default, any token's by argument; limits stay in USD", () => {
  assert.equal(amount.usdcUnits("12.5"), 12_500_000n);
  assert.equal(amount.usdcUnits("0.000001"), 1n);
  assert.throws(() => amount.usdcUnits("1.0000009"), /not a USDC amount: "1.0000009" \(a plain number with at most 6 decimals, like 12.5\)/);
  assert.throws(() => amount.usdcUnits("0"), /not a positive USDC amount: "0"/);
  assert.throws(() => amount.usdcUnits("1."), /not a USDC amount/);
  assert.throws(() => amount.usdcUnits("-1"), /not a USDC amount/);
  // An 18-decimal stablecoin: the same strings, scaled by its decimals, named by its symbol.
  assert.equal(amount.stableUnits("1.5", 18, "USDT"), 1_500_000_000_000_000_000n);
  assert.equal(amount.stableUnits("0.000000000000000001", 18, "USDT"), 1n);
  assert.throws(() => amount.stableUnits("0.0000000000000000001", 18, "USDT"), /not a USDT amount: .* at most 18 decimals/);
  assert.throws(() => amount.stableUnits("1.1234567", 6, "USDC"), /at most 6 decimals/);
  assert.equal(amount.usdcUnits("2", 18, "USDT"), 2_000_000_000_000_000_000n);
  assert.equal(amount.unitsToUsd(1_500_000n), 1.5);
  assert.equal(amount.unitsToUsd(1_500_000_000_000_000_000n, 18), 1.5);
  assert.equal(amount.unitsToUsd(12_345_678n, 6), 12.345678);
  assert.equal(amount.usdToUnits(1.5), 1_500_000n);
  assert.equal(amount.usdToUnits(1.5, 18), 1_500_000_000_000_000_000n);
  assert.equal(amount.unitsToText(12_500_000n), "12.5");
  assert.equal(amount.unitsToText(3_000_000n), "3");
  assert.equal(amount.unitsToText(1n, 18), "0.000000000000000001");
  assert.equal(amount.unitsToText(1_234_500_000_000_000_000n, 18), "1.2345");
  assert.equal(amount.roundUsd(0.1 + 0.2), 0.3);
});

// ---------------------------------------------------------------- the guard: no chain literals outside the registry

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * A chain id, a chain's token, explorer or RPC written outside src/chains.js is a place a new chain would be forgotten.
 * Each pattern lists the few files where a hit is deliberate, and why. A listed file that no longer has the hit fails too, so
 * the list cannot go stale.
 */
const PATTERNS = [
  { name: "Base's chain id", re: /8453/ },
  { name: "the USDC_BASE constant", re: /USDC_BASE/, allowed: { "src/base.js": "the v0.3 name Base's callers and tests import; its value is read from the registry" } },
  { name: "a basescan link", re: /basescan\.org/ },
  { name: "Base's public RPC", re: /mainnet\.base\.org/ },
  { name: "a CAIP-2 EVM network id", re: /eip155:\d/ },
  { name: "KyberSwap's per-chain API", re: /aggregator-api\.kyberswap\.com/ },
  { name: "an explorer other than the registry's", re: /(?:etherscan|bscscan|arbiscan|polygonscan|snowtrace)\.(?:io|com|org)/ },
];

/** A 0x address written in code outside the registry: only these, each not a per-chain fact. */
const ALLOWED_ADDRESSES = {
  "src/purchase-evm.js": ["0x000000000022D473030F116dDEE9F6B43aC78BA3"], // Permit2 (the same on every chain), named in a comment
  "src/bitrefill.js": ["0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A"], // Bitrefill's x402 payee: Bitrefill's, not a chain's
  "src/swap/evm.js": ["0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9", "0x0000000000000000000000000000000000000000"], // Sato's fee address (one key on every chain); the zero address
};

const files = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "bin"))]
  .map((p) => ({ path: relative(root, p), text: readFileSync(p, "utf8") }))
  .filter((f) => f.path !== join("src", "chains.js"));

test("guard: the source reads chains from the registry, not from literals", () => {
  assert.ok(files.length > 20, "the guard found the source tree");
  const problems = [];
  for (const { name, re, allowed = {} } of PATTERNS) {
    for (const f of files) {
      const hit = re.test(f.text);
      if (hit && !allowed[f.path]) problems.push(`${f.path} has ${name} (${re}); read it from src/chains.js`);
      if (!hit && allowed[f.path]) problems.push(`${f.path} is allowed ${name} but no longer has it; remove it from the list`);
    }
    for (const p of Object.keys(allowed)) if (!files.some((f) => f.path === p)) problems.push(`${p} is allowed ${name} but does not exist`);
  }
  assert.deepEqual(problems, []);
});

test("guard: a 0x address in the source is a registry address or one of the few listed", () => {
  const registry = new Set();
  const walk = (o) => {
    if (typeof o === "string" && /^0x[0-9a-fA-F]{40}$/.test(o)) registry.add(o.toLowerCase());
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (k !== "viem") walk(v);
  };
  walk(getChain("base"));
  const problems = [];
  for (const f of files) {
    const found = [...new Set(f.text.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])];
    const allowed = new Set((ALLOWED_ADDRESSES[f.path] ?? []).map((a) => a.toLowerCase()));
    for (const a of found) if (!allowed.has(a.toLowerCase())) problems.push(`${f.path} writes the address ${a}; a chain's addresses belong in src/chains.js`);
    for (const a of allowed) if (!found.some((x) => x.toLowerCase() === a)) problems.push(`${f.path} is allowed ${a} but no longer has it`);
  }
  assert.deepEqual(problems, []);
  // And the registry's own addresses are not repeated anywhere else (they would be the same literal, guarded above).
  assert.ok(registry.size >= 6);
});
