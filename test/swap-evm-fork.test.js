// Swaps on a local anvil fork of Base: the real KyberSwap router and pools, the
// real USDC, a test wallet funded with test balances. Nothing reaches the real
// chain. The route and its calldata are built LIVE by KyberSwap's public API for
// the fork wallet; Sato Hub is not called (its build-tx writes a public record),
// so the Sato-shaped response is wrapped around Kyber's answer and a passing
// signature check is injected. The kit's own simulation is the real
// eth_simulateV1 (anvil 1.8 supports it, with traceTransfers).
//
//   SATO_AGENT_FORK=1 node --test test/swap-evm-fork.test.js
// Needs `anvil` (Foundry) on PATH and network access. FORK_RPC overrides the upstream RPC.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, pad, toHex } from "viem";
import { base } from "viem/chains";
import { freshHome } from "./helpers.js";
import { passes, satoResponseFrom } from "./swap-evm-helpers.js";

const enabled = process.env.SATO_AGENT_FORK === "1";
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

freshHome();
process.env.SATO_AGENT_BASE_RPC = RPC;
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { actions, spentLast24h } = await import("../src/ledger.js");
const { USDC_BASE } = await import("../src/base.js");
const evm = await import("../src/swap/evm.js");
const { KYBER_ROUTER_BASE, SATO_FEE_RECIPIENT, TOKENS, planBaseSwap, verifyBaseSwapPlan, executeBaseSwap, dryRunBaseSwap } = evm;

let anvil;
let me;
const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 60_000 }) });
const rpc = (method, params) => pub.request({ method, params });
const usdcOf = (a) => pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const allowanceOf = (a) => pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "allowance", args: [a, KYBER_ROUTER_BASE] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function giveUsdc(addr, units) {
  for (let slot = 0; slot < 20; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
    await rpc("anvil_setStorageAt", [USDC_BASE, key, pad(toHex(units))]);
    if ((await usdcOf(addr)) === units) return slot;
    await rpc("anvil_setStorageAt", [USDC_BASE, key, pad("0x0")]);
  }
  throw new Error("could not find the USDC balance slot");
}

const MAJORS = new Set([USDC_BASE, TOKENS.WETH.address, TOKENS.ETH.address].map((a) => a.toLowerCase()));
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

/**
 * A live KyberSwap route + build for the fork wallet, wrapped the way Sato Hub answers. Same fee parameters Sato sends:
 * the fee on the input, except when a long-tail token is SOLD, where it is on the output (and the answer says so).
 */
