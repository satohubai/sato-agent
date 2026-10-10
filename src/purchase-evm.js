// A Base transaction someone else built for the agent to sign: the Crossmint payment
// behind an Amazon order. Untrusted bytes. Nothing is signed until the kit's own
// simulation (eth_simulateV1 with traceTransfers, the same call swaps use) shows:
//
//   - the call succeeds;
//   - the wallet loses USDC, more than nothing and at most the quoted total;
//   - the wallet loses nothing else: no ETH (beyond gas, which the simulation does
//     not count as a transfer), no other token, no NFT;
//   - no approval is left behind: for every Approval event the transaction emits from
//     the agent, a second simulation runs the transaction and then reads that
//     allowance in the same block, and it must be 0. An approval-for-all or a Permit2
//     approval from the agent is refused outright.
//
// SHAPE-AGNOSTIC ON PURPOSE (2026-10-09): the exact transaction Crossmint builds is not
// known yet. It may be a plain USDC transfer, or a call into a payment contract that pulls
// USDC (approve + transferFrom in one call, a permit, a router). The checks above do not
// depend on that shape: the balance changes are the binding check. A contract call
// (`to` is not the USDC contract) is allowed ONLY when the simulation shows USDC-only loss
// up to the total and no lingering allowance, and it is reported as `contract_call: true`.

import { decodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddress, parseTransaction, toEventSelector } from "viem";
import { Refused } from "./errors.js";
import { USDC_BASE } from "./base.js";
import { assetDeltas, defaultSimulate } from "./swap/evm.js";

const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL_TOPIC = toEventSelector("Approval(address,address,uint256)");
const APPROVAL_FOR_ALL_TOPIC = toEventSelector("ApprovalForAll(address,address,bool)");
// Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3): an allowance it records lives in Permit2, not in the token.
const PERMIT2_TOPICS = [
  toEventSelector("Approval(address,address,address,uint160,uint48)"),
  toEventSelector("Permit(address,address,address,uint160,uint48,uint48)"),
];
/** The gas the payment gets in the kit's simulation, and the most it is ever signed with. */
export const SIM_GAS = 1_500_000n;

const r = (rule, message, limit = null, observed = null) => ({ rule, limit, observed, message });
const lc = (s) => String(s).toLowerCase();
const word = (t) => `0x${String(t).slice(-40).toLowerCase()}`;
const callOk = (c) => c?.status === "0x1" || c?.status === 1 || c?.status === "0x01";

/**
 * The call to make, from the serialized transaction: { to, data, value, chain_id }. `encoding` "hex" (a serialized,
 * unsigned transaction, viem's parseTransaction) or "json" ({ to, data, value?, chainId? }). Gas, nonce and fees in it
 * are ignored: the kit sets its own. Throws Refused on another chain, a value in ETH, or no target.
 */
export function decodeBaseTx(serialized, encoding = "hex") {
  let tx;
  try {
    if (encoding === "json") tx = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
    else if (["hex", "rlp", "serialized"].includes(encoding)) tx = parseTransaction(serialized);
    else throw new Error(`unknown encoding "${String(encoding).slice(0, 20)}"`);
  } catch (err) {
    throw new Refused([r("purchase_tx.decode", `the payment transaction could not be decoded (${String(err.shortMessage || err.message).slice(0, 160)}); nothing was signed`)]);
  }
  const problems = [];
  if (!tx || typeof tx.to !== "string" || !isAddress(tx.to)) problems.push(r("purchase_tx.decode", "the payment transaction names no valid target"));
  if (tx?.chainId !== undefined && Number(tx.chainId) !== 8453) problems.push(r("purchase_tx.chain", `the payment transaction is for chain ${tx.chainId}, not Base (8453)`, 8453, Number(tx.chainId)));
  let value = 0n;
  try {
    value = BigInt(tx?.value ?? 0);
  } catch {
    problems.push(r("purchase_tx.decode", "the payment transaction's value is not a number"));
  }
  if (value !== 0n) problems.push(r("purchase_tx.value", "the payment transaction sends ETH; a purchase moves only USDC", "0", value.toString()));
  const data = typeof tx?.data === "string" ? tx.data : tx?.input ?? "0x";
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) problems.push(r("purchase_tx.decode", "the payment transaction's data is not hex"));
  if (problems.length) throw new Refused(problems);
  return { to: getAddress(tx.to), data, value: 0n, chain_id: 8453 };
}

async function simulate(calls, agent, deps) {
  let raw;
  try {
    raw = await (deps.simulate ?? defaultSimulate)({ taker: agent, calls, c: deps.c });
  } catch (err) {
    throw new Refused([r("purchase_tx.sim_unavailable", `this kit's own simulation could not run (${String(err.details || err.shortMessage || err.message).slice(0, 200)}); nothing is signed without one`)]);
  }
  const blocks = Array.isArray(raw) ? raw : [raw];
  const got = blocks.every((b) => Array.isArray(b?.calls)) ? blocks.flatMap((b) => b.calls) : null;
  if (!Array.isArray(got) || got.length !== calls.length) throw new Refused([r("purchase_tx.sim_unavailable", "this kit's own simulation returned an answer it cannot read; nothing is signed without one")]);
  return got;
}

