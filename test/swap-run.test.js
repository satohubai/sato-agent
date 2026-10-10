// The swap orchestrator (src/swap/run.js), offline: the order of checks, the
// independent price, and how each failure stops a swap before anything is
// signed. The chain modules are injected (they have their own suites).

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused, NeedsApproval } = await import("../src/errors.js");
const { PriceUnavailable } = await import("../src/price.js");
const { PlanStale, WSOL_MINT } = await import("../src/swap/solana.js");
const { USDC_MINT, TOKEN_2022_PROGRAM } = await import("../src/solana.js");
const { prepareSwap, sizeSwap, runSwap, chooseSlippage, swapLines, swapIntent, compareHubWithChain, CONFIRM } = await import("../src/swap/run.js");
const evm = await import("../src/swap/evm.js");
const sol = await import("../src/swap/solana.js");
const { TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");

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

// ================================================================= any token (v0.3)
//
// The chain modules are injected, as above. Tokens are real-shaped: a Base ERC-20 and a Solana mint.

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const PEPE = "0x52b492a33E447Cdb854c7FC19F1e57E8BfA1777D";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const degenToken = { address: DEGEN, symbol: "DEGEN", name: "Degen", decimals: 18, native: false, major: false };
const pepeToken = { address: PEPE, symbol: "PEPE", name: "Pepe", decimals: 18, native: false, major: false };

/** The owner's choices for one test: no caps by default (owner decision D5), `cap` for a slippage cap, `ask` for approval mode. */
function owner({ cap = "none", ask = false } = {}) {
  setPolicy({ swaps: "on", swapSlippageBps: cap, maxTradesPerDay: "none", approval: ask ? "ask" : "auto" });
}
const needs = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NeedsApproval) return e;
    throw e;
  }
  return null;
};

// ---- Base rig
const baseResolver = async (input) => {
  const s = String(input).trim();
  if (Object.hasOwn(evm.TOKENS, s.toUpperCase())) return { ...evm.TOKENS[s.toUpperCase()] };
  if (s.toLowerCase() === DEGEN.toLowerCase()) return { ...degenToken };
  if (s.toLowerCase() === PEPE.toLowerCase()) return { ...pepeToken };
  throw new Error(`"${s}" is not USDC, ETH, WETH or a token's 0x contract address on Base`);
};
/** A verified Base plan for a token trade, as evm.planAndVerifyBaseSwap returns it (the fields summarize / execute read). */
const calmMarket = { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 19.9, value_gap_pct: 0.5, source: "Sato Hub's answer (the KyberSwap route summary)" };
function baseTokenPlan({ side, major = "USDC", majorUnits, tokenUnits, usd, market = calmMarket, sellBack = null, slip = 150 }) {
  const buy = side === "buy";
  const m = evm.TOKENS[major];
  const tin = buy ? m : degenToken;
  const tout = buy ? degenToken : m;
  const amountIn = buy ? majorUnits : tokenUnits;
  const quoted = buy ? tokenUnits : majorUnits;
  return {
    verified: true, venue: "kyberswap", route_id: "rt_t", receipt_url: null,
    from: tin.major ? tin.symbol : `${tin.symbol} 0x4ed4…efed`, to: tout.major ? tout.symbol : `${tout.symbol} 0x4ed4…efed`, token_in: tin, token_out: tout,
    amount_in: amountIn, quoted_out: quoted, min_out: (quoted * BigInt(10_000 - slip)) / 10_000n, slippage_bps: slip, usd,
    router: evm.KYBER_ROUTER_BASE, approval: { needed: false },
    fee: { bps: 15, recipient: evm.SATO_FEE_RECIPIENT, disclosure: "fee sentence", side: buy ? "in" : "out" },
    long_tail: buy ? "out" : "in", major_leg: { asset: major, units: majorUnits }, market, sell_back: sellBack,
    simulation: { source: "eth_simulateV1", in_delta: -amountIn, out_delta: quoted },
  };
}
function baseRig(planOrFn, extra = {}) {
  const calls = [];
  const executed = [];
  return {
    calls,
    executed,
    deps: {
      oraclePrice: eth(2500),
      publicQuote: async () => null, // no venue is asked in a unit test (the pre-size has its own test)
      resolveBaseToken: baseResolver,
      planAndVerifyBaseSwap: async (args, d) => (calls.push({ args, d }), typeof planOrFn === "function" ? planOrFn() : planOrFn),
      executeBaseSwap: async (_p, d) => (executed.push(d), { tx: "0xabc", explorer: "https://basescan.org/tx/0xabc" }),
      ...extra,
    },
  };
}
const DEGEN_BUY = { chain: "base", from: "USDC", to: DEGEN, amount: "20" };
const DEGEN_SELL = { chain: "base", from: DEGEN, to: "USDC", amount: "5000" };
const buyPlan = (o = {}) => baseTokenPlan({ side: "buy", majorUnits: 20_000_000n, tokenUnits: 5000n * 10n ** 18n, usd: 20, ...o });
const sellPlan = (o = {}) => baseTokenPlan({ side: "sell", majorUnits: 19_900_000n, tokenUnits: 5000n * 10n ** 18n, usd: 19.9, ...o });

// ---- Solana rig
function mintEntry({ program = TOKEN_PROGRAM_ADDRESS, decimals = 5, extensions = [], freeze = false } = {}) {
  const head = Buffer.alloc(82);
  head[44] = decimals;
  head[45] = 1;
  if (freeze) {
    head.writeUInt32LE(1, 46); // a freeze authority is set
    Buffer.alloc(32, 9).copy(head, 50);
  }
  let raw = head;
  if (program === TOKEN_2022_PROGRAM && extensions.length) {
    const tlv = extensions.map(([type, data]) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(type, 0);
      h.writeUInt16LE(data.length, 2);
      return Buffer.concat([h, data]);
    });
    raw = Buffer.concat([head, Buffer.alloc(83), Buffer.from([1]), ...tlv]); // 165 bytes, the account type (1 = mint), then the extensions
  }
  return { owner: program, data: [raw.toString("base64"), "base64"], lamports: 1, executable: false };
}
const EXT = {
  ConfidentialTransferMint: [4, Buffer.alloc(65, 1)],
  ConfidentialTransferFeeConfig: [16, Buffer.alloc(129, 1)],
  ConfidentialMintBurn: [24, Buffer.alloc(196, 1)],
  pausable: [26, Buffer.concat([Buffer.alloc(32, 3), Buffer.from([0])])],
  PermanentDelegate: [12, Buffer.alloc(32, 7)],
  TransferHook: [14, Buffer.alloc(64, 7)],
  NonTransferable: [9, Buffer.alloc(0)],
  transferFee: (bps) => {
    const d = Buffer.alloc(108);
    d.writeUInt16LE(bps, 88);
    d.writeUInt16LE(bps, 106);
    return [1, d];
  },
};
const rpcFor = (map) => ({ getAccountInfo: (addr) => ({ send: async () => ({ value: map[String(addr)] ?? null }) }) });
const satoFor = (tin, tout, amountIn, extra = {}) => ({ mode: "recommend", chain: "Solana", token_in: tin, token_out: tout, amount_in: String(amountIn), venue: "jupiter-aggregator", sato_fee_bps: 15, disclosure: "fee", route_id: "rt_s", ...extra });
function solTokenPlan({ from, to, amountIn, out, impactBps = null, feeLeg = "input", feeMax = 0, inDec, outDec, minOut }) {
  return {
    agent: "A", chain: "solana", venue: "jupiter", from, to, amount_in: String(amountIn),
    quote: { out_amount: String(out), min_out: String(minOut ?? Math.floor(out * 0.985)), price_impact_bps: impactBps, route_hops: 2 },
    fee: { bps: 15, leg: feeLeg, max_units: String(feeMax), symbol: feeLeg === "input" ? "USDC" : "SOL" },
    tokens: { in: { decimals: inDec }, out: { decimals: outDec } },
    disclosure: ["Swap line"],
  };
}
function solRig(planFn, { mints = { [BONK]: mintEntry() }, sato = {}, price = 110, extra = {} } = {}) {
  const asked = [];
  const planned = [];
  const executed = [];
  return {
    asked,
    planned,
    executed,
    deps: {
      oraclePrice: solPrice(price),
      publicQuote: async () => null,
      solDeps: { rpc: rpcFor(mints) },
      callTool: async (_n, args) => (asked.push(args), { structured: satoFor(args.token_in, args.token_out, args.amount_in, sato) }),
      verifySignature: async () => ({ ok: true }),
      verifySolanaSwapPlan: async () => ({ simulated: { ok: true } }),
      planSolanaSwap: async (a, d) => (planned.push({ a, d }), planFn(a)),
      executeSolanaSwap: async (_p, d) => (executed.push(d), { tx: "sig", amount_out: "123456" }),
      ...extra,
    },
  };
}
const BONK_BUY = { chain: "solana", from: "USDC", to: BONK, amount: "20" };
const BONK_SELL = { chain: "solana", from: BONK, to: "USDC", amount: "1000000" };
const bonkBuyPlan = (o = {}) => (a) => solTokenPlan({ from: a.from, to: a.to, amountIn: 20_000_000, out: 100_000_000_000, inDec: 6, outDec: 5, ...o });
const bonkSellPlan = (o = {}) => (a) => solTokenPlan({ from: a.from, to: a.to, amountIn: 100_000_000_000, out: 19_700_000, feeLeg: "output", feeMax: 30_000, inDec: 5, outDec: 6, ...o });

