// Swaps on Base, offline. The Sato Hub response is built from a real KyberSwap
// route + build and a real eth_simulateV1 trace (test/fixtures/swap-evm); the
// chain is a stand-in that scripts receipts. Sato Hub is never called.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { freshHome } from "./helpers.js";
import { FIXTURES, SENDER, fakeChain, passes, recordedSimulation, replay, satoResponse, topicAddr, transferLog } from "./swap-evm-helpers.js";

freshHome();
const evm = await import("../src/swap/evm.js");
const { Refused, Pending } = await import("../src/errors.js");
const { setPolicy } = await import("../src/policy.js");
const { actions, entries, spentLast24h } = await import("../src/ledger.js");
const { decodeFunctionData, encodeFunctionData, erc20Abi } = await import("viem");

const {
  KYBER_ROUTER_BASE, NATIVE_PLACEHOLDER, SATO_FEE_RECIPIENT, TOKENS, WETH_BASE,
  decimalToUnits, parseIntent, planBaseSwap, verifyBaseSwapPlan, executeBaseSwap: executeBaseSwapRaw, dryRunBaseSwap, summarizeBaseSwapPlan, assetDeltas,
} = evm;
const USDC = TOKENS.USDC.address;
// executeBaseSwap requires the caller's independent USD figure; the tests give it the plan's own unless they say otherwise.
const executeBaseSwap = (plan, deps = {}) => executeBaseSwapRaw(plan, { usdNotional: plan?.usd, ...deps });

