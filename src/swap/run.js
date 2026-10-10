// One swap, end to end, on either chain: the order every check runs in, so the
// CLI stays small and the two chains cannot drift apart.
//
//   1. the owner's choices: chain, swaps turned on, slippage cap, trades per 24h
//   2. what is being traded, read FROM THE CHAIN: USDC, ETH, WETH, SOL, or any other
//      token by its Base address or Solana mint (decimals and token program come from
//      the chain, never from Sato Hub's resolver or from a link). One side must be the
//      chain's major asset; a token for a token is refused.
//   3. an INDEPENDENT price (Chainlink on Base, for ETH and for SOL). No price, no
//      swap: the kit never values a trade from the quote it is about to sign.
//      The USD figure held to the limits is the major leg:
//        USDC sold      the amount
//        ETH / SOL sold the amount x the Chainlink price
//        a token sold   unknown until the quote (there is no independent token price);
//                       sized from the major leg it returns (USDC, or ETH / SOL x the
//                       Chainlink price) and the limits are checked AGAIN before any
//                       approval of the quote or any signing
//   4. the quote and the unsigned transaction (Sato Hub on Base; Jupiter on
//      Solana with Sato's signed fee disclosure), then the chain module's own
//      verification and simulation (pinned contracts/programs, balance deltas)
//   5. USDC <-> ETH and USDC <-> SOL: the quote's implied price must sit near the oracle
//      price (ORACLE_TOLERANCE_PCT), or nothing is signed. A token pair has no independent
//      price, so this check does not apply; the market figures are shown instead.
//   6. slippage: the owner's flag, else the owner's cap, else a default picked for the
//      trade (50 bps between majors, 150 bps with a token, plus a Solana token's own
//      transfer fee), never above the kit's 500 bps
//   7. the trade stops for the owner's approval, even in auto mode, when it is unusual
//      (CONFIRM below): high slippage, a large price impact or value gap, a poor
//      sell-back test, or a token whose issuer holds a power over it
//   8. execute under the ledger/lock/exit-code contract (in the chain modules)
//
// Steps 1-7 run for a dry run too; a dry run stops there.

import { address as solAddress } from "@solana/kit";
import { erc20Abi } from "viem";
import { evaluate, loadPolicy } from "../policy.js";
import { spentLast24h } from "../ledger.js";
import { NeedsApproval, Refused } from "../errors.js";
import { consumeApproval, requestApproval } from "../approvals.js";
import { oraclePrice, quoteWithinOracle, ORACLE_TOLERANCE_PCT, PriceUnavailable } from "../price.js";
import { callTool, looksLikeLink, resolveTokenViaHub, runCheck } from "../satohub.js";
import { verifyHubSignature } from "../hub-signature.js";
import { addresses } from "../wallet.js";
import { usdcUnits, roundUsd } from "../amount.js";
import { clean, cleanBody } from "../text.js";
import { clients as baseClients } from "../base.js";
import * as evm from "./evm.js";
import * as sol from "./solana.js";
import { rpc as solanaRpc } from "../solana.js";

const refuse = (rule, message, limit = null, observed = null) => new Refused([{ rule, limit, observed, message }]);
const DISCLOSURE_MAX_AGE_MS = 120_000;

/** When a trade stops for the owner's approval even in auto mode. Whole basis points, except the Base value gap (percent). */
export const CONFIRM = Object.freeze({ slippageBps: 300, priceImpactBps: 300, valueGapPct: 3, sellBackLossBps: 300 });
/** The most slippage the kit ever signs (also the most an owner's cap can be). */
export const SLIPPAGE_HARD_CAP_BPS = 500;
/** The slippage picked per trade when neither the owner's flag nor the owner's cap says: between majors, and with a token. */
export const DEFAULT_SLIPPAGE_BPS = Object.freeze({ majors: 50, token: 150 });

const MAJORS = {
  base: { USDC: { decimals: 6 }, ETH: { decimals: 18, oracle: "ETH" }, WETH: { decimals: 18, oracle: "ETH" } },
  solana: { USDC: { decimals: 6 }, SOL: { decimals: 9, oracle: "SOL" } },
};
/** Symbols a token must not be shown under without its address: a scam token can call itself USDC. */
/** A long-tail token is always shown with its short address ("PEPE 0x6982…1933", "DezX…B263"): its symbol is whatever its creator wrote. */
export const shortBaseAddress = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
export const shortMint = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
const isBaseAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isSolanaMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** A plain positive decimal with at most `decimals` places, as base units. Never rounded. */
function toUnits(amount, decimals, label) {
  const s = String(amount);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals || !(Number(s) > 0)) throw new Error(`not a ${label} amount: "${amount}" (a plain positive number with at most ${decimals} decimals)`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}
const unitsToText = (units, decimals) => sol.formatUnits(units, decimals);

// ---------------------------------------------------------------- what is being traded

/**
 * A link is turned into a token by Sato Hub's resolver and nothing else (the kit never parses one itself).
 * An address or mint passes through. Returns { input, hub } where `hub` is Sato Hub's answer for a link.
 */
async function inputToAddress(chain, raw, deps) {
  const input = String(raw ?? "").trim();
  if (!looksLikeLink(input)) return { input, hub: null };
  // The same signature check as Sato Hub's fee disclosure (two minutes old at most). A link decides WHICH token is traded, so an
  // answer that cannot be shown to come from Sato Hub is not followed; the owner sends the contract address instead.
  const res = await (deps.resolveHub ?? resolveTokenViaHub)(input, { chain, verifySignature: deps.verifySignature, maxAgeMs: DISCLOSURE_MAX_AGE_MS });
  if (res.ok && res.signature?.ok !== true) {
    throw refuse("resolver_unsigned", `Sato Hub's answer for this link could not be shown to be signed by Sato Hub (${clean(res.signature?.error ?? "no signature", 160)}); send the contract address instead`);
  }
  if (!res.ok) {
    throw new Error(
      res.reason === "not_resolved"
        ? `Sato Hub could not resolve this link (${clean(res.error, 200)}); send the contract address instead`
        : "Sato Hub could not resolve this link right now; send the contract address instead",
    );
  }
  if (res.token.chain !== chain) throw new Error(`that link is for ${res.token.chain}, but --chain is ${chain}`);
  return { input: res.token.address, hub: res.token };
}

/**
 * One side of a swap, read from the chain. Returns
 *   { kind: "major" | "token", symbol (the label shown), id (address or mint), decimals, oracle, arg (what the chain module is
 *     given), info (the module's own resolution), hub (Sato Hub's hint for a link, or null), disagreements }
 */
