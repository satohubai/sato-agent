// Swaps on Solana: USDC <-> SOL through Jupiter, built here, checked here,
// signed here.
//
// Sato Hub does not hand back a Solana transaction (its Jupiter adapter never
// calls /swap), so this kit builds one through Jupiter's public API and treats
// what comes back as untrusted bytes:
//
//   plan     quote + build (Jupiter), with the Sato fee disclosed in the plan
//   verify   decode the transaction, resolve its address lookup tables from the
//            chain, check every instruction, then simulate it and compare the
//            agent's balances before and after. Nothing passes on Jupiter's say-so.
//   execute  the same order of operations as `sendUsdc` in ../solana.js: reserve
//            against the limits, sign, record the signature, broadcast, poll.
//            A transaction that may have gone out is never re-signed or retried.
//
// Scope is exactly USDC <-> SOL (native SOL; Jupiter wraps and unwraps it).
// Every network dependency is injectable, so the tests run offline against
// recorded mainnet responses.

import {
  address,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSignerRole,
  signTransaction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { loadPolicy } from "../policy.js";
import { record, release, reserve } from "../ledger.js";
import { Pending, Refused, Rejected } from "../errors.js";
import { usdcUnits } from "../amount.js";
import { loadWallet, solanaSecret } from "../wallet.js";
import { USER_AGENT } from "../version.js";
import { TOKEN_2022_PROGRAM, USDC_MINT, explorer, rpc as defaultRpc } from "../solana.js";

/** Same 20 s guard as ../solana.js, but the timer is cleared once the call settles (a swap makes many calls). */
const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

// ---------------------------------------------------------------- constants

/** Wrapped SOL. Native SOL is wrapped and unwrapped by Jupiter (`wrapAndUnwrapSol`). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Jupiter's public Swap API. Keyless is ~0.5 requests per second; lite-api.jup.ag is being phased out. */
export const JUPITER_API = "https://api.jup.ag/swap/v1";

// Sato's Jupiter referral TOKEN accounts (not the referral account itself): Jupiter
// pays the platform fee into the one whose mint is the swap's input mint.
//   seeds   ["referral_ata", referral_account, mint]
//   program REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3
//   referral account GwRkq9EBWwcLNbFzYYGSKkgoBYo4grLvCV67dHoEZ4ZB
// Sources: Sato Hub app `lib/route/jupiterReferral.ts` (derivation) and
// `docs/REVENUE-SETUP.md:42` (USDC = FMEX...4LGo, "confirmed on mainnet"). The
// wSOL address was derived with exactly that rule on 2026-10-09 and read back from
// mainnet: an initialised SPL token account, mint wSOL (test/swap-solana.test.js
// re-derives both offline). A fee account is never taken from a response.
export const SATO_REFERRAL_ACCOUNT = "GwRkq9EBWwcLNbFzYYGSKkgoBYo4grLvCV67dHoEZ4ZB";
export const SATO_FEE_ACCOUNTS = Object.freeze({
  [USDC_MINT]: "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo",
  [WSOL_MINT]: "HnyyFHhp3LQ6VfRn1AhPHSwboYYQa1HT7REaMfzsA8gx",
});
/**
 * The kit refuses a platform fee above this, whatever a response says. Sato's
 * published same-chain rate is 3 bps stable-to-stable and 15 bps with a volatile
 * leg (USDC <-> SOL is volatile); 25 bps is cross-chain only. Same ceiling as Base.
 */
export const FEE_BPS_MAX = 15;

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Top-level programs a swap transaction may call. Sources: Jupiter v6 id and the
 * rest from SWAP-CONTRACT section 3.5 (Jupiter docs and mainnet checks), and the
 * Token-2022 id from @solana-program/token-2022 (the older id in v0.1.0 was wrong).
 * There is NO Referral program here on purpose: the fee is a Jupiter-internal
 * transfer, so a top-level call to it is refused. CPI programs (the AMMs) are not
 * visible statically; the simulation covers what they do to the agent's balances.
 */
export const SWAP_PROGRAM_ALLOWLIST = Object.freeze({
  [JUPITER_PROGRAM]: "Jupiter v6",
  [TOKEN_PROGRAM_ADDRESS]: "Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [ASSOCIATED_TOKEN_PROGRAM]: "Associated Token",
  [SYSTEM_PROGRAM]: "System",
  [COMPUTE_BUDGET_PROGRAM]: "ComputeBudget",
});

/**
 * The most the priority fee may cost: 100,000 lamports (0.0001 SOL, about a cent
 * and about 20x the 5,000-lamport base fee). Enough for Jupiter's "high" level to
 * land in normal conditions, small enough that a bad response cannot make a swap
 * expensive. Passed to Jupiter as `maxLamports` AND re-checked on the decoded
 * transaction, because Jupiter's reply is not trusted.
 */
export const PRIORITY_MAX_LAMPORTS = 100_000;
const BASE_FEE_LAMPORTS = 5_000n;
/** Rent of one 165-byte token account. A swap into USDC may create the agent's USDC account. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
/**
 * Everything beyond `amount_in` that a swap may take from the agent's SOL: the
 * network fee (base + priority cap) plus rent for up to two new token accounts.
 * Documented cap for the SOL-input outflow check.
 */
export const SOL_OVERHEAD_CAP_LAMPORTS = BASE_FEE_LAMPORTS + BigInt(PRIORITY_MAX_LAMPORTS) + 2n * TOKEN_ACCOUNT_RENT;

/** A built transaction older than this is rebuilt, never signed: its blockhash is on a clock. */
export const PLAN_MAX_AGE_MS = 25_000;
/** ...and one whose blockhash has fewer than this many blocks left (~0.4 s each) is rebuilt too. */
export const MIN_BLOCKS_LEFT = 60;
export const SLIPPAGE_BPS_DEFAULT = 50;
export const SLIPPAGE_BPS_MAX = 500;
const HTTP_TIMEOUT_MS = 20_000;
const JUPITER_MIN_GAP_MS = 2_100; // keyless is 0.5 RPS

const SYMBOLS = {
  USDC: { symbol: "USDC", mint: USDC_MINT, decimals: 6 },
  SOL: { symbol: "SOL", mint: WSOL_MINT, decimals: 9 },
};
const MINT_SYMBOL = { [USDC_MINT]: "USDC", [WSOL_MINT]: "SOL" };

/** A plan whose blockhash is too old (or about to be) to sign. Nothing was reserved or signed. */
export class PlanStale extends Error {}

// ---------------------------------------------------------------- small helpers

const big = (x) => BigInt(typeof x === "number" ? Math.trunc(x) : (x ?? 0));
const jsonSafe = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const refuse = (rule, message) => ({ rule, message });

/** A plain decimal SOL amount, at most 9 places, positive; never rounded. */
export function solLamports(amount) {
  const s = String(amount);
  const [whole, frac = ""] = s.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || s.endsWith(".") || frac.length > 9) {
    throw new Error(`not a SOL amount: "${amount}" (a plain number with at most 9 decimals, like 0.05)`);
  }
  const units = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
  if (units <= 0n) throw new Error(`not a positive SOL amount: "${amount}"`);
  return units;
}

