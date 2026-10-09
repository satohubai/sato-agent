// Swaps on Base between USDC and ETH / WETH, through Sato Hub's swap tool.
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

// ---------------------------------------------------------------- pinned values

export const WETH_BASE = "0x4200000000000000000000000000000000000006";
/** The placeholder KyberSwap (and Sato Hub's gate) use for the chain's native coin. */
export const NATIVE_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** KyberSwap's MetaAggregationRouterV2 on Base: read from Kyber's own API (routerAddress) and checked onchain. */
export const KYBER_ROUTER_BASE = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
/** Where Sato Hub's swap fee goes (inside the venue call; there is no wrapper contract). */
export const SATO_FEE_RECIPIENT = "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9";
/** Sato Hub's published schedule is 3 bps (stable pairs) and 15 bps (anything volatile). Higher is refused until a kit release says otherwise. */
export const MAX_SATO_FEE_BPS = 15;
export const BASE_CHAIN_ID = 8453;
export const VENUE = "kyberswap";

export const TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: "USDC", address: USDC_BASE, decimals: 6, native: false }),
  WETH: Object.freeze({ symbol: "WETH", address: WETH_BASE, decimals: 18, native: false }),
  ETH: Object.freeze({ symbol: "ETH", address: NATIVE_PLACEHOLDER, decimals: 18, native: true }),
});

// The router entry point the kit decodes. Source: MetaAggregationRouterV2 at KYBER_ROUTER_BASE, verified on Sourcify
// (chain 8453, full match, 2024-08-08): swap(SwapExecutionParams) = selector 0xe21fd0e9, with
// SwapExecutionParams { callTarget, approveTarget, targetData, SwapDescriptionV2 desc, clientData } and
// SwapDescriptionV2 { srcToken, dstToken, srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[], dstReceiver,
// amount, minReturnAmount, flags, permit }. A selector this kit does not decode is refused.
export const KYBER_SWAP_SELECTOR = "0xe21fd0e9";
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

// ---------------------------------------------------------------- intent

function resolveSide(symbol, label) {
  const t = TOKENS[String(symbol ?? "").toUpperCase()];
  if (!t) throw new Error(`${label}: "${symbol}" is not supported on Base (USDC, ETH or WETH)`);
  return t;
}

/** Validate what the owner asked for. Throws a plain Error on bad input; nothing is sent anywhere. */
export function parseIntent({ from, to, amount, slippageBps }) {
  const tokenIn = resolveSide(from, "--from");
  const tokenOut = resolveSide(to, "--to");
  if (tokenIn.symbol === tokenOut.symbol) throw new Error("--from and --to are the same token");
  if (tokenIn.symbol !== "USDC" && tokenOut.symbol !== "USDC") throw new Error("only USDC <-> ETH and USDC <-> WETH swaps are supported on Base");
  const amountIn = decimalToUnits(amount, tokenIn.decimals, `${tokenIn.symbol} amount`);
  // 500 bps is the most the owner's policy can allow; a library caller is held to the same cap.
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
    throw new Error(`slippage must be a whole number of basis points from 1 to 500 (got ${slippageBps})`);
  }
  return { from: tokenIn.symbol, to: tokenOut.symbol, tokenIn, tokenOut, amount: unitsToDecimal(amountIn, tokenIn.decimals), amountIn, slippageBps };
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
  const intent = parseIntent({ from, to, amount, slippageBps });
  let client;
  const getClient = () => (client ??= deps.c ?? clients());
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
    if (feeBps > MAX_SATO_FEE_BPS) out.push(refusal("fee_over_ceiling", `the fee rate is above the ${MAX_SATO_FEE_BPS} bps this kit release accepts`, MAX_SATO_FEE_BPS, feeBps));
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
    const checked = checkRouterCalldata(tx.data, { intent, minOut: minOut !== null && minOut > 0n ? minOut : null, feeBps: feeDisclosed ? feeBps : null });
    out.push(...checked.refusals);
    calldata = checked.facts;
  }
  return { refusals: out, facts: { value: value ?? 0n, quoted, minOut, calldata } };
}

