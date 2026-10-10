// What every purchase (a gift card, an Amazon order, a checkout) goes through before
// anything is signed:
//
//   1. the owner's limits, with the price known (the same per-transaction and rolling
//      24-hour USD limits as every spend; a purchase is reserved under the same spend
//      lock when it is paid, so two purchases cannot both squeeze under a limit);
//   2. the owner's purchase setting (`policy set --purchases ask|auto`; unset = ask):
//      in "ask" mode the price card is shown and the command stops with exit 5 and an
//      approval code bound to that exact purchase. The owner's yes is the same command
//      again with `--approve <code>`.
//
// A dry run asks nobody and spends nothing.

import { evaluate, loadPolicy, purchasesAsk } from "./policy.js";
import { spentLast24h } from "./ledger.js";
import { NeedsApproval, Refused } from "./errors.js";
import { consumeApproval, requestApproval } from "./approvals.js";

export const refusal = (rule, message, limit = null, observed = null) => ({ rule, limit, observed, message });
export const refuse = (rule, message, limit = null, observed = null) => new Refused([refusal(rule, message, limit, observed)]);

/** The owner's limits for a purchase of `usd` on `chain` to `to` (or every payee in `payees`). Throws Refused. */
export function checkLimits({ usd, chain, to, payees = [] }, policy = loadPolicy()) {
  const out = evaluate(policy, { usd: usd ?? 0.000001, to, chain }, spentLast24h());
  // Every address the money reaches must pass the owner's allowlist (when they set one), not just the first.
  for (const p of payees) {
    if (p === to) continue;
    for (const r of evaluate(policy, { usd: 0.000001, to: p, chain }, { usd: 0, unreadable: [] })) if (r.rule === "allow_recipients") out.push(r);
  }
  if (out.length) throw new Refused(out);
}

/** The chain a purchase is made on: the owner's one chain, or `--chain` when they chose two. Throws Refused / Error. */
export function purchaseChain(requested, allowed = ["base", "solana"], policy = loadPolicy()) {
  const chains = Array.isArray(policy?.chains) ? policy.chains : null;
  if (!policy) throw new Refused(evaluate(null, {}, { usd: 0, unreadable: [] }));
  if (!chains) throw new Refused(evaluate(policy, { usd: 1e-6 }, { usd: 0, unreadable: [] }));
  let chain = requested === undefined ? undefined : String(requested).toLowerCase();
  if (chain === undefined) {
    const usable = chains.filter((c) => allowed.includes(c));
    if (usable.length === 1) chain = usable[0];
    else if (usable.length > 1) throw new Error(`this agent may spend on ${chains.join(" and ")}: say which with --chain ${usable.join("|")}`);
    else chain = chains[0];
  }
  if (!["base", "solana"].includes(chain)) throw new Error("--chain must be base or solana");
  if (!chains.includes(chain)) throw refuse("chain_not_allowed", `this agent is set to work on ${chains.join(" and ")} only`, chains, chain);
  return chain;
}

/**
 * The owner's purchase setting. In "ask" mode (the default) a run without `--approve` throws NeedsApproval (exit 5)
 * carrying the price card; a run with it consumes the code for exactly this intent. `card` is the list of lines the
 * owner is shown; the intent itself is written to the ledger, so it must never hold a secret or the address.
 */
export async function purchaseGate(intent, { approve, dryRun = false, card = [] } = {}, policy = loadPolicy()) {
  if (dryRun || !purchasesAsk(policy)) return { asked: false };
  if (!approve) {
    const err = new NeedsApproval(intent, await requestApproval(intent));
    // The card goes to the command's own stdout (the CLI prints it), never into the error text: an order's card names
    // the recipient, and the address never goes in an error message.
    err.card = card;
    err.message = `This purchase needs the owner's yes (purchases ask first; the owner can switch them to auto with \`policy set --purchases auto\`).\n${err.message}`;
    throw err;
  }
  await consumeApproval(approve, intent);
  return { asked: true };
}
