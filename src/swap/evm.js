// Swaps on Base through Sato Hub's swap tool: USDC <-> ETH / WETH, and ANY ERC-20 token
// against USDC, ETH or WETH (the "major" side). One side is always a major; a swap of one
// long-tail token for another is not supported (a later phase).
//
// Sato Hub's fee is always taken in the major side, never in the long-tail token:
//   buying a long-tail token    fee in the input  (chargeFeeBy=currency_in, flags 0x280)
//   selling a long-tail token   fee in the output (chargeFeeBy=currency_out, FEE_ON_DST 0x40, flags 0x2c0)
// The fee side is read from Sato Hub's disclosure (`sato_fee_side`: "in" | "out"), or inferred from
// which side is the major when the field is absent, and the decoded calldata must match it exactly.
//
// A token's decimals, symbol and name are read from the chain (never from a resolver): a token with
// no code, or with unreadable decimals, is refused (token_unreadable).
//
// BUYING a long-tail token also runs a sell-back simulation: right after the buy, in one more
// eth_simulateV1, everything the buy delivered is sold back to the major through a live KyberSwap
// route (no Sato fee on that leg; it is only simulated, never sent). The buy runs in one simulated
// block and the sell in the NEXT, with the chain's real prevRandao, so a token that only refuses a
// sale in the block it was bought in does not fail the test. A token that cannot be sold back, or
// whose round trip loses more than the owner's slippage and the fees allow, is refused before
// anything is signed. (A transfer fee shows up as that round-trip loss: see transfer_fee_detected.)
//
//   plan     ask Sato Hub (onchain_agent_swap, mode build-tx) for an UNSIGNED
//            transaction. Pinned token addresses, strict amounts.
//   verify   nothing is signed until ALL of these hold: Sato's signature checks
//            out and is fresh; the venue is KyberSwap and the transaction goes to
//            the pinned Kyber router; chain id 8453; value is the amount for an
//            ETH sale and 0 otherwise; Sato's own simulation says ok; the fee
//            disclosure names the pinned recipient; min_out is computed HERE;
//            the router CALLDATA is decoded and its own fields are checked (the
//            tokens, the amount, who receives the output, the minimum the router
//            itself will enforce, the fee receivers and amounts, no permit);
//            and OUR OWN simulation (eth_simulateV1 with traceTransfers) of
//            [approve, swap] from the agent's address shows the agent gives up
//            at most amount_in, receives at least min_out, and loses nothing else.
//   execute  one Base swap at a time (a lock), reserve against the owner's
//            limits, approve the exact amount to the pinned router if the
//            allowance is short, check the plan's age again right before signing
//            the swap, sign it locally with its hash recorded before broadcast,
//            wait for the receipt, read the output actually received, record it.
//
// Sato Hub's response is a SUGGESTION. Its signature proves who produced the
// bytes, not that the transaction is good for the agent; the checks that decide
// are the pinned addresses, the decoded calldata and the kit's own simulation.
// The minimum is written INTO the transaction (desc.minReturnAmount) and the kit
// checks it before signing, so a swap that would pay less than the minimum fails
// onchain instead of completing. The simulation cannot be the only guard: a pool
// can behave differently in a simulation than on the real chain.
//
// Every build-tx call writes a public record at Sato Hub (a receipt row), also
// when only a dry run is wanted. There is no way to ask for a transaction
// without one.
//
// A swap that fails before it is signed, or reverts onchain, gives its
// reservation back. A signed swap whose outcome is unknown (no receipt, a
// broadcast error) stays counted and throws Pending: do not retry.

import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isAddress, parseEventLogs, toHex } from "viem";
import { Pending, Refused, Rejected } from "../errors.js";
import { clients, signAndSend, USDC_BASE } from "../base.js";
import { loadPolicy } from "../policy.js";
import { record, release, reserve } from "../ledger.js";
import { withLock } from "../store.js";
import { callTool as satoCallTool } from "../satohub.js";
import { unitsToUsd } from "../amount.js";
import { USER_AGENT } from "../version.js";
import { FEE_CEILING_BPS, feePercent, feeTierRefusals, pairTier } from "./fee-tier.js";

// ---------------------------------------------------------------- pinned values

export const WETH_BASE = "0x4200000000000000000000000000000000000006";
/** The placeholder KyberSwap (and Sato Hub's gate) use for the chain's native coin. */
export const NATIVE_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** KyberSwap's MetaAggregationRouterV2 on Base: read from Kyber's own API (routerAddress) and checked onchain. */
export const KYBER_ROUTER_BASE = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
/** Where Sato Hub's swap fee goes (inside the venue call; there is no wrapper contract). */
export const SATO_FEE_RECIPIENT = "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9";
/**
 * The most Sato Hub's fee may ever be, on any pair: 1% (src/swap/fee-tier.js). A stable or major pair is held to 0.15%;
 * only a trade with a long-tail token may cost more. Sato Hub sets its rate within that without a kit release.
 */
export const MAX_SATO_FEE_BPS = FEE_CEILING_BPS;
/** The kit's own fee tier for a swap intent: "stable", "major" or "token". */
export const tierOf = (intent) => pairTier(intent.tokenIn.major ? intent.tokenIn.symbol : null, intent.tokenOut.major ? intent.tokenOut.symbol : null);
export const BASE_CHAIN_ID = 8453;
export const VENUE = "kyberswap";

/** The "major" assets: one side of every swap is one of these. Anything else is a long-tail token, read from the chain. */
export const TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: "USDC", name: "USD Coin", address: USDC_BASE, decimals: 6, native: false, major: true }),
  WETH: Object.freeze({ symbol: "WETH", name: "Wrapped Ether", address: WETH_BASE, decimals: 18, native: false, major: true }),
  ETH: Object.freeze({ symbol: "ETH", name: "Ether", address: NATIVE_PLACEHOLDER, decimals: 18, native: true, major: true }),
});

/** KyberSwap's public aggregator API on Base: used only to build the simulated sell-back leg (Sato Hub builds the real swap). */
export const KYBER_API_BASE = "https://aggregator-api.kyberswap.com/base/api/v1";
const KYBER_TIMEOUT_MS = 20_000;
/** The sell-back is only simulated, so it is built with a wide slippage: a revert then means the token cannot be sold, not that the price moved. The round-trip rule decides. */
const SELL_BACK_SLIPPAGE_BPS = 1000;
/** The round trip (buy, then sell everything back) may lose 2x the owner's slippage, 2x the Sato fee and this margin for pool fees and spread. */
export const ROUND_TRIP_MARGIN_BPS = 300;
/** How far below min_out Kyber's own rounding can put the minimum in the calldata when the fee is on the output (measured: 2; one unit of margin). */
const FEE_OUT_ROUNDING_UNITS = 3n;
/** A buy that delivers this much less than the swap's own reported output took a fee on transfer. */
export const TRANSFER_FEE_TOLERANCE_BPS = 10;

// The router entry point the kit decodes. Source: MetaAggregationRouterV2 at KYBER_ROUTER_BASE, verified on Sourcify
// (chain 8453, full match, 2024-08-08): swap(SwapExecutionParams) = selector 0xe21fd0e9, with
// SwapExecutionParams { callTarget, approveTarget, targetData, SwapDescriptionV2 desc, clientData } and
// SwapDescriptionV2 { srcToken, dstToken, srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[], dstReceiver,
// amount, minReturnAmount, flags, permit }. A selector this kit does not decode is refused.
export const KYBER_SWAP_SELECTOR = "0xe21fd0e9";
/** The router's own event for a completed swap (MetaAggregationRouterV2; read on a live Base swap, 2026-10-09). */
const KYBER_SWAPPED_EVENT = [
  {
    type: "event",
    name: "Swapped",
    inputs: [
      { name: "sender", type: "address", indexed: false },
      { name: "srcToken", type: "address", indexed: false },
      { name: "dstToken", type: "address", indexed: false },
      { name: "dstReceiver", type: "address", indexed: false },
      { name: "spentAmount", type: "uint256", indexed: false },
      { name: "returnAmount", type: "uint256", indexed: false },
    ],
  },
];
/** KyberSwap's executor on Base: the only `callTarget` accepted (seen on every live build). */
export const KYBER_EXECUTOR_BASE = "0x8F10B468b06c6FD214B65F87778827F7D113f996";
export const KYBER_ROUTER_ABI = Object.freeze([
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "execution",
        type: "tuple",
        components: [
          { name: "callTarget", type: "address" },
          { name: "approveTarget", type: "address" },
          { name: "targetData", type: "bytes" },
          {
            name: "desc",
            type: "tuple",
            components: [
              { name: "srcToken", type: "address" },
              { name: "dstToken", type: "address" },
              { name: "srcReceivers", type: "address[]" },
              { name: "srcAmounts", type: "uint256[]" },
              { name: "feeReceivers", type: "address[]" },
              { name: "feeAmounts", type: "uint256[]" },
              { name: "dstReceiver", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "minReturnAmount", type: "uint256" },
              { name: "flags", type: "uint256" },
              { name: "permit", type: "bytes" },
            ],
          },
          { name: "clientData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "returnAmount", type: "uint256" },
      { name: "gasUsed", type: "uint256" },
    ],
  },
]);
/**
 * desc.flags bits, from the router source (a flag is "set" when `flags & bit != 0`).
 * Kyber's live builds for these pairs carry 0x280 = IN_BPS (0x80) + 0x200; the router itself reads no 0x200 bit.
 */
export const KYBER_FLAGS = Object.freeze({
  PARTIAL_FILL: 0x01n, // the router then checks returnAmount * amount >= minReturnAmount * spent: a weaker floor
  FEE_ON_DST: 0x40n, // the fee is taken from the OUTPUT instead of the input
  FEE_IN_BPS: 0x80n, // feeAmounts are basis points of the amount, not absolute units
});
/** Every bit a build may carry: IN_BPS, plus 0x200 which Kyber sets on every live build and the router does not read. */
const KYBER_ALLOWED_FLAGS = 0x80n | 0x200n;

/** Gas limits for the kit's own simulation: generous for an exact approval and a KyberSwap route. */
const SIM_GAS_APPROVE = 100_000n;
const SIM_GAS_SWAP = 2_000_000n;
/** Gas for an approve(router, 0) sent right after our own transactions (no estimate from a possibly stale node). */
const RESET_GAS = 100_000n;

/** The swap's gas limit from our own simulation: what it used, plus half again and a fixed margin, within the simulation's cap. */
export function swapGasLimit(plan) {
  const used = plan?.simulation?.gas_used;
  const last = Array.isArray(used) && used.length ? used[used.length - 1] : null;
  const g = last !== null && /^\d+$/.test(String(last)) ? BigInt(last) : 0n;
  if (g <= 0n) return SIM_GAS_SWAP;
  const limit = (g * 3n) / 2n + 50_000n;
  return limit > SIM_GAS_SWAP ? SIM_GAS_SWAP : limit;
}

/** How long Sato's signature, and a verified plan, stay usable. Prices move; the plan is rebuilt after this. */
export const MAX_AGE_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 60_000;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

/**
 * The USD value of the swap, from the caller's independent price check. Required: without it a library
 * caller could fall back to the value the simulation shows, which a hostile response could shape.
 */