const rules = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${e?.stack}`);
    return e.refusals.map((r) => r.rule);
  }
  assert.fail("expected a refusal");
};

const CASES = {
  "usdc-to-eth": { from: "USDC", to: "ETH", amount: "100" },
  "eth-to-usdc": { from: "ETH", to: "USDC", amount: "0.01" },
  "usdc-to-weth": { from: "USDC", to: "WETH", amount: "100" },
};

/** Verify one recorded case with everything injected. `edit` may change the response or the simulation. */
async function verifyCase(name, { edit, editSim, deps = {}, slippageBps = 50, allowance = 0n } = {}) {
  const args = { ...CASES[name], slippageBps };
  const response = satoResponse(name);
  edit?.(response);
  const sim = recordedSimulation(name);
  editSim?.(sim);
  const seen = [];
  const intent = parseIntent(args);
  intent.taker = SENDER;
  const plan = await verifyBaseSwapPlan(response, intent, { verifySignature: passes, simulate: replay(sim, seen), readAllowance: async () => allowance, ...deps });
  return { plan, seen, response };
}

// ------------------------------------------------------------------ amounts and intent

test("amounts are strict: no rounding, 6 places for USDC, 18 for ETH", () => {
  assert.equal(decimalToUnits("12.5", 6), 12_500_000n);
  assert.equal(decimalToUnits("0.000001", 18), 1_000_000_000_000n);
  assert.equal(decimalToUnits("1.000000000000000001", 18), 1_000_000_000_000_000_001n);
  for (const bad of ["1.0000001", "0", "0.0", "-1", "1e3", ".5", "5.", " 1", "0x10", "1,5", ""]) {
    assert.throws(() => decimalToUnits(bad, 6), /not a/, bad);
  }
  assert.throws(() => decimalToUnits("1.0000000000000000001", 18), /at most 18 decimals/);
  assert.throws(() => parseIntent({ from: "USDC", to: "ETH", amount: "1.0000001", slippageBps: 50 }), /at most 6 decimals/);
});

test("intent: only USDC <-> ETH/WETH, never the same token, slippage in whole bps", () => {
  const ok = parseIntent({ from: "usdc", to: "eth", amount: "5", slippageBps: 50 });
  assert.equal(ok.tokenIn.address, USDC);
  assert.equal(ok.tokenOut.address, NATIVE_PLACEHOLDER);
  assert.equal(ok.amountIn, 5_000_000n);
  assert.throws(() => parseIntent({ from: "ETH", to: "WETH", amount: "1", slippageBps: 50 }), /only USDC/);
  assert.throws(() => parseIntent({ from: "USDC", to: "USDC", amount: "1", slippageBps: 50 }), /same token/);
  assert.throws(() => parseIntent({ from: "USDC", to: "DAI", amount: "1", slippageBps: 50 }), /not supported on Base/);
  for (const s of [0, -1, 5001, 0.5, "50", undefined]) assert.throws(() => parseIntent({ from: "USDC", to: "ETH", amount: "1", slippageBps: s }), /slippage/);
});

// ------------------------------------------------------------------ plan

test("plan asks Sato Hub for build-tx with pinned addresses, base units, the agent as taker, and no recipient", async () => {
  const calls = [];
  const response = satoResponse("usdc-to-eth");
  const callTool = async (name, args) => {
    calls.push({ name, args });
    return { text: JSON.stringify(response), structured: response, isError: false };
  };
  const { response: got, intent } = await planBaseSwap({ from: "USDC", to: "ETH", amount: "100", slippageBps: 50 }, { callTool, taker: SENDER.toLowerCase() });
  assert.equal(got, response, "the signed response comes back untouched");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "onchain_agent_swap");
  assert.deepEqual(calls[0].args, {
    mode: "build-tx",
    chain_in: "Base",
    chain_out: "Base",
    token_in: USDC,
    token_out: NATIVE_PLACEHOLDER,
    amount_in: "100000000",
    taker: SENDER, // checksummed
    slippage_bps: 50,
    venue: "kyberswap", // Sato Hub is asked for the one router the kit decodes
    response_format: "json",
    usd_notional: 100,
  });
  assert.equal(intent.taker, SENDER);

  // Selling ETH: no price is known, so none is sent (unknown is never 0).
  await planBaseSwap({ from: "ETH", to: "USDC", amount: "0.01", slippageBps: 100 }, { callTool, taker: SENDER });
  assert.equal(calls[1].args.token_in, NATIVE_PLACEHOLDER);
  assert.equal(calls[1].args.amount_in, "10000000000000000");
  assert.ok(!("usd_notional" in calls[1].args));
  await planBaseSwap({ from: "ETH", to: "USDC", amount: "0.01", slippageBps: 100 }, { callTool, taker: SENDER, usdNotional: 25 });
  assert.equal(calls[2].args.usd_notional, 25);
  assert.ok(calls.every((c) => !("recipient" in c.args)));
});

test("plan falls back to the JSON text, and fails clearly on an error result", async () => {
  const response = satoResponse("usdc-to-eth");
  const viaText = await planBaseSwap({ from: "USDC", to: "ETH", amount: "1", slippageBps: 50 }, { taker: SENDER, callTool: async () => ({ text: JSON.stringify(response), structured: null, isError: false }) });
  assert.equal(viaText.response.route_id, response.route_id);
  await assert.rejects(planBaseSwap({ from: "USDC", to: "ETH", amount: "1", slippageBps: 50 }, { taker: SENDER, callTool: async () => ({ text: "rate limited", structured: null, isError: true }) }), /did not return a swap quote: rate limited/);
});

// ------------------------------------------------------------------ verify: the good paths

for (const name of Object.keys(CASES)) {
  test(`verifies a real KyberSwap route and trace: ${name}`, async () => {
    const { plan, seen } = await verifyCase(name);
    const { from } = CASES[name];
    assert.equal(plan.verified, true);
    assert.equal(plan.router, KYBER_ROUTER_BASE);
    assert.equal(plan.venue, "kyberswap");
    assert.equal(plan.route_id, "rt_fixture00001");
    // min_out is the quote less 50 bps, computed here
    assert.equal(plan.min_out, (plan.quoted_out * 9950n) / 10_000n);
    assert.ok(plan.simulation.out_delta >= plan.min_out);
    assert.ok(-plan.simulation.in_delta <= plan.amount_in);
    assert.equal(plan.fee.bps, 15);
    assert.equal(plan.fee.recipient, SATO_FEE_RECIPIENT);
    assert.match(plan.fee.disclosure, /KyberSwap/);
    assert.ok(plan.fee.seen_in_simulation > 0n, "the fee address was seen receiving the disclosed fee");
    assert.equal(plan.approval.needed, from === "USDC");
    // the simulation was asked for [approve (exact), swap] from the agent, with transfers traced and no validation
    assert.equal(seen[0].taker, SENDER);
    assert.equal(seen[0].calls.length, from === "USDC" ? 2 : 1);
    if (from === "USDC") {
      const a = decodeFunctionData({ abi: erc20Abi, data: seen[0].calls[0].data });
      assert.equal(a.functionName, "approve");
      assert.equal(a.args[0], KYBER_ROUTER_BASE);
      assert.equal(a.args[1], plan.amount_in, "approve is for the exact amount");
      assert.equal(seen[0].calls[0].to, USDC);
    }
    const swap = seen[0].calls.at(-1);
    assert.equal(swap.to, KYBER_ROUTER_BASE);
    assert.equal(swap.value, from === "ETH" ? 10_000_000_000_000_000n : 0n);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.tx));
    // the summary is JSON-safe
    const s = summarizeBaseSwapPlan(plan);
    assert.doesNotThrow(() => JSON.stringify(s));
    assert.equal(s.sell.asset, from);
  });
}

test("the USD value held to the limits is the USDC leg, measured; an ETH sale cannot be understated", async () => {
  const usdc = await verifyCase("usdc-to-eth");
  assert.equal(usdc.plan.usd, 100);
  const eth = await verifyCase("eth-to-usdc");
  assert.ok(eth.plan.usd > 24 && eth.plan.usd < 26, `measured from the simulated USDC inflow: ${eth.plan.usd}`);
  const low = await verifyCase("eth-to-usdc", { deps: { usdNotional: 0.01 } });
  assert.equal(low.plan.usd, eth.plan.usd, "a lower figure from the caller does not lower it");
  const high = await verifyCase("eth-to-usdc", { deps: { usdNotional: 40 } });
  assert.equal(high.plan.usd, 40, "a higher one raises it");
});

test("an allowance that is already enough is not approved again (and not simulated)", async () => {
  // the recorded trace had an approve first; with no approve to run, the trace has one call
  const { plan, seen } = await verifyCase("usdc-to-eth", { editSim: (s) => s.result[0].calls.shift(), allowance: 200_000_000n });
  assert.equal(plan.approval.needed, false);
  assert.equal(seen[0].calls.length, 1);
  assert.equal(summarizeBaseSwapPlan(plan).approval, null);
});

test("the real eth_simulateV1 request: transfers traced, no validation, latest, from the agent", () => {
  const params = evm.buildSimulationRequest({ taker: SENDER, calls: [{ to: USDC, data: "0x12", value: 0n }, { to: KYBER_ROUTER_BASE, data: "0x34", value: 255n }] });
  assert.deepEqual(params, [
    {
      blockStateCalls: [{ calls: [{ from: SENDER, to: USDC, data: "0x12" }, { from: SENDER, to: KYBER_ROUTER_BASE, data: "0x34", value: "0xff" }] }],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ]);
});

test("asset deltas come from traced Transfer logs, native ETH from 0xeeee…", () => {
  const sim = recordedSimulation("usdc-to-eth").result[0].calls;
  const { deltas, leaves } = assetDeltas(sim, SENDER);
  assert.equal(deltas.get(USDC.toLowerCase()), -100_000_000n);
  assert.ok(deltas.get(NATIVE_PLACEHOLDER.toLowerCase()) > 0n);
  assert.equal(leaves.length, 0);
});

// ------------------------------------------------------------------ verify: every refusal

test("refuses when Sato's signature is missing, wrong, unreadable or old", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.meta.signature = null) })), ["signature_unverified"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => delete r.meta })), ["signature_unverified"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { verifySignature: async () => ({ ok: false, why: "bad signature" }) } })), ["signature_unverified"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { verifySignature: async () => false } })), ["signature_unverified"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { verifySignature: async () => { throw new Error("jwks unreachable"); } } })), ["signature_unverified"]);
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.meta.signature.signed_at = old) })), ["signature_stale"]);
  // with no verifier injected the default is src/hub-signature.js; it must refuse a signature it cannot confirm
  // (skipped once that file exists, because the real check would fetch Sato Hub's keys over the network)
  if (!existsSync(new URL("../src/hub-signature.js", import.meta.url))) {
    assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { verifySignature: undefined } })), ["signature_unverified"]);
  }
});

test("refuses any router, venue or approval target that is not the pinned one", async () => {
  const other = "0x0000000000001fF3684f28c67538d4D072C22734";
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.to = other) })), ["router_not_pinned"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.venue = "0x-protocol") })), ["router_not_pinned"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.approval_target = other) })), ["router_not_pinned"]);
  // case does not matter
  const { plan } = await verifyCase("usdc-to-eth", { edit: (r) => { r.tx.to = r.tx.to.toLowerCase(); r.tx.approval_target = r.tx.to.toUpperCase().replace("0X", "0x"); } });
  assert.equal(plan.router, KYBER_ROUTER_BASE);
});

test("refuses the wrong chain", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.chain_id = 1) })), ["chain_not_base"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.chain_id = null) })), ["chain_not_base"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.chain = "Ethereum") })), ["chain_not_base"]);
});

test("refuses a wrong value: ETH sales send exactly the amount, everything else sends none", async () => {
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: (r) => (r.tx.value = "0") })), ["value_mismatch"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: (r) => (r.tx.value = "20000000000000000") })), ["value_mismatch"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: (r) => (r.tx.value = null) })), ["value_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.value = "1") })), ["value_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.value = "0x1") })), ["value_mismatch"]);
  // hex is read as hex
  const { plan } = await verifyCase("eth-to-usdc", { edit: (r) => (r.tx.value = "0x2386f26fc10000") });
  assert.equal(plan.tx.value, 10_000_000_000_000_000n);
});

test("refuses unless Sato's own simulation says ok", async () => {
  for (const sim of [null, { ok: null, precondition_only: true }, { ok: false, revert: "x" }, { lane: "none" }]) {
    assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.simulation = sim) })), ["simulation_not_ok"]);
  }
});

test("refuses without a pinned, readable fee disclosure", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => { delete r.sato_fee_bps; } })), ["fee_disclosure_missing"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.disclosure = "  ") })), ["fee_disclosure_missing"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.sato_fee_recipient = null) })), ["fee_disclosure_missing"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.sato_fee_recipient = "0x000000000000000000000000000000000000dEaD") })), ["fee_recipient_not_pinned"]);
  // (the transaction still takes 15 bps, so it also differs from the disclosed rate)
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.sato_fee_bps = 100) })), ["fee_over_ceiling", "fee_not_as_disclosed"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.sato_fee_bps = 7.5) })), ["fee_disclosure_missing"]);
});

test("refuses a response that is about something else, or that carries no transaction", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_in = "1") })), ["response_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.token_out = WETH_BASE) })), ["response_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.mode = "recommend") })), ["response_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => { r.tx = null; r.withheld = { rule: "E1", reason: "gate said no" }; } })), ["tx_withheld"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => { for (const k of Object.keys(r)) if (k !== "meta") delete r[k]; r.unavailable = "no adapter answered"; r.tried = []; } })), ["tx_withheld"]);
});

test("min_out must work out to something", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_out = "0") })), ["min_out_invalid"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => delete r.amount_out })), ["min_out_invalid"]);
  // a 1-unit quote less any slippage rounds down to 0
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_out = "1"), slippageBps: 100 })), ["min_out_invalid"]);
});

test("slippage above the policy maximum (500 bps) is refused for library callers too", () => {
  assert.throws(() => evm.parseIntent({ from: "USDC", to: "ETH", amount: "1", slippageBps: 501 }), /1 to 500/);
});

test("refuses to sign blind: no kit simulation means no swap", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { simulate: async () => { throw new Error("the method eth_simulateV1 does not exist/is not available"); } } })), ["simulation_unavailable"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { simulate: async () => null } })), ["simulation_unavailable"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { simulate: async () => [{ calls: [] }] } })), ["simulation_unavailable"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { readAllowance: async () => { throw new Error("rpc down"); } } })), ["simulation_unavailable"]);
});

test("refuses when the simulated swap or approval would fail", async () => {
  const msg = await verifyCase("usdc-to-eth", { editSim: (s) => { s.result[0].calls[1].status = "0x0"; s.result[0].calls[1].error = { code: 3, message: "execution reverted: Return amount is not enough" }; } }).catch((e) => e);
  assert.ok(msg instanceof Refused);
  assert.equal(msg.refusals[0].rule, "simulation_failed");
  assert.match(msg.message, /the swap would fail: execution reverted: Return amount is not enough/);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => (s.result[0].calls[0].status = "0x0") })), ["simulation_failed"]);
});

test("refuses when the simulated balance changes are off", async () => {
  const bump = (calls, pred, f) => {
    for (const c of calls) for (const l of c.logs) if (pred(l)) l.data = `0x${f(BigInt(l.data)).toString(16).padStart(64, "0")}`;
  };
  // more USDC leaves than the amount asked for
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => s.result[0].calls.at(-1).logs.push(transferLog(USDC.toLowerCase(), SENDER, KYBER_ROUTER_BASE, 1n)) })), ["outflow_exceeds_amount_in"]);
  // less ETH arrives than min_out
  const toMe = (l) => l.address === NATIVE_PLACEHOLDER.toLowerCase() && l.topics[2] === topicAddr(SENDER);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => bump(s.result[0].calls, toMe, (v) => v / 2n) })), ["output_below_min_out"]);
  // a quote that promised more than the trace shows
  // (the transaction's own minimum is then far below the minimum the quote implies, which is refused before the trace is read)
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_out = (BigInt(r.amount_out) * 2n).toString()) })), ["min_out_not_enforced"]);
  // a different token leaves the wallet in the same transaction
  const dai = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => s.result[0].calls.at(-1).logs.push(transferLog(dai, SENDER, KYBER_ROUTER_BASE, 5n)) })), ["other_token_leaves"]);
  // so does ETH, when buying WETH
  assert.deepEqual(await rules(verifyCase("usdc-to-weth", { editSim: (s) => s.result[0].calls.at(-1).logs.push(transferLog(NATIVE_PLACEHOLDER.toLowerCase(), SENDER, KYBER_ROUTER_BASE, 5n)) })), ["other_token_leaves"]);
  // an NFT cannot be netted: any that leaves is refused
  const nft = { address: "0x1111111111111111111111111111111111111111", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topicAddr(SENDER), topicAddr(KYBER_ROUTER_BASE), "0x01"], data: "0x" };
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => s.result[0].calls.at(-1).logs.push(nft) })), ["other_token_leaves"]);
  // an ETH sale cannot send more ETH than the amount
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { editSim: (s) => s.result[0].calls.at(-1).logs.push(transferLog(NATIVE_PLACEHOLDER.toLowerCase(), SENDER, KYBER_ROUTER_BASE, 1n)) })), ["outflow_exceeds_amount_in"]);
  // the fee address receives more than the disclosed rate (here the extra comes out of the wallet too, so both rules fire)
  const toFee = (l) => l.topics[0].startsWith("0xddf252") && l.topics[2] === topicAddr(SATO_FEE_RECIPIENT);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { editSim: (s) => bump(s.result[0].calls, toFee, (v) => v * 3n) })), ["outflow_exceeds_amount_in", "fee_exceeds_disclosed"]);
});

// ------------------------------------------------------------------ verify: the router calldata, field by field
//
// The recorded builds are REAL KyberSwap route/build answers (swap(SwapExecutionParams), selector 0xe21fd0e9). Each
// test decodes the real calldata, changes ONE field, re-encodes it with the router ABI, and expects the one refusal.

const { ROUTER_ABI, FLAGS } = { ROUTER_ABI: evm.KYBER_ROUTER_ABI, FLAGS: evm.KYBER_FLAGS };
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const cp = (o) => (Array.isArray(o) ? o.map(cp) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cp(v)])) : o);

const decodeBuild = (data) => cp(decodeFunctionData({ abi: ROUTER_ABI, data }).args[0]);
const encodeBuild = (execution) => encodeFunctionData({ abi: ROUTER_ABI, functionName: "swap", args: [execution] });
/** An `edit` for verifyCase: change the decoded execution, put the re-encoded bytes back into the response. */
const tamper = (change) => (r) => {
  const ex = decodeBuild(r.tx.data);
  change(ex.desc, ex, r);
  r.tx.data = encodeBuild(ex);
};

test("the input can only be handed to KyberSwap's executor (the router itself does not restrict it)", async () => {
  for (const name of Object.keys(CASES)) assert.equal(decodeBuild(satoResponse(name).tx.data).callTarget.toLowerCase(), evm.KYBER_EXECUTOR_BASE.toLowerCase(), name);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((_d, ex) => (ex.callTarget = STRANGER)) })), ["executor_not_pinned"]);
});

test("the recorded builds decode with the router ABI and re-encode to the same bytes", () => {
  for (const name of Object.keys(CASES)) {
    const { tx } = satoResponse(name);
    assert.equal(tx.data.slice(0, 10), evm.KYBER_SWAP_SELECTOR);
    assert.equal(encodeBuild(decodeBuild(tx.data)).toLowerCase(), tx.data.toLowerCase(), name);
    const d = decodeBuild(tx.data).desc;
    assert.equal(d.dstReceiver, SENDER);
    assert.deepEqual(d.feeReceivers, [SATO_FEE_RECIPIENT]);
    assert.deepEqual(d.feeAmounts, [15n]);
    assert.equal(d.permit, "0x");
    assert.equal(d.flags, 0x280n, "IN_BPS (0x80) plus the 0x200 bit Kyber sets on every build");
  }
});

for (const name of Object.keys(CASES)) {
  test(`an honest build passes the calldata checks, and the minimum in the transaction is read: ${name}`, async () => {
    const { plan } = await verifyCase(name);
    assert.ok(plan.min_out_in_transaction >= plan.min_out - 1n && plan.min_out_in_transaction <= plan.min_out, `${plan.min_out_in_transaction} vs ${plan.min_out}`);
    const s = summarizeBaseSwapPlan(plan);
    assert.ok(s.buy.minimum_in_transaction);
  });
}

test("minReturnAmount of 1 (the reviewed attack) is refused; Kyber's own rounding (one unit under) is accepted, two under is not", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = 1n)) })), ["min_out_not_enforced"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.minReturnAmount = 1n)) })), ["min_out_not_enforced"]);
  const quoted = BigInt(satoResponse("usdc-to-eth").amount_out);
  const minOut = (quoted * 9950n) / 10_000n;
  assert.equal(evm.requiredCalldataMin(minOut), minOut - 1n);
  await verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = minOut - 1n)) });
  await verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = minOut + 1000n)) }); // stricter than the owner asked: fine
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = minOut - 2n)) })), ["min_out_not_enforced"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = 0n)) })), ["min_out_not_enforced"]);
});

test("the minimum is read against min_out for every slippage the owner can set, including Kyber's own floor of the re-quote", () => {
  // Kyber floors (route quote - 1) * (10000 - s) / 10000; the kit's min_out floors quote * (10000 - s) / 10000.
  for (const s of [1, 5, 50, 100, 300, 500, 5000]) {
    for (const quote of [1_000_000n, 399_851_666_998_140n, 40_145_191_458_367_072n, 24_841_409n]) {
      const kit = (quote * BigInt(10_000 - s)) / 10_000n;
      const kyber = ((quote - 1n) * BigInt(10_000 - s)) / 10_000n;
      assert.ok(kyber >= evm.requiredCalldataMin(kit), `s=${s} quote=${quote}: Kyber ${kyber} vs required ${evm.requiredCalldataMin(kit)}`);
    }
  }
});

test("the recipient must be the agent's own wallet", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.dstReceiver = STRANGER)) })), ["recipient_not_taker"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.dstReceiver = STRANGER)) })), ["recipient_not_taker"]);
  // the router reads the zero address as "the sender"; the kit still wants the wallet spelled out
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.dstReceiver = "0x0000000000000000000000000000000000000000")) })), ["recipient_not_taker"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.dstReceiver = KYBER_ROUTER_BASE)) })), ["recipient_not_taker"]);
});

test("the tokens and the amount in the transaction must be the ones asked for", async () => {
  const dai = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.srcToken = WETH_BASE)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.srcToken = USDC)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.dstToken = dai)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.dstToken = WETH_BASE)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-weth", { edit: tamper((d) => (d.dstToken = NATIVE_PLACEHOLDER)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.amount = d.amount + 1n)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.amount = d.amount - 1n)) })), ["calldata_mismatch"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.amount = d.amount / 2n)) })), ["calldata_mismatch"]);
});

test("no token permit rides along", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.permit = "0x1234")) })), ["calldata_mismatch"]);
});

test("the fee in the transaction is exactly the disclosed one: one receiver, the disclosed rate, in bps, from the input", async () => {
  // an extra fee receiver skimming on top
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => { d.feeReceivers = [SATO_FEE_RECIPIENT, STRANGER]; d.feeAmounts = [15n, 50n]; }) })), ["fee_not_as_disclosed"]);
  // the stranger first and the Sato address second, with the right rate for Sato: still two receivers
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => { d.feeReceivers = [STRANGER, SATO_FEE_RECIPIENT]; d.feeAmounts = [100n, 15n]; }) })), ["fee_not_as_disclosed"]);
  // a different single receiver
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.feeReceivers = [STRANGER])) })), ["fee_not_as_disclosed"]);
  // a different rate (higher and lower)
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.feeAmounts = [16n])) })), ["fee_not_as_disclosed"]);
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.feeAmounts = [14n])) })), ["fee_not_as_disclosed"]);
  // fee-on-destination set: the fee would come out of the tokens bought
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.flags = d.flags | FLAGS.FEE_ON_DST)) })), ["fee_not_as_disclosed"]);
  // in-bps cleared: 15 would be read as 15 base units, not 0.15%
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.flags = d.flags & ~FLAGS.FEE_IN_BPS)) })), ["fee_not_as_disclosed"]);
  // no fee receivers at all while the response discloses 15 bps
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => { d.feeReceivers = []; d.feeAmounts = []; }) })), ["fee_not_as_disclosed"]);
});

test("a build with no fee passes the fee check only when the response discloses 0 bps", () => {
  const { tx } = satoResponse("usdc-to-eth");
  const intent = { ...parseIntent({ ...CASES["usdc-to-eth"], slippageBps: 50 }), taker: SENDER };
  const minOut = (BigInt(satoResponse("usdc-to-eth").amount_out) * 9950n) / 10_000n;
  const noFee = encodeBuild((() => { const ex = decodeBuild(tx.data); ex.desc.feeReceivers = []; ex.desc.feeAmounts = []; return ex; })());
  assert.deepEqual(evm.checkRouterCalldata(noFee, { intent, minOut, feeBps: 0 }).refusals, []);
  assert.deepEqual(evm.checkRouterCalldata(noFee, { intent, minOut, feeBps: 15 }).refusals.map((r) => r.rule), ["fee_not_as_disclosed"]);
  // 0 disclosed but the transaction pays a receiver
  assert.deepEqual(evm.checkRouterCalldata(tx.data, { intent, minOut, feeBps: 0 }).refusals.map((r) => r.rule), ["fee_not_as_disclosed"]);
});

test("router options that weaken the minimum, or that the kit does not know, are refused", async () => {
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.flags = d.flags | FLAGS.PARTIAL_FILL)) })), ["min_out_not_enforced"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.flags = d.flags | 0x20n)) })), ["calldata_mismatch"]); // simple-swap mode
  assert.deepEqual(await rules(verifyCase("eth-to-usdc", { edit: tamper((d) => (d.flags = d.flags | 0x02n)) })), ["calldata_mismatch"]); // extra ETH
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => (d.flags = d.flags | 0x1000n)) })), ["calldata_mismatch"]);
});

test("a function the kit does not decode, or an encoding it cannot be sure of, is refused whole", async () => {
  const good = satoResponse("usdc-to-eth").tx.data;
  const swapped = (sel) => (r) => (r.tx.data = sel + good.slice(10));
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: swapped("0xdeadbeef") })), ["calldata_unrecognized"]);
  // swapGeneric / swapSimpleMode selectors of the same router: real functions, not decoded here
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: swapped("0x59e50fed") })), ["calldata_unrecognized"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: swapped("0x8af033fb") })), ["calldata_unrecognized"]);
  // the right selector with bytes that do not decode, and with bytes after the standard encoding
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.data = good.slice(0, 200)) })), ["calldata_unrecognized"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.data = `${good}00`) })), ["calldata_unrecognized"]);
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.data = "0xe21fd0e9") })), ["calldata_unrecognized"]);
  // an address with dirty upper bits would be read differently by the contract: not the standard encoding
  const dirty = `${good.slice(0, 10)}${good.slice(10).replace(/^(.{64})(.{24})/, "$1" + "ff".repeat(12))}`;
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.tx.data = dirty) })), ["calldata_unrecognized"]);
});

test("several things wrong at once are all reported", async () => {
  const got = await rules(verifyCase("usdc-to-eth", { edit: tamper((d) => { d.minReturnAmount = 1n; d.dstReceiver = STRANGER; }) }));
  assert.deepEqual(got.sort(), ["min_out_not_enforced", "recipient_not_taker"]);
});

test("the refusal messages are plain words the owner can read", async () => {
  const e = await verifyCase("usdc-to-eth", { edit: tamper((d) => (d.minReturnAmount = 1n)) }).catch((x) => x);
  assert.match(e.message, /REFUSED min_out_not_enforced: the transaction itself would accept less ETH than the minimum/);
  for (const word of ["safe", "secure", "trusted", "guaranteed"]) assert.doesNotMatch(e.message, new RegExp(word, "i"));
});

test("usdNotional is required to plan and to sign: no fallback to the simulated value", async () => {
  let asked = 0;
  const callTool = async () => {
    asked++;
    return { text: "", structured: satoResponse("usdc-to-eth"), isError: false };
  };
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, "100"]) {
    await assert.rejects(evm.planAndVerifyBaseSwap({ from: "USDC", to: "ETH", amount: "100", slippageBps: 50 }, { taker: SENDER, callTool, usdNotional: bad }), /usdNotional is required for planning a swap/, String(bad));
    await assert.rejects(dryRunBaseSwap({ from: "USDC", to: "ETH", amount: "100", slippageBps: 50 }, { taker: SENDER, callTool, usdNotional: bad }), /usdNotional is required/);
  }
  assert.equal(asked, 0, "Sato Hub is not asked (that call writes a public record) when the figure is missing");
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER });
  const before = entries().filter((e) => e.kind === "swap").length;
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, "100"]) {
    await assert.rejects(executeBaseSwapRaw(plan, { c, usdNotional: bad }), /usdNotional is required for signing a swap/, String(bad));
  }
  assert.equal(state.sent.length, 0);
  assert.equal(entries().filter((e) => e.kind === "swap").length, before, "nothing was reserved");
});

// ------------------------------------------------------------------ verify: the simulation looks like the real chain

test("the simulation carries the chain's base fee and real fees, so a zero base fee cannot give it away", async () => {
  const base = 5_000_000n;
  const params = evm.buildSimulationRequest({ taker: SENDER, calls: [{ to: USDC, data: "0x12", value: 0n }, { to: KYBER_ROUTER_BASE, data: "0x34", value: 255n }], baseFeePerGas: base, maxPriorityFeePerGas: 1_000_000n });
  const block = params[0].blockStateCalls[0];
  assert.deepEqual(block.blockOverrides, { baseFeePerGas: "0x4c4b40" });
  for (const call of block.calls) {
    assert.ok(BigInt(call.maxFeePerGas) >= base, "maxFeePerGas covers the base fee");
    assert.equal(call.maxPriorityFeePerGas, "0xf4240");
  }
  assert.equal(params[0].validation, false);
  assert.equal(params[0].traceTransfers, true);
});

test("the default simulation reads the latest block's base fee from the node before it simulates", async () => {
  const sent = [];
  const c = {
    pub: {
      getBlock: async () => ({ baseFeePerGas: 6_500_000n }),
      estimateMaxPriorityFeePerGas: async () => 2_000_000n,
      request: async (req) => {
        sent.push(req);
        return recordedSimulation("usdc-to-eth").result;
      },
    },
  };
  const { plan } = await verifyCase("usdc-to-eth", { deps: { simulate: undefined, c } });
  assert.equal(plan.simulation.source, "eth_simulateV1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "eth_simulateV1");
  const [{ blockStateCalls }] = sent[0].params;
  assert.equal(blockStateCalls[0].blockOverrides.baseFeePerGas, "0x632ea0");
  assert.ok(blockStateCalls[0].calls.every((k) => BigInt(k.maxFeePerGas) >= 6_500_000n && k.maxPriorityFeePerGas === "0x1e8480"));
  // a node that cannot give a base fee means no realistic simulation: refused, never run with a zero one
  const noFee = { pub: { getBlock: async () => ({}), request: async () => assert.fail("must not simulate without a base fee") } };
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { deps: { simulate: undefined, c: noFee } })), ["simulation_unavailable"]);
});

test("a dry run is plan + verify and returns the summary; nothing is reserved", async () => {
  const response = satoResponse("usdc-to-eth");
  const out = await dryRunBaseSwap(
    { from: "USDC", to: "ETH", amount: "100", slippageBps: 50 },
    { taker: SENDER, usdNotional: 100, callTool: async () => ({ text: "", structured: response, isError: false }), verifySignature: passes, simulate: replay(recordedSimulation("usdc-to-eth")), readAllowance: async () => 0n },
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.simulated, true);
  assert.equal(out.router, KYBER_ROUTER_BASE);
  assert.equal(out.sell.amount, "100");
  assert.equal(out.approval.amount, "100");
  assert.equal(out.sato_fee.bps, 15);
  assert.equal(entries().filter((e) => e.kind === "swap").length, 0);
});

// ------------------------------------------------------------------ execute (scripted chain)

setPolicy({ chains: "base", perTx: "150", perDay: "100000", swapSlippageBps: "500", maxTradesPerDay: "none" });
const lastSwap = () => actions().filter((a) => a.kind === "swap").at(-1);
const reserved = () => spentLast24h().usd;

async function planFor(name, opts) {
  return (await verifyCase(name, opts)).plan;
}

test("will not sign a plan that did not come out of verify, or an old one, or for another wallet", async () => {
  const { c } = fakeChain({ address: SENDER });
  const real = await planFor("usdc-to-eth");
  assert.deepEqual(await rules(executeBaseSwap({ ...real }, { c })), ["plan_not_verified"]);
  assert.deepEqual(await rules(executeBaseSwap(real, { c, now: Date.now() + 5 * 60_000 })), ["plan_stale"]);
  const { c: other } = fakeChain({ address: "0x000000000000000000000000000000000000dEaD" });
  assert.deepEqual(await rules(executeBaseSwap(real, { c: other })), ["taker_mismatch"]);
  assert.equal(entries().filter((e) => e.kind === "swap").length, 0, "nothing was reserved");
});

test("the owner's limits come first: a refused swap reserves nothing and signs nothing", async () => {
  const { c, state } = fakeChain({ address: SENDER });
  const plan = await planFor("usdc-to-eth");
  const policy = { ...(await import("../src/policy.js")).loadPolicy(), max_usd_per_tx: 50 };
  assert.deepEqual(await rules(executeBaseSwap(plan, { c, policy })), ["max_usd_per_tx"]);
  assert.equal(state.sent.length, 0);
  assert.equal(reserved(), 0);
});

test("USDC -> ETH: reserves, approves the exact amount to the router, swaps, reads what arrived, records everything", async () => {
  const plan = await planFor("usdc-to-eth");
  const got = 40_000_000_000_000_000n;
  // ETH out leaves no log: the balance across the block says what arrived (gas 100k * 1e6 = 1e11 added back)
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", { status: "success", spends: plan.amount_in }], balance: 1_000_000_000_000_000_000n, balanceAfter: 1_000_000_000_000_000_000n + got - 100_000n * 1_000_000n });
  const out = await executeBaseSwap(plan, { c });

  assert.equal(state.sent.length, 2);
  const [approve, swap] = state.sent;
  const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  assert.equal(approve.to, USDC);
  assert.deepEqual([a.functionName, a.args[0], a.args[1]], ["approve", KYBER_ROUTER_BASE, 100_000_000n]);
  assert.equal(swap.to, KYBER_ROUTER_BASE);
  assert.equal(swap.data, plan.tx.data);
  assert.equal(swap.value, 0n);

  assert.equal(out.received.amount, "0.04");
  assert.equal(out.received.asset, "ETH");
  assert.equal(out.sold.amount, "100");
  assert.equal(out.allowance, "none_left");
  assert.deepEqual(out.warnings, []);
  assert.match(out.explorer, /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
  assert.match(out.approve_tx, /^0x[0-9a-f]{64}$/);

  const row = lastSwap();
  assert.equal(row.status, "confirmed");
  assert.equal(row.kind, "swap");
  assert.equal(row.chain, "base");
  assert.equal(row.usd, 100);
  assert.equal(row.to, KYBER_ROUTER_BASE);
  assert.equal(row.asset_in, "USDC");
  assert.equal(row.asset_out, "ETH");
  assert.equal(row.amount_in, "100");
  assert.equal(row.min_out_units, plan.min_out.toString());
  assert.equal(row.route_id, "rt_fixture00001");
  assert.equal(row.receipt_url, "https://satohub.ai/swap/receipts/rt_fixture00001");
  assert.equal(row.amount_out, "0.04");
  assert.equal(row.tx, out.tx);
  assert.equal(row.approve_tx, out.approve_tx);
  assert.equal(row.explorer, `https://basescan.org/tx/${out.tx}`);
  assert.equal(reserved(), 100, "the spend stays counted");
});