/**
 * The smallest minReturnAmount the kit accepts in the calldata for a given min_out. Kyber builds from its own
 * re-quote of the route, which is one base unit below the route quote in every live build we recorded, and then
 * floors; so its floor is min_out or min_out - 1. The kit's min_out is floor(quote * (10000 - slippage) / 10000);
 * a calldata floor below min_out - 1 is not Kyber rounding, it is a weaker minimum than the owner's slippage allows.
 */
export function requiredCalldataMin(minOut) {
  const r = minOut - 1n;
  return r > 1n ? r : 1n;
}

/**
 * Decode the transaction data sent to the pinned router and check the fields the router acts on.
 * Returns { refusals, facts }. Anything this kit cannot decode, or that does not re-encode to the
 * same bytes (so the decoder and the contract could read it differently), is refused whole.
 */
export function checkRouterCalldata(data, { intent, minOut, feeBps }) {
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
    const need = requiredCalldataMin(minOut);
    if (d.minReturnAmount < need) out.push(refusal("min_out_not_enforced", `the transaction itself would accept less ${intent.tokenOut.symbol} than the minimum, so it would not stop a worse price`, need.toString(), d.minReturnAmount.toString()));
  }
  if ((flags & KYBER_FLAGS.PARTIAL_FILL) !== 0n) out.push(refusal("min_out_not_enforced", "the transaction allows a partial fill, which weakens the router's own minimum", "0", flags.toString()));
  if ((flags & ~(KYBER_ALLOWED_FLAGS | KYBER_FLAGS.FEE_ON_DST | KYBER_FLAGS.PARTIAL_FILL)) !== 0n) out.push(refusal("calldata_mismatch", "the transaction sets router options this kit does not know", `0x${KYBER_ALLOWED_FLAGS.toString(16)}`, `0x${flags.toString(16)}`));

  // the fee: exactly the one disclosed receiver and rate, in bps, taken from the input
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
    if ((flags & KYBER_FLAGS.FEE_ON_DST) !== 0n) out.push(refusal("fee_not_as_disclosed", "the transaction takes its fee from the tokens bought instead of the tokens sold", "taken from the input", `flags 0x${flags.toString(16)}`));
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
 */
export function buildSimulationRequest({ taker, calls, baseFeePerGas, maxPriorityFeePerGas }) {
  const realistic = typeof baseFeePerGas === "bigint" && baseFeePerGas > 0n;
  const tip = typeof maxPriorityFeePerGas === "bigint" && maxPriorityFeePerGas >= 0n ? maxPriorityFeePerGas : 0n;
  const fees = realistic ? { maxFeePerGas: toHex((baseFeePerGas * 12n) / 10n + tip), maxPriorityFeePerGas: toHex(tip) } : {};
  return [
    {
      blockStateCalls: [
        {
          ...(realistic ? { blockOverrides: { baseFeePerGas: toHex(baseFeePerGas) } } : {}),
          calls: calls.map((c) => ({ from: taker, to: c.to, data: c.data, ...(c.value ? { value: toHex(c.value) } : {}), ...fees })),
        },
      ],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ];
}

/** The latest block's base fee and a priority fee, read from the node the swap will be sent through. */
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
  return { baseFeePerGas, maxPriorityFeePerGas: tip };
}

export async function defaultSimulate({ taker, calls, c }) {
  const fees = await simulationFees(c);
  return c.pub.request({ method: "eth_simulateV1", params: buildSimulationRequest({ taker, calls, ...fees }) });
}

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