test("sizing from the major leg: USDC sold is the amount, ETH sold is the amount at the Chainlink price, a token sold has no figure before the quote", async () => {
  owner();
  let oracleReads = 0;
  const counted = (usd) => async (asset) => (oracleReads++, (asset === "SOL" ? solPrice(usd) : eth(usd))());
  const b1 = await sizeSwap(DEGEN_BUY, baseRig(buyPlan()).deps);
  assert.deepEqual([b1.usd, b1.usdBasis, b1.longTail, b1.oracle], [20, "usdc_amount", "out", null]);
  const b2 = await sizeSwap({ chain: "base", from: "ETH", to: DEGEN, amount: "0.01" }, baseRig(buyPlan(), { oraclePrice: counted(2500) }).deps);
  assert.deepEqual([b2.usd, b2.usdBasis, oracleReads], [25, "oracle", 1]);
  // a token sold: nothing to value yet, and no Chainlink read for a USDC pair at all
  oracleReads = 0;
  const b3 = await sizeSwap(DEGEN_SELL, baseRig(sellPlan(), { oraclePrice: counted(2500) }).deps);
  assert.deepEqual([b3.usd, b3.usdBasis, b3.longTail, oracleReads], [null, "after_quote", "in", 0]);
  // ...but a token sold for ETH reads the ETH price up front (no price, no swap)
  const b4 = await sizeSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, baseRig(sellPlan(), { oraclePrice: counted(2500) }).deps);
  assert.deepEqual([b4.usd, oracleReads], [null, 1]);
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, baseRig(sellPlan(), { oraclePrice: async () => { throw new PriceUnavailable("stale"); } }).deps)), ["price_unavailable"]);
  // Solana
  const s1 = await sizeSwap(BONK_BUY, solRig(bonkBuyPlan()).deps);
  assert.deepEqual([s1.usd, s1.usdBasis, s1.tail.id], [20, "usdc_amount", BONK]);
  const s2 = await sizeSwap({ chain: "solana", from: "SOL", to: BONK, amount: "0.5" }, solRig(bonkBuyPlan()).deps);
  assert.deepEqual([s2.usd, s2.usdBasis], [55, "oracle"]);
  const s3 = await sizeSwap(BONK_SELL, solRig(bonkSellPlan()).deps);
  assert.deepEqual([s3.usd, s3.usdBasis], [null, "after_quote"]);
});

test("Base: a token sold for USDC is sized from the USDC the quote returns, and the owner's limits are checked again after the quote", async () => {
  owner();
  const rig = baseRig(sellPlan());
  const p = await prepareSwap(DEGEN_SELL, rig.deps);
  assert.equal(p.display.usd_held_to_limits, 19.9);
  assert.equal(p.display.usd_basis, "usdc_received");
  assert.equal(p.display.oracle, null, "a token has no independent price");
  assert.equal(rig.calls[0].d.usdFromQuote, true, "Sato Hub is told no figure is known yet");
  assert.equal(rig.calls[0].d.usdNotional, undefined, "and is sent none");
  assert.equal(rig.calls[0].args.from.address, DEGEN, "the token as the chain read it");
  await p.execute();
  assert.equal(rig.executed[0].usdNotional, 19.9, "the quote-sized figure reaches the signer");
  // a quote that pays out more than the per-transaction limit ($100): refused after the quote, before anything is signed
  const big = baseRig(sellPlan({ majorUnits: 150_000_000n, usd: 150 }));
  assert.deepEqual(await rules(prepareSwap(DEGEN_SELL, big.deps)), ["max_usd_per_tx"]);
  assert.equal(big.calls.length, 1, "it WAS quoted: that is where the figure comes from");
  assert.equal(big.executed.length, 0);
  assert.deepEqual(await rules(runSwap(DEGEN_SELL, { dryRun: true }, big.deps)), ["max_usd_per_tx"]);
  // the day's total counts too
  setPolicy({ perDay: "10" });
  assert.deepEqual(await rules(prepareSwap(DEGEN_SELL, baseRig(sellPlan()).deps)), ["max_usd_per_day"]);
  setPolicy({ perDay: "300" });
});

test("Base: a token sold for ETH is valued at the Chainlink price of the ETH the quote returns", async () => {
  owner();
  const plan = baseTokenPlan({ side: "sell", major: "ETH", majorUnits: 10n ** 16n, tokenUnits: 5000n * 10n ** 18n, usd: 0 }); // 0.01 ETH, no USDC leg to measure
  const p = await prepareSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, baseRig(plan).deps);
  assert.equal(p.display.usd_held_to_limits, 25);
  assert.equal(p.display.usd_basis, "oracle_on_received");
  assert.equal(p.display.oracle.used_for.includes("sizing the ETH leg only"), true);
  assert.equal(p.display.oracle.deviation_pct, null, "no quote-vs-oracle check for a token");
  // 0.01 ETH at $2500 = $25 is within the $100 limit; 0.05 ETH is not
  const big = baseTokenPlan({ side: "sell", major: "ETH", majorUnits: 5n * 10n ** 16n, tokenUnits: 5000n * 10n ** 18n, usd: 0 });
  assert.deepEqual(await rules(prepareSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, baseRig(big).deps)), ["max_usd_per_tx"]);
});

test("Base: a token bought is held to the USDC amount (or the ETH at the Chainlink price); the oracle check is skipped for a token and kept for a major pair", async () => {
  owner();
  const p = await prepareSwap(DEGEN_BUY, baseRig(buyPlan()).deps);
  assert.deepEqual([p.display.usd_held_to_limits, p.display.usd_basis, p.display.oracle], [20, "usdc_amount", null]);
  assert.equal(p.display.long_tail.role, "buying");
  // buying with ETH: sized at the oracle, which is used to size and not to judge the token's price
  const e = await prepareSwap({ chain: "base", from: "ETH", to: DEGEN, amount: "0.01" }, baseRig(baseTokenPlan({ side: "buy", major: "ETH", majorUnits: 10n ** 16n, tokenUnits: 5000n * 10n ** 18n, usd: 25 })).deps);
  assert.deepEqual([e.display.usd_held_to_limits, e.display.oracle.deviation_pct], [25, null]);
  // a token quote that would imply a crazy ETH price is not an oracle matter: no quote_off_market
  const odd = await prepareSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, baseRig(baseTokenPlan({ side: "sell", major: "ETH", majorUnits: 10n ** 12n, tokenUnits: 5000n * 10n ** 18n, usd: 0 })).deps);
  assert.ok(odd.display.usd_held_to_limits < 1);
  // the same oracle still judges a major pair
  const far = prepareSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan({ sellAmount: 50, quoted: 0.015, usd: 50 }) });
  assert.deepEqual(await rules(far), ["quote_off_market"]);
});

