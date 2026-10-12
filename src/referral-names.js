// Referral names (v0.3.2). A bot that is asked to share itself gets a NAME from Sato Hub (sunny-otter); bots copied from its
// share are referred by that name, and Sato Hub pays the name's owner 30% of its swap fee on their swaps, weekly in USDC.
// The contract is frozen in the Sato Hub app (REFERRAL-NAMES-CONTRACT.md); this file is the kit's side of it:
//
//   - the byte-exact message the bot signs (create / set_payout), and the signature with this bot's own wallet key;
//   - POST <origin>/api/referral/name to create the name or change where payouts go;
//   - GET  <origin>/api/referral/name/<name> to check a name before it is saved as this bot's referrer;
//   - the bot's own name, payout and offer state in settings.json (mode 600);
//   - the three share texts and the one-time offer.
//
// What it never does: spend, post, DM or share anything, or send a key anywhere. The signature proves the wallet; the key
// stays here. Swap-time behaviour (the referrer on a swap, the settlement report) stays in src/swap/referral.js.

import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { MCP_URL } from "./satohub.js";
import { USER_AGENT } from "./version.js";
import { clean } from "./text.js";
import { PlainError } from "./errors.js";
import { record } from "./ledger.js";
import { evmAccount, solanaSecret } from "./wallet.js";
import { chainKeys, isEvm, isKnownChain, orList, pipeList } from "./chains.js";
import { isReferralName, loadSettings, normalizeAddress, normalizeReferralName, patchSettings, shortReferrer } from "./settings.js";

/** The referrer's share of Sato Hub's swap fee, in percent. The ONE place the kit says it (BOT.md repeats it in words). */
export const REFERRAL_SHARE_PERCENT = 30;

export const NAME_PATH = "/api/referral/name";
export const NAME_TIMEOUT_MS = 10_000;
export const LOOKUP_TIMEOUT_MS = 8_000;

const b58 = getBase58Decoder(); // bytes -> base58 string
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ---------------------------------------------------------------- the signed message (contract section 2)

/**
 * The message the bot signs, byte for byte: UTF-8, lines joined by "\n", no trailing newline. `name` is "-" for create.
 * Addresses are as normalized by `normalizeAddress` (Base lower case, Solana exact case); `issuedAt` an ISO 8601 UTC string
 * with milliseconds (`new Date().toISOString()`).
 */
export function referralMessage({ action, name, signer, payout, issuedAt }) {
  if (action !== "create" && action !== "set_payout") throw new Error(`unknown referral action "${action}"`);
  return ["Sato Hub referral name", `action: ${action}`, `name: ${action === "create" ? "-" : name}`, `signer: ${signer}`, `payout: ${payout}`, `issued_at: ${issuedAt}`].join("\n");
}

/** EIP-191 personal_sign of `message` with a Base private key (0x + 64 hex): the signature as 0x + 65 bytes hex. */
export async function signBase(message, privateKey) {
  return privateKeyToAccount(privateKey).signMessage({ message });
}

/** The Base signer address (lower case) for a private key. */
export const baseSignerAddress = (privateKey) => privateKeyToAccount(privateKey).address.toLowerCase();

const solanaPrivateKey = (secret) => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret).subarray(0, 32)]), format: "der", type: "pkcs8" });

/** The Solana address (base58) of a keypair given as a 32-byte seed or the wallet's 64-byte seed || public key. */
export const solanaSignerAddress = (secret) => b58.decode(Buffer.from(createPublicKey(solanaPrivateKey(secret)).export({ format: "jwk" }).x, "base64url"));

/** ed25519 signature over the UTF-8 bytes of `message` with a Solana key (32-byte seed, or 64-byte seed || public key): base58. */
export function signSolana(message, secret) {
  return b58.decode(edSign(null, Buffer.from(message, "utf8"), solanaPrivateKey(secret)));
}

/**
 * This bot's signer for a chain: { chain, address, sign(message) }. By default the wallet's own key; `keys` ({ evmKey,
 * solanaSecret }) swaps in another key (the tests sign the contract's vectors this way). The key is never returned.
 */