function requireUsdNotional(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`usdNotional is required for ${what}: the swap's USD value from an independent price check, as a positive number (got ${v === undefined ? "nothing" : String(v)})`);
  }
  return v;
}

const lc = (s) => String(s).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);
const explorer = (hash) => `https://basescan.org/tx/${hash}`;
const refusal = (rule, message, limit = null, observed = null) => ({ rule, limit, observed, message });

// ---------------------------------------------------------------- amounts

/** A plain positive decimal with at most `decimals` places, as base units. Never rounded. */
export function decimalToUnits(amount, decimals, label = "amount") {
  const s = String(amount);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals) {
    throw new Error(`not a ${label}: "${amount}" (a plain number with at most ${decimals} decimals, like 0.25)`);
  }
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0"));
  if (units <= 0n) throw new Error(`not a positive ${label}: "${amount}"`);
  return units;
}

/** Base units back to a plain decimal string (no trailing zeros). */
export function unitsToDecimal(units, decimals) {
  const u = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = u / base;
  const frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A non-negative integer from a decimal string, a 0x hex string, a number or a bigint; null if it is none of those. */
function uintOf(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  return null;
}

// ---------------------------------------------------------------- tokens and intent

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_DECIMALS = 36;
const bytes32TextAbi = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] }];

/** Text a token contract returns is untrusted data: one printable line, no control or direction characters, short. */
export function cleanTokenText(value, max = 48) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const majorByAddress = (a) => Object.values(TOKENS).find((t) => same(t.address, a)) ?? null;
/** A major asset from its symbol or its address, with no chain read; null if it is neither. */
function majorOf(input) {
  const raw = String(input ?? "").trim();
  if (Object.hasOwn(TOKENS, raw.toUpperCase())) return TOKENS[raw.toUpperCase()];
  return isAddress(raw, { strict: false }) ? majorByAddress(raw) : null;
}

const unreadable = (message, observed = null) => new Refused([refusal("token_unreadable", message, null, observed)]);

async function readText(pub, address, name) {
  try {
    const v = await pub.readContract({ address, abi: erc20Abi, functionName: name });
    if (typeof v === "string") return v;
  } catch {
    /* some old tokens (MKR, SAI) return bytes32: try that next */
  }
  try {
    const v = await pub.readContract({ address, abi: bytes32TextAbi(name), functionName: name });
    if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v.slice(2), "hex").toString("utf8").replace(/\0+$/g, "");
  } catch {
    /* unreadable: the caller falls back */
  }
  return null;
}

/**
 * A token on Base from its symbol (USDC, ETH, WETH) or its 0x contract address.
 * The three major assets are known without a chain read. Any other token has its decimals, symbol
 * and name READ FROM THE CHAIN here, never taken from a resolver or from Sato Hub: no code at the
 * address, or decimals that cannot be read, refuses the token (rule token_unreadable). The symbol
 * and name are the contract's own words, cleaned of control characters, and are display only.
 * Returns { address, symbol, name, decimals, native, major }.
 *
 * deps: { c (a client with .pub) | getClient }
 */
export async function resolveBaseToken(addressOrSymbol, deps = {}) {
  const raw = String(addressOrSymbol ?? "").trim();
  const known = majorOf(raw);
  if (known) return { ...known };
  if (!isAddress(raw, { strict: false })) throw new Error(`"${raw}" is not USDC, ETH, WETH or a token's 0x contract address on Base`);
  if (!isAddress(raw)) throw new Error(`"${raw}" is not a valid address: its capital letters do not match the checksum (a typo?)`);
  const address = getAddress(raw);
  if (address === ZERO_ADDRESS) throw new Error("the zero address is not a token");

  const pub = (deps.c ?? deps.getClient?.() ?? clients()).pub;
  let code;
  try {
    code = await pub.getCode({ address });
  } catch (err) {
    throw unreadable(`the token at ${address} could not be read from Base (${errText(err).slice(0, 160)}), so nothing is bought or sold`, address);
  }
  if (!code || code === "0x") throw unreadable(`there is no contract at ${address} on Base, so it is not a token this kit can swap`, address);
  let decimals;
  try {
    decimals = await pub.readContract({ address, abi: erc20Abi, functionName: "decimals" });
  } catch (err) {
    throw unreadable(`the contract at ${address} does not report its decimals (${errText(err).slice(0, 120)}), so an amount of it cannot be counted exactly`, address);
  }
  const d = typeof decimals === "bigint" ? Number(decimals) : decimals;
  if (!Number.isInteger(d) || d < 0 || d > MAX_DECIMALS) throw unreadable(`the contract at ${address} reports decimals this kit cannot use (${String(decimals).slice(0, 20)}; it accepts 0 to ${MAX_DECIMALS})`, String(decimals).slice(0, 20));
  const [symbolRaw, nameRaw] = await Promise.all([readText(pub, address, "symbol"), readText(pub, address, "name")]);
  const symbol = cleanTokenText(symbolRaw, 24) || shortAddress(address);
  const name = cleanTokenText(nameRaw, 48) || null;
  return { address, symbol, name, decimals: d, native: false, major: false };
}

/**
 * How a token is named in the plan, the approval and the ledger. A major is its symbol. EVERY other token carries its short
 * address beside its symbol ("PEPE 0x6982…1933"): a symbol is whatever the contract's creator wrote (it can look like another
 * token's, with homoglyphs or an RTL mark), the address is what the approval is really about.
 */
function labelOf(t) {
  if (t.major) return t.symbol;
  const short = shortAddress(t.address);
  return t.symbol === short ? short : `${t.symbol} ${short}`;
}

/** The intent for two resolved tokens. Throws a plain Error on bad input; nothing is sent anywhere. */
function buildIntent(tokenInRaw, tokenOutRaw, amount, slippageBps) {
  const tokenIn = { ...tokenInRaw, major: Boolean(tokenInRaw.major) };
  const tokenOut = { ...tokenOutRaw, major: Boolean(tokenOutRaw.major) };
  if (same(tokenIn.address, tokenOut.address)) throw new Error("--from and --to are the same token");
  if (tokenIn.major && tokenOut.major) {
    if (tokenIn.symbol !== "USDC" && tokenOut.symbol !== "USDC") throw new Error("only USDC <-> ETH and USDC <-> WETH swaps are supported between the main assets on Base");
  } else if (!tokenIn.major && !tokenOut.major) {
    throw new Error("one side of a swap must be USDC, ETH or WETH: a swap of one token for another token is not supported yet");
  }
  const amountIn = decimalToUnits(amount, tokenIn.decimals, `${tokenIn.symbol} amount`);
  // 500 bps is the most the owner's policy can allow; a library caller is held to the same cap.
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
    throw new Error(`slippage must be a whole number of basis points from 1 to 500 (got ${slippageBps})`);
  }
  // Which side is the long-tail token, if any. The fee is always taken on the other (major) side.
  const longTail = tokenIn.major && tokenOut.major ? null : tokenIn.major ? "out" : "in";
  return {
    from: labelOf(tokenIn),
    to: labelOf(tokenOut),
    tokenIn,
    tokenOut,
    amount: unitsToDecimal(amountIn, tokenIn.decimals),
    amountIn,
    slippageBps,
    longTail,
    /** Where the Sato Hub fee is expected: on the input when buying a long-tail token (and between majors), on the output when selling one. */
    feeSide: longTail === "in" ? "out" : "in",
  };
}

/**
 * Validate what the owner asked for, with no chain read: `from` / `to` are USDC, ETH, WETH (or their
 * addresses), or tokens already resolved by resolveBaseToken. A bare token address needs resolveIntent.
 */
export function parseIntent({ from, to, amount, slippageBps }) {
  const side = (v, label) => {
    if (v && typeof v === "object" && typeof v.address === "string" && Number.isInteger(v.decimals)) return v;
    const t = majorOf(v);
    if (t) return t;
    if (isAddress(String(v ?? "").trim(), { strict: false })) throw new Error(`${label}: a token address must be resolved first (resolveBaseToken / resolveIntent)`);
    throw new Error(`${label}: "${v}" is not supported on Base (USDC, ETH, WETH or a token's 0x contract address)`);
  };
  return buildIntent(side(from, "--from"), side(to, "--to"), amount, slippageBps);
}

/** parseIntent for any token: addresses are resolved (decimals, symbol, name read from the chain) first. */
export async function resolveIntent({ from, to, amount, slippageBps }, deps = {}) {
  const resolve = async (v, label) => {
    if (v && typeof v === "object" && typeof v.address === "string" && Number.isInteger(v.decimals)) return v;
    try {
      return await resolveBaseToken(v, deps);
    } catch (err) {
      if (err instanceof Refused || !(err instanceof Error)) throw err;
      throw new Error(`${label}: ${err.message}`);
    }
  };
  const tokenIn = await resolve(from, "--from");
  const tokenOut = await resolve(to, "--to");
  return buildIntent(tokenIn, tokenOut, amount, slippageBps);
}

// ---------------------------------------------------------------- plan

function takerOf(deps, getClient) {
  const t = deps.taker ?? getClient().account.address;
  if (!isAddress(t, { strict: false })) throw new Error(`not a Base address: ${t}`);
  return getAddress(t);
}

/**
 * Ask Sato Hub for an unsigned swap transaction. WRITES A PUBLIC RECORD there
 * (see the top of this file). Returns the signed response untouched, plus the
 * validated intent; nothing is trusted yet: pass both to verifyBaseSwapPlan.
 *
 * deps: { taker, usdNotional, callTool, c }
 */
export async function planBaseSwap({ from, to, amount, slippageBps }, deps = {}) {
  let client;
  const getClient = () => (client ??= deps.c ?? clients());
  // A token address is read from the chain here (decimals, symbol, name); Sato Hub is not asked yet.
  const intent = await resolveIntent({ from, to, amount, slippageBps }, { ...deps, getClient });
  intent.taker = takerOf(deps, getClient);
  // The USD value the caller already knows. For a USDC sale it is the amount itself.
  const known = intent.tokenIn.symbol === "USDC" ? unitsToUsd(intent.amountIn) : deps.usdNotional;
  intent.usd_hint = Number.isFinite(known) && known > 0 ? known : null;

  const args = {
    mode: "build-tx",
    chain_in: "Base",
    chain_out: "Base",
    token_in: intent.tokenIn.address,
    token_out: intent.tokenOut.address,
    amount_in: intent.amountIn.toString(),
    taker: intent.taker,
    slippage_bps: intent.slippageBps,
    // Ask Sato Hub for KyberSwap only: it is the one router this kit decodes. Sato Hub then never
    // answers with another venue, and says so by name if KyberSwap cannot quote. (A Sato Hub that
    // predates the pin ignores the field; the venue check below still refuses anything else.)
    venue: VENUE,
    response_format: "json",
    ...(intent.usd_hint !== null ? { usd_notional: intent.usd_hint } : {}),
    // No `recipient`: Sato only gate-checks it and no venue honours it. The output goes to the taker.
  };
  const call = deps.callTool ?? satoCallTool;
  const r = await call("onchain_agent_swap", args);
  let response = r.structured;
  if (!response && r.text) {
    try {
      response = JSON.parse(r.text);
    } catch {
      response = null;
    }
  }
  if (r.isError || !response || typeof response !== "object") {
    throw new Error(`Sato Hub did not return a swap quote${r.text ? `: ${String(r.text).slice(0, 300)}` : ""}`);
  }
  return { response, intent };
}

