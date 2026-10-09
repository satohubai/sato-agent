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
const { decodeFunctionData, erc20Abi } = await import("viem");

const {
  KYBER_ROUTER_BASE, NATIVE_PLACEHOLDER, SATO_FEE_RECIPIENT, TOKENS, WETH_BASE,
  decimalToUnits, parseIntent, planBaseSwap, verifyBaseSwapPlan, executeBaseSwap, dryRunBaseSwap, summarizeBaseSwapPlan, assetDeltas,
} = evm;
const USDC = TOKENS.USDC.address;

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
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.sato_fee_bps = 100) })), ["fee_over_ceiling"]);
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
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_out = "1") , slippageBps: 5000 })), ["min_out_invalid"]);
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
  assert.deepEqual(await rules(verifyCase("usdc-to-eth", { edit: (r) => (r.amount_out = (BigInt(r.amount_out) * 2n).toString()) })), ["output_below_min_out"]);
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

test("a dry run is plan + verify and returns the summary; nothing is reserved", async () => {
  const response = satoResponse("usdc-to-eth");
  const out = await dryRunBaseSwap(
    { from: "USDC", to: "ETH", amount: "100", slippageBps: 50 },
    { taker: SENDER, callTool: async () => ({ text: "", structured: response, isError: false }), verifySignature: passes, simulate: replay(recordedSimulation("usdc-to-eth")), readAllowance: async () => 0n },
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

setPolicy({ chains: "base", perTx: "150", perDay: "100000", swapSlippageBps: "1000", maxTradesPerDay: "none" });
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

test("fixtures are the recorded ones", () => {
  assert.ok(FIXTURES.endsWith("fixtures/swap-evm/"));
  assert.equal(recordedSimulation("usdc-to-eth").result[0].calls.length, 2);
});
