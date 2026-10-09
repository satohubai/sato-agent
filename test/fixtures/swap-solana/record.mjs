// Re-records the fixtures in this folder from REAL mainnet responses.
//
//   node test/fixtures/swap-solana/record.mjs
//
// Read-only: Jupiter's public quote + build endpoints (they build a transaction
// and write nothing) and the public RPC's getMultipleAccounts / simulateTransaction.
// Nothing is signed, nothing is sent, no key is used. The "agent" is a large,
// funded public wallet that has both USDC and SOL, so the simulation succeeds.
// Jupiter's keyless limit is about one request every 2 s; the planner spaces them.

import { writeFileSync } from "node:fs";
import { createSolanaRpc } from "@solana/kit";
import { planSolanaSwap, verifySolanaSwapPlan } from "../../../src/swap/solana.js";

const WALLET = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const UA = "SatoHub-swap-dev/1.0";
const RPC_URL = process.env.SATO_AGENT_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const here = (f) => new URL(f, import.meta.url);
const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

const CASES = [
  { file: "usdc-to-sol.json", from: "USDC", to: "SOL", amount: "25" },
  { file: "sol-to-usdc.json", from: "SOL", to: "USDC", amount: "0.5" },
];

for (const c of CASES) {
  const http = [];
  const calls = [];
  const recFetch = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    http.push({ url: String(url).replace("https://api.jup.ag/swap/v1", ""), method: init.method, body: init.body ? JSON.parse(init.body) : null, status: res.status, text });
    return new Response(text, { status: res.status });
  };
  const real = createSolanaRpc(RPC_URL, { headers: { "user-agent": UA } });
  const rpc = new Proxy(real, {
    get: (t, k) => (...args) => {
      const req = t[k](...args);
      return {
        send: async () => {
          const result = await req.send();
          const kept = plain(result);
          // Logs and inner instructions are bulk the checks never read.
          if (k === "simulateTransaction") delete kept.value.logs, delete kept.value.innerInstructions;
          calls.push({ method: k, args: plain(args), result: kept });
          return result;
        },
      };
    },
  });
  const deps = { agent: WALLET, satoFeeBps: 15, fetch: recFetch, userAgent: UA, rpc };
  const plan = await planSolanaSwap({ from: c.from, to: c.to, amount: c.amount, slippageBps: 50 }, deps);
  const verification = await verifySolanaSwapPlan(plan, { agent: WALLET, from: c.from, to: c.to, amount: c.amount }, deps);
  writeFileSync(
    here(c.file),
    JSON.stringify({ recorded_at: new Date().toISOString(), wallet: WALLET, request: { from: c.from, to: c.to, amount: c.amount, slippageBps: 50, satoFeeBps: 15 }, built_at: plan.built_at, http, rpc: calls, verification }, null, 1) + "\n",
  );
  console.log(c.file, "ok", plan.disclosure.join(" | "));
  console.log(JSON.stringify(verification.simulated));
}