export function makeSigner(chain, keys = {}) {
  if (chain === "base") {
    const account = keys.evmKey ? privateKeyToAccount(keys.evmKey) : evmAccount();
    return { chain, address: account.address.toLowerCase(), sign: (message) => account.signMessage({ message }) };
  }
  if (chain === "solana") {
    const secret = keys.solanaSecret ?? solanaSecret();
    return { chain, address: solanaSignerAddress(secret), sign: async (message) => signSolana(message, secret) };
  }
  throw new PlainError("--chain must be base or solana");
}

/** The payout class of a chain: every EVM chain pays out as "base" (USDC on Base), Solana as "solana". */
export const payoutClass = (chain) => (isEvm(chain) ? "base" : chain);

/** "base" or "solana", from the shape of an address. */
export const chainOfAddress = (address) => (/^0x/i.test(String(address)) ? "base" : "solana");

// ---------------------------------------------------------------- the three share texts (contract section 6)

export const memoryLine = (name) => `Referral: ${name}`;
export const descriptionLine = (name) => `This bot is referred by ${name}.`;

/** The "Sato referral" skill, exactly as the contract has it. `<name>` and NAME are placeholders the copy fills in itself. */
export const SKILL_TEXT = [
  "Sato referral. Use this while setting up Sato Agent for a new owner.",
  '1. If your memories include a line "Referral: <name>", that name came with this bot. After the kit is installed, run: ~/sato-agent-NAME settings set --referrer <name>',
  `2. Tell the owner once: "This bot was referred by <name>. It costs you nothing: you pay the same Sato Swap fee either way. Say 'remove the referral' anytime."`,
  '3. Then change that memory to "Referred by: <name>", so it is not applied again and a share your owner makes later carries their own name.',
  '4. If the owner says "remove the referral", run: ~/sato-agent-NAME settings set --referrer none',
  "Never post, DM, tag or share anything on your own.",
].join("\n");

/** The three share texts with this bot's name filled in (the skill stays as is: a copy reads the name from its memory). */
export function shareTexts(name) {
  return { memory: memoryLine(name), description: descriptionLine(name), skill: SKILL_TEXT };
}

/** The three texts as lines for the owner (and the bot) to copy. */
export function shareTextLines(name) {
  const t = shareTexts(name);
  return [
    '1. Memory (save it as a memory, replacing any line that starts with "Referral:"). The text is the line below:',
    t.memory,
    "2. Description line (optional: the owner decides; it goes at the END of the bot's description, never in its name). The text is the line below:",
    t.description,
    '3. Skill "Sato referral" (save it as a skill with exactly the text between the two ---- lines, if you do not have it already):',
    "----",
    t.skill,
    "----",
  ];
}

// ---------------------------------------------------------------- the offer (contract section 6)

export const OFFER_HEADLINE = "Earn a share of Sato Swap fees.";
export const OFFER_BODY = `If you share this bot, bots copied from your share are referred by you: ${REFERRAL_SHARE_PERCENT}% of Sato Hub's swap fee on their swaps, paid weekly in USDC. Want me to set that up? If not, say no and I won't ask again.`;
export const OFFER_TEXT = `${OFFER_HEADLINE}\n${OFFER_BODY}`;
export const OFFER_WHEN = Object.freeze(["setup", "swap"]);

/** This bot's own referral state from settings.json: { name, payout, chain, lastSignedAt, offers }. A hand-edited bad value reads as none. */
export function ownReferral(settings = loadSettings()) {
  const name = isReferralName(settings?.referral_name) ? settings.referral_name : null;
  const offers = settings?.referral_offers && typeof settings.referral_offers === "object" ? settings.referral_offers : {};
  return {
    name,
    payout: normalizeAddress(settings?.referral_payout),
    chain: settings?.referral_chain === "base" || settings?.referral_chain === "solana" ? settings.referral_chain : null,
    lastSignedAt: typeof settings?.referral_last_signed_at === "string" ? settings.referral_last_signed_at : null,
    payoutChangedAt: typeof settings?.referral_payout_changed_at === "string" ? settings.referral_payout_changed_at : null,
    offers: { setup_at: offers.setup_at ?? null, swap_at: offers.swap_at ?? null, declined_at: offers.declined_at ?? null },
  };
}