// ---------------------------------------------------------------- verify: signature + static checks

async function defaultVerifySignature(response) {
  let mod;
  try {
    mod = await import("../hub-signature.js");
  } catch {
    throw new Refused([refusal("signature_unverified", "this kit has no Sato Hub signature check available, so the response cannot be checked")]);
  }
  return mod.verifyHubSignature(response);
}

async function checkSignature(response, deps, now) {
  const sig = response?.meta?.signature;
  if (!sig || typeof sig !== "object") {
    throw new Refused([refusal("signature_unverified", "the response from Sato Hub is not signed, and an unsigned transaction is never signed by this kit")]);
  }
  let outcome;
  try {
    outcome = await (deps.verifySignature ?? defaultVerifySignature)(response);
  } catch (err) {
    if (err instanceof Refused) throw err;
    throw new Refused([refusal("signature_unverified", `the Sato Hub signature check could not complete (${err.message})`)]);
  }
  const ok = outcome === true || outcome?.ok === true;
  if (!ok) {
    throw new Refused([refusal("signature_unverified", `the Sato Hub signature does not match the response${outcome?.why ? ` (${outcome.why})` : ""}`, null, sig.kid ?? null)]);
  }
  const signedAt = Date.parse(sig.signed_at);
  const maxAge = deps.maxAgeMs ?? MAX_AGE_MS;
  if (!Number.isFinite(signedAt) || now - signedAt > maxAge || signedAt - now > MAX_FUTURE_SKEW_MS) {
    throw new Refused([refusal("signature_stale", "the response was not signed within the last two minutes; ask again", `${maxAge / 1000}s`, sig.signed_at ?? null)]);
  }
  return { kid: sig.kid ?? null, signed_at: sig.signed_at };
}

/** Everything about the response that can be checked without the network. Returns the facts the plan keeps. */
function staticChecks(response, intent) {
  const out = [];
  const tx = response.tx;

  if (response.mode !== "build-tx") out.push(refusal("response_mismatch", "the response is not a build-tx answer", "build-tx", response.mode ?? null));
  if (!same(response.token_in, intent.tokenIn.address)) out.push(refusal("response_mismatch", "the response is about a different input token than the one asked for", intent.tokenIn.address, response.token_in ?? null));
  if (!same(response.token_out, intent.tokenOut.address)) out.push(refusal("response_mismatch", "the response is about a different output token than the one asked for", intent.tokenOut.address, response.token_out ?? null));
  if (String(response.amount_in) !== intent.amountIn.toString()) out.push(refusal("response_mismatch", "the response is about a different amount than the one asked for", intent.amountIn.toString(), response.amount_in ?? null));
  if (typeof response.chain !== "string" || lc(response.chain) !== "base") out.push(refusal("chain_not_base", "the response is not for Base", "base", response.chain ?? null));

  if (!tx || typeof tx !== "object") {
    out.push(refusal("tx_withheld", `Sato Hub returned no transaction${response.withheld?.reason ? `: ${String(response.withheld.reason).slice(0, 300)}` : ""}`, null, response.withheld?.rule ?? null));
    return { refusals: out };
  }

  // (b) the venue and the contract the transaction goes to
  if (response.venue !== VENUE) out.push(refusal("router_not_pinned", `only ${VENUE} is accepted as the venue`, VENUE, response.venue ?? null));
  if (!same(tx.to, KYBER_ROUTER_BASE)) out.push(refusal("router_not_pinned", "the transaction does not go to the pinned KyberSwap router", KYBER_ROUTER_BASE, tx.to ?? null));
  if (tx.approval_target != null && !same(tx.approval_target, KYBER_ROUTER_BASE)) out.push(refusal("router_not_pinned", "Sato Hub names a different contract to approve than the pinned router", KYBER_ROUTER_BASE, tx.approval_target));
  // (c)
  if (Number(tx.chain_id) !== BASE_CHAIN_ID) out.push(refusal("chain_not_base", "the transaction is not for Base (chain id 8453)", BASE_CHAIN_ID, tx.chain_id ?? null));
  // (d)
  const value = tx.value == null ? 0n : uintOf(tx.value);
  const wantValue = intent.tokenIn.native ? intent.amountIn : 0n;
  if (value === null || value !== wantValue) out.push(refusal("value_mismatch", intent.tokenIn.native ? "the ETH sent with the transaction must equal the amount sold" : "an ERC-20 sale must send no ETH", wantValue.toString(), tx.value ?? null));
  if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2}){4,}$/.test(tx.data)) out.push(refusal("response_mismatch", "the transaction has no calldata", null, null));

  // (e)
  if (response.simulation?.ok !== true) {
    out.push(refusal("simulation_not_ok", "Sato Hub's own simulation did not report ok; this kit requires it", true, response.simulation?.ok ?? null));
  }

  // (f) the fee disclosure
  const feeBps = response.sato_fee_bps;
  const feeDisclosed = typeof feeBps === "number" && Number.isInteger(feeBps) && feeBps >= 0 && typeof response.sato_fee_recipient === "string" && typeof response.disclosure === "string" && response.disclosure.trim() !== "";
  if (!feeDisclosed) {
    out.push(refusal("fee_disclosure_missing", "the response does not state the Sato Hub fee (rate, recipient and sentence)"));
  } else {
    if (!same(response.sato_fee_recipient, SATO_FEE_RECIPIENT)) out.push(refusal("fee_recipient_not_pinned", "the fee goes to an address this kit does not know", SATO_FEE_RECIPIENT, response.sato_fee_recipient));
    // The tiered ceilings (src/swap/fee-tier.js): at most 1% on any pair, at most 0.15% unless a long-tail token is traded,
    // and a disclosed tier must match the kit's own reading of the pair.
    out.push(...feeTierRefusals({ bps: feeBps, tier: tierOf(intent), disclosedTier: response.sato_fee_tier }));
  }

  // (f2) which side the fee is taken on. Sato Hub discloses it (`sato_fee_side`); an answer that does not is read as the
  // side the kit expects (the input when buying a long-tail token, the output when selling one). Either way it must be the
  // major side: the fee is never taken in the long-tail token.
  let feeSide = intent.feeSide ?? "in";
  let feeSideDisclosed = false;
  const sideField = response.sato_fee_side;
  if (sideField !== undefined && sideField !== null) {
    if (sideField !== "in" && sideField !== "out") {
      out.push(refusal("fee_disclosure_missing", 'the fee side Sato Hub disclosed is neither "in" nor "out"', '"in" or "out"', String(sideField).slice(0, 20)));
    } else {
      feeSide = sideField;
      feeSideDisclosed = true;
      const feeToken = feeSide === "in" ? intent.tokenIn : intent.tokenOut;
      if (!feeToken.major) out.push(refusal("fee_side_not_major", `Sato Hub's fee would be taken in ${labelOf(feeToken)}, not in USDC or ETH; this kit only accepts the fee on the USDC / ETH side`, intent.feeSide, feeSide));
    }
  }

  // (g) min_out is ours: the quote, less the owner's slippage
  const quoted = uintOf(response.amount_out);
  let minOut = null;
  if (quoted === null || quoted <= 0n) out.push(refusal("min_out_invalid", "the quoted output is missing or zero", null, response.amount_out ?? null));
  else {
    minOut = (quoted * BigInt(10_000 - intent.slippageBps)) / 10_000n;
    if (minOut <= 0n) out.push(refusal("min_out_invalid", "the minimum output works out to zero", null, quoted.toString()));
  }

  // (h) the router calldata: what the contract itself will do, decoded, not what the response says it does
  let calldata = null;
  if (typeof tx.data === "string" && /^0x([0-9a-fA-F]{2}){4,}$/.test(tx.data)) {
    const checked = checkRouterCalldata(tx.data, { intent, minOut: minOut !== null && minOut > 0n ? minOut : null, feeBps: feeDisclosed ? feeBps : null, feeSide, feeSideInferred: !feeSideDisclosed });
    out.push(...checked.refusals);
    calldata = checked.facts;
  }
  return { refusals: out, facts: { value: value ?? 0n, quoted, minOut, calldata, feeSide, feeSideDisclosed, market: marketOf(response) } };
}

/**
 * The route's own market figures, if Sato Hub's answer carries them: Kyber's route summary has amountInUsd,
 * amountOutUsd and (on some chains) priceImpact. Passed through for display; nothing is enforced here. Never
 * invented: a field that is absent or not a finite number is null (unknown is not zero), and the gap between the two
 * USD figures is only computed when both are there. (Kyber's route summary on Base carries no priceImpact; the USD gap
 * includes the pool fees, Sato's fee and gas, so it is a value gap, not a pure price impact.)
 */
export function marketOf(response) {
  const num = (v) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  // Sato Hub's real shape (app lib/route/adapters/types.ts QuotePriceImpact), at the top of its answer:
  //   price_impact: { reported_bps, usd_value_gap_bps, amount_in_usd, amount_out_usd, source }
  // reported_bps is the venue's own price-impact figure (null for KyberSwap); usd_value_gap_bps is the gap between the
  // venue's USD valuations of the input and the output, in basis points (fees included). Both are null when unknown.
  const pi = response?.price_impact && typeof response.price_impact === "object" && !Array.isArray(response.price_impact) ? response.price_impact : null;
  const bpsToPct = (v) => (num(v) === null ? null : Math.round(num(v) * 100) / 10_000);
  // Older shapes stay as fallbacks (a flat answer, or the route summary carried through).
  const homes = [pi, response, response?.route_summary, response?.routeSummary, response?.route, response?.quote, response?.market].filter((h) => h && typeof h === "object");
  const pick = (...keys) => {
    for (const h of homes) for (const k of keys) if (num(h[k]) !== null) return num(h[k]);
    return null;
  };
  const priceImpactPct = pi && num(pi.reported_bps) !== null ? bpsToPct(pi.reported_bps) : pick("price_impact_pct", "price_impact", "priceImpact");
  const amountInUsd = pick("amount_in_usd", "amountInUsd");
  const amountOutUsd = pick("amount_out_usd", "amountOutUsd");
  const reportedGap = pi && num(pi.usd_value_gap_bps) !== null ? bpsToPct(pi.usd_value_gap_bps) : null;
  const computedGap = amountInUsd !== null && amountOutUsd !== null && amountInUsd > 0 ? Math.round(((amountInUsd - amountOutUsd) / amountInUsd) * 10_000) / 100 : null;
  const gap = reportedGap ?? computedGap;
  if (priceImpactPct === null && gap === null && amountInUsd === null && amountOutUsd === null) return null;
  return { price_impact_pct: priceImpactPct, amount_in_usd: amountInUsd, amount_out_usd: amountOutUsd, value_gap_pct: gap, source: "Sato Hub's answer (the KyberSwap route summary)" };
}

/**
 * The smallest minReturnAmount the kit accepts in the calldata for a given min_out. Kyber builds from its own
 * re-quote of the route, which is one base unit below the route quote in every live build we recorded, and then
 * floors; so its floor is min_out or min_out - 1. The kit's min_out is floor(quote * (10000 - slippage) / 10000);
 * a calldata floor below min_out - 1 is not Kyber rounding, it is a weaker minimum than the owner's slippage allows.
 *
 * With the fee on the OUTPUT (selling a long-tail token) Kyber's re-quote is two units below the route quote, not one
 * (it rounds the fee as well): 18 of 18 live builds on 2026-10-09, in USDC and in ETH, at 1 to 500 bps of slippage.
 * The quote itself is the amount AFTER the fee, and the router checks its minimum against the amount after the fee too,
 * so min_out needs no adjustment for the fee, only that wider rounding allowance (3 units of USDC or ETH).
 */
