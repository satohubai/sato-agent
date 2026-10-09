// The swap orchestrator (src/swap/run.js), offline: the order of checks, the
// independent price, and how each failure stops a swap before anything is
// signed. The chain modules are injected (they have their own suites).

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { PriceUnavailable } = await import("../src/price.js");
const { PlanStale } = await import("../src/swap/solana.js");
const { prepareSwap, sizeSwap } = await import("../src/swap/run.js");

initWallet();
setPolicy({ chains: "base,solana", perTx: "100", perDay: "300", swapSlippageBps: "100", maxTradesPerDay: "5" });

const eth = (usd) => async () => ({ asset: "ETH", usd, updated_at: "2026-10-09T00:00:00Z", age_s: 20, source: "chainlink:base:0x7104" });
const solPrice = (usd) => async () => ({ asset: "SOL", usd, updated_at: "2026-10-09T00:00:00Z", age_s: 600, source: "chainlink:base:0x9750" });
const rules = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refused) return e.refusals.map((r) => r.rule);
    throw e;
  }
  return [];
};

// A verified Base plan, as evm.planAndVerifyBaseSwap returns it (only the fields summarize/execute read).
const basePlan = ({ sellAmount, quoted, usd }) => ({
  verified: true,
  venue: "kyberswap",
  route_id: "rt_test",
  receipt_url: null,
  from: "USDC",
  to: "ETH",
  token_in: { symbol: "USDC", decimals: 6, native: false },
  token_out: { symbol: "ETH", decimals: 18, native: true },
  amount_in: BigInt(Math.round(sellAmount * 1e6)),
  quoted_out: BigInt(Math.round(quoted * 1e18)),
  min_out: BigInt(Math.round(quoted * 0.99 * 1e18)),
  slippage_bps: 100,
  usd,
  router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  approval: { needed: true, spender: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", amount: BigInt(Math.round(sellAmount * 1e6)) },
  fee: { bps: 15, recipient: "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9", disclosure: "fee sentence" },
  simulation: { source: "eth_simulateV1", in_delta: -BigInt(Math.round(sellAmount * 1e6)), out_delta: BigInt(Math.round(quoted * 1e18)) },
});

test("swaps off: refused before any price or quote is fetched", async () => {
  setPolicy({ swapSlippageBps: "off" });
  let priced = false;
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: "USDC", to: "ETH", amount: "10" }, { oraclePrice: async () => ((priced = true), eth(2500)()) })), ["swaps_not_enabled"]);
  assert.equal(priced, false, "no price is read for a swap the owner hasn't allowed");
  setPolicy({ swapSlippageBps: "100", maxTradesPerDay: "5" });
});

test("no independent price, no swap", async () => {
  const r = await rules(sizeSwap({ chain: "base", from: "ETH", to: "USDC", amount: "0.01" }, { oraclePrice: async () => { throw new PriceUnavailable("stale"); } }));
  assert.deepEqual(r, ["price_unavailable"]);
});

test("selling ETH or SOL is sized from the oracle, never from the quote; slippage over the owner's cap is refused", async () => {
  const s = await sizeSwap({ chain: "base", from: "ETH", to: "USDC", amount: "0.02" }, { oraclePrice: eth(2500) });
  assert.equal(s.usd, 50);
  const t = await sizeSwap({ chain: "solana", from: "SOL", to: "USDC", amount: "0.5" }, { oraclePrice: solPrice(110) });
  assert.equal(t.usd, 55);
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: "ETH", to: "USDC", amount: "0.1" }, { oraclePrice: eth(2500) })), ["max_usd_per_tx"], "$250 is over the $100 per-transaction limit");
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: "USDC", to: "ETH", amount: "10", slippageBps: 300 }, { oraclePrice: eth(2500) })), ["max_slippage_bps"]);
  await assert.rejects(sizeSwap({ chain: "base", from: "ETH", to: "WETH", amount: "1" }, { oraclePrice: eth(2500) }), /USDC/);
  await assert.rejects(sizeSwap({ chain: "solana", from: "USDC", to: "ETH", amount: "1" }, { oraclePrice: eth(2500) }), /swaps USDC, SOL/);
});

test("Base: a quote near the oracle passes; a quote far from it is refused before signing", async () => {
  let executed = false;
  const near = await prepareSwap(
    { chain: "base", from: "USDC", to: "ETH", amount: "50" },
    { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan({ sellAmount: 50, quoted: 0.0199, usd: 50 }) },
  );
  assert.ok(Math.abs(near.display.oracle.deviation_pct - 0.502513) < 0.01);
  assert.equal(near.display.approval.exact, true);
  const far = prepareSwap(
    { chain: "base", from: "USDC", to: "ETH", amount: "50" },
    { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan({ sellAmount: 50, quoted: 0.015, usd: 50 }), baseDeps: {} },
  );
  assert.deepEqual(await rules(far), ["quote_off_market"]);
  assert.equal(executed, false);
});

test("Solana: Sato's signed fee disclosure is required; an unverifiable one stops the swap", async () => {
  const satoBody = { venue: "jupiter-aggregator", sato_fee_bps: 15, disclosure: "fee", route_id: "rt_s", meta: { signature: { kid: "x" } } };
  const deps = {
    oraclePrice: solPrice(110),
    callTool: async () => ({ structured: satoBody, isError: false }),
    verifySignature: async () => { throw new Error("bad_signature"); },
  };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, deps)), ["signature_unverified"]);
  const wrongVenue = { ...deps, verifySignature: async () => ({ ok: true }), callTool: async () => ({ structured: { ...satoBody, venue: "raydium" } }) };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, wrongVenue)), ["venue_unexpected"]);
});

test("Solana: off-market quote refused; a stale plan is rebuilt and re-checked before signing", async () => {
  const satoBody = { venue: "jupiter-aggregator", sato_fee_bps: 15, disclosure: "fee", route_id: "rt_s" };
  let built = 0;
  const plan = (outLamports) => ({ agent: "A", from: "USDC", to: "SOL", amount_in: "11000000", quote: { out_amount: String(outLamports), min_out: String(Math.floor(outLamports * 0.99)) }, disclosure: ["line"] });
  const base = {
    oraclePrice: solPrice(110),
    callTool: async () => ({ structured: satoBody }),
    verifySignature: async () => ({ ok: true }),
    verifySolanaSwapPlan: async () => ({ simulated: { ok: true } }),
  };
  const off = await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, { ...base, planSolanaSwap: async () => plan(50_000_000) }));
  assert.deepEqual(off, ["quote_off_market"], "11 USDC for 0.05 SOL is $220/SOL vs $110");
  const p = await prepareSwap(
    { chain: "solana", from: "USDC", to: "SOL", amount: "11" },
    {
      ...base,
      planSolanaSwap: async () => (built++, plan(99_500_000)),
      executeSolanaSwap: async () => {
        if (built === 1) throw new PlanStale("old");
        return { tx: "sig", explorer: "https://solscan.io/tx/sig" };
      },
      solDeps: {},
    },
  );
  // The first execute is stale: the kit rebuilds (built 2), re-verifies, re-checks the oracle, then executes.
  const r = await p.execute();
  assert.equal(built, 2, "a stale plan was rebuilt, never re-signed");
  assert.equal(r.tx, "sig");
});
