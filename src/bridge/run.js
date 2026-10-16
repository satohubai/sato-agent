// One bridge, end to end: the agent moves ITS OWN funds from one of its chains to another through deBridge (DLN), after Sato Hub
// builds the unsigned order and this kit decodes and checks it independently. The order every check runs in:
//
//   1. the owner's choices: both chains in the policy, bridges turned on, the per-transaction and 24-hour limits (shared with
//      swaps and sends). The source is Base, Arbitrum or Polygon; BNB Chain and Solana as a SOURCE are refused with a plain reason.
//   2. what is being moved, read from the kit's chain table (src/chains.js): the chain's stablecoins or its own coin, on each side.
//      No other token. The recipient is always this bot's own address on the destination.
//   3. the order from Sato Hub (onchain_agent_swap, mode build-tx, venue debridge), its signature (two minutes old at most),
//      the protocol's fixed fee read onchain (globalFixedNativeFee()), and the order DECODED and checked field by field by
//      src/bridge/dln.js (verifyDlnTx): the contract, the function, the tokens, the amounts, who receives, who may cancel, the
//      fee. Nothing is signed on Sato Hub's word.
//   4. the cost, in USD, from the kit's own prices: what leaves the wallet (the amount and the fixed fee) against what arrives.
//      A stablecoin is its units; ETH, POL, BNB and SOL are priced by Chainlink. A bridge costing more than 3% of what it moves
//      needs the owner's approval even in auto mode; one that would deliver less than half of what it spends is refused.
//   5. the kit's own simulation of [approve, createSaltedOrder]: what leaves the wallet is the amount and the fixed fee, nothing
//      else. No simulation, no signing.
//   6. execute under the ledger/lock/exit-code contract: reserve, exact approval to DlnSource, sign the order, read its id from
//      the CreatedOrder event in the receipt. The order is then "sent", never "bridged": it is filled by a solver on the
//      destination, and `bridge status` asks deBridge.
//
// Steps 1-5 run for a dry run too; a dry run stops there.
//
// The order is filled for EXACTLY the amount shown or not at all (no slippage). An unfilled order can be cancelled by the order
// authority on the destination, which is this bot's own address; this version has no cancel command.

import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs, zeroAddress } from "viem";
import { evaluate, loadPolicy, allowedChains } from "../policy.js";
import { actions, record, release, reserve, spentLast24h } from "../ledger.js";
import { NeedsApproval, Pending, Refused, Rejected } from "../errors.js";
import { consumeApproval, requestApproval } from "../approvals.js";
import { oraclePrice, PriceUnavailable } from "../price.js";
import { NATIVE_PLACEHOLDER, debridgeChainIdOf, dlnSourceOf, evmChain, explorerTx, getChain, isEvm, isKnownChain, labelOf, isKnownDlnTaker, lockName, orList, stablesOf } from "../chains.js";
import { callTool as satoCallTool } from "../satohub.js";
import { verifyHubSignature } from "../hub-signature.js";
import { addresses } from "../wallet.js";
import { roundUsd, unitsToUsd } from "../amount.js";
import { clean } from "../text.js";
import { assertClientChain, clients, signAndSend } from "../base.js";
import { withLock } from "../store.js";
import { userAgent } from "../version.js";
import { MAX_AGE_MS, SATO_FEE_RECIPIENT, assetDeltas, decimalToUnits, defaultSimulate, exactGasLimit, simGasSwap, swapGasLimit, unitsToDecimal } from "../swap/evm.js";
import { feePercent } from "../swap/fee-tier.js";
import { encodeDestAddress } from "./dln.js";

// ---------------------------------------------------------------- pinned values

/** deBridge's DlnSource, the same address on Base, Arbitrum and Polygon (Sourcify exact match on Base, 2026-10-16): the registry's pin. */
export const DLN_SOURCE = dlnSourceOf("base");
/** The chains this version bridges FROM. */
export const BRIDGE_SOURCES = Object.freeze(["base", "arbitrum", "polygon"]);
/** Why a chain that is not a source is refused, in plain words. */
const SOURCE_REFUSALS = Object.freeze({
  bnb: "deBridge sends BNB Chain orders through a contract this kit does not read yet, so it cannot check them; bridge from Base, Arbitrum or Polygon",
  solana: "this kit cannot read deBridge's Solana transactions yet; bridge from Base, Arbitrum or Polygon",
});
/** The most Sato Hub's cross-chain fee may be: 25 bps, taken from the amount sent. */
export const BRIDGE_FEE_CEILING_BPS = 25;
/** The cost (percent of what is moved) above which the owner is asked, even in auto mode. */
export const COST_CONFIRM_PCT = 3;
/** The share of what leaves the wallet that must arrive: below this the bridge is refused (the fixed fee swamps a small amount). */
export const MIN_ARRIVAL_SHARE = 0.5;
/**
 * The most the protocol's fixed fee may be on each source chain, in wei: ten times what it was measured at (2026-10-16:
 * Base 0.001 ETH, Arbitrum 0.001 ETH, Polygon 0.5 POL). It is read onchain every time and the order must carry exactly that;
 * this ceiling stops a fee that jumped (or an endpoint that lies) from being paid. A real raise past it waits for a kit update.
 */
export const FIX_FEE_CEILING_WEI = Object.freeze({ base: 10n ** 16n, arbitrum: 10n ** 16n, polygon: 5n * 10n ** 18n });
/** deBridge's markers for the chain's own coin. */
export const DEBRIDGE_NATIVE_EVM = zeroAddress;
export const DEBRIDGE_NATIVE_SOLANA = "11111111111111111111111111111111";
/** deBridge's public API: the order status, and the orders a transaction created. Read only. */
export const DLN_API = "https://dln.debridge.finance/v1.0/dln";
const API_TIMEOUT_MS = 15_000;
/** An order still "Created" after this long is not being filled: `bridge status` says how it can be cancelled. */
export const STUCK_AFTER_MINUTES = 30;
const RPC_TIMEOUT_MS = 20_000;
const SIM_GAS_APPROVE = 100_000n;
const RESET_GAS = 100_000n;
const RESET_GAS_L1_FALLBACK = 500_000n;

const FIX_FEE_ABI = [{ type: "function", name: "globalFixedNativeFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint88" }] }];

// DlnSource's CreatedOrder event, from the verified implementation's ABI (Sourcify, Base 0x2b42…8611). Its topic0 is
// 0xfc8703fd57380f9dd234a89dce51333782d49c5902f307b02f03e014d18fe471, read on a live Base order on 2026-10-16.
export const CREATED_ORDER_EVENT = Object.freeze([
  {
    type: "event",
    name: "CreatedOrder",
    anonymous: false,
    inputs: [
      {
        name: "order",
        type: "tuple",
        indexed: false,
        components: [
          { name: "makerOrderNonce", type: "uint64" },
          { name: "makerSrc", type: "bytes" },
          { name: "giveChainId", type: "uint256" },
          { name: "giveTokenAddress", type: "bytes" },
          { name: "giveAmount", type: "uint256" },
          { name: "takeChainId", type: "uint256" },
          { name: "takeTokenAddress", type: "bytes" },
          { name: "takeAmount", type: "uint256" },
          { name: "receiverDst", type: "bytes" },
          { name: "givePatchAuthoritySrc", type: "bytes" },
          { name: "orderAuthorityAddressDst", type: "bytes" },
          { name: "allowedTakerDst", type: "bytes" },
          { name: "allowedCancelBeneficiarySrc", type: "bytes" },
          { name: "externalCall", type: "bytes" },
        ],
      },
      { name: "orderId", type: "bytes32", indexed: false },
      { name: "affiliateFee", type: "bytes", indexed: false },
      { name: "nativeFixFee", type: "uint256", indexed: false },
      { name: "percentFee", type: "uint256", indexed: false },
      { name: "referralCode", type: "uint32", indexed: false },
      { name: "metadata", type: "bytes", indexed: false },
    ],
  },
]);

const lc = (s) => String(s).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);
const refusal = (rule, message, limit = null, observed = null) => ({ rule, limit, observed, message });
const refuse = (rule, message, limit = null, observed = null) => new Refused([refusal(rule, message, limit, observed)]);
const errText = (err) => String(err?.shortMessage || err?.message || err);
const ORDER_ID = /^0x[0-9a-fA-F]{64}$/;

/** A request the owner (or the agent) wrote wrongly: the CLI turns it into a usage error. */
export class BridgeUsage extends Error {}