export function requiredCalldataMin(minOut, tolerance = 1n) {
  const r = minOut - tolerance;
  return r > 1n ? r : 1n;
}

/**
 * Decode the transaction data sent to the pinned router and check the fields the router acts on.
 * Returns { refusals, facts }. Anything this kit cannot decode, or that does not re-encode to the
 * same bytes (so the decoder and the contract could read it differently), is refused whole.
 */
export function checkRouterCalldata(data, { intent, minOut, feeBps, feeSide = "in", feeSideInferred = false }) {
  const out = [];
  const unrecognized = (why) => ({ refusals: [refusal("calldata_unrecognized", `the transaction calls the router in a way this kit does not read (${why}), so it will not sign it`, KYBER_SWAP_SELECTOR, String(data).slice(0, 10))], facts: null });
  if (String(data).slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) return unrecognized("it is not the router's swap function");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data });
    const again = encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: "swap", args: decoded.args });
    if (lc(again) !== lc(data)) return unrecognized("its encoding is not the standard one");
  } catch {
    return unrecognized("it does not decode");
  }
  const d = decoded.args[0].desc;
  // The contract the router hands the input to. The router does not restrict it, so the kit does:
  // only Kyber's own executor (every live build on 2026-10-09, 66 of 66). A rotated executor is
  // refused until the kit is updated, never followed.
  if (!same(decoded.args[0].callTarget, KYBER_EXECUTOR_BASE)) out.push(refusal("executor_not_pinned", "the swap hands the tokens to a contract that is not KyberSwap's executor; update the kit if KyberSwap changed it", KYBER_EXECUTOR_BASE, decoded.args[0].callTarget));

  if (!same(d.srcToken, intent.tokenIn.address)) out.push(refusal("calldata_mismatch", `the transaction sells a different token than ${intent.tokenIn.symbol}`, intent.tokenIn.address, d.srcToken));
  if (!same(d.dstToken, intent.tokenOut.address)) out.push(refusal("calldata_mismatch", `the transaction buys a different token than ${intent.tokenOut.symbol}`, intent.tokenOut.address, d.dstToken));
  if (d.amount !== intent.amountIn) out.push(refusal("calldata_mismatch", "the transaction sells a different amount than the one asked for", intent.amountIn.toString(), d.amount.toString()));
  if (!same(d.dstReceiver, intent.taker)) out.push(refusal("recipient_not_taker", "the transaction sends the bought tokens to an address that is not the agent's wallet", intent.taker, d.dstReceiver));
  if (d.permit !== "0x") out.push(refusal("calldata_mismatch", "the transaction carries a token permit, which this kit does not allow", "0x", String(d.permit).slice(0, 74)));

  // the minimum the router itself enforces
  const flags = d.flags;
  if (minOut !== null) {
    // Kyber's rounding depends on where the fee is taken, which the calldata itself says (a disclosure that disagrees is refused below).
    const need = requiredCalldataMin(minOut, (flags & KYBER_FLAGS.FEE_ON_DST) !== 0n ? FEE_OUT_ROUNDING_UNITS : 1n);
    if (d.minReturnAmount < need) out.push(refusal("min_out_not_enforced", `the transaction itself would accept less ${intent.tokenOut.symbol} than the minimum, so it would not stop a worse price`, need.toString(), d.minReturnAmount.toString()));
  }
  if ((flags & KYBER_FLAGS.PARTIAL_FILL) !== 0n) out.push(refusal("min_out_not_enforced", "the transaction allows a partial fill, which weakens the router's own minimum", "0", flags.toString()));
  if ((flags & ~(KYBER_ALLOWED_FLAGS | KYBER_FLAGS.FEE_ON_DST | KYBER_FLAGS.PARTIAL_FILL)) !== 0n) out.push(refusal("calldata_mismatch", "the transaction sets router options this kit does not know", `0x${KYBER_ALLOWED_FLAGS.toString(16)}`, `0x${flags.toString(16)}`));

  // the fee: exactly the one disclosed receiver and rate, in bps, on the disclosed side (the input, or with FEE_ON_DST the output)
  if (feeBps !== null) {
    const receivers = d.feeReceivers;
    const amounts = d.feeAmounts;
    if (feeBps === 0) {
      if (receivers.length !== 0 || amounts.length !== 0) out.push(refusal("fee_not_as_disclosed", "the response says there is no fee, but the transaction pays fee receivers", "none", receivers.join(",")));
    } else {
      if (receivers.length !== 1 || !same(receivers[0], SATO_FEE_RECIPIENT)) out.push(refusal("fee_not_as_disclosed", "the transaction pays fee receivers other than the one Sato Hub disclosed", SATO_FEE_RECIPIENT, receivers.join(",") || "none"));
      else if (amounts.length !== 1 || amounts[0] !== BigInt(feeBps)) out.push(refusal("fee_not_as_disclosed", "the transaction takes a fee rate other than the one Sato Hub disclosed", `${feeBps} bps`, amounts.map(String).join(",") || "none"));
      if ((flags & KYBER_FLAGS.FEE_IN_BPS) === 0n) out.push(refusal("fee_not_as_disclosed", "the transaction does not count its fee in basis points, so the fee amount would be read differently", "in bps", `flags 0x${flags.toString(16)}`));
    }
    // which side the router takes the fee from: FEE_ON_DST = the output, otherwise the input. It must be the disclosed (or expected) side.
    const takenFromOutput = (flags & KYBER_FLAGS.FEE_ON_DST) !== 0n;
    if (takenFromOutput !== (feeSide === "out")) {
      const actualToken = takenFromOutput ? intent.tokenOut : intent.tokenIn;
      // Nothing was disclosed and the transaction takes the fee in a long-tail token: that is the major-side rule, not a disclosure mismatch.
      const rule = feeSideInferred && !actualToken.major ? "fee_side_not_major" : "fee_not_as_disclosed";
      const where = takenFromOutput ? "from the tokens bought instead of the tokens sold" : "from the tokens sold instead of the tokens bought";
      out.push(refusal(rule, `the transaction takes its fee ${where}${actualToken.major ? "" : `, so in ${labelOf(actualToken)}, not in USDC or ETH`}`, feeSide === "out" ? "taken from the output (FEE_ON_DST)" : "taken from the input", `flags 0x${flags.toString(16)}`));
    }
  }
  return {
    refusals: out,
    facts: { min_return_amount: d.minReturnAmount, flags, dst_receiver: getAddress(d.dstReceiver), fee_receivers: d.feeReceivers.map((a) => getAddress(a)), fee_amounts: [...d.feeAmounts], amount: d.amount },
  };
}

// ---------------------------------------------------------------- verify: the kit's own simulation

/**
 * The eth_simulateV1 parameters for [approve?, swap] from the agent, against the latest block.
 *
 * With `baseFeePerGas` the simulated block carries the real chain's base fee and every call carries a
 * real-looking fee (maxFeePerGas, maxPriorityFeePerGas), so `block.basefee == 0` and `tx.gasprice == 0`
 * cannot tell a pool that this is a simulation. (eth_simulateV1 runs with a zero base fee by default.)
 *
 * Also realistic when the caller has the latest block's facts:
 *   - `prevRandao` (the latest block's mixHash; on Base it is the L1 randomness) goes in the block overrides, so
 *     `block.prevrandao == 0` cannot tell a token that this is a simulation either;
 *   - `blockNumber` / `timestamp` (the latest block's) give the simulated blocks real, later numbers and times:
 *     the first block is the next one, the second LATER_BLOCK[1] on (Base makes a block every 2 s). Gaps of minutes
 *     were tried and dropped: some routes' quotes expire within them (refusing ordinary tokens) and anvil forks reject
 *     them. A sale blocked by a longer time lock is not caught (the README says so).
 *   - `splitAt`: calls from that index on go in a SECOND simulated block (eth_simulateV1 carries state from one
 *     block to the next). The sell-back test uses it: the buy in one block, the approve and the sell in the next, so a
 *     token that refuses to be sold in the block it was bought in (a common honeypot trick) does not fail the test.
 */
/** How far past the block that was read each simulated block sits: the buy in the next block, the sell-back in the one after. */
export const LATER_BLOCK = Object.freeze([Object.freeze({ blocks: 1, seconds: 2 }), Object.freeze({ blocks: 2, seconds: 4 })]);

export function buildSimulationRequest({ taker, calls, baseFeePerGas, maxPriorityFeePerGas, prevRandao, blockNumber, timestamp, splitAt }) {
  const realistic = typeof baseFeePerGas === "bigint" && baseFeePerGas > 0n;
  const tip = typeof maxPriorityFeePerGas === "bigint" && maxPriorityFeePerGas >= 0n ? maxPriorityFeePerGas : 0n;
  const fees = realistic ? { maxFeePerGas: toHex((baseFeePerGas * 12n) / 10n + tip), maxPriorityFeePerGas: toHex(tip) } : {};
  const randao = typeof prevRandao === "string" && /^0x[0-9a-fA-F]{64}$/.test(prevRandao) && !/^0x0{64}$/.test(prevRandao) ? prevRandao : null;
  const timed = typeof blockNumber === "bigint" && typeof timestamp === "bigint";
  const encode = (c) => ({ from: taker, to: c.to, data: c.data, ...(c.value ? { value: toHex(c.value) } : {}), ...(c.gas ? { gas: toHex(c.gas) } : {}), ...fees });
  const overrides = (k) => ({
    ...(realistic ? { baseFeePerGas: toHex(baseFeePerGas) } : {}),
    ...(randao ? { prevRandao: randao } : {}),
    ...(timed ? { number: toHex(blockNumber + BigInt(LATER_BLOCK[k].blocks)), time: toHex(timestamp + BigInt(LATER_BLOCK[k].seconds)) } : {}),
  });
  const withOverrides = (k) => (Object.keys(overrides(k)).length ? { blockOverrides: overrides(k) } : {});
  const split = Number.isInteger(splitAt) && splitAt > 0 && splitAt < calls.length ? splitAt : null;
  const groups = split === null ? [calls] : [calls.slice(0, split), calls.slice(split)];
  return [
    {
      blockStateCalls: groups.map((g, i) => ({ ...withOverrides(i), calls: g.map(encode) })),
      traceTransfers: true,
      validation: false,
    },
    // A load-balanced node that moved on between the read and this call rejects number = read+1 as out of order
    // (-38020); defaultSimulate reads again and retries (a block tag of the read block is not accepted by every node).
    "latest",
  ];
}

