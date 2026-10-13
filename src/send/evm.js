// `send --asset` on an EVM chain: the native coin (ETH, BNB, POL), a registry stablecoin, the wrapped native, or ANY ERC-20 by its
// contract address. The token's decimals and symbol are read from the chain (src/swap/evm.js resolveBaseToken), never from a resolver.
//
//   plan     resolve the asset, read the balance, work out the amount (`all` keeps a gas reserve for the native coin), put the
//            USD figure the limits see on it, and run the transfer through the kit's own eth_simulateV1: a revert is refused, and
//            what the RECIPIENT ends up holding is read from the simulation, so a token that takes a fee on transfer is shown
//   execute  reserve against the limits, sign locally, record the hash, broadcast, wait: the same contract as `sendStable`
//            (src/base.js), and a send is never retried.
//
// USD for the limits: a stablecoin 1:1 (decimals-aware); the native coin and the wrapped native from the Chainlink feed (no feed, no
// send); any other token has NO price here: it counts $0 against the limits and is recorded `usd: null`, `unpriced: true`. It is
// never refused for lacking a price, and nothing asks any venue for a quote.

import { encodeFunctionData, erc20Abi, isAddress, zeroAddress } from "viem";
import { Pending, Rejected } from "../errors.js";
import { assertClientChain, clients, signAndSend } from "../base.js";
import { NATIVE_PLACEHOLDER, evmChain, explorerTx, isStableSymbol, sendL1ReserveWei } from "../chains.js";
import { loadPolicy } from "../policy.js";
import { record, release, reserve } from "../ledger.js";
import { PriceUnavailable, oraclePrice } from "../price.js";
import { stableUnits, unitsToText, unitsToUsd } from "../amount.js";
import { assetDeltas, cleanTokenText, defaultSimulate, exactGasLimit, resolveBaseToken } from "../swap/evm.js";
import { ledgerSpend, refuse, tokenLabel, usdUp } from "./common.js";

const lc = (s) => String(s).toLowerCase();
const errText = (err) => String(err?.shortMessage || err?.message || err);
/** Gas limits the simulation gives each call: a plain transfer, and a token's. (Without one the node assumes a whole block's gas.) */
const SIM_GAS_NATIVE = 200_000n;
const SIM_GAS_TOKEN = 300_000n;
const SIM_GAS_READ = 100_000n;
/** A plain value transfer to an account with no code costs exactly this. */
export const EOA_TRANSFER_GAS = 21_000n;
/** What `all` reserves gas for when the recipient is a contract (a deposit forwarder, a multisig): its receive function can use more. */
export const CONTRACT_RECIPIENT_GAS = 150_000n;
/** The gas an `--amount all` of the native coin keeps is this many times what the transfer costs at the fee the node quotes now. */
export const GAS_RESERVE_FACTOR = 2n;

/** The asset a send names, read from the chain. No `--asset` means the chain's default stablecoin. */
export async function resolveEvmAsset(chain, raw, deps = {}) {
  const spec = evmChain(chain);
  const input = raw === undefined || raw === null || raw === "" ? spec.defaultStable : String(raw).trim();
  let t;
  try {
    t = await resolveBaseToken(input, { chain, ...(deps.c ? { c: deps.c } : {}) });
  } catch (err) {
    if (err instanceof Error && !err.refusals) throw new Error(`--asset: ${err.message}`);
    throw err;
  }
  if (!t.major) {
    const symbol = cleanTokenText(t.symbol, 24);
    return { kind: "token", symbol, name: t.name ?? null, address: t.address, decimals: t.decimals, label: tokenLabel(symbol, t.address), id: t.address };
  }
  const kind = t.native ? "native" : isStableSymbol(chain, t.symbol) ? "stable" : "wrapped";
  return { kind, symbol: t.symbol, name: t.name ?? null, address: t.native ? null : t.address, decimals: t.decimals, label: t.symbol, id: t.symbol };
}

/** The fee per gas a transaction would be quoted now (the most it can be charged per unit): EIP-1559 `maxFeePerGas`, else the legacy gas price. */
async function feePerGas(c, deps) {
  if (deps.maxFeePerGas !== undefined) return BigInt(deps.maxFeePerGas);
  let price;
  try {
    const f = await c.pub.estimateFeesPerGas();
    price = f.maxFeePerGas ?? f.gasPrice;
  } catch {
    try {
      price = await c.pub.getGasPrice();
    } catch {
      /* handled below */
    }
  }
  if (typeof price !== "bigint" || price <= 0n) throw refuse("gas_price_unavailable", "the node would not say what gas costs right now, so the gas for this send cannot be worked out; nothing was signed");
  return price;
}