const withTimeout = (p, ms = RPC_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** Round a percentage up to the next whole percent: the band an approval binds (a worse cost needs a new approval). */
const band = (pct) => `upto_${Math.max(1, Math.ceil(Number(pct) - 1e-9))}pct`;
const reason = (code, text) => ({ code, text });
/** 0x1234…abcd for a long hex string. */
const shortHex = (h) => (String(h).length > 14 ? `${String(h).slice(0, 8)}…${String(h).slice(-4)}` : String(h));
/** A USD figure for a sentence: cents ("2.50"), or more places for a sum below a cent. */
const money = (n) => (typeof n === "number" && Math.abs(n) >= 0.01 ? n.toFixed(2) : String(roundUsd(n)));
const merge = (...lists) => {
  const seen = new Set();
  return lists.flat().filter((r) => !seen.has(r.code) && seen.add(r.code));
};

// ---------------------------------------------------------------- what is being moved

/**
 * One side of a bridge, from the chain table. Returns
 *   { symbol, native, decimals, address (an EVM token, or deBridge's native marker), mint (Solana), kind: "stable" | "native" }
 * `address` is what Sato Hub is asked for and what the order must carry; on Solana it is the mint (or the native marker).
 */
function resolveAsset(chainKey, raw, label) {
  const c = getChain(chainKey);
  const input = String(raw ?? "").trim();
  const upper = input.toUpperCase();
  const stables = stablesOf(chainKey);
  const menu = orList([...stables.map(([s]) => s), c.native.symbol]);
  for (const [symbol, s] of stables) {
    const byAddress = isEvm(chainKey) ? same(input, s.address) : input === s.mint;
    if (upper === symbol || byAddress) {
      const id = isEvm(chainKey) ? getAddress(s.address) : s.mint;
      return { symbol, native: false, decimals: s.decimals, address: id, mint: isEvm(chainKey) ? null : s.mint, kind: "stable" };
    }
  }
  const nativeMarker = isEvm(chainKey) ? DEBRIDGE_NATIVE_EVM : DEBRIDGE_NATIVE_SOLANA;
  const isNativeInput = upper === c.native.symbol || input === nativeMarker || (isEvm(chainKey) && same(input, NATIVE_PLACEHOLDER));
  if (isNativeInput) return { symbol: c.native.symbol, native: true, decimals: c.native.decimals, address: nativeMarker, mint: isEvm(chainKey) ? null : nativeMarker, kind: "native" };
  throw new BridgeUsage(`${label}: on ${c.label} the kit bridges ${menu}; "${clean(input, 60)}" is none of those (other tokens are not supported in this version)`);
}

/** The USD price of a chain's own coin from the kit's oracle (Chainlink), or null when none can be read. */
async function nativeUsdPrice(chainKey, deps) {
  const asset = getChain(chainKey).native.oracle;
  if (!asset) return null;
  try {
    const p = await (deps.oraclePrice ?? oraclePrice)(asset, isEvm(chainKey) ? { chain: chainKey } : {});
    return typeof p?.usd === "number" && Number.isFinite(p.usd) && p.usd > 0 ? p : null;
  } catch (err) {
    if (err instanceof PriceUnavailable) return null;
    throw err;
  }
}

const nativeToUsd = (price, wei, decimals) => (price ? roundUsd(Number(unitsToDecimal(wei, decimals)) * price.usd) : null);

/** The wallet's whole balance of a stablecoin, read from the chain (base units). */
async function defaultTokenBalance(chain, asset, deps) {
  const c = deps.c ?? clients(undefined, chain);
  return BigInt(await withTimeout(c.pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [c.account.address] })));
}

/**
 * Validate the request against the owner's choices and size it. Throws Refused (the owner's choices, or a chain this version
 * cannot bridge from), BridgeUsage (a request written wrongly) or an Error. Nothing is sent anywhere except a price read.
 */
export async function sizeBridge({ chain, toChain, asset, amount, receive }, deps = {}) {
  const src = String(chain ?? "").toLowerCase();
  const dst = String(toChain ?? "").toLowerCase();
  if (!isKnownChain(src)) throw new BridgeUsage(`--chain must be one of the chains the kit knows (${orList(BRIDGE_SOURCES)} to bridge from)`);
  if (!isKnownChain(dst)) throw new BridgeUsage("--to-chain must be one of the chains the kit knows");
  if (src === dst) throw new BridgeUsage("--chain and --to-chain are the same chain; a bridge moves funds to another chain");
  if (!BRIDGE_SOURCES.includes(src)) throw refuse("bridge_source_unsupported", `cannot bridge from ${labelOf(src)}: ${SOURCE_REFUSALS[src] ?? "this version bridges from Base, Arbitrum or Polygon"}`, BRIDGE_SOURCES.join(","), src);

  const policy = deps.policy ?? loadPolicy();
  // The cheap refusals first (limits set, the source chain, bridges on): nothing is read from a chain for a bridge the owner hasn't allowed.
  const first = evaluate(policy, { usd: 0.000001, chain: src, kind: "bridge" }, spentLast24h());
  if (first.length) throw new Refused(first);
  if (!allowedChains(policy).includes(dst)) {
    throw refuse("chain_not_allowed", `this agent is set to work on ${allowedChains(policy).join(" and ")}; ${labelOf(dst)} is not one of them, so the owner adds it with \`sato-agent policy set --chains\` before a bridge can go there`, allowedChains(policy), dst);
  }

  const tokenIn = resolveAsset(src, asset, "--asset");
  let tokenOut;
  if (receive !== undefined && receive !== null && String(receive).trim() !== "") tokenOut = resolveAsset(dst, receive, "--receive");
  else if (tokenIn.kind === "stable") {
    const firstStable = stablesOf(dst)[0];
    tokenOut = resolveAsset(dst, firstStable[0], "--receive");
  } else if (getChain(dst).native.symbol === tokenIn.symbol) tokenOut = resolveAsset(dst, tokenIn.symbol, "--receive");
  else {
    const c = getChain(dst);
    throw new BridgeUsage(`--receive is needed: ${tokenIn.symbol} on ${labelOf(src)} has no same coin on ${c.label}; say what to receive there, for example --receive ${orList([...stablesOf(dst).map(([s]) => s), c.native.symbol])}`);
  }

  // The amount: a number, or `all` for the whole balance of a stablecoin (read from the chain). A coin's `all` is refused: it must keep
  // its own gas and the protocol's fixed fee, which the owner sizes.
  let amountText = String(amount);
  let amountIsAll = false;
  if (/^all$/i.test(amountText)) {
    if (tokenIn.native) throw new BridgeUsage(`--amount all moves the whole balance of a stablecoin; for ${tokenIn.symbol} give an amount (the wallet needs ${tokenIn.symbol} left for the fixed fee and gas)`);
    let units;
    try {
      units = await (deps.tokenBalance ?? defaultTokenBalance)(src, tokenIn, deps);
    } catch (err) {
      throw new Error(`could not read the wallet's ${tokenIn.symbol} balance on ${labelOf(src)} (${clean(errText(err), 160)}); give an amount instead`);
    }
    if (!(units > 0n)) throw refuse("no_balance", `the wallet holds no ${tokenIn.symbol} on ${labelOf(src)}, so there is nothing to bridge`);
    amountText = unitsToDecimal(units, tokenIn.decimals);
    amountIsAll = true;
  }
  let amountUnits;
  try {
    amountUnits = decimalToUnits(amountText, tokenIn.decimals, `${tokenIn.symbol} amount`);
  } catch (err) {
    throw new BridgeUsage(err.message);
  }

  const c = deps.c;
  const taker = getAddress(deps.taker ?? c?.account?.address ?? addresses().base);
  const recipient = isEvm(dst) ? taker : (deps.solanaAddress ?? addresses().solana);

  // A first USD figure for the limits, before anything is asked of Sato Hub (a quote writes a public record there).
  let usdGive = null;
  if (tokenIn.kind === "stable") usdGive = roundUsd(unitsToUsd(amountUnits, tokenIn.decimals));
  else usdGive = nativeToUsd(await nativeUsdPrice(src, deps), amountUnits, tokenIn.decimals);
  const early = evaluate(policy, { usd: usdGive ?? 0.000001, chain: src, kind: "bridge" }, spentLast24h());
  if (early.length) throw new Refused(early);

  return { chain: src, chainOut: dst, tokenIn, tokenOut, amountText, amountUnits, amountIsAll, usdGive, taker, recipient };
}

// ---------------------------------------------------------------- Sato Hub, its signature, the protocol's fee

/** The signed order from Sato Hub. WRITES A PUBLIC RECORD there (build-tx always does), also for a dry run. */
async function askSatoHub(sized, deps) {
  const args = {
    mode: "build-tx",
    chain_in: getChain(sized.chain).hubName,
    chain_out: getChain(sized.chainOut).hubName,
    venue: "debridge",
    token_in: sized.tokenIn.address,
    token_out: sized.tokenOut.address,
    amount_in: sized.amountUnits.toString(),
    taker: sized.taker,
    recipient: sized.recipient,
    // Labels the recipient as the caller's own address on the destination (Sato Hub's gate cannot check a Solana address against the EVM taker).
    // The kit's own verifier still checks that the order pays this bot's own address.
    recipient_owner: "self",
    // A DLN order is filled for exactly its take amount: there is no slippage to set.
    slippage_bps: 0,
    response_format: "json",
    ...(sized.usdGive !== null ? { usd_notional: sized.usdGive } : {}),
  };
  const r = await (deps.callTool ?? satoCallTool)("onchain_agent_swap", args);
  let response = r?.structured ?? null;
  if (!response && r?.text) {
    try {
      response = JSON.parse(r.text);
    } catch {
      response = null;
    }
  }
  if (r?.isError || !response || typeof response !== "object") {
    throw refuse("bridge_quote_unavailable", `Sato Hub did not return a bridge order${r?.text ? `: ${clean(r.text, 300)}` : ""}; nothing was signed`);
  }
  return response;
}

async function defaultVerifySignature(response) {
  return verifyHubSignature(response, { maxAgeMs: MAX_AGE_MS });
}

/** The same two-minute signature check swaps use: the response is signed by Sato Hub, and was signed just now. */
async function checkSignature(response, deps, now) {
  const sig = response?.meta?.signature;
  if (!sig || typeof sig !== "object") throw refuse("signature_unverified", "the response from Sato Hub is not signed, and an unsigned order is never signed by this kit");
  let outcome;
  try {
    outcome = await (deps.verifySignature ?? defaultVerifySignature)(response);
  } catch (err) {
    if (err instanceof Refused) throw err;
    throw refuse("signature_unverified", `the Sato Hub signature check could not complete (${clean(err.message, 200)})`);
  }
  if (!(outcome === true || outcome?.ok === true)) throw refuse("signature_unverified", `the Sato Hub signature does not match the response${outcome?.why ? ` (${clean(outcome.why, 120)})` : ""}`, null, sig.kid ?? null);
  const signedAt = Date.parse(sig.signed_at);
  const maxAge = deps.maxAgeMs ?? MAX_AGE_MS;
  if (!Number.isFinite(signedAt) || now - signedAt > maxAge || signedAt - now > 60_000) {
    throw refuse("signature_stale", "the response was not signed within the last two minutes; ask again", `${maxAge / 1000}s`, sig.signed_at ?? null);
  }
  return { kid: sig.kid ?? null, signed_at: sig.signed_at };
}