export function formatUnits(units, decimals) {
  const u = big(units);
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${u / base}${frac ? "." + frac : ""}`;
}

function side(sym) {
  const s = SYMBOLS[String(sym ?? "").toUpperCase()];
  if (!s) throw new Error(`unsupported asset "${sym}": Solana swaps are USDC <-> SOL only`);
  return s;
}

function parseIntent({ from, to, amount, slippageBps }) {
  const a = side(from);
  const b = side(to);
  if (a.symbol === b.symbol) throw new Error("a swap needs two different assets (USDC <-> SOL)");
  const units = a.symbol === "USDC" ? usdcUnits(amount) : solLamports(amount);
  const slip = slippageBps ?? SLIPPAGE_BPS_DEFAULT;
  if (!Number.isInteger(slip) || slip < 1 || slip > SLIPPAGE_BPS_MAX) {
    throw new Error(`slippage must be a whole number of basis points from 1 to ${SLIPPAGE_BPS_MAX} (got ${slippageBps})`);
  }
  return { a, b, units, slip };
}

const b64 = getBase64Encoder();
function decodeTxBase64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("the transaction is not base64");
  return getTransactionDecoder().decode(b64.encode(text));
}

// ---------------------------------------------------------------- Jupiter HTTP

let lastJupiterCall = 0;

async function jupiter(path, { method = "GET", body }, d) {
  const gap = d.minGapMs ?? JUPITER_MIN_GAP_MS;
  const wait = Math.min(gap, lastJupiterCall + gap - d.now()); // never longer than the gap, whatever the clock did
  if (wait > 0 && gap > 0) await d.sleep(wait);
  const headers = { "user-agent": d.userAgent, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  const key = d.jupiterApiKey ?? process.env.SATO_AGENT_JUPITER_API_KEY;
  if (key) headers["x-api-key"] = key;
  for (let attempt = 0; ; attempt++) {
    lastJupiterCall = d.now();
    let res;
    try {
      res = await d.fetch(`${d.jupiterBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Jupiter did not answer (${err.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : err.message}); nothing was signed`);
    }
    const text = await res.text();
    if (res.status === 429 && attempt === 0) {
      await d.sleep(Math.min(10_000, Math.max(3_000, Number(res.headers?.get?.("retry-after") ?? 0) * 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`Jupiter answered HTTP ${res.status}: ${text.slice(0, 200)}${res.status === 429 ? " (keyless Jupiter allows about one request every 2 s; wait and try again)" : ""}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Jupiter answered something that is not JSON: ${text.slice(0, 120)}`);
    }
  }
}

function withDefaults(deps = {}) {
  return {
    ...deps,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    fetch: deps.fetch ?? globalThis.fetch,
    userAgent: deps.userAgent ?? USER_AGENT,
    jupiterBase: deps.jupiterBase ?? JUPITER_API,
  };
}

// ---------------------------------------------------------------- plan

/**
 * Quote and build a swap. Writes nothing, signs nothing, and records nothing at
 * Sato Hub (its recommend / build-tx calls write public receipts, so they are not
 * used here). Needs `deps.satoFeeBps` from Sato Hub's quote (0 = no fee).
 *
 *   plan = {
 *     chain, venue, agent, from, to, mint_in, mint_out,
 *     amount_in, quote: { out_amount, min_out, slippage_bps, price_impact_pct, route, context_slot },
 *     fee: { bps, account, mint, leg: "input", max_units, symbol, text } | { bps: 0, account: null, text },
 *     priority: { max_lamports, jupiter_estimate_lamports },
 *     usd_estimate, swap_transaction (base64, v0), last_valid_block_height, built_at,
 *     disclosure: [lines to show the owner before anything is signed]
 *   }
 */
export async function planSolanaSwap({ from, to, amount, slippageBps }, deps = {}) {
  const d = withDefaults(deps);
  const { a, b, units, slip } = parseIntent({ from, to, amount, slippageBps });
  const agent = d.agent ?? loadWallet().solana.address;
  address(agent);

  const feeBps = d.satoFeeBps;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    throw new Error(`satoFeeBps is required (from Sato Hub's quote; 0 for none) and must be a whole number from 0 to ${FEE_BPS_MAX}`);
  }
  // The fee account is pinned per input mint. A different one from the caller (or a
  // response) is a kit release, not something to follow.
  const pinned = SATO_FEE_ACCOUNTS[a.mint];
  if (feeBps > 0 && d.feeAccount !== undefined && d.feeAccount !== pinned) {
    throw new Refused([refuse("solana_swap.fee_account_unpinned", `the fee account ${d.feeAccount} is not the one this kit pins for ${a.symbol} (${pinned}); update the kit rather than follow it`)]);
  }

  const q = new URLSearchParams({ inputMint: a.mint, outputMint: b.mint, amount: units.toString(), slippageBps: String(slip), swapMode: "ExactIn", restrictIntermediateTokens: "true" });
  if (feeBps > 0) q.set("platformFeeBps", String(feeBps));
  const quote = await jupiter(`/quote?${q}`, {}, d);
  checkQuote(quote, { a, b, units, slip, feeBps });

  const body = {
    userPublicKey: agent,
    quoteResponse: quote,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    // Capped, not "auto": Jupiter picks a level, we bound what it may cost.
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: PRIORITY_MAX_LAMPORTS, priorityLevel: "high" } },
  };
  if (feeBps > 0) body.feeAccount = pinned;
  const built = await jupiter("/swap", { method: "POST", body }, d);
  if (typeof built?.swapTransaction !== "string" || !built.swapTransaction) throw new Error("Jupiter returned no transaction");
  if (built.simulationError) throw new Error(`Jupiter's own simulation of the swap failed: ${jsonSafe(built.simulationError).slice(0, 200)}`);
  if (!Number.isFinite(built.lastValidBlockHeight)) throw new Error("Jupiter returned no lastValidBlockHeight");

  const maxFeeUnits = feeBps > 0 ? (units * BigInt(feeBps) + 9_999n) / 10_000n : 0n;
  const fee = feeBps > 0
    ? {
        bps: feeBps, account: pinned, mint: a.mint, leg: "input", symbol: a.symbol, max_units: maxFeeUnits.toString(),
        text: `Sato Hub fee: ${feeBps / 100}% of the ${a.symbol} you swap (up to ${formatUnits(maxFeeUnits, a.decimals)} ${a.symbol}), paid in ${a.symbol} to Sato Hub's Jupiter referral token account ${pinned} inside this same transaction. It comes out of the amount you swap; nothing is added on top.`,
      }
    : { bps: 0, account: null, text: "No Sato Hub fee on this swap." };

  const outAmount = big(quote.outAmount);
  const minOut = big(quote.otherAmountThreshold);
  // USDC is on one side of every swap here, so the USD size is read off that side.
  const usd = a.symbol === "USDC" ? Number(units) / 1e6 : Number(outAmount) / 1e6;
  const route = (quote.routePlan ?? []).map((r) => r?.swapInfo?.label).filter(Boolean);
  const plan = {
    chain: "solana",
    venue: "jupiter",
    agent,
    from: a.symbol,
    to: b.symbol,
    mint_in: a.mint,
    mint_out: b.mint,
    amount_in: units.toString(),
    quote: {
      out_amount: outAmount.toString(),
      min_out: minOut.toString(),
      slippage_bps: slip,
      price_impact_pct: quote.priceImpactPct ?? null,
      route,
      context_slot: quote.contextSlot ?? null,
    },
    fee,
    priority: { max_lamports: PRIORITY_MAX_LAMPORTS, jupiter_estimate_lamports: Number.isFinite(built.prioritizationFeeLamports) ? built.prioritizationFeeLamports : null },
    usd_estimate: usd,
    swap_transaction: built.swapTransaction,
    last_valid_block_height: built.lastValidBlockHeight,
    built_at: d.now(),
  };
  plan.disclosure = [
    `Swap ${formatUnits(units, a.decimals)} ${a.symbol} for ${b.symbol} on Solana through Jupiter${route.length ? ` (${route.join(" > ")})` : ""}.`,
    `You receive at least ${formatUnits(minOut, b.decimals)} ${b.symbol} (Jupiter's estimate is ${formatUnits(outAmount, b.decimals)}; slippage limit ${slip / 100}%). The transaction fails instead of paying less.`,
    fee.text,
    `Network fee: ${Number(BASE_FEE_LAMPORTS) / 1e9} SOL plus a priority fee of at most ${PRIORITY_MAX_LAMPORTS / 1e9} SOL. If you have no ${b.symbol === "USDC" ? "USDC" : "wrapped SOL"} account yet, creating one costs about ${Number(TOKEN_ACCOUNT_RENT) / 1e9} SOL rent${b.symbol === "SOL" ? " (refunded when it is closed)" : ""}.`,
  ];
  return plan;
}

