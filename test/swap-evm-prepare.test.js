// prepareSwap and runSwap on BNB Chain, Arbitrum and Polygon, offline: the orchestrator above the chain module (src/swap/run.js),
// driven by the REAL verifier (evm.verifyBaseSwapPlan) over the recorded KyberSwap routes and builds for each chain
// (test/fixtures/swap-evm/<chain>/). The reviewer's finding was that stablecoin <-> stablecoin crashed here (no oracle to check the quote
// against) while every per-chain test stopped at verifyBaseSwapPlan; so each case below goes through sizing, the independent check,
// the owner's limits and the approval, with only Sato Hub, the node and the signer injected.

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";
import { SENDER, load, passes, satoResponseFrom } from "./swap-evm-helpers.js";

freshHome();
const evm = await import("../src/swap/evm.js");
const { evmChain, majorTokens } = await import("../src/chains.js");
const { Refused, NeedsApproval } = await import("../src/errors.js");
const { setPolicy } = await import("../src/policy.js");
const { prepareSwap, runSwap, sizeSwap, swapIntent, swapLines, STABLE_PEG_TOLERANCE_PCT } = await import("../src/swap/run.js");
const { approvalFeeCeiling } = await import("../src/swap/fee-tier.js");

const owner = () => setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", swaps: "on", perTx: "500", perDay: "100000", swapSlippageBps: "500", maxTradesPerDay: "none", approval: "auto" });
owner();