/** Would the `when` offer print now? No name of its own, not declined, not already shown for this `when`. */
export function offerEligible(when, settings = loadSettings()) {
  if (!OFFER_WHEN.includes(when)) return false;
  const own = ownReferral(settings);
  return !own.name && !own.offers.declined_at && !own.offers[`${when}_at`];
}

/**
 * The offer for `when`, or null when this bot is not eligible. Eligible: it prints the text AND records `referral_offers.<when>_at`,
 * so it is shown once per `when`, ever. Throws only when settings.json cannot be written (the caller decides what that means).
 */
export function takeOffer(when, now = new Date()) {
  if (!offerEligible(when)) return null;
  patchSettings((s) => ({ ...s, referral_offers: { ...(typeof s.referral_offers === "object" && s.referral_offers ? s.referral_offers : {}), [`${when}_at`]: now.toISOString() } }));
  return OFFER_TEXT;
}

/** The offer after a confirmed swap: like `takeOffer("swap")`, but it can never throw (a swap's result is never changed by it). */
export function swapOffer(deps = {}) {
  try {
    return takeOffer("swap", deps.now);
  } catch {
    return null;
  }
}

/** The owner said no: no offer prints again. Returns true when it was recorded for the first time. */
export function declineOffer(now = new Date()) {
  if (ownReferral().offers.declined_at) return false;
  patchSettings((s) => ({ ...s, referral_offers: { ...(typeof s.referral_offers === "object" && s.referral_offers ? s.referral_offers : {}), declined_at: now.toISOString() } }));
  return true;
}

// ---------------------------------------------------------------- talking to Sato Hub