function checkQuote(quote, { a, b, units, slip, feeBps }) {
  const bad = (m) => {
    throw new Error(`Jupiter's quote does not match the request (${m}); nothing was signed`);
  };
  if (!quote || typeof quote !== "object") bad("no quote");
  if (quote.inputMint !== a.mint || quote.outputMint !== b.mint) bad("different assets");
  if (quote.swapMode !== "ExactIn") bad("not an exact-input quote");
  if (String(quote.inAmount) !== units.toString()) bad("different input amount");
  if (Number(quote.slippageBps) !== slip) bad("different slippage");
  if (!/^\d+$/.test(String(quote.outAmount)) || !/^\d+$/.test(String(quote.otherAmountThreshold))) bad("no output amounts");
  const out = big(quote.outAmount);
  const min = big(quote.otherAmountThreshold);
  if (out <= 0n || min <= 0n || min > out) bad("output amounts are inconsistent");
  // The floor Jupiter reports must be the slippage the owner asked for (to the unit).
  if (min * 10_000n < out * BigInt(10_000 - slip) - 10_000n) bad("the minimum output is looser than the slippage limit");
  if (feeBps > 0 && Number(quote.platformFee?.feeBps) !== feeBps) bad("the platform fee was not applied");
  if (feeBps === 0 && big(quote.platformFee?.amount) > 0n) bad("an unrequested platform fee");
}

