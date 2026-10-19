// Sato Hub's tiered swap fee (owner ruling 2026-10-10): 0.03% stable pairs, 0.15% majors, 0.75% any long-tail token.
// The kit holds every disclosed fee to 1% on any pair and 0.15% unless a long-tail token is traded, classifies the
// pair itself, and refuses a disclosed tier that disagrees. Offline.

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const F = await import("../src/swap/fee-tier.js");
const S = await import("../src/swap/solana.js");
const { swapIntent, swapLines } = await import("../src/swap/run.js");

const rules = (x) => x.map((r) => r.rule);

test("the kit's own tier for a pair: stable, major or token", () => {
  assert.equal(F.pairTier("USDC", "USDC"), "stable");
  assert.equal(F.pairTier("USDC", "ETH"), "major");
  assert.equal(F.pairTier("WETH", "USDC"), "major");
  assert.equal(F.pairTier("SOL", "USDC"), "major");
  assert.equal(F.pairTier("ETH", "WETH"), "major");
  assert.equal(F.pairTier("USDC", null), "token");
  assert.equal(F.pairTier(null, "SOL"), "token");
});

test("75 bps on a token pair is accepted; 76 to 100 is refused as above the tier's rate; 101 is refused on any pair", () => {
  assert.deepEqual(F.feeTierRefusals({ bps: 75, tier: "token", disclosedTier: "token" }), []);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 76, tier: "token", disclosedTier: "token" })), ["fee_above_tier"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 100, tier: "token", disclosedTier: "token" })), ["fee_above_tier"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 101, tier: "token", disclosedTier: "token" })), ["fee_over_ceiling"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 101, tier: "major", disclosedTier: "major" })), ["fee_over_ceiling"]);
});

test("a major or stable pair above its rate is refused (75 bps on USDC <-> ETH); 3 bps on a stable pair and 15 on a major pass", () => {
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 75, tier: "major", disclosedTier: "major" })), ["fee_over_major_ceiling"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 16, tier: "major", disclosedTier: "major" })), ["fee_over_major_ceiling"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 16, tier: "stable", disclosedTier: "stable" })), ["fee_over_major_ceiling"]);
  assert.deepEqual(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier: "major" }), []);
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "stable", disclosedTier: "stable" }), []);
});

test("never without the fee: 0 bps is fee_missing for every tier, with the plain 'do not swap another way' ending", () => {
  for (const tier of ["stable", "major", "token"]) {
    const got = F.feeTierRefusals({ bps: 0, tier, disclosedTier: tier });
    assert.deepEqual(rules(got), ["fee_missing"], tier);
    assert.match(got[0].message, /Tell the owner; do not swap another way\.$/);
  }
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 0, tier: "stable", prefix: "solana_swap." })), ["solana_swap.fee_missing"], "0 with no tier is still fee_missing");
  assert.deepEqual(rules(F.feeTierRefusals({ bps: null, tier: "major", disclosedTier: "major" })), ["fee_disclosure_missing"]);
});

test("the disclosed tier must be present (fee_tier_missing), the kit's own reading is no stand-in", () => {
  for (const disclosedTier of [undefined, null]) {
    assert.deepEqual(rules(F.feeTierRefusals({ bps: 75, tier: "token", disclosedTier })), ["fee_tier_missing"]);
    assert.deepEqual(rules(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier, prefix: "solana_swap." })), ["solana_swap.fee_tier_missing"]);
  }
});

test("a fee BELOW the published rate of the disclosed tier is refused (fee_below_tier): token at 10, major at 5, stable at 1", () => {
  for (const [tier, bps] of [["token", 10], ["token", 74], ["major", 5], ["major", 14], ["stable", 1], ["stable", 2], ["token", 15], ["token", 3]]) {
    const got = F.feeTierRefusals({ bps, tier, disclosedTier: tier });
    assert.deepEqual(rules(got), ["fee_below_tier"], `${tier} ${bps}`);
    assert.deepEqual([got[0].limit, got[0].observed], [F.PUBLISHED_FEE_BPS[tier], bps]);
    assert.match(got[0].message, /Tell the owner; do not swap another way\.$/);
  }
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 5, tier: "major", disclosedTier: "major", prefix: "solana_swap." })), ["solana_swap.fee_below_tier"]);
});

test("every published tier at its exact rate passes, on the kit's own reading and on a cheaper-than-the-kit disclosure", () => {
  for (const [tier, bps] of Object.entries({ stable: 3, major: 15, token: 75 })) {
    assert.deepEqual(F.feeTierRefusals({ bps, tier, disclosedTier: tier }), [], tier);
    assert.equal(F.PUBLISHED_FEE_BPS[tier], bps);
  }
  // Sato Hub reads USDC -> USDT as stable (3) and SOL -> PYUSD as major (15) while the kit reads both as a token trade.
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "token", disclosedTier: "stable" }), []);
  assert.deepEqual(F.feeTierRefusals({ bps: 15, tier: "token", disclosedTier: "major" }), []);
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "major", disclosedTier: "stable" }), []);
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "token", disclosedTier: "stable", prefix: "solana_swap." }), []);
});