async function resolveAsset(chain, raw, deps, label) {
  const { input, hub } = await inputToAddress(chain, raw, deps);
  const generic = () =>
    new Error(
      chain === "base"
        ? `${label}: on base the kit swaps USDC, ETH, WETH, or a token by its 0x contract address (or a link); "${clean(raw, 60)}" is none of those`
        : `${label}: on solana the kit swaps USDC, SOL, or a token by its mint address (or a link); "${clean(raw, 60)}" is none of those`,
    );
  let asset;
  try {
    if (chain === "base") {
      const t = await (deps.resolveBaseToken ?? evm.resolveBaseToken)(input, deps.baseDeps ?? {});
      const short = shortBaseAddress(t.address);
      const shown = t.major ? t.symbol : t.symbol === short ? short : `${t.symbol} ${short}`;
      asset = { kind: t.major ? "major" : "token", symbol: shown, id: t.address, decimals: t.decimals, oracle: t.major ? MAJORS.base[t.symbol]?.oracle : undefined, arg: t, name: t.name ?? null, info: t };
    } else {
      const t = await (deps.resolveSolanaToken ?? sol.resolveSolanaToken)(input, deps.solDeps ?? {});
      (deps.assertSolanaTokenTradable ?? sol.assertSolanaTokenTradable)(t);
      asset = { kind: t.major ? "major" : "token", symbol: t.major ?? shortMint(t.mint), id: t.mint, decimals: t.decimals, oracle: t.major ? MAJORS.solana[t.major]?.oracle : undefined, arg: t.major ?? t.mint, name: null, info: t };
    }
  } catch (err) {
    if (err instanceof Refused) throw err;
    const looksRight = chain === "base" ? isBaseAddress(input) : isSolanaMint(input);
    if (!looksRight && !(input.toUpperCase() in MAJORS[chain])) throw generic();
    throw new Error(`${label}: ${err.message}`);
  }
  asset.hub = hub;
  asset.disagreements = hub ? compareHubWithChain(chain, hub, asset.info) : [];
  return asset;
}

/**
 * Where Sato Hub's resolver and the chain disagree, in plain words. The chain wins: the swap and the card use the
 * chain's decimals, program and authorities. Sato Hub's name, price and liquidity are only ever shown, never relied on.
 */
export function compareHubWithChain(chain, hub, info) {
  const out = [];
  if (!hub || !info) return out;
  if (Number.isInteger(hub.decimals) && Number.isInteger(info.decimals) && hub.decimals !== info.decimals) {
    out.push(`Sato Hub says ${hub.decimals} decimals; the chain says ${info.decimals}. The chain's value is used.`);
  }
  if (chain === "solana") {
    const names = { spl: "Token", "token-2022": "Token-2022" };
    if (hub.program && names[hub.program] && info.program_name && names[hub.program] !== info.program_name) {
      out.push(`Sato Hub says the ${names[hub.program]} program; the chain says ${info.program_name}. The chain's value is used.`);
    }
    for (const [field, label] of [["mint_authority", "mint authority"], ["freeze_authority", "freeze authority"]]) {
      if (hub[field] === undefined || hub[field] === null || typeof hub[field] !== "object") continue;
      const hubHolds = hub[field].set ? hub[field].address ?? "someone" : null;
      const chainHolds = info[field] ?? null;
      if ((hubHolds === null) !== (chainHolds === null) || (hubHolds && chainHolds && hubHolds !== "someone" && hubHolds !== chainHolds)) {
        out.push(`Sato Hub says the ${label} is ${hubHolds ? `set (${hubHolds})` : "revoked"}; the chain says ${chainHolds ? `set (${chainHolds})` : "revoked"}. The chain's value is used.`);
      }
    }
    if (Array.isArray(hub.token2022_extensions) && Array.isArray(info.extensions)) {
      const a = [...hub.token2022_extensions].sort().join(",");
      const b = [...info.extensions].sort().join(",");
      if (a !== b) out.push(`Sato Hub lists the Token-2022 extensions ${hub.token2022_extensions.length ? hub.token2022_extensions.join(", ") : "none"}; the chain lists ${info.extensions.length ? info.extensions.join(", ") : "none"}. The chain's list is used.`);
    }
  }
  return out;
}