test("ETH -> USDC: no approval; the swap carries the ETH; the USDC received is read from the receipt's logs", async () => {
  const before = reserved();
  const plan = await planFor("eth-to-usdc");
  const usdcOut = 24_840_000n;
  const logs = [transferLog(USDC, KYBER_ROUTER_BASE, SENDER, usdcOut)];
  const { c, state } = fakeChain({ address: SENDER, receipts: [{ status: "success", logs }] });
  const out = await executeBaseSwap(plan, { c });
  assert.equal(state.sent.length, 1, "no approval for native ETH");
  assert.equal(state.sent[0].value, 10_000_000_000_000_000n);
  assert.equal(out.received.amount, "24.84");
  assert.equal(out.approve_tx, null);
  assert.equal(out.allowance, null);
  assert.equal(lastSwap().amount_in, "0.01");
  assert.ok(reserved() > before);
});

test("an allowance that is already enough is not approved again", async () => {
  const plan = await planFor("usdc-to-weth", { allowance: 500_000_000n, editSim: (s) => s.result[0].calls.shift() });
  const { c, state } = fakeChain({ address: SENDER, allowance: 500_000_000n, receipts: [{ status: "success", logs: [transferLog(WETH_BASE, KYBER_ROUTER_BASE, SENDER, 40_000_000_000_000_000n)] }] });
  const out = await executeBaseSwap(plan, { c });
  assert.equal(state.sent.length, 1);
  assert.equal(out.received.amount, "0.04");
  assert.equal(out.allowance, null, "an allowance we did not grant is not ours to reset");
});