test("Solana: a token bought is sized from the USDC (or SOL at the Chainlink price); a token sold is sized from the major leg, with the fee added back, and the limits are checked again", async () => {
  owner();
  const buy = solRig(bonkBuyPlan());
  const b = await prepareSwap(BONK_BUY, buy.deps);
  assert.deepEqual([b.display.usd_held_to_limits, b.display.usd_basis, b.display.oracle], [20, "usdc_amount", null]);
  assert.equal(buy.asked[0].token_in, USDC_MINT);
  assert.equal(buy.asked[0].token_out, BONK, "Sato Hub is asked about the token's mint");
  assert.equal(buy.asked[0].usd_notional, 20);
  assert.equal(buy.asked[0].venue, "jupiter-aggregator");
  assert.equal(buy.planned[0].a.to, BONK);
  // sale for USDC: 19.7 USDC out plus the 0.03 fee that comes out of the output = 19.73
  const sell = solRig(bonkSellPlan());
  const s = await prepareSwap(BONK_SELL, sell.deps);
  assert.deepEqual([s.display.usd_held_to_limits, s.display.usd_basis, s.display.oracle], [19.73, "usdc_received", null]);
  assert.equal("usd_notional" in sell.asked[0], false, "no figure is sent before there is one");
  assert.equal(sell.asked[0].token_in, BONK);
  await s.execute();
  assert.equal(sell.executed[0].usdNotional, 19.73);
  // sale for SOL: 0.2003 SOL (fee added back) at $110
  const forSol = solRig(bonkSellPlan({ out: 200_000_000, feeMax: 300_000, outDec: 9 }));
  const t = await prepareSwap({ chain: "solana", from: BONK, to: "SOL", amount: "1000000" }, forSol.deps);
  assert.deepEqual([t.display.usd_held_to_limits, t.display.usd_basis, t.display.oracle.deviation_pct], [22.033, "oracle_on_received", null]);
  // over the limit once the quote is in: refused
  assert.deepEqual(await rules(prepareSwap(BONK_SELL, solRig(bonkSellPlan({ out: 150_000_000 })).deps)), ["max_usd_per_tx"]);
});

test("a token for a token is refused, clearly, on both chains", async () => {
  owner();
  assert.deepEqual(await rules(sizeSwap({ chain: "base", from: DEGEN, to: PEPE, amount: "5" }, baseRig(buyPlan()).deps)), ["token_to_token"]);
  assert.deepEqual(await rules(sizeSwap({ chain: "solana", from: BONK, to: WIF, amount: "5" }, solRig(bonkBuyPlan(), { mints: { [BONK]: mintEntry(), [WIF]: mintEntry() } }).deps)), ["token_to_token"]);
  await assert.rejects(sizeSwap({ chain: "base", from: DEGEN, to: PEPE, amount: "5" }, baseRig(buyPlan()).deps), /one side of a swap must be USDC, ETH or WETH/);
  // a symbol that is not a major is not guessed at
  await assert.rejects(sizeSwap({ chain: "base", from: "USDC", to: "PEPE", amount: "5" }, baseRig(buyPlan()).deps), /USDC, ETH, WETH, or a token by its 0x contract address/);
  await assert.rejects(sizeSwap({ chain: "solana", from: "USDC", to: "BONK", amount: "5" }, solRig(bonkBuyPlan()).deps), /swaps USDC, SOL, or a token by its mint address/);
});

test("slippage is picked per trade: 50 bps between majors, 150 with a token, plus a Solana token's own transfer fee, never above 500; the owner's flag and cap still win", async () => {
  assert.deepEqual(chooseSlippage({ longTail: false }), { bps: 50, source: "default", default_bps: 50 });
  assert.equal(chooseSlippage({ longTail: true }).bps, 150);
  assert.equal(chooseSlippage({ longTail: true, tokenFeeBps: 200 }).bps, 350);
  assert.equal(chooseSlippage({ longTail: true, tokenFeeBps: 400 }).bps, 500, "capped at the kit's 500");
  assert.equal(chooseSlippage({ longTail: false, tokenFeeBps: 400 }).bps, 50, "a transfer fee only matters with a token");
  assert.equal(chooseSlippage({ longTail: true, flag: 80 }).bps, 80);
  assert.deepEqual(chooseSlippage({ longTail: true, cap: 100 }), { bps: 100, source: "owner_cap", default_bps: 150 });
  assert.equal(chooseSlippage({ longTail: false, cap: 300 }).bps, 50, "a cap above the default leaves the default");
  for (const bad of [0, 501, 1.5, -3]) assert.throws(() => chooseSlippage({ flag: bad }), /1 to 500/);

  owner();
  assert.equal((await sizeSwap({ chain: "base", from: "USDC", to: "ETH", amount: "10" }, baseRig(buyPlan()).deps)).slippageBps, 50);
  assert.equal((await sizeSwap(DEGEN_BUY, baseRig(buyPlan()).deps)).slippageBps, 150);
  assert.equal((await sizeSwap({ ...DEGEN_BUY, slippageBps: 220 }, baseRig(buyPlan()).deps)).slippageBps, 220);
  // Solana: a Token-2022 mint with a 2% transfer fee gets 150 + 200
  const fee = { [BONK]: mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [EXT.transferFee(200)] }) };
  const s = await sizeSwap(BONK_BUY, solRig(bonkBuyPlan(), { mints: fee }).deps);
  assert.deepEqual([s.slippageBps, s.slippage.includes_transfer_fee_bps], [350, 200]);
  assert.deepEqual(s.confirm.map((c) => c.code), ["slippage_over_300_bps"], "350 bps is above 300: the owner is asked");
  // the owner's cap, set at setup, is still enforced: a flag above it is refused, and it lowers the default
  owner({ cap: "100" });
  assert.deepEqual(await rules(sizeSwap({ ...DEGEN_BUY, slippageBps: 200 }, baseRig(buyPlan()).deps)), ["max_slippage_bps"]);
  const capped = await sizeSwap(DEGEN_BUY, baseRig(buyPlan()).deps);
  assert.deepEqual([capped.slippageBps, capped.slippage.source], [100, "owner_cap"]);
  // and it is what the planner is given and what the display says
  const rig = baseRig(buyPlan());
  const shown = await prepareSwap(DEGEN_BUY, rig.deps);
  assert.equal(rig.calls[0].args.slippageBps, 100);
  assert.match(swapLines(shown.display).join("\n"), /Slippage used: 100 bps \(the owner's cap/);
  owner();
  const free = baseRig(buyPlan());
  const shown2 = await prepareSwap(DEGEN_BUY, free.deps);
  assert.equal(free.calls[0].args.slippageBps, 150);
  assert.match(swapLines(shown2.display).join("\n"), /Slippage used: 150 bps \(picked for this trade: 150 bps because a token is involved\)/);
});

test("the thresholds: 300 bps of slippage, 300 bps of price impact, a 3% Base value gap and a 300 bps sell-back loss are the lines; one step over asks", async () => {
  assert.deepEqual(CONFIRM, { slippageBps: 300, priceImpactBps: 300, valueGapPct: 3, sellBackLossBps: 300 });
  owner();
  const at = async (req, plan, deps) => (await prepareSwap(req, deps(plan))).confirm.map((c) => c.code);
  // slippage
  assert.deepEqual((await sizeSwap({ ...DEGEN_BUY, slippageBps: 300 }, baseRig(buyPlan()).deps)).confirm, []);
  assert.deepEqual((await sizeSwap({ ...DEGEN_BUY, slippageBps: 301 }, baseRig(buyPlan()).deps)).confirm.map((c) => c.code), ["slippage_over_300_bps"]);
  // Base value gap (percent) and sell-back loss (bps)
  const baseOf = (plan) => baseRig(plan).deps;
  assert.deepEqual(await at(DEGEN_BUY, buyPlan({ market: { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 19.4, value_gap_pct: 3 } }), baseOf), []);
  assert.deepEqual(await at(DEGEN_BUY, buyPlan({ market: { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 19.38, value_gap_pct: 3.1 } }), baseOf), ["value_gap_over_3_pct_upto_4pct"]);
  assert.deepEqual(await at(DEGEN_BUY, buyPlan({ sellBack: { checked: true, sold_units: 5n * 10n ** 21n, returned_units: 19_400_000n, asset: "USDC", loss_bps: 300, allowed_loss_bps: 600, route_id: "r" } }), baseOf), []);
  assert.deepEqual(await at(DEGEN_BUY, buyPlan({ sellBack: { checked: true, sold_units: 5n * 10n ** 21n, returned_units: 19_300_000n, asset: "USDC", loss_bps: 301, allowed_loss_bps: 600, route_id: "r" } }), baseOf), ["sell_back_loss_over_300_bps_upto_4pct"]);
  // a sale carries no sell-back test, and a value gap on a sale asks the same way
  assert.deepEqual(await at(DEGEN_SELL, sellPlan({ market: { price_impact_pct: null, amount_in_usd: 21, amount_out_usd: 19.9, value_gap_pct: 5.24 } }), baseOf), ["value_gap_over_3_pct_upto_6pct"]);
  // Solana price impact (bps), from Jupiter
  const solOf = (impactBps) => solRig(bonkBuyPlan({ impactBps })).deps;
  assert.deepEqual(await at(BONK_BUY, 300, solOf), []);
  assert.deepEqual(await at(BONK_BUY, 301, solOf), ["price_impact_over_300_bps_upto_4pct"]);
  assert.deepEqual(await at(BONK_BUY, null, solOf), [], "an unknown impact is not a reason (and not zero)");
});

