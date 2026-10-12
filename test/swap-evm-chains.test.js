// Swaps on BNB Chain, Arbitrum and Polygon, offline. The Sato Hub responses are built from REAL KyberSwap routes and builds for each chain
// (test/fixtures/swap-evm/<chain>/, recorded by record-chain.mjs on 2026-10-12) and the kit's own eth_simulateV1 results for them
// (run against a public node with the kit's request for that chain, the input funded inside the simulation only). Sato Hub is never
// called and nothing here touches the network.
//
// Per chain: native <-> default stable (the 15 bps tier), stable <-> stable (3 bps), a long-tail token bought (fee on the input, then
// the sell-back in a second block) and sold (fee on the output, FEE_ON_DST). The amounts are decimal-aware: BNB Chain's stablecoins
// have 18 decimals, so "10 USDT" is 10e18 units and the dollar figure the limits see must still be 10.

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";
import { SENDER, fakeChain, load, passes, satoResponseFrom, topicAddr, transferLog } from "./swap-evm-helpers.js";

freshHome();
const evm = await import("../src/swap/evm.js");
const chainsMod = await import("../src/chains.js");
const { Pending, Refused, Rejected } = await import("../src/errors.js");
const baseMod = await import("../src/base.js");
const { setPolicy } = await import("../src/policy.js");
const { actions, entries } = await import("../src/ledger.js");
const { decodeFunctionData, encodeFunctionData } = await import("viem");
const { evmChain, majorTokens } = chainsMod;
const { KYBER_ROUTER_ABI: ROUTER_ABI } = evm;

setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", perTx: "500", perDay: "100000", swapSlippageBps: "500", maxTradesPerDay: "none" });