test("a swap that lands below its minimum is still recorded, with a warning", async () => {
  const plan = await planFor("usdc-to-weth", { allowance: 500_000_000n, editSim: (s) => s.result[0].calls.shift() });
  const { c } = fakeChain({ address: SENDER, allowance: 500_000_000n, receipts: [{ status: "success", logs: [transferLog(WETH_BASE, KYBER_ROUTER_BASE, SENDER, 1n)] }] });
  const out = await executeBaseSwap(plan, { c });
  assert.match(out.warnings[0], /below the minimum/);
  assert.equal(lastSwap().status, "confirmed");
  assert.ok(lastSwap().warnings.length);
});

test("approval reverts: the reservation is given back, no swap is attempted", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["revert"] });
  await assert.rejects(executeBaseSwap(plan, { c }), /the approval reverted/);
  assert.equal(state.sent.length, 1);
  assert.equal(lastSwap().status, "failed");
  assert.equal(lastSwap().reason, "approval reverted onchain");
  assert.equal(reserved(), before);
});

test("approval succeeds, swap reverts: reservation given back, the approval is set back to 0 and the ledger says so", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", "revert", "success"] });
  await assert.rejects(executeBaseSwap(plan, { c }), (e) => /transaction reverted/.test(e.message) && /set back to 0/.test(e.message));
  assert.equal(state.sent.length, 3);
  const reset = decodeFunctionData({ abi: erc20Abi, data: state.sent[2].data });
  assert.deepEqual([reset.functionName, reset.args[0], reset.args[1]], ["approve", KYBER_ROUTER_BASE, 0n]);
  assert.equal(state.allowance, 0n);
  const row = lastSwap();
  assert.equal(row.status, "failed");
  assert.equal(row.reason, "reverted onchain");
  assert.equal(row.allowance, "reset");
  assert.ok(row.approve_tx, "the approval that landed is on record");
  assert.equal(reserved(), before);
});