const clone = (o) => JSON.parse(JSON.stringify(o));
const TAILS = {
  bnb: { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "CAKE", name: "PancakeSwap Token", decimals: 18, native: false, major: false },
  arbitrum: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", name: "Arbitrum", decimals: 18, native: false, major: false },
  polygon: { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", symbol: "AAVE", name: "Aave Token", decimals: 18, native: false, major: false },
};
const NATIVE_AMOUNT = { bnb: "0.02", arbitrum: "0.005", polygon: "20" };

function casesOf(key) {
  const c = evmChain(key);
  const stable = c.defaultStable;
  const other = Object.keys(c.stables).find((s) => s !== stable);
  const tail = TAILS[key].address;
  return {
    "native-to-stable": { from: c.native.symbol, to: stable, amount: NATIVE_AMOUNT[key], bps: 15, tier: "major", side: "in" },
    "stable-to-native": { from: stable, to: c.native.symbol, amount: "10", bps: 15, tier: "major", side: "in" },
    "stable-to-stable": { from: stable, to: other, amount: "10", bps: 3, tier: "stable", side: "in" },
    "stable-to-tail": { from: stable, to: tail, amount: "10", bps: 75, tier: "token", side: "in", sellBack: true },
    "tail-to-stable": { from: tail, to: stable, amount: "10", bps: 75, tier: "token", side: "out" },
  };
}

/** The native coin's USD price implied by a recorded route, so the independent price agrees with the quote unless a test moves it. */
function priceFromRoute(key, name) {
  const c = evmChain(key);
  const r = load(`${key}/${name}-route`).data.routeSummary;
  const stableDec = (sym) => c.stables[sym].decimals;
  const inStable = name.startsWith("stable");
  const stableUnits = inStable ? r.amountIn : r.amountOut;
  const nativeUnits = inStable ? r.amountOut : r.amountIn;
  const sym = inStable ? casesOf(key)[name].from : casesOf(key)[name].to;
  return Number(BigInt(stableUnits)) / 10 ** stableDec(sym) / (Number(BigInt(nativeUnits)) / 10 ** 18);
}

/** Everything prepareSwap / runSwap need, with the real verifier fed the recorded answers. */
function rig(key, name, { editResponse, editPlan, oracleScale = 1 } = {}) {
  const meta = casesOf(key)[name];
  const c = evmChain(key);
  const executed = [];
  const asked = [];
  const nativeUsd = ["native-to-stable", "stable-to-native"].includes(name) ? priceFromRoute(key, name) : null;
  const deps = {
    oraclePrice: async (asset, opts) => {
      asked.push([asset, opts]);
      return { asset, usd: (nativeUsd ?? priceFromRoute(key, "native-to-stable")) * oracleScale, updated_at: new Date().toISOString(), age_s: 30, source: `chainlink:${key}:0xfeed` };
    },
    publicQuote: async () => null,
    resolveBaseToken: async (input, d) => (String(input).toLowerCase() === TAILS[key].address.toLowerCase() ? { ...TAILS[key] } : evm.resolveBaseToken(input, d)),
    planAndVerifyBaseSwap: async (args) => {
      const intent = evm.parseIntent({ from: args.from, to: args.to, amount: args.amount, slippageBps: args.slippageBps, chain: key });
      intent.taker = SENDER;
      const response = satoResponseFrom(load(`${key}/${name}-route`), load(`${key}/${name}-build`), { hubName: c.hubName, chainId: c.chainId, feeBps: meta.bps, feeTier: meta.tier, feeSide: meta.side });
      editResponse?.(response);
      const sims = [clone(load(`${key}/${name}-sim`))];
      if (meta.sellBack) sims.push(clone(load(`${key}/${name}-sellback-sim`)));
      let i = 0;
      const plan = await evm.verifyBaseSwapPlan(response, intent, {
        verifySignature: passes,
        simulate: async () => clone(sims[Math.min(i++, sims.length - 1)].result),
        readAllowance: async () => 0n,
        ...(meta.sellBack
          ? {
              buildSellBack: async () => {
                const b = load(`${key}/${name}-sellback-build`).data;
                const r = load(`${key}/${name}-sellback-route`).data.routeSummary;
                return { to: b.routerAddress, data: b.data, value: 0n, quoted_out: r.amountOut, route_id: r.routeID };
              },
            }
          : {}),
      });
      return editPlan ? { ...plan, ...editPlan(plan) } : plan; // a verified plan is frozen: an edit is a copy
    },
    executeBaseSwap: async (plan, d) => (executed.push({ plan, d }), { tx: "0xabc", explorer: `${c.explorer.url}/tx/0xabc` }),
  };
  return { deps, executed, asked, meta, req: { chain: key, from: meta.from, to: meta.to, amount: meta.amount, slippageBps: 50 } };
}

const rules = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${e?.stack}`);
    return e.refusals.map((r) => r.rule);
  }
  assert.fail("expected a refusal");
};

test("Sato Hub's launch pause (P0) is shown as sato_paused with the server's reason on an EVM chain (no signature check, no 'tx_withheld')", async () => {
  owner();
  const paused = { mode: "build-tx", chain: "BNB Chain", venue: "none", tx: null, sato_fee_bps: null, withheld: { rule: "P0", reason: "Sato Hub has paused swaps for the launch." } };
  // (the rig feeds the recorded answer to the real verifier; here the answer is the pause, unsigned: the pause is read before the signature)
  const r = rig("bnb", "stable-to-stable", { editResponse: (res) => { for (const k of Object.keys(res)) delete res[k]; Object.assign(res, paused); } });
  const err = await prepareSwap(r.req, r.deps).then(() => null, (e) => e);
  assert.deepEqual(err.refusals.map((x) => x.rule), ["sato_paused"]);
  assert.equal(err.refusals[0].message, "Sato Hub has paused swaps for the launch. Nothing was built or signed. Try again later; do not swap another way.");
  assert.equal(r.executed.length, 0);
});

for (const key of ["bnb", "arbitrum", "polygon"]) {
  const c = evmChain(key);
  const T = majorTokens(key);
  const pair = (name) => `${casesOf(key)[name].from} -> ${casesOf(key)[name].to}`;

  test(`${key}: prepareSwap ${pair("stable-to-stable")}: no oracle, held to one-for-one, the 3 bps tier, exactly $10`, async () => {
    owner();
    const r = rig(key, "stable-to-stable");
    const p = await prepareSwap(r.req, r.deps);
    assert.equal(r.asked.length, 0, "a stablecoin pair needs no price read");
    assert.equal(p.display.oracle, null);
    assert.ok(p.display.stable_peg.deviation_pct <= STABLE_PEG_TOLERANCE_PCT, JSON.stringify(p.display.stable_peg));
    assert.deepEqual([p.display.sato_fee.tier, p.display.sato_fee.bps], ["stable", 3]);
    assert.equal(p.display.usd_held_to_limits, 10, "decimals-aware: 10 units of this chain's stable are ten dollars");
    assert.equal(p.display.chain, key);
    const lines = swapLines(p.display).join("\n");
    assert.match(lines, /Two stablecoins have no oracle: the quote is held to one for one/);
    await p.execute();
    assert.equal(r.executed.length, 1);
    assert.equal(r.executed[0].d.usdNotional, 10, "the figure the signer books");
  });

  test(`${key}: runSwap ${pair("stable-to-stable")} runs end to end; the intent the owner approves names the pair, the tier and its 3 bps ceiling`, async () => {
    owner();
    const r = rig(key, "stable-to-stable");
    const out = await runSwap(r.req, {}, r.deps);
    assert.deepEqual(out.confirm, []);
    await out.prepared.execute();
    assert.equal(r.executed.length, 1);
    const sized = await sizeSwap(r.req, r.deps);
    const intent = swapIntent(sized);
    assert.deepEqual([intent.chain, intent.fee_tier, intent.fee_max_bps], [key, "stable", 3]);
    assert.equal(intent.fee_max_bps, approvalFeeCeiling("stable"));
    assert.match(intent.price, /stablecoin pair has no oracle/);
    assert.match(intent.price, new RegExp(`within ${STABLE_PEG_TOLERANCE_PCT}%`));
    assert.doesNotMatch(intent.price, /oracle tolerance/);
    // with approval "ask" the owner is asked first, and the code binds this very intent
    setPolicy({ approval: "ask" });
    const asking = await runSwap(r.req, {}, r.deps).then(() => null, (e) => e);
    assert.ok(asking instanceof NeedsApproval, "approval ask: the owner is asked before anything is quoted");
    owner();
  });

  test(`${key}: a stablecoin pair that comes back off one-for-one is refused (stable_pair_off_peg), in either direction, never skipped`, async () => {
    owner();
    // the build is for 10 in / ~10 out; make the verified plan say 12% too little, then 12% too much, were it ever to get this far
    for (const factor of [88n, 112n]) {
      const r = rig(key, "stable-to-stable", { editPlan: (plan) => ({ quoted_out: (plan.quoted_out * factor) / 100n }) });
      const got = await rules(prepareSwap(r.req, r.deps));
      assert.deepEqual(got, ["stable_pair_off_peg"], `factor ${factor}`);
      assert.equal(r.executed.length, 0, "nothing was signed");
    }
    // just inside the tolerance passes
    const ok = rig(key, "stable-to-stable", { editPlan: (plan) => ({ quoted_out: (plan.quoted_out * 995n) / 1000n }) });
    const p = await prepareSwap(ok.req, ok.deps);
    assert.ok(p.display.stable_peg.deviation_pct > 0 && p.display.stable_peg.deviation_pct <= STABLE_PEG_TOLERANCE_PCT);
    // an unreadable amount is a refusal too
    const zero = rig(key, "stable-to-stable", { editPlan: () => ({ quoted_out: 0n }) });
    assert.deepEqual(await rules(prepareSwap(zero.req, zero.deps)), ["stable_pair_off_peg"]);
  });

  test(`${key}: prepareSwap ${pair("native-to-stable")}: the native coin is priced by the chain's own feed and the quote is held to it`, async () => {
    owner();
    const r = rig(key, "native-to-stable");
    const p = await prepareSwap(r.req, r.deps);
    assert.deepEqual(r.asked[0], [c.native.symbol, { chain: key }]);
    assert.equal(p.display.oracle.asset, c.native.symbol);
    assert.ok(Math.abs(p.display.oracle.deviation_pct) < 1, `${p.display.oracle.deviation_pct}% from the independent price`);
    assert.equal(p.display.stable_peg, undefined);
    assert.deepEqual([p.display.sato_fee.tier, p.display.sato_fee.bps], ["major", 15]);
    assert.equal(p.display.usd_basis, "oracle");
    await p.execute();
    assert.equal(r.executed.length, 1);
    // an independent price 20% away from the quote is a refusal (quote_off_market), nothing signed
    const off = rig(key, "native-to-stable", { oracleScale: 1.2 });
    assert.deepEqual(await rules(prepareSwap(off.req, off.deps)), ["quote_off_market"]);
    assert.equal(off.executed.length, 0);
  });

  test(`${key}: prepareSwap ${pair("stable-to-native")}: sized as the stable amount, the quote held to the native coin's feed`, async () => {
    owner();
    const r = rig(key, "stable-to-native");
    const p = await prepareSwap(r.req, r.deps);
    assert.equal(p.display.usd_held_to_limits, 10);
    assert.equal(p.display.usd_basis, "usdc_amount");
    assert.ok(Math.abs(p.display.oracle.deviation_pct) < 1);
    assert.equal(p.display.approval.exact, true);
    assert.equal(p.display.approval.address, T[c.defaultStable].address);
    const off = rig(key, "stable-to-native", { oracleScale: 0.8 });
    assert.deepEqual(await rules(prepareSwap(off.req, off.deps)), ["quote_off_market"]);
  });

  test(`${key}: prepareSwap ${c.defaultStable} -> a long-tail token: no independent price for the token, sized from the stable, the sell-back checked`, async () => {
    owner();
    const r = rig(key, "stable-to-tail");
    const p = await prepareSwap(r.req, r.deps);
    assert.equal(p.display.oracle, null);
    assert.deepEqual([p.display.usd_held_to_limits, p.display.usd_basis], [10, "usdc_amount"]);
    assert.equal(p.display.long_tail.role, "buying");
    assert.equal(p.display.long_tail.address, TAILS[key].address);
    assert.deepEqual([p.display.sato_fee.tier, p.display.sato_fee.bps, p.display.sato_fee.side], ["token", 75, "in"]);
    assert.equal(p.display.sell_back.checked, true);
    const lines = swapLines(p.display).join("\n");
    assert.match(lines, /no independent price for the token/);
    await p.execute();
    assert.equal(r.executed.length, 1);
    const out = await runSwap(r.req, { dryRun: true }, r.deps);
    assert.equal(out.prepared.display.usd_held_to_limits, 10);
  });

  test(`${key}: prepareSwap a long-tail token -> ${c.defaultStable}: sized from the stable the quote returns, held to the owner's limits after the quote`, async () => {
    owner();
    setPolicy({ perTx: "5000" }); // the recorded sale is worth a good deal more than $500 on some chains
    const r = rig(key, "tail-to-stable");
    const p = await prepareSwap(r.req, r.deps);
    assert.equal(p.display.oracle, null);
    assert.equal(p.display.usd_basis, "usdc_received");
    const valued = Number(load(`${key}/tail-to-stable-route`).data.routeSummary.amountOutUsd);
    assert.ok(Math.abs(p.display.usd_held_to_limits - valued) / valued < 0.05, `${p.display.usd_held_to_limits} against ${valued}`);
    assert.equal(p.display.long_tail.role, "selling");
    assert.deepEqual([p.display.sato_fee.tier, p.display.sato_fee.side], ["token", "out"]);
    // a per-transaction limit below that figure stops it after the quote, before anything is signed
    setPolicy({ perTx: String(Math.max(0.01, Math.floor(valued) / 2)) });
    const low = rig(key, "tail-to-stable");
    assert.deepEqual(await rules(prepareSwap(low.req, low.deps)), ["max_usd_per_tx"]);
    assert.equal(low.executed.length, 0);
    owner();
  });
}

test("a pair with neither an oracle nor two stablecoins is refused (oracle_missing), never waved through", async () => {
  // the guard behind the stable-pair branch: a sized swap whose volatile side has no price is not a stablecoin pair
  owner();
  const r = rig("bnb", "native-to-stable");
  r.deps.oraclePrice = async () => ({ asset: "BNB", usd: 750, updated_at: new Date().toISOString(), age_s: 1, source: "x" });
  const sized = await sizeSwap(r.req, r.deps);
  sized.oracle = null; // as if the price had not been read
  assert.deepEqual(await rules(prepareSwap(r.req, { ...r.deps, sized })), ["oracle_missing"]);
});