// ---------------------------------------------------------------- inspection (static)

const u32 = (data, at = 1) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
const u64 = (data, at = 1) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

async function derivedAta(owner, mint, tokenProgram = TOKEN_PROGRAM_ADDRESS) {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return ata;
}

/**
 * Decode a swap transaction and run every check that needs no simulation.
 * `alts` maps each lookup table address to its list of addresses. Returns
 * { refusals, facts }; it never throws for a bad transaction, only for bad input.
 */
export async function inspectSolanaSwapTransaction(swapTransaction, { agent, mintIn, amountIn, feeAccount }, alts) {
  const refusals = [];
  const facts = { programs: [], priority_lamports: 0n, keys: [], lookup_loaded: { writable: [], readonly: [] }, created_atas: [] };
  let tx;
  let compiled;
  let message;
  try {
    tx = decodeTxBase64(swapTransaction);
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: alts });
  } catch (err) {
    refusals.push(refuse("solana_swap.decode", `the transaction could not be decoded with its lookup tables (${String(err.message).slice(0, 160)})`));
    return { refusals, facts };
  }
  if (compiled.version !== 0) refusals.push(refuse("solana_swap.version", `expected a version 0 transaction, got ${compiled.version}`));

  // (a) fee payer and (b) the only signer.
  const statics = compiled.staticAccounts;
  const nSigners = compiled.header.numSignerAccounts;
  if (statics[0] !== agent) refusals.push(refuse("solana_swap.fee_payer", `the fee payer is ${statics[0]}, not the agent ${agent}`));
  if (nSigners !== 1) refusals.push(refuse("solana_swap.signers", `${nSigners} accounts must sign; only the agent may`));
  const sigKeys = Object.keys(tx.signatures);
  if (sigKeys.length !== 1 || sigKeys[0] !== agent) refusals.push(refuse("solana_swap.signers", `the transaction expects signatures from ${sigKeys.join(", ")}; only the agent may sign`));

  // Resolved account keys, in the order the runtime (and the simulation) report them.
  const lookups = compiled.addressTableLookups ?? [];
  const writable = lookups.flatMap((l) => l.writableIndexes.map((i) => alts[l.lookupTableAddress][i]));
  const readonly = lookups.flatMap((l) => l.readonlyIndexes.map((i) => alts[l.lookupTableAddress][i]));
  facts.lookup_loaded = { writable, readonly };
  facts.keys = [...statics, ...writable, ...readonly];

  const agentSplAta = {
    [USDC_MINT]: await derivedAta(agent, USDC_MINT),
    [WSOL_MINT]: await derivedAta(agent, WSOL_MINT),
  };

  let limit = null;
  let price = null;
  let heap = 0;
  let loadedLimit = 0;
  let nonBudget = 0;
  let systemLamports = 0n;
  const pushOnce = (set, v) => set.includes(v) || set.push(v);

  for (const [n, ix] of message.instructions.entries()) {
    const prog = ix.programAddress;
    const data = ix.data ?? new Uint8Array();
    const accts = ix.accounts ?? [];
    pushOnce(facts.programs, prog);
    // No instruction may ask for anyone's signature but the agent's.
    for (const acc of accts) if (isSignerRole(acc.role) && acc.address !== agent) refusals.push(refuse("solana_swap.signers", `instruction ${n} needs a signature from ${acc.address}`));

    if (!SWAP_PROGRAM_ALLOWLIST[prog]) {
      refusals.push(refuse("solana_swap.program_allowlist", `instruction ${n} calls ${prog}, which is not an allowed program`));
      continue;
    }
    if (prog !== COMPUTE_BUDGET_PROGRAM) nonBudget++;

    if (prog === COMPUTE_BUDGET_PROGRAM) {
      const d0 = data[0];
      if (d0 === 2 && data.length === 5) {
        if (limit !== null) refusals.push(refuse("solana_swap.priority_fee", "two compute-unit-limit instructions"));
        limit = u32(data);
      } else if (d0 === 3 && data.length === 9) {
        if (price !== null) refusals.push(refuse("solana_swap.priority_fee", "two compute-unit-price instructions"));
        price = u64(data);
      } else if (d0 === 1 && data.length === 5) heap = u32(data);
      else if (d0 === 4 && data.length === 5) loadedLimit = u32(data);
      else refusals.push(refuse("solana_swap.compute_budget", `instruction ${n} is a ComputeBudget instruction this kit does not allow (type ${d0})`));
    } else if (prog === SYSTEM_PROGRAM) {
      // Only a SOL transfer from the agent into its own wrapped-SOL account (the wrap step).
      const kind = data.length >= 4 ? u32(data, 0) : -1;
      if (kind === 2 && data.length === 12) {
        const lamports = u64(data, 4);
        systemLamports += lamports;
        if (accts[0]?.address !== agent || accts[1]?.address !== agentSplAta[WSOL_MINT]) {
          refusals.push(refuse("solana_swap.system_transfer", `instruction ${n} moves SOL to ${accts[1]?.address}, which is not the agent's own wrapped-SOL account`));
        }
      } else refusals.push(refuse("solana_swap.system_instruction", `instruction ${n} is a System instruction this kit does not allow`));
    } else if (prog === ASSOCIATED_TOKEN_PROGRAM) {
      const kind = data.length === 0 ? 0 : data[0];
      const [payer, ata, owner, mint, , tokenProgram] = accts.map((x) => x.address);
      if ((kind !== 0 && kind !== 1) || accts.length < 6) {
        refusals.push(refuse("solana_swap.ata_instruction", `instruction ${n} is an Associated Token instruction this kit does not allow`));
      } else {
        const mintOk = mint === USDC_MINT || mint === WSOL_MINT;
        if (payer !== agent || owner !== agent || !mintOk || tokenProgram !== TOKEN_PROGRAM_ADDRESS || ata !== agentSplAta[mint]) {
          refusals.push(refuse("solana_swap.ata_instruction", `instruction ${n} creates a token account that is not the agent's own USDC or wrapped-SOL account`));
        } else pushOnce(facts.created_atas, ata);
      }
    } else if (prog === TOKEN_PROGRAM_ADDRESS || prog === TOKEN_2022_PROGRAM) {
      const kind = data[0];
      if (kind === 6 || kind === 4 || kind === 13) {
        refusals.push(refuse("solana_swap.token_authority", `instruction ${n} is a token ${kind === 6 ? "SetAuthority" : kind === 4 ? "Approve" : "ApproveChecked"}, which gives someone control of the agent's tokens`));
      } else if (kind === 9) {
        // Closing the wrapped-SOL account after the swap: the lamports must come back to the agent.
        if (accts[1]?.address !== agent || accts[2]?.address !== agent) {
          refusals.push(refuse("solana_swap.token_close_destination", `instruction ${n} closes a token account into ${accts[1]?.address}, not the agent`));
        }
      } else if (kind === 17) {
        // SyncNative: credits the wrapped lamports; moves nothing.
      } else refusals.push(refuse("solana_swap.token_instruction", `instruction ${n} is a token instruction (type ${kind}) this kit does not allow at the top level`));
    }
    // Jupiter: its accounts and data are Jupiter's; its effect is checked by the simulation.
  }

  // (e) the priority fee: price x limit, in lamports, rounded up.
  const effLimit = BigInt(limit ?? Math.min(200_000 * nonBudget, 1_400_000));
  facts.priority_lamports = price === null ? 0n : (price * effLimit + 999_999n) / 1_000_000n;
  facts.compute_unit_limit = Number(effLimit);
  facts.requested_heap = heap;
  facts.loaded_accounts_limit = loadedLimit;
  if (facts.priority_lamports > BigInt(PRIORITY_MAX_LAMPORTS)) {
    refusals.push(refuse("solana_swap.priority_fee", `the priority fee would be ${facts.priority_lamports} lamports, over the cap of ${PRIORITY_MAX_LAMPORTS}`));
  }
  if (mintIn === WSOL_MINT) {
    if (systemLamports > big(amountIn)) refusals.push(refuse("solana_swap.system_transfer", `the transaction wraps ${systemLamports} lamports, more than the ${amountIn} being swapped`));
  } else if (systemLamports > 0n) {
    refusals.push(refuse("solana_swap.system_transfer", "the transaction moves SOL, but this swap does not spend SOL"));
  }
  if (feeAccount && !facts.keys.includes(feeAccount)) refusals.push(refuse("solana_swap.fee_account_missing", `the disclosed fee account ${feeAccount} is not in the transaction`));
  facts.system_lamports = systemLamports;
  facts.instruction_count = message.instructions.length;
  return { refusals, facts };
}