test("swap rejected by the node after an approval: given back, approval reset", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", "reject", "success"] });
  await assert.rejects(executeBaseSwap(plan, { c }), /the node refused/);
  assert.equal(state.allowance, 0n);
  assert.equal(lastSwap().status, "failed");
  assert.equal(reserved(), before);
});

test("approval succeeds, swap fails, and the reset fails too: the ledger records the open allowance", async () => {
  const plan = await planFor("usdc-to-eth");
  const { c } = fakeChain({ address: SENDER, receipts: ["success", "revert", "revert"] });
  await assert.rejects(executeBaseSwap(plan, { c }), (e) => /could not be set back to 0/.test(e.message) && /100000000 base units of USDC/.test(e.message));
  const rows = entries().filter((e) => e.id === lastSwap().id);
  const open = rows.find((r) => r.allowance === "left_open");
  assert.ok(open);
  assert.equal(open.allowance_left_units, "100000000");
  assert.equal(open.allowance_spender, KYBER_ROUTER_BASE);
});

test("an unknown outcome stays counted and throws Pending; the allowance is left alone", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", "nonce"] });
  await assert.rejects(executeBaseSwap(plan, { c }), (e) => e instanceof Pending && /Do NOT retry/.test(e.message));
  assert.equal(state.sent.length, 2, "no reset was sent: the swap may still land and use the approval");
  assert.equal(lastSwap().status, "signed");
  assert.match(lastSwap().tx, /^0x[0-9a-f]{64}$/);
  assert.equal(reserved(), before + 100);
});

