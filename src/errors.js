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
    super(`${message}\nIt may still land.${counted} Do NOT retry; check ${details.explorer ?? "the explorer"} first.`);
    this.details = details;
  }
}

/** A broadcast the node definitely refused: it never entered the mempool. */
export class Rejected extends Error {}