// ---------------------------------------------------------------- balance deltas

/**
 * What a transaction (simulated or confirmed) did to the agent. Inputs are the
 * runtime's own arrays: `keys` (static + loaded writable + loaded readonly),
 * pre/post lamports, and pre/post token balances. All from one execution, so
 * there is no race between a "before" read and an "after" read.
 *
 *   usdc.delta   change in USDC across the agent's USDC token accounts (base units)
 *   sol.delta    change in the agent's SOL position: its lamports plus every wrapped-SOL
 *                account it owns, rent included (wrap, unwrap and close move value
 *                between those two and so net to zero)
 *   created_usdc_rent  lamports locked in USDC accounts the transaction created
 *   others       agent-owned token accounts of any other mint that lost tokens
 */
export function balanceDeltas(view, agent) {
  const keys = view.keys.map(String);
  const agentIndex = keys.indexOf(agent);
  const pre = view.preBalances.map(big);
  const post = view.postBalances.map(big);
  const mine = (list) => (list ?? []).filter((t) => t.owner === agent);
  const preTok = mine(view.preTokenBalances);
  const postTok = mine(view.postTokenBalances);
  const amount = (t) => big(t.uiTokenAmount?.amount ?? t.amount);
  const sumMint = (list, mint) => list.filter((t) => t.mint === mint).reduce((s, t) => s + amount(t), 0n);
  const indices = (mint) => new Set([...preTok, ...postTok].filter((t) => t.mint === mint).map((t) => t.accountIndex));
  const lamportsOf = (set, arr) => [...set].reduce((s, i) => s + arr[i], 0n);

  const wsolIdx = indices(WSOL_MINT);
  const solPre = (agentIndex >= 0 ? pre[agentIndex] : 0n) + lamportsOf(wsolIdx, pre);
  const solPost = (agentIndex >= 0 ? post[agentIndex] : 0n) + lamportsOf(wsolIdx, post);
  const preUsdcIdx = new Set(preTok.filter((t) => t.mint === USDC_MINT).map((t) => t.accountIndex));
  let createdRent = 0n;
  for (const t of postTok) if (t.mint === USDC_MINT && !preUsdcIdx.has(t.accountIndex)) createdRent += post[t.accountIndex];

  const others = [];
  const otherMints = new Set([...preTok, ...postTok].map((t) => t.mint).filter((m) => m !== USDC_MINT && m !== WSOL_MINT));
  for (const m of otherMints) {
    const delta = sumMint(postTok, m) - sumMint(preTok, m);
    if (delta !== 0n) others.push({ mint: m, delta });
  }
  const usdcPre = sumMint(preTok, USDC_MINT);
  const usdcPost = sumMint(postTok, USDC_MINT);
  return {
    usdc: { pre: usdcPre, post: usdcPost, delta: usdcPost - usdcPre },
    sol: { pre: solPre, post: solPost, delta: solPost - solPre },
    created_usdc_rent: createdRent,
    others,
    agent_in_transaction: agentIndex >= 0,
  };
}