const TAILS = {
  bnb: { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "CAKE", name: "PancakeSwap Token", decimals: 18, native: false, major: false },
  arbitrum: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", name: "Arbitrum", decimals: 18, native: false, major: false },
  polygon: { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", symbol: "AAVE", name: "Aave Token", decimals: 18, native: false, major: false },
};
const NATIVE_AMOUNT = { bnb: "0.02", arbitrum: "0.005", polygon: "20" };
const clone = (o) => JSON.parse(JSON.stringify(o));
const cp = (o) => (Array.isArray(o) ? o.map(cp) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cp(v)])) : o);
const decodeBuild = (data) => cp(decodeFunctionData({ abi: ROUTER_ABI, data }).args[0]);
const encodeBuild = (execution) => encodeFunctionData({ abi: ROUTER_ABI, functionName: "swap", args: [execution] });
const tamper = (change) => (r) => {
  const ex = decodeBuild(r.tx.data);
  change(ex.desc, ex, r);
  r.tx.data = encodeBuild(ex);
};
const rules = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${e?.stack}`);
    return e.refusals.map((r) => r.rule);
  }
  assert.fail("expected a refusal");
};
const sequence = (sims, seen = []) => {
  let i = 0;
  return async (req) => {
    seen.push(req);
    return clone(sims[Math.min(i++, sims.length - 1)].result);
  };
};

/** The cases recorded for every chain, described for a chain: what to swap, the fee the Hub would charge, and the side it takes it on. */
function casesOf(key) {
  const c = evmChain(key);
  const stable = c.defaultStable;
  const other = Object.keys(c.stables).find((s) => s !== stable);
  const tail = TAILS[key];
  return {
    "native-to-stable": { from: c.native.symbol, to: stable, amount: NATIVE_AMOUNT[key], bps: 15, tier: "major", side: "in" },
    "stable-to-native": { from: stable, to: c.native.symbol, amount: "10", bps: 15, tier: "major", side: "in" },
    "stable-to-stable": { from: stable, to: other, amount: "10", bps: 3, tier: "stable", side: "in" },
    "stable-to-tail": { from: stable, to: tail, amount: "10", bps: 75, tier: "token", side: "in", sellBack: true },
    "tail-to-stable": { from: tail, to: stable, amount: "10", bps: 75, tier: "token", side: "out" },
  };
}

function recordedSellBack(key, name, seen = []) {
  return async (args) => {
    seen.push(args);
    const b = load(`${key}/${name}-sellback-build`).data;
    const r = load(`${key}/${name}-sellback-route`).data.routeSummary;
    return { to: b.routerAddress, data: b.data, value: 0n, quoted_out: r.amountOut, route_id: r.routeID };
  };
}

/** Verify one recorded case on one chain with everything injected. */
async function verifyCase(key, name, { edit, editSim, editIntent, deps = {}, allowance = 0n, side, fixture = name } = {}) {
  const meta = casesOf(key)[name];
  const c = evmChain(key);
  const intent = evm.parseIntent({ from: meta.from, to: meta.to, amount: meta.amount, slippageBps: 50, chain: key });
  intent.taker = SENDER;
  editIntent?.(intent);
  // `fixture`: another recorded route/build/simulation for the same case (the Polygon AAVE sale that needed 2.5M gas)
  const response = satoResponseFrom(load(`${key}/${fixture}-route`), load(`${key}/${fixture}-build`), { hubName: c.hubName, chainId: c.chainId, feeBps: meta.bps, feeTier: meta.tier, feeSide: side ?? meta.side });
  edit?.(response);
  const sim1 = clone(load(`${key}/${fixture}-sim`));
  editSim?.(sim1);
  const sims = [sim1];
  if (meta.sellBack) sims.push(clone(load(`${key}/${name}-sellback-sim`)));
  const seen = [];
  const sellSeen = [];
  const plan = await evm.verifyBaseSwapPlan(response, intent, {
    verifySignature: passes,
    simulate: sequence(sims, seen),
    readAllowance: async () => allowance,
    ...(meta.sellBack ? { buildSellBack: recordedSellBack(key, name, sellSeen) } : {}),
    ...deps,
  });
  return { plan, response, intent, seen, sellSeen, meta };
}

for (const key of ["bnb", "arbitrum", "polygon"]) {
  const c = evmChain(key);
  const T = majorTokens(key);
  const stableToken = T[c.defaultStable];
  const route = (name) => load(`${key}/${name}-route`).data.routeSummary;

  // ------------------------------------------------------------ the recorded builds, held to the kit's checks

  test(`${key}: the recorded builds use the pinned router and executor, and the registry's chain`, () => {
    for (const name of Object.keys(casesOf(key))) {
      const b = load(`${key}/${name}-build`).data;
      assert.equal(b.routerAddress.toLowerCase(), c.kyber.router.toLowerCase(), name);
      assert.equal(decodeBuild(b.data).callTarget.toLowerCase(), c.kyber.executor.toLowerCase(), `${name}: the executor`);
      assert.equal(b.data.slice(0, 10), evm.KYBER_SWAP_SELECTOR, name);
    }
  });

  test(`${key}: ${c.native.symbol} -> ${c.defaultStable}: native in, the fee on the input in the native coin, the stable measured with its own decimals`, async () => {
    const { plan, seen } = await verifyCase(key, "native-to-stable");
    assert.deepEqual([plan.chain, plan.chain_id], [key, c.chainId]);
    assert.equal(plan.approval.needed, false, "a native sale needs no approval");
    assert.equal(plan.approval.spender, c.kyber.router);
    assert.equal(plan.tx.value, evm.decimalToUnits(NATIVE_AMOUNT[key], 18, "x"));
    assert.deepEqual([plan.fee.tier, plan.fee.bps, plan.fee.side], ["major", 15, "in"]);
    assert.ok(plan.simulation.fee_seen > 0n, "the fee address was seen receiving the fee");
    // The USD the limits see is the stable the simulation measured, converted with ITS decimals (18 on BNB Chain, 6 elsewhere).
    const expected = Number(route("native-to-stable").amountOutUsd);
    assert.ok(Math.abs(plan.usd - expected) / expected < 0.03, `usd ${plan.usd} against the route's own ${expected}`);
    assert.equal(plan.long_tail, null);
    assert.equal(seen.length, 1, "one simulation");
    assert.equal(seen[0].calls.length, 1);
  });

  test(`${key}: ${c.defaultStable} -> ${c.native.symbol}: an exact approval to the pinned router; exactly $10 for 10 ${c.defaultStable}`, async () => {
    const { plan, seen } = await verifyCase(key, "stable-to-native");
    assert.equal(plan.approval.needed, true);
    assert.equal(plan.approval.token, stableToken.address);
    assert.equal(plan.approval.amount, 10n * 10n ** BigInt(stableToken.decimals));
    assert.equal(plan.amount_in, 10n * 10n ** BigInt(stableToken.decimals));
    assert.equal(plan.usd, 10, "decimals-aware: 10 units of a 18-decimal stable are still ten dollars");
    assert.equal(plan.fee.side, "in");
    assert.equal(seen[0].calls.length, 2, "approve, then the swap");
    assert.equal(seen[0].calls[0].to, stableToken.address);
  });

  test(`${key}: ${c.defaultStable} -> ${Object.keys(c.stables).find((s) => s !== c.defaultStable)}: a stablecoin pair is the 3 bps tier`, async () => {
    const { plan } = await verifyCase(key, "stable-to-stable");
    assert.deepEqual([plan.fee.tier, plan.fee.bps], ["stable", 3]);
    assert.equal(plan.usd, 10);
    assert.equal(plan.long_tail, null);
    // the kit's own reading of the pair, whatever Sato Hub says
    const hub = await verifyCase(key, "stable-to-stable", { edit: (r) => (r.sato_fee_tier = undefined) });
    assert.equal(hub.plan.fee.tier, "stable");
  });

  test(`${key}: a stablecoin pair priced as "major" by Sato Hub is refused as dearer than the kit's reading`, async () => {
    // the 3 bps build, claimed as the 15 bps tier: Sato Hub may call a pair CHEAPER than the kit does, never dearer
    const r = await rules(verifyCase(key, "stable-to-stable", { edit: (res) => (res.sato_fee_tier = "token") }));
    assert.deepEqual(r, ["fee_tier_mismatch"]);
    // and a fee above the stable tier's ceiling is refused whatever the label
    const over = await rules(verifyCase(key, "stable-to-stable", { edit: (res) => (res.sato_fee_bps = 16) }));
    assert.ok(over.includes("fee_over_major_ceiling") || over.includes("fee_not_as_disclosed"), over.join(","));
    // a stable pair is held to ITS ceiling (3 bps), not the major tier's 15: 4 bps is refused whatever the label, 3 is the recorded build
    const four = await rules(verifyCase(key, "stable-to-stable", { edit: (res) => (res.sato_fee_bps = 4) }));
    assert.ok(four.includes("fee_over_major_ceiling"), four.join(","));
    const fifteen = await rules(verifyCase(key, "stable-to-stable", { edit: (res) => ((res.sato_fee_bps = 15), (res.sato_fee_tier = "major")) }));
    assert.ok(fifteen.includes("fee_over_major_ceiling"), "15 bps on a stable pair priced as major: " + fifteen.join(","));
    assert.equal((await verifyCase(key, "stable-to-stable")).plan.fee.bps, 3);
  });

  test(`${key}: buying a long-tail token: the fee in ${c.defaultStable} (the input), the sell-back simulated in a second block, the round trip within the band`, async () => {
    const { plan, seen, sellSeen } = await verifyCase(key, "stable-to-tail");
    assert.deepEqual([plan.fee.tier, plan.fee.bps, plan.fee.side, plan.long_tail], ["token", 75, "in", "out"]);
    assert.equal(plan.usd, 10);
    assert.equal(plan.sell_back.checked, true);
    assert.ok(plan.sell_back.loss_bps <= plan.sell_back.allowed_loss_bps, `${plan.sell_back.loss_bps} within ${plan.sell_back.allowed_loss_bps}`);
    assert.equal(sellSeen[0].chain, key, "the sell-back is built on this chain's KyberSwap");
    assert.equal(seen.length, 2);
    assert.equal(seen[1].splitAt, 2, "the buy in one block, the sell in the next");
    assert.equal(plan.token_out.address, TAILS[key].address);
  });

  test(`${key}: selling a long-tail token: the fee comes off the ${c.defaultStable} received (FEE_ON_DST), and is never in the token`, async () => {
    const { plan } = await verifyCase(key, "tail-to-stable");
    assert.deepEqual([plan.fee.tier, plan.fee.side, plan.long_tail], ["token", "out", "in"]);
    // the USD the limits see: the stable the simulation measured for the sale, fee added back (about what the route itself valued it at)
    const valued = Number(route("tail-to-stable").amountOutUsd);
    assert.ok(Math.abs(plan.usd - valued) / valued < 0.05, `usd ${plan.usd} against the route's own ${valued}`);
    assert.ok(plan.simulation.fee_seen > 0n);
    assert.equal(plan.major_leg.asset, c.defaultStable);
    // a Sato Hub that puts the fee on the token side is refused, and so is one that says nothing but whose build does
    assert.ok((await rules(verifyCase(key, "tail-to-stable", { side: "in" }))).includes("fee_side_not_major"));
    assert.ok((await rules(verifyCase(key, "stable-to-tail", { side: "out" }))).includes("fee_side_not_major"));
  });

  // ------------------------------------------------------------ what the checks refuse

  test(`${key}: the response must be for this chain, by its display name or key, and the transaction for its chain id`, async () => {
    assert.equal((await verifyCase(key, "native-to-stable", { edit: (r) => (r.chain = key) })).plan.chain, key, "the key is accepted");
    assert.equal((await verifyCase(key, "native-to-stable", { edit: (r) => (r.chain = c.hubName.toUpperCase()) })).plan.chain, key, "any letter case of the display name");
    assert.deepEqual(await rules(verifyCase(key, "native-to-stable", { edit: (r) => (r.chain = key === "bnb" ? "Arbitrum" : "BNB Chain") })), [`chain_not_${key}`]);
    assert.deepEqual(await rules(verifyCase(key, "native-to-stable", { edit: (r) => (r.tx.chain_id = 8453) })), [`chain_not_${key}`]);
  });

  test(`${key}: a router that is not the pinned one, or an executor that is not Kyber's, is refused`, async () => {
    const stranger = "0x000000000000000000000000000000000000dEaD";
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: (r) => (r.tx.to = stranger) }))).includes("router_not_pinned"));
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: tamper((d, ex) => (ex.callTarget = stranger)) }))).includes("executor_not_pinned"));
    // the same router on ANOTHER chain's entry is not this chain's pin when the pins differ: here they are equal, so only the chain id decides
    assert.equal(evmChain(key).kyber.router, evmChain("base").kyber.router);
  });

  test(`${key}: the fee must go to Sato Hub's one address, at the disclosed rate, and the ceilings hold`, async () => {
    const stranger = "0x000000000000000000000000000000000000dEaD";
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: (r) => (r.sato_fee_recipient = stranger) }))).includes("fee_recipient_not_pinned"));
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: tamper((d) => (d.feeReceivers = [stranger])) }))).includes("fee_not_as_disclosed"));
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: (r) => (r.sato_fee_bps = 16) }))).length > 0, "above the major ceiling");
    assert.ok((await rules(verifyCase(key, "stable-to-tail", { edit: (r) => (r.sato_fee_bps = 101) }))).includes("fee_over_ceiling"), "above 1% on any pair");
  });

  test(`${key}: a build whose output goes to someone else, or whose minimum is weaker than the owner's slippage, is refused`, async () => {
    const stranger = "0x000000000000000000000000000000000000dEaD";
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: tamper((d) => (d.dstReceiver = stranger)) }))).includes("recipient_not_taker"));
    assert.ok((await rules(verifyCase(key, "native-to-stable", { edit: tamper((d) => (d.minReturnAmount = 1n)) }))).includes("min_out_not_enforced"));
  });

  test(`${key}: the kit's simulation is mandatory: one that cannot run is a refusal, and a wallet without gas says so in the chain's coin`, async () => {
    const meta = casesOf(key)["native-to-stable"];
    const c2 = evmChain(key);
    const intent = evm.parseIntent({ from: meta.from, to: meta.to, amount: meta.amount, slippageBps: 50, chain: key });
    intent.taker = SENDER;
    const response = () => satoResponseFrom(load(`${key}/native-to-stable-route`), load(`${key}/native-to-stable-build`), { hubName: c2.hubName, chainId: c2.chainId, feeBps: 15, feeTier: "major", feeSide: "in" });
    const base = { verifySignature: passes, readAllowance: async () => 0n };
    assert.deepEqual(await rules(evm.verifyBaseSwapPlan(response(), intent, { ...base, simulate: async () => { throw new Error("-32601 the method eth_simulateV1 does not exist"); } })), ["simulation_unavailable"]);
    const noGas = await evm.verifyBaseSwapPlan(response(), intent, { ...base, simulate: async () => { throw new Error("insufficient funds for gas * price + value"); } }).then(() => null, (e) => e);
    assert.ok(noGas instanceof Refused);
    assert.equal(noGas.refusals[0].rule, `not_enough_${c2.native.symbol.toLowerCase()}`);
    assert.match(noGas.refusals[0].message, new RegExp(`enough ${c2.native.symbol} on ${c2.label} for this swap's gas`));
  });

  // ------------------------------------------------------------ signing, on this chain

  test(`${key}: executing signs under this chain's locks and rows: the ledger says ${key}, the explorer is the chain's, the amounts use the chain's decimals`, async () => {
    const before = entries().filter((e) => e.kind === "swap").length;
    const { plan } = await verifyCase(key, "stable-to-native");
    const got = 5n * 10n ** 15n;
    const { c: client, state } = fakeChain({ address: SENDER, chainKey: key, receipts: ["success", { status: "success", spends: plan.amount_in, logs: [] }], balance: 10n ** 18n, balanceAfter: 10n ** 18n + got + 100_000n * 1_000_000n });
    const out = await evm.executeBaseSwap(plan, { c: client, usdNotional: plan.usd });
    assert.equal(state.sent.length, 2, "an exact approval, then the swap");
    const approve = decodeFunctionData({ abi: (await import("viem")).erc20Abi, data: state.sent[0].data });
    assert.deepEqual([state.sent[0].to, approve.functionName, approve.args[0], approve.args[1]], [stableToken.address, "approve", c.kyber.router, plan.amount_in]);
    assert.equal(state.sent[1].to, c.kyber.router);
    assert.equal(out.sold.amount, "10");
    assert.equal(out.allowance, "none_left");
    assert.match(out.explorer, new RegExp(`^${c.explorer.url.replace(/\./g, "\\.")}/tx/0x[0-9a-f]{64}$`));
    const rows = entries().filter((e) => e.kind === "swap");
    assert.equal(rows.length, before + 2 - 1, "one swap row (two lines)");
    const row = rows.at(-1);
    assert.equal(row.chain, key);
    assert.equal(row.usd, 10);
    assert.equal(row.asset_in, c.defaultStable);
    assert.equal(row.amount_in, "10");
    assert.equal(row.token_in, stableToken.address);
  });
}