test("a disclosed tier MORE expensive than the kit's reading is refused (fee_tier_mismatch)", () => {
  // USDC <-> ETH priced as a "token" trade: an overcharge.
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier: "token" })), ["fee_tier_mismatch"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 3, tier: "stable", disclosedTier: "major" })), ["fee_tier_mismatch"]);
  // A server calling a major pair a "token" pair to charge 75 bps: both rules fire (the ceiling is the kit's tier then).
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 75, tier: "major", disclosedTier: "token" })), ["fee_tier_mismatch", "fee_over_major_ceiling"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 3, tier: "token", disclosedTier: "premium" })), ["fee_tier_mismatch"], "an unknown tier is not accepted");
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 3, tier: "token", disclosedTier: "cross_chain" })), ["fee_tier_mismatch"], "a swap can never claim the bridge tier");
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier: "token", prefix: "solana_swap." })), ["solana_swap.fee_tier_mismatch"]);
});

test("a disclosed tier CHEAPER than the kit's reading is accepted, held to the rate of the tier Sato Hub claimed", () => {
  // USDC -> USDT: Sato Hub's majors include USDT ("stable"); the kit reads USDT as a long-tail token ("token").
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "token", disclosedTier: "stable" }), []);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 75, tier: "token", disclosedTier: "stable" })), ["fee_over_major_ceiling"], "a stable claim never charges 0.75%");
  // DEGEN (a kit long-tail token) priced as "major" at 15 bps: cheaper, accepted; at 16+ it is over the claimed tier.
  assert.deepEqual(F.feeTierRefusals({ bps: 15, tier: "token", disclosedTier: "major" }), []);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 16, tier: "token", disclosedTier: "major" })), ["fee_over_major_ceiling"]);
  // A cheaper claim still has a floor: "stable" at 1 bps, "major" at 10 bps.
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 1, tier: "token", disclosedTier: "stable" })), ["fee_below_tier"]);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 10, tier: "token", disclosedTier: "major" })), ["fee_below_tier"]);
  // USDC <-> ETH priced as "stable": cheaper, accepted at 3; 15 is over the stable rate.
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "major", disclosedTier: "stable" }), []);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier: "stable" })), ["fee_over_major_ceiling"], "a stable claim is held to the stable ceiling");
});

test("each tier has its own ceiling: a stable pair is held to 3 bps, not to the major tier's 15 (4 bps refused, 3 accepted)", () => {
  assert.deepEqual(F.TIER_CEILING_BPS, { stable: 3, major: 15, token: 100, cross_chain: 25 });
  assert.deepEqual(F.feeTierRefusals({ bps: 3, tier: "stable", disclosedTier: "stable" }), []);
  const got = F.feeTierRefusals({ bps: 4, tier: "stable", disclosedTier: "stable" });
  assert.deepEqual(rules(got), ["fee_over_major_ceiling"]);
  assert.deepEqual([got[0].limit, got[0].observed], [3, 4]);
  assert.match(got[0].message, /priced as stable, whose most is 0\.03%/);
  assert.deepEqual(F.feeTierRefusals({ bps: 15, tier: "major", disclosedTier: "major" }), []);
  assert.deepEqual(rules(F.feeTierRefusals({ bps: 16, tier: "major", disclosedTier: "major" })), ["fee_over_major_ceiling"]);
  assert.deepEqual([F.approvalFeeCeiling("stable"), F.approvalFeeCeiling("major"), F.approvalFeeCeiling("token")], [3, 15, 100]);
});

test("a bridge: exactly the cross_chain rate (25 bps); 0 is fee_missing, 10 is fee_below_tier, 26 is over the ceiling; the tier must be cross_chain", () => {
  assert.deepEqual(F.bridgeFeeRefusals({ bps: 25, disclosedTier: "cross_chain" }), []);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 0, disclosedTier: "cross_chain" })), ["fee_missing"]);
  const low = F.bridgeFeeRefusals({ bps: 10, disclosedTier: "cross_chain" });
  assert.deepEqual(rules(low), ["fee_below_tier"]);
  assert.match(low[0].message, /nothing was signed\. Tell the owner; do not bridge another way\.$/);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 26, disclosedTier: "cross_chain" })), ["fee_over_ceiling"]);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 25, disclosedTier: undefined })), ["fee_tier_missing"]);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 25, disclosedTier: null })), ["fee_tier_missing"]);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 25, disclosedTier: "major" })), ["fee_tier_mismatch"]);
  assert.deepEqual(rules(F.bridgeFeeRefusals({ bps: 1.5, disclosedTier: "cross_chain" })), ["fee_amount_mismatch"]);
});

