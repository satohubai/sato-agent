// Stablecoin amounts, parsed the same way on every chain: a plain decimal with at
// most the token's decimals (6 for USDC, 18 for some chains' USDT / USDC), positive.
// Never rounded: "1.0000009" is refused, not turned into 1.000001 (Base used to
// round it, Solana refused it). Limits stay in USD; only the token units differ.

export const USDC_DECIMALS = 6;

/** A plain positive decimal with at most `decimals` places, as base units. Throws a plain Error naming `symbol`. */
export function stableUnits(amount, decimals = USDC_DECIMALS, symbol = "USDC") {
  const s = String(amount);
  const [whole, frac = ""] = s.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || s.endsWith(".") || frac.length > decimals) {
    throw new Error(`not a ${symbol} amount: "${amount}" (a plain number with at most ${decimals} decimals, like 12.5)`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error(`not a positive ${symbol} amount: "${amount}"`);
  return units;
}

/** USDC (6 decimals unless told otherwise). */
export const usdcUnits = (amount, decimals = USDC_DECIMALS, symbol = "USDC") => stableUnits(amount, decimals, symbol);

/** Base units of a dollar stablecoin as a USD number. */
export const unitsToUsd = (units, decimals = USDC_DECIMALS) => Number(units) / 10 ** decimals;

/** A USD figure as base units (rounded to the nearest unit), the inverse of `unitsToUsd`. */
export const usdToUnits = (usd, decimals = USDC_DECIMALS) => BigInt(Math.round(usd * 10 ** decimals));

/** Base units as a plain decimal string with no trailing zeros ("12.5", "3"). */
export function unitsToText(units, decimals = USDC_DECIMALS) {
  const u = BigInt(units);
  const one = 10n ** BigInt(decimals);
  const frac = (u % one).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${u / one}.${frac}` : (u / one).toString();
}

/** Round a USD figure for display (float sums like 0.30000000000000004). */
export const roundUsd = (n) => Math.round(n * 1e6) / 1e6;