// ------------------------------------------------------------------ the simulation request, per chain

test("the simulation request: block number / time overrides only where the chain tolerates them; a zero base fee prices by gas price", () => {
  const calls = [{ to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 0n }];
  const facts = { taker: SENDER, calls, blockNumber: 1000n, timestamp: 5000n, prevRandao: `0x${"11".repeat(32)}` };
  const base = evm.buildSimulationRequest({ ...facts, baseFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n, chain: "base" });
  assert.equal(base[0].blockStateCalls[0].blockOverrides.number, "0x3e9", "Base: the next block");
  assert.ok(base[0].blockStateCalls[0].blockOverrides.prevRandao);
  for (const key of ["bnb", "arbitrum", "polygon"]) {
    const req = evm.buildSimulationRequest({ ...facts, baseFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n, chain: key });
    const o = req[0].blockStateCalls[0].blockOverrides ?? {};
    assert.equal(o.number, undefined, `${key}: no block number override`);
    assert.equal(o.time, undefined, `${key}: no time override`);
    assert.equal(o.baseFeePerGas, "0xf4240", `${key}: the real base fee is still carried`);
    // a sell-back's second block is one more entry with no override either
    const two = evm.buildSimulationRequest({ ...facts, calls: [...calls, ...calls], splitAt: 1, baseFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n, chain: key });
    assert.equal(two[0].blockStateCalls.length, 2);
    assert.equal(two[0].blockStateCalls[1].blockOverrides?.number, undefined);
  }
  const bnb = evm.buildSimulationRequest({ ...facts, baseFeePerGas: 0n, legacyGasPrice: 50_000_000n, chain: "bnb" });
  assert.equal(bnb[0].blockStateCalls[0].calls[0].gasPrice, "0x2faf080");
  assert.equal(bnb[0].blockStateCalls[0].calls[0].maxFeePerGas, undefined);
  assert.equal(bnb[0].blockStateCalls[0].blockOverrides?.baseFeePerGas, undefined);
  assert.equal(bnb[0].validation, false);
  assert.equal(bnb[0].traceTransfers, true);
  assert.deepEqual(evm.laterBlocks("bnb"), [{ blocks: 1, seconds: 1 }, { blocks: 2, seconds: 2 }]);
});

