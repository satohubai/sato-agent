// One swap, end to end, on either chain: the order every check runs in, so the
// CLI stays small and the two chains cannot drift apart.
//
//   1. the owner's choices: chain, swaps turned on, slippage cap, trades per 24h
//   2. an INDEPENDENT price (Chainlink on Base, for ETH and for SOL). No price,
//      no swap: the kit never values a trade from the quote it is about to sign.
//      The USD figure held to the limits is the USDC leg when USDC is sold, and
//      the oracle value of the ETH/SOL sold otherwise.
//   3. the quote and the unsigned transaction (Sato Hub on Base; Jupiter on
//      Solana with Sato's signed fee disclosure), then the chain module's own
//      verification and simulation (pinned contracts/programs, balance deltas)
//   4. the quote's implied price must sit near the oracle price
//      (ORACLE_TOLERANCE_PCT), or nothing is signed
//   5. execute under the ledger/lock/exit-code contract (in the chain modules)
//
// Steps 1-4 run for a dry run too; a dry run stops there.

import { evaluate, loadPolicy } from "../policy.js";
import { spentLast24h } from "../ledger.js";
import { Refused } from "../errors.js";
import { oraclePrice, quoteWithinOracle, ORACLE_TOLERANCE_PCT, PriceUnavailable } from "../price.js";
import { callTool } from "../satohub.js";
import { verifyHubSignature } from "../hub-signature.js";
import { addresses } from "../wallet.js";
import { usdcUnits, unitsToUsd, roundUsd } from "../amount.js";
import * as evm from "./evm.js";
import * as sol from "./solana.js";
import { USDC_MINT } from "../solana.js";

const refuse = (rule, message, limit = null, observed = null) => new Refused([{ rule, limit, observed, message }]);
const DISCLOSURE_MAX_AGE_MS = 120_000;

const ASSETS = {
  base: { USDC: { decimals: 6 }, ETH: { decimals: 18, oracle: "ETH" }, WETH: { decimals: 18, oracle: "ETH" } },
  solana: { USDC: { decimals: 6 }, SOL: { decimals: 9, oracle: "SOL" } },
};

function decimalToNumber(amount, decimals, label) {
  const s = String(amount);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals || !(Number(s) > 0)) throw new Error(`not a ${label} amount: "${amount}" (a plain positive number with at most ${decimals} decimals)`);
  return Number(s);
}

/** Validate the request against the owner's choices and size it in USD from an independent price. */
export async function sizeSwap({ chain, from, to, amount, slippageBps }, deps = {}) {
  const table = ASSETS[chain];
  if (!table) throw new Error("--chain must be base or solana");
  const f = String(from ?? "").toUpperCase();
  const t = String(to ?? "").toUpperCase();
  if (!table[f] || !table[t]) throw new Error(`on ${chain} the kit swaps ${Object.keys(table).join(", ")}`);
  if (f === t) throw new Error("--from and --to are the same asset");
  if (f !== "USDC" && t !== "USDC") throw new Error("one side of a swap must be USDC (this version)");

  const policy = deps.policy ?? loadPolicy();
  const bps = slippageBps ?? policy?.max_slippage_bps;
  const volatile = table[f].oracle ?? table[t].oracle;
  const amountNum = f === "USDC" ? unitsToUsd(usdcUnits(amount)) : decimalToNumber(amount, table[f].decimals, f);

  // Cheap refusals first (chain, swaps on, slippage cap, trade count): no price read for a swap the owner hasn't allowed.
  const pre = evaluate(policy, { usd: 0.000001, chain, kind: "swap", slippage_bps: bps }, spentLast24h());
  if (pre.length) throw new Refused(pre);

  let oracle;
  try {
    oracle = await (deps.oraclePrice ?? oraclePrice)(volatile);
  } catch (err) {
    if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent ${volatile} price right now (${err.message}); the kit does not swap without one`);
    throw err;
  }
  const usd = roundUsd(f === "USDC" ? amountNum : amountNum * oracle.usd);

  // The owner's caps, before anything is quoted (the reservation re-checks under the lock).
  const early = evaluate(policy, { usd, chain, kind: "swap", slippage_bps: bps }, spentLast24h());
  if (early.length) throw new Refused(early);
  return { chain, from: f, to: t, amount: String(amount), amountNum, slippageBps: bps, usd, oracle, volatile };
}

/** The quote's implied USD price for the volatile side, from a verified plan. */
function impliedPrice(sized, sell, buy) {
  // sell/buy are plain numbers in whole units; USDC is one side.
  return sized.from === "USDC" ? sell / buy : buy / sell;
}

function checkAgainstOracle(sized, implied) {
  const tol = ORACLE_TOLERANCE_PCT[sized.volatile];
  const q = quoteWithinOracle({ usdOracle: sized.oracle.usd, usdQuote: implied, tolerancePct: tol });
  if (!q.ok) {
    throw refuse(
      "quote_off_market",
      `the quote prices ${sized.volatile} at $${roundUsd(implied)}, ${q.deviation_pct ?? "?"}% from the independent Chainlink price of $${roundUsd(sized.oracle.usd)} (tolerance ${tol}%); nothing was signed`,
      tol,
      q.deviation_pct,
    );
  }
  return q.deviation_pct;
}

/** A new Chainlink reading for a rebuilt plan; no price, no swap. */
async function freshOracle(sized, deps) {
  try {
    return { ...sized, oracle: await (deps.oraclePrice ?? oraclePrice)(sized.volatile) };
  } catch (err) {
    if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent ${sized.volatile} price right now (${err.message}); the kit does not swap without one`);
    throw err;
  }
}

