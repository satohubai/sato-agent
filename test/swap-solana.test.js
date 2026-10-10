// Solana swaps (USDC <-> SOL via Jupiter), offline.
//
// The fixtures in test/fixtures/swap-solana/ are REAL mainnet responses for a
// large, funded public wallet (recorded by record.mjs with Jupiter's public
// quote/build API and the public RPC; nothing signed, nothing sent): the quote,
// the built v0 transaction with its address lookup tables, and the RPC's
// unsigned simulation. Execution tests re-address a fixture to a throwaway key.
//
// SATO_AGENT_LIVE_READ=1 adds read-only checks against mainnet (Jupiter's
// quote/build endpoints and the RPC's simulateTransaction; still nothing signed).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  address,
  fetchAddressesForLookupTables,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  createSolanaRpc,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  pipe,
  AccountRole,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { freshHome } from "./helpers.js";
import { compile, fetchJupiterIdl } from "./fixtures/swap-solana/idl.mjs";

freshHome();
const { setPolicy } = await import("../src/policy.js");
const { entries, spentLast24h } = await import("../src/ledger.js");
const { Pending, Refused, Rejected } = await import("../src/errors.js");
const { USDC_MINT, TOKEN_2022_PROGRAM } = await import("../src/solana.js");
const S = await import("../src/swap/solana.js");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/swap-solana/${name}.json`, import.meta.url), "utf8"));
const USDC_SOL = fixture("usdc-to-sol");
const SOL_USDC = fixture("sol-to-usdc");
const NOFEE = fixture("usdc-to-sol-nofee");
// Long-tail tokens, recorded from mainnet 2026-10-09 (record.mjs): BONK is a classic SPL mint, SI a Token-2022 mint with a
// 1% transfer fee; WIF and GOAT are routed through other tokens (two and three hops); the "fresh" ones are for a wallet that
// holds nothing, so they are only decoded and inspected (they show the account creations).
const BONK_BUY = fixture("usdc-to-bonk");
const BONK_SELL = fixture("bonk-to-usdc");
const SOL_BONK = fixture("sol-to-bonk");
const BONK_SOL = fixture("bonk-to-sol");
const WIF_BUY = fixture("usdc-to-wif-multihop");
const GOAT_SELL = fixture("goat-to-usdc-multihop");
const SI_BUY = fixture("usdc-to-si-token2022");
const SI_SELL = fixture("si-to-usdc-token2022");
const FRESH_BUY = fixture("usdc-to-bonk-fresh");
const FRESH_SELL = fixture("bonk-to-sol-fresh");
const TAIL_FIXTURES = [BONK_BUY, BONK_SELL, SOL_BONK, BONK_SOL, WIF_BUY, GOAT_SELL, SI_BUY, SI_SELL];
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SI = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP";
const JUP_IDL = fixture("jupiter-idl");
const WALLET = USDC_SOL.wallet;
const WSOL = S.WSOL_MINT;
const rules = (err) => err.refusals.map((r) => r.rule);

// ----------------------------------------------------------------- fakes

function fakeFetch(fx, { onRequest, edit } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    onRequest?.(url, init);
    const path = String(url).replace(S.JUPITER_API, "");
    const rec = fx.http.find((h) => (path.startsWith("/quote") ? h.url.startsWith("/quote") : h.url === path));
    let text = rec.text;
    if (edit) text = edit(path, text);
    return new Response(text, { status: rec.status });
  };
  return { fetch, calls };
}

/** An RPC that replays the recorded lookup tables and simulation, with knobs. */
function fakeRpc(fx, o = {}) {
  const recorded = (method) => fx.rpc.find((c) => c.method === method).result;
  const sent = [];
  const rpc = {
    getMultipleAccounts: (addrs) => ({
      send: async () => {
        const rec = recorded("getMultipleAccounts");
        // Recorded for the same table list; serve it for any request of that list.
        return structuredClone(rec);
      },
    }),
    // A mint (or any account) read: served from what was recorded for that address, or from `o.accounts` (address -> RPC entry or null).
    getAccountInfo: (addr) => ({
      send: async () => {
        o.onGetAccountInfo?.(String(addr));
        if (o.accountsThrow) throw new Error(o.accountsThrow);
        if (o.accounts && String(addr) in o.accounts) return { context: { slot: 1n }, value: structuredClone(o.accounts[String(addr)]) };
        const rec = fx.rpc.find((c) => c.method === "getAccountInfo" && c.args[0] === String(addr));
        if (!rec) throw new Error(`no recorded getAccountInfo for ${addr}`);
        return structuredClone(rec.result);
      },
    }),
    simulateTransaction: (wire, opts) => ({
      send: async () => {
        o.onSimulate?.(wire, opts);
        if (o.simThrows) throw new Error(o.simThrows);
        const res = structuredClone(recorded("simulateTransaction"));
        o.editSim?.(res.value);
        return res;
      },
    }),
    isBlockhashValid: (blockhash, opts) => ({
      send: async () => {
        o.onBlockhashCheck?.(blockhash, opts);
        if (o.blockhashThrows) throw new Error(o.blockhashThrows);
        return { context: { slot: 1n }, value: typeof o.blockhashValid === "function" ? o.blockhashValid() : (o.blockhashValid ?? true) };
      },
    }),
    sendTransaction: (wire, opts) => ({
      send: async () => {
        sent.push({ wire, opts });
        if (o.sendThrows) throw o.sendThrows;
        return "sig";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        const next = (o.statuses ?? [{ confirmationStatus: "confirmed", err: null }]).shift?.() ?? { confirmationStatus: "confirmed", err: null };
        if (next === "throw") throw new Error("flaky status read");
        return { value: [next === "none" ? null : next] };
      },
    }),
    getTransaction: () => ({
      send: async () => {
        if (o.txThrows) throw new Error("not indexed yet");
        const sim = recorded("simulateTransaction").value;
        return {
          transaction: { message: { accountKeys: o.accountKeys } },
          meta: { fee: sim.fee, preBalances: sim.preBalances, postBalances: sim.postBalances, preTokenBalances: sim.preTokenBalances, postTokenBalances: sim.postTokenBalances, loadedAddresses: sim.loadedAddresses },
        };
      },
    }),
  };
  return { rpc, sent };
}

// ----------------------------------------------------------------- transaction surgery

const b64e = getBase64Encoder();
const b64d = getBase64Decoder();
function mutate(tx64, fn) {
  const tx = getTransactionDecoder().decode(b64e.encode(tx64));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  fn(compiled);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
  const n = compiled.header.numSignerAccounts;
  const signatures = Object.fromEntries(compiled.staticAccounts.slice(0, n).map((a) => [a, null]));
  return b64d.decode(getTransactionEncoder().encode({ messageBytes, signatures }));
}
const compiledOf = (tx64) => getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(b64e.encode(tx64)).messageBytes);
const indexOf = (c, addr) => c.staticAccounts.indexOf(addr);

/** The fixture plan, rebuilt through planSolanaSwap against the recorded Jupiter replies. */
async function planFrom(fx, extra = {}) {
  const { fetch } = fakeFetch(fx);
  return S.planSolanaSwap(fx.request, { agent: fx.wallet, satoFeeBps: fx.request.satoFeeBps, fetch, rpc: fakeRpc(fx).rpc, minGapMs: 0, now: () => fx.built_at, ...extra });
}
const verifyDeps = (fx, o) => ({ rpc: fakeRpc(fx, o).rpc, minGapMs: 0 });
const intentOf = (fx) => ({ agent: fx.wallet, from: fx.request.from, to: fx.request.to, amount: fx.request.amount });
const withTx = (plan, tx) => ({ ...plan, swap_transaction: tx });

async function refusedBy(plan, fx, o) {
  try {
    await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx, o));
  } catch (err) {
    assert.ok(err instanceof Refused, `expected Refused, got ${err.stack}`);
    return rules(err);
  }
  assert.fail("expected a refusal");
}

/** Every refusal (rule + message) for a plan that fails verification. */
async function refusalsOf(plan, fx, o) {
  try {
    await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx, o));
  } catch (err) {
    assert.ok(err instanceof Refused, `expected Refused, got ${err.stack}`);
    return err.refusals;
  }
  assert.fail("expected a refusal");
}

// Jupiter's route instruction, taken apart and put back. The recorded builds end exactly
// where the arguments end (route plan, then in_amount u64, quoted_out u64, slippage u16, fee u8).
const jupiterIxs = (c) => c.instructions.filter((i) => c.staticAccounts[i.programAddressIndex] === S.JUPITER_PROGRAM);
const ARGS = 19;
function readArgs(ix) {
  const d = Buffer.from(ix.data);
  const t = d.length - ARGS;
  return { inAmount: d.readBigUInt64LE(t), quotedOut: d.readBigUInt64LE(t + 8), slippageBps: d.readUInt16LE(t + 16), feeBps: d[t + 18] };
}
function writeArgs(ix, a) {
  const d = Buffer.from(ix.data);
  const t = d.length - ARGS;
  if (a.inAmount !== undefined) d.writeBigUInt64LE(BigInt(a.inAmount), t);
  if (a.quotedOut !== undefined) d.writeBigUInt64LE(BigInt(a.quotedOut), t + 8);
  if (a.slippageBps !== undefined) d.writeUInt16LE(a.slippageBps, t + 16);
  if (a.feeBps !== undefined) d[t + 18] = a.feeBps;
  ix.data = new Uint8Array(d);
}
/** Tamper with Jupiter's arguments in a plan's transaction. */
const withArgs = (plan, a) => withTx(plan, mutate(plan.swap_transaction, (c) => writeArgs(jupiterIxs(c)[0], a)));
/** Point one of Jupiter's account slots at an account that is not the right one (added to the transaction as a read-only key). */
function withAccount(plan, slot, addr) {
  return withTx(plan, mutate(plan.swap_transaction, (c) => {
    const old = c.staticAccounts.length;
    c.staticAccounts.push(addr);
    c.header.numReadonlyNonSignerAccounts += 1;
    // Keys loaded from lookup tables come after the static ones: move them up by one.
    for (const i of c.instructions) {
      if (i.accountIndices) i.accountIndices = i.accountIndices.map((x) => (x >= old ? x + 1 : x));
      if (i.programAddressIndex >= old) i.programAddressIndex += 1;
    }
    jupiterIxs(c)[0].accountIndices[slot] = old;
  }));
}
const randomAddress = async () => (await generateKeyPairSigner()).address;

/** Edit the simulated state of the agent's SOL (keeps the account read-back consistent). */
const shiftAgentLamports = (delta) => (v) => {
  v.postBalances[0] = (BigInt(v.postBalances[0]) + BigInt(delta)).toString();
  v.accounts[0].lamports = v.postBalances[0];
};

// ----------------------------------------------------------------- pins

test("pins: the fee accounts re-derive from Sato's referral account, and the program ids are the right ones", async () => {
  const enc = getAddressEncoder();
  for (const [mint, expected] of Object.entries(S.SATO_FEE_ACCOUNTS)) {
    const [pda] = await getProgramDerivedAddress({
      programAddress: address("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3"),
      seeds: [new TextEncoder().encode("referral_ata"), enc.encode(address(S.SATO_REFERRAL_ACCOUNT)), enc.encode(address(mint))],
    });
    assert.equal(pda, expected, `fee account for ${mint}`);
  }
  assert.equal(S.SATO_FEE_ACCOUNTS[USDC_MINT], "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo", "the USDC account Sato Hub's own tests pin");
  assert.deepEqual(Object.keys(S.SWAP_PROGRAM_ALLOWLIST).sort(), [
    "11111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]);
  assert.equal(TOKEN_2022_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  assert.ok(Object.isFrozen(S.SATO_FEE_ACCOUNTS) && Object.isFrozen(S.SWAP_PROGRAM_ALLOWLIST));
});

// ----------------------------------------------------------------- plan

test("plan: USDC -> SOL asks Jupiter for the quote, then the build, with the pinned fee account and a capped priority fee", async () => {
  const { fetch, calls } = fakeFetch(USDC_SOL);
  const plan = await S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, feeAccount: S.SATO_FEE_ACCOUNTS[USDC_MINT], fetch, minGapMs: 0, now: () => USDC_SOL.built_at, userAgent: "SatoHub-swap-dev/1.0" });
  assert.equal(calls.length, 2);
  const quote = new URL(calls[0].url);
  assert.equal(quote.origin + quote.pathname, "https://api.jup.ag/swap/v1/quote");
  assert.equal(quote.searchParams.get("inputMint"), USDC_MINT);
  assert.equal(quote.searchParams.get("outputMint"), WSOL);
  assert.equal(quote.searchParams.get("amount"), "25000000");
  assert.equal(quote.searchParams.get("slippageBps"), "50");
  assert.equal(quote.searchParams.get("platformFeeBps"), "15");
  assert.equal(quote.searchParams.get("onlyDirectRoutes"), "true", "no route through a third token: the kit refuses to create accounts for one");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "https://api.jup.ag/swap/v1/swap");
  assert.equal(calls[1].init.method, "POST");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.userPublicKey, WALLET);
  assert.equal(body.feeAccount, "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo");
  assert.equal(body.wrapAndUnwrapSol, true);
  assert.equal(body.useSharedAccounts, false, "the plain route instruction is asked for: it is the only one the kit decodes");
  assert.equal(body.dynamicComputeUnitLimit, true);
  assert.equal(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports, 100_000);
  assert.ok(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports <= S.PRIORITY_MAX_LAMPORTS);
  for (const c of calls) {
    assert.ok(c.init.signal instanceof AbortSignal, "a timeout on every request");
    assert.equal(c.init.headers["user-agent"], "SatoHub-swap-dev/1.0");
  }
  assert.equal(plan.from, "USDC");
  assert.equal(plan.to, "SOL");
  assert.equal(plan.amount_in, "25000000");
  assert.equal(plan.fee.account, "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo");
  assert.equal(plan.fee.max_units, "37500");
  assert.ok(BigInt(plan.quote.min_out) < BigInt(plan.quote.out_amount));
  assert.equal(plan.usd_estimate, 25);
  assert.match(plan.disclosure.join("\n"), /Sato Hub fee: 0\.15% of the USDC you swap \(up to 0\.0375 USDC\).*FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo.*same transaction/);
  assert.match(plan.disclosure.join("\n"), /at least [\d.]+ SOL/);
  assert.doesNotMatch(plan.disclosure.join("\n"), /\b(safe|secure|trusted|guaranteed?)\b/i);
  // The minimum shown is the quote less the owner's slippage, rounded down: what the transaction enforces.
  assert.equal(plan.quote.min_out, S.minOutFor(plan.quote.out_amount, 50).toString());
  assert.match(plan.disclosure.join("\n"), /That minimum is written into the transaction, and this kit reads it back out of the transaction and checks it before signing\. If the swap cannot deliver it, the transaction fails and nothing is swapped\./);
});

test("plan: SOL -> USDC takes the fee in wrapped SOL, to the pinned wSOL referral account", async () => {
  const { fetch, calls } = fakeFetch(SOL_USDC);
  const plan = await S.planSolanaSwap(SOL_USDC.request, { agent: WALLET, satoFeeBps: 15, fetch, minGapMs: 0 });
  assert.equal(JSON.parse(calls[1].init.body).feeAccount, "HnyyFHhp3LQ6VfRn1AhPHSwboYYQa1HT7REaMfzsA8gx");
  assert.equal(plan.amount_in, "500000000");
  assert.equal(plan.fee.mint, WSOL);
  assert.equal(plan.fee.max_units, "750000");
  assert.equal(plan.usd_estimate, Number(plan.quote.out_amount) / 1e6, "USD size is read off the USDC leg");
  assert.match(plan.fee.text, /0\.00075 SOL/);
});

test("plan: amounts are strict (no rounding), an asset is USDC, SOL or a mint address, slippage is bounded", async () => {
  const base = { agent: WALLET, satoFeeBps: 15, fetch: fakeFetch(USDC_SOL).fetch, minGapMs: 0 };
  const bad = (p, re) => assert.rejects(S.planSolanaSwap(p, base), re);
  await bad({ from: "USDC", to: "SOL", amount: "1.0000001" }, /not a USDC amount/);
  await bad({ from: "SOL", to: "USDC", amount: "0.0000000001" }, /not a SOL amount/);
  await bad({ from: "USDC", to: "SOL", amount: "1e3" }, /not a USDC amount/);
  await bad({ from: "USDC", to: "SOL", amount: "0" }, /not a positive USDC amount/);
  await bad({ from: "SOL", to: "USDC", amount: "-1" }, /not a SOL amount/);
  await bad({ from: "USDC", to: "USDC", amount: "1" }, /two different assets/);
  await bad({ from: "USDC", to: "BONK", amount: "1" }, /"BONK" is not USDC, SOL or a Solana mint address/);
  await bad({ from: "USDC", to: "SOL", amount: "1", slippageBps: 0 }, /slippage/);
  await bad({ from: "USDC", to: "SOL", amount: "1", slippageBps: 501 }, /slippage/);
  await bad({ from: "USDC", to: "SOL", amount: "1", slippageBps: 12.5 }, /slippage/);
  assert.equal(S.solLamports("0.000000001"), 1n);
  assert.equal(S.solLamports("1.5"), 1_500_000_000n);
});

test("plan: the Sato fee rate is required; a fee account other than the pinned one is refused; no fee sends no fee parameters", async () => {
  const mk = (extra) => ({ agent: WALLET, fetch: fakeFetch(USDC_SOL).fetch, minGapMs: 0, ...extra });
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, mk({})), /satoFeeBps is required/);
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, mk({ satoFeeBps: 101 })), /satoFeeBps/);
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, mk({ satoFeeBps: 15, feeAccount: "11111111111111111111111111111111" })), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.fee_account_unpinned");

  // No fee: the quote carries none and the build gets no feeAccount.
  const calls = [];
  const noFee = fakeFetch(USDC_SOL, {
    onRequest: (u, init) => calls.push({ u: String(u), body: init.body }),
    edit: (path, text) => (path.startsWith("/quote") ? JSON.stringify({ ...JSON.parse(text), platformFee: null }) : text),
  });
  const plan = await S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 0, fetch: noFee.fetch, minGapMs: 0 });
  assert.equal(new URL(calls[0].u).searchParams.has("platformFeeBps"), false);
  assert.equal("feeAccount" in JSON.parse(calls[1].body), false);
  assert.equal(plan.fee.bps, 0);
  assert.equal(plan.fee.account, null);
  assert.match(plan.disclosure.join("\n"), /No Sato Hub fee/);
});

test("plan: a quote that does not match the request, or a failed build, is an error before anything is signed", async () => {
  const mutateQuote = (fn) => fakeFetch(USDC_SOL, { edit: (path, text) => (path.startsWith("/quote") ? JSON.stringify(fn(JSON.parse(text))) : text) });
  const run = (f) => S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: f.fetch, minGapMs: 0 });
  await assert.rejects(run(mutateQuote((q) => ({ ...q, outputMint: USDC_MINT }))), /does not match the request/);
  await assert.rejects(run(mutateQuote((q) => ({ ...q, inAmount: "24999999" }))), /different input amount/);
  await assert.rejects(run(mutateQuote((q) => ({ ...q, otherAmountThreshold: "1" }))), /looser than the slippage/);
  await assert.rejects(run(mutateQuote((q) => ({ ...q, platformFee: null }))), /platform fee was not applied/);
  await assert.rejects(run(mutateQuote((q) => ({ ...q, slippageBps: 300 }))), /different slippage/);
  const badBuild = fakeFetch(USDC_SOL, { edit: (path, text) => (path === "/swap" ? JSON.stringify({ ...JSON.parse(text), simulationError: { error: "x" } }) : text) });
  await assert.rejects(run(badBuild), /Jupiter's own simulation/);
  const noTx = fakeFetch(USDC_SOL, { edit: (path, text) => (path === "/swap" ? "{}" : text) });
  await assert.rejects(run(noTx), /no transaction/);
});

test("plan: HTTP errors, a 429 (retried once, after a pause), a timeout and non-JSON are handled", async () => {
  let n = 0;
  const sleeps = [];
  const flaky = async (url, init) => {
    n++;
    if (n === 1) return new Response("slow down", { status: 429 });
    return fakeFetch(USDC_SOL).fetch(url, init);
  };
  const plan = await S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: flaky, minGapMs: 0, sleep: async (ms) => sleeps.push(ms) });
  assert.ok(plan.swap_transaction);
  assert.ok(sleeps.some((ms) => ms >= 3000), "paused before the retry");

  const always429 = async () => new Response("slow down", { status: 429 });
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: always429, minGapMs: 0, sleep: async () => {} }), /HTTP 429.*one request every 2 s/);
  const timeout = async () => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  };
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: timeout, minGapMs: 0 }), /timed out after 20 s\); nothing was signed/);
  const html = async () => new Response("<html>", { status: 200 });
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: html, minGapMs: 0 }), /not JSON/);
  const five = async () => new Response("bad gateway", { status: 502 });
  await assert.rejects(S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: five, minGapMs: 0 }), /HTTP 502/);
});

test("plan: the keyless rate limit is respected between the quote and the build", async () => {
  let t = 1_000_000;
  const waits = [];
  const f = fakeFetch(USDC_SOL);
  // Reset the module's clock by making the first call look old.
  await S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch: f.fetch, now: () => (t += 100), sleep: async (ms) => { waits.push(ms); t += ms; } });
  assert.ok(waits.length >= 1 && waits.every((ms) => ms <= 2100), `waited ${waits}`);
});

// ----------------------------------------------------------------- verify: passes

test("verify: the recorded USDC -> SOL transaction passes (lookup tables resolved from the chain), with the simulated numbers", async () => {
  const plan = await planFrom(USDC_SOL);
  const v = await S.verifySolanaSwapPlan(plan, intentOf(USDC_SOL), verifyDeps(USDC_SOL));
  assert.equal(v.ok, true);
  assert.ok(v.lookup_tables >= 1, "at least one address lookup table");
  assert.ok(v.programs.some((p) => p.name === "Jupiter v6"));
  assert.ok(v.programs.every((p) => S.SWAP_PROGRAM_ALLOWLIST[p.id]));
  assert.equal(v.simulated.input_outflow, "25000000");
  assert.ok(BigInt(v.simulated.output_inflow) >= BigInt(plan.quote.min_out));
  assert.equal(v.simulated.fee_observed_units, "37500", "15 bps of 25 USDC, observed in the fee account");
  assert.ok(v.priority_lamports <= S.PRIORITY_MAX_LAMPORTS);
});

test("verify: the recorded SOL -> USDC transaction passes, and the fee shows up in the wSOL fee account", async () => {
  const plan = await planFrom(SOL_USDC);
  const v = await S.verifySolanaSwapPlan(plan, intentOf(SOL_USDC), verifyDeps(SOL_USDC));
  assert.equal(v.ok, true);
  assert.equal(v.simulated.fee_observed_units, "750000", "15 bps of 0.5 SOL");
  assert.ok(BigInt(v.simulated.input_outflow) - 500_000_000n <= S.SOL_OVERHEAD_CAP_LAMPORTS);
  assert.ok(BigInt(v.simulated.output_inflow) >= BigInt(plan.quote.min_out));
});

test("verify: the simulation is asked for exactly what the contract says", async () => {
  const plan = await planFrom(USDC_SOL);
  let seen;
  await S.verifySolanaSwapPlan(plan, intentOf(USDC_SOL), verifyDeps(USDC_SOL, { onSimulate: (wire, opts) => (seen = { wire, opts }) }));
  assert.equal(seen.opts.sigVerify, false);
  assert.equal(seen.opts.replaceRecentBlockhash, true);
  assert.equal(seen.opts.encoding, "base64");
  assert.equal(seen.opts.accounts.encoding, "base64");
  const ata = (await findAssociatedTokenPda({ owner: address(WALLET), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  assert.ok(seen.opts.accounts.addresses.includes(WALLET) && seen.opts.accounts.addresses.includes(ata));
  assert.equal(seen.wire, plan.swap_transaction);
});

// ----------------------------------------------------------------- verify: mutated fixtures refuse

test("verify refuses: a foreign program injected", async () => {
  const plan = await planFrom(USDC_SOL);
  const tx = mutate(plan.swap_transaction, (c) => {
    c.staticAccounts[indexOf(c, "ComputeBudget111111111111111111111111111111")] = "Vote111111111111111111111111111111111111111";
  });
  assert.deepEqual([...new Set(await refusedBy(withTx(plan, tx), USDC_SOL))], ["solana_swap.program_allowlist"]);
});

test("verify refuses: the fee payer changed", async () => {
  const plan = await planFrom(USDC_SOL);
  const other = (await generateKeyPairSigner()).address;
  const tx = mutate(plan.swap_transaction, (c) => {
    c.staticAccounts[0] = other;
  });
  const got = await refusedBy(withTx(plan, tx), USDC_SOL);
  assert.ok(got.includes("solana_swap.fee_payer"), got.join());
});

test("verify refuses: an extra signer", async () => {
  const plan = await planFrom(USDC_SOL);
  const tx = mutate(plan.swap_transaction, (c) => {
    c.header.numSignerAccounts = 2;
  });
  const got = await refusedBy(withTx(plan, tx), USDC_SOL);
  assert.ok(got.includes("solana_swap.signers"), got.join());
});

test("verify refuses: a SetAuthority (and an Approve) added at the top level", async () => {
  const plan = await planFrom(USDC_SOL);
  const withToken = (data) =>
    mutate(plan.swap_transaction, (c) => {
      c.instructions.push({ programAddressIndex: indexOf(c, TOKEN_PROGRAM_ADDRESS), accountIndices: [1, 0], data: Uint8Array.from(data) });
    });
  const setAuthority = withToken([6, 2, 1, ...new Uint8Array(32).fill(7)]);
  assert.ok((await refusedBy(withTx(plan, setAuthority), USDC_SOL)).includes("solana_swap.token_authority"));
  const approve = withToken([4, 255, 255, 255, 255, 255, 255, 255, 255]);
  assert.ok((await refusedBy(withTx(plan, approve), USDC_SOL)).includes("solana_swap.token_authority"));
  const transfer = withToken([3, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok((await refusedBy(withTx(plan, transfer), USDC_SOL)).includes("solana_swap.token_instruction"));
});

test("verify refuses: a priority fee over the cap, a second price instruction, and a close into someone else", async () => {
  const plan = await planFrom(USDC_SOL);
  const price = (micro) => (c) => {
    const ix = c.instructions.find((i) => c.staticAccounts[i.programAddressIndex].startsWith("ComputeBudget") && i.data[0] === 3);
    const d = new Uint8Array(9);
    d[0] = 3;
    new DataView(d.buffer).setBigUint64(1, micro, true);
    ix.data = d;
  };
  assert.ok((await refusedBy(withTx(plan, mutate(plan.swap_transaction, price(10_000_000_000n))), USDC_SOL)).includes("solana_swap.priority_fee"));
  const twice = mutate(plan.swap_transaction, (c) => {
    c.instructions.push({ ...c.instructions.find((i) => c.staticAccounts[i.programAddressIndex].startsWith("ComputeBudget") && i.data[0] === 3) });
  });
  assert.ok((await refusedBy(withTx(plan, twice), USDC_SOL)).includes("solana_swap.priority_fee"));
  const closeElsewhere = mutate(plan.swap_transaction, (c) => {
    const close = c.instructions.find((i) => c.staticAccounts[i.programAddressIndex] === TOKEN_PROGRAM_ADDRESS && i.data[0] === 9);
    close.accountIndices = [close.accountIndices[0], 1, 0];
  });
  assert.ok((await refusedBy(withTx(plan, closeElsewhere), USDC_SOL)).includes("solana_swap.token_close_destination"));
  // The same close, left alone (to the agent), is what the real transaction does and passes.
  await S.verifySolanaSwapPlan(plan, intentOf(USDC_SOL), verifyDeps(USDC_SOL));
});

test("verify refuses: a plan for the wrong agent, assets, amount, fee account, or no minimum", async () => {
  const plan = await planFrom(USDC_SOL);
  const other = (await generateKeyPairSigner()).address;
  const run = (p, intent = intentOf(USDC_SOL)) => S.verifySolanaSwapPlan(p, intent, verifyDeps(USDC_SOL)).then(() => assert.fail("passed"), (e) => rules(e));
  assert.ok((await run({ ...plan, agent: other })).includes("solana_swap.intent"));
  assert.ok((await run(plan, { ...intentOf(USDC_SOL), amount: "24" })).includes("solana_swap.intent"));
  assert.ok((await run(plan, { ...intentOf(USDC_SOL), to: "USDC" })).includes("solana_swap.intent"));
  assert.ok((await run({ ...plan, quote: { ...plan.quote, min_out: "0" } })).includes("solana_swap.intent"));
  assert.ok((await run({ ...plan, fee: { ...plan.fee, account: other } })).includes("solana_swap.fee_account"));
  assert.ok((await run({ ...plan, fee: { ...plan.fee, bps: 5000 } })).includes("solana_swap.fee_account"));
  assert.ok((await run({ ...plan, swap_transaction: "not base64!" })).includes("solana_swap.decode"));
  // A lookup table that cannot be read leaves the transaction undecodable: refused, not guessed.
  const noTables = { rpc: { getMultipleAccounts: () => ({ send: async () => { throw new Error("rpc down"); } }) }, minGapMs: 0 };
  await assert.rejects(S.verifySolanaSwapPlan(plan, intentOf(USDC_SOL), noTables), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.decode");
});

// ----------------------------------------------------------------- verify: Jupiter's own instruction is read, not trusted
//
// The reviewer's finding, proven against a mainnet simulation on 2026-10-09: a fresh build
// rewritten to quoted_out=1 and slippage_bps=10000 simulated fine and used to verify,
// leaving a transaction whose onchain floor is one lamport. Every case below starts from a
// recorded REAL Jupiter build and changes one thing in Jupiter's instruction.

test("verify reads Jupiter's route instruction out of the transaction, and an honest build agrees with everything the plan says", async () => {
  for (const [fx, fee] of [[USDC_SOL, 15], [SOL_USDC, 15], [NOFEE, 0]]) {
    const plan = await planFrom(fx);
    const route = S.decodeJupiterRoute(jupiterIxs(compiledOf(plan.swap_transaction))[0].data);
    assert.equal(route.inAmount.toString(), plan.amount_in);
    assert.equal(route.platformFeeBps, fee);
    assert.equal(route.slippageBps, 50);
    // The plan's minimum is the quote less slippage, rounded down: what the transaction enforces.
    assert.equal(S.minOutFor(route.quotedOut, route.slippageBps).toString(), plan.quote.min_out);
    assert.equal(route.quotedOut.toString(), plan.quote.out_amount, "Jupiter quoted the same output in the transaction");
    const v = await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx));
    assert.deepEqual({ ...v.jupiter, route_steps: undefined }, {
      instruction: "route", route_steps: undefined, in_amount: plan.amount_in, quoted_out: plan.quote.out_amount, slippage_bps: 50, platform_fee_bps: fee, enforced_min_out: plan.quote.min_out,
    });
  }
});

test("verify refuses: quoted_out rewritten to 1 (the onchain floor would be 1 lamport)", async () => {
  const plan = await planFrom(USDC_SOL);
  const got = await refusalsOf(withArgs(plan, { quotedOut: 1n }), USDC_SOL);
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.min_out_not_enforced"]);
  assert.match(got[0].message, /only requires 0 base units.*below the \d+ shown to the owner/);
});

test("verify refuses: slippage_bps rewritten to 10000 (the floor is nothing at all)", async () => {
  const plan = await planFrom(USDC_SOL);
  const got = await refusalsOf(withArgs(plan, { slippageBps: 10_000 }), USDC_SOL);
  assert.ok(got.every((r) => r.rule === "solana_swap.min_out_not_enforced"), got.map((r) => r.rule).join());
  assert.ok(got.some((r) => /allows 10000 bps of slippage; the limit for this swap is 50 bps/.test(r.message)));
  assert.ok(got.some((r) => /only requires 0 base units/.test(r.message)));
});

test("verify refuses: the reviewer's tamper (quoted_out=1 AND slippage_bps=10000) on both directions", async () => {
  for (const fx of [USDC_SOL, SOL_USDC, NOFEE]) {
    const plan = await planFrom(fx);
    const rules_ = await refusedBy(withArgs(plan, { quotedOut: 1n, slippageBps: 10_000 }), fx);
    assert.ok(rules_.includes("solana_swap.min_out_not_enforced"), rules_.join());
  }
});

test("verify refuses: slippage_bps above the request, even when the quoted output is raised so the floor still looks right", async () => {
  const plan = await planFrom(USDC_SOL);
  const min = BigInt(plan.quote.min_out);
  // 60 bps allowed, quoted output scaled up so floor(quoted x 9940 / 10000) is still >= the minimum shown.
  const quotedOut = (min * 10_000n) / 9_940n + 2n;
  assert.ok(S.minOutFor(quotedOut, 60) >= min);
  const got = await refusalsOf(withArgs(plan, { slippageBps: 60, quotedOut }), USDC_SOL);
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.min_out_not_enforced"]);
  assert.match(got[0].message, /allows 60 bps of slippage; the limit for this swap is 50 bps/);
  // Less slippage than asked for is fine (as long as the floor holds): the same build at 20 bps passes.
  const tighter = withArgs(plan, { slippageBps: 20 });
  assert.equal((await S.verifySolanaSwapPlan(tighter, intentOf(USDC_SOL), verifyDeps(USDC_SOL))).ok, true);
});

test("verify refuses: the owner's own slippage limit (intent.slippage_bps) is held to, whatever the plan says", async () => {
  const plan = await planFrom(USDC_SOL);
  const run = (intent) => S.verifySolanaSwapPlan(plan, { ...intentOf(USDC_SOL), ...intent }, verifyDeps(USDC_SOL)).then(() => assert.fail("passed"), (e) => rules(e));
  assert.ok((await run({ slippage_bps: 20 })).includes("solana_swap.min_out_not_enforced"), "the plan and transaction allow 50, the owner asked for 20");
  assert.ok((await run({ slippage_bps: 501 })).includes("solana_swap.intent"));
  assert.equal((await S.verifySolanaSwapPlan(plan, { ...intentOf(USDC_SOL), slippage_bps: 50, fee_bps: 15 }, verifyDeps(USDC_SOL))).ok, true);
  assert.ok((await run({ fee_bps: 3 })).includes("solana_swap.fee_not_as_disclosed"), "Sato Hub disclosed 3 bps, the plan charges 15");
});

test("verify refuses: a plan whose shown minimum is looser than its own quote less slippage, or a slippage over the kit's cap", async () => {
  const plan = await planFrom(USDC_SOL);
  const loose = { ...plan, quote: { ...plan.quote, min_out: "1" } };
  assert.ok((await refusedBy(withArgs(loose, { quotedOut: 1n }), USDC_SOL)).includes("solana_swap.min_out_not_enforced"), "quoted_out=1 is not 'enforced' just because the plan was edited to match");
  assert.ok((await refusedBy({ ...plan, quote: { ...plan.quote, slippage_bps: 501 } }, USDC_SOL)).includes("solana_swap.intent"));
});

test("verify refuses: platform_fee_bps changed in Jupiter's instruction", async () => {
  const plan = await planFrom(USDC_SOL);
  for (const feeBps of [0, 14, 16, 255]) {
    const got = await refusalsOf(withArgs(plan, { feeBps }), USDC_SOL);
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.fee_not_as_disclosed"], `fee ${feeBps}`);
    assert.match(got[0].message, new RegExp(`takes a platform fee of ${feeBps} bps; 15 bps was disclosed`));
  }
});

test("verify refuses: the fee paid to a stranger's account, with the pinned fee account still in the transaction", async () => {
  const stranger = await randomAddress();
  for (const [fx, pinned] of [[USDC_SOL, S.SATO_FEE_ACCOUNTS[USDC_MINT]], [SOL_USDC, S.SATO_FEE_ACCOUNTS[WSOL]]]) {
    const plan = await planFrom(fx);
    const got = await refusalsOf(withAccount(plan, 6, stranger), fx);
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.fee_not_as_disclosed"]);
    assert.match(got[0].message, new RegExp(`pays its platform fee to ${stranger}, not the disclosed account ${pinned}`));
  }
  // With no fee disclosed, naming a fee account at all is refused; absent (Jupiter's own id) passes.
  const none = await planFrom(NOFEE);
  assert.equal((await S.verifySolanaSwapPlan(none, intentOf(NOFEE), verifyDeps(NOFEE))).ok, true);
  const named = await refusalsOf(withAccount(none, 6, stranger), NOFEE);
  assert.deepEqual(named.map((r) => r.rule), ["solana_swap.fee_not_as_disclosed"]);
  assert.match(named[0].message, /names a fee account.*but no fee was disclosed/);
  // And a fee-free plan on a transaction that does charge one.
  assert.ok((await refusedBy({ ...(await planFrom(USDC_SOL)), fee: { bps: 0, account: null, text: "" } }, USDC_SOL)).includes("solana_swap.fee_not_as_disclosed"));
});

test("verify refuses: the output paid to an account that is not the agent's own (either destination slot), or taken from someone else's", async () => {
  const stranger = await randomAddress();
  for (const fx of [USDC_SOL, SOL_USDC]) {
    const plan = await planFrom(fx);
    const dest = await refusalsOf(withAccount(plan, 3, stranger), fx);
    assert.deepEqual(dest.map((r) => r.rule), ["solana_swap.recipient_not_agent"]);
    assert.match(dest[0].message, new RegExp(`pays the output to ${stranger}, which is not the agent's own`));
    const second = await refusalsOf(withAccount(plan, 4, stranger), fx);
    assert.deepEqual(second.map((r) => r.rule), ["solana_swap.recipient_not_agent"]);
    assert.ok((await refusedBy(withAccount(plan, 2, stranger), fx)).includes("solana_swap.jupiter_source_not_agent"));
    assert.ok((await refusedBy(withAccount(plan, 1, stranger), fx)).includes("solana_swap.jupiter_authority_not_agent"));
    assert.ok((await refusedBy(withAccount(plan, 5, stranger), fx)).includes("solana_swap.jupiter_account_mismatch"));
  }
  // The agent's own account for the OTHER mint is not the destination either (output into the input account).
  const plan = await planFrom(USDC_SOL);
  const usdcAta = (await findAssociatedTokenPda({ owner: address(WALLET), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  assert.ok((await refusedBy(withAccount(plan, 3, usdcAta), USDC_SOL)).includes("solana_swap.recipient_not_agent"));
  // The second destination slot may hold the agent's own output account, never a stranger's.
  const wsolAta = (await findAssociatedTokenPda({ owner: address(WALLET), mint: address(WSOL), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  assert.equal((await S.verifySolanaSwapPlan(withAccount(plan, 4, wsolAta), intentOf(USDC_SOL), verifyDeps(USDC_SOL))).ok, true);
});

test("verify refuses: in_amount changed in Jupiter's instruction", async () => {
  const plan = await planFrom(USDC_SOL);
  for (const inAmount of [1n, 24_999_999n, 25_000_001n, 2n ** 64n - 1n]) {
    const got = await refusalsOf(withArgs(plan, { inAmount }), USDC_SOL);
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_amount_mismatch"], `in_amount ${inAmount}`);
    assert.match(got[0].message, new RegExp(`swaps ${inAmount} base units, not the 25000000 asked for`));
  }
});

test("verify refuses: a Jupiter instruction this kit does not read (unknown, and the known forms it does not allow)", async () => {
  const plan = await planFrom(USDC_SOL);
  const disc = (hex) => mutate(plan.swap_transaction, (c) => {
    const d = Buffer.from(jupiterIxs(c)[0].data);
    Buffer.from(hex, "hex").copy(d, 0);
    jupiterIxs(c)[0].data = new Uint8Array(d);
  });
  const unknown = await refusalsOf(withTx(plan, disc("0102030405060708")), USDC_SOL);
  assert.deepEqual(unknown.map((r) => r.rule), ["solana_swap.jupiter_instruction_unrecognized"]);
  assert.match(unknown[0].message, /does not recognise \(0102030405060708\)/);
  for (const [hex, name] of Object.entries(S.JUPITER_INSTRUCTION_NAMES)) {
    if (name === "route") continue;
    const got = await refusalsOf(withTx(plan, disc(hex)), USDC_SOL);
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_instruction_unrecognized"], name);
    assert.match(got[0].message, new RegExp(`is Jupiter's ${name}, which this kit does not read or allow`));
  }
});

test("verify refuses: two route instructions (or none) in one transaction", async () => {
  const plan = await planFrom(USDC_SOL);
  const two = mutate(plan.swap_transaction, (c) => {
    const ix = jupiterIxs(c)[0];
    c.instructions.splice(c.instructions.indexOf(ix) + 1, 0, { ...ix, accountIndices: [...ix.accountIndices], data: new Uint8Array(ix.data) });
  });
  const got = await refusalsOf(withTx(plan, two), USDC_SOL);
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_route_count"]);
  assert.match(got[0].message, /has 2 Jupiter instructions/);
  // A second one that is not a route is refused as that, and still counted.
  const mixed = mutate(plan.swap_transaction, (c) => {
    const ix = jupiterIxs(c)[0];
    const data = new Uint8Array(ix.data);
    data.set(Buffer.from("c1209b3341d69c81", "hex"), 0);
    c.instructions.push({ ...ix, accountIndices: [...ix.accountIndices], data });
  });
  assert.deepEqual([...new Set(await refusedBy(withTx(plan, mixed), USDC_SOL))].sort(), ["solana_swap.jupiter_instruction_unrecognized", "solana_swap.jupiter_route_count"]);
  const none = mutate(plan.swap_transaction, (c) => {
    c.instructions = c.instructions.filter((i) => c.staticAccounts[i.programAddressIndex] !== S.JUPITER_PROGRAM);
  });
  assert.deepEqual(await refusedBy(withTx(plan, none), USDC_SOL), ["solana_swap.jupiter_route_count"]);
});

test("every refusal message is plain words for the owner (no safe / secure / trusted / guaranteed)", async () => {
  const plan = await planFrom(USDC_SOL);
  const stranger = await randomAddress();
  const all = [];
  for (const bad of [withArgs(plan, { quotedOut: 1n, slippageBps: 10_000, inAmount: 1n, feeBps: 0 }), withAccount(plan, 6, stranger), withAccount(plan, 3, stranger), withAccount(plan, 2, stranger), withAccount(plan, 1, stranger)]) {
    all.push(...(await refusalsOf(bad, USDC_SOL)).map((r) => r.message));
  }
  all.push(...(await refusalsOf(plan, USDC_SOL, { editSim: (v) => (v.accounts[SIM_USDC] = tokenAccountEntry({ mint: USDC_MINT, owner: stranger, delegate: stranger, closeAuthority: stranger })) })).map((r) => r.message));
  assert.ok(all.length >= 8);
  for (const m of all) assert.doesNotMatch(m, /\b(safe|secure|trusted|guaranteed?|guarantees)\b/i, m);
});

test("verify refuses: a copy of the honest arguments placed AFTER tampered ones (Anchor ignores bytes left over, so the tail alone would lie)", async () => {
  // Simulated on mainnet 2026-10-09: this data runs, and Jupiter's program reads the FIRST
  // arguments (quoted_out=1, slippage 10000). Reading only the last 19 bytes would pass it.
  for (const fx of [USDC_SOL, SOL_USDC]) {
    const plan = await planFrom(fx);
    const tx = mutate(plan.swap_transaction, (c) => {
      const ix = jupiterIxs(c)[0];
      const honestTail = Buffer.from(ix.data).subarray(ix.data.length - ARGS);
      writeArgs(ix, { quotedOut: 1n, slippageBps: 10_000 });
      ix.data = new Uint8Array(Buffer.concat([Buffer.from(ix.data), honestTail]));
    });
    const got = await refusalsOf(withTx(plan, tx), fx);
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_instruction_unrecognized"]);
    assert.match(got[0].message, /does not leave exactly the 19 bytes of arguments/);
  }
});

// ----------------------------------------------------------------- the route-plan walker (what makes "the end of the plan" reliable)

/** Independent of the kit's table: walk the IDL's own types to size or build a value. */
function idlWalker(types) {
  const byName = Object.fromEntries(types.map((t) => [t.name, t]));
  const PRIM = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
  const rnd = (n) => Uint8Array.from({ length: n }, (_x, i) => (i * 37 + n) & 255);
  const u32 = (n) => [n & 255, (n >> 8) & 255, 0, 0];
  /** Encode a value of an IDL type; `pick(enumName)` chooses variants; `n` is a counter for Vec lengths. */
  function encode(t, pick) {
    if (typeof t === "string") {
      if (t === "bytes" || t === "string") return [...u32(3), 9, 9, 9];
      return t === "bool" ? [1] : [...rnd(PRIM[t]).map((b) => b & 0x7f)];
    }
    if (t.option) return pick.optSome ? [1, ...encode(t.option, pick)] : [0];
    if (t.vec) return [...u32(2), ...encode(t.vec, pick), ...encode(t.vec, pick)];
    if (t.array) return Array.from({ length: t.array[1] }, () => encode(t.array[0], pick)).flat();
    const name = t.defined.name ?? t.defined;
    const d = byName[name];
    if (d.type.kind === "struct") return (d.type.fields ?? []).flatMap((f) => encode(f.type ?? f, pick));
    const idx = pick.variant(name, d.type.variants.length);
    const v = d.type.variants[idx];
    return [idx, ...(v.fields ?? []).flatMap((f) => encode(f.type ?? f, pick))];
  }
  return { encode, byName };
}

test("the embedded route-plan layout is exactly what the IDL's types compile to, and the stored IDL is the one the discriminators come from", () => {
  const { step, enums } = compile(JUP_IDL.types);
  assert.deepEqual(JSON.parse(JSON.stringify(S.ROUTE_LAYOUT)), JSON.parse(JSON.stringify({ step, enums })));
  assert.equal(enums.Swap.variants, JUP_IDL.types.find((t) => t.name === "Swap").type.variants.length);
  assert.equal(JUP_IDL.instructions.route, S.JUPITER_ROUTE_DISCRIMINATOR);
  assert.deepEqual(JUP_IDL.route.args.map((a) => a.name), ["route_plan", "in_amount", "quoted_out_amount", "slippage_bps", "platform_fee_bps"]);
  assert.deepEqual(JUP_IDL.route.args.slice(1).map((a) => a.type), ["u64", "u64", "u16", "u8"]);
  assert.deepEqual(JUP_IDL.route.accounts.slice(0, 9).map((a) => a.name), ["token_program", "user_transfer_authority", "user_source_token_account", "user_destination_token_account", "destination_token_account", "destination_mint", "platform_fee_account", "event_authority", "program"]);
  assert.deepEqual(JUP_IDL.route.accounts.filter((a) => a.optional).map((a) => a.name), ["destination_token_account", "platform_fee_account"]);
  for (const [hex, name] of Object.entries(S.JUPITER_INSTRUCTION_NAMES)) assert.equal(JUP_IDL.instructions[name], hex, name);
  // sha256("global:route")[0..8]: Anchor's rule, so the table above is not just copied from a file.
  assert.equal(createHash("sha256").update("global:route").digest().subarray(0, 8).toString("hex"), S.JUPITER_ROUTE_DISCRIMINATOR);
});

test("the kit finds the end of a route plan for EVERY Swap variant (and every nested CandidateSwap), as built from the IDL's types", () => {
  const { encode, byName } = idlWalker(JUP_IDL.types);
  const swapN = byName.Swap.type.variants.length;
  const candN = byName.CandidateSwap.type.variants.length;
  const tail = [...u64le(1_000_000), ...u64le(900_000), ...u16le(50), 15];
  const step = (swapBytes) => [...swapBytes, 100, 0, 1];
  const data = (steps) => Uint8Array.from([...Buffer.from(S.JUPITER_ROUTE_DISCRIMINATOR, "hex"), ...u32le(steps.length), ...steps.flat(), ...tail]);
  let checked = 0;
  for (const optSome of [false, true]) {
    for (let v = 0; v < swapN; v++) {
      for (let cand = 0; cand < (byName.Swap.type.variants[v].fields?.some((f) => JSON.stringify(f.type).includes("CandidateSwap")) ? candN : 1); cand++) {
        const pick = { optSome, variant: (name, n) => (name === "Swap" ? v : name === "CandidateSwap" ? cand % n : 0) };
        const swapBytes = encode({ defined: { name: "Swap" } }, pick);
        const d = data([step(swapBytes), step([0])]);
        const r = S.decodeJupiterRoute(d);
        assert.equal(r.steps, 2);
        assert.deepEqual([r.inAmount, r.quotedOut, r.slippageBps, r.platformFeeBps], [1_000_000n, 900_000n, 50, 15], `Swap variant ${v} (${byName.Swap.type.variants[v].name}) cand ${cand} optSome ${optSome}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= swapN * 2);
  // One more than the table knows is refused by name, not misread.
  const unknown = Uint8Array.from([...Buffer.from(S.JUPITER_ROUTE_DISCRIMINATOR, "hex"), ...u32le(1), swapN, 100, 0, 1, ...tail]);
  assert.throws(() => S.decodeJupiterRoute(unknown), /newer than this kit's copy of Jupiter's program interface/);
});

test("the kit reads the recorded real builds to their end, and nothing is left over", () => {
  for (const fx of [USDC_SOL, SOL_USDC, NOFEE]) {
    const swap = JSON.parse(fx.http.find((h) => h.url === "/swap").text).swapTransaction;
    const ix = jupiterIxs(compiledOf(swap))[0];
    const r = S.decodeJupiterRoute(ix.data);
    assert.ok(r.steps >= 1);
    assert.equal(Buffer.from(ix.data).subarray(0, 8).toString("hex"), "e517cb977ae3ad2a");
  }
  const honest = jupiterIxs(compiledOf(JSON.parse(USDC_SOL.http.find((h) => h.url === "/swap").text).swapTransaction))[0].data;
  assert.throws(() => S.decodeJupiterRoute(Uint8Array.from([...honest, 0])), /extra or missing bytes/);
  assert.throws(() => S.decodeJupiterRoute(honest.subarray(0, honest.length - 1)), /extra or missing bytes|runs past/);
  assert.throws(() => S.decodeJupiterRoute(Uint8Array.from(honest.subarray(0, 12))), /too short/);
  const hugeVec = Uint8Array.from(honest);
  new DataView(hugeVec.buffer).setUint32(8, 0xffffffff, true);
  assert.throws(() => S.decodeJupiterRoute(hugeVec), /RouteLayout|claims more entries|runs past|extra or missing|malformed|newer/);
  assert.throws(() => S.decodeJupiterRoute(Uint8Array.from({ length: 40 }, () => 7)), /not a route instruction/);
});

test("minOutFor: rounds down, and slippage of 10000 bps or more leaves no floor", () => {
  assert.equal(S.minOutFor(226_419_270n, 50), 225_287_173n, "Jupiter's own threshold for this quote is 225,287,174 (rounded up); the kit promises the rounded-down one");
  assert.equal(S.minOutFor(55_043_427n, 50), 54_768_209n);
  assert.equal(S.minOutFor(1_000n, 10_000), 0n);
  assert.equal(S.minOutFor(1_000n, 65_535), 0n);
  assert.equal(S.minOutFor(1_000n, 0), 1_000n);
});

// ----------------------------------------------------------------- verify: the agent's accounts after the swap

/** An SPL Token account as the RPC returns it: base64 data of the 165-byte layout. */
function tokenAccountEntry({ mint, owner, amount = 0n, delegate = null, closeAuthority = null, lamports = 2_039_280, program = TOKEN_PROGRAM_ADDRESS }) {
  const enc = getAddressEncoder();
  const raw = Buffer.alloc(165);
  Buffer.from(enc.encode(address(mint))).copy(raw, 0);
  Buffer.from(enc.encode(address(owner))).copy(raw, 32);
  raw.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) {
    raw.writeUInt32LE(1, 72);
    Buffer.from(enc.encode(address(delegate))).copy(raw, 76);
  }
  raw[108] = 1;
  if (closeAuthority) {
    raw.writeUInt32LE(1, 129);
    Buffer.from(enc.encode(address(closeAuthority))).copy(raw, 133);
  }
  return { data: [raw.toString("base64"), "base64"], executable: false, lamports: String(lamports), owner: program, rentEpoch: "18446744073709551615", space: "165" };
}
const SIM_USDC = 1; // positions in the simulation's `accounts` read-back: agent, USDC account, wrapped-SOL account, fee account
const SIM_WSOL = 2;
const SIM_FEE = 3;

test("verify passes the recorded builds' post-state: the agent's accounts are its own, with no delegate and no close authority", async () => {
  for (const fx of [USDC_SOL, SOL_USDC, NOFEE]) {
    const plan = await planFrom(fx);
    const seen = [];
    await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx, { editSim: (v) => seen.push(...v.accounts) }));
    assert.ok(seen.length >= 3);
  }
});

test("verify refuses: a delegate set on the agent's USDC account (no balance changes at all)", async () => {
  const plan = await planFrom(USDC_SOL);
  const stranger = await randomAddress();
  const got = await refusalsOf(plan, USDC_SOL, {
    editSim: (v) => {
      const raw = Buffer.from(v.accounts[SIM_USDC].data[0], "base64");
      raw.writeUInt32LE(1, 72);
      Buffer.from(getAddressEncoder().encode(address(stranger))).copy(raw, 76);
      v.accounts[SIM_USDC].data[0] = raw.toString("base64");
    },
  });
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.account_authority_changed"]);
  assert.match(got[0].message, new RegExp(`USDC account .* would have a delegate \\(${stranger}\\) that can spend from it`));
});

test("verify refuses: the owner of the agent's USDC account changed", async () => {
  const plan = await planFrom(USDC_SOL);
  const stranger = await randomAddress();
  const got = await refusalsOf(plan, USDC_SOL, {
    editSim: (v) => {
      const raw = Buffer.from(v.accounts[SIM_USDC].data[0], "base64");
      Buffer.from(getAddressEncoder().encode(address(stranger))).copy(raw, 32);
      v.accounts[SIM_USDC].data[0] = raw.toString("base64");
    },
  });
  assert.ok(got.every((r) => r.rule === "solana_swap.account_authority_changed"));
  assert.match(got[0].message, new RegExp(`would be owned by ${stranger}, not the agent`));
});

test("verify refuses: a close authority set on the agent's USDC account", async () => {
  const plan = await planFrom(USDC_SOL);
  const stranger = await randomAddress();
  const got = await refusalsOf(plan, USDC_SOL, {
    editSim: (v) => {
      const raw = Buffer.from(v.accounts[SIM_USDC].data[0], "base64");
      raw.writeUInt32LE(1, 129);
      Buffer.from(getAddressEncoder().encode(address(stranger))).copy(raw, 133);
      v.accounts[SIM_USDC].data[0] = raw.toString("base64");
    },
  });
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.account_authority_changed"]);
  assert.match(got[0].message, new RegExp(`would have a close authority \\(${stranger}\\)`));
});

test("verify refuses: the same three changes on the agent's wrapped-SOL account when it is left open, and a different kind of account in its place", async () => {
  const stranger = await randomAddress();
  const plan = await planFrom(USDC_SOL);
  const run = (entry) => refusalsOf(plan, USDC_SOL, { editSim: (v) => (v.accounts[SIM_WSOL] = entry) });
  const mk = (o) => tokenAccountEntry({ mint: WSOL, owner: WALLET, ...o });
  // An open wrapped-SOL account that is the agent's own, plain: nothing to refuse for it.
  const ok = await S.verifySolanaSwapPlan(plan, intentOf(USDC_SOL), verifyDeps(USDC_SOL, { editSim: (v) => (v.accounts[SIM_WSOL] = mk({})) }));
  assert.equal(ok.ok, true);
  const rulesOf = (r) => [...new Set(r.map((x) => x.rule))];
  assert.deepEqual(rulesOf(await run(mk({ delegate: stranger }))), ["solana_swap.account_authority_changed"]);
  assert.deepEqual(rulesOf(await run(mk({ owner: stranger }))), ["solana_swap.account_authority_changed"]);
  assert.deepEqual(rulesOf(await run(mk({ closeAuthority: stranger }))), ["solana_swap.account_authority_changed"]);
  assert.deepEqual(rulesOf(await run(mk({ mint: USDC_MINT }))), ["solana_swap.account_authority_changed"]);
  assert.deepEqual(rulesOf(await run(mk({ program: TOKEN_2022_PROGRAM }))), ["solana_swap.account_authority_changed"], "Token-2022 is not what a wrapped-SOL account is");
});

test("verify refuses: the agent's wallet account assigned to another program", async () => {
  const plan = await planFrom(USDC_SOL);
  const got = await refusalsOf(plan, USDC_SOL, { editSim: (v) => (v.accounts[0].owner = TOKEN_PROGRAM_ADDRESS) });
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.account_authority_changed"]);
  assert.match(got[0].message, /no longer be an ordinary wallet owned by the System program/);
});

test("verify refuses: a read-back that does not line up with the accounts that were asked for", async () => {
  const plan = await planFrom(USDC_SOL);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: (v) => v.accounts.pop() }), ["solana_swap.sim_inconsistent"]);
});

test("balanceDeltas: a wrapped-SOL account whose owner is no longer the agent after the transaction stops counting as the agent's SOL", () => {
  const agent = "Agent1111111111111111111111111111111111111";
  const tok = (accountIndex, mint, amount, owner = agent) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });
  // keys: 0 agent, 1 wrapped-SOL account holding 1 SOL (+ rent)
  const base = { keys: [agent, "w"], preBalances: [1_000_000, 1_000_000_000 + 2_039_280], preTokenBalances: [tok(1, WSOL, 1_000_000_000)] };
  // Honest: still the agent's after, nothing lost.
  const same = S.balanceDeltas({ ...base, postBalances: [1_000_000 - 5_000, 1_000_000_000 + 2_039_280], postTokenBalances: [tok(1, WSOL, 1_000_000_000)] }, agent);
  assert.equal(same.sol.delta, -5_000n);
  // SetAuthority by a CPI: the same lamports and tokens, a different owner. The old code still counted the lamports.
  const taken = S.balanceDeltas({ ...base, postBalances: [1_000_000 - 5_000, 1_000_000_000 + 2_039_280], postTokenBalances: [tok(1, WSOL, 1_000_000_000, "Stranger11111111111111111111111111111111111")] }, agent);
  assert.equal(taken.sol.delta, -5_000n - 1_000_000_000n - 2_039_280n, "the whole account leaves the agent's SOL");
});

test("verify refuses: a SetAuthority on the wrapped-SOL account moves its balance out of the agent's SOL (the output check sees it too)", async () => {
  const plan = await planFrom(USDC_SOL);
  const stranger = await randomAddress();
  // The recorded run closes the wrapped-SOL account. Leave it open instead, holding the proceeds but owned by a
  // stranger: the agent's SOL no longer includes it, so the proceeds do not reach the agent.
  const got = await refusedBy(plan, USDC_SOL, {
    editSim: (v) => {
      const keys = [...compiledOf(plan.swap_transaction).staticAccounts, ...v.loadedAddresses.writable, ...v.loadedAddresses.readonly];
      const wsol = keys.indexOf("umiAsegEDQeKMAfqPhqNxxYDsXo8fuhQy7HHE7viKud");
      assert.ok(wsol > 0);
      v.preTokenBalances.push({ accountIndex: wsol, mint: WSOL, owner: WALLET, uiTokenAmount: { amount: "0" } });
      v.postTokenBalances.push({ accountIndex: wsol, mint: WSOL, owner: stranger, uiTokenAmount: { amount: "226000000" } });
      v.postBalances[wsol] = String(226_000_000 + 2_039_280);
      v.postBalances[0] = (BigInt(v.postBalances[0]) - 226_000_000n - 2_039_280n).toString();
      v.accounts[0].lamports = v.postBalances[0];
    },
  });
  assert.ok(got.includes("solana_swap.sim_output_inflow") || got.includes("solana_swap.sim_input_outflow"), got.join());
});

// ----------------------------------------------------------------- verify: simulation refuses

test("verify refuses on the simulation: it failed, could not run, or returned no balances", async () => {
  const plan = await planFrom(USDC_SOL);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: (v) => (v.err = { InstructionError: [2, { Custom: 6001 }] }) }), ["solana_swap.sim_failed"]);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { simThrows: "429 too many requests" }), ["solana_swap.sim_unavailable"]);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: (v) => delete v.postTokenBalances }), ["solana_swap.sim_unavailable"]);
});

test("verify refuses on the simulation: less than the minimum comes back", async () => {
  const plan = await planFrom(USDC_SOL);
  // Take 0.01 SOL out of what the swap delivers.
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: shiftAgentLamports(-10_000_000_000n) }), ["solana_swap.sim_output_inflow"]);
  const sol = await planFrom(SOL_USDC);
  assert.deepEqual(
    await refusedBy(sol, SOL_USDC, {
      editSim: (v) => {
        for (const t of v.postTokenBalances) if (t.mint === USDC_MINT && t.owner === WALLET) t.uiTokenAmount.amount = (BigInt(t.uiTokenAmount.amount) - 1_000_000n).toString();
      },
    }),
    ["solana_swap.sim_output_inflow"],
  );
});

test("verify refuses on the simulation: more than the amount being swapped leaves", async () => {
  const usdc = await planFrom(USDC_SOL);
  const take = (extra) => (v) => {
    for (const t of v.postTokenBalances) if (t.mint === USDC_MINT && t.owner === WALLET) t.uiTokenAmount.amount = (BigInt(t.uiTokenAmount.amount) - extra).toString();
  };
  assert.deepEqual(await refusedBy(usdc, USDC_SOL, { editSim: take(1n) }), ["solana_swap.sim_input_outflow"]);
  const sol = await planFrom(SOL_USDC);
  // 0.01 SOL more than amount + fees: far over the overhead cap of ~0.0042 SOL.
  assert.deepEqual(await refusedBy(sol, SOL_USDC, { editSim: shiftAgentLamports(-10_000_000n) }), ["solana_swap.sim_input_outflow"]);
});

test("verify refuses on the simulation: another asset of the agent's is drained", async () => {
  const plan = await planFrom(USDC_SOL);
  const got = await refusedBy(plan, USDC_SOL, {
    editSim: (v) => {
      const mk = (amount) => ({ accountIndex: 5, mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", owner: WALLET, programId: TOKEN_PROGRAM_ADDRESS, uiTokenAmount: { amount, decimals: 5 } });
      v.preTokenBalances.push(mk("1000"));
      v.postTokenBalances.push(mk("999"));
    },
  });
  assert.deepEqual(got, ["solana_swap.sim_other_asset"]);
});

test("verify refuses on the simulation: the fee taken is above the disclosed one, or the fee account is not a token account of the input mint", async () => {
  const plan = await planFrom(USDC_SOL);
  // Where the fee account sits in the runtime's account order (static keys, then loaded ones).
  const feeIdx = (v) => [...compiledOf(plan.swap_transaction).staticAccounts, ...v.loadedAddresses.writable, ...v.loadedAddresses.readonly].indexOf(S.SATO_FEE_ACCOUNTS[USDC_MINT]);
  const over = await refusedBy(plan, USDC_SOL, {
    editSim: (v) => {
      const t = v.postTokenBalances.find((x) => x.accountIndex === feeIdx(v));
      t.uiTokenAmount.amount = (BigInt(t.uiTokenAmount.amount) + 100_000n).toString();
    },
  });
  assert.deepEqual(over, ["solana_swap.fee_account"]);
  const gone = await refusedBy(plan, USDC_SOL, { editSim: (v) => (v.preTokenBalances = v.preTokenBalances.filter((t) => t.accountIndex !== feeIdx(v))) });
  assert.deepEqual(gone, ["solana_swap.fee_account"]);
});

test("verify refuses on the simulation: the loaded accounts differ from the lookup tables this kit read, or the read-back disagrees", async () => {
  const plan = await planFrom(USDC_SOL);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: (v) => v.loadedAddresses.writable.reverse() }), ["solana_swap.sim_inconsistent"]);
  assert.deepEqual(await refusedBy(plan, USDC_SOL, { editSim: (v) => (v.accounts[0].lamports = "1") }), ["solana_swap.sim_inconsistent"]);
});

test("verify refuses: a network fee above the base plus the priority fee the instructions imply", async () => {
  const plan = await planFrom(USDC_SOL);
  assert.ok((await refusedBy(plan, USDC_SOL, { editSim: (v) => (v.fee = "90000") })).includes("solana_swap.priority_fee"));
});

// ----------------------------------------------------------------- synthetic transactions (no lookup tables)

async function synthetic(agent, instructions) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(agent), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EdosfaBDx9kfcA8i6XDj29VWUvNXNRGnqHf4Q6LVojgy", lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return b64d.decode(getTransactionEncoder().encode(compileTransaction(msg)));
}
const ix = (programAddress, accounts, data) => ({ programAddress: address(programAddress), accounts: accounts.map(([a, role]) => ({ address: address(a), role })), data: Uint8Array.from(data) });
const W = AccountRole.WRITABLE;
const R = AccountRole.READONLY;
const WS = AccountRole.WRITABLE_SIGNER;
const u64le = (n) => [...new Uint8Array(new BigUint64Array([BigInt(n)]).buffer)];
const u32le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const u16le = (n) => [n & 255, (n >> 8) & 255];

/** A `route` instruction's data: discriminator, a route plan of `swaps` (variant indexes, no payload), then the arguments. */
function routeData({ swaps = [0], inAmount = 100_000_000n, quotedOut = 15_000_000n, slippageBps = 50, feeBps = 0 } = {}) {
  const steps = swaps.flatMap((v) => [v, 100, 0, 1]);
  return [...Buffer.from(S.JUPITER_ROUTE_DISCRIMINATOR, "hex"), ...u32le(swaps.length), ...steps, ...u64le(inAmount), ...u64le(quotedOut), ...u16le(slippageBps), feeBps];
}
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";

test("inspect: a typical fresh-wallet SOL -> USDC build (create accounts, wrap, swap, unwrap) is accepted; the same with tampering is not", async () => {
  const agent = (await generateKeyPairSigner()).address;
  const usdcAta = (await findAssociatedTokenPda({ owner: address(agent), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const wsolAta = (await findAssociatedTokenPda({ owner: address(agent), mint: address(WSOL), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const SYS = "11111111111111111111111111111111";
  const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const create = (ata, mint) => ix(ATA, [[agent, WS], [ata, W], [agent, R], [mint, R], [SYS, R], [TOKEN_PROGRAM_ADDRESS, R]], [1]);
  const good = [
    ix("ComputeBudget111111111111111111111111111111", [], [2, 160, 134, 1, 0]), // 100,000 units
    ix("ComputeBudget111111111111111111111111111111", [], [3, ...u64le(20_000)]),
    create(wsolAta, WSOL),
    create(usdcAta, USDC_MINT),
    ix(SYS, [[agent, WS], [wsolAta, W]], [2, 0, 0, 0, ...u64le(100_000_000)]),
    ix(TOKEN_PROGRAM_ADDRESS, [[wsolAta, W]], [17]),
    ix(S.JUPITER_PROGRAM, [[TOKEN_PROGRAM_ADDRESS, R], [agent, WS], [wsolAta, W], [usdcAta, W], [S.JUPITER_PROGRAM, R], [USDC_MINT, R], [S.JUPITER_PROGRAM, R], [EVENT_AUTHORITY, R], [S.JUPITER_PROGRAM, R]], routeData()),
    ix(TOKEN_PROGRAM_ADDRESS, [[wsolAta, W], [agent, W], [agent, WS]], [9]),
  ];
  // 15 USDC quoted for 0.1 SOL at 50 bps: the transaction requires floor(15,000,000 x 9950 / 10000).
  const opts = { agent, mintIn: WSOL, mintOut: USDC_MINT, amountIn: 100_000_000n, feeAccount: null, feeBps: 0, slippageBps: 50, minOut: 14_925_000n };
  const accepted = await S.inspectSolanaSwapTransaction(await synthetic(agent, good), opts, {});
  assert.deepEqual(accepted.refusals, []);
  assert.equal(accepted.facts.priority_lamports, 2000n, "20,000 micro-lamports x 100,000 units");
  assert.equal(accepted.facts.created_atas.length, 2);

  const other = (await generateKeyPairSigner()).address;
  const check = async (bad, rule, o = opts) => {
    const got = await S.inspectSolanaSwapTransaction(await synthetic(agent, bad), o, {});
    assert.ok(got.refusals.some((r) => r.rule === rule), `${rule} not raised: ${got.refusals.map((r) => r.rule)}`);
  };
  const swap = (i, replacement) => good.map((x, n) => (n === i ? replacement : x));
  await check(swap(4, ix(SYS, [[agent, WS], [other, W]], [2, 0, 0, 0, ...u64le(1000)])), "solana_swap.system_transfer"); // SOL to a stranger
  await check(swap(4, ix(SYS, [[agent, WS], [wsolAta, W]], [2, 0, 0, 0, ...u64le(100_000_001)])), "solana_swap.system_transfer"); // wraps more than it swaps
  await check(swap(4, ix(SYS, [[agent, WS], [other, W]], [4, 0, 0, 0, ...u64le(5)])), "solana_swap.system_instruction"); // anything else System
  await check(swap(3, ix(ATA, [[agent, WS], [usdcAta, W], [other, R], [USDC_MINT, R], [SYS, R], [TOKEN_PROGRAM_ADDRESS, R]], [1])), "solana_swap.ata_instruction"); // an account for someone else
  await check(swap(3, ix(ATA, [[agent, WS], [other, W], [agent, R], [USDC_MINT, R], [SYS, R], [TOKEN_PROGRAM_ADDRESS, R]], [1])), "solana_swap.ata_instruction"); // not the real ATA address
  await check(swap(3, ix(ATA, [[agent, WS], [usdcAta, W], [agent, R], [other, R], [SYS, R], [TOKEN_PROGRAM_ADDRESS, R]], [1])), "solana_swap.ata_instruction"); // some other mint
  await check(swap(7, ix(TOKEN_PROGRAM_ADDRESS, [[wsolAta, W], [other, W], [agent, WS]], [9])), "solana_swap.token_close_destination");
  await check(swap(5, ix(TOKEN_2022_PROGRAM, [[wsolAta, W], [other, R], [agent, WS]], [6, 2, 0])), "solana_swap.token_authority"); // Token-2022 is held to the same rules
  await check(swap(5, ix(TOKEN_PROGRAM_ADDRESS, [[wsolAta, W], [other, R], [agent, WS]], [13, 0, 0, 0, 0, 0, 0, 0, 0, 9])), "solana_swap.token_authority");
  await check(swap(0, ix("ComputeBudget111111111111111111111111111111", [], [5, 0, 0, 0, 0])), "solana_swap.compute_budget");
  await check([...good, ix(other, [[agent, WS]], [])], "solana_swap.program_allowlist");
  // The referral program is not allowed at the top level either.
  await check([...good, ix("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3", [[agent, WS]], [])], "solana_swap.program_allowlist");
  // A USDC-input swap moves no SOL at all.
  await check(good, "solana_swap.system_transfer", { ...opts, mintIn: USDC_MINT });
  // The disclosed fee account must be in the transaction.
  await check(good, "solana_swap.fee_account_missing", { ...opts, feeAccount: S.SATO_FEE_ACCOUNTS[WSOL] });

  // Jupiter's instruction is read, not trusted: the numbers and accounts in it are held to what was asked and disclosed.
  const jup = (accounts, data) => ix(S.JUPITER_PROGRAM, accounts, data);
  const slots = (over = {}) => {
    const base = [[TOKEN_PROGRAM_ADDRESS, R], [agent, WS], [wsolAta, W], [usdcAta, W], [S.JUPITER_PROGRAM, R], [USDC_MINT, R], [S.JUPITER_PROGRAM, R], [EVENT_AUTHORITY, R], [S.JUPITER_PROGRAM, R]];
    for (const [i, v] of Object.entries(over)) base[i] = v;
    return base;
  };
  const withJup = (accounts, data) => swap(6, jup(accounts, data));
  await check(withJup(slots(), routeData({ quotedOut: 1n })), "solana_swap.min_out_not_enforced");
  await check(withJup(slots(), routeData({ slippageBps: 10_000 })), "solana_swap.min_out_not_enforced");
  await check(withJup(slots(), routeData({ slippageBps: 60, quotedOut: 15_100_000n })), "solana_swap.min_out_not_enforced"); // enough output, but more slippage than allowed
  await check(withJup(slots(), routeData({ inAmount: 99_999_999n })), "solana_swap.jupiter_amount_mismatch");
  await check(withJup(slots(), routeData({ feeBps: 15 })), "solana_swap.fee_not_as_disclosed");
  await check(withJup(slots({ 6: [other, W] }), routeData()), "solana_swap.fee_not_as_disclosed"); // a fee account when none was disclosed
  await check(withJup(slots({ 3: [other, W] }), routeData()), "solana_swap.recipient_not_agent");
  await check(withJup(slots({ 4: [other, W] }), routeData()), "solana_swap.recipient_not_agent"); // the optional second destination
  await check(withJup(slots({ 2: [other, W] }), routeData()), "solana_swap.jupiter_source_not_agent");
  await check(withJup(slots({ 5: [S.WSOL_MINT, R] }), routeData()), "solana_swap.jupiter_account_mismatch");
  await check(withJup(slots(), [...routeData(), 0]), "solana_swap.jupiter_instruction_unrecognized"); // a byte after the arguments
  await check(withJup(slots(), routeData().slice(0, -1)), "solana_swap.jupiter_instruction_unrecognized"); // a byte short
  await check(withJup(slots(), routeData({ swaps: [197] })), "solana_swap.jupiter_instruction_unrecognized"); // a venue this kit's copy of the interface does not know
  await check([...good, good[6]], "solana_swap.jupiter_route_count");
  await check(good.filter((_x, n) => n !== 6), "solana_swap.jupiter_route_count"); // no route at all
  // With a disclosed fee: the pinned account, the disclosed rate.
  const fee = S.SATO_FEE_ACCOUNTS[WSOL];
  await check(withJup(slots({ 6: [fee, W] }), routeData({ feeBps: 15 })), "solana_swap.fee_not_as_disclosed", { ...opts, feeAccount: fee, feeBps: 14 });
  await check(withJup(slots({ 6: [other, W] }), routeData({ feeBps: 15 })), "solana_swap.fee_not_as_disclosed", { ...opts, feeAccount: fee, feeBps: 15 });
  await check(withJup(slots(), routeData({ feeBps: 15 })), "solana_swap.fee_not_as_disclosed", { ...opts, feeAccount: fee, feeBps: 15 }); // the fee account left out (None) while a fee is disclosed
  const withFee = await S.inspectSolanaSwapTransaction(await synthetic(agent, withJup(slots({ 6: [fee, W] }), routeData({ feeBps: 15 }))), { ...opts, feeAccount: fee, feeBps: 15 }, {});
  assert.deepEqual(withFee.refusals, []);
});

test("balanceDeltas: wrapping, unwrapping and closing net to zero; new USDC accounts' rent is counted; other tokens are watched", () => {
  const agent = "Agent1111111111111111111111111111111111111";
  const tok = (accountIndex, mint, amount, owner = agent) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });
  // keys: 0 agent, 1 wSOL account (created and closed), 2 USDC account (created in this tx), 3 stranger
  const out = S.balanceDeltas(
    {
      keys: [agent, "w", "u", "x"],
      preBalances: [10_000_000_000, 0, 0, 5],
      postBalances: [10_000_000_000 - 1_000_000_000 - 5_000 - 2_039_280, 0, 2_039_280, 5],
      preTokenBalances: [],
      postTokenBalances: [tok(2, USDC_MINT, 100_000_000)],
    },
    agent,
  );
  assert.equal(out.usdc.delta, 100_000_000n);
  assert.equal(out.sol.delta, -1_000_005_000n - 2_039_280n, "the SOL the agent gave up, with fee and rent");
  assert.equal(out.created_usdc_rent, 2_039_280n);
  // Pre-existing wSOL account closed into the agent: neutral.
  const closed = S.balanceDeltas(
    {
      keys: [agent, "w"],
      preBalances: [1_000, 2_039_280 + 500],
      postBalances: [1_000 + 2_039_280 + 500 - 5_000, 0],
      preTokenBalances: [tok(1, WSOL, 500)],
      postTokenBalances: [],
    },
    agent,
  );
  assert.equal(closed.sol.delta, -5_000n, "only the network fee");
  // Tokens of other mints are reported when they move.
  const other = S.balanceDeltas({ keys: [agent, "o"], preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [tok(1, "OtherMint", 10)], postTokenBalances: [tok(1, "OtherMint", 4)] }, agent);
  assert.deepEqual(other.others, [{ mint: "OtherMint", delta: -6n }]);
  // Someone else's token accounts are not the agent's.
  const theirs = S.balanceDeltas({ keys: [agent, "o"], preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [tok(1, USDC_MINT, 10, "Stranger")], postTokenBalances: [tok(1, USDC_MINT, 0, "Stranger")] }, agent);
  assert.equal(theirs.usdc.delta, 0n);
});

// ----------------------------------------------------------------- execute

async function readdressed(fx, to, extraMints = []) {
  // Same recorded swap, but for a throwaway key, so it can really be signed in the test.
  const T = to.address;
  const ata = async (mint) => (await findAssociatedTokenPda({ owner: address(T), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const oldAta = async (mint) => (await findAssociatedTokenPda({ owner: address(fx.wallet), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const map = new Map([[fx.wallet, T], [await oldAta(USDC_MINT), await ata(USDC_MINT)], [await oldAta(WSOL), await ata(WSOL)]]);
  for (const m of extraMints) map.set(await oldAta(m), await ata(m)); // a classic SPL long-tail mint's account
  const swapAll = (text) => [...map].reduce((t, [a, b]) => t.split(a).join(b), text);
  const next = JSON.parse(swapAll(JSON.stringify(fx)));
  next.wallet = T;
  // The simulated token accounts carry their owner as raw bytes (inside base64), which a text swap cannot reach.
  const enc = getAddressEncoder();
  for (const entry of next.rpc.find((c) => c.method === "simulateTransaction").result.value.accounts) {
    const raw = Buffer.from(entry.data[0], "base64");
    if (entry.owner !== TOKEN_PROGRAM_ADDRESS || raw.length !== 165) continue;
    if (Buffer.compare(raw.subarray(32, 64), Buffer.from(enc.encode(address(fx.wallet)))) === 0) {
      Buffer.from(enc.encode(address(T))).copy(raw, 32);
      entry.data[0] = raw.toString("base64");
    }
  }
  const plan = await planFrom(fx);
  const tx = mutate(plan.swap_transaction, (c) => {
    c.staticAccounts = c.staticAccounts.map((a) => map.get(a) ?? a);
  });
  return { fx: next, plan: { ...plan, agent: T, swap_transaction: tx } };
}

async function setup(fxName = USDC_SOL, o = {}) {
  const signer = await generateKeyPairSigner();
  const { fx, plan } = await readdressed(fxName, signer, o.extraMints);
  const rig = fakeRpc(fx, { accountKeys: compiledOf(plan.swap_transaction).staticAccounts, ...o });
  // usdNotional is what the orchestrator measures independently; the plan's own estimate is never used.
  const deps = { rpc: rig.rpc, signer, now: () => plan.built_at + 2_000, sleep: async () => {}, minGapMs: 0, pollMs: 0, usdNotional: 25, ...(o.deps ?? {}) };
  return { signer, fx, plan, rig, deps };
}
const policyAllow = (perTx = "50", perDay = "100") => setPolicy({ perTx, perDay, chains: "solana", swapSlippageBps: "500", maxTradesPerDay: "none" });
const rowsOf = (id) => entries().filter((e) => e.id === id);
const lastRows = () => entries().filter((e) => e.kind === "swap" || e.status);

test("execute: reserve, sign, record the signature, broadcast, confirm, record the real amount out", async () => {
  policyAllow();
  const before = entries().length;
  const { signer, plan, rig, deps } = await setup();
  const out = await S.executeSolanaSwap(plan, deps);
  assert.equal(out.asset_in, "USDC");
  assert.equal(out.asset_out, "SOL");
  assert.equal(out.amount_in, "25000000");
  assert.equal(out.usd, 25);
  assert.match(out.explorer, /^https:\/\/solscan\.io\/tx\//);
  assert.equal(out.fee.account, "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo");
  assert.equal(out.amount_out, out.verification.simulated.output_inflow, "confirmed output (before the network fee) equals what the verified simulation delivered");
  assert.ok(BigInt(out.amount_out) >= BigInt(plan.quote.min_out));

  // What was sent: the verified message, signed by the agent's key, once.
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].opts.encoding, "base64");
  const sent = getTransactionDecoder().decode(b64e.encode(rig.sent[0].wire));
  assert.deepEqual(Object.keys(sent.signatures), [signer.address]);
  assert.ok(sent.signatures[signer.address], "signed");
  assert.deepEqual(sent.messageBytes, getTransactionDecoder().decode(b64e.encode(plan.swap_transaction)).messageBytes, "the signed bytes are the verified bytes");

  // The ledger: submitted (with the swap fields) -> signed (with the signature) -> confirmed (with amount out).
  const rows = entries().slice(before);
  assert.deepEqual(rows.map((r) => r.status), ["submitted", "signed", "confirmed"]);
  assert.deepEqual({ kind: rows[0].kind, chain: rows[0].chain, usd: rows[0].usd, to: rows[0].to, asset_in: rows[0].asset_in, asset_out: rows[0].asset_out, amount_in: rows[0].amount_in, min_out: rows[0].min_out }, {
    kind: "swap", chain: "solana", usd: 25, to: "jupiter", asset_in: "USDC", asset_out: "SOL", amount_in: "25000000", min_out: plan.quote.min_out,
  });
  assert.equal(rows[1].tx, out.tx);
  assert.equal(rows[2].amount_out, out.amount_out);
});

test("execute: a swap over the owner's limit is refused before anything is signed or sent", async () => {
  policyAllow("10", "100");
  const before = entries().length;
  const { plan, rig, deps } = await setup();
  await assert.rejects(S.executeSolanaSwap(plan, deps), (e) => e instanceof Refused && rules(e).includes("max_usd_per_tx"));
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before, "nothing reserved");
});

test("execute: a plan whose blockhash is old is rebuilt, never signed (by age, and by the chain saying the blockhash is gone)", async () => {
  policyAllow();
  const before = entries().length;
  const old = await setup(USDC_SOL);
  await assert.rejects(S.executeSolanaSwap(old.plan, { ...old.deps, now: () => old.plan.built_at + S.PLAN_MAX_AGE_MS + 1 }), S.PlanStale);

  // The chain is asked about the blockhash that is inside the bytes to be signed, at confirmed.
  let asked;
  const gone = await setup(USDC_SOL, { blockhashValid: false, onBlockhashCheck: (hash, opts) => (asked = { hash, opts }) });
  await assert.rejects(S.executeSolanaSwap(gone.plan, gone.deps), (e) => e instanceof S.PlanStale && /no longer valid; rebuild/.test(e.message));
  assert.equal(asked.hash, compiledOf(gone.plan.swap_transaction).lifetimeToken);
  assert.equal(asked.opts.commitment, "confirmed");
  assert.equal(gone.rig.sent.length, 0);
  assert.equal(entries().length, before, "nothing reserved for a stale plan");
});

test("execute: Jupiter's lastValidBlockHeight is not consulted; a plan that claims none or a stale one still signs when the chain says the blockhash is valid", async () => {
  policyAllow("50", "10000");
  const a = await setup(USDC_SOL);
  const b = await setup(USDC_SOL);
  a.plan.last_valid_block_height = 1;
  b.plan.last_valid_block_height = Number.MAX_SAFE_INTEGER;
  for (const x of [a, b]) {
    x.deps.rpc.getBlockHeight = () => assert.fail("the block height must not be read");
    const out = await S.executeSolanaSwap(x.plan, x.deps);
    assert.ok(out.tx);
  }
});

test("execute: if the chain cannot say whether the blockhash is valid, nothing is signed (an error, not a rebuild)", async () => {
  policyAllow();
  const before = entries().length;
  const { plan, rig, deps } = await setup(USDC_SOL, { blockhashThrows: "429 too many requests" });
  await assert.rejects(S.executeSolanaSwap(plan, deps), (e) => !(e instanceof S.PlanStale) && /could not check that the swap's blockhash is still valid.*nothing was signed/.test(e.message));
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before);
});

test("execute: the blockhash running out while reserving still stops before signing, and gives the reservation back", async () => {
  policyAllow();
  const before = entries().length;
  let checks = 0;
  const { plan, rig, deps } = await setup(USDC_SOL, { blockhashValid: () => ++checks === 1 });
  await assert.rejects(S.executeSolanaSwap(plan, deps), S.PlanStale);
  assert.equal(checks, 2, "checked once before verifying and once right before signing");
  assert.equal(rig.sent.length, 0);
  const rows = entries().slice(before);
  assert.deepEqual(rows.map((r) => r.status), ["submitted", "failed"]);
  assert.equal(spentLast24h().usd >= 0, true);
});

test("execute: usdNotional is required and the plan's own USD estimate is never used in its place", async () => {
  policyAllow("50", "10000");
  const before = entries().length;
  const { plan, rig, deps } = await setup(USDC_SOL);
  assert.equal(plan.usd_estimate, 25, "the plan carries an estimate, which must not be a fallback");
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, "25", {}]) {
    const { usdNotional, ...rest } = deps;
    void usdNotional;
    await assert.rejects(S.executeSolanaSwap(plan, bad === undefined ? rest : { ...rest, usdNotional: bad }), /usdNotional is required.*nothing was signed/, `usdNotional ${String(bad)}`);
  }
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before, "nothing reserved");
  // A real value is what the limits are checked against, not the plan's 25.
  policyAllow("10", "100");
  await assert.rejects(S.executeSolanaSwap(plan, { ...deps, usdNotional: 40 }), (e) => e instanceof Refused && rules(e).includes("max_usd_per_tx"));
});

test("execute: a verification failure (the simulation delivers too little) stops before reserving", async () => {
  policyAllow();
  const before = entries().length;
  const { plan, rig, deps } = await setup(USDC_SOL, { editSim: shiftAgentLamports(-10_000_000_000n) });
  await assert.rejects(S.executeSolanaSwap(plan, deps), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.sim_output_inflow");
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before);
});

test("execute: the RPC's own preflight refusing it is Rejected, and the spend is given back", async () => {
  policyAllow();
  const before = entries().length;
  const { plan, deps } = await setup(USDC_SOL, { sendThrows: Object.assign(new Error("Transaction simulation failed"), { context: { __code: -32002 } }) });
  await assert.rejects(S.executeSolanaSwap(plan, deps), Rejected);
  const rows = entries().slice(before);
  assert.deepEqual(rows.map((r) => r.status), ["submitted", "signed", "failed"]);
  assert.match(rows[2].reason, /preflight/);
});

test("execute: any other broadcast error is Pending and stays counted (do not retry, do not re-sign)", async () => {
  policyAllow();
  const before = entries().length;
  const { plan, rig, deps } = await setup(USDC_SOL, { sendThrows: new Error("Solana RPC timed out after 20000 ms") });
  const sentBefore = spentLast24h().usd;
  await assert.rejects(S.executeSolanaSwap(plan, deps), (e) => e instanceof Pending && /Do NOT retry/.test(e.message) && !!e.details.tx);
  assert.equal(rig.sent.length, 1, "broadcast once");
  const rows = entries().slice(before);
  assert.deepEqual(rows.map((r) => r.status), ["submitted", "signed"]);
  assert.equal(spentLast24h().usd - sentBefore, 25, "the spend stays counted");
});

test("execute: a flaky status read continues; an onchain error gives the spend back; no confirmation in time is Pending", async () => {
  policyAllow("50", "10000");
  const flaky = await setup(USDC_SOL, { statuses: ["throw", "none", { confirmationStatus: "processed", err: null }, { confirmationStatus: "finalized", err: null }] });
  const done = await S.executeSolanaSwap(flaky.plan, flaky.deps);
  assert.ok(done.tx);

  const before = entries().length;
  const reverted = await setup(USDC_SOL, { statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6001 }] } }] });
  await assert.rejects(S.executeSolanaSwap(reverted.plan, reverted.deps), /failed onchain/);
  assert.deepEqual(entries().slice(before).map((r) => r.status), ["submitted", "signed", "failed"]);

  const slow = await setup(USDC_SOL, { statuses: Array(5).fill("none") });
  slow.deps.maxPolls = 5;
  await assert.rejects(S.executeSolanaSwap(slow.plan, slow.deps), (e) => e instanceof Pending && /not confirmed/.test(e.message));
});

test("execute: if the confirmed transaction cannot be read, the amount out is null (never zero)", async () => {
  policyAllow("50", "10000");
  const { plan, deps } = await setup(USDC_SOL, { txThrows: true });
  const out = await S.executeSolanaSwap(plan, deps);
  assert.equal(out.amount_out, null);
  assert.equal(entries().at(-1).amount_out, null);
});

test("execute: a signing key that is not the agent's is refused before anything is sent, and the reservation is released", async () => {
  policyAllow("50", "10000");
  const before = entries().length;
  const { plan, rig, deps } = await setup();
  deps.signer = await generateKeyPairSigner();
  await assert.rejects(S.executeSolanaSwap(plan, deps), /not the agent/);
  assert.equal(rig.sent.length, 0);
  assert.deepEqual(entries().slice(before).map((r) => r.status), ["submitted", "failed"]);
});

test("dry run: plans and verifies, reserves nothing, signs nothing, and leaves out the transaction bytes", async () => {
  policyAllow();
  const before = entries().length;
  const { fetch } = fakeFetch(USDC_SOL);
  const rig = fakeRpc(USDC_SOL);
  const out = await S.dryRunSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch, rpc: rig.rpc, minGapMs: 0 });
  assert.equal(out.dry_run, true);
  assert.equal(out.verification.ok, true);
  assert.equal("swap_transaction" in out.plan, false);
  assert.match(out.plan.disclosure.join("\n"), /Sato Hub fee/);
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before);
});

// ================================================================= any SPL / Token-2022 mint against USDC or SOL
//
// The fixtures are real mainnet builds (see TAIL_FIXTURES above). Mint data for the extension rules is synthetic:
// built here, byte by byte, in the layout spl-token and spl-token-2022 use.

const ENC = getAddressEncoder();
const SIM_TAIL = 4; // in a fee-carrying fixture's `accounts` read-back: agent, USDC, wrapped SOL, fee account, the token's account

/** Token-2022 mint-extension bodies (type numbers and sizes are spl-token-2022's ExtensionType). */
const EXT = {
  PermanentDelegate: [12, () => Buffer.alloc(32, 7)],
  TransferHook: [14, () => Buffer.alloc(64, 7)],
  NonTransferable: [9, () => Buffer.alloc(0)],
  ConfidentialTransferMint: [4, () => Buffer.alloc(65, 1)],
  ConfidentialTransferFeeConfig: [16, () => Buffer.alloc(129, 1)],
  ConfidentialMintBurn: [24, () => Buffer.alloc(196, 1)],
  DefaultAccountStateFrozen: [6, () => Buffer.from([2])],
  DefaultAccountStateInitialized: [6, () => Buffer.from([1])],
  PausablePaused: [26, () => Buffer.concat([Buffer.alloc(32, 3), Buffer.from([1])])],
  PausableLive: [26, () => Buffer.concat([Buffer.alloc(32, 3), Buffer.from([0])])],
  MintCloseAuthority: [3, () => Buffer.alloc(32, 5)],
  InterestBearingConfig: [10, () => Buffer.alloc(52, 1)],
  ScaledUiAmountConfig: [25, () => Buffer.alloc(56, 1)],
  MetadataPointer: [18, () => Buffer.alloc(64, 2)],
  TokenMetadata: [19, () => Buffer.alloc(90, 65)],
  TransferFeeConfig: [1, (bps = 250, newerBps = bps) => {
    const b = Buffer.alloc(108);
    Buffer.alloc(32, 9).copy(b, 0); // transfer fee config authority
    b.writeBigUInt64LE(1n, 72); b.writeBigUInt64LE(5_000n, 80); b.writeUInt16LE(bps, 88); // older fee
    b.writeBigUInt64LE(2n, 90); b.writeBigUInt64LE(7_000n, 98); b.writeUInt16LE(newerBps, 106); // newer fee
    return b;
  }],
  Unknown: [99, () => Buffer.alloc(8)],
};
const ext = (name, ...args) => [EXT[name][0], EXT[name][1](...args)];

/** An RPC mint account: spl-token's 82 bytes, and for Token-2022 padding to 165, the account-type byte and a TLV list. */
function mintEntry({ program = TOKEN_PROGRAM_ADDRESS, decimals = 6, mintAuthority = null, freezeAuthority = null, extensions = [], initialized = true, space } = {}) {
  const base = Buffer.alloc(82);
  if (mintAuthority) { base.writeUInt32LE(1, 0); Buffer.from(ENC.encode(address(mintAuthority))).copy(base, 4); }
  base.writeBigUInt64LE(1_000_000_000n, 36);
  base[44] = decimals;
  base[45] = initialized ? 1 : 0;
  if (freezeAuthority) { base.writeUInt32LE(1, 46); Buffer.from(ENC.encode(address(freezeAuthority))).copy(base, 50); }
  let raw = base;
  if (program === TOKEN_2022_PROGRAM && extensions.length) {
    const tlv = Buffer.concat(extensions.map(([type, data]) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(type, 0); h.writeUInt16LE(data.length, 2);
      return Buffer.concat([h, data]);
    }));
    raw = Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), tlv]);
  }
  return { data: [raw.toString("base64"), "base64"], executable: false, lamports: "1461600", owner: program, rentEpoch: "1", space: String(space ?? raw.length) };
}
/** A resolver rig over the recorded fixtures' RPC that serves `entry` for `mint`. */
const rpcFor = (mint, entry) => fakeRpc(BONK_BUY, { accounts: { [mint]: entry } }).rpc;

test("tokens: USDC and SOL are pinned (by symbol, in any case, or by mint) and read nothing from the chain", async () => {
  const noChain = { rpc: new Proxy({}, { get: () => () => { throw new Error("the chain must not be read for a major"); } }) };
  const usdc = await S.resolveSolanaToken("usdc", noChain);
  assert.deepEqual({ mint: usdc.mint, decimals: usdc.decimals, program: usdc.program, major: usdc.major, onchain: usdc.onchain }, { mint: USDC_MINT, decimals: 6, program: TOKEN_PROGRAM_ADDRESS, major: "USDC", onchain: false });
  const sol = await S.resolveSolanaToken("SOL", noChain);
  assert.deepEqual({ mint: sol.mint, decimals: sol.decimals, major: sol.major }, { mint: WSOL, decimals: 9, major: "SOL" });
  assert.equal((await S.resolveSolanaToken(USDC_MINT, noChain)).major, "USDC");
  assert.equal((await S.resolveSolanaToken(WSOL, noChain)).major, "SOL", "the wrapped-SOL mint is SOL");
  for (const t of [usdc, sol]) assert.deepEqual([t.extensions, t.refusals], [[], []]);
});

test("tokens: a classic SPL mint is read from the chain: program, decimals, authorities, no extensions (BONK, recorded)", async () => {
  const t = await S.resolveSolanaToken(BONK, { rpc: fakeRpc(BONK_BUY).rpc });
  assert.equal(t.mint, BONK);
  assert.equal(t.program, TOKEN_PROGRAM_ADDRESS);
  assert.equal(t.program_name, "Token");
  assert.equal(t.decimals, 5);
  assert.equal(t.major, null);
  assert.equal(t.onchain, true);
  assert.equal(t.mint_authority, null);
  assert.equal(t.freeze_authority, null);
  assert.deepEqual(t.extensions, []);
  assert.deepEqual(t.refusals, []);
  assert.equal(t.transfer_fee, null);
  assert.ok(t.notes.some((n) => /No freeze authority/.test(n)) && t.notes.some((n) => /No mint authority/.test(n)));
});

test("tokens: a Token-2022 mint with a transfer fee is read from the chain, the fee reported with its bps, and it is allowed (SI, recorded)", async () => {
  const t = await S.resolveSolanaToken(SI, { rpc: fakeRpc(SI_BUY).rpc });
  assert.equal(t.program, TOKEN_2022_PROGRAM);
  assert.equal(t.program_name, "Token-2022");
  assert.equal(t.decimals, 6);
  assert.deepEqual(t.extensions, ["MetadataPointer", "TransferFeeConfig", "TokenMetadata"]);
  assert.equal(t.transfer_fee.bps, 100);
  assert.equal(t.extension_details.TransferFeeConfig.bps, 100);
  assert.deepEqual(t.refusals, []);
  assert.match(t.notes.join("\n"), /transfer fee of 1% \(100 bps/);
  S.assertSolanaTokenTradable(t); // does not throw
});

test("tokens: Token-2022 extensions that let someone move or freeze the agent's tokens, or stop a sale, are refused, naming the extension", async () => {
  const mint = await randomAddress();
  for (const name of ["PermanentDelegate", "TransferHook", "NonTransferable", "ConfidentialTransferMint", "ConfidentialTransferFeeConfig", "ConfidentialMintBurn"]) {
    // On its own and among harmless ones.
    for (const extensions of [[ext(name)], [ext("MetadataPointer"), ext(name), ext("TokenMetadata")]]) {
      const t = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, extensions })) });
      assert.deepEqual(t.refusals.map((r) => r.rule), ["solana_swap.token_extension_refused"], name);
      assert.match(t.refusals[0].message, new RegExp(`\\b${name}\\b`), "the refusal names the extension");
      assert.throws(() => S.assertSolanaTokenTradable(t), (e) => e instanceof Refused && rules(e).includes("solana_swap.token_extension_refused"));
    }
  }
  // A mint whose new accounts start frozen, or that is paused right now, cannot be sold; one the kit has no table entry for could do anything.
  for (const [extensions, re] of [[[ext("DefaultAccountStateFrozen")], /DefaultAccountState.*frozen/], [[ext("PausablePaused")], /paused right now/], [[ext("Unknown")], /does not know \(type 99\)/]]) {
    const t = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, extensions })) });
    assert.deepEqual(t.refusals.map((r) => r.rule), ["solana_swap.token_extension_refused"]);
    assert.match(t.refusals[0].message, re);
  }
  // All of them at once: every one is named.
  const all = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext("PermanentDelegate"), ext("TransferHook"), ext("NonTransferable")] })) });
  assert.equal(all.refusals.length, 3);
  assert.deepEqual(S.TOKEN_2022_EXTENSION_POLICY.refuse && Object.keys(S.TOKEN_2022_EXTENSION_POLICY.refuse).sort(), ["ConfidentialMintBurn", "ConfidentialTransferFeeConfig", "ConfidentialTransferMint", "NonTransferable", "PermanentDelegate", "TransferHook"]);
});

test("tokens: a transfer fee, a freeze or mint authority, metadata and the like are reported and allowed", async () => {
  const mint = await randomAddress();
  const auth = await randomAddress();
  const t = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, freezeAuthority: auth, mintAuthority: auth, extensions: [ext("MetadataPointer"), ext("TransferFeeConfig", 250, 400), ext("MintCloseAuthority"), ext("PausableLive"), ext("InterestBearingConfig"), ext("DefaultAccountStateInitialized"), ext("TokenMetadata")] })) });
  assert.deepEqual(t.refusals, []);
  assert.equal(t.freeze_authority, auth);
  assert.equal(t.mint_authority, auth);
  assert.equal(t.transfer_fee.bps, 400, "the higher of the older and newer fee, so the owner is never shown less than may be charged");
  assert.equal(t.transfer_fee.older.bps, 250);
  assert.equal(t.transfer_fee.newer.bps, 400);
  const notes = t.notes.join("\n");
  assert.match(notes, new RegExp(`freeze authority is set \\(${auth}\\)`));
  assert.match(notes, new RegExp(`mint authority is set \\(${auth}\\)`));
  assert.match(notes, /transfer fee of 4% \(400 bps/);
  assert.match(notes, /can be paused/);
  assert.match(notes, /can be closed/);
  assert.match(notes, /metadata/);
  assert.match(notes, /interest-adjusted/);
  assert.doesNotMatch(notes, /\b(safe|secure|trusted|guaranteed?|scam|malicious)\b/i);
  S.assertSolanaTokenTradable(t);
  // A classic mint reports its authorities too.
  const classic = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ freezeAuthority: auth })) });
  assert.equal(classic.freeze_authority, auth);
  assert.equal(classic.mint_authority, null);
  assert.deepEqual(classic.refusals, []);
});

test("tokens: an address that is not a readable mint is refused or errors, never guessed at", async () => {
  const mint = await randomAddress();
  const refused = async (entry, re) => {
    await assert.rejects(S.resolveSolanaToken(mint, { rpc: rpcFor(mint, entry) }), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_not_a_mint" && re.test(e.message), re.source);
  };
  await refused(null, /nothing exists at that address/);
  await refused({ ...mintEntry(), owner: "11111111111111111111111111111111" }, /owned by 1111/);
  await refused({ ...mintEntry(), owner: S.JUPITER_PROGRAM }, /not a token mint/);
  await refused(tokenAccountEntry({ mint: USDC_MINT, owner: WALLET }), /token account/); // 165 bytes under the Token program
  await refused(mintEntry({ initialized: false }), /never initialised/);
  await refused({ data: ["AAAA", "base64"], executable: false, lamports: "1", owner: TOKEN_PROGRAM_ADDRESS, space: "3" }, /too short/);
  // Token-2022: a token account (type byte 2) in place of a mint; a truncated extension list; an extension of the wrong size listed twice.
  const t22 = mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext("MetadataPointer")] });
  const raw = Buffer.from(t22.data[0], "base64");
  const asAccount = Buffer.from(raw); asAccount[165] = 2;
  await refused({ ...t22, data: [asAccount.toString("base64"), "base64"] }, /not a mint/);
  await refused({ ...t22, data: [raw.subarray(0, raw.length - 10).toString("base64"), "base64"] }, /malformed extension list/);
  const wrongSize = mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [[12, Buffer.alloc(33)]] }); // a PermanentDelegate of 33 bytes
  await refused(wrongSize, /PermanentDelegate extension is 33 bytes, not the 32/);
  await refused(mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext("MetadataPointer"), ext("MetadataPointer")] }), /lists the MetadataPointer extension twice/);
  // A tag other than 0 or 1 in an optional field.
  const bad = Buffer.from(mintEntry().data[0], "base64"); bad.writeUInt32LE(7, 0);
  await refused({ ...mintEntry(), data: [bad.toString("base64"), "base64"] }, /malformed authority field/);
  // Not an address at all, and an RPC that fails: errors before anything is signed.
  await assert.rejects(S.resolveSolanaToken("BONK", { rpc: rpcFor(mint, null) }), /"BONK" is not USDC, SOL or a Solana mint address/);
  await assert.rejects(S.resolveSolanaToken(mint, { rpc: fakeRpc(BONK_BUY, { accountsThrow: "rpc down" }).rpc }), /could not be read from the chain \(rpc down\); nothing was signed/);
});

test("tokens: a swap with a refused mint, with two tokens, or with the same asset twice is refused before Jupiter is asked", async () => {
  const mint = await randomAddress();
  const calls = [];
  const fetch = async (u) => (calls.push(String(u)), new Response("{}"));
  const base = (entry) => ({ agent: WALLET, satoFeeBps: 15, fetch, minGapMs: 0, rpc: rpcFor(mint, entry) });
  const hooked = mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext("TransferHook")] });
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: mint, amount: "5" }, base(hooked)), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_extension_refused" && /TransferHook/.test(e.message));
  await assert.rejects(S.planSolanaSwap({ from: mint, to: "SOL", amount: "5" }, base(hooked)), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_extension_refused");
  // Token <-> token is a later phase.
  const other = await randomAddress();
  const two = { ...base(mintEntry()), rpc: fakeRpc(BONK_BUY, { accounts: { [mint]: mintEntry(), [other]: mintEntry() } }).rpc };
  await assert.rejects(S.planSolanaSwap({ from: mint, to: other, amount: "5" }, two), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_to_token" && /USDC or SOL/.test(e.message));
  await assert.rejects(S.planSolanaSwap({ from: mint, to: mint, amount: "5" }, base(mintEntry())), /two different assets/);
  await assert.rejects(S.planSolanaSwap({ from: WSOL, to: "SOL", amount: "1" }, base(mintEntry())), /two different assets/);
  assert.deepEqual(calls, [], "Jupiter was never asked");
});


// ----------------------------------------------------------------- plan: a long-tail token

test("plan: a long-tail token asks for shared accounts and multi-hop routes, and the fee account is always the USDC or SOL one", async () => {
  const cases = [
    // fixture, the fee mint, the fee leg
    [BONK_BUY, USDC_MINT, "input"],
    [BONK_SELL, USDC_MINT, "output"],
    [SOL_BONK, WSOL, "input"],
    [BONK_SOL, WSOL, "output"],
    [WIF_BUY, USDC_MINT, "input"],
    [GOAT_SELL, USDC_MINT, "output"],
    [SI_BUY, USDC_MINT, "input"],
    [SI_SELL, USDC_MINT, "output"],
  ];
  for (const [fx, feeMint, leg] of cases) {
    const { fetch, calls } = fakeFetch(fx);
    const plan = await S.planSolanaSwap(fx.request, { agent: fx.wallet, satoFeeBps: 15, fetch, rpc: fakeRpc(fx).rpc, minGapMs: 0, now: () => fx.built_at });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.get("onlyDirectRoutes"), null, "a long-tail token may be routed through other tokens");
    assert.equal(q.get("restrictIntermediateTokens"), "true");
    assert.equal(q.get("platformFeeBps"), "15");
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.useSharedAccounts, true, "the hops sit in Jupiter's own accounts");
    assert.equal(body.feeAccount, S.SATO_FEE_ACCOUNTS[feeMint], `${fx.request.from} -> ${fx.request.to}: the fee account is the one for ${feeMint === USDC_MINT ? "USDC" : "wrapped SOL"}`);
    assert.notEqual(plan.fee.mint, plan.token.mint, "never the long-tail token");
    assert.equal(plan.fee.mint, feeMint);
    assert.equal(plan.fee.leg, leg);
    assert.equal(plan.fee.account, S.SATO_FEE_ACCOUNTS[feeMint]);
    // from / to: the symbol for USDC and SOL, the mint for the token.
    const tokenMint = plan.token.mint;
    assert.deepEqual([plan.from, plan.to].filter((x) => x === tokenMint), [tokenMint]);
    assert.ok([plan.mint_in, plan.mint_out].includes(tokenMint));
    assert.equal(plan.tokens.in.mint, plan.mint_in);
    assert.equal(plan.tokens.out.mint, plan.mint_out);
    assert.equal(plan.tokens.in.decimals, plan.mint_in === tokenMint ? plan.token.decimals : plan.mint_in === USDC_MINT ? 6 : 9);
    assert.match(plan.disclosure.join("\n"), new RegExp(`mint ${tokenMint}`));
    assert.equal(plan.quote.route_hops, plan.quote.route.length || plan.quote.route_hops);
    assert.doesNotMatch(plan.disclosure.join("\n"), /\b(safe|secure|trusted|guaranteed?)\b/i);
  }
  // USDC <-> SOL is unchanged: direct routes, no shared accounts.
  const { fetch, calls } = fakeFetch(USDC_SOL);
  await S.planSolanaSwap(USDC_SOL.request, { agent: WALLET, satoFeeBps: 15, fetch, minGapMs: 0 });
  assert.equal(new URL(calls[0].url).searchParams.get("onlyDirectRoutes"), "true");
  assert.equal(JSON.parse(calls[1].init.body).useSharedAccounts, false);
});

test("plan: the fee text says which leg it comes from; an output fee is a share of the payout, never of the other token", async () => {
  const buy = await planFrom(BONK_BUY);
  assert.match(buy.fee.text, /0\.15% of the USDC you swap \(up to 0\.0075 USDC\)/);
  assert.equal(buy.fee.max_units, "7500");
  assert.equal(buy.fee.estimated, undefined);
  const sell = await planFrom(BONK_SELL);
  assert.match(sell.fee.text, /0\.15% of the USDC the swap pays out \(about [\d.]+ USDC at Jupiter's estimate\).*FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo.*same transaction.*nothing is ever taken in the other token/);
  assert.equal(sell.fee.estimated, true);
  // 15 bps of what the pool paid out: out / (1 - 0.0015) x 0.0015, rounded up, plus a unit.
  const out = BigInt(sell.quote.out_amount);
  assert.ok(BigInt(sell.fee.max_units) >= (out * 15n) / 9985n && BigInt(sell.fee.max_units) <= (out * 15n) / 9985n + 2n, sell.fee.max_units);
  const sellSol = await planFrom(BONK_SOL);
  assert.match(sellSol.fee.text, /0\.15% of the SOL the swap pays out/);
});

test("plan: amounts of a token follow the mint's decimals, strictly; SOL <-> token has no USD estimate, USDC <-> token has", async () => {
  const bad = (p, re) => assert.rejects(S.planSolanaSwap(p, { agent: WALLET, satoFeeBps: 15, fetch: fakeFetch(BONK_SELL).fetch, rpc: fakeRpc(BONK_SELL).rpc, minGapMs: 0 }), re);
  await bad({ from: BONK, to: "USDC", amount: "1.000001" }, /not a .* amount: "1\.000001" \(a plain number with at most 5 decimals\)/); // BONK has 5
  await bad({ from: BONK, to: "USDC", amount: "0" }, /not a positive/);
  await bad({ from: BONK, to: "USDC", amount: "-1" }, /not a .* amount/);
  await bad({ from: BONK, to: "USDC", amount: "1e3" }, /not a .* amount/);
  await bad({ from: BONK, to: "USDC", amount: "184467440737095516160" }, /too large to count exactly/);
  assert.equal(S.tokenUnits("1.5", 5), 150000n);
  assert.equal(S.tokenUnits("3", 0), 3n);
  assert.throws(() => S.tokenUnits("3.1", 0), /at most 0 decimals/);
  const sell = await planFrom(BONK_SELL);
  assert.equal(sell.amount_in, "50000000000", "500,000 BONK at 5 decimals");
  assert.equal(sell.usd_estimate, Number(sell.quote.out_amount) / 1e6, "read off the USDC leg");
  const buy = await planFrom(BONK_BUY);
  assert.equal(buy.usd_estimate, 5);
  assert.equal((await planFrom(SOL_BONK)).usd_estimate, null, "no USDC leg: the caller prices it independently");
  assert.equal((await planFrom(BONK_SOL)).usd_estimate, null);
});

test("plan: Jupiter's price impact is passed through (as sent, and in basis points), never enforced; a missing one is null", async () => {
  const edit = (impact) => fakeFetch(BONK_SELL, { edit: (path, text) => (path.startsWith("/quote") ? JSON.stringify({ ...JSON.parse(text), priceImpactPct: impact }) : text) });
  const run = (impact) => S.planSolanaSwap(BONK_SELL.request, { agent: BONK_SELL.wallet, satoFeeBps: 15, fetch: edit(impact).fetch, rpc: fakeRpc(BONK_SELL).rpc, minGapMs: 0, now: () => BONK_SELL.built_at });
  // Jupiter's priceImpactPct is a fraction: 0.0344 is 3.44% (measured on 2026-10-09).
  const big = await run("0.0344");
  assert.equal(big.quote.price_impact_pct, "0.0344");
  assert.equal(big.quote.price_impact_bps, 344);
  assert.match(big.disclosure.join("\n"), /Price impact: Jupiter estimates this swap moves the price by about 3\.44%/);
  // A 40% impact still plans and still verifies: it is shown, not limited (the caller decides).
  const huge = await run("0.4");
  assert.equal(huge.quote.price_impact_bps, 4000);
  assert.equal((await S.verifySolanaSwapPlan(huge, intentOf(BONK_SELL), verifyDeps(BONK_SELL))).ok, true);
  const none = await run(undefined);
  assert.equal(none.quote.price_impact_pct, null);
  assert.equal(none.quote.price_impact_bps, null);
  assert.doesNotMatch(none.disclosure.join("\n"), /Price impact/);
  const real = await planFrom(BONK_BUY);
  assert.equal(real.quote.price_impact_pct, JSON.parse(BONK_BUY.http[0].text).priceImpactPct, "the recorded value, as sent");
});

test("plan: a fee account other than the pinned one for the USDC or SOL side is refused, with a token on either side", async () => {
  const mk = (extra) => ({ agent: BONK_SELL.wallet, fetch: fakeFetch(BONK_SELL).fetch, rpc: fakeRpc(BONK_SELL).rpc, minGapMs: 0, satoFeeBps: 15, ...extra });
  // Selling BONK for USDC: the USDC account is the pinned one; the wrapped-SOL account is not.
  await assert.rejects(S.planSolanaSwap(BONK_SELL.request, mk({ feeAccount: S.SATO_FEE_ACCOUNTS[WSOL] })), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.fee_account_unpinned");
  const ok = await S.planSolanaSwap(BONK_SELL.request, mk({ feeAccount: S.SATO_FEE_ACCOUNTS[USDC_MINT] }));
  assert.equal(ok.fee.account, S.SATO_FEE_ACCOUNTS[USDC_MINT]);
});

// ----------------------------------------------------------------- verify: the recorded long-tail builds

test("verify: every recorded long-tail build passes, read as Jupiter's shared_accounts_route, with the fee on the USDC or SOL side", async () => {
  for (const fx of TAIL_FIXTURES) {
    const label = `${fx.request.from.slice(0, 4)} -> ${fx.request.to.slice(0, 4)}`;
    const plan = await planFrom(fx);
    const v = await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx));
    assert.equal(v.ok, true, label);
    assert.equal(v.jupiter.instruction, "shared_accounts_route", label);
    assert.equal(v.jupiter.in_amount, plan.amount_in, label);
    assert.equal(v.jupiter.quoted_out, plan.quote.out_amount, label);
    assert.equal(v.jupiter.platform_fee_bps, 15);
    assert.equal(v.jupiter.enforced_min_out, plan.quote.min_out);
    assert.ok(BigInt(v.simulated.output_inflow) >= BigInt(plan.quote.min_out), label);
    assert.equal(v.simulated.fee_leg, plan.fee.leg);
    // The fee observed in the USDC or SOL account is within the disclosed share.
    assert.ok(BigInt(v.simulated.fee_observed_units) > 0n && BigInt(v.simulated.fee_observed_units) <= BigInt(v.simulated.fee_disclosed_max_units), label);
    if (plan.fee.leg === "input") assert.equal(v.simulated.fee_observed_units, ((BigInt(plan.amount_in) * 15n) / 10000n).toString(), "15 bps of the input");
    assert.equal(v.token.mint, plan.token.mint);
    assert.equal(v.token.program, plan.token.program);
    assert.ok(v.programs.every((p) => S.SWAP_PROGRAM_ALLOWLIST[p.id]), label);
  }
  // Two or more hops, through Jupiter's accounts: the agent holds no account for the middle tokens.
  assert.ok((await S.verifySolanaSwapPlan(await planFrom(WIF_BUY), intentOf(WIF_BUY), verifyDeps(WIF_BUY))).jupiter.route_steps >= 2);
  assert.ok((await S.verifySolanaSwapPlan(await planFrom(GOAT_SELL), intentOf(GOAT_SELL), verifyDeps(GOAT_SELL))).jupiter.route_steps >= 3);
});

test("verify: a Token-2022 buy creates the agent's account under Token-2022 (rent counted), and a transfer fee leaves the plan's minimum as the check", async () => {
  const plan = await planFrom(SI_BUY);
  const v = await S.verifySolanaSwapPlan(plan, intentOf(SI_BUY), verifyDeps(SI_BUY));
  assert.deepEqual(v.token.extensions, ["MetadataPointer", "TransferFeeConfig", "TokenMetadata"]);
  assert.equal(v.token.transfer_fee_bps, 100);
  assert.equal(v.token.program_name, "Token-2022");
  assert.ok(BigInt(v.simulated.created_token_rent_lamports) > 0n && BigInt(v.simulated.created_token_rent_lamports) < 3_000_000n, "the new Token-2022 account's rent");
  assert.equal(v.simulated.created_usdc_rent_lamports, "0");
  assert.ok(v.programs.some((p) => p.name === "Associated Token"));
  // The agent's net balance is what is held to the minimum, so a transfer fee that took more than the slippage allows is refused.
  const got = await refusedBy(plan, SI_BUY, { editSim: (sim) => {
    const keys = [...compiledOf(plan.swap_transaction).staticAccounts, ...sim.loadedAddresses.writable, ...sim.loadedAddresses.readonly];
    const i = keys.indexOf(PLAN_TAIL_ATA.get(SI_BUY));
    const t = sim.postTokenBalances.find((b) => b.accountIndex === i);
    t.uiTokenAmount.amount = (BigInt(t.uiTokenAmount.amount) * 98n / 100n).toString(); // 2% gone, slippage allows 1.5%
  } });
  assert.deepEqual(got, ["solana_swap.sim_output_inflow"]);
});

const PLAN_TAIL_ATA = new Map();
for (const [fx, program] of [[BONK_BUY, TOKEN_PROGRAM_ADDRESS], [BONK_SELL, TOKEN_PROGRAM_ADDRESS], [SOL_BONK, TOKEN_PROGRAM_ADDRESS], [BONK_SOL, TOKEN_PROGRAM_ADDRESS], [SI_BUY, TOKEN_2022_PROGRAM], [SI_SELL, TOKEN_2022_PROGRAM]]) {
  const mint = [fx.request.from, fx.request.to].find((x) => x !== "USDC" && x !== "SOL");
  PLAN_TAIL_ATA.set(fx, (await findAssociatedTokenPda({ owner: address(fx.wallet), mint: address(mint), tokenProgram: address(program) }))[0]);
}

test("verify: the plan is checked against what the chain says about the mint, read again here", async () => {
  const plan = await planFrom(BONK_BUY);
  // The mint now carries a permanent delegate (the fake chain says so): the swap is refused though the transaction is untouched.
  const hooked = mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext("PermanentDelegate")] });
  const deps = { rpc: fakeRpc(BONK_BUY, { accounts: { [BONK]: hooked } }).rpc, minGapMs: 0 };
  await assert.rejects(S.verifySolanaSwapPlan(plan, intentOf(BONK_BUY), deps), (e) => e instanceof Refused && rules(e).includes("solana_swap.token_extension_refused"));
  // A plan that describes the token differently from the chain (here: decimals) is refused.
  const lied = { ...plan, token: { ...plan.token, decimals: 9 } };
  assert.ok((await refusedBy(lied, BONK_BUY)).includes("solana_swap.intent"));
  // A token on both sides, and a USDC swap where the plan names a token that is not what was asked.
  const swapped = { ...plan, to: "SOL", mint_out: WSOL };
  assert.ok((await refusedBy(swapped, BONK_BUY)).includes("solana_swap.intent"));
  const intentTokens = { ...intentOf(BONK_BUY), from: BONK, to: SI };
  await assert.rejects(S.verifySolanaSwapPlan(plan, intentTokens, { rpc: fakeRpc(BONK_BUY, { accounts: { [SI]: fakeRpc(SI_BUY).rpc && mintEntry() } }).rpc }), (e) => e instanceof Refused && rules(e).includes("solana_swap.token_to_token"));
});

test("verify: the fee is held to the USDC or SOL side whatever the plan says (an account for the token, the wrong side, or the wrong leg is refused)", async () => {
  const stranger = await randomAddress();
  const plan = await planFrom(BONK_SELL);
  const run = (fee) => refusedBy({ ...plan, fee: { ...plan.fee, ...fee } }, BONK_SELL);
  assert.ok((await run({ account: stranger })).includes("solana_swap.fee_account"));
  assert.ok((await run({ account: S.SATO_FEE_ACCOUNTS[WSOL] })).includes("solana_swap.fee_account"), "the wrapped-SOL account is not the one for a USDC payout");
  assert.ok((await run({ mint: BONK })).includes("solana_swap.fee_account"), "a fee in the token being sold");
  assert.ok((await run({ leg: "input" })).includes("solana_swap.fee_account"), "a sell's fee comes from the payout");
  const buy = await planFrom(BONK_BUY);
  assert.ok((await refusedBy({ ...buy, fee: { ...buy.fee, leg: "output" } }, BONK_BUY)).includes("solana_swap.fee_account"));
  assert.ok((await refusedBy({ ...buy, fee: { ...buy.fee, mint: BONK } }, BONK_BUY)).includes("solana_swap.fee_account"));
});

// ----------------------------------------------------------------- Jupiter's shared_accounts_route: decode

const ixData = (fx) => jupiterIxs(compiledOf(JSON.parse(fx.http.find((h) => h.url === "/swap").text).swapTransaction))[0].data;

test("decode: shared_accounts_route is the route's data with an id byte in front; the arguments are read where the route plan ends", () => {
  assert.equal(S.JUPITER_SHARED_ROUTE_DISCRIMINATOR, "c1209b3341d69c81");
  assert.equal(createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).toString("hex"), S.JUPITER_SHARED_ROUTE_DISCRIMINATOR, "Anchor's rule");
  for (const fx of TAIL_FIXTURES) {
    const data = ixData(fx);
    assert.equal(Buffer.from(data).subarray(0, 8).toString("hex"), S.JUPITER_SHARED_ROUTE_DISCRIMINATOR);
    const r = S.decodeJupiterRoute(data);
    assert.equal(r.instruction, "shared_accounts_route");
    assert.equal(r.id, data[8]);
    assert.ok(r.id >= 0 && r.id <= 255 && r.steps >= 1);
    const plan = JSON.parse(fx.http.find((h) => h.url.startsWith("/quote")).text);
    assert.equal(r.inAmount.toString(), plan.inAmount);
    assert.equal(r.quotedOut.toString(), plan.outAmount);
    assert.equal(r.slippageBps, fx.request.slippageBps);
    assert.equal(r.platformFeeBps, 15);
  }
  const honest = ixData(BONK_BUY);
  assert.throws(() => S.decodeJupiterRoute(Uint8Array.from([...honest, 0])), /extra or missing bytes/);
  assert.throws(() => S.decodeJupiterRoute(honest.subarray(0, honest.length - 1)), /extra or missing bytes|runs past/);
  assert.throws(() => S.decodeJupiterRoute(Uint8Array.from(honest.subarray(0, 13))), /too short/);
  // The id byte is not part of the route plan: a plan length read from the wrong place is refused, not misread.
  const shifted = Uint8Array.from([...honest.subarray(0, 8), ...honest.subarray(9)]); // the id byte removed, still the shared discriminator
  assert.throws(() => S.decodeJupiterRoute(shifted), /RouteLayout|extra or missing|runs past|claims more|newer|malformed|too short/);
  // A route (not shared) read with the id byte in the front of its plan is not accepted either.
  const asRoute = Uint8Array.from(honest); asRoute.set(Buffer.from(S.JUPITER_ROUTE_DISCRIMINATOR, "hex"), 0);
  assert.throws(() => S.decodeJupiterRoute(asRoute), /RouteLayout|extra or missing|runs past|claims more|newer|malformed|too short/);
  // The Swap variants of a shared route are found to their end like a route's.
  const { encode, byName } = idlWalker(JUP_IDL.types);
  const swapN = byName.Swap.type.variants.length;
  const tail = [...u64le(1_000_000), ...u64le(900_000), ...u16le(50), 15];
  for (let v = 0; v < swapN; v += 7) {
    const swapBytes = encode({ defined: { name: "Swap" } }, { optSome: true, variant: (name, n) => (name === "Swap" ? v : 0) });
    const d = Uint8Array.from([...Buffer.from(S.JUPITER_SHARED_ROUTE_DISCRIMINATOR, "hex"), 4, ...u32le(2), ...swapBytes, 100, 0, 1, 0, 100, 1, 2, ...tail]);
    const r = S.decodeJupiterRoute(d);
    assert.deepEqual([r.instruction, r.id, r.steps, r.inAmount, r.quotedOut, r.slippageBps, r.platformFeeBps], ["shared_accounts_route", 4, 2, 1_000_000n, 900_000n, 50, 15], `variant ${v}`);
  }
});

test("decode: the account indices the kit reads are the IDL's (names, order, optional ones) and the stored IDL has both forms", () => {
  assert.equal(JUP_IDL.instructions.shared_accounts_route, S.JUPITER_SHARED_ROUTE_DISCRIMINATOR);
  const names = JUP_IDL.shared_accounts_route.accounts.map((a) => a.name);
  const L = S.ROUTE_ACCOUNTS.shared_accounts_route;
  assert.equal(names[L.tokenProgram], "token_program");
  assert.equal(names[L.programAuthority], "program_authority");
  assert.equal(names[L.authority], "user_transfer_authority");
  assert.equal(JUP_IDL.shared_accounts_route.accounts[L.authority].signer, true);
  assert.equal(names[L.source], "source_token_account");
  assert.equal(names[L.programSource], "program_source_token_account");
  assert.equal(names[L.programDest], "program_destination_token_account");
  assert.equal(names[L.dest], "destination_token_account");
  assert.equal(names[L.sourceMint], "source_mint");
  assert.equal(names[L.destMint], "destination_mint");
  assert.equal(names[L.fee], "platform_fee_account");
  assert.equal(names[L.token2022Program], "token_2022_program");
  assert.equal(names[L.program], "program");
  assert.deepEqual(JUP_IDL.shared_accounts_route.accounts.filter((a) => a.optional).map((a) => a.name), ["platform_fee_account", "token_2022_program"]);
  assert.equal(names.length, L.min, "a shared route has this many accounts before the venues' own");
  assert.deepEqual(JUP_IDL.shared_accounts_route.args.map((a) => a.name), ["id", "route_plan", "in_amount", "quoted_out_amount", "slippage_bps", "platform_fee_bps"]);
  assert.deepEqual(JUP_IDL.shared_accounts_route.args.map((a) => a.type).filter((t) => typeof t === "string"), ["u8", "u64", "u64", "u16", "u8"]);
  const R = S.ROUTE_ACCOUNTS.route;
  const rnames = JUP_IDL.route.accounts.map((a) => a.name);
  assert.deepEqual([rnames[R.tokenProgram], rnames[R.authority], rnames[R.source], rnames[R.dest], rnames[R.destMint], rnames[R.fee], rnames[R.program]], ["token_program", "user_transfer_authority", "source_token_account".replace("source_token_account", "user_source_token_account"), "user_destination_token_account", "destination_mint", "platform_fee_account", "program"]);
  assert.ok(Object.isFrozen(S.ROUTE_ACCOUNTS) && Object.isFrozen(S.ROUTE_ACCOUNTS.route) && Object.isFrozen(S.ROUTE_ACCOUNTS.shared_accounts_route));
});

test("decode: the real builds' accounts are where the IDL says: program authority, its accounts, the agent's accounts, the fee account, the mints", async () => {
  const { getProgramDerivedAddress } = await import("@solana/kit");
  for (const fx of TAIL_FIXTURES) {
    const plan = await planFrom(fx);
    const swap = JSON.parse(fx.http.find((h) => h.url === "/swap").text).swapTransaction;
    const c = compiledOf(swap);
    const tx = getTransactionDecoder().decode(b64e.encode(swap));
    void tx;
    const alts = await fetchAddressesForLookupTables([...new Set((c.addressTableLookups ?? []).map((l) => l.lookupTableAddress))], fakeRpc(fx).rpc);
    const keys = [...c.staticAccounts, ...c.addressTableLookups.flatMap((l) => l.writableIndexes.map((i) => alts[l.lookupTableAddress][i])), ...c.addressTableLookups.flatMap((l) => l.readonlyIndexes.map((i) => alts[l.lookupTableAddress][i]))];
    const ixn = jupiterIxs(c)[0];
    const at = (i) => keys[ixn.accountIndices[i]];
    const L = S.ROUTE_ACCOUNTS.shared_accounts_route;
    const id = ixn.data[8];
    const [authority] = await getProgramDerivedAddress({ programAddress: address(S.JUPITER_PROGRAM), seeds: [new TextEncoder().encode("authority"), Uint8Array.of(id)] });
    assert.equal(at(L.programAuthority), authority, "PDA ['authority', [id]] of Jupiter's program");
    assert.equal(at(L.authority), fx.wallet);
    assert.equal(at(L.sourceMint), plan.mint_in);
    assert.equal(at(L.destMint), plan.mint_out);
    assert.equal(at(L.fee), plan.fee.account);
    assert.equal(at(L.program), S.JUPITER_PROGRAM);
    assert.equal(at(L.tokenProgram), TOKEN_PROGRAM_ADDRESS, "the classic Token program in slot 0, even for a Token-2022 mint");
    const prog = (mint) => (mint === SI ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ADDRESS);
    const ata = async (owner, mint) => (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(prog(mint)) }))[0];
    assert.equal(at(L.source), await ata(fx.wallet, plan.mint_in), "the agent's own associated account for the input");
    assert.equal(at(L.dest), await ata(fx.wallet, plan.mint_out), "the agent's own associated account for the output");
    // The slots in the middle: the authority's own account, or (seen for a Token-2022 output) the agent's.
    assert.ok([await ata(authority, plan.mint_in), await ata(fx.wallet, plan.mint_in)].includes(at(L.programSource)));
    assert.ok([await ata(authority, plan.mint_out), await ata(fx.wallet, plan.mint_out)].includes(at(L.programDest)));
    assert.ok([S.JUPITER_PROGRAM, TOKEN_2022_PROGRAM].includes(at(L.token2022Program)));
  }
});

// ----------------------------------------------------------------- verify: tampering with a shared_accounts_route

test("verify refuses (shared route): in_amount, quoted_out, slippage and platform_fee_bps rewritten in Jupiter's instruction", async () => {
  for (const fx of [BONK_BUY, BONK_SELL, WIF_BUY]) {
    const plan = await planFrom(fx);
    const amount = BigInt(plan.amount_in);
    for (const inAmount of [1n, amount - 1n, amount + 1n]) {
      const got = await refusalsOf(withArgs(plan, { inAmount }), fx);
      assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_amount_mismatch"], `${fx.request.to.slice(0, 4)} in_amount ${inAmount}`);
    }
    // The minimum output: quoted_out=1, slippage 10000, and both; an honest-looking copy of the tail appended after tampered ones.
    for (const a of [{ quotedOut: 1n }, { slippageBps: 10_000 }, { quotedOut: 1n, slippageBps: 10_000 }, { slippageBps: 0 }, { slippageBps: 51 }]) {
      assert.ok((await refusedBy(withArgs(plan, a), fx)).includes("solana_swap.min_out_not_enforced"), JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    const trailing = withTx(plan, mutate(plan.swap_transaction, (c) => {
      const jix = jupiterIxs(c)[0];
      const honestTail = Buffer.from(jix.data).subarray(jix.data.length - ARGS);
      writeArgs(jix, { quotedOut: 1n, slippageBps: 10_000 });
      jix.data = new Uint8Array(Buffer.concat([Buffer.from(jix.data), honestTail]));
    }));
    assert.deepEqual(await refusedBy(trailing, fx), ["solana_swap.jupiter_instruction_unrecognized"]);
    // The fee: a different rate, none, and a higher one.
    for (const feeBps of [0, 14, 16, 255]) {
      assert.ok((await refusedBy(withArgs(plan, { feeBps }), fx)).includes("solana_swap.fee_not_as_disclosed"), `fee ${feeBps}`);
    }
  }
});

test("verify refuses (shared route): the fee, the destination, the source and the authority pointed at accounts that are not the agent's or Sato's", async () => {
  const stranger = await randomAddress();
  const L = S.ROUTE_ACCOUNTS.shared_accounts_route;
  for (const fx of [BONK_BUY, BONK_SELL, SI_BUY, SI_SELL]) {
    const plan = await planFrom(fx);
    const tag = `${fx.request.from.slice(0, 4)} -> ${fx.request.to.slice(0, 4)}`;
    const want = {
      [L.fee]: "solana_swap.fee_not_as_disclosed",
      [L.dest]: "solana_swap.recipient_not_agent",
      [L.source]: "solana_swap.jupiter_source_not_agent",
      [L.authority]: "solana_swap.jupiter_authority_not_agent",
      [L.programAuthority]: "solana_swap.jupiter_account_mismatch",
      [L.programSource]: "solana_swap.jupiter_account_mismatch",
      [L.programDest]: "solana_swap.jupiter_account_mismatch",
      [L.sourceMint]: "solana_swap.jupiter_account_mismatch",
      [L.destMint]: "solana_swap.jupiter_account_mismatch",
      [L.program]: "solana_swap.jupiter_account_mismatch",
      [L.tokenProgram]: "solana_swap.jupiter_account_mismatch",
      [L.token2022Program]: "solana_swap.jupiter_account_mismatch",
    };
    for (const [slot, rule] of Object.entries(want)) {
      const got = await refusedBy(withAccount(plan, Number(slot), stranger), fx);
      assert.ok(got.includes(rule), `${tag}: slot ${slot} -> ${rule}, got ${got.join()}`);
    }
    // The authority's id: a different id byte names a different program authority than the accounts do.
    const otherId = withTx(plan, mutate(plan.swap_transaction, (c) => {
      const jix = jupiterIxs(c)[0];
      const d = Buffer.from(jix.data); d[8] = (d[8] + 1) % 256; jix.data = new Uint8Array(d);
    }));
    assert.deepEqual(await refusedBy(otherId, fx), ["solana_swap.jupiter_account_mismatch"], tag);
  }
  // The agent's own destination and source swapped for one another's mint, or the agent's USDC account for the token's.
  const buy = await planFrom(BONK_BUY);
  const bonkAta = (await findAssociatedTokenPda({ owner: address(BONK_BUY.wallet), mint: address(BONK), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  assert.ok((await refusedBy(withAccount(buy, L.source, bonkAta), BONK_BUY)).includes("solana_swap.jupiter_source_not_agent"), "the input taken from the account of the token being bought");
});

test("verify refuses (shared route): a shared route in a USDC <-> SOL swap, and the other Jupiter forms everywhere", async () => {
  // USDC <-> SOL keeps the direct, non-shared route: the shared form is refused by name there.
  const plan = await planFrom(USDC_SOL);
  const disc = (hex) => mutate(plan.swap_transaction, (c) => {
    const d = Buffer.from(jupiterIxs(c)[0].data);
    Buffer.from(hex, "hex").copy(d, 0);
    jupiterIxs(c)[0].data = new Uint8Array(d);
  });
  const got = await refusalsOf(withTx(plan, disc(S.JUPITER_SHARED_ROUTE_DISCRIMINATOR)), USDC_SOL);
  assert.deepEqual(got.map((r) => r.rule), ["solana_swap.jupiter_instruction_unrecognized"]);
  assert.match(got[0].message, /Jupiter's shared_accounts_route, which this kit does not read or allow/);
  // With a token, every other form is still refused by name.
  const tail = await planFrom(BONK_BUY);
  const tdisc = (hex) => withTx(tail, mutate(tail.swap_transaction, (c) => {
    const d = Buffer.from(jupiterIxs(c)[0].data);
    Buffer.from(hex, "hex").copy(d, 0);
    jupiterIxs(c)[0].data = new Uint8Array(d);
  }));
  for (const [hex, name] of Object.entries(S.JUPITER_INSTRUCTION_NAMES)) {
    if (name === "route" || name === "shared_accounts_route") continue;
    const r = await refusalsOf(tdisc(hex), BONK_BUY);
    assert.deepEqual(r.map((x) => x.rule), ["solana_swap.jupiter_instruction_unrecognized"], name);
    assert.match(r[0].message, new RegExp(`is Jupiter's ${name}, which this kit does not read or allow`));
  }
  // A second Jupiter instruction beside a shared route is refused as a count (and the extra one by name).
  const two = withTx(tail, mutate(tail.swap_transaction, (c) => {
    const jix = jupiterIxs(c)[0];
    c.instructions.splice(c.instructions.indexOf(jix) + 1, 0, { ...jix, accountIndices: [...jix.accountIndices], data: new Uint8Array(jix.data) });
  }));
  assert.deepEqual(await refusedBy(two, BONK_BUY), ["solana_swap.jupiter_route_count"]);
  // Too few accounts for a shared route.
  const short = withTx(tail, mutate(tail.swap_transaction, (c) => { jupiterIxs(c)[0].accountIndices = jupiterIxs(c)[0].accountIndices.slice(0, 11); }));
  assert.deepEqual(await refusedBy(short, BONK_BUY), ["solana_swap.jupiter_instruction_unrecognized"]);
});

// ----------------------------------------------------------------- the agent's account for the token: creation, balance, post-state

/** Decode and inspect a recorded build (lookup tables from the fixture), as verify does before the simulation. */
async function inspectFixture(fx, { tx, tail, feeBps = 15 } = {}) {
  const plan = await planFrom(fx);
  const swap = tx ?? plan.swap_transaction;
  const rpc = fakeRpc(fx).rpc;
  const tables = [...new Set((compiledOf(swap).addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
  const alts = tables.length ? await fetchAddressesForLookupTables(tables, rpc) : {};
  const t = tail ?? (await S.resolveSolanaToken(plan.token.mint, { rpc }));
  return S.inspectSolanaSwapTransaction(swap, { agent: fx.wallet, mintIn: plan.mint_in, mintOut: plan.mint_out, amountIn: BigInt(plan.amount_in), feeAccount: feeBps ? plan.fee.account : null, feeBps, slippageBps: fx.request.slippageBps, minOut: BigInt(plan.quote.min_out), tail: { mint: t.mint, program: t.program } }, alts);
}
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ataIxs = (c) => c.instructions.filter((i) => c.staticAccounts[i.programAddressIndex] === ATA_PROGRAM);
/** Point one account slot of the first instruction of a program at another address (added as a read-only key). */
function rewire(tx64, programId, slot, addr, which = 0) {
  return mutate(tx64, (c) => {
    const old = c.staticAccounts.length;
    c.staticAccounts.push(addr);
    c.header.numReadonlyNonSignerAccounts += 1;
    for (const i of c.instructions) {
      if (i.accountIndices) i.accountIndices = i.accountIndices.map((x) => (x >= old ? x + 1 : x));
      if (i.programAddressIndex >= old) i.programAddressIndex += 1;
    }
    c.instructions.filter((i) => c.staticAccounts[i.programAddressIndex] === programId)[which].accountIndices[slot] = old;
  });
}

test("accounts: a brand-new agent's real builds (BONK buy and sell) inspect cleanly, and the buy creates exactly one account: the agent's own for BONK", async () => {
  const buy = await inspectFixture(FRESH_BUY);
  assert.deepEqual(buy.refusals, []);
  const bonkAta = (await findAssociatedTokenPda({ owner: address(FRESH_BUY.wallet), mint: address(BONK), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  assert.deepEqual(buy.facts.created_atas, [bonkAta]);
  assert.equal(buy.facts.route.instruction, "shared_accounts_route");
  assert.ok(buy.facts.route.steps >= 2);
  const sell = await inspectFixture(FRESH_SELL);
  assert.deepEqual(sell.refusals, []);
  assert.equal(sell.facts.created_atas.length, 1, "the wrapped-SOL account for the payout");
  // The creation in the buy is idempotent, under the Token program, payer and owner the agent.
  const c = compiledOf(FRESH_BUY.http.find((h) => h.url === "/swap").text && JSON.parse(FRESH_BUY.http.find((h) => h.url === "/swap").text).swapTransaction);
  const create = ataIxs(c);
  assert.equal(create.length, 1);
  assert.deepEqual(Array.from(create[0].data), [1]);
});

test("accounts: the creation is only the agent's own account, idempotent, for the swapped token, once; anything else about it is refused", async () => {
  const stranger = await randomAddress();
  const swap = JSON.parse(FRESH_BUY.http.find((h) => h.url === "/swap").text).swapTransaction;
  const bad = async (tx, re) => {
    const r = await inspectFixture(FRESH_BUY, { tx });
    assert.ok(r.refusals.some((x) => x.rule === "solana_swap.ata_instruction" && re.test(x.message)), `${re}: ${r.refusals.map((x) => x.rule + " " + x.message).join(" | ")}`);
  };
  await bad(rewire(swap, ATA_PROGRAM, 2, stranger), /not exactly the agent's own idempotent account/); // an account for someone else
  await bad(rewire(swap, ATA_PROGRAM, 1, stranger), /not exactly the agent's own idempotent account/); // not the derived address
  await bad(rewire(swap, ATA_PROGRAM, 0, stranger), /not exactly the agent's own idempotent account/); // someone else pays
  await bad(rewire(swap, ATA_PROGRAM, 5, TOKEN_2022_PROGRAM), /not exactly the agent's own idempotent account/); // BONK is a classic mint
  await bad(rewire(swap, ATA_PROGRAM, 3, stranger), /neither|not the agent's own USDC, wrapped-SOL or swapped-token account/); // a mint that is not the swapped one
  await bad(mutate(swap, (c) => { const d = ataIxs(c)[0]; d.data = new Uint8Array([0]); }), /not exactly the agent's own idempotent account/); // plain create, not idempotent
  await bad(mutate(swap, (c) => { const d = ataIxs(c)[0]; d.data = new Uint8Array([2]); }), /Associated Token instruction this kit does not allow/);
  // A second creation of the same account.
  await bad(mutate(swap, (c) => { const d = ataIxs(c)[0]; c.instructions.splice(c.instructions.indexOf(d) + 1, 0, { ...d, accountIndices: [...d.accountIndices], data: new Uint8Array(d.data) }); }), /a second time/);
  // The Token-2022 buy (recorded, funded): the creation is under Token-2022, and the same changes are refused there.
  const siPlan = await planFrom(SI_BUY);
  const siTx = (fn) => withTx(siPlan, fn(siPlan.swap_transaction));
  assert.equal(ataIxs(compiledOf(siPlan.swap_transaction)).length, 1, "the recorded Token-2022 buy creates the agent's account");
  assert.deepEqual(await refusedBy(siTx((t) => rewire(t, ATA_PROGRAM, 5, TOKEN_PROGRAM_ADDRESS)), SI_BUY), ["solana_swap.ata_instruction"], "a Token-2022 mint's account made under the classic Token program");
  assert.deepEqual(await refusedBy(siTx((t) => rewire(t, ATA_PROGRAM, 2, stranger)), SI_BUY), ["solana_swap.ata_instruction"]);
});

test("accounts: the same creation rules on a plain `route` with a token, built by hand (classic and Token-2022 mints)", async () => {
  const agent = (await generateKeyPairSigner()).address;
  const SYS = "11111111111111111111111111111111";
  for (const program of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM]) {
    const mint = await randomAddress();
    const usdcAta = (await findAssociatedTokenPda({ owner: address(agent), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const tokenAta = (await findAssociatedTokenPda({ owner: address(agent), mint: address(mint), tokenProgram: program }))[0];
    const create = (a, m, kind = 1, prog = program) => ix(ATA_PROGRAM, [[agent, WS], [a, W], [agent, R], [m, R], [SYS, R], [prog, R]], [kind]);
    const route = ix(S.JUPITER_PROGRAM, [[TOKEN_PROGRAM_ADDRESS, R], [agent, WS], [usdcAta, W], [tokenAta, W], [S.JUPITER_PROGRAM, R], [mint, R], [S.JUPITER_PROGRAM, R], [EVENT_AUTHORITY, R], [S.JUPITER_PROGRAM, R]], routeData({ inAmount: 5_000_000n, quotedOut: 900n, slippageBps: 50 }));
    const opts = { agent, mintIn: USDC_MINT, mintOut: mint, amountIn: 5_000_000n, feeAccount: null, feeBps: 0, slippageBps: 50, minOut: 895n, tail: { mint, program } };
    const budget = ix("ComputeBudget111111111111111111111111111111", [], [2, 160, 134, 1, 0]);
    const good = await S.inspectSolanaSwapTransaction(await synthetic(agent, [budget, create(tokenAta, mint), route]), opts, {});
    assert.deepEqual(good.refusals, [], program);
    assert.deepEqual(good.facts.created_atas, [tokenAta]);
    const check = async (instrs, o = opts, re = /ata_instruction/) => {
      const r = await S.inspectSolanaSwapTransaction(await synthetic(agent, instrs), o, {});
      assert.ok(r.refusals.some((x) => re.test(x.rule)), `${program} ${r.refusals.map((x) => x.rule)}`);
    };
    await check([budget, create(tokenAta, mint), create(tokenAta, mint), route]); // twice
    await check([budget, create(tokenAta, mint, 0), route]); // not idempotent
    await check([budget, create(tokenAta, mint, 1, program === TOKEN_PROGRAM_ADDRESS ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ADDRESS), route]); // the other token program
    await check([budget, create(usdcAta, mint), route]); // the USDC account's address for the token
    const other = await randomAddress();
    await check([budget, create((await findAssociatedTokenPda({ owner: address(agent), mint: address(other), tokenProgram: program }))[0], other), route]); // some other mint
    // A token swap without `tail` given: the same creation is refused (the kit does not guess which mint is the token).
    await check([budget, create(tokenAta, mint), route], { ...opts, tail: undefined });
    // A shared route is refused when there is no token, and a plain route with a token passes.
    assert.ok((await S.inspectSolanaSwapTransaction(await synthetic(agent, [budget, route]), opts, {})).refusals.length === 0);
  }
  // `tail` that is neither side is bad input.
  await assert.rejects(S.inspectSolanaSwapTransaction(await synthetic(agent, []), { agent, mintIn: USDC_MINT, mintOut: WSOL, amountIn: 1n, feeAccount: null, feeBps: 0, slippageBps: 50, minOut: 1n, tail: { mint: BONK, program: TOKEN_PROGRAM_ADDRESS } }, {}), /tail is neither side/);
});

test("accounts: after the swap the agent's account for the token is held to the same rules as its USDC account (owner, delegate, close authority, program)", async () => {
  const stranger = await randomAddress();
  for (const [fx, program] of [[BONK_BUY, TOKEN_PROGRAM_ADDRESS], [BONK_SELL, TOKEN_PROGRAM_ADDRESS], [SI_BUY, TOKEN_2022_PROGRAM], [SI_SELL, TOKEN_2022_PROGRAM]]) {
    const tag = fx.request.to.slice(0, 4) + "/" + fx.request.from.slice(0, 4);
    const plan = await planFrom(fx);
    const mint = plan.token.mint;
    const edit = (fn) => refusalsOf(plan, fx, { editSim: (v) => { v.accounts[SIM_TAIL] = fn(v.accounts[SIM_TAIL]); } });
    const mk = (o) => (entry) => ({ ...tokenAccountEntry({ mint, owner: fx.wallet, program, ...o }), lamports: entry.lamports });
    // As recorded it passes (and the account really is there).
    assert.ok(S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx)), tag);
    const recorded = JSON.parse(JSON.stringify(fx.rpc.find((c) => c.method === "simulateTransaction").result.value.accounts[SIM_TAIL]));
    assert.equal(recorded.owner, program, `${tag}: the account is owned by the mint's program`);
    for (const [name, o, re] of [
      ["a delegate", { delegate: stranger }, /would have a delegate/],
      ["a different owner", { owner: stranger }, /would be owned by/],
      ["a close authority", { closeAuthority: stranger }, /would have a close authority/],
      ["a different mint", { mint: USDC_MINT }, /would hold a different token/],
    ]) {
      const got = await edit(mk(o));
      assert.deepEqual([...new Set(got.map((r) => r.rule))], ["solana_swap.account_authority_changed"], `${tag}: ${name}`);
      assert.match(got[0].message, re);
      assert.match(got[0].message, /the agent's .* account/);
    }
    // The wrong token program for the mint: refused as not a plain account of it.
    const otherProgram = program === TOKEN_PROGRAM_ADDRESS ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ADDRESS;
    const got = await edit((entry) => ({ ...tokenAccountEntry({ mint, owner: fx.wallet, program: otherProgram }), lamports: entry.lamports }));
    assert.deepEqual(got.map((r) => r.rule), ["solana_swap.account_authority_changed"]);
    assert.match(got[0].message, new RegExp(`would not be a plain ${program === TOKEN_PROGRAM_ADDRESS ? "Token" : "Token-2022"} account`));
  }
  // A Token-2022 account with extensions (account-type byte 2 after the 165 bytes) is plain; a wrong type byte or an odd size is not.
  const plan = await planFrom(SI_BUY);
  const withExt = (type, size = 182) => (entry) => {
    const e = tokenAccountEntry({ mint: SI, owner: SI_BUY.wallet, program: TOKEN_2022_PROGRAM });
    const raw = Buffer.concat([Buffer.from(e.data[0], "base64"), Buffer.alloc(size - 165)]);
    raw[165] = type;
    return { ...e, data: [raw.toString("base64"), "base64"], lamports: entry.lamports, space: String(size) };
  };
  assert.equal((await refusalsOfOk(plan, SI_BUY, withExt(2))).ok, true);
  assert.equal((await refusedByEdit(plan, SI_BUY, withExt(1))).length, 1);
  const tiny = (entry) => { const e = withExt(2)(entry); const raw = Buffer.from(e.data[0], "base64").subarray(0, 100); return { ...e, data: [raw.toString("base64"), "base64"] }; };
  assert.equal((await refusedByEdit(plan, SI_BUY, tiny)).length, 1);
});
async function refusalsOfOk(plan, fx, fn) {
  return S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx, { editSim: (v) => { v.accounts[SIM_TAIL] = fn(v.accounts[SIM_TAIL]); } }));
}
async function refusedByEdit(plan, fx, fn) {
  try {
    await refusalsOfOk(plan, fx, fn);
  } catch (err) {
    assert.ok(err instanceof Refused, err.stack);
    return err.refusals;
  }
  assert.fail("expected a refusal");
}

test("balanceDeltas: the token being swapped is counted on its own (buy and sell), its new account's rent separately, and it is not an 'other' asset", () => {
  const agent = "Agent1111111111111111111111111111111111111";
  const T = "TokenMint1111111111111111111111111111111111";
  const tok = (accountIndex, mint, amount, owner = agent) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });
  // Buy: USDC out, the token in to a new account (keys: 0 agent, 1 USDC account, 2 token account created here).
  const buy = S.balanceDeltas({
    keys: [agent, "u", "t"],
    preBalances: [10_000_000_000, 2_039_280, 0],
    postBalances: [10_000_000_000 - 5_000 - 2_074_080, 2_039_280, 2_074_080],
    preTokenBalances: [tok(1, USDC_MINT, 5_000_000)],
    postTokenBalances: [tok(1, USDC_MINT, 0), tok(2, T, 123_456)],
  }, agent, T);
  assert.deepEqual([buy.usdc.delta, buy.tail.delta, buy.tail.pre, buy.tail.post], [-5_000_000n, 123_456n, 0n, 123_456n]);
  assert.equal(buy.created_tail_rent, 2_074_080n);
  assert.equal(buy.created_usdc_rent, 0n);
  assert.deepEqual(buy.others, [], "the token is not an other asset");
  assert.equal(buy.sol.delta, -5_000n - 2_074_080n, "the fee and the new account's rent");
  // Sell: the token out (existing account), USDC in.
  const sell = S.balanceDeltas({
    keys: [agent, "u", "t"],
    preBalances: [10_000_000_000, 2_039_280, 2_039_280],
    postBalances: [10_000_000_000 - 5_000, 2_039_280, 2_039_280],
    preTokenBalances: [tok(1, USDC_MINT, 0), tok(2, T, 900)],
    postTokenBalances: [tok(1, USDC_MINT, 77), tok(2, T, 400)],
  }, agent, T);
  assert.deepEqual([sell.tail.delta, sell.usdc.delta, sell.created_tail_rent], [-500n, 77n, 0n]);
  // Without naming the token, it is an 'other' asset like any (the form every existing caller uses).
  const plain = S.balanceDeltas({ keys: [agent, "u", "t"], preBalances: [1, 1, 1], postBalances: [1, 1, 1], preTokenBalances: [tok(2, T, 900)], postTokenBalances: [tok(2, T, 400)] }, agent);
  assert.equal(plain.tail, null);
  assert.deepEqual(plain.others, [{ mint: T, delta: -500n }]);
  // Other agents' accounts of the token do not count as the agent's.
  const theirs = S.balanceDeltas({ keys: [agent, "x"], preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [tok(1, T, 10, "Stranger")], postTokenBalances: [tok(1, T, 0, "Stranger")] }, agent, T);
  assert.equal(theirs.tail.delta, 0n);
});

// ----------------------------------------------------------------- verify: the simulation, with a token

test("verify refuses on the simulation (token): too little of the token comes back, too much of it leaves, SOL leaves beyond fees and rent", async () => {
  const keysOf = (plan, v) => [...compiledOf(plan.swap_transaction).staticAccounts, ...v.loadedAddresses.writable, ...v.loadedAddresses.readonly];
  const tailRows = (plan, fx, v) => {
    const i = keysOf(plan, v).indexOf(PLAN_TAIL_ATA.get(fx));
    assert.ok(i > 0, "the agent's token account is in the transaction");
    return { post: v.postTokenBalances.find((b) => b.accountIndex === i), pre: v.preTokenBalances.find((b) => b.accountIndex === i) };
  };
  // Buy: the token's balance rises by less than the minimum.
  const buy = await planFrom(BONK_BUY);
  const less = await refusedBy(buy, BONK_BUY, { editSim: (v) => { const { post, pre } = tailRows(buy, BONK_BUY, v); post.uiTokenAmount.amount = (BigInt(pre.uiTokenAmount.amount) + 1n).toString(); } });
  assert.deepEqual(less, ["solana_swap.sim_output_inflow"]);
  // Sell: more of the token leaves than was swapped.
  const sell = await planFrom(BONK_SELL);
  const more = await refusedBy(sell, BONK_SELL, { editSim: (v) => { const { post } = tailRows(sell, BONK_SELL, v); post.uiTokenAmount.amount = (BigInt(post.uiTokenAmount.amount) - 1n).toString(); } });
  assert.deepEqual(more, ["solana_swap.sim_input_outflow"]);
  // A buy that costs SOL beyond the network fee and the rent of an account.
  const drained = await refusedBy(buy, BONK_BUY, { editSim: shiftAgentLamports(-3_000_000_000) });
  assert.deepEqual(drained, ["solana_swap.sim_input_outflow"]);
  // A sell for SOL that also drained USDC from another account of the agent's.
  const sellSol = await planFrom(BONK_SOL);
  const usdcLoss = await refusedBy(sellSol, BONK_SOL, { editSim: (v) => {
    const keys = keysOf(sellSol, v);
    const i = keys.indexOf(sellSol.agent === WALLET ? "FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq" : "x");
    assert.ok(i > 0);
    const post = v.postTokenBalances.find((b) => b.accountIndex === i);
    post.uiTokenAmount.amount = (BigInt(post.uiTokenAmount.amount) - 1_000_000n).toString();
  } });
  assert.ok(usdcLoss.length >= 1);
  // The token's tokens are only that: another mint draining is still caught as an 'other' asset.
  const otherMint = await randomAddress();
  const drain = await refusedBy(buy, BONK_BUY, { editSim: (v) => {
    v.preTokenBalances.push({ accountIndex: 1, mint: otherMint, owner: WALLET, uiTokenAmount: { amount: "50" } });
    v.postTokenBalances.push({ accountIndex: 1, mint: otherMint, owner: WALLET, uiTokenAmount: { amount: "0" } });
  } });
  assert.deepEqual(drain, ["solana_swap.sim_other_asset"]);
});

test("verify refuses on the simulation (fee): an output fee above the share of the payout, in the wrong account, or missing; an input fee above its share", async () => {
  const keysOf = (plan, v) => [...compiledOf(plan.swap_transaction).staticAccounts, ...v.loadedAddresses.writable, ...v.loadedAddresses.readonly];
  for (const fx of [BONK_SELL, BONK_SOL, SI_SELL, GOAT_SELL, BONK_BUY, SOL_BONK]) {
    const plan = await planFrom(fx);
    const bump = (n) => (v) => {
      const i = keysOf(plan, v).indexOf(plan.fee.account);
      const post = v.postTokenBalances.find((b) => b.accountIndex === i);
      post.uiTokenAmount.amount = (BigInt(post.uiTokenAmount.amount) + BigInt(n)).toString();
    };
    const tag = `${fx.request.from.slice(0, 4)} -> ${fx.request.to.slice(0, 4)}`;
    // Honest: passes. A fee that is far more than 15 bps of the payout: refused as a fee.
    const ok = await S.verifySolanaSwapPlan(plan, intentOf(fx), verifyDeps(fx));
    const observed = BigInt(ok.simulated.fee_observed_units);
    const huge = plan.fee.leg === "output" ? 10n * BigInt(ok.simulated.output_inflow) / 100n : 10n * BigInt(plan.amount_in) / 100n; // 10%
    assert.deepEqual(await refusedBy(plan, fx, { editSim: bump(huge) }), ["solana_swap.fee_account"], tag);
    assert.ok(observed > 0n);
  }
  // The fee account absent from the simulation's token balances (not an initialised account of that mint).
  const plan = await planFrom(BONK_SELL);
  const missing = await refusedBy(plan, BONK_SELL, { editSim: (v) => {
    const keys = keysOf(plan, v);
    const i = keys.indexOf(plan.fee.account);
    v.preTokenBalances = v.preTokenBalances.filter((b) => b.accountIndex !== i);
  } });
  assert.deepEqual(missing, ["solana_swap.fee_account"]);
});

test("verify refuses on the simulation (rent): a new account for the token that holds more than the rent-exempt minimum for its size", async () => {
  const plan = await planFrom(SI_BUY);
  const keys = (v) => [...compiledOf(plan.swap_transaction).staticAccounts, ...v.loadedAddresses.writable, ...v.loadedAddresses.readonly];
  const ok = await S.verifySolanaSwapPlan(plan, intentOf(SI_BUY), verifyDeps(SI_BUY));
  const rent = BigInt(ok.simulated.created_token_rent_lamports);
  assert.ok(rent > 0n);
  const inflate = (extra) => (v) => {
    const i = keys(v).indexOf(PLAN_TAIL_ATA.get(SI_BUY));
    v.postBalances[i] = (BigInt(v.postBalances[i]) + BigInt(extra)).toString();
    v.postBalances[0] = (BigInt(v.postBalances[0]) - BigInt(extra)).toString();
    v.accounts[0].lamports = v.postBalances[0];
    v.accounts[SIM_TAIL].lamports = v.postBalances[i];
  };
  assert.deepEqual(await refusedBy(plan, SI_BUY, { editSim: inflate(2_000_000) }), ["solana_swap.sim_input_outflow"]);
  // Within the minimum (the rent rate was cut in 2026, so the real rent is below the old rate this cap uses) it passes.
  assert.equal((await S.verifySolanaSwapPlan(plan, intentOf(SI_BUY), verifyDeps(SI_BUY, { editSim: inflate(100_000) }))).ok, true);
});

// ----------------------------------------------------------------- execute, with a token

test("execute: a swap for a token and one of a token are signed under the limits and record the real amount out", async () => {
  policyAllow("50", "100000"); // the ledger already holds the spends of the tests above
  for (const [fx, mintOut] of [[BONK_BUY, BONK], [BONK_SELL, USDC_MINT]]) {
    const before = entries().length;
    const { plan, rig, deps } = await setup(fx, { extraMints: [BONK] });
    const out = await S.executeSolanaSwap(plan, { ...deps, usdNotional: 5 });
    assert.equal(out.asset_out, plan.to);
    assert.equal(out.amount_in, plan.amount_in);
    assert.equal(out.fee.account, "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo", "the fee is paid in USDC");
    assert.equal(out.amount_out, out.verification.simulated.output_inflow, `${mintOut === BONK ? "the token as it landed" : "the USDC"} equals what the verified simulation delivered`);
    assert.ok(BigInt(out.amount_out) >= BigInt(plan.quote.min_out));
    assert.equal(rig.sent.length, 1);
    assert.deepEqual(entries().slice(before).map((r) => r.status), ["submitted", "signed", "confirmed"]);
  }
});

// ----------------------------------------------------------------- dry run, with a token

test("dry run: a token swap plans and verifies, reserves nothing, and carries the token and the price impact for the caller", async () => {
  policyAllow();
  const before = entries().length;
  const { fetch } = fakeFetch(SI_BUY);
  const rig = fakeRpc(SI_BUY);
  const out = await S.dryRunSolanaSwap(SI_BUY.request, { agent: SI_BUY.wallet, satoFeeBps: 15, fetch, rpc: rig.rpc, minGapMs: 0 });
  assert.equal(out.verification.ok, true);
  assert.equal(out.plan.token.mint, SI);
  assert.equal(out.plan.token.transfer_fee.bps, 100);
  assert.equal(out.plan.quote.price_impact_bps, Math.round(Number(JSON.parse(SI_BUY.http[0].text).priceImpactPct) * 10000));
  assert.equal("swap_transaction" in out.plan, false);
  assert.equal(rig.sent.length, 0);
  assert.equal(entries().length, before);
});

test("every long-tail refusal message is plain words for the owner (no safe / secure / trusted / guaranteed)", async () => {
  const stranger = await randomAddress();
  const mint = await randomAddress();
  const all = [];
  const plan = await planFrom(BONK_BUY);
  for (const slot of [1, 2, 3, 4, 5, 6, 9, 10]) all.push(...(await refusalsOf(withAccount(plan, slot, stranger), BONK_BUY)).map((r) => r.message));
  for (const name of Object.keys(S.TOKEN_2022_EXTENSION_POLICY.refuse)) {
    const t = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, extensions: [ext(name)] })) });
    all.push(...t.refusals.map((r) => r.message), ...t.notes);
  }
  const freeze = await S.resolveSolanaToken(mint, { rpc: rpcFor(mint, mintEntry({ program: TOKEN_2022_PROGRAM, freezeAuthority: stranger, mintAuthority: stranger, extensions: [ext("TransferFeeConfig")] })) });
  all.push(...freeze.notes);
  assert.ok(all.length >= 20);
  for (const m of all) assert.doesNotMatch(m, /\b(safe|secure|trusted|guaranteed?|guarantees)\b/i, m);
});

// ----------------------------------------------------------------- live, read-only (opt-in)

const live = process.env.SATO_AGENT_LIVE_READ === "1";
const liveDeps = () => ({ agent: WALLET, satoFeeBps: 15, userAgent: "SatoHub-swap-dev/1.0", rpc: createSolanaRpc(process.env.SATO_AGENT_SOLANA_RPC || "https://api.mainnet-beta.solana.com", { headers: { "user-agent": "SatoHub-swap-dev/1.0" } }) });

test("LIVE read: the recorded transactions still simulate on mainnet and the delta logic reads the same", { skip: !live }, async () => {
  const rpc = liveDeps().rpc;
  for (const [fx, wantOutflowAsset] of [[USDC_SOL, "usdc"], [SOL_USDC, "sol"]]) {
    const plan = await planFrom(fx);
    // Replays the recorded transaction against current state (blockhash replaced, signatures not checked).
    let v;
    try {
      v = await S.verifySolanaSwapPlan(plan, intentOf(fx), { rpc, minGapMs: 0 });
    } catch (err) {
      // A recorded quote is hours old: once the market has moved by more than its slippage the
      // program itself refuses it (SlippageToleranceExceeded, 6001). That is the floor working,
      // not a fault; every static check and the simulation setup still ran. The fresh-build
      // tests below cover the whole path against current prices.
      if (err instanceof Refused && rules(err).join() === "solana_swap.sim_failed" && /"Custom":"6001"/.test(err.message)) {
        console.log(`# ${fx.request.from}->${fx.request.to}: the recorded quote is stale (Jupiter's slippage check, 6001); skipped the numbers`);
        continue;
      }
      throw err;
    }
    assert.equal(v.ok, true, `${fx.request.from}->${fx.request.to}`);
    if (wantOutflowAsset === "usdc") assert.equal(v.simulated.input_outflow, "25000000");
    assert.ok(BigInt(v.simulated.output_inflow) >= BigInt(plan.quote.min_out));
    await new Promise((res) => setTimeout(res, 600)); // be kind to the public RPC
  }
});

test("LIVE read: a fresh quote + build + verification, both directions (Jupiter keyless: ~1 request per 2 s)", { skip: !live, timeout: 120_000 }, async () => {
  for (const params of [{ from: "USDC", to: "SOL", amount: "10" }, { from: "SOL", to: "USDC", amount: "0.1" }]) {
    const out = await S.dryRunSolanaSwap({ ...params, slippageBps: 50 }, liveDeps());
    assert.equal(out.verification.ok, true, JSON.stringify(out.verification));
    assert.ok(out.verification.priority_lamports <= S.PRIORITY_MAX_LAMPORTS);
    assert.ok(out.verification.simulated.fee_observed_units !== null);
    assert.equal(out.verification.jupiter.instruction, "route", "api.jup.ag still builds the plain route instruction");
    assert.equal(out.verification.jupiter.platform_fee_bps, 15);
    assert.equal(out.verification.jupiter.slippage_bps, 50);
    assert.equal(out.verification.jupiter.enforced_min_out, out.plan.quote.min_out);
  }
});

test("LIVE read: the reviewer's tamper (quoted_out=1, slippage_bps=10000) on a fresh live build is refused, though the simulation alone would let it through", { skip: !live, timeout: 180_000 }, async () => {
  const deps = liveDeps();
  for (const params of [{ from: "USDC", to: "SOL", amount: "10" }, { from: "SOL", to: "USDC", amount: "0.1" }]) {
    const plan = await S.planSolanaSwap({ ...params, slippageBps: 50 }, deps);
    const intent = { agent: WALLET, from: plan.from, to: plan.to, amount_in: plan.amount_in };
    assert.equal((await S.verifySolanaSwapPlan(plan, intent, deps)).ok, true, "the honest build passes");

    const tampered = withArgs(plan, { quotedOut: 1n, slippageBps: 10_000 });
    const trailing = withTx(plan, mutate(plan.swap_transaction, (c) => {
      const ix = jupiterIxs(c)[0];
      const honestTail = Buffer.from(ix.data).subarray(ix.data.length - ARGS);
      writeArgs(ix, { quotedOut: 1n, slippageBps: 10_000 });
      ix.data = new Uint8Array(Buffer.concat([Buffer.from(ix.data), honestTail]));
    }));
    // The attack is real: mainnet runs both without error (the pool delivers more than the 1-lamport floor).
    for (const tx of [tampered, trailing]) {
      const sim = (await deps.rpc.simulateTransaction(tx.swap_transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send()).value;
      assert.equal(sim.err, null, `the simulation alone passes the tampered ${params.from}->${params.to} build`);
      await new Promise((res) => setTimeout(res, 800));
    }
    // ...and the kit refuses it, by reading Jupiter's instruction.
    await assert.rejects(S.verifySolanaSwapPlan(tampered, intent, deps), (e) => e instanceof Refused && rules(e).includes("solana_swap.min_out_not_enforced"), "quoted_out=1, slippage 10000");
    await assert.rejects(S.verifySolanaSwapPlan(trailing, intent, deps), (e) => e instanceof Refused && rules(e).includes("solana_swap.jupiter_instruction_unrecognized"), "honest tail appended after tampered arguments");
    await assert.rejects(S.verifySolanaSwapPlan(withArgs(plan, { quotedOut: 1n }), intent, deps), (e) => e instanceof Refused && rules(e).includes("solana_swap.min_out_not_enforced"));
  }
});

test("LIVE read: Jupiter's program interface is still the one this kit embeds (a new venue means: re-run test/fixtures/swap-solana/idl.mjs)", { skip: !live }, async () => {
  const { idl } = await fetchJupiterIdl(liveDeps().rpc);
  const { step, enums } = compile(idl.types);
  assert.deepEqual(JSON.parse(JSON.stringify({ step, enums })), JSON.parse(JSON.stringify(S.ROUTE_LAYOUT)), "the Swap / CandidateSwap enums changed on chain");
  const route = idl.instructions.find((i) => i.name === "route");
  assert.equal(Buffer.from(route.discriminator).toString("hex"), S.JUPITER_ROUTE_DISCRIMINATOR);
  assert.deepEqual(route.args.map((a) => a.name), ["route_plan", "in_amount", "quoted_out_amount", "slippage_bps", "platform_fee_bps"]);
  for (const [hex, name] of Object.entries(S.JUPITER_INSTRUCTION_NAMES)) {
    assert.equal(Buffer.from(idl.instructions.find((i) => i.name === name).discriminator).toString("hex"), hex, name);
  }
});

test("LIVE read: builds at several sizes both ways, fee on and off, are all the plain route instruction and all verify", { skip: !live, timeout: 300_000 }, async () => {
  const deps = liveDeps();
  const seen = new Set();
  for (const [params, fee] of [
    [{ from: "USDC", to: "SOL", amount: "1" }, 15],
    [{ from: "USDC", to: "SOL", amount: "100" }, 15],
    [{ from: "USDC", to: "SOL", amount: "500" }, 15],
    [{ from: "USDC", to: "SOL", amount: "10" }, 0],
    [{ from: "SOL", to: "USDC", amount: "0.01" }, 15],
    [{ from: "SOL", to: "USDC", amount: "3" }, 15],
  ]) {
    const out = await S.dryRunSolanaSwap({ ...params, slippageBps: 50 }, { ...deps, satoFeeBps: fee });
    assert.equal(out.verification.jupiter.instruction, "route", JSON.stringify(params));
    assert.equal(out.verification.jupiter.platform_fee_bps, fee);
    seen.add(out.verification.jupiter.instruction);
  }
  assert.deepEqual([...seen], ["route"]);
});

// -- a long-tail token, live (the same Jupiter keyless pace: one request per ~2 s) --

const pause = (ms) => new Promise((res) => setTimeout(res, ms));
/** Retry a read-only RPC call that the public node rate-limits. */
async function patient(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !/429|Too Many/i.test(`${err.message} ${err.context?.statusCode}`)) throw err;
      await pause(3000 * (i + 1));
    }
  }
}

test("LIVE read: a fresh keypair's BONK buy and sell builds (USDC and SOL sides) inspect cleanly: the creations are the agent's own, the route is read to its end", { skip: !live, timeout: 300_000 }, async () => {
  const deps = liveDeps();
  const fresh = (await generateKeyPairSigner()).address;
  // Jupiter simulates a build before it answers and flags a wallet with no SOL; the transaction is still there to inspect. Drop the flag
  // (the kit itself refuses a build that carries it, which is its own test above).
  const stripped = async (url, init) => {
    const res = await fetch(url, init);
    let text = await res.text();
    if (String(url).endsWith("/swap")) {
      const j = JSON.parse(text);
      delete j.simulationError;
      text = JSON.stringify(j);
    }
    return new Response(text, { status: res.status });
  };
  const bonkAta = (await findAssociatedTokenPda({ owner: address(fresh), mint: address(BONK), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  let sawBonkCreation = false;
  for (const params of [{ from: "USDC", to: BONK, amount: "5" }, { from: "SOL", to: BONK, amount: "0.05" }, { from: BONK, to: "USDC", amount: "100000" }, { from: BONK, to: "SOL", amount: "100000" }]) {
    const plan = await patient(() => S.planSolanaSwap({ ...params, slippageBps: 100 }, { ...deps, agent: fresh, fetch: stripped }));
    const tables = [...new Set((compiledOf(plan.swap_transaction).addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
    const alts = await patient(() => fetchAddressesForLookupTables(tables, deps.rpc));
    const tail = await patient(() => S.resolveSolanaToken(BONK, deps));
    const r = await S.inspectSolanaSwapTransaction(plan.swap_transaction, { agent: fresh, mintIn: plan.mint_in, mintOut: plan.mint_out, amountIn: BigInt(plan.amount_in), feeAccount: plan.fee.account, feeBps: 15, slippageBps: 100, minOut: BigInt(plan.quote.min_out), tail: { mint: tail.mint, program: tail.program } }, alts);
    const tag = `${params.from.slice(0, 4)} -> ${params.to.slice(0, 4)}`;
    assert.deepEqual(r.refusals, [], tag);
    assert.equal(r.facts.route.instruction, "shared_accounts_route", tag);
    assert.equal(plan.fee.mint === USDC_MINT || plan.fee.mint === WSOL, true, `${tag}: the fee is in USDC or SOL`);
    assert.equal(plan.fee.leg, params.from === BONK ? "output" : "input", tag);
    if (params.to === BONK) {
      assert.deepEqual(r.facts.created_atas.filter((a) => a === bonkAta), [bonkAta], `${tag}: a buy creates the agent's BONK account, once`);
      sawBonkCreation = true;
    }
    await pause(1500);
  }
  assert.ok(sawBonkCreation);
});

test("LIVE read: the funded wallet's BONK buy and sell (USDC and SOL) plan, verify and simulate against current prices; the fee lands in USDC or wrapped SOL", { skip: !live, timeout: 300_000 }, async () => {
  const deps = liveDeps();
  for (const [params, feeMint, leg] of [
    [{ from: "USDC", to: BONK, amount: "2" }, USDC_MINT, "input"],
    [{ from: BONK, to: "USDC", amount: "100000" }, USDC_MINT, "output"],
    [{ from: "SOL", to: BONK, amount: "0.02" }, WSOL, "input"],
    [{ from: BONK, to: "SOL", amount: "100000" }, WSOL, "output"],
  ]) {
    const out = await patient(() => S.dryRunSolanaSwap({ ...params, slippageBps: 100 }, deps));
    const tag = `${params.from.slice(0, 4)} -> ${params.to.slice(0, 4)}`;
    assert.equal(out.verification.ok, true, tag);
    assert.equal(out.verification.jupiter.instruction, "shared_accounts_route", tag);
    assert.equal(out.plan.fee.mint, feeMint, tag);
    assert.equal(out.verification.simulated.fee_leg, leg, tag);
    assert.ok(BigInt(out.verification.simulated.fee_observed_units) > 0n, tag);
    assert.ok(BigInt(out.verification.simulated.output_inflow) >= BigInt(out.plan.quote.min_out), tag);
    assert.equal(out.plan.token.mint, BONK);
    await pause(1500);
  }
});

test("LIVE read: mints are read from the chain: BONK is a plain mint; PYUSD, the PUMP token and an xStock are refused for what their extensions allow", { skip: !live, timeout: 120_000 }, async () => {
  const deps = liveDeps();
  const bonk = await patient(() => S.resolveSolanaToken(BONK, deps));
  assert.deepEqual([bonk.program, bonk.decimals, bonk.extensions, bonk.refusals], [TOKEN_PROGRAM_ADDRESS, 5, [], []]);
  await pause(1200);
  const refused = {
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": ["PermanentDelegate", "TransferHook"], // PYUSD
    pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: ["TransferHook"], // PUMP
    XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN: ["PermanentDelegate", "TransferHook"], // an xStock
  };
  for (const [mint, names] of Object.entries(refused)) {
    const t = await patient(() => S.resolveSolanaToken(mint, deps));
    assert.equal(t.program, TOKEN_2022_PROGRAM);
    for (const n of names) assert.ok(t.refusals.some((r) => new RegExp(`\\b${n}\\b`).test(r.message)), `${mint.slice(0, 6)} ${n}`);
    await assert.rejects(S.planSolanaSwap({ from: "USDC", to: mint, amount: "1" }, { ...deps, agent: WALLET, satoFeeBps: 15 }), (e) => e instanceof Refused && rules(e).includes("solana_swap.token_extension_refused"));
    await pause(1200);
  }
  // Not a mint: Sato's USDC fee account is a token account, and a wallet is not a token program's account at all.
  await assert.rejects(patient(() => S.resolveSolanaToken(S.SATO_FEE_ACCOUNTS[USDC_MINT], deps)), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_not_a_mint" && /token account/.test(e.message));
  await pause(1200);
  await assert.rejects(patient(() => S.resolveSolanaToken(WALLET, deps)), (e) => e instanceof Refused && rules(e)[0] === "solana_swap.token_not_a_mint");
});

test("LIVE read: Jupiter's shared_accounts_route is still the form this kit decodes (discriminator, arguments, account order)", { skip: !live }, async () => {
  const { idl } = await patient(() => fetchJupiterIdl(liveDeps().rpc));
  const shared = idl.instructions.find((i) => i.name === "shared_accounts_route");
  assert.equal(Buffer.from(shared.discriminator).toString("hex"), S.JUPITER_SHARED_ROUTE_DISCRIMINATOR);
  assert.deepEqual(shared.args.map((a) => a.name), ["id", "route_plan", "in_amount", "quoted_out_amount", "slippage_bps", "platform_fee_bps"]);
  assert.deepEqual(shared.accounts.map((a) => a.name), JUP_IDL.shared_accounts_route.accounts.map((a) => a.name), "the account order moved: re-run test/fixtures/swap-solana/idl.mjs --write and check ROUTE_ACCOUNTS");
  assert.deepEqual(shared.accounts.map((a) => !!a.optional), JUP_IDL.shared_accounts_route.accounts.map((a) => !!a.optional));
});