test("each reason forces the owner's approval in auto mode (exit 5), says why, and an approved re-run goes ahead", async () => {
  owner();
  // 1. slippage: known before the quote, so nothing is quoted until the owner has said yes
  {
    const rig = baseRig(buyPlan());
    const req = { ...DEGEN_BUY, slippageBps: 400 };
    const e = await needs(runSwap(req, {}, rig.deps));
    assert.ok(e, "auto mode, and still asked");
    assert.deepEqual(e.intent.confirm_reasons, ["slippage_over_300_bps"]);
    assert.deepEqual([e.intent.chain, e.intent.from_id, e.intent.to_id, e.intent.amount, e.intent.slippage_bps], ["base", evm.TOKENS.USDC.address, DEGEN, "20", 400]);
    assert.match(e.message, /needs the owner's approval even though the agent acts within its limits, because:\n {2}- the slippage is 400 bps, above 300 bps/);
    assert.equal(e.reasons.length, 1);
    assert.equal(rig.calls.length, 0, "no quote before the approval");
    const ok = await runSwap(req, { approve: e.approval.code }, rig.deps);
    assert.equal(rig.calls.length, 1);
    assert.equal(ok.prepared.confirm.length, 1);
    await assert.rejects(runSwap(req, { approve: e.approval.code }, rig.deps), /approval .* (not found|already used)/, "a code works once");
    // ...and only for that exact swap
    const e2 = await needs(runSwap(req, {}, rig.deps));
    // a code for another swap is not a way in: the owner is asked again, for the swap as it now is (a new code, nothing signed)
    const other = await needs(runSwap({ ...req, slippageBps: 450 }, { approve: e2.approval.code }, rig.deps));
    assert.ok(other && other.approval.code !== e2.approval.code && other.intent.slippage_bps === 450);
    const other2 = await needs(runSwap({ ...req, amount: "21" }, { approve: (await needs(runSwap(req, {}, rig.deps))).approval.code }, rig.deps));
    assert.equal(other2.intent.amount, "21");
    assert.equal(rig.executed.length, 0);
  }
  // 2. Base value gap: only the quote shows it
  {
    const rig = baseRig(buyPlan({ market: { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 18.8, value_gap_pct: 6 } }));
    const e = await needs(runSwap(DEGEN_BUY, {}, rig.deps));
    assert.deepEqual(e.intent.confirm_reasons, ["value_gap_over_3_pct_upto_6pct"]);
    assert.match(e.reasons[0], /value gap that includes pool fees, Sato's fee and gas/);
    assert.equal(rig.executed.length, 0);
    const ok = await runSwap(DEGEN_BUY, { approve: e.approval.code }, rig.deps);
    await ok.prepared.execute();
    assert.equal(rig.executed.length, 1);
  }
  // 3. Base sell-back loss on a buy
  {
    const rig = baseRig(buyPlan({ sellBack: { checked: true, sold_units: 5n * 10n ** 21n, returned_units: 19_000_000n, asset: "USDC", loss_bps: 500, allowed_loss_bps: 600, route_id: "r" } }));
    const e = await needs(runSwap(DEGEN_BUY, {}, rig.deps));
    assert.deepEqual(e.intent.confirm_reasons, ["sell_back_loss_over_300_bps_upto_5pct"]);
    await runSwap(DEGEN_BUY, { approve: e.approval.code }, rig.deps);
  }
  // 4. Solana price impact
  {
    const rig = solRig(bonkSellPlan({ impactBps: 900 }));
    const e = await needs(runSwap(BONK_SELL, {}, rig.deps));
    assert.deepEqual(e.intent.confirm_reasons, ["price_impact_over_300_bps_upto_9pct"]);
    assert.match(e.reasons[0], /moves the price by 9%/);
    const ok = await runSwap(BONK_SELL, { approve: e.approval.code }, rig.deps);
    await ok.prepared.execute();
    assert.equal(rig.executed.length, 1);
  }
  // an approval names its reasons: it is not spent on a quote that has none, and it does not cover a different set
  {
    const first = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    const calm = await runSwap(BONK_SELL, { approve: first.approval.code }, solRig(bonkSellPlan({ impactBps: 100 })).deps);
    assert.deepEqual(calm.confirm, [], "no reason this time, so nothing to approve");
    const slippy = { ...BONK_SELL, slippageBps: 450 };
    const other = await needs(runSwap(slippy, { approve: first.approval.code }, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    assert.notEqual(other.approval.code, first.approval.code, "another slippage is another swap: the owner is asked again");
    await runSwap(BONK_SELL, { approve: first.approval.code }, solRig(bonkSellPlan({ impactBps: 900 })).deps); // still good for the swap it was given for
  }
  // approving the impact the owner saw never approves a worse one: 9% approved, the re-quote says 40%
  {
    const seen = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    const worse = solRig(bonkSellPlan({ impactBps: 4000 }));
    const again = await needs(runSwap(BONK_SELL, { approve: seen.approval.code }, worse.deps));
    assert.deepEqual(again.intent.confirm_reasons, ["price_impact_over_300_bps_upto_40pct"], "asked again, with the new figure");
    assert.equal(worse.executed.length, 0, "nothing was signed on the old approval");
    // within the same band (8.5% after approving 9%) the approval still holds
    const near = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    const ok = await runSwap(BONK_SELL, { approve: near.approval.code }, solRig(bonkSellPlan({ impactBps: 850 })).deps);
    assert.deepEqual(ok.confirm.map((c) => c.code), ["price_impact_over_300_bps_upto_9pct"]);
  }
  // a trade with no reason runs without the owner in auto mode
  {
    const rig = solRig(bonkBuyPlan({ impactBps: 100 }));
    const r = await runSwap(BONK_BUY, {}, rig.deps);
    assert.deepEqual(r.confirm, []);
  }
});

test("a dry run asks nobody and says what would need approval", async () => {
  owner();
  const rig = solRig(bonkSellPlan({ impactBps: 900 }));
  const r = await runSwap(BONK_SELL, { dryRun: true }, rig.deps);
  assert.deepEqual(r.confirm.map((c) => c.code), ["price_impact_over_300_bps_upto_9pct"]);
  assert.match(swapLines(r.prepared.display).join("\n"), /Needs the owner's approval before it is signed, because: Jupiter estimates this swap moves the price by 9%/);
});

test("ask mode: the approval request says the fee in plain words (published rate, and the most this approval allows)", async () => {
  owner({ ask: true });
  try {
    const token = await needs(runSwap(DEGEN_BUY, {}, baseRig(buyPlan()).deps));
    assert.equal(token.intent.fee_tier, "token");
    assert.equal(token.intent.fee_max_bps, 100);
    assert.match(token.message, /\nSato Hub fee: 0\.75% for a token trade \(this approval allows up to 1%\)\.$/);
    assert.equal(token.fee_line, "Sato Hub fee: 0.75% for a token trade (this approval allows up to 1%).");
    const major = await needs(runSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, {}, { oraclePrice: eth(2500) }));
    assert.equal(major.intent.fee_tier, "major");
    assert.match(major.message, /Sato Hub fee: 0\.15% for ETH or SOL with USDC \(this approval allows up to 0\.15%\)\./);
  } finally {
    owner();
  }
});

test("ask mode: the normal approval comes first; a reason only the quote shows needs a second one that names it", async () => {
  owner({ ask: true });
  try {
    // no reason: one approval, then it goes
    const quiet = solRig(bonkBuyPlan({ impactBps: 100 }));
    const a = await needs(runSwap(BONK_BUY, {}, quiet.deps));
    assert.deepEqual(a.intent.confirm_reasons, []);
    assert.equal(quiet.planned.length, 0, "approved before any quote");
    await runSwap(BONK_BUY, { approve: a.approval.code }, quiet.deps);
    assert.equal(quiet.planned.length, 1);
    // a reason that is known up front is in the first approval, shown with it
    const slip = solRig(bonkBuyPlan({ impactBps: 100 }));
    const s1 = await needs(runSwap({ ...BONK_BUY, slippageBps: 400 }, {}, slip.deps));
    assert.deepEqual(s1.intent.confirm_reasons, ["slippage_over_300_bps"]);
    assert.match(s1.message, /the slippage is 400 bps/);
    await runSwap({ ...BONK_BUY, slippageBps: 400 }, { approve: s1.approval.code }, slip.deps);
    // a reason only the quote shows: approval 1 (before the quote) is not enough; approval 2 names the reason
    const loud = solRig(bonkSellPlan({ impactBps: 900 }));
    const first = await needs(runSwap(BONK_SELL, {}, loud.deps));
    assert.deepEqual(first.intent.confirm_reasons, []);
    const second = await needs(runSwap(BONK_SELL, { approve: first.approval.code }, loud.deps));
    assert.ok(second, "the quote showed a price impact: asked again");
    assert.deepEqual(second.intent.confirm_reasons, ["price_impact_over_300_bps_upto_9pct"]);
    assert.notEqual(second.approval.code, first.approval.code);
    assert.match(second.message, /moves the price by 9%/);
    assert.equal(loud.executed.length, 0);
    const done = await runSwap(BONK_SELL, { approve: second.approval.code }, loud.deps);
    await done.prepared.execute();
    assert.equal(loud.executed.length, 1);
    // an unrelated code is not a way in
    await assert.rejects(runSwap(BONK_SELL, { approve: "deadbeef" }, loud.deps), /not found/);
  } finally {
    owner();
  }
});

test("a token whose issuer holds a power is confirm-required, not refused; a token that cannot be sold is refused", async () => {
  owner();
  const mints = (ext) => ({ [BONK]: mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext] }) });
  // the real resolver reads the mint from the (fake) chain
  for (const [name, code, re] of [
    ["PermanentDelegate", "issuer_power_PermanentDelegate", /the issuer can move or burn this token in your wallet/],
    ["TransferHook", "issuer_power_TransferHook", /the issuer's program runs on every transfer and can block a sale/],
  ]) {
    const rig = solRig(bonkBuyPlan({ impactBps: 100, outDec: 5 }), { mints: mints(EXT[name]) });
    const sized = await sizeSwap(BONK_BUY, rig.deps);
    assert.deepEqual(sized.confirm.map((c) => c.code), [code], name);
    assert.match(sized.confirm[0].text, re);
    const e = await needs(runSwap(BONK_BUY, {}, rig.deps));
    assert.deepEqual(e.intent.confirm_reasons, [code]);
    assert.equal(rig.planned.length, 0, "asked before any quote");
    assert.match(e.message, re);
    await runSwap(BONK_BUY, { approve: e.approval.code }, rig.deps);
    assert.equal(rig.planned.length, 1);
    // selling it asks the same way
    const sell = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan(), { mints: mints(EXT[name]) }).deps));
    assert.deepEqual(sell.intent.confirm_reasons, [code]);
  }
  // both powers at once: both named
  const both = solRig(bonkBuyPlan(), { mints: { [BONK]: mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [EXT.PermanentDelegate, EXT.TransferHook] }) } });
  assert.deepEqual((await sizeSwap(BONK_BUY, both.deps)).confirm.map((c) => c.code), ["issuer_power_PermanentDelegate", "issuer_power_TransferHook"]);
  // one that stops a sale is refused, before anything is asked or quoted
  const rig = solRig(bonkBuyPlan(), { mints: mints(EXT.NonTransferable) });
  assert.deepEqual(await rules(runSwap(BONK_BUY, {}, rig.deps)), ["solana_swap.token_extension_refused"]);
  assert.equal(rig.asked.length, 0);
  assert.equal(rig.planned.length, 0);
  // an ordinary mint has no reason
  assert.deepEqual((await sizeSwap(BONK_BUY, solRig(bonkBuyPlan()).deps)).confirm, []);
});

