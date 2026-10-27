// Joining Sato Hub from the kit: `sato-agent join` and `sato-agent passport ...`.
//
// A Sato Passport is a public page on satohub.ai for one agent. `join` makes this agent's: the bot signs ONE message with its own EVM key
// (the primary wallet) and, unless told not to, with its Solana key, and Sato Hub lists the passport. What a signature proves is that the
// signer controlled that wallet's key when it signed and agreed to what the message says. It says nothing about the agent's code, its
// safety or who owns it, and the message says that it moves no funds.
//
// The join contract is frozen in the Sato Hub app (private); this file is the kit's side of it:
//
//   - the byte-exact message a wallet signs (`passportMessage`), per action, pinned against the app's golden vectors in the tests;
//   - the claim code (12 characters, made here with the OS random source) and its digest, which is all Sato Hub ever sees of it;
//   - POST <origin>/api/passport/join to join, POST <origin>/api/passport/action to issue a new claim code or prove a wallet;
//   - what is saved in settings.json (mode 600) when it works: the passport id, its slug, its profile url.
//
// What it never does: send a key, send the claim code (only its digest), log the claim code anywhere, or spend. Joining and issuing a code
// make the agent more public or change who can manage its passport, so each stops for the owner's approval first (exit 5 and a one-time
// code) in every approval mode, like `settings set --referrer`.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { MCP_URL } from "./satohub.js";
import { userAgent } from "./version.js";
import { clean } from "./text.js";
import { PlainError } from "./errors.js";
import { record } from "./ledger.js";
import { makeSigner } from "./referral-names.js";
import { loadWallet } from "./wallet.js";
import { loadSettings, normalizeAddress, patchSettings } from "./settings.js";
import { PASSPORT_ID_RE, passportUrl, savePassport, savedPassport } from "./passport.js";

export const JOIN_PATH = "/api/passport/join";
export const ACTION_PATH = "/api/passport/action";
export const POST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- the signed message (the join contract)

/** The first line every wallet UI shows. */
export const PASSPORT_MESSAGE_TITLE = "satohub.ai asks you to sign a Sato Passport action.";
/** The origin the message is for; Sato Hub never accepts a message for another one. */
export const PASSPORT_MESSAGE_DOMAIN = "satohub.ai";
export const PASSPORT_MESSAGE_VERSION = "1";

/** Every action a wallet signature can authorize (the contract's list; added to, never changed). */
export const PASSPORT_ACTIONS = Object.freeze(["join", "add_wallet", "prove_wallet", "remove_wallet", "set_primary", "update_profile", "issue_claim", "unlink_owner"]);

/** How a join may say it came from: the contract's list without the web form's own path and "other". */
export const JOIN_VIA = Object.freeze(["api", "mcp", "kit", "sato-bot", "create-sato-agent"]);
/** The two this kit says: itself, or the Sato Bot setup that runs it. */
export const KIT_VIA = Object.freeze(["kit", "sato-bot"]);

/** A wallet inside a message: { chain: "evm" | "solana", address } (EVM lower case, Solana exact). */
export const walletLabel = (w) => `${w.chain}:${w.address}`;
const byLabel = (a, b) => (walletLabel(a) < walletLabel(b) ? -1 : walletLabel(a) > walletLabel(b) ? 1 : 0);

/** A wallet in canonical form from an address, its chain read from its shape; null when it is neither an EVM nor a Solana address. */
export function normalizeWallet(raw) {
  const a = normalizeAddress(raw);
  return a ? { chain: /^0x/.test(a) ? "evm" : "solana", address: a } : null;
}

/** What the wallet owner agrees to, in plain words, per action. Every statement says it moves no funds. */
export function actionStatement(action, passportId, wallets) {
  const p = passportId ?? "(new)";
  const list = [...wallets].sort(byLabel).map(walletLabel).join(", ");
  switch (action) {
    case "join":
      return `Creates a public Sato Passport for ${list}. Any wallet on it can manage it. It moves no funds.`;
    case "add_wallet":
      return `Adds ${list} to Sato Passport ${p}, publicly. Any wallet on it can then manage it. It moves no funds.`;
    case "prove_wallet":
      return `Confirms ${list} belongs to Sato Passport ${p}, publicly. Any wallet on it can then manage it. It moves no funds.`;
    case "remove_wallet":
      return `Removes ${list} from Sato Passport ${p}. It moves no funds.`;
    case "set_primary":
      return `Makes ${list} the primary wallet of Sato Passport ${p}. It moves no funds.`;
    case "update_profile":
      return `Changes the public profile of Sato Passport ${p}. It moves no funds.`;
    case "issue_claim":
      return `Issues a new owner claim code for Sato Passport ${p}; earlier unused codes stop working. It moves no funds.`;
    case "unlink_owner":
      return `Unlinks the owner account from Sato Passport ${p}. It moves no funds.`;
    default:
      throw new Error(`unknown passport action "${action}"`);
  }
}

