// USDC amounts, parsed the same way on every chain: a plain decimal with at
// most 6 places, positive. Never rounded: "1.0000009" is refused, not turned
// into 1.000001 (Base used to round it, Solana refused it).

export function usdcUnits(amount) {
  const s = String(amount);
  const [whole, frac = ""] = s.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || s.endsWith(".") || frac.length > 6) {
    throw new Error(`not a USDC amount: "${amount}" (a plain number with at most 6 decimals, like 12.5)`);
  }
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  if (units <= 0n) throw new Error(`not a positive USDC amount: "${amount}"`);
  return units;
}

export const unitsToUsd = (units) => Number(units) / 1e6;

/** Round a USD figure for display (float sums like 0.30000000000000004). */
export const roundUsd = (n) => Math.round(n * 1e6) / 1e6;