async function simulateAndCheck({ intent, facts, tx, approvalNeeded, deps, getClient }) {
  const calls = [];
  if (approvalNeeded) {
    calls.push({ to: intent.tokenIn.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, intent.amountIn] }), value: 0n });
  }
  calls.push({ to: getAddress(tx.to), data: tx.data, value: facts.value });

  let raw;
  try {
    raw = await (deps.simulate ?? defaultSimulate)({ taker: intent.taker, calls, c: deps.simulate ? deps.c : getClient() });
  } catch (err) {
    throw new Refused([refusal("simulation_unavailable", `this kit's own simulation could not run (${String(err.shortMessage || err.message).slice(0, 200)}); it never signs without one`)]);
  }
  const block = Array.isArray(raw) ? raw[0] : raw;
  const got = block?.calls;
  if (!Array.isArray(got) || got.length !== calls.length) {
    throw new Refused([refusal("simulation_unavailable", "this kit's own simulation returned an answer it cannot read; it never signs without one")]);
  }
  for (let i = 0; i < got.length; i++) {
    if (got[i].status !== "0x1" && got[i].status !== 1 && got[i].status !== "0x01") {
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

  // The disclosed fee is taken from the input inside the venue call; what the fee address actually receives can't exceed it.
  const feeBps = BigInt(facts.feeBps);
  const ceiling = (intent.amountIn * feeBps + 9_999n) / 10_000n;
  const feeSeen = received.get(lc(SATO_FEE_RECIPIENT))?.get(inKey) ?? 0n;
  if (feeSeen > ceiling) out.push(refusal("fee_exceeds_disclosed", "the fee address would receive more than the disclosed rate", ceiling.toString(), feeSeen.toString()));
  if (out.length) throw new Refused(out);

  return {
    source: deps.simulate ? "injected" : "eth_simulateV1",
    calls: got.length,
    gas_used: got.map((c) => String(uintOf(c.gasUsed) ?? "")),
    in_delta: inDelta,
    out_delta: outDelta,
    fee_seen: feeSeen,
    deltas: Object.fromEntries([...deltas].map(([k, v]) => [k, v])),
  };
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

  // What counts against the owner's limits: the USDC leg, measured. A USDC sale is the amount itself;
  // an ETH sale is the USDC the kit's own simulation shows coming back, or the caller's figure if higher.
  const usdcLeg = intent.tokenIn.symbol === "USDC" ? intent.amountIn : sim.out_delta;
  const measured = unitsToUsd(usdcLeg);
  const claimed = Number.isFinite(deps.usdNotional) && deps.usdNotional > 0 ? deps.usdNotional : 0;
  const usd = Math.max(measured, claimed);

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
    /** What the router itself will enforce, as decoded from the transaction (at most 1 base unit under min_out). */
    min_out_in_transaction: facts.calldata.min_return_amount,
    slippage_bps: intent.slippageBps,
    usd,
    router: getAddress(tx.to),
    tx: { to: getAddress(tx.to), data: tx.data, value: facts.value, gas_hint: uintOf(tx.gas) },
    approval: { needed: approvalNeeded, token: intent.tokenIn.native ? null : intent.tokenIn.address, spender: KYBER_ROUTER_BASE, amount: intent.amountIn, allowance_before: allowance },
    fee: { bps: response.sato_fee_bps, recipient: getAddress(response.sato_fee_recipient), disclosure: response.disclosure, seen_in_simulation: sim.fee_seen },
    simulation: sim,
    signature,
  });
  VERIFIED.add(plan);
  return plan;
}