const originOf = (deps) => deps.origin ?? new URL(MCP_URL).origin;
const headers = () => ({ "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT });

/** Sato Hub's body as a plain object, or null. */
const parse = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Sato Hub's refusal as one sentence: its message and short code (both cleaned: they are outside text). */
function refusalSentence(status, body) {
  const code = typeof body?.error === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(body.error) ? body.error : null;
  const message = typeof body?.message === "string" && body.message.trim() ? clean(body.message, 300) : null;
  if (!code && !message) return `Sato Hub answered HTTP ${status}.`;
  return `Sato Hub: ${message ?? code}${message && code ? ` (${code})` : ""}`;
}

/**
 * Check a referral name with Sato Hub before it is saved as this bot's referrer: GET <origin>/api/referral/name/<name>.
 * 200 -> { ok: true }. 404 -> PlainError "No referral name <name> at Sato Hub.". Anything else (no answer, a timeout, another
 * status) -> PlainError "Couldn't reach Sato Hub to check the name; try again.". One attempt, a short timeout, nothing sent
 * but the name. deps: fetchImpl, origin, timeoutMs.
 */
export async function lookupReferralName(name, deps = {}) {
  const unreachable = new PlainError("Couldn't reach Sato Hub to check the name; try again.");
  let res;
  let text;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${originOf(deps)}${NAME_PATH}/${encodeURIComponent(name)}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(deps.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw unreachable;
  }
  if (res.status === 404) throw new PlainError(`No referral name ${name} at Sato Hub.`);
  const body = parse(text);
  if (res.status === 200 && body?.ok === true && body.active !== false) return { ok: true };
  if (res.status === 200 && body?.active === false) throw new PlainError(`No referral name ${name} at Sato Hub.`);
  throw unreachable;
}

/**
 * POST a signed request. Returns Sato Hub's JSON body for a 200/201 { ok: true, name }; throws PlainError with Sato Hub's own
 * message for a refusal, and for no answer. Nothing is saved by this function.
 */
async function postSigned(payload, deps) {
  let res;
  let text;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${originOf(deps)}${NAME_PATH}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deps.timeoutMs ?? NAME_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new PlainError("Couldn't reach Sato Hub; nothing was saved. Try again.");
  }
  const body = parse(text);
  if ((res.status === 200 || res.status === 201) && body?.ok === true) return { status: res.status, body };
  if (res.status === 200 || res.status === 201) throw new PlainError("Sato Hub's answer was not understood; nothing was saved. Try again.");
  throw new PlainError(`${refusalSentence(res.status, body)}\nNothing was saved.`);
}

// ---------------------------------------------------------------- create / set-payout

/**
 * The owner's approval for a payout address: `deps.authorize(intent, ledgerIntent)` stops the command (exit 5, a one-time code for
 * this exact intent) until the owner has said yes, then lets it through on the re-run with --approve. The intent names the full
 * address so the owner can check it; the ledger line shows it short. Without a hook nothing is signed.
 */
async function authorizePayout(deps, intent, ledgerIntent) {
  if (!deps.authorize) throw new PlainError("Changing where payouts go needs the owner's approval; nothing was signed.");
  await deps.authorize(intent, ledgerIntent);
}

/**
 * `referral create`: sign a `create` message with this bot's key on `chain`, ask Sato Hub for a name, save it.
 * Returns { name, created, chain, payout, payout_chain, payout_known, signed_at }. Nothing is saved unless Sato Hub says 200/201.
 * A bot has ONE name, signed with one chain's wallet: `create` on the other chain is refused. A `--payout` that is not the signing
 * wallet's own address needs the owner's approval first (`deps.authorize(intent, ledgerIntent)`, which throws until it is given).
 * deps: fetchImpl, origin, keys (see makeSigner), now (Date), timeoutMs, authorize.
 */
export async function createReferralName({ chain: requested, payout }, deps = {}) {
  if (!isKnownChain(requested)) throw new PlainError(`referral create needs --chain ${orList(chainKeys())}.`);
  // Every EVM chain signs with the same key, so the name, the signing wallet and the payout class are "base" whichever EVM chain
  // the owner names (Sato Hub's names registry keeps `base | solana`: the class, not the chain).
  const chain = payoutClass(requested);
  const had = ownReferral();
  if (had.name && had.chain && had.chain !== chain) {
    throw new PlainError(`This bot already has the referral name ${had.name} (signed with its ${chainLabel(had.chain)} wallet). See \`referral show\`.`);
  }
  const signer = makeSigner(chain, deps.keys);
  let payoutAddress = signer.address;
  if (payout !== undefined) {
    payoutAddress = normalizeAddress(payout);
    if (!payoutAddress) throw new PlainError("--payout must be a Base address (0x followed by 40 hex characters) or a Solana address.");
    // Another payout address than this wallet's own is the owner's decision, whatever the approval mode (contract section 6).
    if (payoutAddress !== signer.address) await authorizePayout(deps, { cmd: "referral create", chain, payout: payoutAddress }, { cmd: "referral create", chain, payout: shortReferrer(payoutAddress) });
  }
  const issuedAt = (deps.now ?? new Date()).toISOString();
  const message = referralMessage({ action: "create", signer: signer.address, payout: payoutAddress, issuedAt });
  const signature = await signer.sign(message);
  const { status, body } = await postSigned({ action: "create", signer: signer.address, payout: payoutAddress, issued_at: issuedAt, signature }, deps);
  const name = normalizeReferralName(body.name);
  if (!name) throw new PlainError("Sato Hub's answer did not carry a usable name; nothing was saved. Try again.");
  const created = body.created === true || status === 201;
  const before = ownReferral();
  // A repeat create does not change the payout at Sato Hub (contract section 3): keep what this computer already knew about it.
  const payoutKept = created ? payoutAddress : before.name === name ? before.payout : null;
  const payoutChain = body.payout_chain === "base" || body.payout_chain === "solana" ? body.payout_chain : payoutKept ? chainOfAddress(payoutKept) : null;
  patchSettings((s) => ({ ...s, referral_name: name, referral_payout: payoutKept, referral_chain: chain, referral_last_signed_at: issuedAt }));
  // The ledger holds the payout only in short form (0x1234…abcd).
  record({ kind: "settings", status: "referral_name_created", name, created, signer_chain: chain, payout_chain: payoutChain, payout: payoutKept ? shortReferrer(payoutKept) : null });
  return { name, created, chain, payout: payoutKept, payout_chain: payoutChain, payout_known: Boolean(payoutKept), signed_at: issuedAt };
}

/**
 * `referral set-payout <address>`: sign `set_payout` for the saved name with the saved chain's key. Returns
 * { name, changed, payout, payout_chain }. Nothing is saved unless Sato Hub says 200. ALWAYS needs the owner's approval first
 * (`deps.authorize`), whatever the approval mode: a payout change redirects every accrual not yet batched.
 */
export async function setReferralPayout(address, deps = {}) {
  const own = ownReferral();
  if (!own.name || !own.chain) throw new PlainError("Run referral create first.");
  const payout = normalizeAddress(address);
  if (!payout) throw new PlainError("referral set-payout needs a Base address (0x followed by 40 hex characters) or a Solana address.");
  await authorizePayout(deps, { cmd: "referral set-payout", name: own.name, chain: own.chain, payout }, { cmd: "referral set-payout", name: own.name, chain: own.chain, payout: shortReferrer(payout) });
  const signer = makeSigner(own.chain, deps.keys);
  // issued_at must be later than the last signed change: never earlier than one millisecond after the saved one.
  const now = (deps.now ?? new Date()).getTime();
  const last = own.lastSignedAt ? Date.parse(own.lastSignedAt) : NaN;
  const issuedAt = new Date(Number.isFinite(last) && now <= last ? last + 1 : now).toISOString();
  const message = referralMessage({ action: "set_payout", name: own.name, signer: signer.address, payout, issuedAt });
  const signature = await signer.sign(message);
  const { body } = await postSigned({ action: "set_payout", name: own.name, signer: signer.address, payout, issued_at: issuedAt, signature }, deps);
  if (normalizeReferralName(body.name) !== own.name) throw new PlainError("Sato Hub's answer named a different referral name; nothing was saved. Try again.");
  const payoutChain = body.payout_chain === "base" || body.payout_chain === "solana" ? body.payout_chain : chainOfAddress(payout);
  const previous = own.payout;
  patchSettings((s) => ({ ...s, referral_payout: payout, referral_last_signed_at: issuedAt, referral_payout_changed_at: issuedAt }));
  const changed = body.changed !== false;
  // The ledger holds the payout only in short form (0x1234…abcd).
  if (changed) record({ kind: "settings", status: "referral_payout_changed", name: own.name, signer_chain: own.chain, payout_chain: payoutChain, from: previous ? shortReferrer(previous) : null, to: shortReferrer(payout) });
  return { name: own.name, changed, payout, payout_chain: payoutChain };
}

// ---------------------------------------------------------------- show

const chainLabel = (c) => (c === "base" ? "Base" : c === "solana" ? "Solana" : "unknown chain");

/** `referral show`: what the owner sees. `referredBy` is the saved referrer (a name or an address), or null. */
export function referralShow(referredBy) {
  const own = ownReferral();
  const offers = own.offers;
  const offer = own.name ? "not needed: this bot has its own referral name" : offers.declined_at ? `declined (${offers.declined_at.slice(0, 10)}); it will not be asked again` : OFFER_WHEN.filter((w) => offers[`${w}_at`]).length ? `shown at ${OFFER_WHEN.filter((w) => offers[`${w}_at`]).join(" and ")}` : "not shown yet";
  const payoutChain = own.payout ? chainOfAddress(own.payout) : null;
  const data = {
    name: own.name,
    payout: own.payout ? shortReferrer(own.payout) : null,
    payout_chain: payoutChain,
    signing_chain: own.chain,
    payout_changed_at: own.payoutChangedAt,
    referred_by: referredBy ? (isReferralName(referredBy) ? referredBy : shortReferrer(referredBy)) : null,
    offer: { state: own.name ? "has_name" : offers.declined_at ? "declined" : "open", setup_at: offers.setup_at, swap_at: offers.swap_at, declined_at: offers.declined_at },
  };
  const lines = [
    own.name
      ? `This bot's referral name: ${own.name}${own.payout ? `\nPayouts go to ${shortReferrer(own.payout)} on ${chainLabel(payoutChain)} (signed with this bot's ${chainLabel(own.chain)} wallet).` : `\nPayout: kept at Sato Hub (signed with this bot's ${chainLabel(own.chain)} wallet). \`referral set-payout <address>\` sets it.`}`
      : `This bot has no referral name of its own. \`referral create --chain ${pipeList(chainKeys())}\` makes one.`,
    ...(own.name && own.payoutChangedAt ? [`Last payout change: ${own.payoutChangedAt}`] : []),
    `Referred by: ${data.referred_by ?? "nobody (no referral set)"}`,
    `Offer: ${offer}`,
  ];
  return { text: lines.join("\n"), data };
}