/** Sato Hub's signed fee disclosure for a Solana swap (Sato quotes; the kit builds through Jupiter). */
async function satoSolanaDisclosure(sized, deps) {
  const a = addresses();
  const mint = { USDC: USDC_MINT, SOL: sol.WSOL_MINT };
  const amountIn = sized.from === "USDC" ? usdcUnits(sized.amount).toString() : sol.solLamports(sized.amount).toString();
  const r = await (deps.callTool ?? callTool)("onchain_agent_swap", {
    mode: "recommend",
    chain_in: "Solana",
    chain_out: "Solana",
    token_in: mint[sized.from],
    token_out: mint[sized.to],
    amount_in: amountIn,
    taker: a.solana,
    slippage_bps: sized.slippageBps,
    usd_notional: sized.usd,
    response_format: "json",
  });
  const body = r.structured;
  if (r.isError || !body) throw refuse("sato_quote_unavailable", "Sato Hub did not return a quote for this swap; nothing was signed");
  try {
    // Same two-minute window as Base: a disclosure is for this swap, now.
    await (deps.verifySignature ?? verifyHubSignature)(body, { maxAgeMs: DISCLOSURE_MAX_AGE_MS });
  } catch (err) {
    throw refuse("signature_unverified", `Sato Hub's quote could not be shown to come from Sato Hub (${err.message}); nothing was signed`);
  }
  // The signed answer must be about THIS swap: same chain, pair and amount.
  const mismatch = [
    String(body.chain ?? "").toLowerCase() !== "solana" && "chain",
    body.token_in !== mint[sized.from] && "token_in",
    body.token_out !== mint[sized.to] && "token_out",
    String(body.amount_in) !== amountIn && "amount_in",
  ].filter(Boolean);
  if (mismatch.length) throw refuse("response_mismatch", `Sato Hub's signed quote is about a different swap (${mismatch.join(", ")} differ); nothing was signed`);
  if (body.venue !== "jupiter-aggregator" && body.venue !== "jupiter") throw refuse("venue_unexpected", `Sato Hub chose ${body.venue ?? "no venue"}; this kit swaps on Solana through Jupiter only`);
  if (!Number.isInteger(body.sato_fee_bps)) throw refuse("fee_disclosure_missing", "Sato Hub's quote does not state its fee");
  return { feeBps: body.sato_fee_bps, disclosure: body.disclosure ?? null, route_id: body.route_id ?? null, receipt_url: body.receipt_url ?? null };
}

/**
 * Plan and verify a swap on either chain. Returns { sized, display, execute }:
 * `display` is safe to print (and to show the owner); `execute()` signs under the
 * ledger contract. Throws Refused / PlanStale / Error before anything is signed.
 */