/** The wallet's whole balance of a token, read from the chain (base units). */
async function defaultTokenBalance(chain, asset, deps) {
  const a = addresses();
  if (chain === "base") {
    const pub = (deps.baseDeps?.c ?? baseClients()).pub;
    return BigInt(await withTimeout(pub.readContract({ address: asset.id, abi: erc20Abi, functionName: "balanceOf", args: [a.base] })));
  }
  const r = deps.solDeps?.rpc ?? solanaRpc();
  const res = await withTimeout(r.getTokenAccountsByOwner(solAddress(a.solana), { mint: solAddress(asset.id) }, { encoding: "jsonParsed" }).send());
  return res.value.reduce((s, x) => s + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}

// ---------------------------------------------------------------- slippage and the reasons to stop and ask

/** The slippage for this trade and why: the owner's flag, else the owner's cap, else a default picked for the trade. */
export function chooseSlippage({ flag, cap, longTail, tokenFeeBps = 0 }) {
  const validate = (bps, what) => {
    if (!Number.isInteger(bps) || bps < 1 || bps > SLIPPAGE_HARD_CAP_BPS) throw new Error(`${what} must be a whole number of basis points from 1 to ${SLIPPAGE_HARD_CAP_BPS} (got ${bps})`);
    return bps;
  };
  if (flag !== undefined && flag !== null) return { bps: validate(flag, "--slippage-bps"), source: "owner", default_bps: null };
  const base = longTail ? DEFAULT_SLIPPAGE_BPS.token + (Number.isInteger(tokenFeeBps) ? tokenFeeBps : 0) : DEFAULT_SLIPPAGE_BPS.majors;
  const def = Math.min(base, SLIPPAGE_HARD_CAP_BPS);
  if (Number.isInteger(cap) && cap < def) return { bps: cap, source: "owner_cap", default_bps: def };
  return { bps: def, source: "default", default_bps: def, ...(longTail && tokenFeeBps ? { includes_transfer_fee_bps: tokenFeeBps } : {}) };
}

const reason = (code, text) => ({ code, text });

/**
 * A reason read from a quote carries the band the owner saw, rounded UP to the next whole
 * percent ("…_upto_5pct" for 4.2%). The code is what the approval binds, so a re-quote in
 * the same band still matches, and a worse one (or a different one) needs a new approval:
 * approving a 4% price impact never approves a 40% one.
 */
const band = (pct) => `upto_${Math.max(1, Math.ceil(Number(pct) - 1e-9))}pct`;

/** The reasons known before any quote: the slippage, and a Solana token's issuer powers. */
function preConfirm(sized) {
  const out = [];
  if (sized.slippageBps > CONFIRM.slippageBps) out.push(reason("slippage_over_300_bps", `the slippage is ${sized.slippageBps} bps, above ${CONFIRM.slippageBps} bps`));
  // A Solana token's powers over the agent's tokens (src/swap/solana.js `confirm`). An extension is `issuer_power_<name>`; the other
  // powers (a freeze authority, pausable transfers, a transfer fee above 300 bps) carry their own code, the fee in a band.
  // None of these depends on the slippage, so an owner's cap does not silence them.
  for (const c of sized.tail?.info?.confirm ?? []) out.push(reason(c.code ?? `issuer_power_${c.extension}`, c.code ? `the token: ${c.why}` : `the token has the Token-2022 ${c.extension} extension: ${c.why}`));
  return out;
}

/** Base reasons from a verified plan: the route's value gap (it includes pool fees, Sato's fee and gas), and the sell-back test. */
function baseConfirm(plan) {
  const out = [];
  const m = plan.market;
  // Fail closed: on a trade with a token, an answer with no market figure at all leaves nothing to judge the price by, so the owner decides.
  if (plan.long_tail && (!m || (typeof m.price_impact_pct !== "number" && typeof m.value_gap_pct !== "number"))) {
    out.push(reason("no_market_figure", "the quote gave no USD figures, so price impact can't be checked"));
  }
  if (m && typeof m.price_impact_pct === "number" && m.price_impact_pct > CONFIRM.priceImpactBps / 100) out.push(reason(`price_impact_over_300_bps_${band(m.price_impact_pct)}`, `the route's own price impact is ${m.price_impact_pct}%, above ${CONFIRM.priceImpactBps / 100}%`));
  if (m && typeof m.value_gap_pct === "number" && m.value_gap_pct > CONFIRM.valueGapPct) {
    out.push(reason(`value_gap_over_3_pct_${band(m.value_gap_pct)}`, `the route values what you get ${m.value_gap_pct}% below what you give (a value gap that includes pool fees, Sato's fee and gas), above ${CONFIRM.valueGapPct}%`));
  }
  if (plan.sell_back && plan.sell_back.loss_bps > CONFIRM.sellBackLossBps) {
    out.push(reason(`sell_back_loss_over_300_bps_${band(plan.sell_back.loss_bps / 100)}`, `buying this token and selling it straight back (simulated) loses ${plan.sell_back.loss_bps / 100}%, above ${CONFIRM.sellBackLossBps / 100}%`));
  }
  return out;
}

/** Solana reason from a plan: Jupiter's price impact. */
function solanaConfirm(plan) {
  const bps = plan.quote?.price_impact_bps;
  return typeof bps === "number" && bps > CONFIRM.priceImpactBps ? [reason(`price_impact_over_300_bps_${band(bps / 100)}`, `Jupiter estimates this swap moves the price by ${bps / 100}%, above ${CONFIRM.priceImpactBps / 100}%`)] : [];
}

const merge = (...lists) => {
  const seen = new Set();
  return lists.flat().filter((r) => !seen.has(r.code) && seen.add(r.code));
};

// ---------------------------------------------------------------- size

/** Validate the request against the owner's choices and size it in USD from an independent price (where one exists). */
export async function sizeSwap({ chain, from, to, amount, slippageBps }, deps = {}) {
  const table = MAJORS[chain];
  if (!table) throw new Error("--chain must be base or solana");
  const policy = deps.policy ?? loadPolicy();

  // Cheap refusals first (chain, swaps on, trade count, a slippage the owner's cap forbids): nothing is read from a chain for a swap the owner hasn't allowed.
  const first = evaluate(policy, { usd: 0.000001, chain, kind: "swap", slippage_bps: slippageBps }, spentLast24h());
  if (first.length) throw new Refused(first);

  const fromAsset = await resolveAsset(chain, from, deps, "--from");
  const toAsset = await resolveAsset(chain, to, deps, "--to");
  if (fromAsset.id === toAsset.id) throw new Error("--from and --to are the same asset");
  const tailIn = fromAsset.kind === "token";
  const tailOut = toAsset.kind === "token";
  if (tailIn && tailOut) throw refuse("token_to_token", `one side of a swap must be ${chain === "base" ? "USDC, ETH or WETH" : "USDC or SOL"}; swapping one token straight for another is not supported yet`);
  const longTail = tailIn ? "in" : tailOut ? "out" : null;
  if (!longTail && fromAsset.symbol !== "USDC" && toAsset.symbol !== "USDC") throw new Error("one side of a swap must be USDC (this version)");
  const tail = tailIn ? fromAsset : tailOut ? toAsset : null;

  // The amount: a number, or `all` for the whole balance of a token being sold (read from the chain).
  let amountText = String(amount);
  let amountIsAll = false;
  if (/^all$/i.test(amountText)) {
    if (!tailIn) throw new Error("--amount all sells the whole balance of a token; for USDC, ETH, WETH or SOL give an amount");
    let units;
    try {
      units = await (deps.tokenBalance ?? defaultTokenBalance)(chain, fromAsset, deps);
    } catch (err) {
      throw new Error(`could not read the wallet's ${fromAsset.symbol} balance (${clean(err.message, 160)}); give an amount instead`);
    }
    if (!(units > 0n)) throw refuse("no_balance", `the wallet holds none of ${fromAsset.symbol}, so there is nothing to sell`);
    amountText = unitsToText(units, fromAsset.decimals);
    amountIsAll = true;
  }
  toUnits(amountText, fromAsset.decimals, fromAsset.symbol); // refuses malformed amounts before anything else
  const amountNum = Number(amountText);

  const tokenFeeBps = tail?.info?.transfer_fee?.bps ?? 0;
  const slippage = chooseSlippage({ flag: slippageBps, cap: policy?.max_slippage_bps, longTail: Boolean(longTail), tokenFeeBps });

  // The USD value held to the limits, from the major leg, before any quote. A token sold has none yet.
  const oracleAsset = fromAsset.oracle ?? toAsset.oracle ?? null; // the volatile major (ETH or SOL), if one is traded
  let oracle = null;
  if (oracleAsset) {
    try {
      oracle = await (deps.oraclePrice ?? oraclePrice)(oracleAsset);
    } catch (err) {
      if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent ${oracleAsset} price right now (${err.message}); the kit does not swap without one`);
      throw err;
    }
  }
  let usd = null;
  let usdBasis = "after_quote";
  if (!tailIn) {
    usd = roundUsd(fromAsset.symbol === "USDC" ? amountNum : amountNum * oracle.usd);
    usdBasis = fromAsset.symbol === "USDC" ? "usdc_amount" : "oracle";
  }

  // The owner's caps, before anything is quoted (the reservation re-checks under the lock).
  const early = evaluate(policy, { usd: usd ?? 0.000001, chain, kind: "swap", slippage_bps: slippage.bps }, spentLast24h());
  if (early.length) throw new Refused(early);

  const sized = {
    chain,
    from: fromAsset.symbol,
    to: toAsset.symbol,
    fromAsset,
    toAsset,
    amount: amountText,
    amountIsAll,
    amountNum,
    slippageBps: slippage.bps,
    slippage,
    usd,
    usdBasis,
    oracle,
    volatile: oracleAsset,
    longTail,
    tail,
    // A link names the token only through Sato Hub: say which address it became, so the owner sees what is really traded.
    resolvedFromLink: [fromAsset, toAsset].filter((a) => a.hub).map((a) => ({ symbol: a.symbol, address: a.id, chain })),
    notes: [
      ...[fromAsset, toAsset].filter((a) => a.hub).map((a) => `The link resolved to ${a.id} on ${chain === "base" ? "Base" : "Solana"} (Sato Hub's signed answer); the chain was read for that address, not the link.`),
      ...fromAsset.disagreements,
      ...toAsset.disagreements,
    ],
  };
  sized.confirm = preConfirm(sized);
  return sized;
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

/** The oracle block of a display: a major pair is checked against it; a token pair only uses it to size the ETH / SOL leg. */
function oracleDisplay(sized, deviation) {
  if (!sized.oracle) return null;
  return { asset: sized.volatile, usd: sized.oracle.usd, source: sized.oracle.source, age_s: sized.oracle.age_s, deviation_pct: deviation ?? null, ...(sized.longTail ? { used_for: `sizing the ${sized.volatile} leg only; there is no independent price for the token` } : {}) };
}

/**
 * A token sale has no USD figure until there is a quote, and Sato Hub's quote writes a public record. So the sale is sized first from
 * the venue's PUBLIC quote (KyberSwap on Base, Jupiter on Solana: no record): if the major leg it returns already exceeds what the
 * owner's per-transaction or remaining 24-hour limit allows, it is refused before Sato Hub is asked. Advisory: a venue with no
 * answer skips this, and the figure from Sato Hub's own quote is sized and checked again after it (the real check).
 */
async function presizeTokenSale(sized, deps) {
  if (sized.longTail !== "in") return;
  let out = null;
  try {
    if (deps.publicQuote) out = await deps.publicQuote(sized);
    else if (sized.chain === "base") out = await evm.kyberPublicOut({ tokenIn: sized.fromAsset.arg, tokenOut: sized.toAsset.arg, amountIn: toUnits(sized.amount, sized.fromAsset.decimals, sized.from) }, deps.baseDeps ?? {});
    else out = await sol.publicQuoteOut({ inputMint: sized.fromAsset.id, outputMint: sized.toAsset.id, units: toUnits(sized.amount, sized.fromAsset.decimals, sized.from), slippageBps: sized.slippageBps }, deps.solDeps ?? {});
  } catch {
    out = null;
  }
  if (out === null || out === undefined) return;
  const whole = Number(out) / 10 ** sized.toAsset.decimals;
  const usd = roundUsd(sized.toAsset.symbol === "USDC" ? whole : whole * (sized.oracle?.usd ?? NaN));
  if (!(usd > 0)) return;
  recheckLimits(sized, usd, deps);
}

/** Re-check the owner's caps once the size is known from the quote. Throws Refused. */
function recheckLimits(sized, usd, deps) {
  const policy = deps.policy ?? loadPolicy();
  const late = evaluate(policy, { usd, chain: sized.chain, kind: "swap", slippage_bps: sized.slippageBps }, spentLast24h());
  if (late.length) throw new Refused(late);
}

// ---------------------------------------------------------------- Solana: Sato's fee disclosure

const solUnits = (asset, amount) => (asset.arg === "USDC" ? usdcUnits(amount) : asset.arg === "SOL" ? sol.solLamports(amount) : sol.tokenUnits(amount, asset.decimals, asset.symbol));

/** Sato Hub's signed fee disclosure for a Solana swap (Sato quotes; the kit builds through Jupiter). */
async function satoSolanaDisclosure(sized, deps) {
  const a = addresses();
  const tokenIn = sized.fromAsset.id;
  const tokenOut = sized.toAsset.id;
  const amountIn = solUnits(sized.fromAsset, sized.amount).toString();
  const r = await (deps.callTool ?? callTool)("onchain_agent_swap", {
    mode: "recommend",
    chain_in: "Solana",
    chain_out: "Solana",
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    taker: a.solana,
    slippage_bps: sized.slippageBps,
    // A token sold has no USD figure before the quote: none is sent, rather than a made-up one.
    ...(sized.usd !== null ? { usd_notional: sized.usd } : {}),
    // Jupiter only: the kit builds through Jupiter, so the fee disclosure must be Jupiter's.
    venue: "jupiter-aggregator",
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
    body.token_in !== tokenIn && "token_in",
    body.token_out !== tokenOut && "token_out",
    String(body.amount_in) !== amountIn && "amount_in",
  ].filter(Boolean);
  if (mismatch.length) throw refuse("response_mismatch", `Sato Hub's signed quote is about a different swap (${mismatch.join(", ")} differ); nothing was signed`);
  if (body.venue !== "jupiter-aggregator" && body.venue !== "jupiter") throw refuse("venue_unexpected", `Sato Hub chose ${body.venue ?? "no venue"}; this kit swaps on Solana through Jupiter only`);
  if (!Number.isInteger(body.sato_fee_bps)) throw refuse("fee_disclosure_missing", "Sato Hub's quote does not state its fee");
  // Where the fee is taken: the major side, never the token. A Sato Hub that says otherwise is not followed; one that is silent is
  // read as the side the kit pins (the kit's own fee accounts are USDC and wrapped SOL only, so the fee can land nowhere else).
  const wantSide = sized.fromAsset.kind === "major" ? "in" : "out";
  const majorAsset = sized.fromAsset.kind === "major" ? sized.fromAsset : sized.toAsset;
  if (body.sato_fee_side !== undefined && body.sato_fee_side !== null && body.sato_fee_side !== wantSide) {
    throw refuse("fee_side_mismatch", `Sato Hub's signed quote puts its fee on the ${body.sato_fee_side === "out" ? "output" : "input"} leg; for this swap the kit takes it on the ${wantSide === "out" ? "output" : "input"} leg (the ${majorAsset.symbol} side); nothing was signed`);
  }
  if (typeof body.sato_fee_token === "string" && body.sato_fee_token !== majorAsset.id && body.sato_fee_token.toUpperCase() !== majorAsset.symbol) {
    throw refuse("fee_side_mismatch", `Sato Hub's signed quote takes its fee in ${clean(body.sato_fee_token, 60)}; the kit only accepts it in ${majorAsset.symbol}; nothing was signed`);
  }
  return { feeBps: body.sato_fee_bps, disclosure: body.disclosure ?? null, route_id: body.route_id ?? null, receipt_url: body.receipt_url ?? null, side: body.sato_fee_side ?? null };
}

// ---------------------------------------------------------------- prepare

/** The approval intent: what the owner approves, exactly. Binds the chain, both tokens, the amount, the slippage and the reasons. */
export function swapIntent(sized, reasonCodes = [], { skipCheck = false } = {}) {
  return {
    cmd: "swap",
    chain: sized.chain,
    from: sized.from,
    to: sized.to,
    from_id: sized.fromAsset.id,
    to_id: sized.toAsset.id,
    amount: sized.amount,
    slippage_bps: sized.slippageBps,
    confirm_reasons: [...reasonCodes].sort(),
    price: sized.longTail
      ? "no independent price exists for the token: its USD size comes from the quote, is held to your limits before anything is signed, and the minimum out is set by the slippage"
      : "the quote must sit within the oracle tolerance; the minimum out is set by the slippage",
    skip_check: Boolean(skipCheck),
  };
}

/**
 * Plan and verify a swap on either chain. Returns { sized, display, confirm, execute }:
 * `display` is safe to print (and to show the owner); `confirm` is the list of reasons the owner must approve this trade
 * (empty = none); `execute()` signs under the ledger contract. Throws Refused / PlanStale / Error before anything is signed.
 * `deps.sized` reuses a sizing already done by the caller.
 */
export async function prepareSwap(req, deps = {}) {
  const sized = deps.sized ?? (await sizeSwap(req, deps));
  return sized.chain === "base" ? prepareBase(sized, deps) : prepareSolana(sized, deps);
}

async function prepareBase(sized, deps) {
  const baseDeps = deps.baseDeps ?? {};
  await presizeTokenSale(sized, deps); // before Sato Hub is asked: its quote writes a public record
  const plan = await (deps.planAndVerifyBaseSwap ?? evm.planAndVerifyBaseSwap)(
    { from: sized.fromAsset.arg, to: sized.toAsset.arg, amount: sized.amount, slippageBps: sized.slippageBps },
    // A token sale has no USD figure before the quote; nothing made up is sent to Sato Hub.
    { ...(sized.usd !== null ? { usdNotional: sized.usd } : { usdFromQuote: true }), ...baseDeps },
  );
  const s = evm.summarizeBaseSwapPlan(plan);

  // What the trade is worth, from the major leg.
  let held;
  let basis = sized.usdBasis;
  if (sized.longTail === "in") {
    if (sized.toAsset.symbol === "USDC") {
      held = plan.usd; // the USDC the simulation measured coming back (fee included)
      basis = "usdc_received";
    } else {
      const eth = Number(evm.unitsToDecimal(plan.major_leg?.units ?? 0n, sized.toAsset.decimals));
      held = Math.max(plan.usd ?? 0, eth * sized.oracle.usd);
      basis = "oracle_on_received";
    }
    held = roundUsd(held);
    if (!(held > 0)) throw refuse("usd_unknown", "the quote did not show what the major leg of this sale is worth, so it cannot be held to your limits; nothing was signed");
  } else {
    held = Math.max(sized.usd, plan.usd);
  }
  if (sized.longTail) recheckLimits(sized, held, deps);

  // A major pair is held to the independent price; a token has none.
  const deviation = sized.longTail ? null : checkAgainstOracle(sized, impliedPrice(sized, Number(s.sell.amount), Number(s.buy.quoted)));
  const confirm = merge(sized.confirm, baseConfirm(plan));
  return {
    sized,
    confirm,
    display: {
      ...s,
      chain: "base",
      slippage: sized.slippage,
      usd_held_to_limits: held,
      usd_basis: basis,
      oracle: oracleDisplay(sized, deviation),
      confirm_reasons: confirm,
      notes: sized.notes,
      resolved_from_link: sized.resolvedFromLink,
    },
    execute: () => (deps.executeBaseSwap ?? evm.executeBaseSwap)(plan, { ...baseDeps, usdNotional: held }),
  };
}

const solDecimals = (plan, side, sized) => plan.tokens?.[side]?.decimals ?? (side === "in" ? sized.fromAsset : sized.toAsset).decimals;

/** What a token sale returns, in USD, from the major leg (the fee comes out of the output, so it is added back). */
function majorOutUsd(plan, sized, oracleUsd) {
  const out = BigInt(plan.quote.out_amount) + (plan.fee?.leg === "output" ? BigInt(plan.fee.max_units ?? 0) : 0n);
  const whole = Number(out) / 10 ** solDecimals(plan, "out", sized);
  return roundUsd(sized.toAsset.symbol === "USDC" ? whole : whole * oracleUsd);
}

async function prepareSolana(sized, deps) {
  await presizeTokenSale(sized, deps); // before Sato Hub is asked: its quote writes a public record
  const fee = await satoSolanaDisclosure(sized, deps);
  const planOnce = () => (deps.planSolanaSwap ?? sol.planSolanaSwap)({ from: sized.fromAsset.arg, to: sized.toAsset.arg, amount: sized.amount, slippageBps: sized.slippageBps }, { satoFeeBps: fee.feeBps, ...(deps.solDeps ?? {}) });
  // The bound the transaction is held to: the owner's slippage and the fee Sato Hub disclosed, never the plan's own values.
  const intentFor = (p) => ({ agent: p.agent, from: p.from, to: p.to, amount_in: p.amount_in, slippage_bps: sized.slippageBps, fee_bps: fee.feeBps });
  let plan = await planOnce();
  const verification = await (deps.verifySolanaSwapPlan ?? sol.verifySolanaSwapPlan)(plan, intentFor(plan), deps.solDeps ?? {});
  const outDecimals = solDecimals(plan, "out", sized);
  const outNum = Number(plan.quote.out_amount) / 10 ** outDecimals;

  let held = sized.usd;
  let basis = sized.usdBasis;
  if (sized.longTail === "in") {
    held = majorOutUsd(plan, sized, sized.oracle?.usd);
    basis = sized.toAsset.symbol === "USDC" ? "usdc_received" : "oracle_on_received";
    if (!(held > 0)) throw refuse("usd_unknown", "the quote did not show what the major leg of this sale is worth, so it cannot be held to your limits; nothing was signed");
    recheckLimits(sized, held, deps);
  } else if (sized.longTail === "out") {
    recheckLimits(sized, held, deps);
  }
  const deviation = sized.longTail ? null : checkAgainstOracle(sized, impliedPrice(sized, sized.amountNum, outNum));
  const confirm = merge(sized.confirm, solanaConfirm(plan));
  const tail = sized.tail?.info ?? null;
  const display = {
    chain: "solana",
    venue: "jupiter",
    sell: { asset: sized.from, amount: sized.amount, ...(sized.fromAsset.kind === "token" ? { address: sized.fromAsset.id } : {}) },
    buy: {
      asset: sized.to,
      ...(sized.toAsset.kind === "token" ? { address: sized.toAsset.id } : {}),
      quoted: String(outNum),
      minimum: String(Number(plan.quote.min_out) / 10 ** outDecimals),
      minimum_in_transaction: verification.jupiter?.enforced_min_out ? String(Number(verification.jupiter.enforced_min_out) / 10 ** outDecimals) : null,
      slippage_bps: sized.slippageBps,
    },
    slippage: sized.slippage,
    usd_held_to_limits: held,
    usd_basis: basis,
    sato_fee: { bps: fee.feeBps, disclosure: fee.disclosure, route_id: fee.route_id, receipt_url: fee.receipt_url, side: fee.side ?? (plan.fee?.leg === "output" ? "out" : "in"), asset: plan.fee?.symbol ?? null },
    disclosure: plan.disclosure,
    simulation: verification.simulated,
    oracle: oracleDisplay(sized, deviation),
    market: sized.longTail ? { price_impact_bps: plan.quote.price_impact_bps ?? null, route_hops: plan.quote.route_hops ?? null, source: "Jupiter's quote" } : null,
    long_tail: tail ? { side: sized.longTail, role: sized.longTail === "out" ? "buying" : "selling", asset: sized.tail.symbol, address: tail.mint, program: tail.program_name, decimals: tail.decimals, mint_authority: tail.mint_authority, freeze_authority: tail.freeze_authority, extensions: tail.extensions, transfer_fee_bps: tail.transfer_fee?.bps ?? null } : null,
    confirm_reasons: confirm,
    notes: sized.notes,
    resolved_from_link: sized.resolvedFromLink,
  };
  // What arrived, in whole units of the output asset (the module reports base units).
  const withReceived = (r) => (r && typeof r.amount_out === "string" && !r.received ? { ...r, received: { asset: sized.to, amount: sol.formatUnits(r.amount_out, outDecimals) } } : r);
  return {
    sized,
    confirm,
    display,
    execute: async () => {
      // A Solana transaction lives ~60 s; if approval or display took too long, rebuild and re-verify before signing.
      try {
        return withReceived(await (deps.executeSolanaSwap ?? sol.executeSolanaSwap)(plan, { ...(deps.solDeps ?? {}), usdNotional: held, intent: intentFor(plan) }));
      } catch (err) {
        if (!(err instanceof sol.PlanStale)) throw err;
        // Rebuilt from scratch and held to every check again, with a fresh independent price.
        const firstMin = BigInt(plan.quote.min_out);
        plan = await planOnce();
        await (deps.verifySolanaSwapPlan ?? sol.verifySolanaSwapPlan)(plan, intentFor(plan), deps.solDeps ?? {});
        const decimals = solDecimals(plan, "out", sized);
        let usdNow = held;
        let fresh = sized;
        if (sized.volatile) fresh = await freshOracle(sized, deps);
        if (sized.longTail) {
          // No independent token price: the rebuilt quote may not be worse than the minimum the owner was shown, may not need an
          // approval the owner did not give, and is sized and held to the limits again.
          if (BigInt(plan.quote.out_amount) < firstMin) {
            throw refuse("quote_moved", `the first quote expired and the rebuilt one pays less than the minimum you were shown (${String(Number(plan.quote.out_amount) / 10 ** decimals)} against at least ${String(Number(firstMin) / 10 ** decimals)} ${sized.to}); nothing was signed`);
          }
          const added = solanaConfirm(plan).filter((r) => !confirm.some((c) => c.code === r.code));
          if (added.length) throw refuse("confirm_reasons_changed", `the first quote expired and the rebuilt one needs approval for a reason you were not shown (${added.map((r) => r.text).join("; ")}); nothing was signed`);
          if (sized.longTail === "in") {
            usdNow = Math.max(held, majorOutUsd(plan, sized, fresh.oracle?.usd));
            recheckLimits(sized, usdNow, deps);
          } else if (sized.fromAsset.oracle) {
            // SOL sold for a token: valued again at the new Chainlink price; the larger of the two readings counts against the limits.
            usdNow = Math.max(held, roundUsd(sized.amountNum * fresh.oracle.usd));
            recheckLimits(sized, usdNow, deps);
          }
        } else {
          checkAgainstOracle(fresh, impliedPrice(fresh, sized.amountNum, Number(plan.quote.out_amount) / 10 ** decimals));
          // SOL sold is valued again at the new price; the larger of the two readings counts against the limits.
          usdNow = sized.from === "USDC" ? sized.usd : Math.max(sized.usd, roundUsd(sized.amountNum * fresh.oracle.usd));
        }
        const result = await (deps.executeSolanaSwap ?? sol.executeSolanaSwap)(plan, { ...(deps.solDeps ?? {}), usdNotional: usdNow, intent: intentFor(plan) });
        // The owner saw the first quote; say plainly that this one replaced it.
        return { ...withReceived(result), rebuilt: { quoted: String(Number(plan.quote.out_amount) / 10 ** decimals), minimum: String(Number(plan.quote.min_out) / 10 ** decimals), note: "the first quote expired before signing; the kit rebuilt it and checked it again" } };
      }
    },
  };
}

// ---------------------------------------------------------------- the approval gate

/** A NeedsApproval that also says, in plain words, why a trade within the limits still needs the owner. */
async function needsApproval(intent, reasons) {
  const err = new NeedsApproval(intent, await requestApproval(intent));
  if (reasons.length) {
    err.reasons = reasons.map((r) => r.text);
    err.message = `This swap needs the owner's approval even though the agent acts within its limits, because:\n${reasons.map((r) => `  - ${r.text}`).join("\n")}\n${err.message}`;
  }
  return err;
}

/**
 * The whole path of a swap up to (not including) signing, with the owner's approval where it is due:
 *   1. size it and check the owner's choices;
 *   2. before any quote: the owner's approval in ask mode, and also in auto mode when a reason to ask is already known
 *      (high slippage, a token whose issuer holds a power over it);
 *   3. quote, verify and simulate it;
 *   4. after the quote: any reason that only the quote shows (price impact, value gap, a poor sell-back test) needs the owner's approval too,
 *      even in auto mode. That approval names the reasons, so the code only fits a trade with those reasons.
 * Throws NeedsApproval (exit 5) when the owner must approve, Refused (exit 3) when the caps or a check stop it.
 * `approve` is the code from `--approve`. A dry run asks nobody and spends nothing; it reports what would need approval.
 * Returns { sized, prepared, confirm } where prepared.execute() signs.
 */
export async function runSwap(req, { approve, dryRun = false, skipCheck = false } = {}, deps = {}) {
  const sized = await sizeSwap(req, deps);
  const policy = deps.policy ?? loadPolicy();
  const ask = policy?.approval === "ask";
  const before = sized.confirm;
  let codeFree = Boolean(approve); // an approval code this run has not used yet
  let deferred = null;
  let firstIntent = null;
  if (!dryRun && (ask || before.length)) {
    firstIntent = swapIntent(sized, before.map((r) => r.code), { skipCheck });
    if (!approve) throw await needsApproval(firstIntent, before);
    try {
      await consumeApproval(approve, firstIntent);
      codeFree = false;
    } catch (err) {
      // The code may be one given for the quote-time intent (reasons only the quote showed): look again after the quote.
      if (!/different intent/.test(err.message)) throw err;
      deferred = err;
    }
  }
  const prepared = await prepareSwap(req, { ...deps, sized });
  const added = prepared.confirm.filter((r) => !before.some((b) => b.code === r.code));
  if (!dryRun && added.length) {
    const intent = swapIntent(sized, prepared.confirm.map((r) => r.code), { skipCheck });
    if (!codeFree) throw await needsApproval(intent, prepared.confirm);
    try {
      await consumeApproval(approve, intent);
    } catch (err) {
      // The code was for what the owner saw before (another band: a worse price impact, a bigger loss).
      // Nothing is signed; the owner is asked again, with the figures this quote shows.
      if (!/different intent/.test(err.message)) throw err;
      throw await needsApproval(intent, prepared.confirm);
    }
  } else if (deferred) {
    // The code was given for reasons this quote no longer shows (the price impact improved, or went away), and the owner's approval
    // is still due for the trade as it stands now: ask again, cleanly, instead of failing on "different intent".
    throw await needsApproval(firstIntent, before);
  }
  return { sized, prepared, confirm: prepared.confirm };
}

// ---------------------------------------------------------------- display

/** The lines a swap is shown to the owner in (server text is cleaned by the caller). */
export function swapLines(d) {
  const lines = [];
  const chainName = d.chain === "base" ? "Base" : "Solana";
  lines.push(`${chainName} swap via ${d.venue}: sell ${d.sell.amount} ${d.sell.asset} for about ${d.buy.quoted} ${d.buy.asset} (at least ${d.buy.minimum}, slippage ${d.buy.slippage_bps} bps)`);
  if (d.slippage) {
    const why = { owner: "set by the owner for this trade", owner_cap: `the owner's cap, below the ${d.slippage.default_bps} bps this trade would otherwise get`, default: d.slippage.includes_transfer_fee_bps ? `picked for this trade: ${DEFAULT_SLIPPAGE_BPS.token} bps for a token plus its ${d.slippage.includes_transfer_fee_bps} bps transfer fee` : d.long_tail ? `picked for this trade: ${DEFAULT_SLIPPAGE_BPS.token} bps because a token is involved` : `picked for this trade: ${DEFAULT_SLIPPAGE_BPS.majors} bps between major assets` }[d.slippage.source];
    lines.push(`Slippage used: ${d.slippage.bps} bps (${why ?? d.slippage.source}). Add --slippage-bps <n> to choose another (at most ${SLIPPAGE_HARD_CAP_BPS}).`);
  }
  if (d.long_tail) {
    const t = d.long_tail;
    lines.push(`Token: ${t.role === "buying" ? "buying" : "selling"} ${t.asset} (${t.address}${t.decimals !== undefined ? `, ${t.decimals} decimals, ${t.program ?? "ERC-20"}` : ""}), read from the chain just now.`);
  }
  if (d.buy.minimum_in_transaction) lines.push(`The transaction itself refuses to pay less than ${d.buy.minimum_in_transaction} ${d.buy.asset} (written into it and checked by the kit).`);
  if (d.oracle && !d.oracle.used_for) lines.push(`Independent price: ${d.oracle.source} says $${d.oracle.usd} (${d.oracle.age_s}s old); the quote is ${d.oracle.deviation_pct}% from it.`);
  else if (d.oracle) lines.push(`Independent price of the ${d.oracle.asset} leg: ${d.oracle.source} says $${d.oracle.usd} (${d.oracle.age_s}s old). There is no independent price for the token, so the quote is not checked against one.`);
  else if (d.long_tail) lines.push("There is no independent price for the token, so the quote is not checked against one; the size below comes from the quote.");
  if (d.market) {
    const m = d.market;
    if (typeof m.price_impact_bps === "number") lines.push(`Price impact: Jupiter estimates ${m.price_impact_bps / 100}%${m.route_hops ? ` across ${m.route_hops} hop${m.route_hops === 1 ? "" : "s"}` : ""}. Shown for you to weigh.`);
    if (typeof m.value_gap_pct === "number") lines.push(`Value gap: the route values what you give at $${m.amount_in_usd} and what you get at $${m.amount_out_usd}, ${m.value_gap_pct}% apart (this includes pool fees, Sato Hub's fee and gas; it is not a pure price impact).`);
    if (typeof m.price_impact_pct === "number") lines.push(`Price impact reported by the route: ${m.price_impact_pct}%.`);
  }
  if (d.sell_back) lines.push(`Sell-back test (simulated only, nothing sent): buying and selling straight back returns ${d.sell_back.returned} ${d.sell_back.asset} for ${d.sell_back.asset === d.sell.asset ? d.sell.amount : "the amount sold"}, a loss of ${d.sell_back.loss_bps / 100}% (the kit allows up to ${d.sell_back.allowed_loss_bps / 100}%).`);
  const basis = { usdc_amount: "the USDC amount", oracle: "the Chainlink price of what you sell", usdc_received: "the USDC the quote returns for the token", oracle_on_received: "the Chainlink price of the ETH or SOL the quote returns" }[d.usd_basis];
  lines.push(`Held to your limits as $${d.usd_held_to_limits}${basis ? ` (from ${basis})` : ""}.`);
  lines.push(`Sato Hub fee: ${d.sato_fee.bps} bps${d.sato_fee.asset ? `, taken in ${d.sato_fee.asset}` : ""}. ${d.sato_fee.disclosure ?? ""}`.trim());
  if (d.approval) lines.push(`Approval first: exactly ${d.approval.amount} ${d.approval.token} to the pinned router ${d.approval.spender} (never unlimited).`);
  if (Array.isArray(d.disclosure)) lines.push(...d.disclosure);
  for (const n of d.notes ?? []) lines.push(n);
  lines.push(`The kit's own simulation passed: ${JSON.stringify(d.simulation)}`);
  if (d.confirm_reasons?.length) lines.push(`Needs the owner's approval before it is signed, because: ${d.confirm_reasons.map((r) => r.text).join("; ")}.`);
  return lines;
}

// ---------------------------------------------------------------- the token card

const CHAIN_LABEL = { base: "Base", solana: "Solana" };

/**
 * What is at an address, a mint or a link: Sato Hub's resolver for the name, price and liquidity, then the chain for decimals,
 * program and authorities (the chain wins where they differ), then Sato Hub's token check. Read-only: no wallet, no policy.
 * deps: resolveHub, resolveBaseToken, resolveSolanaToken, runCheck, baseDeps, solDeps.
 */
export async function describeToken(input, { chain } = {}, deps = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("token needs an address, a mint or a link");
  if (chain !== undefined && !["base", "solana"].includes(chain)) throw new Error("--chain must be base or solana");
  const link = looksLikeLink(raw);
  const hubRes = await (deps.resolveHub ?? resolveTokenViaHub)(raw, { chain });
  let hub = hubRes.ok ? hubRes.token : null;
  if (link && !hub) {
    throw new Error(
      hubRes.reason === "not_resolved"
        ? `Sato Hub could not resolve this link (${clean(hubRes.error, 200)}); send the contract address instead`
        : "Sato Hub could not resolve this link right now; send the contract address instead",
    );
  }
  const guessed = isBaseAddress(raw) ? "base" : isSolanaMint(raw) ? "solana" : null;
  const where = link ? hub.chain : guessed ?? chain ?? (hub ? hub.chain : null);
  if (!where) throw new Error("token needs a 0x contract address (Base), a Solana mint or a link; for USDC, ETH or SOL by name, add --chain");
  if (chain && chain !== where) throw new Error(`that is a ${where} address, but --chain is ${chain}`);
  const address = link ? hub.address : raw;
  const notes = [];
  if (!hubRes.ok) notes.push(`Sato Hub's token resolver gave no answer (${clean(hubRes.error ?? hubRes.reason, 160)}); this card is read from the chain only, without a price or liquidity.`);
  if (hubRes.ok && !hubRes.signature?.ok) notes.push("Sato Hub's resolver answer could not be shown to be signed by Sato Hub, so its name, price and liquidity are shown as a hint only.");
  if (hub && hub.chain !== where) {
    notes.push(`Sato Hub placed this on ${hub.chain}; the address is a ${where} address. The chain read below is for ${where}, and Sato Hub's name, price and liquidity are left out.`);
    hub = null;
  }

  // The chain, always (decimals, program, authorities, extensions). Refusals to read (no contract, not a mint) come through as Refused.
  let info;
  if (where === "base") info = await (deps.resolveBaseToken ?? evm.resolveBaseToken)(address, deps.baseDeps ?? {});
  else info = await (deps.resolveSolanaToken ?? sol.resolveSolanaToken)(address, deps.solDeps ?? {});
  const disagreements = compareHubWithChain(where, hub, info);

  // The check is about the token the chain read, by the address the chain gave back (never a link, never a symbol).
  const checked = where === "base" ? info.address : info.mint;
  const check = await (deps.runCheck ?? runCheck)({ token: checked, chain: CHAIN_LABEL[where] }, "token");
  const src = (field) => hub?.sources?.find((s) => s.field === field) ?? null;
  const pool = hub?.main_pool ?? null;
  const card = {
    chain: where,
    address: where === "base" ? info.address : info.mint,
    name: where === "base" ? info.name ?? hub?.name ?? null : hub?.name ?? null,
    symbol: where === "base" ? info.symbol : hub?.symbol ?? info.major ?? null,
    name_source: where === "base" ? (info.name ? "the contract" : hub?.name ? "Sato Hub" : null) : hub?.name ? "Sato Hub" : null,
    decimals: info.decimals,
    program: where === "base" ? "ERC-20" : info.program_name,
    major: where === "base" ? (info.major ? info.symbol : null) : info.major ?? null,
    price: hub && typeof hub.price_usd === "number" ? { usd: hub.price_usd, source: src("price_usd")?.source ?? "Sato Hub", as_of: src("price_usd")?.as_of ?? hub.checked_at ?? null } : null,
    liquidity: hub && typeof hub.liquidity_usd === "number" ? { usd: hub.liquidity_usd, main_pool: pool, source: src("liquidity_usd")?.source ?? "Sato Hub", as_of: src("liquidity_usd")?.as_of ?? hub.checked_at ?? null } : null,
    sato_hub_resolver: hubRes.ok ? { used: true, signature_checked: hubRes.signature?.ok === true, resolved_from: hub?.resolved_from ?? null, gaps: hub?.gaps ?? [], checked_at: hub?.checked_at ?? null } : { used: false, reason: hubRes.reason, error: hubRes.error ?? null },
    solana:
      where === "solana" && !info.major
        ? {
            mint_authority: info.mint_authority,
            freeze_authority: info.freeze_authority,
            supply: info.supply,
            extensions: info.extensions,
            transfer_fee_bps: info.transfer_fee?.bps ?? null,
            confirm: info.confirm ?? [],
            refused: (info.refusals ?? []).map((r) => r.message),
            notes: info.notes,
          }
        : null,
    disagreements,
    notes,
    sato_hub_check: check.unavailable
      ? { available: false, reason: check.reason ?? null, text: check.text }
      : { available: true, verdict: check.verdict, rule: check.rule, checked_at: check.checked_at, text: check.text },
  };
  // A name and a symbol are whatever the creator wrote. Every token other than a major is shown with its short address, and a
  // symbol or name with characters outside plain ASCII (homoglyphs, direction marks) is flagged.
  const shortAddr = where === "base" ? shortBaseAddress(card.address) : shortMint(card.address);
  card.label = card.major ? card.symbol : card.symbol ? `${clean(card.symbol, 30)} ${shortAddr}` : shortAddr;
  card.symbol_non_ascii = !card.major && /[^\x20-\x7E]/.test(`${card.symbol ?? ""}${card.name ?? ""}`);
  if (card.symbol_non_ascii) card.notes.push("The name or symbol contains characters outside plain ASCII (look-alike letters or direction marks), which can make a token pass for another one. Go by the address.");
  return card;
}

/** The card as plain lines. Names, symbols and Sato Hub's text are untrusted: cleaned, one line each. */
export function renderTokenCard(card) {
  const c = (v, max = 200) => clean(v, max);
  const lines = [];
  lines.push(`${card.name ? `${c(card.name, 60)} ` : ""}${card.label ? `(${c(card.label, 60)}) ` : ""}on ${CHAIN_LABEL[card.chain]}${card.name_source ? ` (name per ${card.name_source}; it is whatever the creator wrote)` : ""}`.trim());
  lines.push(`Address:  ${card.address}`);
  lines.push(`Decimals: ${card.decimals} (read from the chain)`);
  lines.push(`Program:  ${card.program} (read from the chain)`);
  const date = (iso) => (iso ? String(iso).replace(/\.\d+Z$/, "Z") : "an unknown time");
  lines.push(card.price ? `Price:    $${card.price.usd} (${c(card.price.source, 80)}, ${date(card.price.as_of)}; one pool's listing, not a quote)` : "Price:    unknown");
  if (card.liquidity) {
    const p = card.liquidity.main_pool;
    lines.push(`Liquidity: $${card.liquidity.usd} listed in the main pool${p ? ` (${c(p.venue, 40)}${p.address ? ` ${c(p.address, 60)}` : ""}${p.quote_token?.symbol ? `, against ${c(p.quote_token.symbol, 20)}` : ""})` : ""} (${c(card.liquidity.source, 80)}, ${date(card.liquidity.as_of)}; that pool only)`);
  } else lines.push("Liquidity: unknown");
  const s = card.solana;
  if (s) {
    lines.push(`Mint authority:   ${s.mint_authority ? `set, to ${s.mint_authority}: it can create more of this token` : "none (no more can be created)"}`);
    lines.push(`Freeze authority: ${s.freeze_authority ? `set, to ${s.freeze_authority}: it can freeze this wallet's account for the token, and a frozen account cannot sell` : "none"}`);
    lines.push(`Token-2022 extensions: ${s.extensions.length ? s.extensions.join(", ") : "none"}`);
    if (s.transfer_fee_bps) lines.push(`Transfer fee: ${s.transfer_fee_bps / 100}% on every transfer of this token.`);
    for (const x of s.confirm) lines.push(`Needs your approval on every trade: ${x.code ? "" : `${x.extension}: `}${x.why}.`);
    for (const m of s.refused) lines.push(`Not tradable by this kit: ${c(m, 300)}`);
  }
  for (const d of card.disagreements) lines.push(`Note: ${d}`);
  for (const n of card.notes) lines.push(`Note: ${c(n, 300)}`);
  const k = card.sato_hub_check;
  lines.push("");
  lines.push(k.available ? `Sato Hub's token check (dated evidence${k.checked_at ? `, ${date(k.checked_at)}` : ""}; not a verdict on anyone):` : "Sato Hub's token check did not run:");
  lines.push(cleanBody(k.text ?? ""));
  return lines;
}
