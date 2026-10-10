// The referral share (v0.3.1). A referrer is a payout address the owner was given when someone shared this kit; Sato Hub pays
// it 30% of the swap fee, weekly in USDC. This file is ALL the kit does about it:
//
//   - the swap request to Sato Hub carries `referrer` (only when one is set);
//   - the signed answer carries `referral`; the kit shows it, and WARNS (never blocks) when Sato Hub did not record the
//     referrer that was sent;
//   - after a confirmed swap that carried a referrer, the kit tells Sato Hub which transaction it was, once.
//
// What it never does: change what the owner pays, where the fee goes, the fee checks (address, side, tier, ceiling), the
// approval, the limits, the exit code, or wait on Sato Hub for more than a few seconds after the swap is already done.

import { MCP_URL } from "../satohub.js";
import { USER_AGENT } from "../version.js";
import { clean } from "../text.js";
import { normalizeReferrer, referrer as savedReferrer, shortReferrer } from "../settings.js";

export const SETTLE_PATH = "/api/route/settle";
export const SETTLE_TIMEOUT_MS = 8_000;

/** The referrer a swap carries: `deps.referrer` when the caller gave one (null = none, for this swap), else the saved setting. */
export function referrerFor(deps = {}) {
  if (Object.hasOwn(deps, "referrer")) return normalizeReferrer(deps.referrer);
  try {
    return savedReferrer();
  } catch {
    return null; // unreadable settings: no referral, the swap itself is unaffected
  }
}

/**
 * Sato Hub refusing the referrer it was sent (`{ error: "referrer_invalid", message }`), as a sentence for the owner, or null
 * when the answer is not that refusal. `result` is the tool result ({ text, structured, isError }), `body` its JSON body.
 */
export function referrerRefusalMessage(body, result) {
  const text = String(body?.message ?? result?.text ?? "");
  if (body?.error !== "referrer_invalid" && !/referrer_invalid/.test(String(result?.text ?? ""))) return null;
  return `Sato Hub did not accept the referral address${text && !/^referrer_invalid$/.test(text) ? ` (${clean(text, 200)})` : ""}. Nothing was signed. Fix it with \`settings set --referrer <address>\`, remove it with \`settings set --referrer none\`, or run this swap once without it with --no-referrer.`;
}

/** The `referral` object of a signed answer, as far as it is usable: { referrer, share_of_fee_bps, payout } or null. */
export function readReferral(answer) {
  if (!answer || typeof answer !== "object" || typeof answer.referrer !== "string") return null;
  const bps = answer.share_of_fee_bps;
  return { referrer: answer.referrer, share_of_fee_bps: Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : null, payout: typeof answer.payout === "string" ? answer.payout : null };
}

/**
 * What the owner is shown about the referral on one swap: null when no referrer was sent. `sent` is the normalized referrer
 * in the request, `answer` the signed answer's `referral`. `recorded` is true only when the signed answer names the same
 * referrer (normalized); otherwise `warning` says so. Display only: nothing here can stop a swap.
 * `feeBps`: the quote's Sato fee. A quote with NO Sato fee (0, null or missing) has nothing to share, and Sato Hub answers `referral: null`
 * for it: that is not a failure, so the view is null (nothing printed, nothing reported) whatever the answer says.
 */
export function referralView(sent, answer, feeBps) {
  if (!sent) return null;
  if (!feeBps) return null; // 0, null or missing: no fee to share
  const got = readReferral(answer);
  const recorded = Boolean(got) && normalizeReferrer(got.referrer) === sent;
  return {
    sent,
    recorded,
    share_of_fee_bps: recorded ? got.share_of_fee_bps : null,
    payout: recorded ? got.payout : null,
    warning: recorded ? null : "Sato Hub didn't record your referrer on this swap. The swap is unaffected; the referrer's share may not be paid for it.",
  };
}

/** The sentence added to the fee line when Sato Hub recorded the referral: "30% of it goes to the referrer 0x1234…abcd." */
export function referralFeeSentence(view) {
  if (!view?.recorded) return "";
  const share = view.share_of_fee_bps === null ? null : view.share_of_fee_bps / 100;
  return ` ${share === null ? "Part" : `${share}%`} of it goes to the referrer ${shortReferrer(view.sent)}${view.payout === "weekly_usdc" ? " (paid weekly in USDC)" : ""}; it is not an extra charge.`;
}

/**
 * Tell Sato Hub which transaction a confirmed swap was, so the referrer can be paid. POST <origin>/api/route/settle with
 * { route_id, chain, tx }. ONE attempt, a short timeout, never throws. Returns { attempted, ok, recorded, status?, code? }:
 * ok only for 200 { ok: true, recorded: true }; any other answer (400 bad_request, 404, 409 different_tx / tx_already_used /
 * chain_mismatch / tx_mismatch, 429, 503, a timeout) is a `code` for the one line the owner sees, never a retry.
 * Called only for a swap that carried a referrer (the caller checks); with none, nothing is sent at all.
 * deps: fetchImpl, origin.
 */
export async function settleReferral({ routeId, chain, tx }, deps = {}) {
  if (!routeId || !tx) return { attempted: false, ok: false, recorded: false, code: "no_route_id", error: "no_route_id" };
  try {
    const origin = deps.origin ?? new URL(MCP_URL).origin;
    const res = await (deps.fetchImpl ?? fetch)(`${origin}${SETTLE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ route_id: String(routeId), chain, tx: String(tx) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? SETTLE_TIMEOUT_MS),
    });
    // Only the status and, for a refusal, Sato Hub's short error code are read. 200 { ok: true, recorded: true } is the one success.
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    if (res.status === 200 && body?.ok === true && body?.recorded === true) return { attempted: true, ok: true, recorded: true, status: 200 };
    return failed(res.status, res.status === 200 ? "not_confirmed" : errorCode(body) ?? `http_${res.status}`);
  } catch (err) {
    return failed(null, err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "no_answer");
  }
}

const failed = (status, code) => ({ attempted: true, ok: false, recorded: false, ...(status ? { status } : {}), code, error: code });
/** Sato Hub's short error code from a refusal body ({ error } or { code }), or null. Only a plain token is shown to the owner. */
const errorCode = (body) => {
  const c = body && typeof body === "object" ? (typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : null) : null;
  return c && /^[A-Za-z0-9_.-]{1,40}$/.test(c) ? c : null;
};

/**
 * After a confirmed swap: report it if (and only if) the swap carried a referrer. `display` is the swap's display, `result`
 * what the chain module returned. Returns null when nothing was sent (no referrer), else the outcome of the one attempt.
 * Never throws and never changes the swap's result.
 */
export async function reportSettlement(display, result, deps = {}) {
  try {
    if (!display?.referral?.sent) return null;
    return await settleReferral({ routeId: result?.route_id ?? display.route_id ?? display.sato_fee?.route_id ?? null, chain: display.chain, tx: result?.tx }, deps);
  } catch (err) {
    return failed(null, "no_answer");
  }
}

/** The one line that says what happened to the report. Never an alarm: the swap is done and was not affected. */
export function settlementLine(outcome) {
  if (!outcome) return null;
  if (outcome.ok) return "Referral recorded.";
  return `Note: the referral for this swap could not be recorded (${clean(outcome.code ?? outcome.error ?? "no_answer", 40)}). The swap itself is unaffected.`;
}