const callOk = (call) => call?.status === "0x1" || call?.status === 1 || call?.status === "0x01";
const uintOf = (hex) => {
  try {
    return typeof hex === "string" && /^0x[0-9a-fA-F]+$/.test(hex) ? BigInt(hex) : null;
  } catch {
    return null;
  }
};
/** A uint256 a call returned (a balance), or null when the call failed or returned something else. */
const returnedUint = (call) => (callOk(call) && typeof call.returnData === "string" && call.returnData.length >= 66 ? uintOf(call.returnData.slice(0, 66)) : null);

function revertText(call) {
  const msg = call?.error?.message ?? call?.error?.data ?? null;
  if (msg) return String(msg).slice(0, 200);
  const rd = call?.returnData;
  if (typeof rd === "string" && rd.startsWith("0x08c379a0") && rd.length >= 138) {
    try {
      const len = Number(BigInt(`0x${rd.slice(74, 138)}`));
      return Buffer.from(rd.slice(138, 138 + len * 2), "hex").toString("utf8").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 200);
    } catch {
      /* fall through */
    }
  }
  return "no reason given";
}

/** Run the calls through the kit's own eth_simulateV1 (or the injected one). Never signs without one. */
async function simulate({ c, chain, calls, deps }) {
  const spec = evmChain(chain);
  let raw;
  try {
    raw = await (deps.simulate ?? defaultSimulate)({ taker: c.account.address, calls, c });
  } catch (err) {
    const why = String(err.details || err.shortMessage || err.message);
    if (/insufficient funds/i.test(why)) {
      throw refuse(`not_enough_${spec.native.symbol.toLowerCase()}`, `the wallet does not hold enough ${spec.native.symbol} on ${spec.label} for this send's gas; add a little ${spec.native.symbol} on ${spec.label} and try again (nothing was signed)`, null, why.slice(0, 160));
    }
    throw refuse("simulation_unavailable", `this kit's own simulation could not run (${why.slice(0, 200)}); it never signs without one`);
  }
  const blocks = Array.isArray(raw) ? raw : [raw];
  const got = blocks.every((b) => Array.isArray(b?.calls)) ? blocks.flatMap((b) => b.calls) : null;
  if (!got || got.length !== calls.length) throw refuse("simulation_unavailable", "this kit's own simulation returned an answer it cannot read; it never signs without one");
  return got;
}

const balanceOfData = (who) => encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who] });

/**
 * Work out one send and prove it would go through. Reads the chain; reserves, signs and sends nothing.
 *
 * req:  { chain, to, amount ("1.5" | "all"), asset (a symbol, a 0x address or the native placeholder; none = the chain's default stable) }
 * deps: { c (a client), oraclePrice, simulate, maxFeePerGas }  (tests)
 *
 * plan = { chain, to, asset, all, units, amountText, usd, unpriced, valuation, received, notes, powers, stays, gas, tx }
 */