/** The balance change of one token account (by address) between two states, or null if it is not in the transaction. */
function tokenAccountChange(view, accountAddress) {
  const idx = view.keys.map(String).indexOf(accountAddress);
  if (idx < 0) return null;
  const find = (list) => (list ?? []).find((t) => t.accountIndex === idx);
  const a = find(view.preTokenBalances);
  const z = find(view.postTokenBalances);
  return { index: idx, mint: (a ?? z)?.mint ?? null, existed: !!a, pre: a ? big(a.uiTokenAmount?.amount) : 0n, post: z ? big(z.uiTokenAmount?.amount) : 0n };
}

// ---------------------------------------------------------------- verify

function intentOf(plan, intent) {
  const i = intent ?? {};
  const from = side(i.from ?? plan.from);
  const to = side(i.to ?? plan.to);
  let units = i.amount_in ?? plan.amount_in;
  if (i.amount !== undefined) units = from.symbol === "USDC" ? usdcUnits(i.amount) : solLamports(i.amount);
  return { agent: i.agent ?? plan.agent, from, to, amountIn: big(units) };
}

/**
 * Check a built swap before anything is signed. Throws Refused (rule ids
 * `solana_swap.*`) on the first failing stage, listing every failure in it.
 * Returns { ok: true, ... } with the facts that were checked.
 *
 * `intent` is what the owner asked for ({ agent, from, to, amount_in | amount }),
 * checked against the plan and the decoded transaction, not copied from the plan.
 */