const dash = (v) => (v === null || v === undefined || v === "" ? "-" : v);

/**
 * The exact bytes a wallet signs: UTF-8, lines joined by "\n", no trailing newline. Every line is always present (a "-" when it does not apply).
 *   action       one of PASSPORT_ACTIONS
 *   passport_id  the passport acted on; null for `join` (written "-")
 *   wallet       the wallet whose key signs THIS message ({ chain, address })
 *   wallets      the wallets the request is about, sorted by label here
 *   issued_at    ISO 8601 UTC with milliseconds
 *   primary      join: the primary EVM wallet, or null
 *   name         join: the display name exactly as sent, or null for a generated default
 *   via          join: how the agent registered
 *   claim_sha256 join / issue_claim: claimCodeDigest(code)
 *   patch_sha256 update_profile only
 */
export function passportMessage(m) {
  const set = [...m.wallets].sort(byLabel).map(walletLabel).join(",");
  return [
    PASSPORT_MESSAGE_TITLE,
    "",
    actionStatement(m.action, m.passport_id ?? null, m.wallets),
    "",
    `domain: ${PASSPORT_MESSAGE_DOMAIN}`,
    `version: ${PASSPORT_MESSAGE_VERSION}`,
    `action: ${m.action}`,
    `passport: ${dash(m.passport_id)}`,
    `wallet: ${walletLabel(m.wallet)}`,
    `wallets: ${set}`,
    `primary: ${m.primary ? walletLabel(m.primary) : "-"}`,
    `name: ${dash(m.name)}`,
    `via: ${dash(m.via)}`,
    `claim: ${dash(m.claim_sha256)}`,
    `patch: ${dash(m.patch_sha256)}`,
    `issued_at: ${m.issued_at}`,
  ].join("\n");
}

// ---------------------------------------------------------------- the display name (validated, never rewritten: the name is signed)

// Never allowed in signed text: control and format characters (NUL, bidi overrides, zero-width), lone surrogates (encoders disagree on
// them), and line / paragraph separators (a wallet screen may show them as a new line, faking a line of the message).
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
// Any space character other than the plain ASCII space U+0020 (NBSP, Ogham, the U+2000..U+200A run, narrow NBSP, medium math space, ideographic).
const OTHER_SPACE = /[^\S ]|[   -   　]/u;

/** A reason the display name cannot be used as it is, or null. 3 to 80 characters, plain spaces only, at least 3 letters or digits. */
export function nameProblem(v) {
  if (typeof v !== "string") return "name must be text";
  if (v.length < 3 || v.length > 80) return "name must be 3–80 characters";
  if (UNSAFE_TEXT.test(v)) return "name contains a control, invisible or line-break character";
  if (OTHER_SPACE.test(v)) return "name may use only the plain space between words";
  if (v !== v.trim() || / {2,}/.test(v)) return "name has leading, trailing or repeated spaces";
  if ((v.match(LETTER_OR_DIGIT) ?? []).length < 3) return "name needs at least 3 letters or digits";
  return null;
}

// ---------------------------------------------------------------- the claim code

/** Lookalike-free upper case, so a code read aloud or typed from a chat survives. */
export const CLAIM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CLAIM_CODE_RE = /^SATO(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){3}$/;
/** A code works once, for 7 days. */
export const CLAIM_TTL_DAYS = 7;

/**
 * A new claim code, SATO-XXXX-XXXX-XXXX (12 characters, about 2^59). Needs the operating system's random source and throws rather than
 * fall back to anything weaker. Rejection sampling: no modulo bias. `randomBytes(n)` is injectable for the tests.
 */