/** DlnSource's fixed protocol fee on the source chain (wei), read onchain. The order must carry exactly this. */
async function readFixFee(chain, deps, getClient) {
  let fee;
  try {
    fee = deps.readFixFee ? await deps.readFixFee({ chain }) : await withTimeout(getClient().pub.readContract({ address: DLN_SOURCE, abi: FIX_FEE_ABI, functionName: "globalFixedNativeFee" }));
  } catch (err) {
    throw refuse("fix_fee_unreadable", `the protocol's fixed fee could not be read from ${labelOf(chain)} (${clean(errText(err), 160)}), so the order cannot be checked; nothing was signed`);
  }
  let wei;
  try {
    wei = BigInt(fee);
  } catch {
    throw refuse("fix_fee_unreadable", `${labelOf(chain)} gave an unreadable fixed fee; nothing was signed`);
  }
  const ceiling = FIX_FEE_CEILING_WEI[chain];
  if (wei < 0n || wei > ceiling) {
    throw refuse("fix_fee_over_ceiling", `deBridge's fixed fee on ${labelOf(chain)} reads ${unitsToDecimal(wei < 0n ? 0n : wei, getChain(chain).native.decimals)} ${getChain(chain).native.symbol}, above the ${unitsToDecimal(ceiling, getChain(chain).native.decimals)} this kit pays; nothing was signed`, ceiling.toString(), wei.toString());
  }
  return wei;
}

// ---------------------------------------------------------------- the kit's own simulation

const callOk = (c) => c.status === "0x1" || c.status === 1 || c.status === "0x01";

function revertNote(call) {
  const msg = call?.error?.message ?? call?.error?.data ?? null;
  if (msg) return String(msg).slice(0, 200);
  const rd = call?.returnData;
  return typeof rd === "string" && rd !== "0x" ? rd.slice(0, 74) : "no reason given";
}

/** Run calls through the kit's own eth_simulateV1 (or the injected one). Refuses, never guesses, when it cannot run or be read. */
async function runSimulation({ plan, calls, deps, getClient }) {
  let raw;
  try {
    raw = await (deps.simulate ?? defaultSimulate)({ taker: plan.taker, calls, c: deps.simulate ? deps.c : getClient() });
  } catch (err) {
    const why = String(err.details || err.shortMessage || err.message);
    if (/insufficient funds/i.test(why)) {
      const ch = evmChain(plan.chain);
      throw new Refused([refusal(`not_enough_${ch.native.symbol.toLowerCase()}`, `the wallet does not hold enough ${ch.native.symbol} on ${ch.label} for the fixed fee and gas${plan.tokenIn.native ? ` and the ${ch.native.symbol} being moved` : ""}; add some and try again (nothing was signed)`, null, why.slice(0, 160))]);
    }
    throw new Refused([refusal("simulation_unavailable", `this kit's own simulation could not run (${why.slice(0, 200)}); it never signs without one`)]);
  }
  const blocks = Array.isArray(raw) ? raw : [raw];
  const got = blocks.every((b) => Array.isArray(b?.calls)) ? blocks.flatMap((b) => b.calls) : null;
  if (!Array.isArray(got) || got.length !== calls.length) {
    throw new Refused([refusal("simulation_unavailable", "this kit's own simulation returned an answer it cannot read; it never signs without one")]);
  }
  return got;
}

async function readAllowance({ plan, deps, getClient }) {
  if (deps.readAllowance) return BigInt(await deps.readAllowance({ token: plan.tokenIn.address, owner: plan.taker, spender: DLN_SOURCE }));
  return BigInt(await withTimeout(getClient().pub.readContract({ address: plan.tokenIn.address, abi: erc20Abi, functionName: "allowance", args: [plan.taker, DLN_SOURCE] })));
}

const approveData = (amount) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DLN_SOURCE, amount] });

/** The calls the bridge itself sends: an exact approval when the allowance is short, then the order. */
function bridgeCalls(plan, approvalNeeded) {
  const calls = [];
  if (approvalNeeded) calls.push({ to: plan.tokenIn.address, data: approveData(plan.giveAmount), value: 0n, gas: SIM_GAS_APPROVE });
  calls.push({ to: DLN_SOURCE, data: plan.tx.data, value: plan.tx.value, gas: simGasSwap(plan.chain) });
  return calls;
}

/** The outcome of the simulation, or Refused. What may leave the wallet is the amount, and the native coin up to the transaction's value. */
async function simulateAndCheck({ plan, approvalNeeded, deps, getClient }) {
  const calls = bridgeCalls(plan, approvalNeeded);
  const got = await runSimulation({ plan, calls, deps, getClient });
  for (let i = 0; i < got.length; i++) {
    if (!callOk(got[i])) throw new Refused([refusal("simulation_failed", `${i === calls.length - 1 ? "the bridge order" : "the approval"} would fail: ${revertNote(got[i])}`, null, got[i].status ?? null)]);
  }
  const { deltas, leaves } = assetDeltas(got, plan.taker);
  const nativeKey = lc(NATIVE_PLACEHOLDER);
  const giveKey = plan.tokenIn.native ? nativeKey : lc(plan.tokenIn.address);
  const out = [];
  if (!plan.tokenIn.native) {
    const left = -(deltas.get(giveKey) ?? 0n);
    if (left !== plan.giveAmount) out.push(refusal("bridge_outflow_mismatch", `the simulation takes ${unitsToDecimal(left < 0n ? 0n : left, plan.tokenIn.decimals)} ${plan.tokenIn.symbol} from the wallet, not the ${unitsToDecimal(plan.giveAmount, plan.tokenIn.decimals)} asked for`, plan.giveAmount.toString(), left.toString()));
  }
  const nativeLeft = -(deltas.get(nativeKey) ?? 0n);
  // The coin as the amount: what leaves must be the amount and the fixed fee, not less (the order would not carry what was asked).
  if (plan.tokenIn.native && nativeLeft < plan.tx.value) out.push(refusal("bridge_outflow_mismatch", `the simulation takes ${unitsToDecimal(nativeLeft < 0n ? 0n : nativeLeft, plan.tokenIn.decimals)} ${plan.tokenIn.symbol} from the wallet, not the ${unitsToDecimal(plan.tx.value, plan.tokenIn.decimals)} (the amount and the fixed fee) the order sends`, plan.tx.value.toString(), nativeLeft.toString()));
  if (nativeLeft > plan.tx.value) out.push(refusal("outflow_exceeds_amount", `the simulation takes more ${evmChain(plan.chain).native.symbol} from the wallet than the order sends`, plan.tx.value.toString(), nativeLeft.toString()));
  for (const [asset, delta] of deltas) {
    if (asset !== giveKey && asset !== nativeKey && delta < 0n) out.push(refusal("other_token_leaves", `the bridge would also take ${asset} from the wallet`, "0", delta.toString()));
  }
  for (const l of leaves) out.push(refusal("other_token_leaves", `the bridge would move an ${l.kind} token out of the wallet`, null, l.asset));
  if (out.length) throw new Refused(out);

  // The order id the simulation saw (an extra reading; the real one comes from the receipt).
  let simulatedOrderId = null;
  try {
    const last = got[got.length - 1];
    const ev = parseEventLogs({ abi: CREATED_ORDER_EVENT, logs: last.logs ?? [], eventName: "CreatedOrder" }).filter((l) => same(l.address, DLN_SOURCE));
    if (ev.length === 1) simulatedOrderId = ev[0].args.orderId;
  } catch {
    simulatedOrderId = null;
  }
  return {
    source: deps.simulate ? "injected" : "eth_simulateV1",
    calls: got.length,
    gas_used: got.map((c) => String(c.gasUsed === undefined || c.gasUsed === null ? "" : BigInt(c.gasUsed))),
    leaves: giveKey === nativeKey ? (nativeLeft).toString() : (-(deltas.get(giveKey) ?? 0n)).toString(),
    native_leaves: nativeLeft.toString(),
    simulated_order_id: simulatedOrderId,
  };
}

// ---------------------------------------------------------------- prepare

const VERIFIED = new WeakSet();

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const asBig = (v, what) => {
  try {
    return BigInt(v);
  } catch {
    throw refuse("verifier_answer_unreadable", `the order check returned an unreadable ${what}; nothing was signed`);
  }
};

