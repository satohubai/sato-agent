// The owner's check gate (`policy set --check-gate`) applies to swaps too (v0.5.4): the verdict Sato Hub's signed swap answer
// carries (`gate.verdict`) is held to the same rule and wording as a send or a payment, on Solana and on EVM chains.
// `unknown` (or no gate in the answer) refuses only when the owner chose that (`--on-check-unavailable`).

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { WSOL_MINT } = await import("../src/swap/solana.js");
const { USDC_MINT } = await import("../src/solana.js");
const { prepareSwap } = await import("../src/swap/run.js");
const { swapGateRefusals, gateRefusals } = await import("../src/satohub.js");

initWallet();
setPolicy({ chains: "base,solana", perTx: "100", perDay: "300", swapSlippageBps: "100", maxTradesPerDay: "50" });

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
const setGate = (checkGate, onCheckUnavailable) => setPolicy(checkGate === "off" ? { checkGate } : { checkGate, onCheckUnavailable });

// ---- the pure helper
test("swapGateRefusals: the same rules and wording as gateRefusals; unknown or no gate follows on_check_unavailable", () => {
  const ids = (p, g) => swapGateRefusals(p, g).map((r) => r.rule);
  assert.deepEqual(ids({ check_gate: "off" }, { verdict: "no" }), [], "gate off: nothing is refused");
  assert.deepEqual(ids(null, { verdict: "no" }), [], "no policy: nothing is refused");
  assert.deepEqual(ids({ check_gate: "no" }, { verdict: "no" }), ["check_no"]);
  assert.deepEqual(ids({ check_gate: "no" }, "NO"), ["check_no"], "a bare verdict string, any casing");
  assert.deepEqual(ids({ check_gate: "no" }, { verdict: "caution" }), []);
  assert.deepEqual(ids({ check_gate: "caution" }, { verdict: "caution" }), ["check_caution"]);
  assert.deepEqual(ids({ check_gate: "caution" }, { verdict: "go" }), []);
  // unknown / no gate: the owner's choice decides
  for (const g of [{ verdict: "unknown" }, undefined, null, {}, { verdict: 3 }, "maybe"]) {
    assert.deepEqual(ids({ check_gate: "no", on_check_unavailable: "allow" }, g), [], `allow: ${JSON.stringify(g)}`);
    assert.deepEqual(ids({ check_gate: "no", on_check_unavailable: "refuse" }, g), ["check_unavailable"], `refuse: ${JSON.stringify(g)}`);
    assert.deepEqual(ids({ check_gate: "caution" }, g), ["check_unavailable"], "never chosen: fail closed, as everywhere");
  }
  // same wording as the payment paths for a verdict
  const a = swapGateRefusals({ check_gate: "no" }, { verdict: "no" })[0];
  const b = gateRefusals({ check_gate: "no" }, { verdict: "no" })[0];
  assert.equal(a.message, b.message);
  assert.equal(a.limit, b.limit);
  // Sato Hub's own first refusal rule is named when it gives one
  assert.match(swapGateRefusals({ check_gate: "no" }, { verdict: "no", refusals: [{ rule: "G3" }] })[0].message, /under rule G3/);
});

// ---- Solana
const satoSol = (gate) => ({ mode: "recommend", chain: "Solana", token_in: USDC_MINT, token_out: WSOL_MINT, amount_in: "11000000", venue: "jupiter-aggregator", sato_fee_bps: 15, sato_fee_tier: "major", disclosure: "fee", route_id: "rt_s", ...(gate === undefined ? {} : { gate }) });
const solDeps = (gate, planned) => ({
  oraclePrice: solPrice(110),
  callTool: async () => ({ structured: satoSol(gate), isError: false }),
  verifySignature: async () => ({ ok: true }),
  planSolanaSwap: async () => {
    planned.n++;
    throw new Error("stop here: the gate let it through");
  },
});
const solRun = async (gate) => {
  const planned = { n: 0 };
  const r = await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, solDeps(gate, planned)).catch((e) => (/stop here/.test(e.message) ? undefined : Promise.reject(e))));
  return { rules: r, reachedJupiter: planned.n > 0 };
};