export async function verifySolanaSwapPlan(plan, intent, deps = {}) {
  const d = withDefaults(deps);
  const r = d.rpc ?? defaultRpc();
  const want = intentOf(plan, intent);
  const refusals = [];
  const fail = (rule, msg) => refusals.push(refuse(rule, msg));

  // The plan must be the swap that was asked for.
  if (plan.chain !== "solana" || plan.venue !== "jupiter") fail("solana_swap.intent", "the plan is not a Solana / Jupiter swap");
  if (plan.agent !== want.agent) fail("solana_swap.intent", `the plan is for ${plan.agent}, not the agent ${want.agent}`);
  if (plan.from !== want.from.symbol || plan.to !== want.to.symbol || plan.mint_in !== want.from.mint || plan.mint_out !== want.to.mint) fail("solana_swap.intent", "the plan swaps different assets than asked");
  if (want.from.symbol === want.to.symbol) fail("solana_swap.intent", "a swap needs two different assets");
  if (String(plan.amount_in) !== want.amountIn.toString()) fail("solana_swap.intent", `the plan swaps ${plan.amount_in} base units, not the ${want.amountIn} asked for`);
  const minOut = (() => {
    try {
      return big(plan.quote?.min_out);
    } catch {
      return 0n;
    }
  })();
  if (minOut <= 0n) fail("solana_swap.intent", "the plan carries no minimum output");

  // The disclosed fee: pinned account, sane rate, never above what the plan shows the owner.
  const feeBps = plan.fee?.bps ?? 0;
  const pinnedFee = SATO_FEE_ACCOUNTS[want.from.mint];
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) fail("solana_swap.fee_account", `the fee rate ${feeBps} bps is outside 0-${FEE_BPS_MAX}`);
  if (feeBps > 0 && plan.fee.account !== pinnedFee) fail("solana_swap.fee_account", `the fee account ${plan.fee?.account} is not the pinned ${want.from.symbol} referral account ${pinnedFee}`);
  if (feeBps === 0 && plan.fee?.account) fail("solana_swap.fee_account", "a fee account is set but the plan discloses no fee");
  const feeAccount = feeBps > 0 ? pinnedFee : null;
  const maxFee = (want.amountIn * BigInt(Math.max(0, feeBps)) + 9_999n) / 10_000n + (feeBps > 0 ? 1n : 0n);
  if (refusals.length) throw new Refused(refusals);

  // Decode, resolving the address lookup tables from the chain (the transaction alone cannot name its accounts).
  let altTables = {};
  let tx;
  try {
    tx = decodeTxBase64(plan.swap_transaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const tables = [...new Set((compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
    if (tables.length) altTables = await withTimeout(fetchAddressesForLookupTables(tables, r), 20_000);
  } catch (err) {
    throw new Refused([refuse("solana_swap.decode", `the transaction could not be decoded or its lookup tables read (${String(err.message).slice(0, 160)}); nothing was signed`)]);
  }
  const { refusals: staticRefusals, facts } = await inspectSolanaSwapTransaction(
    plan.swap_transaction,
    { agent: want.agent, mintIn: want.from.mint, amountIn: want.amountIn, feeAccount },
    altTables,
  );
  if (staticRefusals.length) throw new Refused(staticRefusals);

  // (f) Simulation: unsigned, fresh blockhash, then compare the agent's balances before and after.
  const watch = [...new Set([want.agent, await derivedAta(want.agent, USDC_MINT), await derivedAta(want.agent, WSOL_MINT), ...(feeAccount ? [feeAccount] : [])])];
  let sim;
  try {
    const res = await withTimeout(
      r.simulateTransaction(plan.swap_transaction, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { addresses: watch, encoding: "base64" },
      }).send(),
      20_000,
    );
    sim = res.value;
  } catch (err) {
    throw new Refused([refuse("solana_swap.sim_unavailable", `the simulation could not run (${String(err.message).slice(0, 160)}); a swap is not signed without one`)]);
  }
  if (sim.err) throw new Refused([refuse("solana_swap.sim_failed", `the simulation failed: ${jsonSafe(sim.err).slice(0, 200)}`)]);
  if (!sim.preBalances || !sim.postBalances || !sim.preTokenBalances || !sim.postTokenBalances) {
    throw new Refused([refuse("solana_swap.sim_unavailable", "the simulation returned no balances; a swap is not signed without them")]);
  }

  const loaded = sim.loadedAddresses ?? { writable: [], readonly: [] };
  const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (!sameList(loaded.writable ?? [], facts.lookup_loaded.writable) || !sameList(loaded.readonly ?? [], facts.lookup_loaded.readonly)) {
    throw new Refused([refuse("solana_swap.sim_inconsistent", "the accounts the simulation loaded do not match the lookup tables this kit read")]);
  }
  const view = { keys: facts.keys, preBalances: sim.preBalances, postBalances: sim.postBalances, preTokenBalances: sim.preTokenBalances, postTokenBalances: sim.postTokenBalances };
  const deltas = balanceDeltas(view, want.agent);
  // The `accounts` read-back must agree with the runtime's own balances (guards a mismatched response).
  const post0 = sim.accounts?.[0];
  if (!post0 || big(post0.lamports) !== big(sim.postBalances[0])) {
    throw new Refused([refuse("solana_swap.sim_inconsistent", "the simulated account state does not match the simulated balances")]);
  }

  const simFee = big(sim.fee);
  const feeCeiling = BASE_FEE_LAMPORTS + facts.priority_lamports;
  const rule = [];
  if (simFee > feeCeiling) rule.push(refuse("solana_swap.priority_fee", `the simulated network fee is ${simFee} lamports, above the ${feeCeiling} the instructions imply`));
  const overhead = simFee + deltas.created_usdc_rent;
  if (overhead > SOL_OVERHEAD_CAP_LAMPORTS) rule.push(refuse("solana_swap.sim_input_outflow", `fees and new-account rent total ${overhead} lamports, over the cap of ${SOL_OVERHEAD_CAP_LAMPORTS}`));

  let grossOut;
  if (want.from.symbol === "USDC") {
    const out = -deltas.usdc.delta;
    if (out > want.amountIn) rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${out} USDC units, more than the ${want.amountIn} being swapped`));
    grossOut = deltas.sol.delta + simFee; // SOL received, before the network fee
    if (deltas.created_usdc_rent > 0n) rule.push(refuse("solana_swap.sim_input_outflow", "a USDC swap should not create a USDC account"));
  } else {
    const out = -deltas.sol.delta;
    if (out > want.amountIn + overhead) rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${out} lamports, more than the ${want.amountIn} swapped plus ${overhead} of fees and rent`));
    grossOut = deltas.usdc.delta;
  }
  if (grossOut < minOut) rule.push(refuse("solana_swap.sim_output_inflow", `the simulation delivers ${grossOut} ${want.to.symbol} base units, below the minimum of ${minOut}`));
  for (const o of deltas.others) if (o.delta < 0n) rule.push(refuse("solana_swap.sim_other_asset", `the swap would reduce the agent's balance of ${o.mint} by ${-o.delta}`));

  let feeObserved = null;
  if (feeAccount) {
    const ch = tokenAccountChange(view, feeAccount);
    if (!ch || !ch.existed || ch.mint !== want.from.mint) {
      rule.push(refuse("solana_swap.fee_account", `the fee account ${feeAccount} is not an initialised ${want.from.symbol} token account in the simulation`));
    } else {
      feeObserved = ch.post - ch.pre;
      if (feeObserved < 0n || feeObserved > maxFee) rule.push(refuse("solana_swap.fee_account", `the simulated fee is ${feeObserved} ${want.from.symbol} base units, outside the disclosed 0 to ${maxFee}`));
    }
  }
  if (rule.length) throw new Refused(rule);

  return {
    ok: true,
    programs: facts.programs.map((p) => ({ id: p, name: SWAP_PROGRAM_ALLOWLIST[p] })),
    lookup_tables: Object.keys(altTables).length,
    instruction_count: facts.instruction_count,
    priority_lamports: Number(facts.priority_lamports),
    simulated: {
      network_fee_lamports: simFee.toString(),
      input_outflow: (want.from.symbol === "USDC" ? -deltas.usdc.delta : -deltas.sol.delta).toString(),
      output_inflow: grossOut.toString(),
      min_out: minOut.toString(),
      created_usdc_rent_lamports: deltas.created_usdc_rent.toString(),
      fee_observed_units: feeObserved === null ? null : feeObserved.toString(),
      fee_disclosed_max_units: feeAccount ? maxFee.toString() : null,
    },
  };
}

// ---------------------------------------------------------------- execute

async function assertPlanFresh(plan, r, d) {
  const age = d.now() - plan.built_at;
  if (!(age >= 0) || age > PLAN_MAX_AGE_MS) throw new PlanStale(`the swap was built ${Math.round(age / 1000)} s ago and its blockhash is about to expire; rebuild it (nothing was signed)`);
  const height = Number(await withTimeout(r.getBlockHeight({ commitment: "confirmed" }).send()));
  if (plan.last_valid_block_height - height < MIN_BLOCKS_LEFT) throw new PlanStale(`the swap's blockhash has only ${plan.last_valid_block_height - height} blocks left; rebuild it (nothing was signed)`);
}

