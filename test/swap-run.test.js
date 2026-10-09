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
const { PlanStale, WSOL_MINT } = await import("../src/swap/solana.js");
const { USDC_MINT } = await import("../src/solana.js");
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
  setPolicy({ swaps: "off" });
  let priced = false;
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: "USDC", to: "ETH", amount: "10" }, { oraclePrice: async () => ((priced = true), eth(2500)()) })), ["swaps_not_enabled"]);
  assert.equal(priced, false, "no price is read for a swap the owner hasn't allowed");
  setPolicy({ swaps: "on" });
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
});

// Sato's signed answer for "sell 11 USDC for SOL" (the fields the kit binds).
const satoSol = (extra = {}) => ({ mode: "recommend", chain: "Solana", token_in: USDC_MINT, token_out: WSOL_MINT, amount_in: "11000000", venue: "jupiter-aggregator", sato_fee_bps: 15, disclosure: "fee", route_id: "rt_s", ...extra });

test("Solana: Sato's signed fee disclosure is required; an unverifiable one stops the swap", async () => {
  const satoBody = satoSol({ meta: { signature: { kid: "x" } } });
  const deps = {
    oraclePrice: solPrice(110),
    callTool: async () => ({ structured: satoBody, isError: false }),
    verifySignature: async () => { throw new Error("bad_signature"); },
  };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, deps)), ["signature_unverified"]);
  // Sato Hub is asked for Jupiter by name...
  let asked;
  await prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, { ...deps, callTool: async (_n, args) => ((asked = args), { structured: satoBody, isError: false }) }).catch(() => {});
  assert.equal(asked.venue, "jupiter-aggregator");
  // ...and an answer naming another venue (an older Sato Hub ignores the pin) is still refused.
  const wrongVenue = { ...deps, verifySignature: async () => ({ ok: true }), callTool: async () => ({ structured: { ...satoBody, venue: "raydium" } }) };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, wrongVenue)), ["venue_unexpected"]);
  // a genuine signature on an answer about a different swap is not a disclosure for this one
  for (const other of [{ amount_in: "1000000" }, { token_out: USDC_MINT }, { token_in: WSOL_MINT }, { chain: "Base" }]) {
    const d = { ...deps, verifySignature: async () => ({ ok: true }), callTool: async () => ({ structured: satoSol(other) }) };
    assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, d)), ["response_mismatch"], JSON.stringify(other));
  }
  // and it must be fresh: two minutes, like Base
  let window;
  const fresh = { ...deps, verifySignature: async (_b, opts) => ((window = opts?.maxAgeMs), { ok: true }), callTool: async () => ({ structured: satoSol() }), planSolanaSwap: async () => { throw new Error("stop here"); } };
  await assert.rejects(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, fresh), /stop here/);
  assert.equal(window, 120_000);
});

test("Solana: off-market quote refused; a stale plan is rebuilt and re-checked before signing", async () => {
  const satoBody = satoSol();
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
  assert.equal(r.rebuilt.minimum, "0.098505", "the rebuilt minimum is reported to the owner");
});

test("Solana: a rebuilt plan that is off-market, or has no fresh price, is never signed", async () => {
  const plan = (outLamports) => ({ agent: "A", from: "USDC", to: "SOL", amount_in: "11000000", quote: { out_amount: String(outLamports), min_out: String(Math.floor(outLamports * 0.99)) }, disclosure: ["line"] });
  const setup = ({ rebuiltOut, prices }) => {
    let built = 0;
    let signed = 0;
    let priced = 0;
    return {
      counts: () => ({ built, signed, priced }),
      deps: {
        oraclePrice: async () => {
          const p = prices[Math.min(priced++, prices.length - 1)];
          if (p instanceof Error) throw p;
          return solPrice(p)();
        },
        callTool: async () => ({ structured: satoSol() }),
        verifySignature: async () => ({ ok: true }),
        verifySolanaSwapPlan: async () => ({ simulated: { ok: true } }),
        planSolanaSwap: async () => (built++ === 0 ? plan(99_500_000) : plan(rebuiltOut)),
        executeSolanaSwap: async () => {
          if (built === 1) throw new PlanStale("old");
          signed++;
          return { tx: "sig" };
        },
        solDeps: {},
      },
    };
  };
  // the rebuilt quote is far off the market: refused, nothing signed
  const a = setup({ rebuiltOut: 50_000_000, prices: [110] });
  const pa = await prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, a.deps);
  assert.deepEqual(await rules(pa.execute()), ["quote_off_market"]);
  assert.equal(a.counts().signed, 0);
  // the price moved while the owner looked: the rebuilt plan is held to the NEW price
  const b = setup({ rebuiltOut: 99_500_000, prices: [110, 220] });
  const pb = await prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, b.deps);
  assert.deepEqual(await rules(pb.execute()), ["quote_off_market"]);
  assert.equal(b.counts().priced, 2, "the oracle is read again for the rebuilt plan");
  assert.equal(b.counts().signed, 0);
  // no fresh price at rebuild time: refused
  const c = setup({ rebuiltOut: 99_500_000, prices: [110, new PriceUnavailable("stale")] });
  const pc = await prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, c.deps);
  assert.deepEqual(await rules(pc.execute()), ["price_unavailable"]);
  assert.equal(c.counts().signed, 0);
});

test("Solana: the transaction is held to the owner's slippage and Sato's disclosed fee, not the plan's own", async () => {
  const seen = [];
  const plan = { agent: "A", from: "USDC", to: "SOL", amount_in: "11000000", quote: { out_amount: "99500000", min_out: "98505000" }, disclosure: [] };
  const p = await prepareSwap(
    { chain: "solana", from: "USDC", to: "SOL", amount: "11", slippageBps: 80 },
    {
      oraclePrice: solPrice(110),
      callTool: async () => ({ structured: satoSol({ sato_fee_bps: 15 }) }),
      verifySignature: async () => ({ ok: true }),
      planSolanaSwap: async () => plan,
      verifySolanaSwapPlan: async (_p, intent) => (seen.push(["verify", intent]), { simulated: { ok: true }, jupiter: { enforced_min_out: "98505000" } }),
      executeSolanaSwap: async (_p, d) => (seen.push(["execute", d.intent, d.usdNotional]), { tx: "sig" }),
      solDeps: {},
    },
  );
  assert.equal(p.display.buy.minimum_in_transaction, "0.098505");
  await p.execute();
  for (const [step, intent] of seen) assert.deepEqual([step, intent.slippage_bps, intent.fee_bps], [step, 80, 15]);
  assert.equal(seen.find(([s]) => s === "execute")[2], 11, "the oracle-sized USD reaches the signer");
});