export async function prepareSwap(req, deps = {}) {
  const sized = await sizeSwap(req, deps);

  if (sized.chain === "base") {
    const plan = await (deps.planAndVerifyBaseSwap ?? evm.planAndVerifyBaseSwap)({ from: sized.from, to: sized.to, amount: sized.amount, slippageBps: sized.slippageBps }, { usdNotional: sized.usd, ...(deps.baseDeps ?? {}) });
    const s = evm.summarizeBaseSwapPlan(plan);
    const deviation = checkAgainstOracle(sized, impliedPrice(sized, Number(s.sell.amount), Number(s.buy.quoted)));
    return {
      sized,
      display: { chain: "base", ...s, usd_held_to_limits: Math.max(sized.usd, plan.usd), oracle: { usd: sized.oracle.usd, source: sized.oracle.source, age_s: sized.oracle.age_s, deviation_pct: deviation } },
      execute: () => evm.executeBaseSwap(plan, { usdNotional: sized.usd, ...(deps.baseDeps ?? {}) }),
    };
  }

  const fee = await satoSolanaDisclosure(sized, deps);
  const planOnce = () => (deps.planSolanaSwap ?? sol.planSolanaSwap)({ from: sized.from, to: sized.to, amount: sized.amount, slippageBps: sized.slippageBps }, { satoFeeBps: fee.feeBps, ...(deps.solDeps ?? {}) });
  // The bound the transaction is held to: the owner's slippage and the fee Sato Hub disclosed, never the plan's own values.
  const intentFor = (p) => ({ agent: p.agent, from: p.from, to: p.to, amount_in: p.amount_in, slippage_bps: sized.slippageBps, fee_bps: fee.feeBps });
  let plan = await planOnce();
  const verification = await (deps.verifySolanaSwapPlan ?? sol.verifySolanaSwapPlan)(plan, intentFor(plan), deps.solDeps ?? {});
  const outUnits = Number(plan.quote.out_amount);
  const outNum = outUnits / 10 ** ASSETS.solana[sized.to].decimals;
  const deviation = checkAgainstOracle(sized, impliedPrice(sized, sized.amountNum, outNum));
  const display = {
    chain: "solana",
    venue: "jupiter",
    sell: { asset: sized.from, amount: sized.amount },
    buy: {
      asset: sized.to,
      quoted: String(outNum),
      minimum: String(Number(plan.quote.min_out) / 10 ** ASSETS.solana[sized.to].decimals),
      minimum_in_transaction: verification.jupiter?.enforced_min_out ? String(Number(verification.jupiter.enforced_min_out) / 10 ** ASSETS.solana[sized.to].decimals) : null,
      slippage_bps: sized.slippageBps,
    },
    usd_held_to_limits: sized.usd,
    sato_fee: { bps: fee.feeBps, disclosure: fee.disclosure, route_id: fee.route_id, receipt_url: fee.receipt_url },
    disclosure: plan.disclosure,
    simulation: verification.simulated,
    oracle: { usd: sized.oracle.usd, source: sized.oracle.source, age_s: sized.oracle.age_s, deviation_pct: deviation },
  };
  return {
    sized,
    display,
    execute: async () => {
      // A Solana transaction lives ~60 s; if approval or display took too long, rebuild and re-verify before signing.
      try {
        return await (deps.executeSolanaSwap ?? sol.executeSolanaSwap)(plan, { ...(deps.solDeps ?? {}), usdNotional: sized.usd, intent: intentFor(plan) });
      } catch (err) {
        if (!(err instanceof sol.PlanStale)) throw err;
        // Rebuilt from scratch and held to every check again, with a fresh independent price.
        plan = await planOnce();
        await (deps.verifySolanaSwapPlan ?? sol.verifySolanaSwapPlan)(plan, intentFor(plan), deps.solDeps ?? {});
        const fresh = await freshOracle(sized, deps);
        const decimals = ASSETS.solana[sized.to].decimals;
        checkAgainstOracle(fresh, impliedPrice(fresh, sized.amountNum, Number(plan.quote.out_amount) / 10 ** decimals));
        const result = await (deps.executeSolanaSwap ?? sol.executeSolanaSwap)(plan, { ...(deps.solDeps ?? {}), usdNotional: sized.usd, intent: intentFor(plan) });
        // The owner saw the first quote; say plainly that this one replaced it.
        return { ...result, rebuilt: { quoted: String(Number(plan.quote.out_amount) / 10 ** decimals), minimum: String(Number(plan.quote.min_out) / 10 ** decimals), note: "the first quote expired before signing; the kit rebuilt it and checked it again" } };
      }
    },
  };
}
