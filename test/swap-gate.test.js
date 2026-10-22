// The owner's check gate (`policy set --check-gate`) applies to swaps too (v0.5.4), in the one way that fits a swap: it stops on a
// `no` verdict in Sato Hub's signed swap answer (`gate.verdict`), under `--check-gate no` and `--check-gate caution` alike. Live, Sato
// Hub's swap gate answers `caution` on almost every swap by design (EVM: venue rule R6 for KyberSwap itself; Solana: token_out rule T6,
// the token lane has no `go`), so a `caution` is shown in the swap's output and never refuses. `unknown` (or no gate in the answer)
// refuses only when the owner chose that (`--on-check-unavailable`).

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome, raisesInForce } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy: setPolicyAt } = await import("../src/policy.js");
const setPolicy = raisesInForce(setPolicyAt); // raises take effect at once here; the 24-hour wait is tested in test/hardening.test.js
const { Refused } = await import("../src/errors.js");
const { WSOL_MINT } = await import("../src/swap/solana.js");
const { USDC_MINT } = await import("../src/solana.js");
const { prepareSwap, swapLines } = await import("../src/swap/run.js");
const { swapGateRefusals, gateView, gateTargetsText } = await import("../src/satohub.js");

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

// What Sato Hub's swap gate really answers (2026-10): caution by design, with the part and rule that asked for it.
const EVM_CAUTION = { verdict: "caution", refusals: [], targets: { venue: { verdict: "caution", rule: "R6" } } };
const SOL_CAUTION = { verdict: "caution", refusals: [], targets: { token_out: { verdict: "caution", rule: "T6" } } };
const NO = { verdict: "no", refusals: [], targets: { token_out: { verdict: "no", rule: "T2" } } };

// ---- the pure helpers
test("gateView reads the real gate shape: the parts that did not come back go, with plain ids only", () => {
  assert.deepEqual(gateView(EVM_CAUTION), { verdict: "caution", targets: [{ target: "venue", verdict: "caution", rule: "R6" }] });
  assert.equal(gateTargetsText(gateView(SOL_CAUTION)), "token_out T6");
  assert.deepEqual(gateView("NO"), { verdict: "no", targets: [] });
  assert.equal(gateView(undefined), null);
  assert.equal(gateView(null), null);
  // a go part is not listed; a server's free text is never carried over; an id with odd characters is dropped
  const v = gateView({ verdict: "caution", targets: { venue: { verdict: "go", rule: "R1" }, token_out: { verdict: "caution", rule: "T6\u001b[31m evil text" }, "bad key!": { verdict: "caution", rule: "X1" } } });
  assert.deepEqual(v, { verdict: "caution", targets: [{ target: "token_out", verdict: "caution", rule: null }] });
  // a refusals entry that names a target counts too; an unreadable verdict is null
  assert.deepEqual(gateView({ verdict: "no", refusals: [{ target: "token_out", rule: "T2" }] }).targets, [{ target: "token_out", verdict: "no", rule: "T2" }]);
  assert.equal(gateView({ verdict: 3 }).verdict, null);
  // an already-read view reads back the same
  assert.deepEqual(gateView(gateView(EVM_CAUTION)), gateView(EVM_CAUTION));
});