export async function planEvmSend({ chain, to, amount, asset: rawAsset }, deps = {}) {
  const spec = evmChain(chain);
  if (!isAddress(to)) throw new Error(`not a ${spec.label} address: ${to}`);
  if (lc(to) === zeroAddress) throw refuse("recipient_zero_address", "the zero address is where tokens are burned; nothing was signed", null, to);
  const c = deps.c ?? clients(undefined, chain);
  assertClientChain(c, chain, "send");
  const me = c.account.address;

  const asset = await resolveEvmAsset(chain, rawAsset, { ...deps, c });
  if (asset.address && lc(asset.address) === lc(to)) {
    throw refuse("recipient_is_token_contract", `${to} is the contract of ${asset.label} itself; tokens sent to it cannot be taken back. Ask the owner for the recipient's own address.`, null, to);
  }
  const native = asset.kind === "native";
  const all = /^all$/i.test(String(amount));

  // The balance of what is being sent.
  let balance;
  try {
    balance = native ? await c.pub.getBalance({ address: me }) : BigInt(await c.pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [me] }));
  } catch (err) {
    throw new Error(`could not read the wallet's ${asset.label} balance on ${spec.label} (${errText(err).slice(0, 160)}); nothing was signed`);
  }

  // A coin with a price feed is priced from it, or not sent: the same rule as the swaps.
  let oracle = null;
  if (native || asset.kind === "wrapped") {
    try {
      oracle = await (deps.oraclePrice ?? oraclePrice)(spec.native.oracle, { chain });
    } catch (err) {
      if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent ${spec.native.oracle} price right now (${err.message}); the kit does not send ${asset.symbol} without one`);
      throw err;
    }
  }

  // The amount. `all` of the native coin leaves a gas reserve: what the transfer costs at the fee the node quotes now, times a safety
  // factor, plus a fixed pad where the gas includes a cost of posting data to Ethereum (the registry's `sendReserve`).
  let feeCap = null;
  let units;
  let reserveWei = 0n;
  // A plain transfer to an account with no code costs exactly 21,000 gas; a contract recipient (a deposit forwarder, a multisig) can use more.
  let hasCode = false;
  if (native) {
    feeCap = await feePerGas(c, deps);
    try {
      const code = await c.pub.getCode({ address: to });
      hasCode = Boolean(code && code !== "0x");
    } catch {
      hasCode = true; // unknown: reserve for the larger cost
    }
  }
  if (all) {
    if (native) {
      let g = hasCode ? CONTRACT_RECIPIENT_GAS : EOA_TRANSFER_GAS;
      if (spec.simulation.exactGasEstimate) g = await exactGasLimit(c, chain, { to, value: 1n }, g, { deps, what: "send" });
      reserveWei = g * feeCap * GAS_RESERVE_FACTOR + sendL1ReserveWei(chain);
      units = balance - reserveWei;
      if (units <= 0n) {
        throw refuse("nothing_to_send", `the wallet holds ${unitsToText(balance, asset.decimals)} ${asset.symbol} on ${spec.label}; after keeping about ${unitsToText(reserveWei, asset.decimals)} ${asset.symbol} for gas, nothing would be left to send`, null, unitsToText(balance, asset.decimals));
      }
    } else {
      units = balance;
      if (units <= 0n) throw refuse("no_balance", `the wallet holds none of ${asset.label} on ${spec.label}, so there is nothing to send`);
    }
  } else {
    units = stableUnits(amount, asset.decimals, asset.symbol);
    if (units > balance) {
      throw refuse("insufficient_balance", `the wallet holds ${unitsToText(balance, asset.decimals)} ${asset.label} on ${spec.label}, less than the ${unitsToText(units, asset.decimals)} asked for; nothing was signed`, unitsToText(balance, asset.decimals), unitsToText(units, asset.decimals));
    }
  }

  // The transfer, simulated. A token's is bracketed by balance reads of the sender and the recipient in the same simulated block.
  let calls;
  let tx;
  if (native) {
    tx = { to, value: units };
    // The simulation checks the wallet can pay gas x fee on top of the value, so the gas it is given must fit what `all` kept.
    calls = [{ to, data: "0x", value: units, gas: !hasCode ? EOA_TRANSFER_GAS : all ? CONTRACT_RECIPIENT_GAS : SIM_GAS_NATIVE }];
  } else {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
    tx = { to: asset.address, data, value: 0n };
    const read = (who) => ({ to: asset.address, data: balanceOfData(who), value: 0n, gas: SIM_GAS_READ });
    calls = [read(me), read(to), { to: asset.address, data, value: 0n, gas: SIM_GAS_TOKEN }, read(me), read(to)];
  }
  const got = await simulate({ c, chain, calls, deps });
  const xfer = got[native ? 0 : 2];
  if (!callOk(xfer)) throw refuse("send_would_fail", `this transfer would revert (${revertText(xfer)}); nothing was signed`, null, revertText(xfer));

  // What the recipient ends up holding. A token: its balance before and after in the simulation, else the Transfer logs. The
  // native coin: the traced transfer (a node that does not trace it leaves this unknown, and the plan says so).
  const logs = assetDeltas([xfer], me).received;
  let received = null;
  if (native) {
    received = logs.get(lc(to))?.get(lc(NATIVE_PLACEHOLDER)) ?? null;
  } else {
    const [sender0, to0, , sender1, to1] = got.map(returnedUint);
    if (to0 !== null && to1 !== null) received = to1 > to0 ? to1 - to0 : 0n;
    else received = logs.get(lc(to))?.get(lc(asset.address)) ?? null;
    if (sender0 !== null && sender1 !== null && sender0 > sender1 && sender0 - sender1 > units) {
      throw refuse("send_takes_more", `this token would take ${unitsToText(sender0 - sender1, asset.decimals)} from the wallet for a send of ${unitsToText(units, asset.decimals)}; nothing was signed`, unitsToText(units, asset.decimals), unitsToText(sender0 - sender1, asset.decimals));
    }
  }
  if (received !== null && received <= 0n) throw refuse("send_delivers_nothing", `the simulated transfer succeeds but the recipient would receive none of the ${asset.label}; nothing was signed`);
  const less = received !== null && received < units ? received : null;

  // The gas limit to sign with: what the simulation used plus half again (a plain transfer to an account with no code is exactly 21,000),
  // and, where the gas includes a data cost the simulation cannot see (Arbitrum), at least the node's estimate for this exact transaction.
  const used = uintOf(xfer.gasUsed);
  let gas = used === null ? (native ? CONTRACT_RECIPIENT_GAS : 200_000n) : native && used === EOA_TRANSFER_GAS ? EOA_TRANSFER_GAS : (used * 3n) / 2n + 25_000n;
  if (gas > spec.simulation.maxGas) gas = spec.simulation.maxGas;
  if (spec.simulation.exactGasEstimate) gas = await exactGasLimit(c, chain, tx, gas, { deps, what: "send" });
  if (native && units + gas * feeCap > balance) {
    throw refuse(`not_enough_${spec.native.symbol.toLowerCase()}`, `${unitsToText(units, asset.decimals)} ${asset.symbol} plus its gas is more than the wallet holds (${unitsToText(balance, asset.decimals)}); use --amount all to send everything and keep what the gas needs`);
  }

  // USD for the limits.
  let usd = null;
  let unpriced = false;
  let valuation;
  if (asset.kind === "stable") {
    usd = unitsToUsd(units, asset.decimals);
    valuation = { basis: "stable" };
  } else if (oracle) {
    usd = usdUp(Number(unitsToText(units, asset.decimals)) * oracle.usd);
    valuation = { basis: "oracle", oracle: { asset: spec.native.oracle, usd: oracle.usd, age_s: oracle.age_s, source: oracle.source } };
  } else {
    unpriced = true;
    valuation = { basis: "none" };
  }

  const notes = [];
  const stays = native && all ? { wei: balance - units, text: `${unitsToText(balance - units, asset.decimals)} ${asset.symbol}` } : null;
  if (stays) notes.push(`Sending everything except ${stays.text}, which stays in the wallet for gas.`);
  else if (all) notes.push("Sending the whole balance.");
  if (less !== null) {
    notes.push(`This token takes a fee on transfer: the recipient would receive ${unitsToText(less, asset.decimals)} of the ${unitsToText(units, asset.decimals)} sent (${unitsToText(units - less, asset.decimals)} less).`);
  } else if (native && received === null) {
    notes.push("The simulation did not report the transfer, so what the recipient receives was not compared with what is sent.");
  }

  return {
    chain,
    to,
    asset,
    all,
    units,
    amountText: unitsToText(units, asset.decimals),
    usd,
    unpriced,
    valuation,
    received: less === null ? null : { units: less, text: unitsToText(less, asset.decimals) },
    notes,
    powers: [],
    stays,
    rent: null,
    gas: { limit: gas, maxFeePerGas: feeCap },
    tx,
    explorer: (hash) => explorerTx(chain, hash),
  };
}

/**
 * Reserve the send against the limits, sign it, record the hash, broadcast, wait. Throws Refused when the limits say no (nothing signed),
 * Pending when it may have gone out (stays counted; never retry), Rejected when the node refused it. Never retried.
 */
export async function executeEvmSend(plan, deps = {}) {
  const { chain } = plan;
  const c = deps.c ?? clients(undefined, chain);
  const entry = await reserve(deps.policy ?? loadPolicy(), ledgerSpend(plan));
  let receipt;
  try {
    receipt = await signAndSend(c, { to: plan.tx.to, data: plan.tx.data, value: plan.tx.value, gas: plan.gas.limit }, (hash) => record({ id: entry.id, status: "signed", tx: hash }), { chain });
  } catch (err) {
    // Pending = it may have gone out: stays counted. Anything else (an error before signing, a definite rejection) never moved funds.
    if (!(err instanceof Pending)) release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: String(err.shortMessage || err.message) });
    throw err;
  }
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    throw new Error(`transaction reverted: ${explorerTx(chain, receipt.transactionHash)}`);
  }
  record({ id: entry.id, status: "confirmed", tx: receipt.transactionHash, ...(plan.received ? { received: plan.received.text } : {}) });
  return { tx: receipt.transactionHash, explorer: explorerTx(chain, receipt.transactionHash) };
}
