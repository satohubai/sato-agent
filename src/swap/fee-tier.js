// Sato Hub's swap fee, by tier (owner ruling, 2026-10-10):
//
//   stable  stablecoin <-> stablecoin       3 bps (0.03%)
//   major   ETH / WETH / SOL <-> USDC, and major <-> major       15 bps (0.15%)
//   token   any trade with a long-tail token                      75 bps (0.75%)
//
// Sato Hub sets the rate server-side and discloses it in its signed quote (`sato_fee_bps`, and `sato_fee_tier`). The kit
// does not pin the rate; it holds it to two ceilings so a broken or hostile server cannot overcharge:
//
//   - any pair: at most FEE_CEILING_BPS (1%);
//   - a stable or major pair: at most MAJOR_FEE_CEILING_BPS (0.15%). Only a pair with a long-tail token may go higher.
//
// The kit classifies the pair itself (it already knows which side is a major and which a long-tail token). Sato Hub's
// majors are a wider set (USDT, DAI, ...), so its disclosed tier may be CHEAPER than the kit's reading: that is accepted,
// held to the ceiling of the tier Sato Hub claimed (a "stable" claim can never charge 0.75%). A disclosed tier MORE
// expensive than the kit's reading is an overcharge and is refused (`fee_tier_mismatch`). Without a disclosed tier the
// kit's own is used. The fee side is always decided by the kit's own majors (USDC / ETH / WETH / SOL), whatever the tier.
// Where the fee is taken is unchanged: always on the major side, never in the long-tail token (checked elsewhere).

export const FEE_CEILING_BPS = 100;
export const MAJOR_FEE_CEILING_BPS = 15;
export const FEE_TIERS = Object.freeze(["stable", "major", "token"]);
/** Sato Hub's published rate per tier, for display and docs only: the kit enforces the ceilings above, not these. */
export const PUBLISHED_FEE_BPS = Object.freeze({ stable: 3, major: 15, token: 75 });
/** Stablecoins among the kit's majors. */
const STABLE_SYMBOLS = new Set(["USDC"]);

/**
 * The tier of a pair, from the kit's own classification. Each side is the symbol of a major ("USDC", "ETH", "WETH",
 * "SOL") or null for a long-tail token.
 */
export function pairTier(a, b) {
  if (!a || !b) return "token";
  return STABLE_SYMBOLS.has(String(a).toUpperCase()) && STABLE_SYMBOLS.has(String(b).toUpperCase()) ? "stable" : "major";
}

/** The fee as the owner reads it: "0.75%". */
export const feePercent = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

/** "0.75% (75 bps, any other token)": the percent first, then the bps and the tier in words. */
export function feeText(bps, tier) {
  const words = { stable: "stablecoin pair", major: "ETH/SOL with USDC", token: "a token trade" }[tier];
  return `${feePercent(bps)} (${bps} bps${words ? `, ${words}` : ""})`;
}

/**
 * The refusals for a disclosed fee on a pair of this tier (empty = allowed). `disclosedTier` is Sato Hub's
 * `sato_fee_tier` (undefined or null when it sent none). `prefix` names the rules ("" on Base, "solana_swap." on Solana).
 */
export function feeTierRefusals({ bps, tier, disclosedTier, prefix = "" }) {
  const out = [];
  const r = (rule, message, limit, observed) => out.push({ rule: `${prefix}${rule}`, limit, observed, message });
  // Tiers are ordered by cost. Sato Hub's set of majors is wider than the kit's (USDT, DAI, USDbC, EURC, ...), so it may
  // call a pair cheaper than the kit does (USDC -> USDT: "stable" to Sato Hub, "token" to the kit): that charges the owner
  // LESS and is accepted, held to the ceiling of the tier Sato Hub claimed. Only a tier MORE expensive than the kit's own
  // reading is an overcharge, and is refused.
  const claimed = disclosedTier === undefined || disclosedTier === null ? null : disclosedTier;
  let ceilingTier = tier;
  if (claimed !== null) {
    if (!FEE_TIERS.includes(claimed) || TIER_ORDER[claimed] > TIER_ORDER[tier]) {
      r("fee_tier_mismatch", `Sato Hub priced this as a "${String(claimed).slice(0, 20)}" trade, which costs more than the ${tier} pair it is to this kit; nothing was signed`, tier, String(claimed).slice(0, 20));
    } else {
      ceilingTier = claimed;
    }
  }
  if (!Number.isInteger(bps) || bps < 0) {
    r("fee_disclosure_missing", "Sato Hub's fee is not a whole number of basis points", "0-100", bps ?? null);
  } else if (bps > FEE_CEILING_BPS) {
    r("fee_over_ceiling", `the fee is ${feePercent(bps)} (${bps} bps), above the ${feePercent(FEE_CEILING_BPS)} this kit ever accepts; nothing was signed`, FEE_CEILING_BPS, bps);
  } else if (ceilingTier !== "token" && bps > MAJOR_FEE_CEILING_BPS) {
    r("fee_over_major_ceiling", `the fee is ${feePercent(bps)} (${bps} bps) on a pair priced as ${ceilingTier}; only a trade with a long-tail token may cost more than ${feePercent(MAJOR_FEE_CEILING_BPS)}; nothing was signed`, MAJOR_FEE_CEILING_BPS, bps);
  }
  return out;
}

/** The most a swap approval allows Sato Hub to charge on a pair of this tier. */
export const approvalFeeCeiling = (tier) => (tier === "token" ? FEE_CEILING_BPS : MAJOR_FEE_CEILING_BPS);

/**
 * The plain line an approval request carries for a swap (approved before the quote, so the rate is the published one and
 * the ceiling is what the approval allows): "Sato Hub fee: 0.75% for a token trade (this approval allows up to 1%)".
 */
export function approvalFeeLine(tier) {
  const pct = (bps) => `${Number((bps / 100).toFixed(2))}%`;
  const words = { stable: " for a stablecoin pair", major: " for ETH or SOL with USDC", token: " for a token trade" }[tier] ?? "";
  return `Sato Hub fee: ${pct(PUBLISHED_FEE_BPS[tier] ?? approvalFeeCeiling(tier))}${words} (this approval allows up to ${pct(approvalFeeCeiling(tier))}).`;
}

/** Cheapest first. */
export const TIER_ORDER = Object.freeze({ stable: 0, major: 1, token: 2 });