test("an approval whose outcome is unknown is Pending too, and no swap is sent", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["nonce"] });
  await assert.rejects(executeBaseSwap(plan, { c }), (e) => e instanceof Pending);
  assert.equal(state.sent.length, 1);
  assert.equal(lastSwap().status, "approval_signed");
  assert.equal(reserved(), before + 100);
});

test("an error before anything is signed gives the reservation back", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER });
  await assert.rejects(executeBaseSwap(plan, { c, readAllowance: async () => { throw new Error("rpc down"); } }), /rpc down/);
  assert.equal(state.sent.length, 0);
  assert.equal(lastSwap().status, "failed");
  assert.equal(reserved(), before);
});

test("a swap is held to the swap caps, not the payee allowlist (it pays a pinned router and the output returns to the agent)", async () => {
  const { c, state } = fakeChain({ address: SENDER });
  const plan = await planFor("usdc-to-eth");
  const base = (await import("../src/policy.js")).loadPolicy();
  const withAllowlist = { ...base, allow_recipients: ["0x000000000000000000000000000000000000dEaD"], max_trades_per_day: 0 };
  // The allowlist is not the reason; the trade cap is.
  assert.deepEqual(await rules(executeBaseSwap(plan, { c, policy: withAllowlist })), ["max_trades_per_day"]);
  const swapsOff = { ...base };
  delete swapsOff.max_slippage_bps;
  delete swapsOff.max_trades_per_day;
  assert.deepEqual(await rules(executeBaseSwap(plan, { c, policy: swapsOff })), ["swaps_not_enabled"]);
  assert.equal(state.sent.length, 0);
});