test("Solana: Sato's disclosure must put the fee on the major side, and the rebuilt quote of a token trade may not be worse than the one the owner was shown", async () => {
  owner();
  // the fee leg: buying (major in) is "in"; selling (token in) is "out"
  assert.deepEqual(await rules(prepareSwap(BONK_BUY, solRig(bonkBuyPlan(), { sato: { sato_fee_side: "out" } }).deps)), ["fee_side_mismatch"]);
  assert.deepEqual(await rules(prepareSwap(BONK_SELL, solRig(bonkSellPlan(), { sato: { sato_fee_side: "in" } }).deps)), ["fee_side_mismatch"]);
  assert.deepEqual(await rules(prepareSwap(BONK_BUY, solRig(bonkBuyPlan(), { sato: { sato_fee_side: "in", sato_fee_token: BONK } }).deps)), ["fee_side_mismatch"], "never the token");
  await prepareSwap(BONK_SELL, solRig(bonkSellPlan(), { sato: { sato_fee_side: "out", sato_fee_token: USDC_MINT } }).deps);
  await prepareSwap(BONK_SELL, solRig(bonkSellPlan(), { sato: { sato_fee_side: "out", sato_fee_token: "USDC" } }).deps);
  await prepareSwap(BONK_SELL, solRig(bonkSellPlan(), { sato: {} }).deps); // an older Sato Hub says nothing: the kit's pinned accounts decide
  // a signed answer about another mint is another swap
  assert.deepEqual(await rules(prepareSwap(BONK_BUY, solRig(bonkBuyPlan(), { extra: { callTool: async () => ({ structured: satoFor(USDC_MINT, WIF, 20_000_000) }) } }).deps)), ["response_mismatch"]);

  // rebuilt after a stale plan: better or equal is fine; below the first minimum, or with a new reason, is not
  const stale = (second) => {
    let built = 0;
    return solRig((a) => (built++ === 0 ? bonkSellPlan()(a) : bonkSellPlan(second)(a)), {
      extra: { executeSolanaSwap: async function exec(_p, d) { if (built === 1) throw new PlanStale("old"); return { tx: "sig", seen: d.usdNotional }; } },
    });
  };
  const okRig = stale({ out: 20_000_000, feeMax: 30_000 });
  const ok = await (await prepareSwap(BONK_SELL, okRig.deps)).execute();
  assert.equal(ok.tx, "sig");
  assert.equal(ok.seen, 20.03, "sized again from the rebuilt quote");
  assert.equal(ok.rebuilt.quoted, "20");
  const worse = stale({ out: 15_000_000 });
  assert.deepEqual(await rules((await prepareSwap(BONK_SELL, worse.deps)).execute()), ["quote_moved"]);
  const louder = stale({ out: 19_700_000, impactBps: 900 });
  assert.deepEqual(await rules((await prepareSwap(BONK_SELL, louder.deps)).execute()), ["confirm_reasons_changed"]);
  const over = stale({ out: 150_000_000 });
  assert.deepEqual(await rules((await prepareSwap(BONK_SELL, over.deps)).execute()), ["max_usd_per_tx"]);
});