/** The latest block's facts and a priority fee, read from the node the swap will be sent through. */
async function simulationFees(c) {
  const block = await c.pub.getBlock({ blockTag: "latest" });
  const baseFeePerGas = block?.baseFeePerGas;
  if (typeof baseFeePerGas !== "bigint" || baseFeePerGas <= 0n) throw new Error("the latest block has no base fee to simulate with");
  let tip = 1_000_000n; // 0.001 gwei: Base's usual tip, if the node cannot say
  try {
    const t = await c.pub.estimateMaxPriorityFeePerGas();
    if (typeof t === "bigint" && t >= 0n) tip = t;
  } catch {
    /* keep the fallback */
  }
  return {
    baseFeePerGas,
    maxPriorityFeePerGas: tip,
    prevRandao: block.mixHash ?? undefined,
    blockNumber: typeof block.number === "bigint" ? block.number : undefined,
    timestamp: typeof block.timestamp === "bigint" ? block.timestamp : undefined,
  };
}

export async function defaultSimulate({ taker, calls, splitAt, c }) {
  // Up to SIMULATE_TRIES times, each on a fresh read: the node behind a public load balancer may have moved past the
  // block that was read (Base makes one every 2 s), which fails the simulated block numbers as out of order. A last
  // failure is the caller's simulation_unavailable.
  let last;
  for (let i = 0; i < SIMULATE_TRIES; i++) {
    try {
      const fees = await simulationFees(c);
      return await c.pub.request({ method: "eth_simulateV1", params: buildSimulationRequest({ taker, calls, splitAt, ...fees }) });
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
const SIMULATE_TRIES = 3;

function revertNote(call) {
  const msg = call?.error?.message ?? call?.error?.data ?? null;
  if (msg) return String(msg).slice(0, 200);
  const rd = call?.returnData;
  // Error(string): 0x08c379a0 + offset + length + text
  if (typeof rd === "string" && rd.startsWith("0x08c379a0") && rd.length >= 138) {
    try {
      const len = Number(BigInt(`0x${rd.slice(74, 138)}`));
      return Buffer.from(rd.slice(138, 138 + len * 2), "hex").toString("utf8").slice(0, 200);
    } catch {
      /* fall through */
    }
  }
  return typeof rd === "string" && rd !== "0x" ? rd.slice(0, 74) : "no reason given";
}

/**
 * The agent's net change per asset from traced Transfer logs. Native ETH appears
 * as Transfer logs from the pseudo-address 0xeeee…eeee. `leaves` lists anything
 * non-fungible (ERC-721 / ERC-1155) that left the agent: those cannot be netted.
 * `received[recipient][asset]` is what each address got, for the fee check.
 */
export function assetDeltas(calls, taker) {
  const me = lc(taker);
  const deltas = new Map();
  const received = new Map();
  const leaves = [];
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + v);
  const word = (t) => `0x${String(t).slice(-40).toLowerCase()}`;
  for (const call of calls) {
    for (const log of call.logs ?? []) {
      const topics = log.topics ?? [];
      const asset = lc(log.address);
      if (topics[0] === TRANSFER_TOPIC && topics.length === 3) {
        const value = uintOf(log.data) ?? 0n;
        const from = word(topics[1]);
        const to = word(topics[2]);
        if (from === me) add(deltas, asset, -value);
        if (to === me) add(deltas, asset, value);
        if (!received.has(to)) received.set(to, new Map());
        add(received.get(to), asset, value);
      } else if (topics[0] === TRANSFER_TOPIC && topics.length === 4) {
        if (word(topics[1]) === me) leaves.push({ asset, kind: "ERC-721", id: topics[3] });
      } else if (topics[0] === TRANSFER_SINGLE_TOPIC && topics.length === 4 && word(topics[2]) === me) {
        leaves.push({ asset, kind: "ERC-1155" });
      } else if (topics[0] === TRANSFER_BATCH_TOPIC && topics.length === 4 && word(topics[2]) === me) {
        leaves.push({ asset, kind: "ERC-1155" });
      }
    }
  }
  return { deltas, received, leaves };
}

const assetKey = (token) => lc(token.address);

/** The calls the swap itself sends: an exact approval when the allowance is short, then the swap. Each gets a gas limit. */
function swapCalls({ intent, facts, tx, approvalNeeded }) {
  // Each simulated call gets a gas limit. With real fees in the simulation the node checks the
  // wallet can pay gas x fee, and with no limit it assumes a whole block's gas (about 0.003 ETH
  // on 2026-10-09), which a wallet funded with a little ETH for gas does not hold.
  const calls = [];
  if (approvalNeeded) {
    calls.push({ to: intent.tokenIn.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, intent.amountIn] }), value: 0n, gas: SIM_GAS_APPROVE });
  }
  calls.push({ to: getAddress(tx.to), data: tx.data, value: facts.value, gas: SIM_GAS_SWAP });
  return calls;
}

/** Run calls through the kit's own eth_simulateV1 (or the injected one). Refuses, never guesses, when it cannot run or be read. */
async function runSimulation({ intent, calls, splitAt, deps, getClient }) {
  let raw;
  try {
    // `splitAt`: the calls from that index on run in a second simulated block (see buildSimulationRequest). An injected
    // simulate() gets the same flat list and the same hint, and may answer with one block or two.
    raw = await (deps.simulate ?? defaultSimulate)({ taker: intent.taker, calls, ...(splitAt !== undefined ? { splitAt } : {}), c: deps.simulate ? deps.c : getClient() });
  } catch (err) {
    const why = String(err.details || err.shortMessage || err.message);
    if (/insufficient funds/i.test(why)) {
      throw new Refused([refusal("not_enough_eth", `the wallet does not hold enough ETH on Base for this swap's gas${intent.tokenIn.native ? " and the ETH being sold" : ""}; add a little ETH on Base and try again (nothing was signed)`, null, why.slice(0, 160))]);
    }
    throw new Refused([refusal("simulation_unavailable", `this kit's own simulation could not run (${why.slice(0, 200)}); it never signs without one`)]);
  }
  // One entry per simulated block, calls in order across the blocks.
  const blocks = Array.isArray(raw) ? raw : [raw];
  const got = blocks.every((b) => Array.isArray(b?.calls)) ? blocks.flatMap((b) => b.calls) : null;
  if (!Array.isArray(got) || got.length !== calls.length) {
    throw new Refused([refusal("simulation_unavailable", "this kit's own simulation returned an answer it cannot read; it never signs without one")]);
  }
  return got;
}

const callOk = (c) => c.status === "0x1" || c.status === 1 || c.status === "0x01";

/** The router's own Swapped event for this swap (receiver = the agent, the expected output token), or null if it is not exactly one. */
function swappedOf(call, intent) {
  try {
    const events = parseEventLogs({ abi: KYBER_SWAPPED_EVENT, logs: call.logs ?? [], eventName: "Swapped" }).filter(
      (l) => same(l.address, KYBER_ROUTER_BASE) && same(l.args.dstReceiver, intent.taker) && same(l.args.dstToken, intent.tokenOut.address),
    );
    return events.length === 1 ? events[0].args : null;
  } catch {
    return null;
  }
}

async function simulateAndCheck({ intent, facts, tx, approvalNeeded, deps, getClient }) {
  const calls = swapCalls({ intent, facts, tx, approvalNeeded });
  const got = await runSimulation({ intent, calls, deps, getClient });
  for (let i = 0; i < got.length; i++) {
    if (!callOk(got[i])) {
      throw new Refused([refusal("simulation_failed", `${i === calls.length - 1 ? "the swap" : "the approval"} would fail: ${revertNote(got[i])}`, null, got[i].status ?? null)]);
    }
  }

  const { deltas, received, leaves } = assetDeltas(got, intent.taker);
  const inKey = assetKey(intent.tokenIn);
  const outKey = assetKey(intent.tokenOut);
  const out = [];
  const inDelta = deltas.get(inKey) ?? 0n;
  const outDelta = deltas.get(outKey) ?? 0n;
  if (-inDelta > intent.amountIn) out.push(refusal("outflow_exceeds_amount_in", `the swap would take more ${intent.tokenIn.symbol} than the amount asked for`, intent.amountIn.toString(), (-inDelta).toString()));
  if (outDelta < facts.minOut) out.push(refusal("output_below_min_out", `the swap would deliver less ${intent.tokenOut.symbol} than the minimum`, facts.minOut.toString(), outDelta.toString()));
  for (const [asset, delta] of deltas) {
    if (asset !== inKey && asset !== outKey && delta < 0n) out.push(refusal("other_token_leaves", `the swap would also take ${asset === lc(NATIVE_PLACEHOLDER) ? "ETH" : asset} from the wallet`, "0", delta.toString()));
  }
  for (const l of leaves) out.push(refusal("other_token_leaves", `the swap would move an ${l.kind} token out of the wallet`, null, l.asset));

  // The disclosed fee is taken inside the venue call, on the disclosed side; what the fee address actually receives can't exceed it.
  //   side "in":  at most bps of the amount sold.
  //   side "out": the router takes bps of the GROSS output and pays the rest to the agent, so the agent's
  //               net output N and the fee F satisfy F <= (N + F) * bps / 10000, i.e. F <= N * bps / (10000 - bps).
  const feeBps = BigInt(facts.feeBps);
  const feeKey = facts.feeSide === "out" ? outKey : inKey;
  const ceiling = facts.feeSide === "out" ? (outDelta * feeBps) / (10_000n - feeBps) + 1n : (intent.amountIn * feeBps + 9_999n) / 10_000n;
  const feeSeen = received.get(lc(SATO_FEE_RECIPIENT))?.get(feeKey) ?? 0n;
  if (feeSeen > ceiling) out.push(refusal("fee_exceeds_disclosed", "the fee address would receive more than the disclosed rate", ceiling.toString(), feeSeen.toString()));

  // A fee on transfer: the router reports what it paid out (its Swapped event); a token that keeps part of every
  // transfer delivers less than that to the agent. Only checked when buying a long-tail token.
  // CAVEAT (review, 2026-10-09): against the real router this cannot fire. MetaAggregationRouterV2 measures `returnAmount` as the
  // receiver's balance change, AFTER the token's own fee, so the event and the agent's balance agree. The check is kept as a cheap
  // consistency test (an injected or different router could disagree), and the kit does not claim to detect transfer fees with it;
  // what the sell-back round trip loses is what shows a fee, as a loss against the allowed band.
  let reportedOut = null;
  if (intent.longTail === "out") {
    const swapped = swappedOf(got[got.length - 1], intent);
    if (swapped) {
      reportedOut = swapped.returnAmount;
      const slack = (reportedOut * BigInt(TRANSFER_FEE_TOLERANCE_BPS)) / 10_000n + 2n;
      if (outDelta + slack < reportedOut) {
        out.push(refusal("transfer_fee_detected", `the swap pays out ${unitsToDecimal(reportedOut, intent.tokenOut.decimals)} ${intent.to} but only ${unitsToDecimal(outDelta, intent.tokenOut.decimals)} reaches the wallet: the token keeps part of every transfer`, `at least ${reportedOut.toString()}`, outDelta.toString()));
      }
    }
  }
  if (out.length) throw new Refused(out);

  return {
    source: deps.simulate ? "injected" : "eth_simulateV1",
    calls: got.length,
    gas_used: got.map((c) => String(uintOf(c.gasUsed) ?? "")),
    in_delta: inDelta,
    out_delta: outDelta,
    fee_seen: feeSeen,
    reported_out: reportedOut,
    deltas: Object.fromEntries([...deltas].map(([k, v]) => [k, v])),
  };
}

// ---------------------------------------------------------------- the sell-back simulation (buying a long-tail token)

