/** A spend the limits did not allow. Nothing was signed. CLI exit code 3. */
export class Refused extends Error {
  constructor(refusals) {
    super(refusals.map((r) => `REFUSED ${r.rule}: ${r.message}`).join("\n"));
    this.refusals = refusals;
  }
}

/**
 * A spend that was signed and may have gone out, but could not be confirmed.
 * It stays counted against the limits. Do NOT retry: check the explorer first.
 * CLI exit code 4.
 */
export class Pending extends Error {
  constructor(message, details = {}) {
    const counted = details.counted === false ? "" : " It stays counted against the limits.";
    const land = details.sent === false ? "" : "\nIt may still land."; // sent:false = signed but never sent
    super(`${message}${land}${counted} Do NOT retry; check ${details.explorer ?? "the explorer"} first.`);
    this.details = details;
  }
}

/** A broadcast the node definitely refused: it never entered the mempool. */
export class Rejected extends Error {}

/** Approval mode: nothing was spent; the owner must approve this exact intent. CLI exit code 5. */
export class NeedsApproval extends Error {
  constructor(intent, approval) {
    const priceNote = intent.cmd === "pay" ? "\nNote: the server sets the price and payee when paying; the per-transaction limit caps it. Approving this does not fix the price." : "";
    super(`Needs the owner's approval. Nothing was spent.\nIntent: ${JSON.stringify(intent)}${priceNote}\nIf the owner approves, re-run the same command with --approve ${approval.code} (valid until ${approval.expires_at}, once).`);
    this.intent = intent;
    this.approval = approval;
  }
}