test("defaultSimulate on BNB Chain: a zero base fee is read as legacy pricing; anywhere else it is a refusal, never a guess", async () => {
  const mk = (chainKey, baseFeePerGas) => {
    const seen = [];
    return {
      seen,
      c: {
        chainKey,
        pub: {
          async getBlock() {
            return { baseFeePerGas, number: 100n, timestamp: 1000n, mixHash: `0x${"00".repeat(32)}` };
          },
          async getGasPrice() {
            return 50_000_000n;
          },
          async estimateMaxPriorityFeePerGas() {
            return 1n;
          },
          async request({ method, params }) {
            seen.push({ method, params });
            return [{ calls: [] }];
          },
        },
      },
    };
  };
  const bnb = mk("bnb", 0n);
  await evm.defaultSimulate({ taker: SENDER, calls: [{ to: SENDER, data: "0x", value: 0n }], c: bnb.c });
  assert.equal(bnb.seen[0].method, "eth_simulateV1");
  assert.equal(bnb.seen[0].params[0].blockStateCalls[0].calls[0].gasPrice, "0x2faf080");
  assert.equal(bnb.seen[0].params[0].blockStateCalls[0].blockOverrides, undefined, "no overrides at all: no block number, no time, no prevrandao");

  const base = mk("base", 0n);
  await assert.rejects(evm.defaultSimulate({ taker: SENDER, calls: [{ to: SENDER, data: "0x", value: 0n }], c: base.c }), /no base fee/);
  assert.deepEqual(base.seen, [], "nothing was simulated");
  const arb = mk("arbitrum", 20_000_000n);
  await evm.defaultSimulate({ taker: SENDER, calls: [{ to: SENDER, data: "0x", value: 0n }], c: arb.c });
  const call = arb.seen[0].params[0].blockStateCalls[0].calls[0];
  assert.equal(call.maxFeePerGas, "0x16e3601", "base fee x 1.2 + the tip (24,000,001)");
  assert.equal(arb.seen[0].params[0].blockStateCalls[0].blockOverrides.number, undefined);
});

