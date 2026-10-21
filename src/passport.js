// The Sato Passport link in an agent's ERC-8004 registration file.
//
// A Sato Passport id looks like sato:agt:<12 characters>. When the owner gives the kit one (`register --passport <id>`), the
// registration file gets one more entry in its `services` list that points at the passport's page on satohub.ai:
//
//   { "name": "SatoPassport", "endpoint": "https://satohub.ai/passport/<the 12 characters>", "version": "1" }
//
// What that entry is: the agent's OWN declaration, written into its own registration file, that links this ERC-8004
// registration to a Sato Passport. The kit does not look the passport up and does not check it against Sato Hub (no network
// call is made here or at register time), and the entry says nothing about the agent being verified, safe or trusted.
//
// The id is saved in settings.json (mode 600, beside the policy) the first time it is given, so a later `register --resume`
// writes the same entry without being told again. `--passport none` drops it.
//
// The shape follows the ERC-8004 registration file: a services entry is { name, endpoint, version } and "the number and type of
// endpoints are fully customizable"; `version` is a SHOULD. The URL base is a constant on purpose: the registration file is
// stored onchain, so the link in it must be the canonical one and never follow an environment variable.

import { clean } from "./text.js";
import { loadSettings, patchSettings } from "./settings.js";
import { record } from "./ledger.js";

/** Sato Passport ids: `sato:agt:` and 12 characters from an alphabet with no look-alikes (no i, l, o, 0, 1). */
export const PASSPORT_ID_RE = /^sato:agt:[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;

/** The canonical, stable page of a passport; the 12 characters follow it. */
export const PASSPORT_URL_BASE = "https://satohub.ai/passport/";

/** The `name` of the services entry. Compared case-insensitively when an entry of the same name is already there. */
export const PASSPORT_SERVICE_NAME = "SatoPassport";

/** The `version` of the services entry: version 1 of the passport link (the `sato:agt:` id and the /passport/<12> page). */
export const PASSPORT_SERVICE_VERSION = "1";

/**
 * A passport id as written (surrounding spaces ignored), or a plain Error naming the flag. The id is never changed to fit:
 * an upper-case or shortened id is refused, not guessed.
 */
export function parsePassportId(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!PASSPORT_ID_RE.test(v)) {
    throw new Error(`--passport must be a Sato Passport id like sato:agt:exmpexmpexmp (sato:agt: and 12 lower-case characters), or none (got "${clean(typeof raw === "string" ? raw : String(raw), 40)}")`);
  }
  return v;
}

/** The page of a passport: https://satohub.ai/passport/<12 characters>. */
export const passportUrl = (id) => PASSPORT_URL_BASE + parsePassportId(id).slice("sato:agt:".length);

/** The services entry for a passport id. */
export const passportService = (id) => ({ name: PASSPORT_SERVICE_NAME, endpoint: passportUrl(id), version: PASSPORT_SERVICE_VERSION });

/**
 * `services` with the passport entry added as the last one. An entry the caller already gave with the same name (any case)
 * is replaced, so there is never a duplicate. With no passport (undefined, null) the list is returned as it is. An invalid id
 * throws before anything is built.
 */
export function withPassportService(services, passport) {
  if (passport === undefined || passport === null) return services;
  const entry = passportService(passport);
  return [...services.filter((s) => String(s?.name ?? "").trim().toLowerCase() !== PASSPORT_SERVICE_NAME.toLowerCase()), entry];
}

// ---------------------------------------------------------------- the saved passport (settings.json)

/** The saved passport id, or null. A hand-edited value that is not a passport id reads as none. */
export function savedPassport() {
  const v = loadSettings()?.passport;
  return typeof v === "string" && PASSPORT_ID_RE.test(v) ? v : null;
}

/**
 * What `register` should use. `input` is what the caller gave: undefined = nothing (use the saved one), null or "none"/"off"/"clear"
 * = no passport from now on, an id = that passport. Validated, nothing written. Returns { passport, explicit }.
 */
export function resolvePassport(input) {
  if (input === undefined) return { passport: savedPassport(), explicit: false };
  if (input === null || (typeof input === "string" && /^(none|off|clear)$/i.test(input.trim()))) return { passport: null, explicit: true };
  return { passport: parsePassportId(input), explicit: true };
}

/**
 * What one `register` call writes. Same as `resolvePassport`, except for ANOTHER agent from the same wallet: a `--again` registration (not a
 * `--resume`, which is the same agent), or a `--resume` of an agent registered after the wallet's first one on that chain (`laterAgent`,
 * which is such a `--again` registration being finished). The saved passport belongs to the first agent, so it is NOT applied to the
 * other one, and a passport is used only when it is given on this very command. A passport given for another agent is for that one
 * file: it is never saved, and the saved one is never replaced or dropped by it.
 *   passport     the id the registration file carries, or null
 *   save         true when this call should write `passport` into settings.json (never for another agent)
 *   skippedSaved the saved id that was left out because this is another agent, else null (the caller says so, in one line)
 *   another      true when this is another agent
 */
export function resolveForRegister(input, { again = false, resume, laterAgent = false } = {}) {
  const r = resolvePassport(input);
  const another = (again && resume === undefined) || laterAgent;
  if (!another) return { passport: r.passport, save: r.explicit, skippedSaved: null, another: false };
  if (input === undefined) return { passport: null, save: false, skippedSaved: savedPassport(), another: true };
  return { passport: r.passport, save: false, skippedSaved: null, another: true };
}

/** The one line printed when the saved passport is left out because this is another agent. */
export const skippedPassportNote = (id) =>
  `The saved Sato Passport link (${id}) was not added to this registration file: this is another agent from the same wallet (--again), and a passport belongs to one agent. Add --passport <this agent's own id> to give it one.`;

/**
 * The lines `register` prints under its result about the passport: the link, when the file carries one (it says what the entry is, the agent's
 * own declaration, and nothing more), and the skipped note, when a saved passport was left out. `save` is whether this call saved the id.
 */
export function passportResultLines(r, { save = false } = {}) {
  const lines = [];
  if (r.passport) lines.push(`Registration file links to Sato Passport ${r.passport}: ${r.passport_url} (this agent's own declaration, not checked by the kit; ${save ? "saved here so --resume keeps it" : "for this registration file only, not saved"}).`);
  if (r.passport_skipped) lines.push(skippedPassportNote(r.passport_skipped));
  return lines;
}

/**
 * Save the passport id (or drop it with null) in settings.json. A change is logged in the ledger (kind "settings"; a passport id is
 * public). Returns true when something changed.
 */
export function savePassport(passport) {
  const was = savedPassport();
  if ((passport ?? null) === was) return false;
  if (passport === null) {
    patchSettings(({ passport: _p, passport_set_at: _t, ...rest }) => rest);
    record({ kind: "settings", status: "passport_cleared", from: was, to: null });
    return true;
  }
  patchSettings((s) => ({ ...s, passport, passport_set_at: new Date().toISOString() }));
  record({ kind: "settings", status: "passport_set", from: was, to: passport });
  return true;
}