/** The cost of the bridge in USD, from the kit's own prices. A figure that cannot be priced is null, never zero. */
async function priceBridge({ sized, giveAmount, takeAmount, fixFee }, deps) {
  const srcPrice = sized.tokenIn.native || fixFee > 0n ? await nativeUsdPrice(sized.chain, deps) : null;
  const dstPrice = sized.tokenOut.native ? await nativeUsdPrice(sized.chainOut, deps) : null;
  const srcNative = getChain(sized.chain).native;
  const give = sized.tokenIn.kind === "stable" ? roundUsd(unitsToUsd(giveAmount, sized.tokenIn.decimals)) : nativeToUsd(srcPrice, giveAmount, sized.tokenIn.decimals);
  const fee = fixFee === 0n ? 0 : nativeToUsd(srcPrice, fixFee, srcNative.decimals);
  const take = sized.tokenOut.kind === "stable" ? roundUsd(unitsToUsd(takeAmount, sized.tokenOut.decimals)) : nativeToUsd(dstPrice, takeAmount, sized.tokenOut.decimals);
  const unpriced = [];
  if (give === null) unpriced.push(`${sized.tokenIn.symbol} on ${labelOf(sized.chain)}`);
  if (fee === null && !unpriced.some((u) => u.startsWith(srcNative.symbol))) unpriced.push(`${srcNative.symbol} on ${labelOf(sized.chain)}`);
  if (take === null) unpriced.push(`${sized.tokenOut.symbol} on ${labelOf(sized.chainOut)}`);
  const priced = [give, fee].filter((n) => typeof n === "number");
  const spendPartial = roundUsd(priced.reduce((s, n) => s + n, 0));
  const complete = give !== null && fee !== null && take !== null;
  const spend = give !== null && fee !== null ? roundUsd(give + fee) : null;
  const cost = complete ? roundUsd(spend - take) : null;
  const costPct = complete && spend > 0 ? Math.round(((spend - take) / spend) * 10_000) / 100 : null;
  return {
    give_usd: give,
    fee_usd: fee,
    take_usd: take,
    spend_usd: spend,
    spend_priced_usd: spendPartial,
    cost_usd: cost,
    cost_pct: costPct,
    unpriced,
    prices: { source: srcPrice ? { asset: srcPrice.asset, usd: srcPrice.usd, source: srcPrice.source, age_s: srcPrice.age_s } : null, destination: dstPrice ? { asset: dstPrice.asset, usd: dstPrice.usd, source: dstPrice.source, age_s: dstPrice.age_s } : null },
  };
}

/** The approval intent: what the owner approves, exactly. Binds the chains, both assets, the amount and the reasons. */
export function bridgeIntent(sized, reasonCodes = []) {
  return {
    cmd: "bridge",
    chain: sized.chain,
    chain_out: sized.chainOut,
    asset: sized.tokenIn.symbol,
    receive: sized.tokenOut.symbol,
    asset_id: sized.tokenIn.address,
    receive_id: sized.tokenOut.address,
    amount: sized.amountText,
    recipient: sized.recipient,
    confirm_reasons: [...reasonCodes].sort(),
    fee_max_bps: BRIDGE_FEE_CEILING_BPS,
    cost_note: `deBridge charges a fixed fee in ${getChain(sized.chain).native.symbol} on top of the amount, and the order is filled for an exact amount: what arrives is shown with the order, and a bridge costing more than ${COST_CONFIRM_PCT}% of what it moves asks again`,
  };
}

/**
 * Plan and check a bridge. Returns { sized, confirm, display, execute }: `display` is safe to print (and to show the owner);
 * `confirm` lists the reasons the owner must approve this bridge (empty = none); `execute()` signs under the ledger contract.
 * Throws Refused / Error before anything is signed.
 *
 * deps: policy, callTool, verifySignature, verifyDlnTx, readFixFee, readAllowance, simulate, oraclePrice, tokenBalance, taker,
 *       solanaAddress, c (an EVM client), now, sized (a sizing already done by the caller)
 */
export async function planBridge(req, deps = {}) {
  const sized = deps.sized ?? (await sizeBridge(req, deps));
  const now = deps.now ?? Date.now();
  const policy = deps.policy ?? loadPolicy();
  let client;
  const getClient = () => (client ??= deps.c ?? clients(undefined, sized.chain));

  const response = await askSatoHub(sized, deps);
  const signature = await checkSignature(response, deps, now);
  if (response.unavailable || !response.tx || typeof response.tx !== "object") {
    throw refuse("tx_withheld", `Sato Hub returned no order for this bridge${response.withheld?.reason ? `: ${clean(response.withheld.reason, 300)}` : ""}; nothing was signed`, null, response.withheld?.rule ?? null);
  }
  const fixFee = await readFixFee(sized.chain, deps, getClient);

  // The independent decoder: the contract, the function, every field of the order. Imported on use, so a test can inject it.
  const verify = deps.verifyDlnTx ?? (await import("./dln.js")).verifyDlnTx;
  const intent = {
    chain: sized.chain,
    chainOut: sized.chainOut,
    tokenIn: { address: sized.tokenIn.address, native: sized.tokenIn.native, decimals: sized.tokenIn.decimals, symbol: sized.tokenIn.symbol },
    tokenOut: { address: sized.tokenOut.address, mint: sized.tokenOut.mint ?? undefined, native: sized.tokenOut.native, decimals: sized.tokenOut.decimals, symbol: sized.tokenOut.symbol },
    amountIn: sized.amountUnits,
    taker: sized.taker,
    recipient: sized.recipient,
  };
  const facts = await verify({ response, intent, fixFeeWei: fixFee });

  // The kit's own look at what the check returned, so a decoder that is wrong or replaced cannot be the only line.
  const giveAmount = asBig(facts.giveAmount, "amount sent");
  const takeAmount = asBig(facts.takeAmount, "amount received");
  const value = asBig(facts.value, "transaction value");
  const checks = [];
  if (giveAmount !== sized.amountUnits) checks.push(refusal("bridge_give_mismatch", "the order sends a different amount than the one asked for", sized.amountUnits.toString(), giveAmount.toString()));
  if (value !== fixFee + (sized.tokenIn.native ? sized.amountUnits : 0n)) checks.push(refusal("bridge_value_mismatch", "the order's value is not the fixed fee (plus the amount, for the chain's own coin)", (fixFee + (sized.tokenIn.native ? sized.amountUnits : 0n)).toString(), value.toString()));
  if (!(takeAmount > 0n)) checks.push(refusal("bridge_take_mismatch", "the order delivers nothing", ">0", takeAmount.toString()));
  if (!same(response.tx.to, DLN_SOURCE)) checks.push(refusal("bridge_wrong_contract", "the transaction does not go to deBridge's DlnSource", DLN_SOURCE, response.tx.to ?? null));
  if (response.tx.chain_id === undefined || response.tx.chain_id === null || Number(response.tx.chain_id) !== evmChain(sized.chain).chainId) checks.push(refusal("response_mismatch", `the transaction is not for ${labelOf(sized.chain)}`, evmChain(sized.chain).chainId, response.tx.chain_id));
  if (!same(facts.approvalSpender, DLN_SOURCE)) checks.push(refusal("bridge_spender_mismatch", "the order check names a different contract to approve than deBridge's DlnSource", DLN_SOURCE, facts.approvalSpender ?? null));
  if (!Number.isInteger(facts.feeBps) || facts.feeBps < 0 || facts.feeBps > BRIDGE_FEE_CEILING_BPS) checks.push(refusal("fee_over_ceiling", `the order's Sato Hub fee is above the ${BRIDGE_FEE_CEILING_BPS} bps this kit accepts`, BRIDGE_FEE_CEILING_BPS, facts.feeBps ?? null));
  if (typeof response.tx.data !== "string" || !/^0x([0-9a-fA-F]{2}){4,}$/.test(response.tx.data)) checks.push(refusal("response_mismatch", "the transaction has no calldata"));
  if (checks.length) throw new Refused(checks);

  // The cost. Gates run before the simulation: no point simulating what will not be signed.
  const cost = await priceBridge({ sized, giveAmount, takeAmount, fixFee }, deps);
  const limitSpend = cost.spend_usd ?? cost.spend_priced_usd;
  const spendRow = limitSpend > 0 ? { usd: limitSpend } : { usd: 0, unpriced: true };
  const late = evaluate(policy, { ...spendRow, chain: sized.chain, kind: "bridge" }, spentLast24h());
  if (late.length) throw new Refused(late);
  if (cost.cost_usd !== null && cost.take_usd < cost.spend_usd * MIN_ARRIVAL_SHARE) {
    const native = getChain(sized.chain).native;
    const feeText = cost.fee_usd !== null ? `about $${money(cost.fee_usd)}` : `${unitsToDecimal(fixFee, native.decimals)} ${native.symbol}`;
    throw refuse(
      "bridge_cost_too_high",
      `this bridge would deliver $${money(cost.take_usd)} for the $${money(cost.spend_usd)} it spends (less than half): the fixed fee is ${feeText} on ${labelOf(sized.chain)}; bridge a larger amount`,
      `at least ${MIN_ARRIVAL_SHARE * 100}% arriving`,
      `${Math.round((cost.take_usd / cost.spend_usd) * 10_000) / 100}%`,
    );
  }
  const confirm = [];
  if (cost.unpriced.length) confirm.push(reason("bridge_unpriced_native", `the kit has no independent price for ${cost.unpriced.join(" and ")}, so it cannot say what this bridge costs or hold all of it to your limits`));
  else if (cost.cost_pct > COST_CONFIRM_PCT) confirm.push(reason(`bridge_cost_over_3_pct_${band(cost.cost_pct)}`, `this bridge costs ${cost.cost_pct}% of what it moves ($${money(cost.cost_usd)} of $${money(cost.spend_usd)}), above ${COST_CONFIRM_PCT}%`));
  // An order that pays out MORE than the amount sent is not a fair one: the solver is paid only from the amount sent (less the fees; the
  // fixed fee goes to deBridge, not to the solver), so no solver is paid to fill it and it may sit open. Compared with the amount SENT, never
  // with the spend (which includes the fixed fee). Stable to stable: an honest order always pays out less than it gives, so no tolerance;
  // with a coin on either side, 2% for the oracle's own drift. Never "low cost".
  if (cost.give_usd !== null && cost.give_usd !== undefined && cost.take_usd !== null) {
    const bothStable = sized.tokenIn.kind === "stable" && sized.tokenOut.kind === "stable";
    const tolerance = bothStable ? 0 : 0.02;
    if (cost.take_usd > cost.give_usd * (1 + tolerance)) {
      confirm.push(reason("bridge_take_above_market", `the quote pays out more than it sends ($${money(cost.take_usd)} arriving for $${money(cost.give_usd)} sent), which a fair order does not; it may never be filled`));
    }
  }
  // The solver named to fill the order: empty (anyone) or a deBridge solver seen on live orders passes quietly; any other may never fill it.
  const takerHex = String(facts.allowedTakerDst ?? "0x").toLowerCase();
  const takerKnown = takerHex === "0x" || takerHex === "" || isKnownDlnTaker(takerHex);
  if (!takerKnown) confirm.push(reason("bridge_unknown_taker", `the order names ${shortHex(takerHex)} as the only solver allowed to fill it, one the kit has not seen deBridge use; if that solver does not fill it, the order stays open`));

  // The kit's own simulation of the real calls.
  let allowance = null;
  if (!sized.tokenIn.native) {
    try {
      allowance = await readAllowance({ plan: { tokenIn: sized.tokenIn, taker: sized.taker }, deps, getClient });
    } catch (err) {
      throw refuse("simulation_unavailable", `the allowance could not be read (${clean(errText(err), 200)}), so nothing can be simulated`);
    }
  }
  const approvalNeeded = !sized.tokenIn.native && allowance < giveAmount;
  const planCore = {
    chain: sized.chain,
    chainOut: sized.chainOut,
    taker: sized.taker,
    recipient: sized.recipient,
    tokenIn: sized.tokenIn,
    tokenOut: sized.tokenOut,
    giveAmount,
    tx: { to: getAddress(response.tx.to), data: response.tx.data, value },
  };
  const sim = await simulateAndCheck({ plan: planCore, approvalNeeded, deps, getClient });

  const orderIdHint = typeof facts.orderIdHint === "string" && ORDER_ID.test(facts.orderIdHint) ? facts.orderIdHint.toLowerCase() : null;
  const notes = [];
  if (sim.simulated_order_id && orderIdHint && lc(sim.simulated_order_id) !== orderIdHint) notes.push("Sato Hub's order id differs from the one the simulation produced; the id is read from the transaction's receipt after it lands.");

  const plan = deepFreeze({
    verified: true,
    verified_at: new Date(now).toISOString(),
    verified_at_ms: now,
    ...planCore,
    fixFee,
    takeAmount,
    feeBps: facts.feeBps,
    feeAmount: facts.feeAmount === undefined || facts.feeAmount === null ? null : asBig(facts.feeAmount, "Sato Hub fee"),
    allowedTakerDst: takerHex,
    allowedTakerKnown: takerKnown,
    orderIdHint,
    approval: { needed: approvalNeeded, token: sized.tokenIn.native ? null : sized.tokenIn.address, spender: DLN_SOURCE, amount: giveAmount, allowance_before: allowance },
    cost,
    limitSpend,
    spendRow,
    simulation: sim,
    signature,
    responseDisclosure: typeof response.disclosure === "string" ? clean(response.disclosure, 400) : null,
  });
  VERIFIED.add(plan);

  const native = getChain(sized.chain).native;
  const display = {
    chain: sized.chain,
    chain_out: sized.chainOut,
    route: "deBridge",
    send: { asset: sized.tokenIn.symbol, amount: unitsToDecimal(giveAmount, sized.tokenIn.decimals), usd: cost.give_usd },
    fix_fee: { asset: native.symbol, amount: unitsToDecimal(fixFee, native.decimals), wei: fixFee.toString(), usd: cost.fee_usd },
    arrives: { asset: sized.tokenOut.symbol, amount: unitsToDecimal(takeAmount, sized.tokenOut.decimals), usd: cost.take_usd, exact: true },
    cost: { usd: cost.cost_usd, pct: cost.cost_pct },
    usd_held_to_limits: limitSpend > 0 ? limitSpend : null,
    unpriced: cost.unpriced,
    sato_fee: { bps: facts.feeBps, tier: "cross_chain", percent: feePercent(facts.feeBps), amount: plan.feeAmount === null ? null : unitsToDecimal(plan.feeAmount, sized.tokenIn.decimals), asset: sized.tokenIn.symbol, recipient: SATO_FEE_RECIPIENT },
    recipient: { address: sized.recipient, chain: sized.chainOut, own: true },
    approval: approvalNeeded ? { token: sized.tokenIn.symbol, address: sized.tokenIn.address, spender: DLN_SOURCE, amount: unitsToDecimal(giveAmount, sized.tokenIn.decimals), exact: true } : null,
    simulation: { source: sim.source, leaves: sim.leaves, native_leaves: sim.native_leaves },
    order_id_hint: orderIdHint,
    filled_by: { allowed_taker_dst: takerHex, short: takerHex === "0x" ? "any solver" : shortHex(takerHex), known: takerKnown },
    prices: cost.prices,
    confirm_reasons: confirm,
    notes: [...(sized.amountIsAll ? [`--amount all is the whole ${sized.tokenIn.symbol} balance on ${labelOf(sized.chain)}.`] : []), ...notes],
  };
  return {
    sized,
    confirm,
    display,
    execute: () => (deps.executeBridge ?? executeBridge)(plan, { ...deps, c: deps.c, policy }),
  };
}