export function generateClaimCode(randomBytes = (n) => nodeRandomBytes(n)) {
  const out = [];
  while (out.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && out.length < 12) out.push(CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length]);
    }
  }
  const s = out.join("");
  return `SATO-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** The code's public digest: what a join or issue_claim signs, so only someone holding the code can redeem it. Lower-case hex SHA-256. */
export const claimCodeDigest = (code) => createHash("sha256").update(`sato-passport-claim:v1:${code}`, "utf8").digest("hex");

// ---------------------------------------------------------------- signers and requests

/** This bot's signer for `chain` ("base" = its EVM key, "solana"), as { chain: "evm"|"solana", address, sign }. The key is never returned. */
function signerFor(chain, keys) {
  const s = makeSigner(chain, keys);
  return { chain: chain === "base" ? "evm" : "solana", address: s.address, sign: s.sign };
}

/** Does this bot have a Solana key to sign with? (A wallet made by `init` always does; `keys` injects one for the tests.) */
function hasSolanaKey(keys) {
  if (keys?.solanaSecret) return true;
  try {
    return typeof loadWallet().solana?.secret_key_b64 === "string";
  } catch {
    return false;
  }
}

/**
 * The wallets a join signs with: the bot's EVM key first (it is the primary: it receives the onchain records), then its Solana key unless
 * `noSolana`. Returns [{ chain, address, sign }].
 */
export function joinSigners({ noSolana = false, keys } = {}) {
  const out = [signerFor("base", keys)];
  if (!noSolana && hasSolanaKey(keys)) out.push(signerFor("solana", keys));
  return out;
}

/** The issued_at to sign: ISO 8601 UTC with milliseconds. */
export const issuedAtOf = (now = new Date()) => now.toISOString();

/**
 * The join request body, signed: every wallet signs the same facts (the wallet set, the primary, the name, how it registered, the claim
 * code's digest) in its own message. `claimCode` is made by the caller; only its digest is in the body. Returns
 * { body, wallets: [{ chain, address }], primary, claim_sha256 }.
 */
export async function buildJoinRequest({ name = null, via = "kit", signers, claimCode, issuedAt }) {
  const wallets = signers.map(({ chain, address }) => ({ chain, address }));
  const primary = wallets.find((w) => w.chain === "evm");
  if (!primary) throw new PlainError("A passport join needs this agent's EVM wallet as its primary; nothing was signed.");
  const claim_sha256 = claimCodeDigest(claimCode);
  const signed = [];
  for (const s of signers) {
    const wallet = { chain: s.chain, address: s.address };
    const message = passportMessage({ action: "join", passport_id: null, wallet, wallets, issued_at: issuedAt, primary, name, via, claim_sha256 });
    signed.push({ address: s.address, signature: await s.sign(message) });
  }
  return {
    body: { wallets: signed, primary: primary.address, issued_at: issuedAt, ...(name === null ? {} : { name }), via, claim_sha256 },
    wallets,
    primary,
    claim_sha256,
  };
}

/** A single-wallet action request body (`issue_claim`, `prove_wallet`), signed. `claimSha256` only for issue_claim. */
export async function buildActionRequest({ action, passportId, signer, claimSha256 = null, issuedAt }) {
  if (action !== "issue_claim" && action !== "prove_wallet") throw new Error(`the kit signs only issue_claim and prove_wallet here, not "${action}"`);
  const wallet = { chain: signer.chain, address: signer.address };
  const message = passportMessage({ action, passport_id: passportId, wallet, wallets: [wallet], issued_at: issuedAt, claim_sha256: claimSha256 });
  const signature = await signer.sign(message);
  return { action, passport_id: passportId, wallet: { address: wallet.address, signature }, ...(claimSha256 ? { claim_sha256: claimSha256 } : {}), issued_at: issuedAt };
}

// ---------------------------------------------------------------- talking to Sato Hub

const originOf = (deps) => deps.origin ?? new URL(MCP_URL).origin;

/** The only host these commands are meant for. */
export const OFFICIAL_HOST = "satohub.ai";

/**
 * The host the passport commands will sign for when it is not satohub.ai (SATO_AGENT_MCP_URL, or a test's origin), else null. A signed join
 * is bound to the domain in its message, but the message says "satohub.ai" whatever host receives it: so the owner is told where it goes,
 * in the approval intent (so a code for one host is no use for another) and on the card.
 */
export function customHost(deps = {}) {
  try {
    const h = new URL(originOf(deps)).host;
    return h === OFFICIAL_HOST ? null : h;
  } catch {
    return "(an address the kit cannot read)";
  }
}
const hostIntent = (h) => (h ? { host: h } : {});
const hostCard = (h) => (h ? [`⚠ Signing for ${h}, not satohub.ai: SATO_AGENT_MCP_URL points the passport commands there. Say yes only if the owner set that on purpose.`] : []);
const parse = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * POST a JSON body. Returns { status, body } (body a plain object or null). No answer or a timeout is a PlainError that says what to do,
 * because the request may have reached Sato Hub even when its answer did not reach here.
 */
async function postJson(path, payload, deps, { what }) {
  let res;
  let text;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${originOf(deps)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": userAgent() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deps.timeoutMs ?? POST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new PlainError(`Couldn't reach Sato Hub, or its answer did not arrive, so nothing was saved here. ${what}`);
  }
  return { status: res.status, body: parse(text), retryAfter: res.headers?.get?.("retry-after") ?? null };
}

const NETWORK_HINT = {
  join: "If the join went through, running `join` again will say the wallet is already on a passport; `passport issue-claim --passport <id>` then makes a new claim code. Otherwise run `join` again.",
  action: "Run the command again.",
};

const TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;

/** The server's machine code for a refusal: `code`, else `error` when that is a plain token (and not a sentence). */
function refusalCode(body) {
  for (const k of ["code", "error"]) if (typeof body?.[k] === "string" && TOKEN.test(body[k])) return body[k];
  return null;
}

/** The server's own sentence: `message`, else `error` when it is a sentence. Cleaned and cut: it is outside text. */
function refusalMessage(body) {
  if (typeof body?.message === "string" && body.message.trim()) return clean(body.message, 300);
  if (typeof body?.error === "string" && body.error.trim() && !TOKEN.test(body.error)) return clean(body.error, 300);
  return null;
}