test("swapGateRefusals: a swap stops on `no` only; caution never refuses; unknown or no gate follows on_check_unavailable", () => {
  const ids = (p, g) => swapGateRefusals(p, g).map((r) => r.rule);
  for (const g of [NO, "no", "NO", gateView(NO)]) {
    assert.deepEqual(ids({ check_gate: "off" }, g), [], "gate off: nothing is refused");
    assert.deepEqual(ids(null, g), [], "no policy: nothing is refused");
    assert.deepEqual(ids({ check_gate: "no" }, g), ["check_no"]);
    assert.deepEqual(ids({ check_gate: "caution" }, g), ["check_no"], "under `caution` a swap still stops on `no`");
  }
  for (const g of [EVM_CAUTION, SOL_CAUTION, "caution", { verdict: "go" }]) {
    for (const gate of ["off", "no", "caution"]) assert.deepEqual(ids({ check_gate: gate, on_check_unavailable: "refuse" }, g), [], `${gate}: ${JSON.stringify(g)} never refuses`);
  }
  // unknown / no gate: the owner's choice decides
  for (const g of [{ verdict: "unknown" }, undefined, null, {}, { verdict: 3 }, "maybe"]) {
    assert.deepEqual(ids({ check_gate: "off" }, g), []);
    assert.deepEqual(ids({ check_gate: "no", on_check_unavailable: "allow" }, g), [], `allow: ${JSON.stringify(g)}`);
    assert.deepEqual(ids({ check_gate: "no", on_check_unavailable: "refuse" }, g), ["check_unavailable"], `refuse: ${JSON.stringify(g)}`);
    assert.deepEqual(ids({ check_gate: "caution" }, g), ["check_unavailable"], "never chosen: fail closed, as everywhere");
  }
  // the refusal names the part and the rule, and says it is about a swap (not "the recipient")
  const r = swapGateRefusals({ check_gate: "caution" }, NO)[0];
  assert.equal(r.limit, "caution");
  assert.equal(r.observed, "no (token_out T2)");
  assert.match(r.message, /Sato Hub's gate on this swap came back "no" \(token_out T2\)/);
  assert.match(r.message, /Nothing was signed/);
  assert.doesNotMatch(r.message, /recipient/i);
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

test("Solana: a token_out T6 caution proceeds under check-gate caution and no; a `no` is refused before Jupiter is asked", async () => {
  for (const gate of ["no", "caution"]) {
    setGate(gate, "refuse");
    assert.deepEqual(await solRun(SOL_CAUTION), { rules: [], reachedJupiter: true }, `${gate}: caution goes on`);
    assert.equal((await solRun({ verdict: "go" })).reachedJupiter, true);
    assert.deepEqual(await solRun(NO), { rules: ["check_no"], reachedJupiter: false }, `${gate}: no stops`);
  }
});

test("Solana: `unknown` or a missing gate refuses only when the owner chose to refuse an unreadable check", async () => {
  setGate("caution", "allow");
  assert.equal((await solRun({ verdict: "unknown" })).reachedJupiter, true);
  assert.equal((await solRun(undefined)).reachedJupiter, true);
  setGate("caution", "refuse");
  assert.deepEqual((await solRun({ verdict: "unknown" })).rules, ["check_unavailable"]);
  assert.deepEqual((await solRun(undefined)).rules, ["check_unavailable"]);
});

test("Solana: with the gate off (the default) nothing stops a swap, not even a `no`", async () => {
  setGate("off");
  for (const g of [NO, SOL_CAUTION, { verdict: "unknown" }, undefined]) assert.equal((await solRun(g)).reachedJupiter, true, JSON.stringify(g));
});

test("Solana: the gate is read only from an answer whose signature was verified", async () => {
  setGate("no", "refuse");
  const planned = { n: 0 };
  const deps = { ...solDeps({ verdict: "go" }, planned), verifySignature: async () => { throw new Error("bad_signature"); } };
  assert.deepEqual(await rules(prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, deps)), ["signature_unverified"]);
});

test("Solana: a caution is a line in the swap's output (the part and the rule), and a go is not", async () => {
  setGate("caution", "refuse");
  const shownFor = async (gate) => {
    // run the whole prepare, with the planner returning a plain Jupiter plan
    const plan = { agent: "A", chain: "solana", venue: "jupiter", from: USDC_MINT, to: WSOL_MINT, amount_in: "11000000", quote: { out_amount: "100000000", min_out: "98500000", price_impact_bps: null, route_hops: 1 }, fee: { bps: 15, leg: "input", max_units: "0", symbol: "USDC" }, tokens: { in: { decimals: 6 }, out: { decimals: 9 } }, disclosure: ["Swap line"] };
    const deps = { ...solDeps(gate, { n: 0 }), planSolanaSwap: async () => plan, verifySolanaSwapPlan: async () => ({ simulated: { ok: true } }) };
    return prepareSwap({ chain: "solana", from: "USDC", to: "SOL", amount: "11" }, deps);
  };
  const withCaution = await shownFor(SOL_CAUTION);
  assert.deepEqual(withCaution.display.sato_hub_gate, { verdict: "caution", targets: [{ target: "token_out", verdict: "caution", rule: "T6" }] });
  assert.match(swapLines(withCaution.display).join("\n"), /Sato Hub's gate on this swap says caution \(token_out T6\)\..*never stops one/);
  const withGo = await shownFor({ verdict: "go" });
  assert.doesNotMatch(swapLines(withGo.display).join("\n"), /Sato Hub's gate on this swap says/);
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
  // what evm.planAndVerifyBaseSwap puts on a plan from the signed answer's gate
  gate: gate && typeof gate === "object" ? gate.verdict : gate ?? null,
  gate_view: gateView(gate),
});
const basePrepare = (gate) => prepareSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => basePlan(gate), baseDeps: {} });
const baseRun = (gate) => rules(basePrepare(gate));

test("EVM: the venue R6 caution (live, on almost every swap) proceeds under check-gate caution and no, and shows as a line; a `no` is refused", async () => {
  for (const gate of ["no", "caution"]) {
    setGate(gate, "refuse");
    assert.deepEqual(await baseRun(EVM_CAUTION), [], `${gate}: caution goes on`);
    assert.deepEqual(await baseRun({ verdict: "go" }), []);
    assert.deepEqual(await baseRun(NO), ["check_no"], `${gate}: no stops`);
    assert.deepEqual(await baseRun("unknown"), ["check_unavailable"]);
    assert.deepEqual(await baseRun(null), ["check_unavailable"]);
  }
  setGate("caution", "allow");
  assert.deepEqual(await baseRun("unknown"), []);
  assert.deepEqual(await baseRun(null), []);
  setGate("caution", "refuse");
  const p = await basePrepare(EVM_CAUTION);
  assert.deepEqual(p.display.sato_hub_gate, { verdict: "caution", targets: [{ target: "venue", verdict: "caution", rule: "R6" }] });
  assert.match(swapLines(p.display).join("\n"), /Sato Hub's gate on this swap says caution \(venue R6\)/);
  setGate("off");
  assert.deepEqual(await baseRun(NO), []);
  assert.deepEqual(await baseRun(null), []);
});

test("EVM: a plan that carries only the bare verdict string (no gate_view) is read the same way", async () => {
  setGate("caution", "refuse");
  const run = (gate) => rules(prepareSwap({ chain: "base", from: "USDC", to: "ETH", amount: "50" }, { oraclePrice: eth(2500), planAndVerifyBaseSwap: async () => ({ ...basePlan(undefined), gate, gate_view: undefined }), baseDeps: {} }));
  assert.deepEqual(await run("caution"), []);
  assert.deepEqual(await run("no"), ["check_no"]);
});
