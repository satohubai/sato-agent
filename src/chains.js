// The chain registry: the ONE place a chain's facts live. Every other module reads a chain
// from here by its key ("base", "solana"), so adding an EVM chain is one entry below plus its
// tests, and no other source file names a chain id, a token address, an explorer or an RPC.
//
// The key is also what the owner and the agent say: `--chain base`, the policy's `chains`, the
// ledger's `chain` field, the Hub request's chain. The wallet's address for every EVM chain is
// the same key's address, kept under `addresses().base` (a wallet file and a JSON output that
// older versions already write).
//
// Facts here are PINS. They are checked into the repo with where they came from, and the kit
// refuses a transaction, a router or an executor that does not match them. A value for a new
// chain is read from the chain itself or the project's own docs and observed live, never
// copied from another chain's entry.

import { arbitrum, base, bsc, polygon } from "viem/chains";

/** The placeholder KyberSwap (and Sato Hub's gate) use for a chain's native coin. */
export const NATIVE_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// The entries are frozen so no module can change a pin at run time. viem's own chain object is left alone: it belongs to viem.
const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const [k, v] of Object.entries(o)) if (k !== "viem") deepFreeze(v);
  }
  return o;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Pins KyberSwap and the ERC-8004 project publish ONE address for on every EVM chain they serve. Each chain below still lists them in