test("what counts against the limits is the larger of the plan's measured value and the caller's figure", async () => {
  const plan = await planFor("eth-to-usdc"); // measured ~ $25
  const { c } = fakeChain({ address: SENDER, receipts: [{ status: "success", logs: [transferLog(USDC, KYBER_ROUTER_BASE, SENDER, 24_840_000n)] }] });
  await executeBaseSwapRaw(plan, { c, usdNotional: 60 });
  assert.equal(lastSwap().usd, 60);
});

// A clock that says "now" for the first `fresh` reads and `late` ms later after that.
const agingClock = (fresh, late = 3 * 60_000) => {
  let n = 0;
  return () => (n++ < fresh ? Date.now() : Date.now() + late);
};

test("a plan that ages out while the approval goes through is refused BEFORE the swap is signed, and the approval is set back to 0", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", "success"] });
  const e = await executeBaseSwap(plan, { c, clock: agingClock(1) }).catch((x) => x);
  assert.ok(e instanceof Refused);
  assert.deepEqual(e.refusals.map((r) => r.rule), ["plan_expired"]);
  assert.match(e.message, /was not signed; plan it again/);
  assert.match(e.message, /approval granted for this swap was set back to 0/);
  assert.equal(state.sent.length, 2, "approve, then the reset; no swap");
  assert.deepEqual(state.sent.map((t) => decodeFunctionData({ abi: erc20Abi, data: t.data }).args[1]), [100_000_000n, 0n]);
  assert.ok(state.sent.every((t) => t.to === USDC), "nothing was sent to the router");
  assert.equal(state.allowance, 0n);
  assert.equal(lastSwap().status, "failed");
  assert.match(lastSwap().reason, /plan expired before the swap was signed/);
  assert.equal(lastSwap().allowance, "reset");
  assert.equal(reserved(), before, "the reservation is given back");
});