// ---------------------------------------------------------------- execute

/**
 * Sign and send a checked plan under the owner's limits.
 *
 * Order, and what each failure does to the reservation:
 *   reserve (Refused: nothing reserved) -> approve (exact amount, DlnSource, only if short)
 *   -> createSaltedOrder, hash recorded before broadcast -> receipt -> the order id from CreatedOrder -> record "sent".
 * Pending (unknown outcome) keeps the spend counted. Any other failure before the order is signed, a definite node rejection, or a
 * revert gives the reservation back. An approval WE granted is set back to 0 when the order then fails for good.
 * The sequence runs under the chain's swap lock, so a bridge and a swap never interleave. The plan's age is checked when the lock is
 * taken AND again right before the order is signed.
 */
export async function executeBridge(plan, deps = {}) {
  if (!plan || !VERIFIED.has(plan)) throw new Refused([refusal("plan_not_verified", "only a plan that passed the bridge checks can be signed")]);
  return withLock(() => executeLocked(plan, deps), { name: lockName(plan.chain, "swap"), waitMs: deps.lockWaitMs ?? 120_000 });
}

/** The 32-byte amount in a CreatedOrder `affiliateFee` (recipient, 20 bytes, then the amount), 0 when there is none, null when it is neither. */
function affiliateAmount(bytes) {
  const h = String(bytes ?? "0x");
  if (h === "0x") return 0n;
  return /^0x[0-9a-fA-F]{104}$/.test(h) ? BigInt(`0x${h.slice(42)}`) : null;
}

/**
 * The CreatedOrder event DlnSource emitted for THIS order in a receipt: its id, and what it says it carries. The event's giveAmount is
 * what is left AFTER deBridge's percent fee and the affiliate fee come out of the amount that left the wallet (a real order: 3,315,908
 * sent, giveAmount 3,313,256, percentFee 2,652), so the match adds both back and compares with the plan's amount. It also has to be
 * this wallet's order (makerSrc), for the amount asked to take, on the chain and token asked for, paying the address asked for.
 * Null when it is not exactly one event.
 */
export function readCreatedOrder(receipt, plan) {
  try {
    const takeToken = lc(encodeDestAddress(plan.chainOut, plan.tokenOut.address));
    const receiver = lc(encodeDestAddress(plan.chainOut, plan.recipient));
    const found = parseEventLogs({ abi: CREATED_ORDER_EVENT, logs: receipt.logs ?? [], eventName: "CreatedOrder" })
      .filter((l) => same(l.address, DLN_SOURCE))
      .filter((l) => {
        const o = l.args.order;
        const affiliate = affiliateAmount(l.args.affiliateFee);
        return (
          affiliate !== null &&
          o.giveAmount + l.args.percentFee + affiliate === plan.giveAmount &&
          lc(o.makerSrc) === lc(plan.taker) &&
          lc(o.giveTokenAddress) === lc(plan.tokenIn.address) &&
          o.takeAmount === plan.takeAmount &&
          o.takeChainId === BigInt(debridgeChainIdOf(plan.chainOut)) &&
          lc(o.takeTokenAddress) === takeToken &&
          lc(o.receiverDst) === receiver
        );
      });
    return found.length === 1 ? { order_id: lc(found[0].args.orderId), native_fix_fee: found[0].args.nativeFixFee, order: found[0].args.order } : null;
  } catch {
    return null;
  }
}

