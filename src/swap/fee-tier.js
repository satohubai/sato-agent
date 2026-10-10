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
// The kit classifies the pair itself (it already knows which side is a major and which a long-tail token). A disclosed
// tier that disagrees with that is refused (`fee_tier_mismatch`); without a disclosed tier the kit's own is used.
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
  if (disclosedTier !== undefined && disclosedTier !== null && disclosedTier !== tier) {
    r("fee_tier_mismatch", `Sato Hub priced this as a "${String(disclosedTier).slice(0, 20)}" trade, but it is a ${tier} pair to this kit; nothing was signed`, tier, String(disclosedTier).slice(0, 20));
  }
  if (!Number.isInteger(bps) || bps < 0) {
    r("fee_disclosure_missing", "Sato Hub's fee is not a whole number of basis points", "0-100", bps ?? null);
  } else if (bps > FEE_CEILING_BPS) {
    r("fee_over_ceiling", `the fee is ${feePercent(bps)} (${bps} bps), above the ${feePercent(FEE_CEILING_BPS)} this kit ever accepts; nothing was signed`, FEE_CEILING_BPS, bps);
  } else if (tier !== "token" && bps > MAJOR_FEE_CEILING_BPS) {
    r("fee_over_major_ceiling", `the fee is ${feePercent(bps)} (${bps} bps) on a ${tier} pair; only a trade with a long-tail token may cost more than ${feePercent(MAJOR_FEE_CEILING_BPS)}; nothing was signed`, MAJOR_FEE_CEILING_BPS, bps);
  }
  return out;
}