/** The next steps Sato Hub names, as short cleaned lines (at most 6). */
function serverSteps(body) {
  const raw = Array.isArray(body?.next) ? body.next : Array.isArray(body?.next_steps) ? body.next_steps : [];
  return raw.filter((s) => typeof s === "string" && s.trim()).slice(0, 6).map((s) => clean(s, 300));
}

/** What the global daily join cap says (`daily_cap`, HTTP 429): never retried in a loop. */
export const JOIN_LIMIT_SENTENCE = "Sato Hub's join limit for today is reached; try again tomorrow.";

/** The longest Sato Hub asks an address to wait: its per-address join quota is per rolling hour. */
export const IP_QUOTA_MAX_SECONDS = 3600;

/**
 * Seconds to wait from a per-address quota refusal: `retry_after_seconds` in the body, else the `Retry-After` header, as a whole number of
 * seconds from 1, clamped to the hour; null when neither is readable.
 */
export function retryAfterSeconds(body, header) {
  for (const v of [body?.retry_after_seconds, header]) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 1) return Math.min(n, IP_QUOTA_MAX_SECONDS);
  }
  return null;
}

/**
 * What the per-address join quota (`ip_quota`, HTTP 429: so many new passports per address per rolling hour) says: when it opens again, in
 * whole minutes rounded up. With no readable wait the whole hour is named, which is the longest it can be. Never retried in a loop.
 */
export function ipQuotaSentence(seconds) {
  const minutes = Math.ceil((seconds ?? IP_QUOTA_MAX_SECONDS) / 60);
  return `Sato Hub's join limit for this address is reached; try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/**
 * A plain reason for each of the contract's refusal codes, and the ones the join handler adds. null for a code the kit does not know:
 * Sato Hub's own sentence is then shown as it is.
 */
export function explainRefusal(code, status = 0, { retryAfterS = null } = {}) {
  switch (code) {
    case "bad_request":
      return "Sato Hub could not read the request.";
    case "bad_wallet":
      return "A wallet address in the request was not an EVM or Solana address.";
    case "bad_signature_shape":
      return "A signature was not in the expected form.";
    case "duplicate_wallet_in_request":
      return "The same wallet was listed twice.";
    case "too_many_wallets":
      return "A passport holds at most 4 EVM and 4 Solana wallets.";
    case "no_wallet":
      return "The request listed no wallet.";
    case "bad_primary":
      return "The primary wallet was not accepted: it must be one of the EVM wallets in the join.";
    case "stale":
      return "The signed message was too old or too far ahead. This computer's clock may be off by more than about two minutes: check the time, then run the command again.";
    case "bad_passport":
      return "The passport id was not accepted.";
    case "bad_name":
      return "The name was not accepted. A name is 3 to 80 characters, with plain spaces only.";
    case "bad_via":
      return "Sato Hub did not accept how this join says it came.";
    case "bad_claim":
      return "The claim code's digest was not accepted.";
    case "bad_patch":
      return "The profile change was not accepted.";
    // The two join limits (HTTP 429), and the command is not tried again for either. Per address: so many new passports per rolling hour, and
    // Sato Hub says when it opens again. Global: a daily cap, tomorrow.
    case "ip_quota":
      return ipQuotaSentence(retryAfterS);
    // The name this quota had before it became hourly: with a wait given it reads as the hourly quota; without one it was the daily one.
    case "ip_daily_quota":
      return retryAfterS ? ipQuotaSentence(retryAfterS) : JOIN_LIMIT_SENTENCE;
    case "daily_cap":
      return JOIN_LIMIT_SENTENCE;
    case "wallet_taken":
      return "Sato Hub says one of this agent's wallets is already on a Sato Passport (one wallet is one passport). `sato-agent passport status` shows the id saved here.";
    case "primary_exists":
      return "This passport already has a different primary wallet.";
    case "name_taken":
      return "A passport already uses that name. Pick another with --name.";
    case "replay":
      return "That signed message was already used. Run the command again: it signs a fresh one.";
    case "claim_taken":
      return "That claim code is already in use. Run the command again: it makes a new one.";
    default:
  }
  if (status === 429 || (code && /rate|throttl/i.test(code))) return "Sato Hub is limiting requests from here right now. Try again later.";
  if (code && /signature/i.test(code)) return "Sato Hub could not check a signature against its wallet.";
  if (status >= 500) return "Sato Hub had a problem on its side. Try again later.";
  return null;
}

/**
 * A refusal as one PlainError for the owner: what happened in plain words (the kit's, for a code it knows), what Sato Hub itself said, its
 * next steps, and that nothing was saved. Every line is cleaned; none holds a key or a claim code (neither is ever sent).
 */
function refusal(res, { saved = "Nothing was saved." } = {}) {
  const code = refusalCode(res.body);
  const said = refusalMessage(res.body);
  const own = explainRefusal(code, res.status, { retryAfterS: retryAfterSeconds(res.body, res.retryAfter) });
  const head = own ?? said ?? `Sato Hub answered HTTP ${res.status}.`;
  const lines = [`Sato Hub did not accept this${code ? ` (${code})` : ` (HTTP ${res.status})`}: ${head}`];
  if (own && said && said !== own) lines.push(`Sato Hub says: ${said}`);
  // The passport a wallet is already on, when Sato Hub names it: a lost claim code for it is recovered with issue-claim (nothing is assumed
  // about whose it is, and it is never saved from here).
  const onId = code === "wallet_taken" && typeof res.body?.passport_id === "string" && PASSPORT_ID_RE.test(res.body.passport_id) ? res.body.passport_id : null;
  if (onId) lines.push(`That passport is ${onId} (${passportUrl(onId)}). If it is this bot's own, \`sato-agent passport issue-claim --passport ${onId}\` makes a new claim code for its owner.`);
  // Not for the join limits: they already say when to try again (minutes for the per-address quota, tomorrow for the daily cap).
  if (res.retryAfter && /^\d{1,6}$/.test(String(res.retryAfter)) && !["ip_quota", "ip_daily_quota", "daily_cap"].includes(code)) lines.push(`Try again in ${res.retryAfter} seconds or more.`);
  const steps = serverSteps(res.body);
  if (steps.length) lines.push("Next:", ...steps.map((s) => `  - ${s}`));
  lines.push(saved);
  return Object.assign(new PlainError(lines.join("\n")), { code, status: res.status });
}