async function executeLocked(plan, deps) {
  const clock = deps.clock ?? (() => deps.now ?? Date.now());
  const maxAge = deps.maxAgeMs ?? MAX_AGE_MS;
  if (clock() - plan.verified_at_ms > maxAge) {
    throw new Refused([refusal("plan_stale", "the checked bridge is more than two minutes old; plan it again", "120s", plan.verified_at)]);
  }
  const chain = plan.chain;
  const explorerOf = (hash) => explorerTx(chain, hash);
  const c = deps.c ?? clients(undefined, chain);
  assertClientChain(c, chain, "bridge");
  if (!same(c.account.address, plan.taker)) throw new Refused([refusal("taker_mismatch", "the bridge was built for a different wallet than the one signing", plan.taker, c.account.address)]);

  const dec = (units, token) => unitsToDecimal(units, token.decimals);
  const native = getChain(chain).native;
  const entry = await reserve(deps.policy ?? loadPolicy(), {
    kind: "bridge",
    chain,
    chain_out: plan.chainOut,
    ...plan.spendRow,
    to: DLN_SOURCE,
    venue: "debridge",
    asset_in: plan.tokenIn.symbol,
    asset_out: plan.tokenOut.symbol,
    amount_in: dec(plan.giveAmount, plan.tokenIn),
    amount_in_units: plan.giveAmount.toString(),
    take_amount: dec(plan.takeAmount, plan.tokenOut),
    take_amount_units: plan.takeAmount.toString(),
    fix_fee_wei: plan.fixFee.toString(),
    fix_fee: `${dec(plan.fixFee, native)} ${native.symbol}`,
    cost_usd: plan.cost.cost_usd,
    cost_pct: plan.cost.cost_pct,
    sato_fee_bps: plan.feeBps,
    sato_fee_recipient: SATO_FEE_RECIPIENT,
    token_in: plan.tokenIn.address,
    token_out: plan.tokenOut.address,
    recipient: plan.recipient,
    allowed_taker_dst: plan.allowedTakerDst,
    ...(plan.orderIdHint ? { order_id_hint: plan.orderIdHint } : {}),
  });

  let approveTx = null;
  let approvedHere = false;
  let nextNonce;
  const reader = () => readAllowance({ plan, deps, getClient: () => c });

  /** Put an allowance WE granted back to 0. Never throws: the ledger row says what happened. */
  const resetAllowance = async ({ force = false } = {}) => {
    let left = null;
    try {
      if (force) left = plan.giveAmount;
      else {
        left = await reader();
        if (left === 0n) return { state: "none_left" };
      }
      const resetTx = { to: plan.tokenIn.address, data: approveData(0n) };
      const resetGas = evmChain(chain).simulation.exactGasEstimate ? await exactGasLimit(c, chain, resetTx, RESET_GAS, { deps, what: "approval reset" }).catch(() => RESET_GAS_L1_FALLBACK) : undefined;
      const r = await signAndSend(
        c,
        { ...resetTx, ...(nextNonce !== undefined ? { nonce: nextNonce, gas: RESET_GAS } : {}), ...(resetGas !== undefined ? { gas: resetGas } : {}) },
        (hash) => record({ id: entry.id, allowance: "reset_signed", allowance_tx: hash, allowance_spender: DLN_SOURCE }),
        { counted: false, chain },
      );
      if (r.status !== "success") throw new Error(`the reset reverted: ${explorerOf(r.transactionHash)}`);
      record({ id: entry.id, allowance: "reset", allowance_tx: r.transactionHash, allowance_spender: DLN_SOURCE });
      return { state: "reset", tx: r.transactionHash };
    } catch (err) {
      record({ id: entry.id, allowance: "left_open", allowance_left_units: left === null ? null : left.toString(), allowance_spender: DLN_SOURCE, allowance_token: plan.tokenIn.address, allowance_error: errText(err) });
      return { state: "left_open", amount: left, error: errText(err) };
    }
  };
  const withNote = (err, a) => {
    if (a?.state === "reset") err.message += `\nThe ${plan.tokenIn.symbol} approval granted for this bridge was set back to 0 (${explorerOf(a.tx)}).`;
    else if (a?.state === "left_open") err.message += `\nThe ${plan.tokenIn.symbol} approval granted for this bridge could not be set back to 0 (${a.error}). deBridge's DlnSource (${DLN_SOURCE}) may still spend up to ${a.amount === null ? plan.giveAmount : a.amount} base units of ${plan.tokenIn.symbol}; the owner can reset it with an approve(DlnSource, 0) transaction.`;
    return err;
  };
  const pendingRow = (step, err) => record({ id: entry.id, status: "pending", step, reason: "outcome unknown", tx: err.details?.tx ?? undefined });

  // --- approval (exact amount, DlnSource, only when the allowance is short)
  let current = plan.tokenIn.native ? null : undefined;
  if (current === undefined) {
    try {
      current = await reader();
    } catch (err) {
      release(entry, "failed before signing", { error: errText(err) });
      throw err;
    }
  }
  if (current !== null && current < plan.giveAmount) {
    let r;
    try {
      const approveTx0 = { to: plan.tokenIn.address, data: approveData(plan.giveAmount) };
      const approveGas = evmChain(chain).simulation.exactGasEstimate ? { gas: await exactGasLimit(c, chain, approveTx0, SIM_GAS_APPROVE, { deps, what: "approval" }) } : {};
      r = await signAndSend(c, { ...approveTx0, ...approveGas }, (hash) => {
        approveTx = hash;
        record({ id: entry.id, status: "approval_signed", step: "approve", tx: hash, approve_tx: hash });
      }, { chain });
    } catch (err) {
      if (err instanceof Pending) pendingRow("approve", err);
      else release(entry, err instanceof Rejected ? "approval rejected; never landed" : "failed before broadcast", { error: errText(err) });
      throw err;
    }
    if (r.status !== "success") {
      release(entry, "approval reverted onchain", { tx: r.transactionHash });
      throw new Error(`the approval reverted: ${explorerOf(r.transactionHash)}`);
    }
    approvedHere = true;
    if (Number.isInteger(r.sentNonce)) nextNonce = r.sentNonce + 1;
    record({ id: entry.id, status: "approved", step: "approve", approve_tx: r.transactionHash });
  }

  // --- the order. The approval wait can take a while, so the plan's age is checked again right before signing.
  if (clock() - plan.verified_at_ms > maxAge) {
    release(entry, "plan expired before the order was signed", { plan_verified_at: plan.verified_at });
    const expired = new Refused([refusal("plan_expired", "the checked bridge became more than two minutes old while the approval was going through, so the order was not signed; plan it again", "120s", plan.verified_at)]);
    throw approvedHere ? withNote(expired, await resetAllowance({ force: true })) : expired;
  }
  const afterApproval = nextNonce !== undefined ? { nonce: nextNonce, gas: swapGasLimit({ chain, simulation: { gas_used: plan.simulation.gas_used } }) } : {};
  let receipt;
  try {
    const orderTx = { to: plan.tx.to, data: plan.tx.data, value: plan.tx.value };
    const orderGas = evmChain(chain).simulation.exactGasEstimate ? { gas: await exactGasLimit(c, chain, orderTx, swapGasLimit({ chain, simulation: { gas_used: plan.simulation.gas_used } }), { deps, what: "bridge order" }) } : {};
    receipt = await signAndSend(c, { ...orderTx, ...afterApproval, ...orderGas }, (hash) => record({ id: entry.id, status: "signed", step: "order", tx: hash }), { chain });
  } catch (err) {
    if (err instanceof Pending) {
      pendingRow("order", err);
      throw err; // may still land: stays counted, allowance untouched
    }
    release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: errText(err) });
    throw approvedHere ? withNote(err, await resetAllowance({ force: true })) : err;
  }
  if (nextNonce !== undefined) nextNonce += 1;
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    const err = new Error(`transaction reverted: ${explorerOf(receipt.transactionHash)}`);
    throw approvedHere ? withNote(err, await resetAllowance({ force: true })) : err;
  }

  // --- sent: the order exists on the source chain and waits for a solver. Its id comes from the receipt.
  const warnings = [];
  const created = readCreatedOrder(receipt, plan);
  let orderId = null;
  let orderIdSource = null;
  if (created) {
    orderId = created.order_id;
    orderIdSource = "log";
    if (created.native_fix_fee !== plan.fixFee) warnings.push(`the order's event reports a fixed fee of ${dec(created.native_fix_fee, native)} ${native.symbol}, not the ${dec(plan.fixFee, native)} ${native.symbol} the kit checked`);
    if (plan.orderIdHint && plan.orderIdHint !== orderId) warnings.push("Sato Hub's order id differs from the one in the receipt; the receipt's is used");
  } else if (plan.orderIdHint) {
    orderId = plan.orderIdHint;
    orderIdSource = "sato_hub";
    warnings.push("the order id could not be read from the receipt; this one is from Sato Hub and is not confirmed by the chain");
  } else {
    warnings.push("the order id could not be read from the receipt; `bridge status` will look it up from the transaction");
  }
  record({
    id: entry.id,
    status: "sent",
    sent_at: new Date().toISOString(),
    tx: receipt.transactionHash,
    order_id: orderId,
    order_id_source: orderIdSource,
    ...(approveTx ? { approve_tx: approveTx } : {}),
    ...(warnings.length ? { warnings } : {}),
  });

  let allowance = null;
  if (approvedHere) {
    allowance = await resetAllowance(); // none_left in the normal case; resets what DlnSource did not take
    if (allowance.state === "left_open") warnings.push(`an approval of ${plan.tokenIn.symbol} to DlnSource is still open: ${allowance.error}`);
  }
  return {
    tx: receipt.transactionHash,
    explorer: explorerOf(receipt.transactionHash),
    approve_tx: approveTx,
    chain,
    chain_out: plan.chainOut,
    state: "sent",
    order_id: orderId,
    order_id_source: orderIdSource,
    sent: { asset: plan.tokenIn.symbol, amount: dec(plan.giveAmount, plan.tokenIn) },
    fix_fee: { asset: native.symbol, amount: dec(plan.fixFee, native) },
    arrives: { asset: plan.tokenOut.symbol, amount: dec(plan.takeAmount, plan.tokenOut), exact: true, chain: plan.chainOut },
    recipient: plan.recipient,
    usd: plan.limitSpend > 0 ? plan.limitSpend : null,
    sato_fee: { bps: plan.feeBps, recipient: SATO_FEE_RECIPIENT },
    allowance: allowance?.state ?? null,
    warnings,
  };
}

