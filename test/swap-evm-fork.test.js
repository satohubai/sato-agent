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
import { createPublicClient, decodeFunctionData, encodeAbiParameters, erc20Abi, http, keccak256, pad, toHex } from "viem";
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

/** A live KyberSwap route + build for the fork wallet, wrapped the way Sato Hub answers. Same fee parameters Sato sends. */
async function liveSatoResponse({ tokenIn, tokenOut, units, slippageBps }) {
  const host = "https://aggregator-api.kyberswap.com/base/api/v1";
  const headers = { "user-agent": "SatoHub-swap-dev/1.0", "x-client-id": "satohub", accept: "application/json" };
  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: units.toString(), feeAmount: "15", chargeFeeBy: "currency_in", isInBps: "true", feeReceiver: SATO_FEE_RECIPIENT });
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
  return satoResponseFrom(route, build);
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

  const out = await executeBaseSwap(plan);

  assert.equal(await usdcOf(me), usdc0 - 50_000_000n, "exactly the amount left");
  const eth1 = await pub.getBalance({ address: me });
  const gas = (await gasPaid(out.tx)) + (await gasPaid(out.approve_tx));
  const gained = eth1 - eth0 + gas;
  // ETH leaves no log, so the kit reads it from the balance change; it matches to within fee components the receipt does not show
  assert.equal(out.received.basis, "balance_change");
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
  const out = await executeBaseSwap(plan);
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
  const out = await executeBaseSwap(plan);
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