test("--amount all sells the whole balance of a token, read from the chain, and only a token", async () => {
  owner();
  const balances = [];
  const bal = (units) => async (chain, asset) => (balances.push([chain, asset.id]), units);
  const b = await sizeSwap({ ...DEGEN_SELL, amount: "all" }, { ...baseRig(sellPlan()).deps, tokenBalance: bal(1234n * 10n ** 18n + 5n * 10n ** 17n) });
  assert.deepEqual([b.amount, b.amountIsAll, balances[0]], ["1234.5", true, ["base", DEGEN]]);
  const s = await sizeSwap({ ...BONK_SELL, amount: "ALL" }, { ...solRig(bonkSellPlan()).deps, tokenBalance: bal(250_000_000_000n) });
  assert.deepEqual([s.amount, s.amountIsAll, balances[1]], ["2500000", true, ["solana", BONK]]);
  // the approval binds the amount that was read
  assert.equal(swapIntent(s, []).amount, "2500000");
  assert.deepEqual(await rules(sizeSwap({ ...DEGEN_SELL, amount: "all" }, { ...baseRig(sellPlan()).deps, tokenBalance: bal(0n) })), ["no_balance"]);
  await assert.rejects(sizeSwap({ ...DEGEN_SELL, amount: "all" }, { ...baseRig(sellPlan()).deps, tokenBalance: async () => { throw new Error("rpc down"); } }), /could not read the wallet's DEGEN 0x4ed4…efed balance \(rpc down\); give an amount instead/);
  await assert.rejects(sizeSwap({ chain: "base", from: "USDC", to: DEGEN, amount: "all" }, baseRig(buyPlan()).deps), /--amount all sells the whole balance of a token/);
  await assert.rejects(sizeSwap({ chain: "base", from: DEGEN, to: "USDC", amount: "1e3" }, baseRig(sellPlan()).deps), /not a DEGEN 0x4ed4…efed amount/);
  await assert.rejects(sizeSwap({ chain: "base", from: DEGEN, to: "USDC", amount: "0" }, baseRig(sellPlan()).deps), /not a DEGEN 0x4ed4…efed amount/);
});

test("a link goes through Sato Hub's resolver and is then read again from the chain; the chain wins where they differ; no resolver, no link", async () => {
  owner();
  const hubFor = (extra = {}) => async (input, { chain }) => ({ ok: true, token: { chain, address: DEGEN, decimals: 18, program: "erc20", symbol: "DEGEN", ...extra }, signature: { ok: true } });
  const rig = baseRig(buyPlan());
  const asked = [];
  const viaLink = await sizeSwap({ ...DEGEN_BUY, to: "https://dexscreener.com/base/0xabc" }, { ...rig.deps, resolveHub: async (i, o) => (asked.push([i, o]), hubFor()(i, o)) });
  // asked with the same signature window as the fee disclosure
  assert.deepEqual(asked, [["https://dexscreener.com/base/0xabc", { chain: "base", verifySignature: undefined, maxAgeMs: 120_000 }]]);
  assert.equal(viaLink.toAsset.id, DEGEN);
  const resolvedNote = `The link resolved to ${DEGEN} on Base (Sato Hub's signed answer); the chain was read for that address, not the link.`;
  assert.deepEqual(viaLink.notes, [resolvedNote]);
  assert.deepEqual(viaLink.resolvedFromLink, [{ symbol: "DEGEN 0x4ed4…efed", address: DEGEN, chain: "base" }]);
  // Sato Hub says 9 decimals; the chain says 18: the chain's number is used and the owner is told
  const wrong = await sizeSwap({ ...DEGEN_BUY, to: "dexscreener.com/base/0xabc" }, { ...rig.deps, resolveHub: hubFor({ decimals: 9 }) });
  assert.equal(wrong.toAsset.decimals, 18);
  assert.deepEqual(wrong.notes, [resolvedNote, "Sato Hub says 9 decimals; the chain says 18. The chain's value is used."]);
  const shown = (await prepareSwap({ ...DEGEN_BUY, to: "https://dexscreener.com/base/0xabc" }, { ...rig.deps, resolveHub: hubFor({ decimals: 9 }) })).display;
  assert.match(swapLines(shown).join("\n"), /Sato Hub says 9 decimals; the chain says 18/);
  assert.match(swapLines(shown).join("\n"), new RegExp(`The link resolved to ${DEGEN} on Base`), "the address the link became is shown (and so in a dry run)");
  assert.deepEqual(shown.resolved_from_link.map((r) => r.address), [DEGEN]);
  // an answer that cannot be shown to be signed by Sato Hub decides nothing: the owner sends the address
  for (const signature of [{ ok: false, error: "missing_signature" }, undefined]) {
    const unsigned = { ...rig.deps, resolveHub: async (i, o) => ({ ...(await hubFor()(i, o)), signature }) };
    await assert.rejects(sizeSwap({ ...DEGEN_BUY, to: "https://dexscreener.com/base/0xabc" }, unsigned), (e) => e instanceof Refused && e.refusals[0].rule === "resolver_unsigned" && /send the contract address instead/.test(e.message));
  }
  // through the real resolver call: it verifies the answer the way the fee disclosure is verified (the injected verifier here)
  const { resolveTokenViaHub } = await import("../src/satohub.js");
  const call = async () => ({ structured: { chain: "base", address: DEGEN, decimals: 18, meta: { signature: null } }, isError: false });
  assert.equal((await resolveTokenViaHub("x", { call, verifySignature: async () => ({ ok: true }), maxAgeMs: 120_000 })).signature.ok, true);
  const seen = [];
  const bad = await resolveTokenViaHub("x", { call, verifySignature: async (b, o) => (seen.push(o), Promise.reject(new Error("missing_signature"))), maxAgeMs: 120_000 });
  assert.deepEqual([bad.ok, bad.signature.ok, seen[0].maxAgeMs], [true, false, 120_000]);
  // no answer: the exact sentence
  const down = { ...rig.deps, resolveHub: async () => ({ ok: false, reason: "unavailable", error: "Unknown tool" }) };
  await assert.rejects(sizeSwap({ ...DEGEN_BUY, to: "https://dexscreener.com/base/0xabc" }, down), /^Error: Sato Hub could not resolve this link right now; send the contract address instead$/);
  // an answer for another chain is not followed
  await assert.rejects(sizeSwap({ ...DEGEN_BUY, to: "https://dexscreener.com/solana/x" }, { ...rig.deps, resolveHub: async () => ({ ok: true, token: { chain: "solana", address: BONK }, signature: { ok: true } }) }), /that link is for solana, but --chain is base/);
  // a bare address never calls the resolver
  let called = false;
  await sizeSwap(DEGEN_BUY, { ...rig.deps, resolveHub: async () => ((called = true), { ok: false }) });
  assert.equal(called, false);
  // the comparison, in isolation
  assert.deepEqual(compareHubWithChain("solana", { decimals: 6, program: "token-2022", mint_authority: { set: true, address: "A" }, freeze_authority: { set: false }, token2022_extensions: [] }, { decimals: 5, program_name: "Token", mint_authority: null, freeze_authority: "F", extensions: ["TransferHook"] }), [
    "Sato Hub says 6 decimals; the chain says 5. The chain's value is used.",
    "Sato Hub says the Token-2022 program; the chain says Token. The chain's value is used.",
    "Sato Hub says the mint authority is set (A); the chain says revoked. The chain's value is used.",
    "Sato Hub says the freeze authority is revoked; the chain says set (F). The chain's value is used.",
    "Sato Hub lists the Token-2022 extensions none; the chain lists TransferHook. The chain's list is used.",
  ]);
  assert.deepEqual(compareHubWithChain("base", { decimals: 18, program: "erc20" }, { decimals: 18 }), []);
});

test("the approval intent binds the chain, both token addresses, the amount, the slippage and the reasons", async () => {
  owner();
  const sized = await sizeSwap({ ...DEGEN_BUY, slippageBps: 400 }, baseRig(buyPlan()).deps);
  const i = swapIntent(sized, ["b", "a"]);
  assert.deepEqual([i.cmd, i.chain, i.from_id, i.to_id, i.amount, i.slippage_bps, i.confirm_reasons], ["swap", "base", evm.TOKENS.USDC.address, DEGEN, "20", 400, ["a", "b"]]);
  assert.match(i.price, /no independent price exists for the token/);
  const s = await sizeSwap(BONK_BUY, solRig(bonkBuyPlan()).deps);
  assert.deepEqual([swapIntent(s, []).from_id, swapIntent(s, []).to_id], [USDC_MINT, BONK]);
  const major = await sizeSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, { oraclePrice: solPrice(110) });
  assert.match(swapIntent(major, []).price, /oracle tolerance/);
});

test("what is shown to the owner names the slippage, the token read from the chain, the figures, and uses no safety words", async () => {
  owner();
  const lines = [];
  for (const [req, rig] of [
    [DEGEN_BUY, baseRig(buyPlan({ market: { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 19.7, value_gap_pct: 1.5 }, sellBack: { checked: true, sold_units: 5n * 10n ** 21n, returned_units: 19_000_000n, asset: "USDC", loss_bps: 500, allowed_loss_bps: 600, route_id: "r" } }))],
    [DEGEN_SELL, baseRig(sellPlan())],
    [BONK_BUY, solRig(bonkBuyPlan({ impactBps: 900 }))],
    [BONK_SELL, solRig(bonkSellPlan())],
  ]) {
    lines.push(...swapLines((await prepareSwap(req, rig.deps)).display));
  }
  const text = lines.join("\n");
  assert.match(text, /Slippage used: 150 bps/);
  assert.match(text, /There is no independent price for the token/);
  assert.match(text, /Sell-back test \(simulated only, nothing sent\)/);
  assert.match(text, /Value gap: the route values what you give at \$20 and what you get at \$19\.7, 1\.5% apart/);
  assert.match(text, /Price impact: Jupiter estimates 9% across 2 hops/);
  assert.match(text, /Held to your limits as \$19\.73 \(from the USDC the quote returns for the token\)/);
  // The fee as a percent first, then in bps (and the tier where the plan knows it), and never in the token.
  assert.match(text, /Sato Hub fee: 0\.15% \(15 bps(, a token trade)?\), taken in (SOL|USDC), never in the token/);
  assert.doesNotMatch(text, /\b(safe|secure|trusted|guaranteed?|verified|audited)\b/i);
});