test("a pair where neither side is a kit major (USDT <-> DAI, \"stable\" to Sato Hub) is refused before any quote: the fee could not be kept off a token", async () => {
  const { sizeSwap } = await import("../src/swap/run.js");
  const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
  const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
  const policy = { chains: ["base"], max_usd_per_tx: null, max_usd_per_day: null, swaps_off: false };
  const resolveBaseToken = async (a) => ({ address: a, symbol: a === USDT ? "USDT" : "DAI", name: null, decimals: 6, major: false, native: false });
  await assert.rejects(sizeSwap({ chain: "base", from: USDT, to: DAI, amount: "10" }, { policy, resolveBaseToken }), (e) => e.refusals?.[0]?.rule === "token_to_token" && /must be USDC, ETH or WETH/.test(e.message));
});

test("the fee is shown as a percent and in bps", () => {
  assert.equal(F.feePercent(75), "0.75%");
  assert.equal(F.feePercent(15), "0.15%");
  assert.equal(F.feePercent(3), "0.03%");
  assert.equal(F.feeText(75, "token"), "0.75% (75 bps, a token trade)");
  const lines = swapLines({ chain: "solana", venue: "jupiter", sell: { asset: "USDC", amount: "20" }, buy: { asset: "BONK", quoted: "1", minimum: "1", slippage_bps: 150 }, usd_held_to_limits: 20, usd_basis: "usdc_amount", sato_fee: { bps: 75, tier: "token", asset: "USDC", disclosure: null }, simulation: {} });
  assert.ok(lines.includes("Sato Hub fee: 0.75% (75 bps, a token trade), taken in USDC, never in the token."));
});

test("Solana: the ceiling is 1% for a token pair, and USDC <-> SOL is held to 0.15% before anything is built", async () => {
  assert.equal(S.FEE_BPS_MAX, 100);
  const noFetch = { fetch: () => assert.fail("nothing is fetched for a fee the kit refuses"), minGapMs: 0, agent: "11111111111111111111111111111111" };
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: "SOL", amount: "1", slippageBps: 50 }, { ...noFetch, satoFeeBps: 75, satoFeeTier: "major" }), (e) => e.refusals?.[0]?.rule === "solana_swap.fee_over_major_ceiling");
  // The tier is required, and the fee must be its published rate.
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: "SOL", amount: "1", slippageBps: 50 }, { ...noFetch, satoFeeBps: 15 }), (e) => e.refusals?.[0]?.rule === "solana_swap.fee_tier_missing");
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: "SOL", amount: "1", slippageBps: 50 }, { ...noFetch, satoFeeBps: 5, satoFeeTier: "major" }), (e) => e.refusals?.[0]?.rule === "solana_swap.fee_below_tier");
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: "SOL", amount: "1", slippageBps: 50 }, { ...noFetch, satoFeeBps: 101 }), /whole number from 1 to 100/);
  // No fee at all is refused too, before anything is fetched (a swap without the fee is not this kit's).
  await assert.rejects(S.planSolanaSwap({ from: "USDC", to: "SOL", amount: "1", slippageBps: 50 }, { ...noFetch, satoFeeBps: 0 }), (e) => e.refusals?.[0]?.rule === "solana_swap.fee_missing");
});

test("the approval line uses the published table and the tier ceiling", () => {
  assert.equal(F.approvalFeeLine("token"), "Sato Hub fee: 0.75% for a token trade (this approval allows up to 1%).");
  assert.equal(F.approvalFeeLine("major"), "Sato Hub fee: 0.15% for ETH or SOL with USDC (this approval allows up to 0.15%).");
  assert.equal(F.approvalFeeLine("stable"), "Sato Hub fee: 0.03% for a stablecoin pair (this approval allows up to 0.03%).");
});

test("the approval intent binds the fee tier and the most that tier may cost", () => {
  const sized = (fromKind, toKind, from, to) => ({ chain: "base", from, to, fromAsset: { kind: fromKind, id: "a" }, toAsset: { kind: toKind, id: "b" }, amount: "1", slippageBps: 50, longTail: fromKind === "token" || toKind === "token" });
  const token = swapIntent(sized("major", "token", "USDC", "DEGEN 0x4ed4…efed"));
  assert.equal(token.fee_tier, "token");
  assert.equal(token.fee_max_bps, 100);
  const major = swapIntent(sized("major", "major", "USDC", "ETH"));
  assert.equal(major.fee_tier, "major");
  assert.equal(major.fee_max_bps, 15);
});
