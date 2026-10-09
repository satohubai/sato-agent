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
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  address,
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

freshHome();
const { setPolicy } = await import("../src/policy.js");
const { entries, spentLast24h } = await import("../src/ledger.js");
const { Pending, Refused, Rejected } = await import("../src/errors.js");
const { USDC_MINT, TOKEN_2022_PROGRAM } = await import("../src/solana.js");
const S = await import("../src/swap/solana.js");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/swap-solana/${name}.json`, import.meta.url), "utf8"));
const USDC_SOL = fixture("usdc-to-sol");
const SOL_USDC = fixture("sol-to-usdc");
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
    simulateTransaction: (wire, opts) => ({
      send: async () => {
        o.onSimulate?.(wire, opts);
        if (o.simThrows) throw new Error(o.simThrows);
        const res = structuredClone(recorded("simulateTransaction"));
        o.editSim?.(res.value);
        return res;
      },
    }),
    getBlockHeight: () => ({ send: async () => BigInt(o.blockHeight ?? 1) }),
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
  return S.planSolanaSwap(fx.request, { agent: fx.wallet, satoFeeBps: fx.request.satoFeeBps, fetch, minGapMs: 0, now: () => fx.built_at, ...extra });
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
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "https://api.jup.ag/swap/v1/swap");
  assert.equal(calls[1].init.method, "POST");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.userPublicKey, WALLET);
  assert.equal(body.feeAccount, "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo");
  assert.equal(body.wrapAndUnwrapSol, true);
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
  assert.doesNotMatch(plan.disclosure.join("\n"), /\b(safe|secure|trusted)\b/i);
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

test("plan: amounts are strict (no rounding), assets are USDC and SOL only, slippage is bounded", async () => {
  const base = { agent: WALLET, satoFeeBps: 15, fetch: fakeFetch(USDC_SOL).fetch, minGapMs: 0 };
  const bad = (p, re) => assert.rejects(S.planSolanaSwap(p, base), re);
  await bad({ from: "USDC", to: "SOL", amount: "1.0000001" }, /not a USDC amount/);
  await bad({ from: "SOL", to: "USDC", amount: "0.0000000001" }, /not a SOL amount/);
  await bad({ from: "USDC", to: "SOL", amount: "1e3" }, /not a USDC amount/);
  await bad({ from: "USDC", to: "SOL", amount: "0" }, /not a positive USDC amount/);
  await bad({ from: "SOL", to: "USDC", amount: "-1" }, /not a SOL amount/);
  await bad({ from: "USDC", to: "USDC", amount: "1" }, /two different assets/);
  await bad({ from: "USDC", to: "BONK", amount: "1" }, /USDC <-> SOL only/);
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
    ix(S.JUPITER_PROGRAM, [[agent, WS], [wsolAta, W], [usdcAta, W]], [1, 2, 3]),
    ix(TOKEN_PROGRAM_ADDRESS, [[wsolAta, W], [agent, W], [agent, WS]], [9]),
  ];
  const opts = { agent, mintIn: WSOL, amountIn: 100_000_000n, feeAccount: null };
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

async function readdressed(fx, to) {
  // Same recorded swap, but for a throwaway key, so it can really be signed in the test.
  const T = to.address;
  const ata = async (mint) => (await findAssociatedTokenPda({ owner: address(T), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const oldAta = async (mint) => (await findAssociatedTokenPda({ owner: address(fx.wallet), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const map = new Map([[fx.wallet, T], [await oldAta(USDC_MINT), await ata(USDC_MINT)], [await oldAta(WSOL), await ata(WSOL)]]);
  const swapAll = (text) => [...map].reduce((t, [a, b]) => t.split(a).join(b), text);
  const next = JSON.parse(swapAll(JSON.stringify(fx)));
  next.wallet = T;
  const plan = await planFrom(fx);
  const tx = mutate(plan.swap_transaction, (c) => {
    c.staticAccounts = c.staticAccounts.map((a) => map.get(a) ?? a);
  });
  return { fx: next, plan: { ...plan, agent: T, swap_transaction: tx } };
}

async function setup(fxName = USDC_SOL, o = {}) {
  const signer = await generateKeyPairSigner();
  const { fx, plan } = await readdressed(fxName, signer);
  const rig = fakeRpc(fx, { blockHeight: plan.last_valid_block_height - 1000, accountKeys: compiledOf(plan.swap_transaction).staticAccounts, ...o });
  const deps = { rpc: rig.rpc, signer, now: () => plan.built_at + 2_000, sleep: async () => {}, minGapMs: 0, pollMs: 0, ...(o.deps ?? {}) };
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

test("execute: a plan whose blockhash is old is rebuilt, never signed (by age, and by blocks left)", async () => {
  policyAllow();
  const before = entries().length;
  const old = await setup(USDC_SOL, { deps: {} });
  await assert.rejects(S.executeSolanaSwap(old.plan, { ...old.deps, now: () => old.plan.built_at + S.PLAN_MAX_AGE_MS + 1 }), S.PlanStale);
  const late = await setup(USDC_SOL, { blockHeight: 0 });
  late.rig = null;
  const near = await setup();
  near.deps.rpc.getBlockHeight = () => ({ send: async () => BigInt(near.plan.last_valid_block_height - 10) });
  await assert.rejects(S.executeSolanaSwap(near.plan, near.deps), /blocks left; rebuild/);
  assert.equal(entries().length, before, "nothing reserved for a stale plan");
});

test("execute: the clock running out while reserving still stops before signing, and gives the reservation back", async () => {
  policyAllow();
  const before = entries().length;
  const { plan, rig, deps } = await setup();
  let heights = 0;
  deps.rpc.getBlockHeight = () => ({ send: async () => BigInt(++heights === 1 ? plan.last_valid_block_height - 1000 : plan.last_valid_block_height - 5) });
  await assert.rejects(S.executeSolanaSwap(plan, deps), S.PlanStale);
  assert.equal(rig.sent.length, 0);
  const rows = entries().slice(before);
  assert.deepEqual(rows.map((r) => r.status), ["submitted", "failed"]);
  assert.equal(spentLast24h().usd >= 0, true);
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

// ----------------------------------------------------------------- live, read-only (opt-in)

const live = process.env.SATO_AGENT_LIVE_READ === "1";
const liveDeps = () => ({ agent: WALLET, satoFeeBps: 15, userAgent: "SatoHub-swap-dev/1.0", rpc: createSolanaRpc(process.env.SATO_AGENT_SOLANA_RPC || "https://api.mainnet-beta.solana.com", { headers: { "user-agent": "SatoHub-swap-dev/1.0" } }) });

test("LIVE read: the recorded transactions still simulate on mainnet and the delta logic reads the same", { skip: !live }, async () => {
  const rpc = liveDeps().rpc;
  for (const [fx, wantOutflowAsset] of [[USDC_SOL, "usdc"], [SOL_USDC, "sol"]]) {
    const plan = await planFrom(fx);
    // Replays the recorded transaction against current state (blockhash replaced, signatures not checked).
    const v = await S.verifySolanaSwapPlan(plan, intentOf(fx), { rpc, minGapMs: 0 });
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
  }
});