// ---------------------------------------------------------------- what is saved (settings.json, mode 600)

const OWN_WALLET_NOTE = "Sato Hub's answer did not list this agent's wallet as proven on the passport, so nothing was saved (a registration file written with a wrong passport id would stay onchain).";

/** The saved join record { passport_id, slug, profile_url, name, via, joined_at }, or null. A hand-edited value that does not fit reads as none. */
export function joinedPassport(settings = loadSettings()) {
  const j = settings?.passport_join;
  if (!j || typeof j !== "object" || typeof j.passport_id !== "string" || !PASSPORT_ID_RE.test(j.passport_id)) return null;
  return {
    passport_id: j.passport_id,
    slug: typeof j.slug === "string" ? j.slug : null,
    profile_url: typeof j.profile_url === "string" ? j.profile_url : null,
    name: typeof j.name === "string" ? j.name : null,
    via: typeof j.via === "string" ? j.via : null,
    joined_at: typeof j.joined_at === "string" ? j.joined_at : null,
  };
}

/** A url Sato Hub gave, kept only when it is a plain https link (it is shown to the owner; the kit never fetches it). */
const httpsOrNull = (v) => (typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s"<>\\]+$/.test(v) && clean(v, 400) === v ? v : null);

/** What `passport status` shows, from settings.json alone. No network call. */
export function passportStatus(settings = loadSettings()) {
  const joined = joinedPassport(settings);
  const linked = savedPassport();
  const id = joined?.passport_id ?? linked;
  return {
    passport: id,
    lookup_url: id ? passportUrl(id) : null,
    joined: Boolean(joined),
    profile_url: joined?.profile_url ?? null,
    slug: joined?.slug ?? null,
    name: joined?.name ?? null,
    via: joined?.via ?? null,
    joined_at: joined?.joined_at ?? null,
    registration_link: linked,
  };
}

/** The lines `passport status` prints. */
export function passportStatusLines(s) {
  if (!s.passport) return ["No Sato Passport is saved here. `sato-agent join` makes one: it is free, and it makes this agent public on satohub.ai."];
  const lines = [`Sato Passport: ${s.passport}`, `  Page:    ${s.lookup_url}`];
  if (s.profile_url) lines.push(`  Profile: ${s.profile_url}`);
  if (s.joined) lines.push(`  Joined:  ${s.joined_at ?? "(date not saved)"}${s.via ? ` via ${s.via}` : ""}${s.name ? `, named "${s.name}"` : ""}`);
  else lines.push("  Joined:  not from here: this id was given to `register --passport`, not made by `join`.");
  if (s.registration_link && s.registration_link !== s.passport) lines.push(`  The ERC-8004 registration file links to ${s.registration_link}.`);
  return lines;
}

// ---------------------------------------------------------------- join

/** The sentence under the claim code. */
export const CLAIM_INSTRUCTION = `Give this code to the agent's owner: signed in on satohub.ai, they enter it once to link the passport. It expires in ${CLAIM_TTL_DAYS} days.`;

/** What joining does, once, in the words the owner reads under the approval and after the join. */
export const JOIN_SCOPE_NOTE = "Joining proves control of this agent's wallet key and makes its passport public on satohub.ai. It says nothing else about the agent: not its code, not who owns it.";

const eachWallet = (w) => `${w.chain === "evm" ? "EVM" : "Solana"} ${w.address}`;

/**
 * The owner's approval for a join or a new claim code: `deps.authorize(intent, card)` stops the command (exit 5, a one-time code for this
 * exact intent) until the owner has said yes, then lets it through on the re-run with --approve. Without a hook nothing is signed.
 */
async function authorize(deps, intent, card) {
  if (!deps.authorize) throw new PlainError("This needs the owner's approval; nothing was signed.");
  await deps.authorize(intent, card);
}

/** A validated `--via` (default "kit"). */
export function parseVia(raw) {
  const v = raw === undefined ? "kit" : String(raw).trim();
  if (!KIT_VIA.includes(v)) throw new PlainError(`--via must be one of ${KIT_VIA.join(" or ")} (got "${clean(raw, 40)}")`);
  return v;
}

/** A validated `--name`, exactly as given (it is signed, so it is never trimmed or fixed up), or null. */
export function parseName(raw) {
  if (raw === undefined) return null;
  const problem = nameProblem(raw);
  if (problem) throw new PlainError(`--name: ${problem}.`);
  return raw;
}

/** The success answer, checked: the id is a passport id, and every wallet this join signed is listed there as proven. */
function readJoinAnswer(res, wallets) {
  const b = res.body;
  if (!b || typeof b !== "object" || typeof b.passport_id !== "string" || !PASSPORT_ID_RE.test(b.passport_id)) {
    throw new PlainError(`Sato Hub's answer was not understood, so nothing was saved here. ${NETWORK_HINT.join}`);
  }
  const listed = Array.isArray(b.wallets) ? b.wallets : null;
  const mine = (w) => listed?.some((x) => x && typeof x.address === "string" && x.address.toLowerCase() === w.address.toLowerCase() && x.proven === true);
  if (!wallets.every(mine)) throw new PlainError(OWN_WALLET_NOTE);
  const expires = typeof b.claim?.expires_at === "string" && Number.isFinite(Date.parse(b.claim.expires_at)) ? b.claim.expires_at : null;
  // ADVISORY, never a refusal (Sato Hub retired the "declared on a legacy passport" refusal): a passport made before joins existed lists one of
  // these wallets without proof. The join went through, so the wallet is live on the NEW passport; `note` says so in Sato Hub's words and is shown
  // once. The kit does not suggest proving the wallet on the old passport (Sato Hub refuses that while this passport holds it), so the extra
  // `next` line about it is left out of what is printed.
  const legacy = Array.isArray(b.legacy_declared)
    ? b.legacy_declared.flatMap((x) =>
        x && typeof x.wallet === "string" && /^(evm|solana):\S{20,64}$/.test(x.wallet) && typeof x.passport_id === "string" && PASSPORT_ID_RE.test(x.passport_id) ? [{ wallet: x.wallet, passport_id: x.passport_id }] : [],
      )
    : [];
  const note = typeof b.note === "string" && b.note.trim() ? clean(b.note, 800) : null;
  const next = serverSteps({ next: b.next }).filter((line) => !(legacy.length && /prove_wallet/i.test(line)));
  return {
    passport_id: b.passport_id,
    slug: typeof b.slug === "string" ? clean(b.slug, 80) : null,
    name: typeof b.name === "string" ? clean(b.name, 120) : null,
    profile_url: httpsOrNull(b.profile_url),
    // No claim object (null, or missing from a malformed answer) = Sato Hub holds no code for this join: the code is then never shown.
    claim: b.claim && typeof b.claim === "object" ? { expires_at: expires } : null,
    next,
    note,
    legacy_declared: legacy,
  };
}

/**
 * `join`: sign one join message per wallet, post it, and save what comes back.
 *   name    the display name (validated, signed exactly), or undefined for a name Sato Hub makes
 *   via     "kit" or "sato-bot"
 *   noSolana  leave the Solana wallet off the passport
 *   again   join even though this bot already has a passport id saved (the new id replaces it; the old passport is not touched)
 * deps: authorize (required), fetchImpl, origin, keys (see makeSigner), now (Date), timeoutMs, randomBytes.
 * Returns { passport_id, slug, name, lookup_url, profile_url, wallets, claim_code, claim_expires_at, next, note, legacy_declared, via, replaced }. `claim_code` is
 * returned once to the caller to print: it is never written to settings.json, the ledger or any file.
 * Nothing is signed before the owner's approval, and nothing is saved unless Sato Hub accepted the join.
 */
export async function joinPassport({ name, via, noSolana = false, again = false } = {}, deps = {}) {
  const displayName = parseName(name);
  const how = parseVia(via);
  const settings = loadSettings();
  const joined = joinedPassport(settings);
  const had = joined?.passport_id ?? savedPassport();
  if (had && !again) {
    throw new PlainError(
      `This bot already has a Sato Passport saved: ${had} (${passportUrl(had)}). A wallet is on one passport, and a second join would only be refused. \`passport status\` shows it; \`passport issue-claim\` makes a new claim code for its owner. If that id is not this bot's own, \`join --again\` joins anyway and saves the new id in its place (the old passport is not changed).`,
    );
  }
  const signers = joinSigners({ noSolana, keys: deps.keys });
  const wallets = signers.map(({ chain, address }) => ({ chain, address }));
  const primary = wallets[0];
  const intent = {
    cmd: "join",
    name: displayName,
    via: how,
    primary: walletLabel(primary),
    wallets: wallets.map(walletLabel),
    again: Boolean(again),
    replaces: again && had ? had : null,
    ...hostIntent(customHost(deps)),
  };
  const card = [
    ...hostCard(customHost(deps)),
    "Join Sato Hub: this makes the agent's Sato Passport PUBLIC on satohub.ai.",
    `Wallets it lists: ${wallets.map(eachWallet).join("; ")} (the EVM wallet is the primary).`,
    `Name: ${displayName ?? "(Sato Hub makes one)"}. It says it came from: ${how}.`,
    "Each wallet signs one message (no payment, no gas). Nothing has been signed or sent.",
    JOIN_SCOPE_NOTE,
  ];
  await authorize(deps, intent, card);

  const now = deps.now ?? new Date();
  const issuedAt = issuedAtOf(now);
  const claimCode = generateClaimCode(deps.randomBytes);
  const built = await buildJoinRequest({ name: displayName, via: how, signers, claimCode, issuedAt });
  const res = await postJson(JOIN_PATH, built.body, deps, { what: NETWORK_HINT.join });
  if (res.status !== 200 && res.status !== 201) throw refusal(res);
  const ans = readJoinAnswer(res, wallets);

  // Saved only now: Sato Hub accepted the join, and its answer lists this agent's own wallets as proven.
  const joinedAt = issuedAtOf(deps.now ?? new Date());
  savePassport(ans.passport_id);
  patchSettings((s) => ({ ...s, passport_join: { passport_id: ans.passport_id, slug: ans.slug, profile_url: ans.profile_url, name: ans.name ?? displayName, via: how, joined_at: joinedAt } }));
  // The ledger holds public facts only: the id, how it came, how many wallets. Never the claim code (not even its digest).
  record({ kind: "passport", status: "joined", passport: ans.passport_id, via: how, wallets: wallets.length, ...(again && had ? { replaced: had } : {}) });
  const claimOk = ans.claim !== null;
  return {
    passport_id: ans.passport_id,
    slug: ans.slug,
    name: ans.name ?? displayName,
    lookup_url: passportUrl(ans.passport_id),
    profile_url: ans.profile_url,
    wallets,
    claim_code: claimOk ? claimCode : null,
    claim_expires_at: ans.claim?.expires_at ?? null,
    next: ans.next,
    note: ans.note,
    legacy_declared: ans.legacy_declared,
    via: how,
    replaced: again && had && had !== ans.passport_id ? had : null,
  };
}

/** The lines `join` prints. The claim code is on its own line, once; with --json the caller puts `claim_code` in its one JSON answer instead. */
export function joinLines(r) {
  const lines = [
    "Joined. This agent's Sato Passport is public now.",
    `  Passport: ${r.passport_id}`,
    `  Page:     ${r.lookup_url}`,
    ...(r.profile_url ? [`  Profile:  ${r.profile_url}`] : []),
    `  Wallets:  ${r.wallets.map((w, i) => `${eachWallet(w)}${i === 0 ? " (primary)" : ""}`).join("; ")}`,
    "  Saved on this computer; `register` links the ERC-8004 registration file to it.",
    ...(r.replaced ? [`  It replaced the saved id ${r.replaced}; that passport was not changed.`] : []),
  ];
  if (r.claim_code) {
    lines.push("", `Claim code (shown once; this computer does not keep it): ${r.claim_code}`, CLAIM_INSTRUCTION);
  } else {
    lines.push("", "Sato Hub did not record a claim code for this join. `sato-agent passport issue-claim` makes one.");
  }
  // Sato Hub's note, once, when it sent one (a passport made before joins existed lists one of these wallets without proof).
  if (r.note) lines.push("", `Note from Sato Hub: ${r.note}`);
  if (r.next.length) lines.push("", "Next (from Sato Hub):", ...r.next.map((s) => `  - ${s}`));
  lines.push("", JOIN_SCOPE_NOTE);
  return lines;
}

// ---------------------------------------------------------------- issue-claim and prove (one wallet, POST /api/passport/action)

/** The passport an action is about: `--passport <id>` when given, else the joined one, else the saved one; a PlainError when there is none. */
function passportForAction(given) {
  if (given !== undefined) {
    const v = String(given).trim();
    if (!PASSPORT_ID_RE.test(v)) throw new PlainError(`--passport must be a Sato Passport id like sato:agt:exmpexmpexmp (got "${clean(given, 40)}")`);
    return v;
  }
  const id = joinedPassport()?.passport_id ?? savedPassport();
  if (!id) throw new PlainError("This bot has no Sato Passport saved. `sato-agent join` makes one (or give --passport <id>).");
  return id;
}

/** `--chain base|solana` for issue-claim and prove: which of the bot's keys signs (default: its EVM key). */
function actionSigner(chain, keys) {
  const c = chain === undefined ? "base" : String(chain).toLowerCase();
  if (c !== "base" && c !== "solana") throw new PlainError("--chain must be base (this agent's EVM key) or solana here");
  if (c === "solana" && !hasSolanaKey(keys)) throw new PlainError("This bot has no Solana key to sign with.");
  return signerFor(c, keys);
}

/**
 * `passport issue-claim`: a new claim code for the passport, signed `issue_claim` by one of this bot's wallets. Earlier unused codes stop
 * working. The owner's approval first (any approval mode). Returns { passport_id, claim_code, claim_expires_at, wallet }. The code is
 * returned once to be printed and is never saved.
 * deps: authorize (required), fetchImpl, origin, keys, now, timeoutMs, randomBytes.
 */
export async function issueClaim({ passport, chain } = {}, deps = {}) {
  const passportId = passportForAction(passport);
  const signer = actionSigner(chain, deps.keys);
  const intent = { cmd: "passport issue-claim", passport: passportId, wallet: walletLabel(signer), ...hostIntent(customHost(deps)) };
  const card = [
    ...hostCard(customHost(deps)),
    `A new owner claim code for ${passportId}: the earlier unused codes stop working.`,
    `${eachWallet(signer)} signs one message (no payment, no gas). Nothing has been signed or sent.`,
    "The code lets whoever holds it link the passport to their account on satohub.ai, once. Give it only to the agent's owner.",
  ];
  await authorize(deps, intent, card);
  const claimCode = generateClaimCode(deps.randomBytes);
  const body = await buildActionRequest({ action: "issue_claim", passportId, signer, claimSha256: claimCodeDigest(claimCode), issuedAt: issuedAtOf(deps.now ?? new Date()) });
  const res = await postJson(ACTION_PATH, body, deps, { what: NETWORK_HINT.action });
  if (res.status !== 200 && res.status !== 201) throw refusal(res, { saved: "No new code was made." });
  if (res.body?.ok === false) throw refusal({ ...res, status: 400 }, { saved: "No new code was made." });
  // A 200 is a recorded code: Sato Hub answers { ok, action, passport_id, claim_expires_at, ... }.
  const expires = typeof res.body?.claim_expires_at === "string" && Number.isFinite(Date.parse(res.body.claim_expires_at)) ? res.body.claim_expires_at : null;
  record({ kind: "passport", status: "claim_issued", passport: passportId, wallet_chain: signer.chain });
  return { passport_id: passportId, wallet: walletLabel(signer), claim_code: claimCode, claim_expires_at: expires };
}

/** The lines `passport issue-claim` prints. */
export function issueClaimLines(r) {
  return [`New claim code for ${r.passport_id} (shown once; this computer does not keep it): ${r.claim_code}`, CLAIM_INSTRUCTION, "Earlier unused codes for this passport stop working."];
}

/**
 * `passport prove`: for a passport made before joins existed, whose wallet was declared and never proven: this bot's wallet signs
 * `prove_wallet` so it is proven on it. Sato Hub accepts it only when that is the passport's listed wallet. The owner's approval first (any
 * approval mode). The id is saved only once Sato Hub accepted it. Returns { passport_id, wallet }.
 * deps: authorize (required), fetchImpl, origin, keys, now, timeoutMs.
 */
export async function proveWallet({ passport, chain } = {}, deps = {}) {
  const passportId = passportForAction(passport);
  const signer = actionSigner(chain, deps.keys);
  const intent = { cmd: "passport prove", passport: passportId, wallet: walletLabel(signer), ...hostIntent(customHost(deps)) };
  const card = [
    ...hostCard(customHost(deps)),
    `Prove this agent's wallet on ${passportId}, publicly: it makes the wallet's control of the passport show on satohub.ai, and any wallet on a passport can manage it.`,
    `${eachWallet(signer)} signs one message (no payment, no gas). Nothing has been signed or sent.`,
    JOIN_SCOPE_NOTE,
  ];
  await authorize(deps, intent, card);
  const body = await buildActionRequest({ action: "prove_wallet", passportId, signer, issuedAt: issuedAtOf(deps.now ?? new Date()) });
  const res = await postJson(ACTION_PATH, body, deps, { what: NETWORK_HINT.action });
  if (res.status !== 200 && res.status !== 201) throw refusal(res);
  if (res.body?.ok === false) throw refusal({ ...res, status: 400 });
  savePassport(passportId);
  record({ kind: "passport", status: "wallet_proven", passport: passportId, wallet_chain: signer.chain });
  return { passport_id: passportId, wallet: walletLabel(signer) };
}