test("a plan that ages out before an ETH sale is signed is refused with nothing sent", async () => {
  const before = reserved();
  const plan = await planFor("eth-to-usdc");
  const { c, state } = fakeChain({ address: SENDER });
  assert.deepEqual(await rules(executeBaseSwap(plan, { c, clock: agingClock(1) })), ["plan_expired"]);
  assert.equal(state.sent.length, 0);
  assert.equal(reserved(), before);
});

test("an allowance that was already there is not reset when the plan expires", async () => {
  const plan = await planFor("usdc-to-weth", { allowance: 500_000_000n, editSim: (s) => s.result[0].calls.shift() });
  const { c, state } = fakeChain({ address: SENDER, allowance: 500_000_000n });
  assert.deepEqual(await rules(executeBaseSwap(plan, { c, clock: agingClock(1) })), ["plan_expired"]);
  assert.equal(state.sent.length, 0);
  assert.equal(state.allowance, 500_000_000n);
});

test("a plan still fresh when the swap is signed goes through (the clock is read twice)", async () => {
  const plan = await planFor("usdc-to-weth", { allowance: 500_000_000n, editSim: (s) => s.result[0].calls.shift() });
  const { c } = fakeChain({ address: SENDER, allowance: 500_000_000n, receipts: [{ status: "success", logs: [transferLog(WETH_BASE, KYBER_ROUTER_BASE, SENDER, 40_000_000_000_000_000n)] }] });
  let reads = 0;
  const out = await executeBaseSwap(plan, { c, clock: () => (reads++, Date.now()) });
  assert.equal(reads, 2);
  assert.equal(out.received.asset, "WETH");
});

const { paths, withLock } = await import("../src/store.js");

test("a swap runs under the base-swap lock, and the lock is let go on success and on failure", async () => {
  const lockFile = paths.lock("base-swap");
  const seen = [];
  const plan = await planFor("usdc-to-eth");
  const { c } = fakeChain({ address: SENDER, receipts: ["success", "revert", "success"] });
  await assert.rejects(executeBaseSwap(plan, { c, readAllowance: async () => (seen.push(existsSync(lockFile)), 0n) }), /transaction reverted/);
  assert.ok(seen.length > 0 && seen.every(Boolean), "the lock was held while the swap ran");
  assert.equal(existsSync(lockFile), false, "released after a failure");
  const plan2 = await planFor("eth-to-usdc");
  const chain2 = fakeChain({ address: SENDER, receipts: [{ status: "success", logs: [transferLog(USDC, KYBER_ROUTER_BASE, SENDER, 24_840_000n)] }] });
  await executeBaseSwap(plan2, { c: chain2.c });
  assert.equal(existsSync(lockFile), false, "released after a success");
});

test("while another swap holds the lock a second one waits, then gives up with nothing reserved or sent", async () => {
  const before = reserved();
  const plan = await planFor("usdc-to-eth");
  const { c, state } = fakeChain({ address: SENDER });
  await withLock(
    async () => {
      await assert.rejects(executeBaseSwap(plan, { c, lockWaitMs: 150 }), /another base-swap is in progress/);
    },
    { name: "base-swap" },
  );
  assert.equal(state.sent.length, 0);
  assert.equal(reserved(), before);
});

test("two swaps started together do not interleave: approve, swap, then the next approve, swap", async () => {
  const planA = await planFor("usdc-to-eth");
  const planB = await planFor("usdc-to-weth");
  const spend = { status: "success", spends: 100_000_000n };
  const { c, state } = fakeChain({ address: SENDER, receipts: ["success", spend, "success", spend] });
  // receipts take real time, so without the lock the two swaps would overlap
  const waitForReceipt = c.pub.waitForTransactionReceipt;
  c.pub.waitForTransactionReceipt = async (a) => (await new Promise((r) => setTimeout(r, 40)), waitForReceipt(a));
  const order = [];
  const tag = (p) => async (...a) => (order.push(p), state.allowance);
  const [a, b] = await Promise.allSettled([
    executeBaseSwap(planA, { c, readAllowance: tag("A") }),
    executeBaseSwap(planB, { c, readAllowance: tag("B") }),
  ]);
  assert.equal(a.status, "fulfilled", a.reason?.message);
  assert.equal(b.status, "fulfilled", b.reason?.message);
  const kinds = state.sent.map((t) => (t.to === USDC ? `approve ${decodeFunctionData({ abi: erc20Abi, data: t.data }).args[1]}` : `swap ${t.data === planA.tx.data ? "A" : "B"}`));
  assert.equal(kinds.length, 4);
  assert.match(kinds[0], /^approve 100000000/);
  assert.match(kinds[1], /^swap [AB]/);
  assert.match(kinds[2], /^approve 100000000/);
  assert.match(kinds[3], /^swap [AB]/);
  assert.notEqual(kinds[1], kinds[3], "each swap ran once");
  // every read of the first swap came before any read of the second
  assert.equal(order.filter((x, i) => x !== order[i - 1]).length, 2, `the swaps never alternate: ${order.join("")}`);
});

test("fixtures are the recorded ones", () => {
  assert.ok(FIXTURES.endsWith("fixtures/swap-evm/"));
  assert.equal(recordedSimulation("usdc-to-eth").result[0].calls.length, 2);
});