// ------------------------------------------------------------------ the swap path above the chain module: sizing, copy, approval

test("sizing a swap on BNB Chain: the BNB price comes from BNB's own feed, a stablecoin amount is its own dollars, the copy names USDT", async () => {
  const { sizeSwap, swapIntent, swapLines } = await import("../src/swap/run.js");
  const asked = [];
  const oraclePrice = async (asset, opts) => (asked.push([asset, opts]), { asset, usd: 750, updated_at: new Date().toISOString(), age_s: 10, source: "chainlink:bnb:0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE" });
  const sellBnb = await sizeSwap({ chain: "bnb", from: "BNB", to: "USDT", amount: "0.02", slippageBps: 50 }, { oraclePrice });
  assert.deepEqual(asked[0], ["BNB", { chain: "bnb" }]);
  assert.deepEqual([sellBnb.volatile, sellBnb.usd, sellBnb.usdBasis], ["BNB", 15, "oracle"]);
  const sellUsdt = await sizeSwap({ chain: "bnb", from: "USDT", to: "WBNB", amount: "10", slippageBps: 50 }, { oraclePrice });
  assert.deepEqual([sellUsdt.usd, sellUsdt.usdBasis, sellUsdt.volatile], [10, "usdc_amount", "BNB"]);
  const usdc = await sizeSwap({ chain: "bnb", from: "USDC", to: "USDT", amount: "10", slippageBps: 50 }, { oraclePrice });
  assert.deepEqual([usdc.usd, usdc.volatile], [10, null], "a stable pair needs no oracle");
  // the wording is the chain's own
  await assert.rejects(sizeSwap({ chain: "bnb", from: "BNB", to: "WBNB", amount: "1", slippageBps: 50 }, { oraclePrice }), /one side of a swap must be USDT or USDC \(this version\)/);
  await assert.rejects(sizeSwap({ chain: "bnb", from: "USDT", to: "DAI", amount: "1", slippageBps: 50 }, { oraclePrice }), /on bnb the kit swaps USDT, USDC, BNB, WBNB, or a token by its 0x contract address/);
  await assert.rejects(sizeSwap({ chain: "bnb", from: "USDT", to: "BNB", amount: "all", slippageBps: 50 }, { oraclePrice }), /for USDT, USDC, BNB or WBNB give an amount/);
  // and the intent the owner approves, and the lines they read
  const intent = swapIntent(sellBnb);
  assert.deepEqual([intent.chain, intent.fee_tier, intent.fee_max_bps], ["bnb", "major", 15]);
  const { approvalFeeLine, feeText } = await import("../src/swap/fee-tier.js");
  assert.equal(approvalFeeLine("major", "bnb"), "Sato Hub fee: 0.15% for BNB or WBNB with USDT or USDC (this approval allows up to 0.15%).");
  assert.equal(feeText(15, "major", "arbitrum"), "0.15% (15 bps, ETH/WETH with USDC or USDT)");
  // Base and Solana keep v0.3's words
  assert.equal(approvalFeeLine("major", "base"), "Sato Hub fee: 0.15% for ETH or SOL with USDC (this approval allows up to 0.15%).");
  assert.equal(approvalFeeLine("major"), "Sato Hub fee: 0.15% for ETH or SOL with USDC (this approval allows up to 0.15%).");
  assert.equal(feeText(15, "major", "solana"), "0.15% (15 bps, ETH/SOL with USDC)");
  const lines = swapLines({
    chain: "bnb", venue: "kyberswap", sell: { asset: "USDT", amount: "10" }, buy: { asset: "BNB", quoted: "0.013", minimum: "0.0129", slippage_bps: 50 }, usd_held_to_limits: 10, usd_basis: "usdc_amount",
    sato_fee: { bps: 15, tier: "major", asset: "USDT", disclosure: "" }, simulation: {},
  });
  assert.match(lines[0], /^BNB Chain swap via kyberswap: sell 10 USDT/);
  assert.ok(lines.some((l) => l.includes("Held to your limits as $10 (from the USDT amount).")));
  assert.ok(lines.some((l) => l.includes("0.15% (15 bps, BNB/WBNB with USDT or USDC), taken in USDT")));
});