test("evm: a token sale may be planned without a USD figure only when the caller says so", async () => {
  const SENDER = "0x1111111111111111111111111111111111111111";
  const stop = async () => { throw new Error("stop here"); };
  await assert.rejects(evm.planAndVerifyBaseSwap({ from: "ETH", to: "USDC", amount: "0.01", slippageBps: 50 }, { taker: SENDER, callTool: stop }), /usdNotional is required for planning a swap/);
  let asked;
  await assert.rejects(evm.planAndVerifyBaseSwap({ from: "ETH", to: "USDC", amount: "0.01", slippageBps: 50 }, { taker: SENDER, usdFromQuote: true, callTool: async (_n, a) => ((asked = a), stop()) }), /stop here/);
  assert.equal("usd_notional" in asked, false, "no figure is sent to Sato Hub");
});

// ================================================================= review round 2

test("Base market figures are read in Sato Hub's real shape (price_impact: reported_bps, usd_value_gap_bps), and drive the reasons", async () => {
  owner();
  // what Sato Hub's answer carries, read by the kit's own marketOf and handed to the orchestrator as a plan would have it
  const answer = (pi) => ({ price_impact: { reported_bps: null, usd_value_gap_bps: null, amount_in_usd: null, amount_out_usd: null, source: "x", ...pi } });
  const planWith = (response, o = {}) => buyPlan({ market: evm.marketOf(response), ...o });
  const codes = async (plan, req = DEGEN_BUY) => (await prepareSwap(req, baseRig(plan).deps)).confirm.map((c) => c.code);
  assert.deepEqual(await codes(planWith(answer({ usd_value_gap_bps: 650, amount_in_usd: 20, amount_out_usd: 18.7 }))), ["value_gap_over_3_pct_upto_7pct"], "Kyber: no reported impact, a 6.5% USD gap");
  assert.deepEqual(await codes(planWith(answer({ usd_value_gap_bps: 300, amount_in_usd: 20, amount_out_usd: 19.4 }))), [], "exactly 3% is not above it");
  assert.deepEqual(await codes(planWith(answer({ reported_bps: 450, usd_value_gap_bps: 100, amount_in_usd: 20, amount_out_usd: 19.8 }))), ["price_impact_over_300_bps_upto_5pct"], "a venue that reports an impact (Jupiter-style)");
  assert.deepEqual(await codes(planWith(answer({ reported_bps: 300 }))), [], "300 bps is not above 300");
  // a sale reads the same way
  assert.deepEqual(await codes(sellPlan({ market: evm.marketOf(answer({ usd_value_gap_bps: 900, amount_in_usd: 21, amount_out_usd: 19.1 })) }), DEGEN_SELL), ["value_gap_over_3_pct_upto_9pct"]);
});

test("fail closed: a token trade whose quote carries no market figure at all asks the owner (no_market_figure), buying or selling; a major pair does not", async () => {
  owner();
  const none = evm.marketOf({ price_impact: { reported_bps: null, usd_value_gap_bps: null, amount_in_usd: null, amount_out_usd: null } });
  assert.equal(none, null);
  for (const [req, plan] of [[DEGEN_BUY, buyPlan({ market: none })], [DEGEN_SELL, sellPlan({ market: none })], [DEGEN_BUY, buyPlan({ market: { price_impact_pct: null, amount_in_usd: 20, amount_out_usd: 19.9, value_gap_pct: null } })]]) {
    const rig = baseRig(plan);
    const e = await needs(runSwap(req, {}, rig.deps));
    assert.ok(e, "asked even in auto mode");
    assert.deepEqual(e.intent.confirm_reasons, ["no_market_figure"]);
    assert.match(e.reasons[0], /the quote gave no USD figures, so price impact can't be checked/);
    assert.equal(rig.executed.length, 0);
    await runSwap(req, { approve: e.approval.code }, rig.deps); // an approved re-run goes ahead
  }
  // USDC <-> ETH is held to the oracle and has no such reason
  const major = await prepareSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan({ sellAmount: 50, quoted: 0.0199, usd: 50 }) });
  assert.deepEqual(major.confirm, []);
});

test("Solana: a freeze authority, pausable transfers and a transfer fee above 300 bps ask the owner on each trade, even when the owner's slippage cap is set", async () => {
  const mints = (extra) => ({ [BONK]: extra });
  for (const cap of ["none", "100"]) {
    owner({ cap });
    // a freeze authority on a classic mint
    const frozen = solRig(bonkBuyPlan({ impactBps: 100 }), { mints: mints(mintEntry({ freeze: true })) });
    const e = await needs(runSwap(BONK_BUY, {}, frozen.deps));
    assert.deepEqual(e.intent.confirm_reasons, ["freeze_authority_set"], `cap ${cap}`);
    assert.match(e.reasons[0], /a freeze authority is set: it can freeze this wallet's account for the token, and a frozen account cannot sell/);
    assert.equal(frozen.planned.length, 0, "asked before any quote");
    await runSwap(BONK_BUY, { approve: e.approval.code }, frozen.deps);
    // selling it asks as well
    assert.deepEqual((await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan(), { mints: mints(mintEntry({ freeze: true })) }).deps))).intent.confirm_reasons, ["freeze_authority_set"]);
    // pausable transfers
    const pausable = solRig(bonkBuyPlan(), { mints: mints(mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [EXT.pausable] })) });
    assert.deepEqual((await needs(runSwap(BONK_BUY, {}, pausable.deps))).intent.confirm_reasons, ["transfers_pausable"]);
    // a transfer fee: 300 bps is the line, above it asks, and the band is bound ("…_upto_Npct")
    const fee = (bps) => solRig(bonkBuyPlan(), { mints: mints(mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [EXT.transferFee(bps)] })) });
    const at300 = await prepareSwap(BONK_BUY, fee(300).deps);
    assert.deepEqual(at300.confirm.map((c) => c.code).filter((c) => c.startsWith("transfer_fee")), []);
    const f4 = await needs(runSwap(BONK_BUY, {}, fee(400).deps));
    assert.ok(f4.intent.confirm_reasons.includes("transfer_fee_upto_4pct"), `cap ${cap}: ${f4.intent.confirm_reasons}`);
    assert.match(f4.reasons.join(" "), /the token takes a 4% fee on every transfer/);
    // approving a 4% fee never approves a 40% one: another band is another approval
    const f40 = await needs(runSwap(BONK_BUY, { approve: f4.approval.code }, fee(4000).deps));
    assert.ok(f40.intent.confirm_reasons.includes("transfer_fee_upto_40pct") && f40.approval.code !== f4.approval.code);
  }
  // a plain mint with nothing of these asks for nothing
  owner();
  assert.deepEqual((await runSwap(BONK_BUY, {}, solRig(bonkBuyPlan({ impactBps: 100 })).deps)).confirm, []);
});

test("an issuer-power token like PYUSD (permanent delegate, transfer hook, confidential transfers) is allowed with per-trade confirmation; confidential mint and burn is still refused", async () => {
  owner();
  const pyusdish = mintEntry({ program: TOKEN_2022_PROGRAM, decimals: 6, extensions: [EXT.PermanentDelegate, EXT.ConfidentialTransferMint, EXT.ConfidentialTransferFeeConfig, EXT.TransferHook] });
  const rig = solRig(bonkBuyPlan({ outDec: 6 }), { mints: { [BONK]: pyusdish } });
  const e = await needs(runSwap(BONK_BUY, {}, rig.deps));
  assert.deepEqual(e.intent.confirm_reasons, ["issuer_power_ConfidentialTransferFeeConfig", "issuer_power_ConfidentialTransferMint", "issuer_power_PermanentDelegate", "issuer_power_TransferHook"]);
  assert.match(e.message, /confidential transfers are enabled on this token; plain transfers still work, but the issuer can configure accounts for private balances/);
  await runSwap(BONK_BUY, { approve: e.approval.code }, rig.deps);
  assert.deepEqual(await rules(runSwap(BONK_BUY, {}, solRig(bonkBuyPlan(), { mints: { [BONK]: mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [EXT.ConfidentialMintBurn] }) } }).deps)), ["solana_swap.token_extension_refused"]);
});