// ---------------------------------------------------------------- the approval gate

/** A NeedsApproval that also says, in plain words, why a bridge within the limits still needs the owner. */
async function needsApproval(intent, reasons) {
  const err = new NeedsApproval(intent, await requestApproval(intent));
  if (reasons.length) {
    err.reasons = reasons.map((r) => r.text);
    err.message = `This bridge needs the owner's approval even though the agent acts within its limits, because:\n${reasons.map((r) => `  - ${r.text}`).join("\n")}\n${err.message}`;
  }
  err.fee_line = `Sato Hub fee: up to ${feePercent(BRIDGE_FEE_CEILING_BPS)} (${BRIDGE_FEE_CEILING_BPS} bps, cross-chain), taken from the amount sent, plus deBridge's fixed fee in ${getChain(intent.chain).native.symbol}.`;
  err.message = `${err.message}\n${err.fee_line}`;
  return err;
}

/**
 * The whole path of a bridge up to (not including) signing, with the owner's approval where it is due:
 *   1. size it and check the owner's choices;
 *   2. before the order is asked for: the owner's approval in ask mode;
 *   3. ask Sato Hub, check and simulate the order;
 *   4. after the order: any reason only the order shows (a cost above 3% of what is moved, a coin with no independent price)
 *      needs the owner's approval too, even in auto mode. That approval names the reasons, so a code only fits a bridge with those.
 * Throws NeedsApproval (exit 5) when the owner must approve, Refused (exit 3) when the limits or a check stop it.
 * `approve` is the code from `--approve`. A dry run asks nobody and spends nothing; it reports what would need approval.
 * Returns { sized, prepared, confirm } where prepared.execute() signs.
 */
export async function runBridge(req, { approve, dryRun = false } = {}, deps = {}) {
  const sized = await sizeBridge(req, deps);
  const policy = deps.policy ?? loadPolicy();
  const ask = policy?.approval === "ask";
  let codeFree = Boolean(approve);
  let deferred = null;
  let firstIntent = null;
  if (!dryRun && ask) {
    firstIntent = bridgeIntent(sized, []);
    if (!approve) throw await needsApproval(firstIntent, []);
    try {
      await consumeApproval(approve, firstIntent);
      codeFree = false;
    } catch (err) {
      // The code may be one given for the order-time intent (reasons only the order showed): look again after the order.
      if (!/different intent/.test(err.message)) throw err;
      deferred = err;
    }
  }
  const prepared = await planBridge(req, { ...deps, sized, policy });
  const added = prepared.confirm;
  if (!dryRun && added.length) {
    const intent = bridgeIntent(sized, added.map((r) => r.code));
    if (!codeFree) throw await needsApproval(intent, added);
    try {
      await consumeApproval(approve, intent);
    } catch (err) {
      // The code was for what the owner saw before (another cost band): nothing is signed; the owner is asked again with these figures.
      if (!/different intent/.test(err.message)) throw err;
      throw await needsApproval(intent, added);
    }
  } else if (deferred) {
    // The code was given for reasons this order no longer shows, and the owner's approval is still due in ask mode: ask again, cleanly.
    throw await needsApproval(firstIntent, []);
  }
  return { sized, prepared, confirm: prepared.confirm };
}

// ---------------------------------------------------------------- display

/** The lines a bridge is shown to the owner in (outside text is cleaned by the caller). */
export function bridgeLines(d) {
  const src = labelOf(d.chain);
  const dst = labelOf(d.chain_out);
  const usd = (n) => (typeof n === "number" ? ` (about $${money(n)})` : "");
  const lines = [];
  lines.push(`Bridge ${src} -> ${dst} via ${d.route}.`);
  lines.push(`Leaves the wallet on ${src}: ${d.send.amount} ${d.send.asset}${usd(d.send.usd)}, plus deBridge's fixed fee of ${d.fix_fee.amount} ${d.fix_fee.asset}${usd(d.fix_fee.usd)}.`);
  lines.push(`Arrives on ${dst}: exactly ${d.arrives.amount} ${d.arrives.asset}${usd(d.arrives.usd)}, when a solver fills the order (usually under a minute). The order is filled for exactly that amount or not at all.`);
  if (d.cost?.usd !== null && d.cost?.usd !== undefined && d.cost.usd < 0) lines.push(`Total cost: none by the kit's prices; the order pays out more than it costs, which a fair order does not.`);
  else if (d.cost?.usd !== null && d.cost?.usd !== undefined) lines.push(`Total cost: about $${money(d.cost.usd)}, which is ${d.cost.pct}% of what leaves the wallet (the fixed fee, Sato Hub's fee and deBridge's costs on ${dst}).`);
  else lines.push(`Total cost: not known, because ${orList(d.unpriced ?? [])} has no independent price in this kit.`);
  lines.push(`Sato Hub fee: ${d.sato_fee.percent} (${d.sato_fee.bps} bps, cross-chain), taken from the amount sent; Sato Hub receives it once the order is filled, not before.${d.sato_fee.amount !== null && d.sato_fee.amount !== undefined ? ` That is ${d.sato_fee.amount} ${d.sato_fee.asset}.` : ""}`);
  lines.push(`Recipient: this bot's own address on ${dst} (${d.recipient.address}).`);
  if (d.filled_by) lines.push(`Filled by: ${d.filled_by.short}${d.filled_by.allowed_taker_dst === "0x" ? " may fill it" : d.filled_by.known ? " (a deBridge solver this kit has seen)" : " (a solver this kit has not seen deBridge use)"}.`);
  if (d.approval) lines.push(`Approval before the order: exactly ${d.approval.amount} ${d.approval.token} to deBridge's DlnSource ${d.approval.spender} (never unlimited), set back to 0 afterwards.`);
  if (d.usd_held_to_limits !== null && d.usd_held_to_limits !== undefined) lines.push(`Held to your limits as $${money(d.usd_held_to_limits)} (the amount and the fixed fee), shared with swaps and sends.`);
  lines.push(`The kit's own simulation passed: ${JSON.stringify(d.simulation)}`);
  for (const n of d.notes ?? []) lines.push(n);
  if (d.confirm_reasons?.length) lines.push(`Needs the owner's approval before it is signed, because: ${d.confirm_reasons.map((r) => r.text).join("; ")}.`);
  return lines;
}

// ---------------------------------------------------------------- status

/** deBridge's order statuses, in the words the owner reads, and what the ledger row becomes. */
const STATUS_WORDS = Object.freeze({
  None: { state: "unknown_order", ledger: null },
  Created: { state: "waiting", ledger: "sent" },
  Fulfilled: { state: "filled", ledger: "filled" },
  SentUnlock: { state: "filled", ledger: "filled" },
  ClaimedUnlock: { state: "filled", ledger: "filled" },
  OrderCancelled: { state: "cancelled", ledger: "cancelled" },
  SentOrderCancel: { state: "cancelled", ledger: "cancelled" },
  ClaimedOrderCancel: { state: "cancelled", ledger: "cancelled" },
});

/** The plain sentence for a deBridge status on one row. Never guesses: a status this kit does not know is said as it came. */
export function describeStatus(status, row) {
  const dst = labelOf(row.chain_out);
  const src = labelOf(row.chain);
  switch (status) {
    case "Created":
      return "waiting for a solver to fill it";
    case "Fulfilled":
    case "SentUnlock":
    case "ClaimedUnlock":
      return `arrived on ${dst}`;
    case "OrderCancelled":
    case "SentOrderCancel":
      return `cancelled; the refund on ${src} is on its way`;
    case "ClaimedOrderCancel":
      return `cancelled; refunded on ${src}`;
    case "None":
      return "deBridge has no record of this order yet";
    default:
      return `deBridge reports "${clean(status, 40)}", which this kit does not know; open the explorer link`;
  }
}