async function liveSatoResponse({ tokenIn, tokenOut, units, slippageBps }) {
  const host = "https://aggregator-api.kyberswap.com/base/api/v1";
  const headers = { "user-agent": "SatoHub-swap-dev/1.0", "x-client-id": "satohub", accept: "application/json" };
  const sellsLongTail = !MAJORS.has(tokenIn.toLowerCase());
  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: units.toString(), feeAmount: "15", chargeFeeBy: sellsLongTail ? "currency_out" : "currency_in", isInBps: "true", feeReceiver: SATO_FEE_RECIPIENT });
  const route = await (await fetch(`${host}/routes?${q}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
  assert.equal(route.code, 0, `kyber routes: ${route.message}`);
  await sleep(1500);
  const build = await (
    await fetch(`${host}/route/build`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: me, recipient: me, slippageTolerance: slippageBps, source: "satohub" }),
      signal: AbortSignal.timeout(30_000),
    })
  ).json();
  assert.equal(build.code, 0, `kyber build: ${build.message}`);
  await sleep(1500);
  return satoResponseFrom(route, build, { feeSide: sellsLongTail ? "out" : "in", market: true });
}

const gasPaid = async (hash) => {
  const r = await pub.getTransactionReceipt({ hash });
  return r.gasUsed * r.effectiveGasPrice;
};

/** plan (against a live Kyber answer) -> verify -> the plan. */
async function planLive({ from, to, amount, slippageBps = 100 }) {
  const intentArgs = { from, to, amount, slippageBps };
  let sent;
  const { response, intent } = await planBaseSwap(intentArgs, {
    taker: me,
    callTool: async (_name, args) => {
      sent = args;
      const live = await liveSatoResponse({ tokenIn: args.token_in, tokenOut: args.token_out, units: BigInt(args.amount_in), slippageBps: args.slippage_bps });
      return { text: "", structured: live, isError: false };
    },
  });
  return { response, intent, sent, verify: (extra = {}) => verifyBaseSwapPlan(response, intent, { verifySignature: passes, ...extra }) };
}

before(async () => {
  if (!enabled) return;
  anvil = spawn("anvil", ["--fork-url", process.env.FORK_RPC || "https://mainnet.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await sleep(500);
    }
  }
  me = initWallet().base;
  await rpc("anvil_setBalance", [me, toHex(10n ** 18n)]); // 1 ETH
  await giveUsdc(me, 500_000_000n); // 500 USDC
  setPolicy({ chains: "base", perTx: "1000", perDay: "10000", swapSlippageBps: "100", maxTradesPerDay: "none" });
});
after(() => anvil?.kill());
process.on("exit", () => anvil?.kill());

test("fork: USDC -> ETH, real route, real simulation, exact approval, balances move within min_out", { skip: !enabled }, async () => {
  const usdc0 = await usdcOf(me);
  const eth0 = await pub.getBalance({ address: me });

  const { verify } = await planLive({ from: "USDC", to: "ETH", amount: "50" });

  // a dry run does everything but sign
  const dry = await dryRunBaseSwap({ from: "USDC", to: "ETH", amount: "50", slippageBps: 100 }, {
    taker: me,
    usdNotional: 50,
    verifySignature: passes,
    callTool: async (_n, args) => ({ text: "", structured: await liveSatoResponse({ tokenIn: args.token_in, tokenOut: args.token_out, units: BigInt(args.amount_in), slippageBps: args.slippage_bps }), isError: false }),
  });
  assert.equal(dry.simulated, true);
  assert.equal(dry.simulation.source, "eth_simulateV1");
  assert.equal(await usdcOf(me), usdc0, "a dry run moves nothing");
  assert.equal(spentLast24h().usd, 0);

  const plan = await verify();
  assert.equal(plan.router, KYBER_ROUTER_BASE);
  assert.equal(plan.approval.needed, true);
  assert.equal(plan.simulation.source, "eth_simulateV1");
  assert.equal(-plan.simulation.in_delta, 50_000_000n);
  assert.ok(plan.simulation.out_delta >= plan.min_out);
  assert.equal(plan.simulation.fee_seen, 75_000n, "15 bps of 50 USDC reached the fee address");
  assert.equal(await allowanceOf(me), 0n);

  const out = await executeBaseSwap(plan, { usdNotional: plan.usd });

  assert.equal(await usdcOf(me), usdc0 - 50_000_000n, "exactly the amount left");
  const eth1 = await pub.getBalance({ address: me });
  const gas = (await gasPaid(out.tx)) + (await gasPaid(out.approve_tx));
  const gained = eth1 - eth0 + gas;
  // ETH leaves no Transfer log, so the kit reads the router's own Swapped event (no extra RPC read); it matches the balances to within fee components the receipt does not show
  assert.equal(out.received.basis, "router_event");
  const reported = BigInt(Math.round(Number(out.received.amount) * 1e18));
  assert.ok(reported >= gained - 10n ** 12n && reported <= gained + 10n ** 12n, `kit read ${reported}, balances say ${gained}`);
  assert.ok(gained >= plan.min_out, `received ${gained} >= min_out ${plan.min_out}`);
  // the approval was for exactly the amount, to the pinned router, and nothing is left open
  const approveTx = await pub.getTransaction({ hash: out.approve_tx });
  const a = decodeFunctionData({ abi: erc20Abi, data: approveTx.input });
  assert.deepEqual([approveTx.to.toLowerCase(), a.functionName, a.args[0], a.args[1]], [USDC_BASE.toLowerCase(), "approve", KYBER_ROUTER_BASE, 50_000_000n]);
  assert.equal(await allowanceOf(me), 0n);
  assert.deepEqual(out.warnings, []);

  const row = actions().filter((x) => x.kind === "swap").at(-1);
  assert.equal(row.status, "confirmed");
  assert.equal(row.tx, out.tx);
  assert.equal(row.approve_tx, out.approve_tx);
  assert.equal(row.usd, 50);
  assert.equal(spentLast24h().usd, 50);
});

test("fork: ETH -> USDC, native value, USDC arrives within min_out", { skip: !enabled }, async () => {
  const usdc0 = await usdcOf(me);
  const eth0 = await pub.getBalance({ address: me });
  const { verify } = await planLive({ from: "ETH", to: "USDC", amount: "0.01" });
  const plan = await verify({ usdNotional: 25 });
  assert.equal(plan.approval.needed, false);
  assert.equal(plan.tx.value, 10n ** 16n);
  const out = await executeBaseSwap(plan, { usdNotional: plan.usd });
  assert.equal(out.approve_tx, null);
  const usdc1 = await usdcOf(me);
  assert.ok(usdc1 - usdc0 >= plan.min_out, `received ${usdc1 - usdc0} >= min_out ${plan.min_out}`);
  assert.equal(out.received.amount, evm.unitsToDecimal(usdc1 - usdc0, 6));
  const eth1 = await pub.getBalance({ address: me });
  const extra = eth0 - eth1 - 10n ** 16n - (await gasPaid(out.tx));
  assert.ok(extra >= 0n && extra < 10n ** 11n, `0.01 ETH plus gas left (anvil's OP-stack fee components add ${extra} wei)`);
});

test("fork: USDC -> WETH delivers WETH", { skip: !enabled }, async () => {
  const weth = (a) => pub.readContract({ address: TOKENS.WETH.address, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const w0 = await weth(me);
  const { verify } = await planLive({ from: "USDC", to: "WETH", amount: "20" });
  const plan = await verify();
  const out = await executeBaseSwap(plan, { usdNotional: plan.usd });
  const w1 = await weth(me);
  assert.ok(w1 - w0 >= plan.min_out);
  assert.equal(out.received.amount, evm.unitsToDecimal(w1 - w0, 18));
  assert.equal(await allowanceOf(me), 0n);
});

test("fork: the kit's own simulation catches what Sato's cannot see (a real route for more USDC than the wallet holds)", { skip: !enabled }, async () => {
  const { verify } = await planLive({ from: "USDC", to: "ETH", amount: "5000" });
  await assert.rejects(verify(), (e) => e instanceof Refused && e.refusals[0].rule === "simulation_failed");
  // nothing was reserved or signed by any of that
  assert.equal(actions().filter((x) => x.kind === "swap" && x.status === "failed").length, 0);
});

test("fork: a stranger's router is refused before any simulation or signature", { skip: !enabled }, async () => {
  const { response, intent } = await planLive({ from: "USDC", to: "ETH", amount: "10" });
  response.tx.to = "0x0000000000001fF3684f28c67538d4D072C22734";
  await assert.rejects(verifyBaseSwapPlan(response, intent, { verifySignature: passes }), (e) => e instanceof Refused && e.refusals[0].rule === "router_not_pinned");
});

// The adversarial review's attack: a build whose own floor is 1 unit. The kit's simulation would still pass it (the pool
// can pay in a simulation); the transaction itself is what has to carry the minimum.
const tamperedLive = async (change) => {
  const live = await planLive({ from: "USDC", to: "ETH", amount: "10" });
  const ex = decodeFunctionData({ abi: evm.KYBER_ROUTER_ABI, data: live.response.tx.data }).args[0];
  const copy = JSON.parse(JSON.stringify(ex, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
  change(copy.desc);
  live.response.tx.data = encodeFunctionData({ abi: evm.KYBER_ROUTER_ABI, functionName: "swap", args: [copy] });
  return live;
};

test("fork: a live Kyber build with minReturnAmount = 1 is refused as min_out_not_enforced", { skip: !enabled }, async () => {
  const honest = await planLive({ from: "USDC", to: "ETH", amount: "10" });
  const plan = await honest.verify();
  assert.ok(plan.min_out_in_transaction >= plan.min_out - 1n && plan.min_out_in_transaction <= plan.min_out, "an honest live build carries Kyber's own rounding of the minimum");
  const { response, intent } = await tamperedLive((d) => (d.minReturnAmount = 1n));
  await assert.rejects(verifyBaseSwapPlan(response, intent, { verifySignature: passes }), (e) => e instanceof Refused && e.refusals.map((r) => r.rule).join() === "min_out_not_enforced");
});

test("fork: a live build that pays someone else, or takes a second fee, is refused", { skip: !enabled }, async () => {
  const stranger = "0x000000000000000000000000000000000000dEaD";
  let t = await tamperedLive((d) => (d.dstReceiver = stranger));
  await assert.rejects(verifyBaseSwapPlan(t.response, t.intent, { verifySignature: passes }), (e) => e instanceof Refused && e.refusals.map((r) => r.rule).join() === "recipient_not_taker");
  t = await tamperedLive((d) => { d.feeReceivers = [...d.feeReceivers, stranger]; d.feeAmounts = [...d.feeAmounts, 100n]; });
  await assert.rejects(verifyBaseSwapPlan(t.response, t.intent, { verifySignature: passes }), (e) => e instanceof Refused && e.refusals.map((r) => r.rule).join() === "fee_not_as_disclosed");
});

test("fork: the kit's simulation runs with the chain's real base fee, so BASEFEE is not zero inside it", { skip: !enabled }, async () => {
  // a contract that returns the BASEFEE opcode: 48 5f 52 60 20 5f f3
  const probe = "0x00000000000000000000000000000000000b45ef";
  const code = "0x485f5260205ff3";
  const latest = await pub.getBlock({ blockTag: "latest" });
  assert.ok(latest.baseFeePerGas > 0n);
  const call = async (params) => {
    params[0].blockStateCalls[0].stateOverrides = { [probe]: { code } };
    params[0].blockStateCalls[0].calls = [{ from: me, to: probe, data: "0x" }];
    const [blk] = await rpc("eth_simulateV1", params);
    assert.equal(blk.calls[0].status, "0x1");
    return BigInt(blk.calls[0].returnData);
  };
  const plain = await call(evm.buildSimulationRequest({ taker: me, calls: [{ to: probe, data: "0x" }] }));
  assert.equal(plain, 0n, "eth_simulateV1's default block has a zero base fee: exactly what a hostile pool could look for");
  const real = await call(evm.buildSimulationRequest({ taker: me, calls: [{ to: probe, data: "0x" }], baseFeePerGas: latest.baseFeePerGas, maxPriorityFeePerGas: 1_000_000n }));
  assert.equal(real, latest.baseFeePerGas);
});

// ---------------------------------------------------------------- any ERC-20: DEGEN against USDC and ETH, live routes, real simulation

const tokenBal = (token, owner) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
const degenAllowance = () => pub.readContract({ address: DEGEN, abi: erc20Abi, functionName: "allowance", args: [me, KYBER_ROUTER_BASE] });

test("fork: BUY DEGEN with USDC: fee in USDC, the sell-back is simulated against a live route and never sent, balances move within min_out", { skip: !enabled }, async () => {
  const usdc0 = await usdcOf(me);
  const degen0 = await tokenBal(DEGEN, me);
  const feeUsdc0 = await usdcOf(SATO_FEE_RECIPIENT);
  const feeDegen0 = await tokenBal(DEGEN, SATO_FEE_RECIPIENT);
  const nonce0 = await pub.getTransactionCount({ address: me });

  const { verify, sent, response, intent } = await planLive({ from: "USDC", to: DEGEN, amount: "20" });
  assert.equal(sent.token_out, DEGEN);
  assert.equal(intent.tokenOut.decimals, 18, "read from the chain");
  assert.equal(intent.tokenOut.symbol, "DEGEN");
  assert.equal(response.sato_fee_side, "in");
  const plan = await verify(); // the DEFAULT sell-back builder: KyberSwap's live API
  assert.equal(plan.fee.side, "in");
  assert.equal(plan.long_tail, "out");
  assert.equal(plan.sell_back.checked, true);
  assert.equal(plan.sell_back.sold_units, plan.simulation.out_delta, "everything the buy delivers");
  assert.ok(plan.sell_back.loss_bps < plan.sell_back.allowed_loss_bps, `round trip lost ${plan.sell_back.loss_bps} bps`);
  assert.equal(plan.simulation.fee_seen, 30_000n, "15 bps of 20 USDC reached the fee address");
  assert.ok(plan.market && plan.market.amount_in_usd > 0 && plan.market.amount_out_usd > 0, "the route's USD figures are carried");
  assert.equal(await usdcOf(me), usdc0, "verifying moves nothing");

  const out = await executeBaseSwap(plan, { usdNotional: plan.usd });
  assert.equal(await pub.getTransactionCount({ address: me }), nonce0 + 2, "approve + swap: the sell-back leg was never sent");
  assert.equal(await usdcOf(me), usdc0 - 20_000_000n, "exactly the amount left");
  const degen1 = await tokenBal(DEGEN, me);
  assert.ok(degen1 - degen0 >= plan.min_out, `received ${degen1 - degen0} >= min_out ${plan.min_out}`);
  assert.equal(out.received.amount, evm.unitsToDecimal(degen1 - degen0, 18));
  assert.equal(out.received.basis, "receipt_logs");
  assert.equal((await usdcOf(SATO_FEE_RECIPIENT)) - feeUsdc0, 30_000n, "the fee landed in USDC, not in DEGEN");
  assert.equal((await tokenBal(DEGEN, SATO_FEE_RECIPIENT)) - feeDegen0, 0n);
  assert.equal(await allowanceOf(me), 0n);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.sato_fee, { bps: 15, recipient: SATO_FEE_RECIPIENT, side: "in" });
  assert.equal(actions().filter((x) => x.kind === "swap").at(-1).token_out, DEGEN);
});

test("fork: the router checks its minimum against the NET output of a sale (what the agent receives), not the output before the fee", { skip: !enabled }, async () => {
  const have = await tokenBal(DEGEN, me);
  assert.ok(have > 0n, "the previous test bought DEGEN");
  const { response, intent } = await planLive({ from: DEGEN, to: "USDC", amount: evm.unitsToDecimal(have, 18) });
  const plan = await verifyBaseSwapPlan(response, intent, { verifySignature: passes });
  const net = plan.simulation.out_delta;
  const gross = net + plan.simulation.fee_seen;
  assert.ok(gross > net);
  // the same transaction with its minimum set to exactly what the simulation delivers: it passes. One unit more: it reverts,
  // although the output BEFORE the fee is far above that. So the compared amount is the net.
  const ex = decodeFunctionData({ abi: evm.KYBER_ROUTER_ABI, data: response.tx.data }).args[0];
  const withMin = (min) => {
    const copy = JSON.parse(JSON.stringify(ex, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    copy.desc.minReturnAmount = min;
    return encodeFunctionData({ abi: evm.KYBER_ROUTER_ABI, functionName: "swap", args: [copy] });
  };
  const latest = await pub.getBlock({ blockTag: "latest" });
  const run = async (min) => {
    const calls = [
      { to: DEGEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, have] }), gas: 100_000n },
      { to: KYBER_ROUTER_BASE, data: withMin(min), gas: 2_000_000n },
    ];
    const [blk] = await rpc("eth_simulateV1", evm.buildSimulationRequest({ taker: me, calls, baseFeePerGas: latest.baseFeePerGas, maxPriorityFeePerGas: 1_000_000n }));
    return blk.calls[1];
  };
  const atNet = await run(net);
  assert.equal(atNet.status, "0x1", "a minimum equal to the net output passes");
  const above = await run(net + 1n);
  assert.equal(above.status, "0x0", `a minimum one unit above the net output reverts, though ${gross} was produced before the fee`);
  assert.match(JSON.stringify(above), /Return amount is not enough/i);
});

test("fork: SELL DEGEN for USDC: the fee comes off the USDC received (FEE_ON_DST), balances and the fee address check out", { skip: !enabled }, async () => {
  const degen0 = await tokenBal(DEGEN, me);
  const usdc0 = await usdcOf(me);
  const feeUsdc0 = await usdcOf(SATO_FEE_RECIPIENT);
  const feeDegen0 = await tokenBal(DEGEN, SATO_FEE_RECIPIENT);
  const nonce0 = await pub.getTransactionCount({ address: me });

  const { verify, response } = await planLive({ from: DEGEN, to: "USDC", amount: evm.unitsToDecimal(degen0, 18) });
  assert.equal(response.sato_fee_side, "out");
  assert.ok((decodeFunctionData({ abi: evm.KYBER_ROUTER_ABI, data: response.tx.data }).args[0].desc.flags & evm.KYBER_FLAGS.FEE_ON_DST) !== 0n, "Kyber built it with FEE_ON_DST");
  const plan = await verify();
  assert.equal(plan.fee.side, "out");
  assert.equal(plan.long_tail, "in");
  assert.equal(plan.sell_back, null);
  assert.equal(plan.approval.needed, true);
  assert.ok(plan.usd > 0, "the USDC measured is the value held to the limits");

  const out = await executeBaseSwap(plan, { usdNotional: plan.usd });
  assert.equal(await pub.getTransactionCount({ address: me }), nonce0 + 2);
  assert.equal(await tokenBal(DEGEN, me), 0n, "all of it sold");
  const net = (await usdcOf(me)) - usdc0;
  const fee = (await usdcOf(SATO_FEE_RECIPIENT)) - feeUsdc0;
  assert.ok(net >= plan.min_out, `the net USDC received ${net} >= min_out ${plan.min_out}`);
  assert.equal(out.received.amount, evm.unitsToDecimal(net, 6), "the receipt's Transfer logs say what the wallet got: net of the fee");
  assert.equal(out.received.basis, "receipt_logs");
  const gross = net + fee;
  assert.ok(fee > 0n && fee * 10_000n <= gross * 15n && fee * 10_000n >= gross * 15n - 10_000n, `15 bps of the gross ${gross} went to the fee address (${fee})`);
  assert.equal(fee, plan.simulation.fee_seen, "the kit's simulation predicted it exactly");
  assert.equal((await tokenBal(DEGEN, SATO_FEE_RECIPIENT)) - feeDegen0, 0n, "no DEGEN ever reached the fee address");
  assert.equal(await degenAllowance(), 0n, "the DEGEN approval is back to 0");
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.sato_fee, { bps: 15, recipient: SATO_FEE_RECIPIENT, side: "out" });
  const row = actions().filter((x) => x.kind === "swap").at(-1);
  assert.deepEqual([row.status, row.asset_in, row.asset_out, row.sato_fee_side], ["confirmed", "DEGEN", "USDC", "out"]);
  assert.equal(row.approve_tx, out.approve_tx);
});

test("fork: ETH -> DEGEN -> ETH: the fee in native ETH on both sides of a round trip", { skip: !enabled }, async () => {
  const feeEth0 = await pub.getBalance({ address: SATO_FEE_RECIPIENT });
  const buy = await planLive({ from: "ETH", to: DEGEN, amount: "0.01" });
  const buyPlan = await buy.verify({ usdNotional: 25 });
  assert.equal(buyPlan.sell_back.checked, true);
  assert.equal(buyPlan.usd, 25, "no USDC leg: the caller's independent figure counts");
  await executeBaseSwap(buyPlan, { usdNotional: 25 });
  const feeEth1 = await pub.getBalance({ address: SATO_FEE_RECIPIENT });
  assert.equal(feeEth1 - feeEth0, 15_000_000_000_000n, "15 bps of 0.01 ETH, on the input");

  const have = await tokenBal(DEGEN, me);
  assert.ok(have > 0n);
  const eth0 = await pub.getBalance({ address: me });
  const sell = await planLive({ from: DEGEN, to: "ETH", amount: evm.unitsToDecimal(have, 18) });
  const sellPlan = await sell.verify({ usdNotional: 25 });
  assert.equal(sellPlan.fee.side, "out");
  const out = await executeBaseSwap(sellPlan, { usdNotional: 25 });
  assert.equal(await tokenBal(DEGEN, me), 0n);
  const gas = (await gasPaid(out.tx)) + (await gasPaid(out.approve_tx));
  const gained = (await pub.getBalance({ address: me })) - eth0 + gas;
  const reported = BigInt(Math.round(Number(out.received.amount) * 1e18));
  assert.equal(out.received.basis, "router_event", "ETH out leaves no Transfer log: the router's own event is read, and it is the net of the fee");
  assert.ok(reported >= gained - 10n ** 12n && reported <= gained + 10n ** 12n, `kit read ${reported}, balances say ${gained}`);
  assert.ok(gained >= sellPlan.min_out);
  const feeOut = (await pub.getBalance({ address: SATO_FEE_RECIPIENT })) - feeEth1;
  // exact: the router's own event is the net, so net + fee is the gross and the fee is 15 bps of it
  const net = evm.decimalToUnits(out.received.amount, 18);
  const gross = net + feeOut;
  assert.ok(feeOut > 0n && feeOut * 10_000n <= gross * 15n && feeOut * 10_000n >= gross * 15n - 10_000n, `15 bps of the gross ${gross} (${feeOut})`);
  assert.equal(feeOut, sellPlan.simulation.fee_seen, "the kit's simulation predicted it exactly");
  assert.equal(await degenAllowance(), 0n);
});

test("fork: a token that does not exist, or has no readable decimals, never reaches Sato Hub", { skip: !enabled }, async () => {
  let asked = 0;
  const callTool = async () => (asked++, { text: "", structured: null, isError: true });
  // an address with no code, and a contract that is not a token (the Kyber router)
  for (const bad of ["0x000000000000000000000000000000000000dEaD", KYBER_ROUTER_BASE]) {
    await assert.rejects(planBaseSwap({ from: "USDC", to: bad, amount: "5", slippageBps: 100 }, { taker: me, callTool }), (e) => e instanceof Refused && e.refusals[0].rule === "token_unreadable", bad);
  }
  assert.equal(asked, 0);
});