test("a bare 0x address with no --chain is the bot's own EVM chain; with two it must be named", async () => {
  const { evmChainFor } = await import("../src/policy.js");
  assert.equal(evmChainFor(undefined, undefined, { chains: ["bnb", "solana"] }), "bnb");
  assert.equal(evmChainFor(undefined, "register", { chains: ["polygon"] }), "polygon");
  assert.equal(evmChainFor(undefined, "register", null), "base", "no policy yet: v0.3's default");
  assert.equal(evmChainFor(undefined, "register", { chains: ["solana"] }), "base", "no EVM chain: the command's own check says so");
  assert.equal(evmChainFor("arbitrum", "register", { chains: ["arbitrum", "base"] }), "arbitrum");
  assert.throws(() => evmChainFor(undefined, undefined, { chains: ["base", "bnb"] }), /works on Base and BNB Chain: say which with --chain base\|bnb/);
  assert.throws(() => evmChainFor("solana", "register", { chains: ["solana"] }), /--chain must be/);
  await assert.rejects(async () => evmChainFor("bnb", "register", { chains: ["base"] }), (e) => e instanceof Refused && e.refusals[0].rule === "chain_not_allowed");
});

// ------------------------------------------------------------------ gas: a cap per chain, and Arbitrum's L1 cost

test("the gas cap is the chain's own: the simulation's calls carry it, and the signing limit stays within it", async () => {
  assert.deepEqual(["base", "bnb", "arbitrum", "polygon"].map((k) => evm.simGasSwap(k)), [2_000_000n, 2_000_000n, 2_000_000n, 5_000_000n]);
  for (const key of ["bnb", "arbitrum", "polygon"]) {
    for (const name of ["stable-to-native", "tail-to-stable"]) {
      const { plan, seen } = await verifyCase(key, name);
      const calls = seen[0].calls;
      assert.equal(calls.at(-1).gas, evm.simGasSwap(key), `${key} ${name}: the swap is simulated with the chain's cap`);
      if (calls.length === 2) assert.equal(calls[0].gas, 100_000n, "an approval keeps its own");
      const used = BigInt(plan.simulation.gas_used.at(-1));
      const want = (used * 3n) / 2n + 50_000n;
      assert.equal(evm.swapGasLimit(plan), want > evm.simGasSwap(key) ? evm.simGasSwap(key) : want, `${key} ${name}: half again plus a margin, within the cap`);
    }
  }
  // A recorded Polygon sale of AAVE (2026-10-12, tail-to-stable-heavy-*) used 2,522,648 gas, more than the 2,000,000 cap the other
  // chains keep: with the cap Polygon had in 0.4.0 it would have been refused. With Polygon's own cap it verifies, is simulated
  // with 5,000,000 and is signed with half again of what it used.
  const heavy = await verifyCase("polygon", "tail-to-stable", { fixture: "tail-to-stable-heavy" });
  assert.equal(BigInt(heavy.plan.simulation.gas_used.at(-1)), 2_522_648n);
  assert.equal(heavy.seen[0].calls.at(-1).gas, 5_000_000n);
  assert.equal(evm.swapGasLimit(heavy.plan), (2_522_648n * 3n) / 2n + 50_000n);
  // the same heavy route on a chain capped at 2M would have been held to 2M (BNB Chain's plan shape, a made-up plan with that gas)
  assert.equal(evm.swapGasLimit({ chain: "bnb", simulation: { gas_used: ["2522648"] } }), 2_000_000n);
  assert.equal(evm.swapGasLimit({ chain: "polygon", simulation: { gas_used: ["2522648"] } }), 3_833_972n);
  assert.equal(evm.swapGasLimit({ simulation: { gas_used: ["2522648"] } }), 2_000_000n, "no chain: Base's, unchanged");
});

const APPROVE_SELECTOR = "0x095ea7b3";
const isReset = (data) => data.startsWith(APPROVE_SELECTOR) && /^0+$/.test(data.slice(-64));

async function arbitrumRun({ estimate, receipts = ["success", { status: "success", logs: [] }], spends = true, name = "stable-to-native", deps = {} }) {
  const { plan } = await verifyCase("arbitrum", name);
  const got = 5n * 10n ** 15n;
  const rec = receipts.map((r) => (spends && typeof r === "object" ? { ...r, spends: plan.amount_in } : r));
  const { c, state } = fakeChain({ address: SENDER, chainKey: "arbitrum", estimate, receipts: rec, balance: 10n ** 18n, balanceAfter: 10n ** 18n + got + 100_000n * 1_000_000n });
  const result = await evm.executeBaseSwap(plan, { c, usdNotional: plan.usd, estimateRetryMs: 0, ...deps }).then((out) => ({ out }), (error) => ({ error }));
  return { plan, state, ...result };
}