/** Why the sell-back leg could not be built: kind "no_route" (KyberSwap has no way to sell the token) or "unavailable" (its API did not answer). */
export class SellBackError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "SellBackError";
    this.kind = kind;
  }
}

/**
 * A live KyberSwap route and build for selling `amountIn` of `tokenIn` for `tokenOut` from `taker`, with NO Sato fee
 * (this leg is only ever simulated, never sent). Straight to KyberSwap's public API, not through Sato Hub: Sato Hub's
 * build-tx writes a public record and this is a check, not a trade. Its answer is held to the same calldata rules as
 * the real swap before it is simulated.
 */
export async function buildKyberSellBack({ tokenIn, tokenOut, amountIn, taker, slippageBps = SELL_BACK_SLIPPAGE_BPS }, deps = {}) {
  const f = deps.kyberFetch ?? fetch;
  const base = deps.kyberApi ?? KYBER_API_BASE;
  const headers = { "user-agent": USER_AGENT, "x-client-id": "satohub", accept: "application/json" };
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const call = async (what, url, init = {}) => {
    let res;
    // One retry after a pause when KyberSwap's public API says "slow down" (429): the route and the build are two calls in a row.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await f(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(KYBER_TIMEOUT_MS) });
      } catch (err) {
        throw new SellBackError("unavailable", `KyberSwap's API did not answer for the ${what} (${errText(err).slice(0, 100)})`);
      }
      if (res.status === 429 && attempt === 0) {
        await sleep(1500);
        continue;
      }
      break;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* handled below */
    }
    if (res.status === 429 || res.status >= 500) throw new SellBackError("unavailable", `KyberSwap's API answered ${res.status} for the ${what}`);
    if (!body || typeof body !== "object") throw new SellBackError("unavailable", `KyberSwap's API gave an answer the kit cannot read for the ${what}`);
    if (body.code !== 0 || !body.data) throw new SellBackError("no_route", `KyberSwap has no ${what}${body.message ? `: ${String(body.message).slice(0, 120)}` : ""}`);
    return body.data;
  };
  const q = new URLSearchParams({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountIn.toString() });
  const routeData = await call("route to sell it back", `${base}/routes?${q}`);
  const summary = routeData.routeSummary;
  if (!summary || typeof summary !== "object") throw new SellBackError("no_route", "KyberSwap returned no route to sell it back");
  const built = await call("build of the sell-back", `${base}/route/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: summary, sender: taker, recipient: taker, slippageTolerance: slippageBps, source: "satohub" }),
  });
  return {
    to: built.routerAddress,
    data: built.data,
    value: uintOf(built.transactionValue ?? "0"),
    quoted_out: summary.amountOut != null ? String(summary.amountOut) : null,
    route_id: summary.routeID != null ? String(summary.routeID) : null,
  };
}

/**
 * What KyberSwap's public route API says `amountIn` of `tokenIn` returns in `tokenOut` right now (base units, a bigint), or
 * null when it has no answer. Straight to KyberSwap, not through Sato Hub: Sato Hub's build-tx writes a public record, and this
 * is only used to size a token sale against the owner's limits BEFORE Sato Hub is asked (run.js). It is advisory; the
 * quote Sato Hub gives is sized and checked again afterwards.
 */
export async function kyberPublicOut({ tokenIn, tokenOut, amountIn }, deps = {}) {
  const f = deps.kyberFetch ?? fetch;
  const q = new URLSearchParams({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountIn.toString() });
  try {
    const res = await f(`${deps.kyberApi ?? KYBER_API_BASE}/routes?${q}`, { headers: { "user-agent": USER_AGENT, "x-client-id": "satohub", accept: "application/json" }, signal: AbortSignal.timeout(KYBER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    const out = uintOf(body?.data?.routeSummary?.amountOut);
    return out !== null && out > 0n ? out : null;
  } catch {
    return null;
  }
}

const sellBackRefusal = (message, observed = null) => new Refused([refusal("cannot_sell_back", message, null, observed)]);

/**
 * Sell back what a purchase of a long-tail token delivers, in ONE more eth_simulateV1 that repeats the buy and then sells
 * the amount the buy delivered (measured in the first simulation) back to the major asset through a live KyberSwap route
 * (pinned router, an exact approval of the token, no Sato fee). Refuses (cannot_sell_back) when no route exists, when the
 * approval or the sell would fail, or when the round trip returns less than amount_in * (1 - 2 x slippage - 2 x fee - 3%).
 * The sell is never sent and costs no gas; the only cost is one more simulation and a KyberSwap route + build.
 */
async function sellBackCheck({ intent, facts, tx, approvalNeeded, sim, deps, getClient }) {
  const major = intent.tokenIn;
  const token = intent.tokenOut;
  const build = deps.buildSellBack ?? ((args) => buildKyberSellBack(args, deps));
  const baseCalls = swapCalls({ intent, facts, tx, approvalNeeded });
  const majorKey = assetKey(major);
  const tokenKey = assetKey(token);
  const feeBps = BigInt(facts.feeBps);
  const allowedLossBps = BigInt(2 * intent.slippageBps) + 2n * feeBps + BigInt(ROUND_TRIP_MARGIN_BPS);
  const minReturn = (intent.amountIn * (10_000n - allowedLossBps)) / 10_000n;

  let units = sim.out_delta;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (units <= 0n) throw sellBackRefusal(`the swap delivers no ${token.symbol} to sell back`);
    let built;
    try {
      built = await build({ tokenIn: token, tokenOut: major, amountIn: units, taker: intent.taker, slippageBps: SELL_BACK_SLIPPAGE_BPS });
    } catch (err) {
      if (err instanceof Refused) throw err;
      if (err instanceof SellBackError && err.kind === "no_route") throw sellBackRefusal(`${intent.to} cannot be sold back: ${err.message}. The kit does not buy a token it cannot test selling.`, "no_route");
      throw new Refused([refusal("sell_back_unavailable", `the kit could not check that ${intent.to} can be sold back (${errText(err).slice(0, 200)}); it does not buy a token it cannot test selling`)]);
    }
    if (!built || typeof built.data !== "string" || !/^0x([0-9a-fA-F]{2}){4,}$/.test(built.data)) throw new Refused([refusal("sell_back_unavailable", "the sell-back route came back without transaction data; the kit does not buy a token it cannot test selling")]);
    if (!same(built.to, KYBER_ROUTER_BASE)) throw new Refused([refusal("router_not_pinned", "the sell-back route names a contract other than the pinned KyberSwap router", KYBER_ROUTER_BASE, built.to ?? null)]);
    if (built.value !== undefined && built.value !== null && built.value !== 0n) throw new Refused([refusal("value_mismatch", "selling a token back must send no ETH", "0", String(built.value))]);

    // The sell-back transaction gets the real swap's calldata rules: pinned executor, the agent as receiver, the right tokens
    // and amount, no permit, and NO fee receivers (this leg carries no Sato fee).
    const sellIntent = { from: intent.to, to: intent.from, tokenIn: token, tokenOut: major, amountIn: units, taker: intent.taker };
    const checked = checkRouterCalldata(built.data, { intent: sellIntent, minOut: null, feeBps: 0, feeSide: "in" });
    if (checked.refusals.length) throw new Refused(checked.refusals.map((r) => ({ ...r, message: `in the sell-back route: ${r.message}` })));

    const approveToken = { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, units] }), value: 0n, gas: SIM_GAS_APPROVE };
    const sell = { to: KYBER_ROUTER_BASE, data: built.data, value: 0n, gas: SIM_GAS_SWAP };
    const calls = [...baseCalls, approveToken, sell];
    // The buy (and its approval) in one block, the token's approval and the sell in the NEXT one.
    const got = await runSimulation({ intent, calls, splitAt: baseCalls.length, deps, getClient });
    const n = baseCalls.length;
    for (let i = 0; i < n; i++) {
      if (!callOk(got[i])) throw new Refused([refusal("simulation_failed", `${i === n - 1 ? "the swap" : "the approval"} would fail when repeated for the sell-back check: ${revertNote(got[i])}`, null, got[i].status ?? null)]);
    }
    const bought = assetDeltas(got.slice(0, n), intent.taker).deltas.get(tokenKey) ?? 0n;
    if (!callOk(got[n])) throw sellBackRefusal(`${intent.to} cannot be sold back: it will not let the router spend it (the approval would fail: ${revertNote(got[n])})`, "approve_reverts");
    if (!callOk(got[n + 1])) {
      // The second run bought a little less than the first and the sell asked for more than it holds: measure again, once.
      if (attempt === 0 && bought > 0n && bought < units) {
        units = bought;
        continue;
      }
      throw sellBackRefusal(
        `${intent.to} cannot be sold back: selling what this swap delivers would fail (${revertNote(got[n + 1])}). A token that blocks selling in the same block it was bought in looks the same to this check.`,
        "sell_reverts",
      );
    }

    const leg = assetDeltas([got[n + 1]], intent.taker);
    const out = [];
    for (const [asset, delta] of leg.deltas) {
      if (asset !== majorKey && asset !== tokenKey && delta < 0n) out.push(refusal("other_token_leaves", `the sell-back would also take ${asset === lc(NATIVE_PLACEHOLDER) ? "ETH" : asset} from the wallet`, "0", delta.toString()));
    }
    for (const l of leg.leaves) out.push(refusal("other_token_leaves", `the sell-back would move an ${l.kind} token out of the wallet`, null, l.asset));
    const tokenSold = -(leg.deltas.get(tokenKey) ?? 0n);
    if (tokenSold > units) out.push(refusal("outflow_exceeds_amount_in", `the sell-back would take more ${token.symbol} than it was asked to sell`, units.toString(), tokenSold.toString()));
    if (out.length) throw new Refused(out);

    const returned = leg.deltas.get(majorKey) ?? 0n;
    const lossBps = Number(((intent.amountIn - returned) * 10_000n) / intent.amountIn);
    if (returned < minReturn) {
      const d = (u) => unitsToDecimal(u, major.decimals);
      throw sellBackRefusal(
        `buying ${intent.to} and selling it straight back returns ${d(returned)} ${major.symbol} for ${d(intent.amountIn)} ${major.symbol}, a loss of ${(lossBps / 100).toFixed(2)}%; the most this kit allows is ${(Number(allowedLossBps) / 100).toFixed(2)}% (twice the slippage, twice the Sato fee and ${ROUND_TRIP_MARGIN_BPS / 100}% for spread). The token may be hard to sell or take a fee on selling.`,
        `${lossBps} bps`,
      );
    }
    return {
      checked: true,
      source: "KyberSwap route, eth_simulateV1",
      sold_units: units,
      returned_units: returned,
      asset: intent.from,
      amount_in_units: intent.amountIn,
      loss_bps: lossBps,
      allowed_loss_bps: Number(allowedLossBps),
      minimum_return_units: minReturn,
      quoted_return: built.quoted_out ?? null,
      route_id: built.route_id ?? null,
      gas_used: { approve: String(uintOf(got[n].gasUsed) ?? ""), sell: String(uintOf(got[n + 1].gasUsed) ?? "") },
      attempts: attempt + 1,
    };
  }
  throw sellBackRefusal(`${intent.to} could not be sold back in the simulation`);
}

// ---------------------------------------------------------------- verify

const VERIFIED = new WeakSet();

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

async function readAllowance({ token, owner, spender, deps, getClient }) {
  if (deps.readAllowance) return deps.readAllowance({ token, owner, spender });
  return getClient().pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

/**
 * Check a Sato Hub swap response against the intent, then simulate it ourselves.
 * Throws Refused (with rule ids) unless every check passes; nothing is signed or
 * reserved here. Returns the verified plan, frozen. executeBaseSwap only accepts
 * a plan that came out of this function.
 *
 * deps: { verifySignature, simulate, readAllowance, c, now, maxAgeMs, usdNotional }
 */
export async function verifyBaseSwapPlan(response, intent, deps = {}) {
  let client;
  const getClient = () => (client ??= deps.c ?? clients());
  const now = deps.now ?? Date.now();

  if (!response || typeof response !== "object") throw new Refused([refusal("response_mismatch", "no response to check")]);
  const signature = await checkSignature(response, deps, now);

  if (response.unavailable) {
    throw new Refused([refusal("tx_withheld", `Sato Hub found no route${Array.isArray(response.tried) ? ` (tried ${response.tried.length} venue${response.tried.length === 1 ? "" : "s"})` : ""}`)]);
  }
  const { refusals, facts } = staticChecks(response, intent);
  if (refusals.length) throw new Refused(refusals);
  facts.feeBps = response.sato_fee_bps;

  const tx = response.tx;
  let allowance = null;
  if (!intent.tokenIn.native) {
    try {
      allowance = await readAllowance({ token: intent.tokenIn.address, owner: intent.taker, spender: KYBER_ROUTER_BASE, deps, getClient });
    } catch (err) {
      throw new Refused([refusal("simulation_unavailable", `the allowance could not be read (${String(err.shortMessage || err.message).slice(0, 200)}), so nothing can be simulated`)]);
    }
  }
  const approvalNeeded = !intent.tokenIn.native && allowance < intent.amountIn;

  const sim = await simulateAndCheck({ intent, facts, tx, approvalNeeded, deps, getClient });

  // Buying a long-tail token: sell everything it delivers straight back, in one more simulation. Refuses a token that
  // cannot be sold, or one whose round trip loses too much (the sell-back is run in a second simulated block).
  const sellBack = intent.longTail === "out" ? await sellBackCheck({ intent, facts, tx, approvalNeeded, sim, deps, getClient }) : null;

  // What counts against the owner's limits: the USDC leg, measured. A USDC sale is the amount itself;
  // an ETH sale is the USDC the kit's own simulation shows coming back, or the caller's figure if higher.
  // USDC is the real USDC contract, never a token that calls itself USDC. When neither side is USDC (ETH or WETH
  // against a long-tail token) there is no USDC leg to measure: the caller's independent figure is the value.
  const feeOut = facts.feeSide === "out";
  const isUsdc = (t) => same(t.address, USDC_BASE);
  const usdcLeg = isUsdc(intent.tokenIn) ? intent.amountIn : isUsdc(intent.tokenOut) ? sim.out_delta + (feeOut ? sim.fee_seen : 0n) : 0n;
  const measured = unitsToUsd(usdcLeg);
  const claimed = Number.isFinite(deps.usdNotional) && deps.usdNotional > 0 ? deps.usdNotional : 0;
  const usd = Math.max(measured, claimed);
  // The major side's amount as the simulation measured it (fee included on a sale), for the caller's own pricing of an ETH leg.
  const majorLeg = intent.longTail === null ? null : intent.longTail === "out" ? { asset: intent.from, units: intent.amountIn } : { asset: intent.to, units: sim.out_delta + (feeOut ? sim.fee_seen : 0n) };

  const plan = deepFreeze({
    verified: true,
    verified_at: new Date(now).toISOString(),
    verified_at_ms: now,
    chain: "base",
    chain_id: BASE_CHAIN_ID,
    venue: VENUE,
    route_id: response.route_id ?? null,
    receipt_url: response.receipt_url ?? null,
    gate: response.gate?.verdict ?? null,
    from: intent.from,
    to: intent.to,
    token_in: { ...intent.tokenIn },
    token_out: { ...intent.tokenOut },
    taker: intent.taker,
    amount_in: intent.amountIn,
    quoted_out: facts.quoted,
    min_out: facts.minOut,
    /** What the router itself will enforce, as decoded from the transaction (Kyber's rounding: 1 base unit under min_out, 2 when the fee is on the output). */
    min_out_in_transaction: facts.calldata.min_return_amount,
    slippage_bps: intent.slippageBps,
    usd,
    router: getAddress(tx.to),
    tx: { to: getAddress(tx.to), data: tx.data, value: facts.value, gas_hint: uintOf(tx.gas) },
    approval: { needed: approvalNeeded, token: intent.tokenIn.native ? null : intent.tokenIn.address, spender: KYBER_ROUTER_BASE, amount: intent.amountIn, allowance_before: allowance },
    fee: { bps: response.sato_fee_bps, tier: tierOf(intent), recipient: getAddress(response.sato_fee_recipient), disclosure: response.disclosure, side: facts.feeSide, side_disclosed: facts.feeSideDisclosed, seen_in_simulation: sim.fee_seen },
    /** Which side is the long-tail token: "in" (selling it), "out" (buying it) or null (USDC <-> ETH/WETH). */
    long_tail: intent.longTail,
    major_leg: majorLeg,
    /** The route's own market figures, if Sato Hub's answer carries them (for display; not enforced here). */
    market: facts.market,
    /** The sell-back simulation (buying a long-tail token only): what selling the purchase straight back returned. */
    sell_back: sellBack,
    simulation: sim,
    signature,
  });
  VERIFIED.add(plan);
  return plan;
}

/** Plan with Sato Hub, then verify. What the CLI calls for both a real swap and a dry run. */
export async function planAndVerifyBaseSwap(args, deps = {}) {
  // Before Sato Hub is asked: that call writes a public record. The one exception is selling a long-tail token for
  // USDC or ETH: its USD value is not known until the quote (there is no independent price for the token), so the
  // caller says so with `usdFromQuote` and sizes the trade from the major leg afterwards (src/swap/run.js). No USD
  // hint is then sent to Sato Hub, and executeBaseSwap still requires the caller's figure to sign.
  if (!deps.usdFromQuote) requireUsdNotional(deps.usdNotional, "planning a swap");
  const { response, intent } = await planBaseSwap(args, deps);
  return verifyBaseSwapPlan(response, intent, deps);
}

/** A JSON-safe, display-ready view of a verified plan (no bigints). Safe to print and to put in an approval intent. */
export function summarizeBaseSwapPlan(plan) {
  const d = (units, token) => unitsToDecimal(units, token.decimals);
  return {
    chain: "base",
    venue: plan.venue,
    route_id: plan.route_id,
    receipt_url: plan.receipt_url,
    // `address`, `name` and `decimals` come from the chain (a long-tail token) and are display data; the symbol is the contract's own word.
    sell: { asset: plan.from, address: plan.token_in.address, name: plan.token_in.name ?? null, amount: d(plan.amount_in, plan.token_in) },
    buy: {
      asset: plan.to,
      address: plan.token_out.address,
      name: plan.token_out.name ?? null,
      quoted: d(plan.quoted_out, plan.token_out),
      minimum: d(plan.min_out, plan.token_out),
      minimum_in_transaction: plan.min_out_in_transaction === undefined ? null : d(plan.min_out_in_transaction, plan.token_out),
      slippage_bps: plan.slippage_bps,
    },
    usd: plan.usd,
    router: plan.router,
    approval: plan.approval.needed ? { token: plan.from, address: plan.approval.token, spender: plan.approval.spender, amount: d(plan.approval.amount, plan.token_in), exact: true } : null,
    // `side`: where the fee is taken, "in" (from what is sold) or "out" (from what is received). Always the USDC / ETH side.
    sato_fee: { bps: plan.fee.bps, tier: plan.fee.tier ?? null, percent: feePercent(plan.fee.bps), recipient: plan.fee.recipient, disclosure: plan.fee.disclosure, side: plan.fee.side ?? "in", asset: (plan.fee.side ?? "in") === "out" ? plan.to : plan.from },
    long_tail: plan.long_tail ? { side: plan.long_tail, role: plan.long_tail === "out" ? "buying" : "selling", asset: plan.long_tail === "out" ? plan.to : plan.from, address: (plan.long_tail === "out" ? plan.token_out : plan.token_in).address } : null,
    market: plan.market ?? null,
    sell_back: plan.sell_back
      ? {
          checked: true,
          sold: d(plan.sell_back.sold_units, plan.token_out),
          returned: d(plan.sell_back.returned_units, plan.token_in),
          asset: plan.sell_back.asset,
          loss_bps: plan.sell_back.loss_bps,
          allowed_loss_bps: plan.sell_back.allowed_loss_bps,
          route_id: plan.sell_back.route_id,
          simulated_only: true,
        }
      : null,
    simulation: {
      source: plan.simulation.source,
      sell_leaves: d(-plan.simulation.in_delta, plan.token_in),
      buy_arrives: d(plan.simulation.out_delta, plan.token_out),
    },
  };
}

/** Plan + verify (every check, including the kit's own simulation); nothing reserved or signed. Still writes a Sato Hub record. */
export async function dryRunBaseSwap(args, deps = {}) {
  const plan = await planAndVerifyBaseSwap(args, deps);
  return { dry_run: true, simulated: true, ...summarizeBaseSwapPlan(plan) };
}

// ---------------------------------------------------------------- execute

const approveData = (amount) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, amount] });
const errText = (err) => String(err?.shortMessage || err?.message || err);

/**
 * What the agent received, and how that was read: { units, basis } or null.
 * - a token: its Transfer logs in the receipt ("receipt_logs");
 * - native ETH (no Transfer log): the pinned router's own Swapped event in the receipt
 *   ("router_event"), when it names the agent as receiver; otherwise the balance change
 *   at the receipt's block ("balance_change"). The balance read needs a node that has
 *   that block, which a load-balanced public RPC may not right away (live, 2026-10-09).
 */
async function measureOutput({ plan, receipt, c }) {
  const me = lc(plan.taker);
  if (!plan.token_out.native) {
    try {
      const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter((l) => same(l.address, plan.token_out.address));
      return { units: logs.reduce((sum, l) => sum + (lc(l.args.to) === me ? l.args.value : 0n) - (lc(l.args.from) === me ? l.args.value : 0n), 0n), basis: "receipt_logs" };
    } catch {
      return null;
    }
  }
  try {
    const swapped = parseEventLogs({ abi: KYBER_SWAPPED_EVENT, logs: receipt.logs, eventName: "Swapped" }).filter(
      (l) => same(l.address, KYBER_ROUTER_BASE) && same(l.args.dstReceiver, plan.taker) && same(l.args.dstToken, plan.token_out.address),
    );
    if (swapped.length === 1) return { units: swapped[0].args.returnAmount, basis: "router_event" };
  } catch {
    /* fall through to the balance change */
  }
  try {
    const [after, beforeBlock] = await Promise.all([
      c.pub.getBalance({ address: plan.taker, blockNumber: receipt.blockNumber }),
      c.pub.getBalance({ address: plan.taker, blockNumber: receipt.blockNumber - 1n }),
    ]);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
    return { units: after - beforeBlock + gas, basis: "balance_change" };
  } catch {
    return null;
  }
}

/**
 * Sign and send a verified plan under the owner's limits.
 *
 * Order, and what each failure does to the reservation:
 *   reserve (Refused: nothing reserved) -> approve (exact amount, pinned router, only if short)
 *   -> swap, hash recorded before broadcast -> receipt -> read the output -> record.
 * Pending (unknown outcome) keeps the spend counted. Any other failure before the
 * swap is signed, a definite node rejection, or a revert gives it back.
 *
 * An approval WE granted is never left behind: if the swap then fails for good (or
 * leaves allowance unspent), the allowance is set back to 0 (gas only, not counted)
 * and the outcome is recorded; if that reset itself fails the ledger row says the
 * allowance is still open, how much, and to whom. After an unknown swap outcome the
 * allowance is left alone, because the swap may still land and use it.
 *
 * The whole sequence runs under one lock ("base-swap"), so two swaps never interleave
 * (one's exact approval overwriting the other's, or one's reset cancelling the other's).
 * The plan's age is checked when the lock is taken AND again right before the swap is
 * signed (the approval wait can be long): a plan that has aged out by then is refused
 * with plan_expired, nothing is spent and the approval is set back to 0.
 *
 * deps: { c, policy, readAllowance, now, clock, maxAgeMs, lockWaitMs, usdNotional (required) }
 */
export async function executeBaseSwap(plan, deps = {}) {
  if (!plan || !VERIFIED.has(plan)) throw new Refused([refusal("plan_not_verified", "only a plan that passed verifyBaseSwapPlan can be signed")]);
  const usdNotional = requireUsdNotional(deps.usdNotional, "signing a swap");
  return withLock(() => executeLocked(plan, { ...deps, usdNotional }), { name: "base-swap", waitMs: deps.lockWaitMs ?? 120_000 });
}

async function executeLocked(plan, deps) {
  const clock = deps.clock ?? (() => deps.now ?? Date.now());
  const maxAge = deps.maxAgeMs ?? MAX_AGE_MS;
  const now = clock();
  if (now - plan.verified_at_ms > maxAge) {
    throw new Refused([refusal("plan_stale", "the checked plan is more than two minutes old; plan it again", "120s", plan.verified_at)]);
  }
  const c = deps.c ?? clients();
  if (!same(c.account.address, plan.taker)) throw new Refused([refusal("taker_mismatch", "the plan was built for a different wallet than the one signing", plan.taker, c.account.address)]);
  // The larger of what verify measured and the caller's independent figure is what counts against the limits.
  const usd = Math.max(plan.usd, deps.usdNotional);
  if (!(usd > 0)) throw new Refused([refusal("usd_unknown", "the swap's USD value is unknown, so it cannot be held to the limits")]);

  const display = (units, token) => unitsToDecimal(units, token.decimals);
  const entry = await reserve(deps.policy ?? loadPolicy(), {
    kind: "swap",
    chain: "base",
    usd,
    to: plan.router,
    venue: plan.venue,
    asset_in: plan.from,
    asset_out: plan.to,
    amount_in: display(plan.amount_in, plan.token_in),
    amount_in_units: plan.amount_in.toString(),
    min_out: display(plan.min_out, plan.token_out),
    min_out_units: plan.min_out.toString(),
    slippage_bps: plan.slippage_bps, // held to the owner's cap again, under the lock
    route_id: plan.route_id,
    sato_fee_bps: plan.fee.bps,
    sato_fee_recipient: plan.fee.recipient,
    sato_fee_side: plan.fee.side ?? "in",
    // The token contracts, so a row never rests on a symbol alone (a long-tail token can call itself anything).
    token_in: plan.token_in.address,
    token_out: plan.token_out.address,
    ...(plan.long_tail ? { long_tail: plan.long_tail } : {}),
    ...(plan.sell_back ? { sell_back_loss_bps: plan.sell_back.loss_bps } : {}),
  });

  let approveTx = null;
  let approvedHere = false;
  // After our approval lands, the transactions that follow it take the next nonces we already
  // know. A public RPC is load-balanced: right after a block it can answer from a node that has
  // not seen the approval yet (nonce, allowance and gas estimates all stale). Seen live 2026-10-09:
  // the swap's gas estimate reverted with TRANSFER_FROM_FAILED and the swap was never sent.
  let nextNonce;
  const reader = (token = plan.token_in.address) => readAllowance({ token, owner: plan.taker, spender: KYBER_ROUTER_BASE, deps, getClient: () => c });

  /**
   * Put an allowance WE granted back to 0. Never throws: the ledger row says what happened.
   * `force`: the swap did not use it, so it is reset without reading it first (a stale read
   * says 0 and would leave the approval open).
   */
  const resetAllowance = async ({ force = false } = {}) => {
    let left = null;
    try {
      if (force) left = plan.amount_in; // what we granted; a swap that failed or never went out pulled nothing
      else {
        left = await reader();
        if (left === 0n) return { state: "none_left" };
      }
      const r = await signAndSend(
        c,
        { to: plan.token_in.address, data: approveData(0n), ...(nextNonce !== undefined ? { nonce: nextNonce, gas: RESET_GAS } : {}) },
        (hash) => record({ id: entry.id, allowance: "reset_signed", allowance_tx: hash, allowance_spender: KYBER_ROUTER_BASE }),
        { counted: false },
      );
      if (r.status !== "success") throw new Error(`the reset reverted: ${explorer(r.transactionHash)}`);
      record({ id: entry.id, allowance: "reset", allowance_tx: r.transactionHash, allowance_spender: KYBER_ROUTER_BASE });
      return { state: "reset", tx: r.transactionHash };
    } catch (err) {
      record({ id: entry.id, allowance: "left_open", allowance_left_units: left === null ? null : left.toString(), allowance_spender: KYBER_ROUTER_BASE, allowance_token: plan.token_in.address, allowance_error: errText(err) });
      return { state: "left_open", amount: left, error: errText(err) };
    }
  };
  const withNote = (err, a) => {
    if (a?.state === "reset") err.message += `\nThe ${plan.from} approval granted for this swap was set back to 0 (${explorer(a.tx)}).`;
    else if (a?.state === "left_open") err.message += `\nThe ${plan.from} approval granted for this swap could not be set back to 0 (${a.error}). The pinned KyberSwap router may still spend up to ${a.amount === null ? plan.amount_in : a.amount} base units of ${plan.from}; the owner can reset it with an approve(router, 0) transaction.`;
    return err;
  };

  // --- approval (exact amount, pinned router, only when the allowance is short)
  let current = plan.token_in.native ? null : undefined;
  if (current === undefined) {
    try {
      current = await reader();
    } catch (err) {
      release(entry, "failed before signing", { error: errText(err) });
      throw err;
    }
  }
  if (current !== null && current < plan.amount_in) {
    let r;
    try {
      r = await signAndSend(c, { to: plan.token_in.address, data: approveData(plan.amount_in) }, (hash) => {
        approveTx = hash;
        record({ id: entry.id, status: "approval_signed", step: "approve", tx: hash, approve_tx: hash });
      });
    } catch (err) {
      if (!(err instanceof Pending)) release(entry, err instanceof Rejected ? "approval rejected; never landed" : "failed before broadcast", { error: errText(err) });
      throw err;
    }
    if (r.status !== "success") {
      release(entry, "approval reverted onchain", { tx: r.transactionHash });
      throw new Error(`the approval reverted: ${explorer(r.transactionHash)}`);
    }
    approvedHere = true;
    if (Number.isInteger(r.sentNonce)) nextNonce = r.sentNonce + 1;
    record({ id: entry.id, status: "approved", step: "approve", approve_tx: r.transactionHash });
  }

  // --- the swap
  // The approval wait can take a while. Prices move, so the plan's age is checked again right before signing.
  const ageNow = clock();
  if (ageNow - plan.verified_at_ms > maxAge) {
    release(entry, "plan expired before the swap was signed", { plan_verified_at: plan.verified_at });
    const expired = new Refused([refusal("plan_expired", "the checked plan became more than two minutes old while the approval was going through, so the swap was not signed; plan it again", "120s", plan.verified_at)]);
    throw approvedHere ? withNote(expired, await resetAllowance({ force: true })) : expired;
  }
  // Right after our own approval, the swap takes the next nonce and the gas our simulation measured,
  // so nothing depends on a node that may not have seen the approval yet.
  const afterApproval = nextNonce !== undefined ? { nonce: nextNonce, gas: swapGasLimit(plan) } : {};
  let receipt;
  try {
    receipt = await signAndSend(c, { to: plan.tx.to, data: plan.tx.data, value: plan.tx.value, ...afterApproval }, (hash) => record({ id: entry.id, status: "signed", step: "swap", tx: hash }));
  } catch (err) {
    if (err instanceof Pending) throw err; // may still land: stays counted, allowance untouched
    release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: errText(err) });
    throw approvedHere ? withNote(err, await resetAllowance({ force: true })) : err;
  }
  if (nextNonce !== undefined) nextNonce += 1; // the swap used it, whatever its outcome
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    const err = new Error(`transaction reverted: ${explorer(receipt.transactionHash)}`);
    throw approvedHere ? withNote(err, await resetAllowance({ force: true })) : err;
  }

  // --- the receipt: what actually arrived
  const warnings = [];
  const measured = await measureOutput({ plan, receipt, c });
  const outUnits = measured?.units ?? null;
  // ERC-20: exact, from the receipt's Transfer logs. ETH: exact, from the router's Swapped event; only when that is
  // missing, the balance change with the receipt's gas and L1 fee added back (close, but it can read slightly low).
  const outBasis = measured?.basis ?? null;
  if (outUnits === null) warnings.push("could not read the amount received from the receipt");
  else if (outUnits < plan.min_out) warnings.push(`received ${display(outUnits, plan.token_out)} ${plan.to}, below the minimum of ${display(plan.min_out, plan.token_out)}`);
  record({
    id: entry.id,
    status: "confirmed",
    tx: receipt.transactionHash,
    amount_out: outUnits === null ? null : display(outUnits, plan.token_out),
    amount_out_units: outUnits === null ? null : outUnits.toString(),
    amount_out_basis: outUnits === null ? null : outBasis,
    route_id: plan.route_id,
    receipt_url: plan.receipt_url,
    ...(approveTx ? { approve_tx: approveTx } : {}),
    ...(warnings.length ? { warnings } : {}),
  });

  let allowance = null;
  if (approvedHere) {
    allowance = await resetAllowance(); // none_left in the normal case; resets what the router did not spend
    if (allowance.state === "left_open") warnings.push(`an approval of ${plan.from} to the router is still open: ${allowance.error}`);
  }
  return {
    tx: receipt.transactionHash,
    explorer: explorer(receipt.transactionHash),
    approve_tx: approveTx,
    route_id: plan.route_id,
    receipt_url: plan.receipt_url,
    sold: { asset: plan.from, amount: display(plan.amount_in, plan.token_in) },
    received: outUnits === null ? null : { asset: plan.to, amount: display(outUnits, plan.token_out), basis: outBasis },
    minimum: { asset: plan.to, amount: display(plan.min_out, plan.token_out) },
    usd,
    sato_fee: { bps: plan.fee.bps, recipient: plan.fee.recipient, side: plan.fee.side ?? "in" },
    allowance: allowance?.state ?? null,
    warnings,
  };
}