async function getJson(url, deps) {
  const f = deps.fetch ?? fetch;
  try {
    const res = await f(url, { headers: { accept: "application/json", "user-agent": userAgent() }, signal: AbortSignal.timeout(deps.apiTimeoutMs ?? API_TIMEOUT_MS) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    return { error: errText(err) };
  }
}

/** deBridge's answer for an order id: { status } | { unknown: true } | { unavailable: true, error }. */
async function fetchOrderStatus(orderId, deps) {
  const r = await getJson(`${DLN_API}/order/${orderId}/status`, deps);
  if (r.error) return { unavailable: true, error: r.error };
  if (r.status === 200 && typeof r.body?.status === "string") return { status: r.body.status };
  if (r.status === 400 && r.body?.errorId === "UNKNOWN_ORDER") return { unknown: true };
  return { unavailable: true, error: `HTTP ${r.status}${r.body?.errorMessage ? `: ${clean(r.body.errorMessage, 120)}` : ""}` };
}

/** The orders a source transaction created, from deBridge: { ids: [...] } | { unavailable: true, error }. */
async function fetchOrderIds(txHash, deps) {
  const r = await getJson(`${DLN_API}/tx/${txHash}/order-ids`, deps);
  if (r.error) return { unavailable: true, error: r.error };
  if (r.status === 200 && Array.isArray(r.body?.orderIds)) return { ids: r.body.orderIds.filter((x) => typeof x === "string" && ORDER_ID.test(x)).map(lc) };
  return { unavailable: true, error: `HTTP ${r.status}${r.body?.errorMessage ? `: ${clean(r.body.errorMessage, 120)}` : ""}` };
}

const TERMINAL = new Set(["filled", "failed"]);

/** One ledger row (or a bare order id) made current: asks deBridge when the order is still in flight, and updates the row. */
async function refreshRow(row, deps) {
  const view = {
    id: row.id ?? null,
    chain: row.chain ?? null,
    chain_out: row.chain_out ?? null,
    asset_in: row.asset_in ?? null,
    amount_in: row.amount_in ?? null,
    asset_out: row.asset_out ?? null,
    take_amount: row.take_amount ?? null,
    usd: row.usd ?? null,
    order_id: row.order_id ?? null,
    order_id_source: row.order_id_source ?? null,
    ledger_status: row.status ?? null,
    debridge_status: row.debridge_status ?? null,
    tx: row.tx ?? null,
    explorer: row.explorer ?? null,
    state: "unknown",
    plain: "",
    checked: false,
    error: null,
  };
  const status = row.status;
  const cancelFinal = status === "cancelled" && row.debridge_status === "ClaimedOrderCancel";
  if (TERMINAL.has(status) || cancelFinal) {
    view.state = status === "filled" ? "filled" : status === "failed" ? "not_sent" : "cancelled";
    view.plain = status === "filled" ? `arrived on ${labelOf(row.chain_out)}` : status === "failed" ? `did not go out${row.reason ? ` (${clean(row.reason, 80)})` : ""}; nothing is left in flight` : describeStatus("ClaimedOrderCancel", row);
    return view;
  }
  if (status === "submitted" || status === "approval_signed" || status === "approved") {
    view.state = "not_sent";
    view.plain = status === "submitted" ? "reserved, but no order was signed; if the command stopped, nothing was sent (it stays counted against the limits for 24 hours)" : "the approval was sent, but no order was signed";
    return view;
  }
  // signed / pending / sent / cancelled-not-final: ask deBridge.
  let orderId = row.order_id;
  // An id read from the transaction's own event (or already confirmed by deBridge) is used as it is. An id that is only Sato Hub's word
  // (the event could not be read), or none, is checked against what deBridge lists for the source transaction before the order is ever
  // marked filled: Sato Hub could name another order, one that is filled, and the ledger would say this one arrived.
  const confirmed = row.order_id_source === "log" || row.order_id_source === "debridge_api";
  if ((!orderId || !confirmed) && row.tx) {
    const ids = await fetchOrderIds(row.tx, deps);
    if (ids.unavailable) {
      view.state = "unavailable";
      view.plain = `deBridge's status service did not answer (${clean(ids.error, 100)}); the order may be fine. Try again in a minute, or open the explorer link`;
      view.error = ids.error;
      return view;
    }
    const mine = orderId && ids.ids.includes(lc(orderId)) ? lc(orderId) : null;
    if (mine || ids.ids.length === 1) {
      const given = orderId;
      orderId = mine ?? ids.ids[0];
      view.order_id = orderId;
      view.order_id_source = "debridge_api";
      if (given && lc(given) !== orderId) view.plain_note = `deBridge lists ${orderId} for this transaction, not the ${clean(given, 80)} Sato Hub named; the one deBridge lists is used`;
      if (row.id) record({ id: row.id, order_id: orderId, order_id_source: "debridge_api", ...(given && lc(given) !== orderId ? { order_id_hint: given, warnings: [view.plain_note] } : {}), ...(["signed", "pending"].includes(status) ? { status: "sent" } : {}) });
    } else {
      view.state = "unconfirmed";
      view.plain = ids.ids.length ? "deBridge lists more than one order for this transaction; open the explorer link" : "deBridge does not list an order for this transaction yet, so the order id cannot be confirmed; the transaction may not have landed. Do NOT retry; check the explorer link";
      return view;
    }
  }
  if (!orderId) {
    view.state = "unconfirmed";
    view.plain = "no transaction or order id is recorded for this bridge; check the wallet on the explorer";
    return view;
  }
  const s = await fetchOrderStatus(orderId, deps);
  if (s.unavailable) {
    view.state = "unavailable";
    view.plain = `deBridge's status service did not answer (${clean(s.error, 100)}); the order may be fine. Try again in a minute, or open the explorer link`;
    view.error = s.error;
    return view;
  }
  view.checked = true;
  if (s.unknown) {
    view.state = "waiting";
    view.plain = "deBridge has not listed this order yet (it can take a few seconds after the transaction lands)";
    return view;
  }
  const known = STATUS_WORDS[s.status];
  view.debridge_status = s.status;
  view.state = known ? known.state : "unknown";
  view.plain = describeStatus(s.status, row);
  if (s.status === "Created") {
    const since = Date.parse(row.sent_at ?? row.first_ts ?? "");
    const minutes = Number.isFinite(since) ? Math.floor(((deps.now ?? Date.now()) - since) / 60_000) : 0;
    if (minutes >= STUCK_AFTER_MINUTES) {
      const dst = labelOf(row.chain_out);
      view.stuck = true;
      view.plain = `not filled after ${minutes} minutes. This bot's own address on ${dst} is the order's authority, so it can cancel the order on deBridge (app.debridge.finance) and get the refund on ${labelOf(row.chain)}; that needs a little ${getChain(row.chain_out).native.symbol} for gas on ${dst}. This kit has no cancel command yet. Do NOT send the bridge again meanwhile`;
    }
  }
  // The ledger follows deBridge: only a change is written. A filled order is the one that stops being in flight.
  if (row.id && (s.status !== row.debridge_status || (known?.ledger && known.ledger !== status))) {
    record({ id: row.id, debridge_status: s.status, ...(known?.ledger ? { status: known.ledger } : {}), status_checked_at: new Date().toISOString() });
    if (known?.ledger) view.ledger_status = known.ledger;
  }
  return view;
}

/**
 * The bridges in the ledger, made current. With `id` (a ledger id or its first characters, an order id or a source transaction), just
 * that one; with none, every bridge in flight and the latest few. deBridge being down is said, never turned into a guess.
 * Returns { bridges: [view], note }.
 */
export async function bridgeStatus({ id } = {}, deps = {}) {
  const rows = actions().filter((a) => a.kind === "bridge");
  const query = id === undefined || id === null ? "" : String(id).trim();
  let chosen;
  if (query) {
    const q = lc(query);
    chosen = rows.filter((r) => r.id === query || (q.length >= 6 && lc(r.id ?? "").startsWith(q)) || lc(r.order_id ?? "") === q || lc(r.tx ?? "") === q);
    if (!chosen.length) {
      if (!ORDER_ID.test(query)) throw new Error(`no bridge in this wallet's ledger matches "${clean(query, 80)}"; \`bridge status\` lists them`);
      // An order id that is not in this ledger: asked of deBridge as it is, nothing is written.
      const s = await fetchOrderStatus(q, deps);
      const view = { id: null, order_id: q, order_id_source: "given", foreign: true, state: s.unavailable ? "unavailable" : s.unknown ? "unknown" : (STATUS_WORDS[s.status]?.state ?? "unknown"), debridge_status: s.status ?? null, checked: !s.unavailable, error: s.error ?? null };
      view.plain = s.unavailable ? `deBridge's status service did not answer (${clean(s.error, 100)})` : s.unknown ? "deBridge has no record of this order id" : describeStatus(s.status, { chain: "base", chain_out: "base" }).replace(/arrived on Base/, "arrived on its destination").replace(/refund on Base/, "refund on its source chain").replace(/refunded on Base/, "refunded on its source chain");
      return { bridges: [view], note: "This order id is not in this wallet's ledger; nothing was written." };
    }
  } else {
    const inFlight = rows.filter((r) => !TERMINAL.has(r.status));
    const recent = rows.slice(-5);
    chosen = [...new Map([...recent, ...inFlight].map((r) => [r.id, r])).values()];
    chosen.sort((a, b) => String(a.first_ts).localeCompare(String(b.first_ts)));
  }
  const bridges = [];
  for (const row of chosen) bridges.push(await refreshRow(row, deps));
  return { bridges, note: bridges.some((b) => b.state === "unavailable") ? "deBridge's status service did not answer for at least one order. The orders are not lost; ask again in a minute." : null };
}

/** The lines `bridge status` prints. Ledger text is cleaned, one line each. */
export function bridgeStatusLines({ bridges, note }) {
  if (!bridges.length) return ["(no bridges yet)"];
  const lines = [];
  for (const b of bridges) {
    const route = b.chain && b.chain_out ? `${labelOf(b.chain)} -> ${labelOf(b.chain_out)}` : "an order";
    const what = b.asset_in ? `${clean(b.amount_in, 30)} ${clean(b.asset_in, 20)} -> ${clean(b.take_amount, 30)} ${clean(b.asset_out, 20)}` : "";
    lines.push(`${b.id ? `${clean(b.id, 8)}  ` : ""}${route}${what ? `  ${what}` : ""}: ${b.plain}`);
    if (b.plain_note) lines.push(`    note: ${clean(b.plain_note, 300)}`);
    if (b.explorer) lines.push(`    source transaction: ${clean(b.explorer, 200)}`);
    if (b.order_id) lines.push(`    order: ${clean(b.order_id, 80)}${b.order_id_source === "sato_hub" ? " (from Sato Hub; not confirmed by the chain)" : ""}`);
  }
  if (note) lines.push(note);
  return lines;
}

/** One ledger row of a bridge for `history` and `status`. */
export function bridgeRowText(a) {
  const route = a.chain && a.chain_out ? `${a.chain}->${a.chain_out}` : "bridge";
  const what = a.asset_in ? ` ${clean(a.amount_in, 30)} ${clean(a.asset_in, 20)} -> ${clean(a.take_amount, 30)} ${clean(a.asset_out, 20)}` : "";
  return `${route}${what}${a.order_id ? ` order ${clean(a.order_id, 80)}` : ""}`;
}