test("Arbitrum: every signed transaction carries max(the simulation-based limit, eth_estimateGas for that exact transaction)", async () => {
  // the node's estimates (the L1 data cost included) are above what the simulation alone gives: they win, for the approval and the swap
  const { plan, state, out, error } = await arbitrumRun({ estimate: (args) => (args.data.startsWith(APPROVE_SELECTOR) ? 300_000n : 4_000_000n) });
  assert.equal(error, undefined, error?.stack);
  assert.equal(state.sent.length, 2);
  assert.equal(state.sent[0].gas, 300_000n, "the approval: the estimate is above the 100,000 floor");
  assert.equal(state.sent[1].gas, 4_000_000n, "the swap: the estimate is above the simulation-based limit");
  assert.ok(evm.swapGasLimit(plan) < 4_000_000n);
  assert.deepEqual(state.estimated.map((a) => [a.to, a.data.slice(0, 10)]), [[plan.token_in.address, APPROVE_SELECTOR], [plan.tx.to, plan.tx.data.slice(0, 10)]], "each exact transaction was estimated, from the bot's account");
  assert.ok(state.estimated.every((a) => a.account.address === SENDER));
  assert.equal(out.sold.amount, "10");
  // estimates BELOW the floors: the simulation-based limit stays
  const low = await arbitrumRun({ estimate: () => 21_000n });
  assert.equal(low.state.sent[0].gas, 100_000n);
  assert.equal(low.state.sent[1].gas, evm.swapGasLimit(low.plan));
});

test("Arbitrum: a swap that needs no approval is estimated too, and a native sale carries its value in the estimate", async () => {
  const { plan } = await verifyCase("arbitrum", "native-to-stable");
  assert.equal(plan.approval.needed, false);
  const router = evmChain("arbitrum").kyber.router;
  const stable = majorTokens("arbitrum")[evmChain("arbitrum").defaultStable];
  const { c, state } = fakeChain({ address: SENDER, chainKey: "arbitrum", estimate: () => 2_500_000n, receipts: [{ status: "success", logs: [transferLog(stable.address, router, SENDER, plan.quoted_out)] }] });
  const out = await evm.executeBaseSwap(plan, { c, usdNotional: plan.usd, estimateRetryMs: 0 });
  assert.equal(out.sold.asset, "ETH");
  assert.equal(state.sent.length, 1, "no approval, one transaction");
  assert.equal(state.sent[0].gas, 2_500_000n, "the node's estimate is above the simulation-based limit");
  assert.equal(state.estimated[0].value, plan.tx.value, "the estimate is for the exact transaction, its value included");
  assert.equal(state.estimated[0].to, plan.tx.to);
});

test("Arbitrum: a node that will not estimate is a refusal and nothing is signed: for the approval, and for the swap (the approval is then set back to 0)", async () => {
  const flaky = await arbitrumRun({ estimate: () => { throw new Error("execution reverted: TRANSFER_FROM_FAILED"); } });
  assert.ok(flaky.error instanceof Refused, flaky.error?.stack);
  assert.equal(flaky.error.refusals[0].rule, "gas_estimate_failed");
  assert.match(flaky.error.message, /would not estimate the gas for this approval on Arbitrum/);
  assert.equal(flaky.state.sent.length, 0, "nothing was signed");
  assert.equal(flaky.state.estimated.length, 3, "tried three times (a node right after a block can lag), then refused");
  // the approval estimates, the swap does not: the approval already granted is reset, and the swap is not sent
  const swapFails = await arbitrumRun({ estimate: (args) => { if (args.data.startsWith(APPROVE_SELECTOR)) return 120_000n; throw new Error("execution reverted"); } });
  assert.ok(swapFails.error instanceof Refused);
  assert.equal(swapFails.error.refusals[0].rule, "gas_estimate_failed");
  assert.match(swapFails.error.message, /for this swap on Arbitrum/);
  assert.match(swapFails.error.message, /approval granted for this swap was set back to 0/);
  assert.equal(swapFails.state.sent.length, 2, "the approval, then its reset; never the swap");
  assert.equal(swapFails.state.sent[1].to, swapFails.plan.token_in.address);
  assert.ok(isReset(swapFails.state.sent[1].data));
  const row = actions().filter((e) => e.kind === "swap").at(-1);
  assert.deepEqual([row.status, row.reason], ["failed", "failed before broadcast"], "the reservation was released: nothing went out, so it no longer counts against the limits");
});