/**
 * Simulate the payment from the agent and hold it to the rules above. `maxUsdcUnits` (bigint): the quoted total.
 * deps: { simulate (tests), c (viem clients) }. Returns { usdc_out, payees, contract_call, approvals_checked, simulated }.
 */
export async function simulateBasePurchase({ agent, to, data, maxUsdcUnits }, deps = {}) {
  const usdc = lc(USDC_BASE);
  const me = lc(agent);
  // A plain approve() on USDC is refused before simulating: a payment never needs to leave one behind.
  if (lc(to) === usdc && lc(data).startsWith("0x095ea7b3")) throw new Refused([r("purchase_tx.lingering_approval", "the payment transaction is a USDC approval, not a payment; nothing was signed")]);
  const call = { to, data, value: 0n, gas: SIM_GAS };
  const got = await simulate([call], agent, deps);
  if (!callOk(got[0])) throw new Refused([r("purchase_tx.sim_failed", `the payment would fail in simulation (${String(got[0]?.error?.message ?? got[0]?.returnData ?? "no reason given").slice(0, 160)})`)]);

  const { deltas, leaves } = assetDeltas(got, agent);
  const problems = [];
  const usdcOut = -(deltas.get(usdc) ?? 0n);
  if (usdcOut <= 0n) problems.push(r("purchase_tx.no_payment", "in simulation the transaction moves no USDC out of the wallet, so it would not pay for the order"));
  if (usdcOut > maxUsdcUnits) problems.push(r("purchase_tx.over_total", `in simulation the transaction takes ${usdcOut} USDC units, more than the quoted total of ${maxUsdcUnits}`, maxUsdcUnits.toString(), usdcOut.toString()));
  for (const [asset, delta] of deltas) {
    if (asset !== usdc && delta < 0n) problems.push(r("purchase_tx.other_asset_leaves", `in simulation the transaction also takes ${asset === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? "ETH" : asset} from the wallet; only USDC may leave`, "0", delta.toString()));
  }
  for (const l of leaves) problems.push(r("purchase_tx.other_asset_leaves", `in simulation the transaction moves an ${l.kind} token out of the wallet`, null, l.asset));

  // Approvals the transaction gives from the agent, and who received USDC straight from it.
  const approvals = [];
  const payees = [];
  for (const log of got[0].logs ?? []) {
    const t = log.topics ?? [];
    if (t[0] === APPROVAL_TOPIC && t.length === 3 && word(t[1]) === me) {
      const key = `${lc(log.address)}:${word(t[2])}`;
      if (!approvals.some((a) => a.key === key)) approvals.push({ key, token: getAddress(log.address), spender: getAddress(word(t[2])) });
    } else if (t[0] === APPROVAL_FOR_ALL_TOPIC && word(t[1]) === me) {
      problems.push(r("purchase_tx.lingering_approval", `the transaction gives ${word(t[2])} control of every token of ${lc(log.address)} the wallet holds`));
    } else if (PERMIT2_TOPICS.includes(t[0]) && t.length >= 2 && word(t[1]) === me) {
      problems.push(r("purchase_tx.lingering_approval", "the transaction records a Permit2 allowance from the wallet"));
    } else if (t[0] === TRANSFER_TOPIC && t.length === 3 && lc(log.address) === usdc && word(t[1]) === me) {
      const to2 = getAddress(word(t[2]));
      if (!payees.includes(to2)) payees.push(to2);
    }
  }
  if (problems.length) throw new Refused(problems);

  // No approval may outlive the transaction: replay it and read each allowance right after, in the same simulated block.
  if (approvals.length) {
    const reads = approvals.map((a) => ({ to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(agent), a.spender] }), value: 0n, gas: 100_000n }));
    const again = await simulate([call, ...reads], agent, deps);
    for (const [i, a] of approvals.entries()) {
      const res = again[i + 1];
      let left = null;
      try {
        left = callOk(res) ? decodeAbiParameters([{ type: "uint256" }], res.returnData)[0] : null;
      } catch {
        left = null;
      }
      if (left === null) problems.push(r("purchase_tx.lingering_approval", `the allowance the transaction sets for ${a.spender} on ${a.token} could not be read back, so it cannot be shown to end at 0`));
      else if (left !== 0n) problems.push(r("purchase_tx.lingering_approval", `after the payment ${a.spender} could still spend ${left} units of ${a.token} from the wallet`, "0", left.toString()));
    }
    if (problems.length) throw new Refused(problems);
  }

  let gasUsed = null;
  try {
    gasUsed = got[0].gasUsed === undefined || got[0].gasUsed === null ? null : BigInt(got[0].gasUsed);
  } catch {
    gasUsed = null;
  }
  return {
    usdc_out: usdcOut,
    gas_used: gasUsed,
    payees,
    contract_call: lc(to) !== usdc,
    approvals_checked: approvals.length,
    simulated: { source: deps.simulate ? "injected" : "eth_simulateV1", usdc_out_units: usdcOut.toString(), payees, contract_call: lc(to) !== usdc, approvals_checked: approvals.length },
  };
}