// its own entry, and each was re-observed per chain (2026-10-12, SPIKES.md section 2 and 3): 28 of 28 live builds named this router and
// executor on BNB, Arbitrum and Polygon; the router is Sourcify-verified on each; the executor's runtime code is identical on all.
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const KYBER_EXECUTOR = "0x8F10B468b06c6FD214B65F87778827F7D113f996";
const ERC8004_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const REGISTRY = deepFreeze({
  base: {
    key: "base",
    label: "Base",
    kind: "evm",
    viem: base,
    chainId: 8453,
    caip2: "eip155:8453",
    /** How Sato Hub's swap tool names the chain (`chain_in` / `chain_out`). */
    hubName: "Base",
    /** The environment variable an owner sets to use their own RPC, and the public ones used otherwise (first is the default). */
    rpcEnv: "SATO_AGENT_BASE_RPC",
    rpcDefaults: ["https://mainnet.base.org"],
    explorer: { url: "https://basescan.org", tx: "/tx/", address: "/address/" },
    native: { symbol: "ETH", name: "Ether", decimals: 18, oracle: "ETH" },
    wrappedNative: { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    /** Stablecoins the kit sends, pays and treats as a "stable" in the fee tier. `eip3009`: can be paid by a signed authorization (x402). */
    stables: { USDC: { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, eip3009: true } },
    /** The stable a send / pay / checkout uses when the owner names none. */
    defaultStable: "USDC",
    chainlink: {
      // ETH/USD on Base. Heartbeat 20 min, deviation 0.15%.
      native: { address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAgeS: 2 * 3600, tolerancePct: 3 },
      // Feeds Chainlink publishes on this chain for assets that live elsewhere. SOL/USD: heartbeat 24 h, deviation 0.5%.
      other: { SOL: { address: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D", maxAgeS: 26 * 3600, tolerancePct: 5 } },
    },
    kyber: {
      slug: "base",
      /** MetaAggregationRouterV2, read from Kyber's own API (routerAddress) and checked onchain. */
      router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      /** The only `callTarget` accepted (seen on every live build). */
      executor: "0x8F10B468b06c6FD214B65F87778827F7D113f996",
    },
    /** ERC-8004 IdentityRegistry (github.com/erc-8004/erc-8004-contracts). */
    erc8004Registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    x402: { v1Name: "base", caip2: "eip155:8453" },
    /** What the kit's own eth_simulateV1 needs to look like this chain: block time, and the tip used when the node cannot say. */
    simulation: { blockTimeS: 2, tipFallbackWei: 1_000_000n, prevRandao: true, timedBlocks: true, zeroBaseFee: false },
    // amazon: Crossmint orders (dark until switched on); giftcards: Bitrefill's agent API takes this chain.
    features: { send: true, swap: true, x402: true, giftcards: true, register: true, checkout: true, amazon: true },
  },
  bnb: {
    key: "bnb",
    label: "BNB Chain",
    kind: "evm",
    viem: bsc,
    chainId: 56,
    caip2: "eip155:56",
    hubName: "BNB Chain",
    // The public endpoints that answered eth_simulateV1 on 2026-10-12 (SPIKES.md section 1). dataseed rate-limits after about ten quick
    // calls, so a call that is turned away moves to the next one (src/rpc.js). An owner's own endpoint replaces the list.
    rpcEnv: "SATO_AGENT_BNB_RPC",
    rpcDefaults: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io", "https://bsc.drpc.org"],
    explorer: { url: "https://bscscan.com", tx: "/tx/", address: "/address/" },
    native: { symbol: "BNB", name: "BNB", decimals: 18, oracle: "BNB" },
    wrappedNative: { symbol: "WBNB", name: "Wrapped BNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
    // BOTH stablecoins have 18 decimals here (everywhere else 6). Neither is Circle's: the USDC is Binance-Peg, no EIP-3009, so no x402.
    // Neither needs approve(0) first (the verified USDT source sets the allowance directly).
    stables: {
      USDT: { symbol: "USDT", name: "Tether USD", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, eip3009: false },
      USDC: { symbol: "USDC", name: "USD Coin", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, eip3009: false },
    },
    defaultStable: "USDT",
    chainlink: {
      // BNB/USD: heartbeat 27 s, deviation 0.1%, rounds about every 33 s. Five minutes without an update is stale.
      native: { address: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", maxAgeS: 300, tolerancePct: 3 },
      other: {},
    },
    kyber: { slug: "bsc", router: KYBER_ROUTER, executor: KYBER_EXECUTOR },
    erc8004Registry: ERC8004_REGISTRY,
    // No x402 here (owner ruling): no general facilitator, and Binance-Peg USDC cannot sign an EIP-3009 authorization.
    x402: { v1Name: null, caip2: "eip155:56" },
    // Blocks come every 0.45 s, so a +1 block / +2 s override is refused (-38020); the latest block's baseFeePerGas is 0 (legacy gas
    // pricing, 0.05 gwei) and its mixHash is zero.
    simulation: { blockTimeS: 1, tipFallbackWei: 50_000_000n, prevRandao: false, timedBlocks: false, zeroBaseFee: true },
    features: { send: true, swap: true, x402: false, giftcards: false, register: true, checkout: true, amazon: false },
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum",
    kind: "evm",
    viem: arbitrum,
    chainId: 42161,
    caip2: "eip155:42161",
    hubName: "Arbitrum",
    rpcEnv: "SATO_AGENT_ARBITRUM_RPC",
    rpcDefaults: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    explorer: { url: "https://arbiscan.io", tx: "/tx/", address: "/address/" },
    native: { symbol: "ETH", name: "Ether", decimals: 18, oracle: "ETH" },
    wrappedNative: { symbol: "WETH", name: "Wrapped Ether", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    // Native Circle USDC is the default. USDT here is USDT0 (symbol "USD₮0" on chain; typed USDT). The bridged USDC.e is NOT listed:
    // it is not Circle's, and the kit never treats it as the stable.
    stables: {
      USDC: { symbol: "USDC", name: "USD Coin", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, eip3009: true },
      USDT: { symbol: "USDT", name: "Tether USD (USDT0)", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, eip3009: true },
    },
    defaultStable: "USDC",
    chainlink: {
      // ETH/USD: heartbeat 1755 s (29 min), deviation 0.05%. Two hours matches Base's ETH feed.
      native: { address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", maxAgeS: 2 * 3600, tolerancePct: 3 },
      other: {},
      // L2 Sequencer Uptime feed (Chainlink's guidance for L2 prices): an answer of 1 is "down", and for graceS after it comes back up
      // the price is not trusted. Read before every price on this chain.
      sequencer: { address: "0xFdB631F5EE196F0ed6FAa767959853A9F217697D", graceS: 3600 },
    },
    kyber: { slug: "arbitrum", router: KYBER_ROUTER, executor: KYBER_EXECUTOR },
    erc8004Registry: ERC8004_REGISTRY,
    x402: { v1Name: "arbitrum", caip2: "eip155:42161" },
    // Blocks of 0.25 to 0.3 s: block-number / time overrides fail here too. Base fee 0.02 gwei, tip 0.
    simulation: { blockTimeS: 1, tipFallbackWei: 0n, prevRandao: false, timedBlocks: false, zeroBaseFee: false },
    features: { send: true, swap: true, x402: true, giftcards: true, register: true, checkout: true, amazon: false },
  },
  polygon: {
    key: "polygon",
    label: "Polygon",
    kind: "evm",
    viem: polygon,
    chainId: 137,
    caip2: "eip155:137",
    hubName: "Polygon",
    // From the researched list. The first three failed their TLS handshake from the research Mac (a path problem there, retest from the
    // deploy host); OnFinality answered but rate-limits about every second call; ZAN simulates but blocks eth_call without an account
    // ("cu limit exceeded", which moves the call on). A keyed provider (SATO_AGENT_POLYGON_RPC) is the dependable route: swaps need
    // eth_simulateV1 and refuse without it.
    rpcEnv: "SATO_AGENT_POLYGON_RPC",
    rpcDefaults: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com", "https://polygon.drpc.org", "https://polygon.api.onfinality.io/public", "https://api.zan.top/polygon-mainnet"],
    explorer: { url: "https://polygonscan.com", tx: "/tx/", address: "/address/" },
    native: { symbol: "POL", name: "Polygon Ecosystem Token", decimals: 18, oracle: "POL" },
    wrappedNative: { symbol: "WPOL", name: "Wrapped Polygon Ecosystem Token", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    // Native Circle USDC is the default; USDC.e (0x2791…4174, bridged) is never the stable. USDT is USDT0: no EIP-3009 here.
    stables: {
      USDC: { symbol: "USDC", name: "USD Coin", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, eip3009: true },
      USDT: { symbol: "USDT", name: "Tether USD (USDT0)", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, eip3009: false },
    },
    defaultStable: "USDC",
    chainlink: {
      // The POL price is Chainlink's MATIC/USD feed (no separate POL/USD): heartbeat 27 s, deviation 0.25%. POL is thinner than ETH, so
      // the quote may sit 5% from the feed.
      native: { address: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", maxAgeS: 300, tolerancePct: 5 },
      other: {},
    },
    kyber: { slug: "polygon", router: KYBER_ROUTER, executor: KYBER_EXECUTOR },
    erc8004Registry: ERC8004_REGISTRY,
    x402: { v1Name: "polygon", caip2: "eip155:137" },
    // Blocks of about 1.5 s on load-balanced nodes that lag: overrides fail (-38020). Base fee about 248 gwei, tip about 30 gwei.
    simulation: { blockTimeS: 2, tipFallbackWei: 30_000_000_000n, prevRandao: false, timedBlocks: false, zeroBaseFee: false },
    features: { send: true, swap: true, x402: true, giftcards: true, register: true, checkout: true, amazon: false },
  },
  solana: {
    key: "solana",
    label: "Solana",
    kind: "solana",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    hubName: "Solana",
    explorer: { url: "https://solscan.io", tx: "/tx/", address: "/account/" },
    native: { symbol: "SOL", name: "Solana", decimals: 9, oracle: "SOL" },
    stables: { USDC: { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 } },
    defaultStable: "USDC",
    // Chainlink publishes SOL/USD on Base, not on Solana: the independent SOL price is read through that chain's feeds.
    chainlink: { via: "base" },
    x402: { v1Name: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    features: { send: true, swap: true, x402: true, giftcards: false, register: false, checkout: true, amazon: true },
  },
});

// ---------------------------------------------------------------- lookups

/** Every chain key the kit knows, in the order they are listed to the owner. */
export const chainKeys = () => Object.keys(REGISTRY);
/** The keys of the EVM chains (the ones that share the wallet's 0x key). */
export const evmChainKeys = () => chainKeys().filter((k) => REGISTRY[k].kind === "evm");
/**
 * The EVM chain a bare 0x address or a command with no chain means. Base: what every v0.3 command meant. A command that takes
 * `--chain` uses the chain named; this is only for the places that never had a chain to name.
 */
export const DEFAULT_EVM_CHAIN = "base";
/** The chain whose Chainlink feeds price an asset for `key` (itself on an EVM chain; Solana reads its SOL/USD on Base). */
export const oracleChainOf = (key) => REGISTRY[key]?.chainlink?.via ?? key;
/** The chain entry for `key`, of any kind; throws on a key the kit does not know. */
export function getChain(key) {
  const c = Object.hasOwn(REGISTRY, String(key)) ? REGISTRY[String(key)] : null;
  if (!c) throw new Error(`unknown chain "${String(key).slice(0, 40)}" (known: ${chainKeys().join(", ")})`);
  return c;
}
/** An EVM chain's entry; throws on a key that is unknown or not an EVM chain. */
export function evmChain(key) {
  const c = getChain(key);
  if (c.kind !== "evm") throw new Error(`${c.label} is not an EVM chain`);
  return c;
}
export const isKnownChain = (key) => typeof key === "string" && Object.hasOwn(REGISTRY, key);
export const isEvm = (key) => isKnownChain(key) && REGISTRY[key].kind === "evm";
export const isSolana = (key) => isKnownChain(key) && REGISTRY[key].kind === "solana";
export const labelOf = (key) => getChain(key).label;
/** The EVM chain with this chain id (a number or a digit string), or null. */
export const evmChainById = (id) => evmChainKeys().map((k) => REGISTRY[k]).find((c) => String(c.chainId) === String(id)) ?? null;
/** The keys of the chains that have a feature ("swap", "x402", ...), registry order. */
export const chainsWith = (feature) => chainKeys().filter((k) => REGISTRY[k].features?.[feature] === true);
export const hasFeature = (key, feature) => isKnownChain(key) && REGISTRY[key].features?.[feature] === true;

/** "Base", "Base and Solana", "A, B and C": the labels of some chains, for a sentence. */
export function labelList(keys) {
  const l = keys.map(labelOf);
  return l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/** "base or solana", "a, b or c": chain keys (or any words) for a sentence. */
export const orList = (words) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`);
/** "base|solana": chain keys for a usage line. */
export const pipeList = (words) => words.join("|");

// ---------------------------------------------------------------- explorers

export const explorerTx = (key, hash) => {
  const e = getChain(key).explorer;
  return `${e.url}${e.tx}${hash}`;
};
export const explorerAddress = (key, address) => {
  const e = getChain(key).explorer;
  return `${e.url}${e.address}${address}`;
};

// ---------------------------------------------------------------- RPC

/**
 * The RPC endpoints an EVM chain is read and written through, in order: the owner's (rpcEnv: one url, or several separated by
 * commas), else the registry's public list. src/rpc.js moves to the next one when an endpoint turns a call away.
 */
export function rpcUrls(key, env = process.env) {
  const c = evmChain(key);
  const own = String(env[c.rpcEnv] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return own.length ? own : [...c.rpcDefaults];
}
/** The first endpoint of `rpcUrls`. */
export const rpcUrl = (key, env = process.env) => rpcUrls(key, env)[0];

// ---------------------------------------------------------------- tokens

/** The stable entries of a chain as [symbol, entry] pairs. */
export const stablesOf = (key) => Object.entries(getChain(key).stables ?? {});
/** The stable symbols of one chain, or (no key) of every chain: what the fee tier calls a "stable". */
export function stableSymbols(key) {
  const keys = key === undefined ? chainKeys() : [key];
  return [...new Set(keys.flatMap((k) => stablesOf(k).map(([s]) => s)))];
}
export const isStableSymbol = (key, symbol) => Object.hasOwn(getChain(key).stables ?? {}, String(symbol ?? "").toUpperCase());
/** The stable entry on an EVM chain whose address is `address` (any letter case), or null. */
export const stableByAddress = (key, address) => stablesOf(key).map(([, s]) => s).find((s) => s.address && String(s.address).toLowerCase() === String(address).toLowerCase()) ?? null;
export const stableBySymbol = (key, symbol) => getChain(key).stables?.[String(symbol ?? "").toUpperCase()] ?? null;
/** The stable a send / pay uses by default on this chain. */
export const defaultStable = (key) => {
  const c = getChain(key);
  return c.stables[c.defaultStable];
};

/**
 * The "major" assets of an EVM chain, keyed by symbol, as the swap code reads them: every stable, the wrapped native
 * token and the native coin (at the placeholder address). One side of every swap is one of these.
 */
export function majorTokens(key) {
  const c = evmChain(key);
  const out = {};
  for (const s of Object.values(c.stables)) out[s.symbol] = Object.freeze({ symbol: s.symbol, name: s.name, address: s.address, decimals: s.decimals, native: false, major: true });
  const w = c.wrappedNative;
  out[w.symbol] = Object.freeze({ symbol: w.symbol, name: w.name, address: w.address, decimals: w.decimals, native: false, major: true });
  const n = c.native;
  out[n.symbol] = Object.freeze({ symbol: n.symbol, name: n.name, address: NATIVE_PLACEHOLDER, decimals: n.decimals, native: true, major: true });
  return Object.freeze(out);
}

/** A chain's major assets as symbols, in the order prose lists them: its stables, its native coin, its wrapped native ("USDC", "ETH", "WETH"). */
export function majorSymbols(key) {
  const c = getChain(key);
  return [...Object.keys(c.stables), c.native.symbol, ...(c.wrappedNative ? [c.wrappedNative.symbol] : [])];
}

/** The Chainlink feed for `asset` ("ETH", "SOL", ...) read through chain `key`: its native feed, or one of its `other` feeds. Null if none. */
export function chainlinkFeed(key, asset) {
  const c = evmChain(key);
  if (c.chainlink?.native && asset === c.native.oracle) return { asset, ...c.chainlink.native };
  const o = c.chainlink?.other?.[asset];
  return o ? { asset, ...o } : null;
}

/** An L2's sequencer uptime feed ({ address, graceS }), or null on a chain without one. */
export const sequencerFeed = (key) => evmChain(key).chainlink?.sequencer ?? null;

/** KyberSwap's public aggregator API on an EVM chain (used only to build the simulated sell-back leg and to presize a sale). */
export const kyberApiBase = (key) => `https://aggregator-api.kyberswap.com/${evmChain(key).kyber.slug}/api/v1`;

// ---------------------------------------------------------------- locks

/** The lock a chain's transactions are serialized under. `base-nonce` and `base-swap` keep the names v0.3 used, so a running older bot interlocks. */
export const lockName = (key, what) => `${getChain(key).key}-${what}`;

// ---------------------------------------------------------------- sanity

/** Checked at load: a malformed entry stops the kit rather than being used. */
for (const key of evmChainKeys()) {
  const c = REGISTRY[key];
  const addrs = [c.wrappedNative.address, c.kyber.router, c.kyber.executor, c.erc8004Registry, ...Object.values(c.stables).map((s) => s.address), ...Object.values(c.chainlink.other ?? {}).map((f) => f.address), c.chainlink.native.address, ...(c.chainlink.sequencer ? [c.chainlink.sequencer.address] : [])];
  for (const a of addrs) if (!EVM_ADDRESS.test(a)) throw new Error(`chains.js: ${key} has a malformed address ${String(a).slice(0, 50)}`);
  if (c.caip2 !== `eip155:${c.chainId}` || c.viem.id !== c.chainId || c.x402.caip2 !== c.caip2) throw new Error(`chains.js: ${key}'s chain id disagrees with its caip2 / viem chain / x402 network`);
  if (!c.stables[c.defaultStable]) throw new Error(`chains.js: ${key}'s defaultStable is not one of its stables`);
  // A feature that depends on a property of the default stable cannot be switched on where the stable lacks it.
  const d = c.stables[c.defaultStable];
  if (c.features.x402 && (d.eip3009 !== true || !c.x402.v1Name)) throw new Error(`chains.js: ${key} has x402 on, but its default stable cannot sign an EIP-3009 authorization (or it has no v1 network name)`);
  if (c.features.giftcards && (d.symbol !== "USDC" || d.eip3009 !== true || d.decimals !== 6)) throw new Error(`chains.js: ${key} has gift cards on, but Bitrefill is paid in 6-decimal Circle USDC`);
  if (!c.rpcDefaults.length) throw new Error(`chains.js: ${key} has no RPC endpoint`);
}