test("a token sale is sized from the venue's PUBLIC quote before Sato Hub (and its public record) is asked; a quote over the limits is refused first", async () => {
  owner();
  // Base: the public quote says 150 USDC comes back; the per-transaction limit is $100
  const base = baseRig(sellPlan(), { publicQuote: async () => 150_000_000n });
  assert.deepEqual(await rules(prepareSwap(DEGEN_SELL, base.deps)), ["max_usd_per_tx"]);
  assert.equal(base.calls.length, 0, "Sato Hub was never asked");
  // ETH out: 0.05 ETH at $2500 = $125
  const eth_ = baseRig(baseTokenPlan({ side: "sell", major: "ETH", majorUnits: 10n ** 16n, tokenUnits: 5000n * 10n ** 18n, usd: 0 }), { publicQuote: async () => 5n * 10n ** 16n });
  assert.deepEqual(await rules(prepareSwap({ chain: "base", from: DEGEN, to: "ETH", amount: "5000" }, eth_.deps)), ["max_usd_per_tx"]);
  assert.equal(eth_.calls.length, 0);
  // Solana: Jupiter's public quote, and the day's remaining room counts
  const sol_ = solRig(bonkSellPlan(), { extra: { publicQuote: async () => 150_000_000n } });
  assert.deepEqual(await rules(prepareSwap(BONK_SELL, sol_.deps)), ["max_usd_per_tx"]);
  assert.deepEqual([sol_.asked.length, sol_.planned.length], [0, 0], "neither Sato Hub nor the planner was reached");
  setPolicy({ perDay: "10" });
  const day = solRig(bonkSellPlan(), { extra: { publicQuote: async () => 19_700_000n } });
  assert.deepEqual(await rules(prepareSwap(BONK_SELL, day.deps)), ["max_usd_per_day"]);
  assert.equal(day.asked.length, 0);
  setPolicy({ perDay: "300" });
  // within the limits it goes on to Sato Hub, whose own quote is sized and checked again; no answer from the venue skips the pre-size
  const fine = solRig(bonkSellPlan(), { extra: { publicQuote: async () => 19_700_000n } });
  await prepareSwap(BONK_SELL, fine.deps);
  assert.equal(fine.asked.length, 1);
  const silent = solRig(bonkSellPlan(), { extra: { publicQuote: async () => { throw new Error("venue down"); } } });
  await prepareSwap(BONK_SELL, silent.deps);
  const afterQuote = solRig(bonkSellPlan({ out: 150_000_000 }), { extra: { publicQuote: async () => 19_700_000n } });
  assert.deepEqual(await rules(prepareSwap(BONK_SELL, afterQuote.deps)), ["max_usd_per_tx"], "the post-quote check still holds");
  // a buy is sized from the major leg already: no public quote is asked for
  let asked = 0;
  await prepareSwap(BONK_BUY, solRig(bonkBuyPlan(), { extra: { publicQuote: async () => (asked++, null) } }).deps);
  assert.equal(asked, 0);
});

test("every long-tail token is labelled with its short address in the intent and the display", async () => {
  owner();
  const sized = await sizeSwap(DEGEN_BUY, baseRig(buyPlan()).deps);
  const i = swapIntent(sized, []);
  assert.deepEqual([i.from, i.to], ["USDC", "DEGEN 0x4ed4…efed"]);
  const d = (await prepareSwap(DEGEN_SELL, baseRig(sellPlan()).deps)).display;
  assert.match(swapLines(d).join("\n"), /sell 5000 DEGEN 0x4ed4…efed for about/);
  const s = await sizeSwap(BONK_BUY, solRig(bonkBuyPlan()).deps);
  assert.deepEqual([swapIntent(s, []).to, swapIntent(s, []).to_id], ["DezX…B263", BONK]);
  // a token that calls itself USDC is still told apart
  const liar = { ...degenToken, symbol: "USDC" };
  const sized2 = await sizeSwap(DEGEN_BUY, { ...baseRig(buyPlan()).deps, resolveBaseToken: async (x) => (String(x).toLowerCase() === DEGEN.toLowerCase() ? { ...liar } : baseResolver(x)) });
  assert.equal(sized2.to, "USDC 0x4ed4…efed");
});

test("an approval for a worse band, or for reasons the quote no longer shows, is asked again cleanly (a new approval request, never an error)", async () => {
  owner();
  // auto mode: approved at 9%, the quote now shows 5%: another band, another approval
  const loud = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan({ impactBps: 900 })).deps));
  assert.deepEqual(loud.intent.confirm_reasons, ["price_impact_over_300_bps_upto_9pct"]);
  const better = await needs(runSwap(BONK_SELL, { approve: loud.approval.code }, solRig(bonkSellPlan({ impactBps: 500 })).deps));
  assert.deepEqual(better.intent.confirm_reasons, ["price_impact_over_300_bps_upto_5pct"]);
  assert.notEqual(better.approval.code, loud.approval.code);
  assert.match(better.message, /moves the price by 5%/);
  // the same band still matches
  await runSwap(BONK_SELL, { approve: better.approval.code }, solRig(bonkSellPlan({ impactBps: 450 })).deps);
  // ask mode: the code was for the quote-time intent (impact 9%); the quote is calm now, and the approval of the trade is still due
  owner({ ask: true });
  try {
    const first = await needs(runSwap(BONK_SELL, {}, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    const second = await needs(runSwap(BONK_SELL, { approve: first.approval.code }, solRig(bonkSellPlan({ impactBps: 900 })).deps));
    const calm = await needs(runSwap(BONK_SELL, { approve: second.approval.code }, solRig(bonkSellPlan({ impactBps: 100 })).deps));
    assert.ok(calm, "asked again, not an error");
    assert.deepEqual(calm.intent.confirm_reasons, []);
    assert.notEqual(calm.approval.code, second.approval.code);
  } finally {
    owner();
  }
});

test("Solana: a SOL -> token trade rebuilt after a stale plan is valued again at the new Chainlink price", async () => {
  owner();
  let reads = 0;
  let built = 0;
  const rig = solRig((a) => (built++, solTokenPlan({ from: a.from, to: a.to, amountIn: 500_000_000, out: 100_000_000_000, inDec: 9, outDec: 5 })), {
    extra: {
      oraclePrice: async () => solPrice(reads++ === 0 ? 110 : 250)(), // $55 for 0.5 SOL, then $125
      executeSolanaSwap: async function exec(_p, d) { if (built === 1) throw new PlanStale("old"); return { tx: "sig", seen: d.usdNotional }; },
    },
  });
  const p = await prepareSwap({ chain: "solana", from: "SOL", to: BONK, amount: "0.5" }, rig.deps);
  assert.equal(p.display.usd_held_to_limits, 55);
  assert.deepEqual(await rules(p.execute()), ["max_usd_per_tx"], "$125 is over the $100 limit once the price is read again");
  assert.equal(reads, 2, "the oracle was read again for the rebuilt plan");
  // a price that is still inside the limit is what reaches the signer
  reads = 0;
  built = 0;
  const rig2 = solRig((a) => (built++, solTokenPlan({ from: a.from, to: a.to, amountIn: 500_000_000, out: 100_000_000_000, inDec: 9, outDec: 5 })), {
    extra: { oraclePrice: async () => solPrice(reads++ === 0 ? 110 : 160)(), executeSolanaSwap: async (_p, d) => { if (built === 1) throw new PlanStale("old"); return { tx: "sig", seen: d.usdNotional }; } },
  });
  const ok = await (await prepareSwap({ chain: "solana", from: "SOL", to: BONK, amount: "0.5" }, rig2.deps)).execute();
  assert.equal(ok.seen, 80);
});

test("a non-ASCII token symbol is flagged on the card, and the card names the token with its short address", async () => {
  const hubless = { resolveHub: async () => ({ ok: false, reason: "unavailable", error: "x" }), runCheck: async () => ({ unavailable: false, verdict: "go", rule: "r", text: "t", checked_at: "2026-10-09T10:00:00Z" }) };
  const { describeToken, renderTokenCard } = await import("../src/swap/run.js");
  const card = await describeToken(DEGEN, {}, { ...hubless, resolveBaseToken: async () => ({ ...degenToken, symbol: "USDС" }) }); // a Cyrillic С
  assert.equal(card.symbol_non_ascii, true);
  assert.equal(card.label, "USDС 0x4ed4…efed");
  assert.match(card.notes.join(" "), /outside plain ASCII/);
  assert.match(renderTokenCard(card)[0], /\(USDС 0x4ed4…efed\) on Base/);
  const plain = await describeToken(DEGEN, {}, { ...hubless, resolveBaseToken: async () => ({ ...degenToken }) });
  assert.equal(plain.symbol_non_ascii, false);
  assert.equal(plain.label, "DEGEN 0x4ed4…efed");
});