/** Where the agent ended up, from a confirmed transaction. Null when the chain read fails (never zero). */
async function actualOutput(sig, plan, r) {
  try {
    const t = await withTimeout(r.getTransaction(sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
    if (!t?.meta) return null;
    const loaded = t.meta.loadedAddresses ?? { writable: [], readonly: [] };
    const keys = [...t.transaction.message.accountKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
    const deltas = balanceDeltas({ keys, preBalances: t.meta.preBalances, postBalances: t.meta.postBalances, preTokenBalances: t.meta.preTokenBalances, postTokenBalances: t.meta.postTokenBalances }, plan.agent);
    return plan.to === "USDC" ? deltas.usdc.delta : deltas.sol.delta + big(t.meta.fee) + deltas.created_usdc_rent;
  } catch {
    return null;
  }
}

/**
 * Sign and send a verified plan, under the owner's limits. Same order as
 * `sendUsdc`: verify, reserve, sign, record the signature, broadcast, poll.
 *
 *   Refused     the limits (or the verification) said no; nothing signed
 *   PlanStale   the blockhash is too old; rebuild the plan; nothing reserved
 *   Rejected    the RPC's preflight refused it; it never went out; released
 *   Pending     it may have gone out: stays counted, do NOT retry
 *   Error       it failed onchain (released) or something failed before signing (released)
 *
 * deps: rpc, signer (default: the wallet's Solana key), policy (default: policy.json),
 * intent (default: the plan's own), usdNotional (default: plan.usd_estimate),
 * now, sleep, pollMs, maxPolls.
 */
export async function executeSolanaSwap(plan, deps = {}) {
  const d = withDefaults(deps);
  const r = d.rpc ?? defaultRpc();
  const usd = d.usdNotional ?? plan.usd_estimate;
  if (!(Number.isFinite(usd) && usd > 0)) throw new Error("no USD size for this swap; the limits cannot be checked");

  await assertPlanFresh(plan, r, d);
  const verification = await verifySolanaSwapPlan(plan, d.intent, d);

  const entry = await reserve(d.policy ?? loadPolicy(), {
    kind: "swap",
    chain: "solana",
    usd,
    to: "jupiter",
    asset_in: plan.from,
    asset_out: plan.to,
    amount_in: plan.amount_in,
    min_out: plan.quote.min_out,
  });

  let signed;
  try {
    // The clock may have run while verifying and reserving: look again right before signing.
    await assertPlanFresh(plan, r, d);
    const signer = d.signer ?? (await createKeyPairSignerFromBytes(solanaSecret()));
    if (signer.address !== plan.agent) throw new Error("the signing key is not the agent the plan was built for");
    const tx = await signTransaction([signer.keyPair], decodeTxBase64(plan.swap_transaction));
    signed = { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
  } catch (err) {
    release(entry, "failed before signing; nothing sent", { error: String(err.message) });
    throw err;
  }

  const { wire, signature } = signed;
  record({ id: entry.id, status: "signed", tx: signature });
  try {
    await withTimeout(r.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  } catch (err) {
    const msg = `${err.message} ${jsonSafe(err.context ?? {})}`;
    if (/PREFLIGHT_FAILURE|preflight|-32002|Blockhash not found|insufficient (funds|lamports)/i.test(msg)) {
      release(entry, "rejected by the RPC preflight; never sent", { tx: signature, error: String(err.message) });
      throw new Rejected(`the RPC refused ${signature}: ${err.message}`);
    }
    throw new Pending(`broadcast of ${signature} reported an error (${err.message}).`, { tx: signature, explorer: explorer(signature) });
  }

  const pollMs = d.pollMs ?? 1500;
  for (let i = 0; i < (d.maxPolls ?? 40); i++) {
    await d.sleep(pollMs);
    let s;
    try {
      s = (await withTimeout(r.getSignatureStatuses([signature]).send())).value[0];
    } catch {
      continue; // a flaky status read is not a failed transaction
    }
    if (s?.err) {
      release(entry, "transaction failed onchain", { tx: signature });
      throw new Error(`transaction failed onchain: ${explorer(signature)}`);
    }
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      const out = await actualOutput(signature, plan, r);
      record({ id: entry.id, status: "confirmed", tx: signature, amount_out: out === null ? null : out.toString() });
      return {
        tx: signature,
        explorer: explorer(signature),
        usd,
        asset_in: plan.from,
        asset_out: plan.to,
        amount_in: plan.amount_in,
        amount_out: out === null ? null : out.toString(),
        min_out: plan.quote.min_out,
        fee: plan.fee,
        verification,
      };
    }
  }
  throw new Pending(`${signature} was sent but not confirmed within ${Math.round(((d.maxPolls ?? 40) * pollMs) / 1000)} s.`, { tx: signature, explorer: explorer(signature) });
}

// ---------------------------------------------------------------- dry run

/**
 * Plan and verify; reserve nothing, sign nothing, send nothing. Calls Jupiter's
 * public quote/build API and the RPC's simulation, both read-only. The returned
 * plan omits the transaction bytes unless `deps.includeTransaction` is set.
 */
export async function dryRunSolanaSwap(params, deps = {}) {
  const d = withDefaults(deps);
  const plan = await planSolanaSwap(params, d);
  const verification = await verifySolanaSwapPlan(plan, { agent: plan.agent, from: plan.from, to: plan.to, amount_in: plan.amount_in }, d);
  const { swap_transaction: tx, ...rest } = plan;
  return { dry_run: true, chain: "solana", plan: d.includeTransaction ? plan : rest, verification, simulated: true, usd: plan.usd_estimate };
}