test("Arbitrum: the reset carries its estimate; a reset the node will not estimate still goes out, with a generous fixed limit", async () => {
  // swap succeeds but leaves its allowance (no `spends`): the kit sets it back to 0
  const est = await arbitrumRun({ spends: false, estimate: (args) => (isReset(args.data) ? 180_000n : args.data.startsWith(APPROVE_SELECTOR) ? 300_000n : 4_000_000n), receipts: ["success", { status: "success", logs: [] }, "success"] });
  assert.equal(est.error, undefined, est.error?.stack);
  assert.equal(est.state.sent.length, 3);
  assert.ok(isReset(est.state.sent[2].data));
  assert.equal(est.state.sent[2].gas, 180_000n);
  const noEst = await arbitrumRun({ spends: false, estimate: (args) => { if (isReset(args.data)) throw new Error("node unavailable"); return args.data.startsWith(APPROVE_SELECTOR) ? 300_000n : 4_000_000n; }, receipts: ["success", { status: "success", logs: [] }, "success"] });
  assert.equal(noEst.error, undefined, noEst.error?.stack);
  assert.equal(noEst.state.sent.length, 3, "the reset was still sent");
  assert.equal(noEst.state.sent[2].gas, 500_000n);
});

test("on BNB Chain, Polygon and Base the node is never asked to estimate: the limits are the simulation's, as before", async () => {
  for (const key of ["bnb", "polygon"]) {
    const { plan } = await verifyCase(key, "stable-to-native");
    const got = 5n * 10n ** 15n;
    const { c, state } = fakeChain({ address: SENDER, chainKey: key, estimate: () => { throw new Error("must not be asked"); }, receipts: ["success", { status: "success", spends: plan.amount_in, logs: [] }], balance: 10n ** 18n, balanceAfter: 10n ** 18n + got + 100_000n * 1_000_000n });
    await evm.executeBaseSwap(plan, { c, usdNotional: plan.usd });
    assert.equal(state.estimated.length, 0, key);
    assert.equal(state.sent[0].gas, undefined, "the approval takes the node's own estimate through viem, as in v0.4.0");
    assert.equal(state.sent[1].gas, evm.swapGasLimit(plan), "after our approval the swap takes the simulation-based limit and the next nonce");
  }
});

// ------------------------------------------------------------------ the client must be for the chain

test("a swap is not signed with a client for another chain (nothing reaches the ledger or the signer)", async () => {
  const before = entries().length;
  const { plan } = await verifyCase("bnb", "stable-to-native");
  for (const chainKey of [undefined, "arbitrum", "polygon", "base"]) {
    const { c, state } = fakeChain({ address: SENDER, ...(chainKey ? { chainKey } : {}) });
    await assert.rejects(evm.executeBaseSwap(plan, { c, usdNotional: plan.usd }), /refusing to swap for bnb with a client for (base|arbitrum|polygon): nothing was signed/, String(chainKey));
    assert.equal(state.sent.length, 0);
  }
  assert.equal(entries().length, before, "no ledger row was written");
});

test("signAndSend: the client's chain must be the transaction's chain", async () => {
  const to = "0x000000000000000000000000000000000000dEaD";
  const none = fakeChain({ address: SENDER });
  await assert.rejects(baseMod.signAndSend(none.c, { to, data: "0x" }, undefined, { chain: "bnb" }), /refusing to sign for bnb with a client for base/);
  const arb = fakeChain({ address: SENDER, chainKey: "arbitrum" });
  await assert.rejects(baseMod.signAndSend(arb.c, { to, data: "0x" }, undefined, { chain: "polygon" }), /refusing to sign for polygon with a client for arbitrum/);
  assert.equal(none.state.sent.length + arb.state.sent.length, 0);
  // the same chain, named or not, is signed
  const ok = fakeChain({ address: SENDER, chainKey: "polygon" });
  assert.equal((await baseMod.signAndSend(ok.c, { to, data: "0x" }, undefined, { chain: "polygon" })).status, "success");
  const ok2 = fakeChain({ address: SENDER, chainKey: "bnb" });
  assert.equal((await baseMod.signAndSend(ok2.c, { to, data: "0x" })).status, "success", "no chain given: the client's own");
});

// ------------------------------------------------------------------ a send that touched more than one endpoint

test("signAndSend: 'nonce too low' / 'already known' after more than one endpoint is Pending (exit 4), never Rejected; after one it keeps its meaning", async () => {
  const to = "0x000000000000000000000000000000000000dEaD";
  const attempt = async (message, hosts, nested = false) => {
    const { c } = fakeChain({ address: SENDER, chainKey: "bnb" });
    c.pub.sendRawTransaction = async () => {
      const inner = Object.assign(new Error(message), { shortMessage: message, details: message, ...(hosts === undefined ? {} : { satoHostsTried: hosts }) });
      throw nested ? Object.assign(new Error("viem wrapped it"), { cause: inner }) : inner;
    };
    return baseMod.signAndSend(c, { to, data: "0x" }, undefined, { chain: "bnb" }).then(() => null, (e) => e);
  };
  for (const message of ["nonce too low: next nonce 7, tx nonce 6", "already known", "replacement transaction underpriced", "insufficient funds for gas * price + value"]) {
    const two = await attempt(message, 2);
    assert.ok(two instanceof Pending, `${message} after two endpoints: ${two?.constructor?.name}`);
    assert.ok((await attempt(message, 3, true)) instanceof Pending, `${message}: found through the cause chain`);
  }
  // one endpoint (or none counted): a refusal is a refusal, and "already known" is still not one
  assert.ok((await attempt("nonce too low: next nonce 7, tx nonce 6", 1)) instanceof Rejected);
  assert.ok((await attempt("nonce too low", undefined)) instanceof Rejected);
  assert.ok((await attempt("insufficient funds for gas * price + value", 1)) instanceof Rejected);
  assert.ok((await attempt("already known", 1)) instanceof Pending);
});
