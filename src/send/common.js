// Shared by the EVM and Solana halves of `send --asset`: a refusal in one line, a short address, the USD figure a coin counts as, and
// the shape of the ledger row a send writes.

import { Refused } from "../errors.js";

/** A policy-style refusal (exit 3, nothing signed) with a rule name and a plain sentence. */
export const refuse = (rule, message, limit = null, observed = null) => new Refused([{ rule, limit, observed, message }]);

/** "0x6982…1933" / "DezX…B263": the first and last characters of an address or mint. */
export const shortId = (a, head = 6) => `${String(a).slice(0, head)}…${String(a).slice(-4)}`;

/** How a token that is not in the registry is named everywhere: its symbol AND its short address (a symbol is whatever its creator wrote). */
export const tokenLabel = (symbol, id, head = 6) => {
  const short = shortId(id, head);
  return !symbol || symbol === short ? short : `${symbol} ${short}`;
};

/** USD for a coin priced from an oracle: rounded UP to a micro-dollar, so a tiny send never counts as nothing. */
export const usdUp = (x) => Math.max(0.000001, Math.ceil(x * 1e6 - 1e-9) / 1e6);

/** `--amount all` (any letter case). */
export const isAll = (amount) => /^all$/i.test(String(amount ?? ""));

/** Said on every send, in its output and in its intent: a send is a plain transfer. */
export const NO_FEE_LINE = "No Sato Hub fee; network gas only.";

/** The sentence every send of a token with no price carries. */
export const UNPRICED_LINE = "Not counted against your USD limits (no price).";

/** The spend a send reserves against the limits and writes to the ledger: chain, asset (symbol plus address or mint), amount, USD (null when unpriced). */
export function ledgerSpend(plan) {
  return {
    kind: "send",
    chain: plan.chain,
    asset: plan.asset.label,
    asset_address: plan.asset.address ?? plan.asset.mint ?? null,
    amount: plan.amountText,
    usd: plan.unpriced ? null : plan.usd,
    ...(plan.unpriced ? { unpriced: true } : {}),
    to: plan.to,
  };
}

/** The intent an approval binds. A native `all` is bound as "all" (the gas it keeps moves with the fee); everything else by its exact amount. */
export function sendIntent(plan) {
  return {
    cmd: "send",
    chain: plan.chain,
    to: plan.to,
    amount: plan.all && plan.asset.kind === "native" ? "all" : plan.amountText,
    asset: plan.asset.id,
    fee: NO_FEE_LINE,
    ...(plan.received ? { received: plan.received.text } : {}),
    ...(plan.powers?.length ? { powers: plan.powers } : {}),
  };
}

/** The lines a send is shown in, before it is approved or signed. */
export function sendLines(plan) {
  const where = plan.chain;
  const value = plan.unpriced
    ? UNPRICED_LINE
    : plan.valuation.basis === "stable"
      ? `Counts as $${plan.usd} against your USD limits (a stablecoin, 1:1).`
      : `Counts as about $${plan.usd} against your USD limits (${plan.valuation.oracle.asset} at $${Number(plan.valuation.oracle.usd).toFixed(2)}, Chainlink, ${plan.valuation.oracle.age_s} s old).`;
  return [`Send ${plan.amountText} ${plan.asset.label} on ${where} to ${plan.to}`, `  ${value}`, ...plan.notes.map((n) => `  ${n}`), `  ${NO_FEE_LINE}`];
}

/** The fields a send adds to its --json output. */
export function sendFields(plan) {
  return {
    chain: plan.chain,
    to: plan.to,
    asset: plan.asset.label,
    asset_address: plan.asset.address ?? plan.asset.mint ?? null,
    amount: plan.amountText,
    usd: plan.unpriced ? null : plan.usd,
    unpriced: plan.unpriced,
    sato_fee: NO_FEE_LINE,
    ...(plan.received ? { received: plan.received.text } : {}),
    ...(plan.stays ? { stays_for_gas: plan.stays.text } : {}),
    ...(plan.rent ? { recipient_account_rent_sol: plan.rent.text } : {}),
    notes: plan.notes,
  };
}
