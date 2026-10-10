// Re-records the fixtures in this folder from REAL mainnet responses.
//
//   node test/fixtures/swap-solana/record.mjs                 every case
//   node test/fixtures/swap-solana/record.mjs usdc-to-bonk.json   just that case (the others are left as they are)
//
// Read-only: Jupiter's public quote + build endpoints (they build a transaction
// and write nothing) and the public RPC's getAccountInfo / getMultipleAccounts /
// simulateTransaction. Nothing is signed, nothing is sent, no key is used. The "agent"
// is a large, funded public wallet that holds the tokens the case needs (so the
// simulation succeeds); a case marked `inspect` uses a made-up wallet that holds
// nothing and is only decoded and inspected, never simulated (it shows what a build
// for a brand-new agent contains: the account creations).
// Jupiter's keyless limit is about one request every 2 s; the planner spaces them, and
// this script spaces and retries the public RPC (it rate-limits per method).

import { writeFileSync } from "node:fs";
import { createSolanaRpc, decompileTransactionMessage, fetchAddressesForLookupTables, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { SATO_FEE_ACCOUNTS, inspectSolanaSwapTransaction, planSolanaSwap, resolveSolanaToken, verifySolanaSwapPlan } from "../../../src/swap/solana.js";

const WALLET = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
// A wallet that holds SI (a Token-2022 mint with a 1% transfer fee), found from a recent SI transfer.
const SI_HOLDER = process.env.SI_HOLDER || "CWJQsg766KK6BNkDHnsREP148E5Gm5q5NLmGgjxdBibE";
// An address no one has used: a new agent's wallet. Only ever inspected.
const FRESH = "5DcxokBQKrEhpUZfAtRPNJRxcsFLnH432KWZBtDaCs4r"; // the public half of a throwaway keypair whose secret was discarded
const UA = "SatoHub-swap-dev/1.0";
const RPC_URL = process.env.SATO_AGENT_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const here = (f) => new URL(f, import.meta.url);
const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // classic SPL, 5 decimals
export const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"; // classic SPL; USDC -> SOL -> WIF (two hops)
export const GOAT = "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump"; // classic SPL; three hops
export const SI = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP"; // Token-2022, TransferFeeConfig 1%

const CASES = [
  { file: "usdc-to-sol.json", from: "USDC", to: "SOL", amount: "25", fee: 15 },
  { file: "sol-to-usdc.json", from: "SOL", to: "USDC", amount: "0.5", fee: 15 },
  // No Sato fee: Jupiter's route instruction then names no fee account (its program id stands in).
  { file: "usdc-to-sol-nofee.json", from: "USDC", to: "SOL", amount: "10", fee: 0 },
  // A long-tail token. The fee is in USDC or SOL whichever way the swap goes (input when buying, output when selling).
  { file: "usdc-to-bonk.json", from: "USDC", to: BONK, amount: "5", fee: 15 },
  { file: "bonk-to-usdc.json", from: BONK, to: "USDC", amount: "500000", fee: 15 },
  { file: "sol-to-bonk.json", from: "SOL", to: BONK, amount: "0.03", fee: 15 },
  { file: "bonk-to-sol.json", from: BONK, to: "SOL", amount: "500000", fee: 15 },
  // Multi-hop: USDC -> SOL -> WIF through Jupiter's shared accounts, three hops for GOAT.
  { file: "usdc-to-wif-multihop.json", from: "USDC", to: WIF, amount: "5", fee: 15 },
  { file: "goat-to-usdc-multihop.json", from: GOAT, to: "USDC", amount: "1", fee: 15 },
  // Token-2022 with a transfer fee.
  { file: "usdc-to-si-token2022.json", from: "USDC", to: SI, amount: "5", fee: 15, slippageBps: 150 },
  { file: "si-to-usdc-token2022.json", from: SI, to: "USDC", amount: "100", fee: 15, slippageBps: 150, wallet: SI_HOLDER },
  // A brand-new agent: the build creates its account for the token. Decoded and inspected only.
  { file: "usdc-to-bonk-fresh.json", from: "USDC", to: BONK, amount: "5", fee: 15, wallet: FRESH, inspect: true },
  { file: "bonk-to-sol-fresh.json", from: BONK, to: "SOL", amount: "500000", fee: 15, wallet: FRESH, inspect: true },
];

const only = process.argv.slice(2);
for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.file))) {
  if (only.length === 0 && ["usdc-to-sol.json", "sol-to-usdc.json", "usdc-to-sol-nofee.json"].includes(c.file)) continue; // recorded earlier; name one to re-record it
  const wallet = c.wallet ?? WALLET;
  const http = [];
  const calls = [];
  const recFetch = async (url, init) => {
    const res = await fetch(url, init);
    let text = await res.text();
    // Jupiter simulates a build before returning it and flags a wallet with no SOL for the fee ("Attempt to debit an
    // account ..."). A made-up wallet always gets that; the transaction is still there to inspect, so the flag is dropped
    // (the kit itself refuses a build that carries it).
    if (c.inspect && String(url).endsWith("/swap")) {
      const j = JSON.parse(text);
      if (j.simulationError) text = JSON.stringify({ ...j, simulationError: undefined, note_simulation_error_dropped: JSON.stringify(j.simulationError) });
    }
    http.push({ url: String(url).replace("https://api.jup.ag/swap/v1", ""), method: init.method, body: init.body ? JSON.parse(init.body) : null, status: res.status, text });
    return new Response(text, { status: res.status });
  };
  const real = createSolanaRpc(RPC_URL, { headers: { "user-agent": UA } });
  const rpc = new Proxy(real, {
    get: (t, k) => (...args) => {
      const req = t[k](...args);
      return {
        send: async () => {
          let result;
          for (let attempt = 0; ; attempt++) {
            await sleep(1200);
            try {
              result = await req.send();
              break;
            } catch (err) {
              if (attempt >= 5 || !/429|Too Many/i.test(`${err.message} ${err.context?.statusCode}`)) throw err;
              await sleep(4000 * (attempt + 1));
            }
          }
          const kept = plain(result);
          // Logs and inner instructions are bulk the checks never read.
          if (k === "simulateTransaction") delete kept.value.logs, delete kept.value.innerInstructions;
          calls.push({ method: k, args: plain(args), result: kept });
          return result;
        },
      };
    },
  });
  const deps = { agent: wallet, satoFeeBps: c.fee, fetch: recFetch, userAgent: UA, rpc };
  const slippageBps = c.slippageBps ?? 50;
  const plan = await planSolanaSwap({ from: c.from, to: c.to, amount: c.amount, slippageBps }, deps);

  let verification;
  if (c.inspect) {
    // Decode and inspect only: the wallet holds nothing, so a simulation would fail.
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(plan.swap_transaction));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const tables = [...new Set((compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
    const alts = tables.length ? await fetchAddressesForLookupTables(tables, rpc) : {};
    const tok = await resolveSolanaToken(plan.token.mint, { rpc });
    const feeMint = plan.fee.mint;
    const { refusals, facts } = await inspectSolanaSwapTransaction(
      plan.swap_transaction,
      { agent: wallet, mintIn: plan.mint_in, mintOut: plan.mint_out, amountIn: BigInt(plan.amount_in), feeAccount: SATO_FEE_ACCOUNTS[feeMint], feeBps: c.fee, slippageBps, minOut: BigInt(plan.quote.min_out), tail: { mint: tok.mint, program: tok.program } },
      alts,
    );
    verification = { inspect_only: true, refusals, created_atas: facts.created_atas, programs: facts.programs, route: facts.route ? { instruction: facts.route.instruction, steps: facts.route.steps } : null };
  } else {
    verification = await verifySolanaSwapPlan(plan, { agent: wallet, from: plan.from, to: plan.to, amount: c.amount }, deps);
  }
  writeFileSync(
    here(c.file),
    JSON.stringify({ recorded_at: new Date().toISOString(), wallet, request: { from: c.from, to: c.to, amount: c.amount, slippageBps, satoFeeBps: c.fee }, built_at: plan.built_at, http, rpc: calls, verification, plan_summary: { fee: plan.fee, quote: plan.quote, token: plan.token } }, null, 1) + "\n",
  );
  console.log(c.file, "ok", plan.disclosure.join(" | "));
  console.log(JSON.stringify(verification.simulated ?? verification));
}