/** Plan with Sato Hub, then verify. What the CLI calls for both a real swap and a dry run. */
export async function planAndVerifyBaseSwap(args, deps = {}) {
  requireUsdNotional(deps.usdNotional, "planning a swap"); // before Sato Hub is asked: that call writes a public record
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
    sell: { asset: plan.from, amount: d(plan.amount_in, plan.token_in) },
    buy: { asset: plan.to, quoted: d(plan.quoted_out, plan.token_out), minimum: d(plan.min_out, plan.token_out), minimum_in_transaction: plan.min_out_in_transaction === undefined ? null : d(plan.min_out_in_transaction, plan.token_out), slippage_bps: plan.slippage_bps },
    usd: plan.usd,
    router: plan.router,
    approval: plan.approval.needed ? { token: plan.from, spender: plan.approval.spender, amount: d(plan.approval.amount, plan.token_in), exact: true } : null,
    sato_fee: { bps: plan.fee.bps, recipient: plan.fee.recipient, disclosure: plan.fee.disclosure },
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
 * Read what the agent actually received, from the receipt. ERC-20: the Transfer
 * logs in it. ETH: the balance change across the block, with gas and the L1 data
 * fee added back (native transfers leave no log). Returns null if it can't be read.
 */
async function measureOutput({ plan, receipt, c }) {
  const me = lc(plan.taker);
  try {
    if (!plan.token_out.native) {
      const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter((l) => same(l.address, plan.token_out.address));
      return logs.reduce((sum, l) => sum + (lc(l.args.to) === me ? l.args.value : 0n) - (lc(l.args.from) === me ? l.args.value : 0n), 0n);
    }
    const [after, beforeBlock] = await Promise.all([
      c.pub.getBalance({ address: plan.taker, blockNumber: receipt.blockNumber }),
      c.pub.getBalance({ address: plan.taker, blockNumber: receipt.blockNumber - 1n }),
    ]);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
    return after - beforeBlock + gas;
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
  });

  let approveTx = null;
  let approvedHere = false;
  const reader = (token = plan.token_in.address) => readAllowance({ token, owner: plan.taker, spender: KYBER_ROUTER_BASE, deps, getClient: () => c });

  /** Put an allowance WE granted back to 0. Never throws: the ledger row says what happened. */
  const resetAllowance = async () => {
    let left = null;
    try {
      left = await reader();
      if (left === 0n) return { state: "none_left" };
      const r = await signAndSend(
        c,
        { to: plan.token_in.address, data: approveData(0n) },
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
    record({ id: entry.id, status: "approved", step: "approve", approve_tx: r.transactionHash });
  }

  // --- the swap
  // The approval wait can take a while. Prices move, so the plan's age is checked again right before signing.
  const ageNow = clock();
  if (ageNow - plan.verified_at_ms > maxAge) {
    release(entry, "plan expired before the swap was signed", { plan_verified_at: plan.verified_at });
    const expired = new Refused([refusal("plan_expired", "the checked plan became more than two minutes old while the approval was going through, so the swap was not signed; plan it again", "120s", plan.verified_at)]);
    throw approvedHere ? withNote(expired, await resetAllowance()) : expired;
  }
  let receipt;
  try {
    receipt = await signAndSend(c, { to: plan.tx.to, data: plan.tx.data, value: plan.tx.value }, (hash) => record({ id: entry.id, status: "signed", step: "swap", tx: hash }));
  } catch (err) {
    if (err instanceof Pending) throw err; // may still land: stays counted, allowance untouched
    release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: errText(err) });
    throw approvedHere ? withNote(err, await resetAllowance()) : err;
  }
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    const err = new Error(`transaction reverted: ${explorer(receipt.transactionHash)}`);
    throw approvedHere ? withNote(err, await resetAllowance()) : err;
  }

  // --- the receipt: what actually arrived
  const warnings = [];
  const outUnits = await measureOutput({ plan, receipt, c });
  // ERC-20: exact, from the receipt's Transfer logs. ETH leaves no log, so it is the balance change with the
  // receipt's gas and L1 fee added back: close, but a fee component the receipt does not show makes it read slightly low.
  const outBasis = plan.token_out.native ? "balance_change" : "receipt_logs";
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
    sato_fee: { bps: plan.fee.bps, recipient: plan.fee.recipient },
    allowance: allowance?.state ?? null,
    warnings,
  };
}