test("Solana: check-gate no refuses a `no` verdict before Jupiter is asked; `caution` and `go` go on", async () => {
  setGate("no", "refuse");
  assert.deepEqual(await solRun({ verdict: "no", refusals: [{ rule: "G1" }] }), { rules: ["check_no"], reachedJupiter: false });
  assert.deepEqual((await solRun({ verdict: "caution" })).reachedJupiter, true);
  assert.deepEqual((await solRun({ verdict: "go" })).reachedJupiter, true);
});

test("Solana: check-gate caution refuses `caution` and `no`", async () => {
  setGate("caution", "refuse");
  assert.deepEqual((await solRun({ verdict: "caution" })).rules, ["check_caution"]);
  assert.deepEqual((await solRun({ verdict: "no" })).rules, ["check_no"]);
  assert.equal((await solRun({ verdict: "go" })).reachedJupiter, true);
});

test("Solana: `unknown` or a missing gate refuses only when the owner chose to refuse an unreadable check", async () => {
  setGate("caution", "allow");
  assert.equal((await solRun({ verdict: "unknown" })).reachedJupiter, true);
  assert.equal((await solRun(undefined)).reachedJupiter, true);
  setGate("caution", "refuse");
  assert.deepEqual((await solRun({ verdict: "unknown" })).rules, ["check_unavailable"]);
  assert.deepEqual((await solRun(undefined)).rules, ["check_unavailable"]);
});

test("Solana: with the gate off (the default) the verdict never stops a swap", async () => {
  setGate("off");
  for (const g of [{ verdict: "no" }, { verdict: "caution" }, { verdict: "unknown" }, undefined]) assert.equal((await solRun(g)).reachedJupiter, true, JSON.stringify(g));
});

test("Solana: the gate is read only from an answer whose signature was verified", async () => {
  setGate("no", "refuse");
  const planned = { n: 0 };
  const deps = { ...solDeps({ verdict: "go" }, planned), verifySignature: async () => { throw new Error("bad_signature"); } };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, deps)), ["signature_unverified"]);
});

// ---- EVM (Base)
const basePlan = (gate) => ({
  verified: true,
  venue: "kyberswap",
  route_id: "rt_test",
  receipt_url: null,
  from: "USDC",
  to: "ETH",
  token_in: { symbol: "USDC", decimals: 6, native: false },
  token_out: { symbol: "ETH", decimals: 18, native: true },
  amount_in: 50_000_000n,
  quoted_out: BigInt(Math.round(0.0199 * 1e18)),
  min_out: BigInt(Math.round(0.0199 * 0.99 * 1e18)),
  slippage_bps: 100,
  usd: 50,
  router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  approval: { needed: true, spender: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", amount: 50_000_000n },
  fee: { bps: 15, recipient: "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9", disclosure: "fee sentence" },
  simulation: { source: "eth_simulateV1", in_delta: -50_000_000n, out_delta: BigInt(Math.round(0.0199 * 1e18)) },
  gate,
});
const baseRun = (gate) => rules(prepareSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan(gate), baseDeps: {} }));

test("EVM: the owner's check-gate applies to the verdict of Sato Hub's signed swap answer (plan.gate), as on Solana", async () => {
  setGate("caution", "refuse");
  assert.deepEqual(await baseRun("caution"), ["check_caution"]);
  assert.deepEqual(await baseRun("no"), ["check_no"]);
  assert.deepEqual(await baseRun("go"), []);
  assert.deepEqual(await baseRun("unknown"), ["check_unavailable"]);
  assert.deepEqual(await baseRun(null), ["check_unavailable"]);
  setGate("no", "allow");
  assert.deepEqual(await baseRun("caution"), []);
  assert.deepEqual(await baseRun("no"), ["check_no"]);
  assert.deepEqual(await baseRun("unknown"), []);
  setGate("off");
  assert.deepEqual(await baseRun("no"), []);
  assert.deepEqual(await baseRun(null), []);
});
