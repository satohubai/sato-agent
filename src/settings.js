// The bot's local settings: today, only the shipping address for Amazon orders.
//
// The address lives ONLY here, in settings.json (mode 600) beside the policy. It is
// sent in the body of a Sato Hub order request and nowhere else: never to the
// ledger, never in another command's output, never in an error message. `settings
// show` prints it back to the owner; `status` only says whether it is set.
//
// The approval of an order is bound to `ship_to_id`, a random id that changes every
// time the address changes, so an approval given for one address cannot be used for
// another, and the ledger (where approval intents are written) never holds the address.

import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { home, readJson, writePrivate } from "./store.js";

export const SETTINGS_SCHEMA = "sato-agent.settings/v1";
const file = () => join(home(), "settings.json");
const hmacKeyFile = () => join(home(), "local-hmac.key");

/**
 * A random 32-byte key made once on this computer (mode 600, beside the settings) and never sent anywhere. It keys the
 * HMAC that binds a private value (a top-up's phone number) into an approval intent, which is written to the ledger: a
 * plain hash of a phone number could be reversed by trying every number; this one cannot without the key.
 */
function hmacKey() {
  const p = hmacKeyFile();
  try {
    writePrivate(p, randomBytes(32).toString("hex") + "\n", { exclusive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const hex = fs.readFileSync(p, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${p} is not a 32-byte key; it was changed by hand. Move it aside to make a new one.`);
  return Buffer.from(hex, "hex");
}

/** HMAC-SHA256 (hex) of `value` under this computer's local key. */
export const localHmac = (value) => createHmac("sha256", hmacKey()).update(String(value), "utf8").digest("hex");

/** The address fields, in the order they are shown, with the flag that sets each one. */
export const SHIP_FIELDS = Object.freeze([
  ["name", "--ship-name"],
  ["line1", "--ship-line1"],
  ["line2", "--ship-line2"],
  ["city", "--ship-city"],
  ["state", "--ship-state"],
  ["postalCode", "--ship-zip"],
  ["country", "--ship-country"],
  ["email", "--ship-email"],
]);
const REQUIRED = ["name", "line1", "city", "state", "postalCode", "country", "email"];
const MAX_FIELD = 200;

export function loadSettings() {
  return readJson(file()) ?? null;
}

/** The shipping address, or null when none is set. */
export function shipTo() {
  return loadSettings()?.ship_to ?? null;
}

/** "set" or "not set": all `status` ever says about the address. */
export const shipToStatus = () => (shipTo() ? "set" : "not set");

function cleanField(key, flag, raw) {
  if (typeof raw !== "string") throw new Error(`${flag} needs a value`);
  // One plain line: no control, zero-width or direction characters (they would hide what is sent).
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) throw new Error(`${flag} contains a control or invisible character`);
  const v = raw.trim().replace(/\s+/g, " ");
  if (v.length > MAX_FIELD) throw new Error(`${flag} is longer than ${MAX_FIELD} characters`);
  // Stored in the exact form Sato Hub sends on to the merchant, so recipient_sha256 matches byte for byte:
  // a country code and a state code upper-cased (Amazon orders ship to US addresses only).
  if (key === "country") {
    if (/^(usa|united states( of america)?)$/i.test(v)) return "US";
    if (!/^[A-Za-z]{2}$/.test(v)) throw new Error(`${flag} must be a two-letter country code, like US`);
    return v.toUpperCase();
  }
  if (key === "state") {
    if (!/^[A-Za-z]{2}$/.test(v)) throw new Error(`${flag} must be a two-letter state code, like CA`);
    return v.toUpperCase();
  }
  if (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`${flag} must be an email address`);
  return v;
}

/**
 * Set or change the shipping address. `fields` maps a key of SHIP_FIELDS to a string (undefined = keep). An empty
 * `line2` removes it. The first time, every field but line2 is required. Returns the new address.
 */
export function setShipTo(fields) {
  const prev = loadSettings();
  const next = { ...(prev?.ship_to ?? {}) };
  let changed = false;
  for (const [key, flag] of SHIP_FIELDS) {
    if (fields[key] === undefined) continue;
    changed = true;
    if (key === "line2" && fields[key].trim() === "") {
      delete next.line2;
      continue;
    }
    const v = cleanField(key, flag, fields[key]);
    if (!v) throw new Error(`${flag} cannot be empty`);
    next[key] = v;
  }
  if (!changed) throw new Error(`settings set needs at least one of: ${SHIP_FIELDS.map(([, f]) => f).join(", ")}`);
  const missing = REQUIRED.filter((k) => !next[k]);
  if (missing.length) throw new Error(`the shipping address also needs ${missing.map((k) => SHIP_FIELDS.find(([key]) => key === k)[1]).join(", ")}`);
  const settings = { ...(prev ?? {}), schema: SETTINGS_SCHEMA, ship_to: next, ship_to_id: randomBytes(8).toString("hex"), ship_to_set_at: new Date().toISOString() };
  writePrivate(file(), JSON.stringify(settings, null, 2) + "\n", { atomic: true });
  return next;
}

/**
 * The address fields from a JSON object (`settings set --stdin`, so the address never sits in a command line or a
 * process list): keys name, line1, line2, city, state, postalCode (or zip), country, email. Any other key is refused.
 */
export function shipFieldsFromJson(text) {
  let o;
  try {
    o = JSON.parse(String(text));
  } catch {
    throw new Error("--stdin needs a JSON object, like {\"name\":\"...\",\"line1\":\"...\",\"city\":\"...\",\"state\":\"CA\",\"postalCode\":\"...\",\"country\":\"US\",\"email\":\"...\"}");
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("--stdin needs a JSON object of the address fields");
  const keys = SHIP_FIELDS.map(([k]) => k);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const key = k === "zip" ? "postalCode" : k;
    if (!keys.includes(key)) throw new Error(`--stdin: "${String(k).slice(0, 30)}" is not an address field (use ${keys.join(", ")})`);
    if (typeof v !== "string") throw new Error(`--stdin: ${key} must be a string`);
    out[key] = v;
  }
  return out;
}

/** Remove the shipping address. */
export function clearShipTo() {
  const prev = loadSettings();
  if (!prev?.ship_to) return false;
  const { ship_to: _a, ship_to_id: _b, ship_to_set_at: _c, ...rest } = prev;
  writePrivate(file(), JSON.stringify({ ...rest, schema: SETTINGS_SCHEMA }, null, 2) + "\n", { atomic: true });
  return true;
}

/** The address as lines for the owner (only `settings show` and an order's own price card print these). */
export function shipToLines(s = shipTo()) {
  if (!s) return ["(no shipping address set)"];
  return [s.name, s.line1, ...(s.line2 ? [s.line2] : []), `${s.city}, ${s.state} ${s.postalCode}`, s.country, s.email];
}

/** Every non-trivial value of the address, for scrubbing it out of any text that came back from a server. */
export function shipToValues(s = shipTo()) {
  if (!s) return [];
  return Object.values(s).filter((v) => typeof v === "string" && v.length >= 3);
}

/** Replace every address value inside `text` (case-insensitive) with "[address]". */
export function scrubAddress(text, s) {
  let out = String(text ?? "");
  if (s === undefined) {
    try {
      s = shipTo();
    } catch {
      s = null; // unreadable settings: nothing to scrub with
    }
  }
  for (const v of shipToValues(s).sort((a, b) => b.length - a.length)) {
    // Whole words only, so a short name does not eat into other words.
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), "[address]");
  }
  return out;
}
