// Swaps on Solana: USDC <-> SOL through Jupiter, built here, checked here,
// signed here.
//
// Sato Hub does not hand back a Solana transaction (its Jupiter adapter never
// calls /swap), so this kit builds one through Jupiter's public API and treats
// what comes back as untrusted bytes:
//
//   plan     quote + build (Jupiter), with the Sato fee disclosed in the plan
//   verify   decode the transaction, resolve its address lookup tables from the
//            chain, check every instruction (Jupiter's own route instruction
//            included: the minimum output, slippage, fee and accounts are read out
//            of its data), then simulate it, compare the agent's balances before and
//            after, and read the agent's token accounts back. Nothing passes on
//            Jupiter's say-so.
//   execute  the same order of operations as `sendUsdc` in ../solana.js: reserve
//            against the limits, sign, record the signature, broadcast, poll.
//            A transaction that may have gone out is never re-signed or retried.
//
// Scope: USDC <-> SOL (native SOL; Jupiter wraps and unwraps it), and any SPL or
// Token-2022 mint against USDC or SOL. One side is always USDC or SOL (token <->
// token is a later phase) and Sato Hub's fee is always taken on that side, never in
// the long-tail token. A long-tail mint is read from the chain (never from a
// resolver): its token program, decimals, authorities and Token-2022 extensions, and
// a mint that can move, freeze or strand the agent's tokens is refused.
// Every network dependency is injectable, so the tests run offline against
// recorded mainnet responses.

import {
  address,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isAddress,
  isSignerRole,
  signTransaction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { loadPolicy } from "../policy.js";
import { record, release, reserve } from "../ledger.js";
import { Pending, Refused, Rejected } from "../errors.js";
import { usdcUnits } from "../amount.js";
import { loadWallet, solanaSecret } from "../wallet.js";
import { USER_AGENT } from "../version.js";
import { TOKEN_2022_PROGRAM, USDC_MINT, explorer, rpc as defaultRpc } from "../solana.js";

/** Same 20 s guard as ../solana.js, but the timer is cleared once the call settles (a swap makes many calls). */
const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

// ---------------------------------------------------------------- constants

/** Wrapped SOL. Native SOL is wrapped and unwrapped by Jupiter (`wrapAndUnwrapSol`). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Jupiter's public Swap API. Keyless is ~0.5 requests per second; lite-api.jup.ag is being phased out. */
export const JUPITER_API = "https://api.jup.ag/swap/v1";

// Sato's Jupiter referral TOKEN accounts (not the referral account itself): Jupiter
// pays the platform fee into the one whose mint is the swap's input mint.
//   seeds   ["referral_ata", referral_account, mint]
//   program REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3
//   referral account GwRkq9EBWwcLNbFzYYGSKkgoBYo4grLvCV67dHoEZ4ZB
// Sources: Sato Hub app `lib/route/jupiterReferral.ts` (derivation) and
// `docs/REVENUE-SETUP.md:42` (USDC = FMEX...4LGo, "confirmed on mainnet"). The
// wSOL address was derived with exactly that rule on 2026-10-09 and read back from
// mainnet: an initialised SPL token account, mint wSOL (test/swap-solana.test.js
// re-derives both offline). A fee account is never taken from a response.
export const SATO_REFERRAL_ACCOUNT = "GwRkq9EBWwcLNbFzYYGSKkgoBYo4grLvCV67dHoEZ4ZB";
export const SATO_FEE_ACCOUNTS = Object.freeze({
  [USDC_MINT]: "FMEXEnUt2fxKkZewdWq5PKebLw4vs1ddyayJjKap4LGo",
  [WSOL_MINT]: "HnyyFHhp3LQ6VfRn1AhPHSwboYYQa1HT7REaMfzsA8gx",
});
/**
 * The kit refuses a platform fee above this, whatever a response says. Sato's
 * published same-chain rate is 3 bps stable-to-stable and 15 bps with a volatile
 * leg (USDC <-> SOL is volatile); 25 bps is cross-chain only. Same ceiling as Base.
 */
export const FEE_BPS_MAX = 15;

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Top-level programs a swap transaction may call. Sources: Jupiter v6 id and the
 * rest from SWAP-CONTRACT section 3.5 (Jupiter docs and mainnet checks), and the
 * Token-2022 id from @solana-program/token-2022 (the older id in v0.1.0 was wrong).
 * There is NO Referral program here on purpose: the fee is a Jupiter-internal
 * transfer, so a top-level call to it is refused. CPI programs (the AMMs) are not
 * visible statically; the simulation covers what they do to the agent's balances.
 */
export const SWAP_PROGRAM_ALLOWLIST = Object.freeze({
  [JUPITER_PROGRAM]: "Jupiter v6",
  [TOKEN_PROGRAM_ADDRESS]: "Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [ASSOCIATED_TOKEN_PROGRAM]: "Associated Token",
  [SYSTEM_PROGRAM]: "System",
  [COMPUTE_BUDGET_PROGRAM]: "ComputeBudget",
});

/**
 * The most the priority fee may cost: 100,000 lamports (0.0001 SOL, about a cent
 * and about 20x the 5,000-lamport base fee). Enough for Jupiter's "high" level to
 * land in normal conditions, small enough that a bad response cannot make a swap
 * expensive. Passed to Jupiter as `maxLamports` AND re-checked on the decoded
 * transaction, because Jupiter's reply is not trusted.
 */
export const PRIORITY_MAX_LAMPORTS = 100_000;
const BASE_FEE_LAMPORTS = 5_000n;
/** Rent of one 165-byte token account. A swap into USDC may create the agent's USDC account. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
/**
 * Rent-exempt minimum = (128 + account bytes) x 3,480 lamports per byte-year x 2 years. That was the rate until 2026;
 * mainnet now charges 2,540 per byte-year (a 182-byte Token-2022 account held 1,574,800 lamports on 2026-10-09), so this
 * is a ceiling that real accounts sit under. If the rate ever rose, the check would refuse rather than pay it.
 */
const RENT_LAMPORTS_PER_BYTE_YEAR = 3_480n;
/** A new account for the long-tail token holds at most the rent-exempt minimum for this many bytes (a Token-2022 account with extensions is a little over 165). */
const MAX_TAIL_ACCOUNT_BYTES = 512n;
/**
 * Everything beyond `amount_in` that a swap may take from the agent's SOL: the
 * network fee (base + priority cap) plus rent for up to two new token accounts.
 * Documented cap for the SOL-input outflow check.
 */
export const SOL_OVERHEAD_CAP_LAMPORTS = BASE_FEE_LAMPORTS + BigInt(PRIORITY_MAX_LAMPORTS) + 2n * TOKEN_ACCOUNT_RENT;

/**
 * A built transaction older than this is rebuilt, never signed: its blockhash is on a
 * clock (about 60-90 s). Right before signing the RPC is also asked whether the
 * transaction's own blockhash is still valid (`isBlockhashValid`); Jupiter's
 * `lastValidBlockHeight` field is never relied on.
 */
export const PLAN_MAX_AGE_MS = 25_000;
export const SLIPPAGE_BPS_DEFAULT = 50;
export const SLIPPAGE_BPS_MAX = 500;
const HTTP_TIMEOUT_MS = 20_000;
const JUPITER_MIN_GAP_MS = 2_100; // keyless is 0.5 RPS

const SYMBOLS = {
  USDC: { symbol: "USDC", mint: USDC_MINT, decimals: 6 },
  SOL: { symbol: "SOL", mint: WSOL_MINT, decimals: 9 },
};
const MINT_SYMBOL = { [USDC_MINT]: "USDC", [WSOL_MINT]: "SOL" };

/** A plan whose blockhash is too old (or about to be) to sign. Nothing was reserved or signed. */
export class PlanStale extends Error {}

// ---------------------------------------------------------------- small helpers

const big = (x) => BigInt(typeof x === "number" ? Math.trunc(x) : (x ?? 0));
const jsonSafe = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const refuse = (rule, message) => ({ rule, message });

/** A plain decimal SOL amount, at most 9 places, positive; never rounded. */
export function solLamports(amount) {
  const s = String(amount);
  const [whole, frac = ""] = s.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || s.endsWith(".") || frac.length > 9) {
    throw new Error(`not a SOL amount: "${amount}" (a plain number with at most 9 decimals, like 0.05)`);
  }
  const units = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
  if (units <= 0n) throw new Error(`not a positive SOL amount: "${amount}"`);
  return units;
}

export function formatUnits(units, decimals) {
  const u = big(units);
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${u / base}${frac ? "." + frac : ""}`;
}

/** A plain decimal amount of a token with `decimals` places, positive, at most a u64; never rounded. */
export function tokenUnits(amount, decimals, label = "token") {
  const s = String(amount);
  const [whole, frac = ""] = s.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || s.endsWith(".") || frac.length > decimals) {
    throw new Error(`not a ${label} amount: "${amount}" (a plain number with at most ${decimals} decimals)`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error(`not a positive ${label} amount: "${amount}"`);
  if (units >= 2n ** 64n) throw new Error(`${label} amount "${amount}" is too large to count exactly`);
  return units;
}

const shortMint = (m) => `${String(m).slice(0, 4)}...${String(m).slice(-4)}`;

// ---------------------------------------------------------------- tokens: any SPL or Token-2022 mint
//
// A mint other than USDC and SOL is read from the chain, never from a resolver or from
// anything a response says: the program that owns it (Token or Token-2022), its
// decimals, its mint and freeze authority and, for Token-2022, its extensions. What the
// kit refuses is mechanical: an extension that lets someone else move or freeze the
// agent's tokens, or that stops them being sold. What it only reports (freeze authority,
// mint authority, a transfer fee, metadata) is for the owner to weigh, in plain words.
//
// Layouts: spl-token `Mint` (82 bytes: mint_authority COption<Pubkey> 0..36, supply u64
// 36, decimals u8 44, is_initialized u8 45, freeze_authority COption<Pubkey> 46..82).
// Token-2022 pads to 165, then one account-type byte (1 = Mint) and a TLV list of
// { type u16, length u16, data }. Extension numbers and sizes are spl-token-2022's
// ExtensionType, cross-checked against the lengths of real mints on 2026-10-09.

const TOKEN_2022_EXTENSIONS = Object.freeze({
  1: "TransferFeeConfig", 2: "TransferFeeAmount", 3: "MintCloseAuthority", 4: "ConfidentialTransferMint", 5: "ConfidentialTransferAccount",
  6: "DefaultAccountState", 7: "ImmutableOwner", 8: "MemoTransfer", 9: "NonTransferable", 10: "InterestBearingConfig", 11: "CpiGuard",
  12: "PermanentDelegate", 13: "NonTransferableAccount", 14: "TransferHook", 15: "TransferHookAccount", 16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount", 18: "MetadataPointer", 19: "TokenMetadata", 20: "GroupPointer", 21: "TokenGroup", 22: "GroupMemberPointer",
  23: "TokenGroupMember", 24: "ConfidentialMintBurn", 25: "ScaledUiAmountConfig", 26: "PausableConfig", 27: "PausableAccount",
});
/** Fixed data sizes of the mint extensions the kit reads (TokenMetadata is variable). A known extension of another size is unreadable. */
const EXTENSION_SIZE = { TransferFeeConfig: 108, MintCloseAuthority: 32, ConfidentialTransferMint: 65, DefaultAccountState: 1, NonTransferable: 0, InterestBearingConfig: 52, PermanentDelegate: 32, TransferHook: 64, ConfidentialTransferFeeConfig: 129, MetadataPointer: 64, GroupPointer: 64, TokenGroup: 80, GroupMemberPointer: 64, TokenGroupMember: 72, ConfidentialMintBurn: 196, ScaledUiAmountConfig: 56, PausableConfig: 33 };

/**
 * What the kit does with each Token-2022 mint extension. `refuse`: the swap is not built,
 * with the reason shown to the owner. `report`: allowed, and told to the owner.
 * An extension this table does not know is refused (a newer one could do anything).
 */
export const TOKEN_2022_EXTENSION_POLICY = Object.freeze({
  refuse: Object.freeze({
    PermanentDelegate: "a permanent delegate can move or burn anyone's tokens of this mint, the agent's included",
    TransferHook: "a transfer hook runs another program on every transfer of this mint, which can block or change a sale",
    NonTransferable: "this mint cannot be transferred, so it cannot be sold or swapped",
    ConfidentialTransferMint: "confidential transfers are enabled on this mint, and the kit cannot tell that a plain sale will work",
    ConfidentialTransferFeeConfig: "confidential transfers with a fee are enabled on this mint, and the kit cannot tell that a plain sale will work",
    ConfidentialMintBurn: "this mint hides its supply changes behind confidential mint and burn, which this kit does not read",
  }),
  report: Object.freeze(["TransferFeeConfig", "MintCloseAuthority", "InterestBearingConfig", "ScaledUiAmountConfig", "PausableConfig", "MetadataPointer", "TokenMetadata", "GroupPointer", "TokenGroup", "GroupMemberPointer", "TokenGroupMember", "DefaultAccountState"]),
});

function readOptPubkey(raw, at) {
  return raw.subarray(at, at + 32).every((b) => b === 0) ? null : getAddressDecoder().decode(raw.subarray(at, at + 32));
}
function readCOption(raw, at) {
  const tag = raw.readUInt32LE(at);
  if (tag !== 0 && tag !== 1) throw new Error("a malformed optional field");
  return tag === 0 ? null : getAddressDecoder().decode(raw.subarray(at + 4, at + 36));
}

/** One mint extension's data, read for the owner (not trusted for anything else). */
function readExtension(name, data) {
  switch (name) {
    case "TransferFeeConfig": {
      const fee = (at) => ({ epoch: data.readBigUInt64LE(at).toString(), maximum_fee: data.readBigUInt64LE(at + 8).toString(), bps: data.readUInt16LE(at + 16) });
      const older = fee(72);
      const newer = fee(90);
      return {
        older, newer,
        // The fee that applies depends on the epoch; the higher of the two is the one reported, so the owner is never shown less than may be charged.
        bps: Math.max(older.bps, newer.bps),
        maximum_fee: (BigInt(older.maximum_fee) > BigInt(newer.maximum_fee) ? older : newer).maximum_fee,
        config_authority: readOptPubkey(data, 0),
        withdraw_authority: readOptPubkey(data, 32),
      };
    }
    case "DefaultAccountState":
      return { state: data[0] === 2 ? "frozen" : data[0] === 1 ? "initialized" : "uninitialized" };
    case "PermanentDelegate":
      return { delegate: readOptPubkey(data, 0) };
    case "TransferHook":
      return { authority: readOptPubkey(data, 0), program_id: readOptPubkey(data, 32) };
    case "MintCloseAuthority":
      return { close_authority: readOptPubkey(data, 0) };
    case "PausableConfig":
      return { authority: readOptPubkey(data, 0), paused: data[32] === 1 };
    case "MetadataPointer":
      return { authority: readOptPubkey(data, 0), metadata_address: readOptPubkey(data, 32) };
    default:
      return {};
  }
}

/**
 * Parse a mint account (an RPC `getAccountInfo` entry, base64) into the facts the kit
 * needs. Throws Refused when it is not a readable, initialised mint.
 */
export function parseMintAccount(entry, mint) {
  const unreadable = (why) => new Refused([refuse("solana_swap.token_not_a_mint", `${mint} is ${why}; the kit swaps SPL and Token-2022 mints only`)]);
  if (!entry) throw unreadable("not an account on Solana (nothing exists at that address)");
  const program = entry.owner;
  if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022_PROGRAM) throw unreadable(`not a token mint (its account is owned by ${program})`);
  const raw = Buffer.from(String(entry.data?.[0] ?? ""), "base64");
  if (raw.length < 82) throw unreadable("not a token mint (the account is too short)");
  if (program === TOKEN_PROGRAM_ADDRESS && raw.length !== 82) throw unreadable("not a token mint (it is a token account or something else)");
  if (raw[45] !== 1) throw unreadable("a mint that was never initialised");
  let mintAuthority;
  let freezeAuthority;
  try {
    mintAuthority = readCOption(raw, 0);
    freezeAuthority = readCOption(raw, 46);
  } catch {
    throw unreadable("a mint with a malformed authority field");
  }
  const extensions = [];
  const details = {};
  const refusals = [];
  const notes = [];
  if (program === TOKEN_2022_PROGRAM && raw.length > 82) {
    if (raw.length <= 166 || raw[165] !== 1) throw unreadable("not a token mint (a Token-2022 account that is not a mint)");
    let pos = 166;
    while (pos + 4 <= raw.length) {
      const type = raw.readUInt16LE(pos);
      const len = raw.readUInt16LE(pos + 2);
      if (type === 0 && len === 0) break;
      if (pos + 4 + len > raw.length) throw unreadable("a mint with a malformed extension list");
      const name = TOKEN_2022_EXTENSIONS[type] ?? `Unknown(${type})`;
      const data = raw.subarray(pos + 4, pos + 4 + len);
      pos += 4 + len;
      if (extensions.includes(name)) throw unreadable(`a mint that lists the ${name} extension twice`);
      extensions.push(name);
      if (!(type in TOKEN_2022_EXTENSIONS)) {
        refusals.push(refuse("solana_swap.token_extension_refused", `the mint has a Token-2022 extension this kit does not know (type ${type}); a newer extension could do anything to the agent's tokens`));
        continue;
      }
      if (name in EXTENSION_SIZE && EXTENSION_SIZE[name] !== len) throw unreadable(`a mint whose ${name} extension is ${len} bytes, not the ${EXTENSION_SIZE[name]} this kit expects`);
      details[name] = readExtension(name, data);
    }
  }
  for (const name of extensions) {
    const why = TOKEN_2022_EXTENSION_POLICY.refuse[name];
    if (why) refusals.push(refuse("solana_swap.token_extension_refused", `the mint has the Token-2022 ${name} extension: ${why}`));
  }
  if (details.DefaultAccountState?.state === "frozen") {
    refusals.push(refuse("solana_swap.token_extension_refused", "the mint has the Token-2022 DefaultAccountState extension set to frozen: every new account for it starts frozen, so the agent could not sell what it buys"));
  }
  if (details.PausableConfig?.paused) {
    refusals.push(refuse("solana_swap.token_extension_refused", "the mint has the Token-2022 PausableConfig extension and is paused right now: transfers of it are stopped"));
  }

  // Reported to the owner, in plain words (no verdict).
  if (freezeAuthority) notes.push(`A freeze authority is set (${freezeAuthority}): it can freeze the agent's account for this token, and a frozen account cannot sell.`);
  else notes.push("No freeze authority is set on this mint.");
  if (mintAuthority) notes.push(`A mint authority is set (${mintAuthority}): it can create more of this token.`);
  else notes.push("No mint authority is set on this mint (no more can be created).");
  const tf = details.TransferFeeConfig;
  if (tf) {
    notes.push(`This Token-2022 mint charges a transfer fee of ${tf.bps / 100}% (${tf.bps} bps; at most ${tf.maximum_fee} base units per transfer) on every transfer of it, so a buy delivers less than the swap output and a sale sends less than it appears to.${tf.config_authority ? ` The fee can be changed by ${tf.config_authority}.` : ""} Quotes for such a token are less exact: a swap can miss its minimum at a tight slippage limit (seen on 2026-10-09 at 0.5%), and if it does the transaction fails and nothing is swapped.`);
  }
  if (details.PausableConfig) notes.push(`Transfers of this mint can be paused by ${details.PausableConfig.authority ?? "its authority"}.`);
  if (details.MintCloseAuthority?.close_authority) notes.push(`The mint can be closed by ${details.MintCloseAuthority.close_authority}.`);
  if (extensions.includes("InterestBearingConfig") || extensions.includes("ScaledUiAmountConfig")) notes.push("The balance shown by wallets for this mint is scaled or interest-adjusted; the swap works in the raw base units.");
  if (extensions.includes("MetadataPointer") || extensions.includes("TokenMetadata")) notes.push("The mint carries its own metadata (name, symbol, link), which is whatever its creator wrote.");

  return {
    mint,
    program,
    program_name: program === TOKEN_2022_PROGRAM ? "Token-2022" : "Token",
    decimals: raw[44],
    supply: raw.readBigUInt64LE(36).toString(),
    mint_authority: mintAuthority,
    freeze_authority: freezeAuthority,
    extensions,
    extension_details: details,
    transfer_fee: tf ? { bps: tf.bps, maximum_fee: tf.maximum_fee, older: tf.older, newer: tf.newer, config_authority: tf.config_authority } : null,
    symbol: null,
    major: null,
    onchain: true,
    notes,
    refusals,
  };
}

const majorToken = (s) => ({
  mint: s.mint, symbol: s.symbol, major: s.symbol, decimals: s.decimals, program: TOKEN_PROGRAM_ADDRESS, program_name: "Token",
  extensions: [], extension_details: {}, transfer_fee: null, onchain: false, notes: [], refusals: [],
});

/**
 * Resolve `USDC`, `SOL` or a base58 mint to what the kit needs to swap it:
 *   { mint, decimals, program, mint_authority, freeze_authority, extensions, major, ... }
 * USDC and SOL are pinned in the kit (SOL is the wrapped-SOL mint, wrapped and unwrapped
 * by Jupiter): `major` is "USDC" or "SOL", and nothing is read from the chain. Any other
 * mint is read from the chain through `deps.rpc` (one getAccountInfo): `major` is null, `program` is the
 * Token or Token-2022 program that owns it, and `extensions` are the Token-2022 extension names
 * (details in `extension_details`, a transfer fee also in `transfer_fee`). `notes` are plain-word
 * lines for the owner; `refusals` is empty unless the mint cannot be traded
 * (`assertSolanaTokenTradable` throws them). It throws Refused (`solana_swap.token_not_a_mint`)
 * when the address is not a readable mint, and an Error for something that is not an address.
 */
export async function resolveSolanaToken(mintOrSymbol, deps = {}) {
  const raw = String(mintOrSymbol ?? "").trim();
  const sym = SYMBOLS[raw.toUpperCase()] ?? Object.values(SYMBOLS).find((s) => s.mint === raw);
  if (sym) return majorToken(sym);
  if (!isAddress(raw)) throw new Error(`"${raw}" is not USDC, SOL or a Solana mint address (a base58 address, 32 to 44 characters)`);
  const r = deps.rpc ?? defaultRpc();
  let value;
  try {
    ({ value } = await withTimeout(r.getAccountInfo(address(raw), { encoding: "base64", commitment: "confirmed" }).send()));
  } catch (err) {
    throw new Error(`the mint ${raw} could not be read from the chain (${String(err.message).slice(0, 160)}); nothing was signed`);
  }
  return parseMintAccount(value, raw);
}

/** Throws Refused (`solana_swap.token_extension_refused`) when the mint's extensions rule it out. */
export function assertSolanaTokenTradable(token) {
  if (token.refusals?.length) throw new Refused(token.refusals);
  return token;
}

/** A token as one side of a swap. A long-tail token's `symbol` is its mint address. */
function tokenSide(info) {
  return { symbol: info.major ?? info.mint, mint: info.mint, decimals: info.decimals, program: info.program, major: info.major, label: info.major ?? shortMint(info.mint), info };
}

const unitsOf = (s, amount) => (s.major === "USDC" ? usdcUnits(amount) : s.major === "SOL" ? solLamports(amount) : tokenUnits(amount, s.decimals, s.label));

/**
 * Which side carries the Sato fee, and on which leg. Both majors: the input (as always). One long-tail side: the major side.
 * Verified against mainnet simulations on 2026-10-09: Jupiter takes the platform fee in the mint of the fee account it is
 * given, when that mint is either side of the swap. Buying (USDC -> token, SOL -> token) with the USDC or wrapped-SOL
 * account takes exactly the fee rate of the INPUT (7,500 of 5,000,000 USDC units at 15 bps), so the long-tail token never
 * carries the fee; selling takes it from the USDC or SOL OUTPUT before it reaches the agent, and the quoted output (and the
 * on-chain minimum) are after it. A fee account of a mint on neither side fails the build (custom error 3). Beware
 * `quote.platformFee.amount` on a buy: it is in units of the OUTPUT mint, not of the mint the fee is paid in. Nothing here reads it.
 */
function feeSideOf(a, b) {
  return a.major ? { side: a, leg: "input" } : { side: b, leg: "output" };
}

async function parseIntent({ from, to, amount, slippageBps }, d) {
  const ia = await resolveSolanaToken(from, d);
  const ib = await resolveSolanaToken(to, d);
  if (ia.mint === ib.mint) throw new Error("a swap needs two different assets");
  if (!ia.major && !ib.major) {
    throw new Refused([refuse("solana_swap.token_to_token", "one side of a swap must be USDC or SOL; swapping one token straight for another is not supported yet")]);
  }
  for (const t of [ia, ib]) assertSolanaTokenTradable(t);
  const a = tokenSide(ia);
  const b = tokenSide(ib);
  const units = unitsOf(a, amount);
  const slip = slippageBps ?? SLIPPAGE_BPS_DEFAULT;
  if (!Number.isInteger(slip) || slip < 1 || slip > SLIPPAGE_BPS_MAX) {
    throw new Error(`slippage must be a whole number of basis points from 1 to ${SLIPPAGE_BPS_MAX} (got ${slippageBps})`);
  }
  return { a, b, units, slip };
}

// ---------------------------------------------------------------- Jupiter's route instruction
//
// Jupiter's own instruction carries the numbers that decide what the swap may pay
// out: the quoted output, the slippage allowed on it, and the platform fee rate.
// They sit in the instruction data, so the kit reads them out of it.
//
// Source: Jupiter v6's Anchor IDL, read from the program's on-chain IDL account
// C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa on 2026-10-09 (a copy is kept in
// test/fixtures/swap-solana/jupiter-idl.json; `node test/fixtures/swap-solana/idl.mjs`
// re-derives the tables below from the chain; the older github.com/jup-ag/jupiter-cpi
// idl.json has the same `route` but no *_v2 instructions).
//
//   route   discriminator e517cb977ae3ad2a = sha256("global:route")[0..8]
//   args    route_plan: Vec<RoutePlanStep>, in_amount u64, quoted_out_amount u64,
//           slippage_bps u16, platform_fee_bps u8      (all little-endian, Borsh)
//   accts   0 token_program, 1 user_transfer_authority (signer), 2 user_source_token_account,
//           3 user_destination_token_account, 4 destination_token_account (optional),
//           5 destination_mint, 6 platform_fee_account (optional), 7 event_authority, 8 program,
//           then the venues' own accounts. An optional account that is absent is
//           Jupiter's program id in its place (Anchor's convention).
//
//   shared_accounts_route   discriminator c1209b3341d69c81 = sha256("global:shared_accounts_route")[0..8]
//   args    id u8, then the same route_plan, in_amount, quoted_out_amount, slippage_bps,
//           platform_fee_bps as `route`
//   accts   0 token_program, 1 program_authority (PDA of Jupiter, seeds ["authority", [id]]),
//           2 user_transfer_authority (signer), 3 source_token_account (the user's),
//           4 program_source_token_account (the program authority's account for the source mint),
//           5 program_destination_token_account (the program authority's account for the
//           destination mint), 6 destination_token_account (the user's), 7 source_mint,
//           8 destination_mint, 9 platform_fee_account (optional), 10 token_2022_program
//           (optional), 11 event_authority, 12 program, then the venues' own accounts.
//   Intermediate tokens of a multi-hop route sit in accounts of the program authority, not
//   the agent's, so the agent needs no account for them. Builds on 2026-10-09 confirmed
//   accounts 1, 4 and 5 are exactly the derived PDA and its associated token accounts.
//
// api.jup.ag returned `route` for every USDC<->SOL build tried on 2026-10-09 ($1 to
// $500 and 0.01 to 3 SOL, fee on and off, 15 builds), and `shared_accounts_route` for
// long-tail tokens asked for with useSharedAccounts. Those two are the only variants
// decoded, and `shared_accounts_route` only for a swap with a long-tail token (USDC <-> SOL
// keeps the direct, non-shared path). Anything else, the *_with_token_ledger,
// exact_out_* forms and the newer *_v2 ones included, is refused by name rather than
// guessed at.
//
// Why the whole route plan is walked and not just the last 19 bytes: Anchor ignores
// bytes left over after the arguments, so data can end with a harmless-looking copy of
// the tail while the program reads different numbers a little earlier. That was
// simulated on mainnet on 2026-10-09 (a copy of an honest tail appended after
// quoted_out=1 and slippage 10000 runs fine). The fixed-size arguments are therefore
// read at the position where the route plan ENDS, and the data must end there.
export const JUPITER_ROUTE_DISCRIMINATOR = "e517cb977ae3ad2a";
export const JUPITER_SHARED_ROUTE_DISCRIMINATOR = "c1209b3341d69c81";
export const JUPITER_INSTRUCTION_NAMES = {
  e517cb977ae3ad2a: "route",
  "96564774a75d0e68": "route_with_token_ledger",
  c1209b3341d69c81: "shared_accounts_route",
  e6798f50779f6aaa: "shared_accounts_route_with_token_ledger",
  d033ef977b2bed5c: "exact_out_route",
  b0d169a89a7d453e: "shared_accounts_exact_out_route",
  bb64facc31c4af14: "route_v2",
  d19853937cfed8e9: "shared_accounts_route_v2",
  "9d8ab85215f4f324": "exact_out_route_v2",
  "3560e5cad8bbfa18": "shared_accounts_exact_out_route_v2",
};
const JUPITER_ROUTE_ARGS_TAIL = 8 + 8 + 2 + 1;
/**
 * Where each form puts the accounts the kit checks, by index (from the IDL's account lists,
 * see above). `min` is how many accounts the form has before the venues' own; `source` /
 * `dest` are the user's token accounts, `authority` the signer, `fee` the optional platform fee
 * account (Jupiter's program id when absent), `program` Jupiter's own program id.
 */
export const ROUTE_ACCOUNTS = Object.freeze({
  route: Object.freeze({ min: 9, tokenProgram: 0, authority: 1, source: 2, dest: 3, destMint: 5, fee: 6, program: 8 }),
  shared_accounts_route: Object.freeze({ min: 13, tokenProgram: 0, programAuthority: 1, authority: 2, source: 3, programSource: 4, programDest: 5, dest: 6, sourceMint: 7, destMint: 8, fee: 9, token2022Program: 10, program: 12 }),
});

// The size of one RoutePlanStep, from the IDL's types. Grammar: a number is that many
// fixed bytes; ["o", T] Option<T>; ["v", T] Vec<T>; ["t", ...T] fields in order;
// ["e", "Name"] an enum, whose payload (if any) is looked up by variant index below.
// Generated by test/fixtures/swap-solana/idl.mjs from the on-chain IDL above, and
// checked against that IDL variant by variant in test/swap-solana.test.js.
const ROUTE_STEP = ["t", ["e", "Swap"], 3];
const ROUTE_ENUMS = {"CandidateSwap":{"variants":19,"payloads":{"0":9,"1":1,"2":9,"5":1,"7":1,"8":1,"9":1,"10":["t",1,["o",["v",2]]],"12":1,"14":1,"15":57,"16":65,"17":81}},"Swap":{"variants":197,"payloads":{"8":1,"12":1,"15":1,"16":1,"17":1,"18":1,"21":1,"23":1,"24":1,"27":1,"28":1,"29":16,"33":4,"39":1,"41":4,"42":3,"43":10,"44":5,"45":5,"47":["t",1,["o",["v",2]]],"58":1,"60":1,"61":1,"64":1,"71":2,"75":["v",2],"81":8,"82":8,"85":1,"86":2,"87":9,"89":1,"94":1,"95":1,"103":["t",1,["o",["v",2]]],"104":1,"106":1,"107":1,"110":1,"111":["t",["v",["e","CandidateSwap"]],["o",1]],"116":1,"117":1,"118":9,"119":1,"120":["t",1,["v",1]],"121":1,"122":16,"123":48,"125":1,"126":17,"127":1,"129":1,"132":1,"135":10,"136":1,"141":1,"145":1,"146":["t",["v",["t",["e","CandidateSwap"],4]],2],"151":1,"152":1,"153":1,"155":2,"157":9,"159":8,"160":1,"161":5,"162":1,"164":1,"165":1,"166":1,"167":2,"168":1,"170":1,"171":1,"172":1,"174":1,"177":1,"178":1,"181":1,"182":1,"183":["t",1,["o",1]],"184":1,"185":57,"186":65,"187":2,"189":1,"190":81,"191":2,"192":1,"193":1,"194":1,"196":1}}};

export const ROUTE_LAYOUT = Object.freeze({ step: ROUTE_STEP, enums: ROUTE_ENUMS });

/** The route data is not something this kit can read to its end. */
class RouteLayoutError extends Error {}

/** Position just after one value of type `t` starting at `pos`. */
function skipValue(t, buf, pos, depth = 0) {
  if (depth > 12) throw new RouteLayoutError("the route plan is nested too deeply");
  if (typeof t === "number") {
    if (pos + t > buf.length) throw new RouteLayoutError("the route plan runs past the end of the instruction");
    return pos + t;
  }
  if (pos >= buf.length) throw new RouteLayoutError("the route plan runs past the end of the instruction");
  switch (t[0]) {
    case "t":
      for (const part of t.slice(1)) pos = skipValue(part, buf, pos, depth + 1);
      return pos;
    case "o":
      if (buf[pos] === 0) return pos + 1;
      if (buf[pos] === 1) return skipValue(t[1], buf, pos + 1, depth + 1);
      throw new RouteLayoutError("the route plan has a malformed optional value");
    case "v": {
      if (pos + 4 > buf.length) throw new RouteLayoutError("the route plan runs past the end of the instruction");
      const n = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      pos += 4;
      if (n > buf.length - pos) throw new RouteLayoutError("the route plan claims more entries than the instruction can hold");
      if (typeof t[1] === "number") return skipValue(n * t[1], buf, pos, depth + 1);
      for (let i = 0; i < n; i++) pos = skipValue(t[1], buf, pos, depth + 1);
      return pos;
    }
    case "e": {
      const e = ROUTE_ENUMS[t[1]];
      const tag = buf[pos];
      if (tag >= e.variants) {
        throw new RouteLayoutError(`the route goes through a ${t[1]} variant (${tag}) that is newer than this kit's copy of Jupiter's program interface (it knows ${e.variants}); update the kit`);
      }
      const payload = e.payloads[tag];
      return payload === undefined ? pos + 1 : skipValue(payload, buf, pos + 1, depth + 1);
    }
    default:
      throw new RouteLayoutError("internal: unknown layout");
  }
}

/**
 * Read a `route` or `shared_accounts_route` instruction's data: { instruction, id, steps,
 * inAmount, quotedOut, slippageBps, platformFeeBps } (`id` is the shared form's leading
 * byte, null for `route`). Throws RouteLayoutError unless the data is exactly
 * discriminator (+ id) + route plan + the 19 fixed bytes, with nothing after.
 */
export function decodeJupiterRoute(data) {
  const buf = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const hex = Buffer.from(buf.subarray(0, 8)).toString("hex");
  const shared = hex === JUPITER_SHARED_ROUTE_DISCRIMINATOR;
  const lead = shared ? 1 : 0; // the shared form's id byte, before the route plan
  if (buf.length < 8 + lead + 4 + JUPITER_ROUTE_ARGS_TAIL) throw new RouteLayoutError("the instruction is too short to be a route");
  if (hex !== JUPITER_ROUTE_DISCRIMINATOR && !shared) throw new RouteLayoutError(`not a route instruction (${hex})`);
  const steps = new DataView(buf.buffer, buf.byteOffset + 8 + lead, 4).getUint32(0, true);
  if (steps < 1) throw new RouteLayoutError("the route has no steps");
  let pos = 12 + lead;
  for (let i = 0; i < steps; i++) pos = skipValue(ROUTE_STEP, buf, pos);
  if (buf.length - pos !== JUPITER_ROUTE_ARGS_TAIL) {
    throw new RouteLayoutError(`the route plan ends at byte ${pos} of ${buf.length}, which does not leave exactly the ${JUPITER_ROUTE_ARGS_TAIL} bytes of arguments (extra or missing bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset + pos, JUPITER_ROUTE_ARGS_TAIL);
  return {
    instruction: shared ? "shared_accounts_route" : "route",
    id: shared ? buf[8] : null,
    steps,
    inAmount: view.getBigUint64(0, true),
    quotedOut: view.getBigUint64(8, true),
    slippageBps: view.getUint16(16, true),
    platformFeeBps: view.getUint8(18),
  };
}

/** The least a swap with this much quoted output and slippage will accept as output (rounded down). */
export function minOutFor(quotedOut, slippageBps) {
  const keep = BigInt(Math.max(0, 10_000 - Number(slippageBps)));
  return (big(quotedOut) * keep) / 10_000n;
}

const b64 = getBase64Encoder();
function decodeTxBase64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("the transaction is not base64");
  return getTransactionDecoder().decode(b64.encode(text));
}

// ---------------------------------------------------------------- Jupiter HTTP

let lastJupiterCall = 0;

async function jupiter(path, { method = "GET", body }, d) {
  const gap = d.minGapMs ?? JUPITER_MIN_GAP_MS;
  const wait = Math.min(gap, lastJupiterCall + gap - d.now()); // never longer than the gap, whatever the clock did
  if (wait > 0 && gap > 0) await d.sleep(wait);
  const headers = { "user-agent": d.userAgent, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  const key = d.jupiterApiKey ?? process.env.SATO_AGENT_JUPITER_API_KEY;
  if (key) headers["x-api-key"] = key;
  for (let attempt = 0; ; attempt++) {
    lastJupiterCall = d.now();
    let res;
    try {
      res = await d.fetch(`${d.jupiterBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Jupiter did not answer (${err.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : err.message}); nothing was signed`);
    }
    const text = await res.text();
    if (res.status === 429 && attempt === 0) {
      await d.sleep(Math.min(10_000, Math.max(3_000, Number(res.headers?.get?.("retry-after") ?? 0) * 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`Jupiter answered HTTP ${res.status}: ${text.slice(0, 200)}${res.status === 429 ? " (keyless Jupiter allows about one request every 2 s; wait and try again)" : ""}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Jupiter answered something that is not JSON: ${text.slice(0, 120)}`);
    }
  }
}

function withDefaults(deps = {}) {
  return {
    ...deps,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    fetch: deps.fetch ?? globalThis.fetch,
    userAgent: deps.userAgent ?? USER_AGENT,
    jupiterBase: deps.jupiterBase ?? JUPITER_API,
  };
}

// ---------------------------------------------------------------- plan

/**
 * Quote and build a swap. Writes nothing, signs nothing, and makes no call to Sato
 * Hub itself: this function only talks to Jupiter (Sato Hub's recommend / build-tx
 * calls write public receipts, so they are not used here). It is not the whole story
 * though: the caller (src/swap/run.js) asks Sato Hub for a signed fee disclosure
 * before a Solana swap, and Sato Hub keeps a public record of that quote (the asset
 * pair and the amount, not the wallet). Needs `deps.satoFeeBps` from that disclosure
 * (0 = no fee).
 *
 * The minimum output is set here, not copied: Jupiter's `outAmount` less the owner's
 * slippage, rounded down, which is what Jupiter's program works out from the numbers
 * in the transaction (verifySolanaSwapPlan checks that the transaction carries them).
 *
 * One side is USDC or SOL; the other may be any SPL or Token-2022 mint (the "long-tail"
 * token, given as its mint address). USDC <-> SOL is built as before: direct routes, no
 * shared accounts. With a long-tail token Jupiter may route through other tokens, and
 * the build uses shared accounts (`shared_accounts_route`) so the intermediate tokens sit
 * in Jupiter's own accounts and the agent needs no account for them. The Sato fee is
 * always on the USDC or SOL side: the input when buying, the output when selling. For a
 * long-tail token this reads the mint from the chain (`deps.rpc`).
 *
 *   plan = {
 *     chain, venue, agent, from, to, mint_in, mint_out,   (from / to: "USDC", "SOL", or the mint address)
 *     amount_in, quote: { out_amount, min_out, slippage_bps, price_impact_pct, price_impact_bps, route, route_hops, context_slot },
 *     fee: { bps, account, mint, leg: "input" | "output", max_units, symbol, text } | { bps: 0, account: null, text },
 *     token: the long-tail token as resolveSolanaToken returned it, or null,
 *     tokens: { in, out } as resolveSolanaToken returned them (decimals included),
 *     priority: { max_lamports, jupiter_estimate_lamports },
 *     usd_estimate (null when neither side is USDC), swap_transaction (base64, v0), last_valid_block_height, built_at,
 *     disclosure: [lines to show the owner before anything is signed]
 *   }
 *
 * `price_impact_pct` is Jupiter's `priceImpactPct` as it sent it. Despite the name it is a
 * FRACTION (0.0344 means 3.44%; measured against a ladder of quote sizes on 2026-10-09), so
 * `price_impact_bps` is that figure in basis points, or null when Jupiter sent none. The
 * kit shows it and enforces nothing on it.
 */
export async function planSolanaSwap({ from, to, amount, slippageBps }, deps = {}) {
  const d = withDefaults(deps);
  const { a, b, units, slip } = await parseIntent({ from, to, amount, slippageBps }, d);
  const tail = a.major ? (b.major ? null : b) : a;
  const agent = d.agent ?? loadWallet().solana.address;
  address(agent);

  const feeBps = d.satoFeeBps;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    throw new Error(`satoFeeBps is required (from Sato Hub's quote; 0 for none) and must be a whole number from 0 to ${FEE_BPS_MAX}`);
  }
  // The fee account is pinned per mint of the fee side (USDC or wSOL; never the long-tail
  // token). A different one from the caller (or a response) is a kit release, not something to follow.
  const { side: feeSide, leg: feeLeg } = feeSideOf(a, b);
  const pinned = SATO_FEE_ACCOUNTS[feeSide.mint];
  if (feeBps > 0 && d.feeAccount !== undefined && d.feeAccount !== pinned) {
    throw new Refused([refuse("solana_swap.fee_account_unpinned", `the fee account ${d.feeAccount} is not the one this kit pins for ${feeSide.symbol} (${pinned}); update the kit rather than follow it`)]);
  }

  // USDC <-> SOL: direct routes only. A route through a third token (USDC -> USDT -> SOL) makes
  // Jupiter create the agent's account for that token, a step the kit does not allow, so a fresh
  // wallet would be refused (seen live, 2026-10-09). USDC/SOL has deep direct pools.
  // With a long-tail token the route may go through other tokens (many trade only against SOL),
  // and the build uses shared accounts: the hops then sit in Jupiter's own accounts.
  const q = new URLSearchParams({ inputMint: a.mint, outputMint: b.mint, amount: units.toString(), slippageBps: String(slip), swapMode: "ExactIn", restrictIntermediateTokens: "true" });
  if (!tail) q.set("onlyDirectRoutes", "true");
  if (feeBps > 0) q.set("platformFeeBps", String(feeBps));
  const quote = await jupiter(`/quote?${q}`, {}, d);
  checkQuote(quote, { a, b, units, slip, feeBps });

  const body = {
    userPublicKey: agent,
    quoteResponse: quote,
    wrapAndUnwrapSol: true,
    // USDC <-> SOL: ask for the plain `route` instruction. Left to itself Jupiter sometimes
    // answers with `shared_accounts_route` (seen live on 2026-10-09, about one build in three),
    // which a USDC <-> SOL swap here would then refuse. With a long-tail token the shared form
    // is what is wanted (it is decoded and checked, see checkJupiterRoute).
    useSharedAccounts: !!tail,
    dynamicComputeUnitLimit: true,
    // Capped, not "auto": Jupiter picks a level, we bound what it may cost.
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: PRIORITY_MAX_LAMPORTS, priorityLevel: "high" } },
  };
  if (feeBps > 0) body.feeAccount = pinned;
  const built = await jupiter("/swap", { method: "POST", body }, d);
  if (typeof built?.swapTransaction !== "string" || !built.swapTransaction) throw new Error("Jupiter returned no transaction");
  if (built.simulationError) throw new Error(`Jupiter's own simulation of the swap failed: ${jsonSafe(built.simulationError).slice(0, 200)}`);
  if (!Number.isFinite(built.lastValidBlockHeight)) throw new Error("Jupiter returned no lastValidBlockHeight");

  const outAmount = big(quote.outAmount);
  // Jupiter's own threshold is the same number rounded up by one at most (checkQuote); the
  // kit uses the rounded-down one so that what it promises is never above what the
  // transaction enforces.
  const minOut = minOutFor(outAmount, slip);

  // The fee: always on the USDC or SOL side. Buying (or USDC <-> SOL) it comes out of the input;
  // selling a long-tail token it comes out of the USDC or SOL received. Either way the
  // fee account is the pinned one for that mint, so the fee is never paid in the long-tail token.
  let maxFeeUnits = 0n;
  let fee = { bps: 0, account: null, text: "No Sato Hub fee on this swap." };
  if (feeBps > 0) {
    if (feeLeg === "input") {
      maxFeeUnits = (units * BigInt(feeBps) + 9_999n) / 10_000n;
      fee = {
        bps: feeBps, account: pinned, mint: feeSide.mint, leg: "input", symbol: feeSide.symbol, max_units: maxFeeUnits.toString(),
        text: `Sato Hub fee: ${feeBps / 100}% of the ${feeSide.symbol} you swap (up to ${formatUnits(maxFeeUnits, feeSide.decimals)} ${feeSide.symbol}), paid in ${feeSide.symbol} to Sato Hub's Jupiter referral token account ${pinned} inside this same transaction. It comes out of the amount you swap; nothing is added on top.`,
      };
    } else {
      // Jupiter's quoted output is already after the fee; the fee is that share of what the pool paid out.
      maxFeeUnits = (outAmount * BigInt(feeBps) + BigInt(10_000 - feeBps - 1)) / BigInt(10_000 - feeBps) + 1n;
      fee = {
        bps: feeBps, account: pinned, mint: feeSide.mint, leg: "output", symbol: feeSide.symbol, max_units: maxFeeUnits.toString(), estimated: true,
        text: `Sato Hub fee: ${feeBps / 100}% of the ${feeSide.symbol} the swap pays out (about ${formatUnits(maxFeeUnits, feeSide.decimals)} ${feeSide.symbol} at Jupiter's estimate), paid in ${feeSide.symbol} to Sato Hub's Jupiter referral token account ${pinned} inside this same transaction. It comes out of what you receive, before it reaches you; nothing is added on top, and nothing is ever taken in the other token.`,
      };
    }
  }

  // USD size, where it can be read off a USDC side. A SOL <-> long-tail swap has none: the caller prices it independently.
  const usd = a.major === "USDC" ? Number(units) / 1e6 : b.major === "USDC" ? Number(outAmount) / 1e6 : null;
  const route = (quote.routePlan ?? []).map((r) => r?.swapInfo?.label).filter(Boolean);
  const impactFraction = Number(quote.priceImpactPct);
  const plan = {
    chain: "solana",
    venue: "jupiter",
    agent,
    from: a.symbol,
    to: b.symbol,
    mint_in: a.mint,
    mint_out: b.mint,
    amount_in: units.toString(),
    quote: {
      out_amount: outAmount.toString(),
      min_out: minOut.toString(),
      slippage_bps: slip,
      // Jupiter's figure as sent: a fraction (0.01 = 1%), whatever the name says. Shown, never enforced.
      price_impact_pct: quote.priceImpactPct ?? null,
      price_impact_bps: quote.priceImpactPct != null && Number.isFinite(impactFraction) ? Math.round(impactFraction * 10_000) : null,
      route,
      route_hops: (quote.routePlan ?? []).length,
      context_slot: quote.contextSlot ?? null,
    },
    fee,
    token: tail ? tail.info : null,
    tokens: { in: a.info, out: b.info },
    priority: { max_lamports: PRIORITY_MAX_LAMPORTS, jupiter_estimate_lamports: Number.isFinite(built.prioritizationFeeLamports) ? built.prioritizationFeeLamports : null },
    usd_estimate: usd,
    swap_transaction: built.swapTransaction,
    last_valid_block_height: built.lastValidBlockHeight,
    built_at: d.now(),
  };
  plan.disclosure = [
    `Swap ${formatUnits(units, a.decimals)} ${a.label} for ${b.label} on Solana through Jupiter${route.length ? ` (${route.join(" > ")})` : ""}.`,
    `You receive at least ${formatUnits(minOut, b.decimals)} ${b.label} (Jupiter's estimate is ${formatUnits(outAmount, b.decimals)}; slippage limit ${slip / 100}%). That minimum is written into the transaction, and this kit reads it back out of the transaction and checks it before signing. If the swap cannot deliver it, the transaction fails and nothing is swapped.`,
    fee.text,
    `Network fee: ${Number(BASE_FEE_LAMPORTS) / 1e9} SOL plus a priority fee of at most ${PRIORITY_MAX_LAMPORTS / 1e9} SOL. If you have no ${b.major === "USDC" ? "USDC" : b.major === "SOL" ? "wrapped SOL" : "token"} account yet, creating one costs about ${Number(TOKEN_ACCOUNT_RENT) / 1e9} SOL rent${b.symbol === "SOL" ? " (refunded when it is closed)" : ""}.`,
  ];
  if (tail) {
    const t = tail.info;
    plan.disclosure.splice(1, 0, `The token is the ${t.program_name} mint ${t.mint} (${t.decimals} decimals), read from the chain just now.`, ...t.notes);
    if (plan.quote.price_impact_bps !== null) {
      plan.disclosure.push(`Price impact: Jupiter estimates this swap moves the price by about ${plan.quote.price_impact_bps / 100}% at this size. It is shown for you to weigh; the kit does not limit it. ${route.length > 1 ? "The route goes through more than one pool." : ""}`.trim());
    }
  }
  return plan;
}

function checkQuote(quote, { a, b, units, slip, feeBps }) {
  const bad = (m) => {
    throw new Error(`Jupiter's quote does not match the request (${m}); nothing was signed`);
  };
  if (!quote || typeof quote !== "object") bad("no quote");
  if (quote.inputMint !== a.mint || quote.outputMint !== b.mint) bad("different assets");
  if (quote.swapMode !== "ExactIn") bad("not an exact-input quote");
  if (String(quote.inAmount) !== units.toString()) bad("different input amount");
  if (Number(quote.slippageBps) !== slip) bad("different slippage");
  if (!/^\d+$/.test(String(quote.outAmount)) || !/^\d+$/.test(String(quote.otherAmountThreshold))) bad("no output amounts");
  const out = big(quote.outAmount);
  const min = big(quote.otherAmountThreshold);
  if (out <= 0n || min <= 0n || min > out) bad("output amounts are inconsistent");
  // The floor Jupiter reports must be the slippage the owner asked for (to the unit):
  // neither looser nor tighter than the rounded-down value, give or take the one unit
  // Jupiter rounds up by.
  const floor = minOutFor(out, slip);
  if (min < floor) bad("the minimum output is looser than the slippage limit");
  if (min > floor + 1n) bad("the minimum output does not match the slippage limit");
  if (feeBps > 0 && Number(quote.platformFee?.feeBps) !== feeBps) bad("the platform fee was not applied");
  if (feeBps === 0 && big(quote.platformFee?.amount) > 0n) bad("an unrequested platform fee");
}

// ---------------------------------------------------------------- inspection (static)

const u32 = (data, at = 1) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
const u64 = (data, at = 1) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

async function derivedAta(owner, mint, tokenProgram = TOKEN_PROGRAM_ADDRESS) {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return ata;
}

/**
 * Check Jupiter's route instruction(s) against what was asked for and disclosed.
 * `jup` is every top-level instruction to Jupiter's program, `{ n, data, accts }`.
 * Pushes refusals; returns the decoded route, or null when there is no single
 * readable `route` instruction.
 */
async function checkJupiterRoute(jup, o, ata, refusals) {
  // The shared-accounts form is read only for a swap with a long-tail token; USDC <-> SOL keeps the plain route.
  const allowShared = !!o.tail;
  if (jup.length !== 1) refusals.push(refuse("solana_swap.jupiter_route_count", `the transaction has ${jup.length} Jupiter instructions; a swap here has exactly one route instruction`));
  let single = null;
  for (const { n, data } of jup) {
    const hex = Buffer.from(data.subarray(0, 8)).toString("hex");
    if (hex === JUPITER_ROUTE_DISCRIMINATOR || (allowShared && hex === JUPITER_SHARED_ROUTE_DISCRIMINATOR)) {
      if (jup.length === 1) single = jup[0];
      continue;
    }
    const name = JUPITER_INSTRUCTION_NAMES[hex];
    refusals.push(refuse("solana_swap.jupiter_instruction_unrecognized", name
      ? `instruction ${n} is Jupiter's ${name}, which this kit does not read or allow (it decodes the plain "route" instruction${allowShared ? " and shared_accounts_route" : ""}, exact input, only)`
      : `instruction ${n} is a Jupiter instruction this kit does not recognise (${hex || "no data"})`));
  }
  if (!single) return null;

  const { n, data, accts } = single;
  let route;
  try {
    route = decodeJupiterRoute(data);
  } catch (err) {
    if (!(err instanceof RouteLayoutError)) throw err;
    refusals.push(refuse("solana_swap.jupiter_instruction_unrecognized", `instruction ${n}: ${err.message}`));
    return null;
  }
  const L = ROUTE_ACCOUNTS[route.instruction];
  if (accts.length < L.min) {
    refusals.push(refuse("solana_swap.jupiter_instruction_unrecognized", `instruction ${n} has ${accts.length} accounts; ${route.instruction === "route" ? "a route instruction" : "a shared_accounts_route instruction"} has at least ${L.min}`));
    return route;
  }
  const at = (i) => accts[i].address;
  const nameOf = (mint) => MINT_SYMBOL[mint] ?? `${shortMint(mint)} token`;

  // What the transaction itself says it will do.
  if (route.inAmount !== big(o.amountIn)) {
    refusals.push(refuse("solana_swap.jupiter_amount_mismatch", `the Jupiter instruction swaps ${route.inAmount} base units, not the ${o.amountIn} asked for`));
  }
  if (!(route.slippageBps >= 1 && route.slippageBps <= o.slippageBps)) {
    refusals.push(refuse("solana_swap.min_out_not_enforced", `the Jupiter instruction allows ${route.slippageBps} bps of slippage; the limit for this swap is ${o.slippageBps} bps`));
  }
  const floor = minOutFor(route.quotedOut, route.slippageBps);
  if (floor < big(o.minOut)) {
    refusals.push(refuse("solana_swap.min_out_not_enforced", `the transaction only requires ${floor} base units out (quoted ${route.quotedOut} less ${route.slippageBps} bps of slippage), below the ${o.minOut} shown to the owner`));
  }
  if (route.platformFeeBps !== o.feeBps) {
    refusals.push(refuse("solana_swap.fee_not_as_disclosed", `the Jupiter instruction takes a platform fee of ${route.platformFeeBps} bps; ${o.feeBps} bps was disclosed`));
  }
  const wantFeeAccount = o.feeAccount ?? JUPITER_PROGRAM; // Anchor: an absent optional account is the program id
  if (at(L.fee) !== wantFeeAccount) {
    refusals.push(refuse("solana_swap.fee_not_as_disclosed", o.feeAccount
      ? `the Jupiter instruction pays its platform fee to ${at(L.fee)}, not the disclosed account ${o.feeAccount}`
      : `the Jupiter instruction names a fee account (${at(L.fee)}) but no fee was disclosed`));
  }

  // Whose money moves and where it lands.
  if (at(L.authority) !== o.agent || !isSignerRole(accts[L.authority].role)) {
    refusals.push(refuse("solana_swap.jupiter_authority_not_agent", `the Jupiter instruction is authorised by ${at(L.authority)}, not the agent`));
  }
  if (at(L.source) !== ata[o.mintIn]) {
    refusals.push(refuse("solana_swap.jupiter_source_not_agent", `the Jupiter instruction takes the input from ${at(L.source)}, which is not the agent's own ${nameOf(o.mintIn)} account`));
  }
  if (at(L.dest) !== ata[o.mintOut]) {
    refusals.push(refuse("solana_swap.recipient_not_agent", `the Jupiter instruction pays the output to ${at(L.dest)}, which is not the agent's own ${nameOf(o.mintOut)} account`));
  }
  if (at(L.destMint) !== o.mintOut) {
    refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction's destination mint is ${at(L.destMint)}, not ${o.mintOut}`));
  }
  const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, ...(o.tail?.program === TOKEN_2022_PROGRAM ? [TOKEN_2022_PROGRAM] : [])];
  if (!tokenPrograms.includes(at(L.tokenProgram))) {
    refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction uses ${at(L.tokenProgram)} as the token program`));
  }
  if (at(L.program) !== JUPITER_PROGRAM) {
    refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction names ${at(L.program)} as its own program`));
  }
  if (route.instruction === "route") {
    if (at(4) !== JUPITER_PROGRAM && at(4) !== ata[o.mintOut]) {
      refusals.push(refuse("solana_swap.recipient_not_agent", `the Jupiter instruction names a second destination account (${at(4)}) that is not the agent's own ${nameOf(o.mintOut)} account`));
    }
  } else {
    // shared_accounts_route: the input goes to Jupiter's program authority, the hops run through the
    // authority's own accounts, and the output comes back to the agent's account. So the authority
    // and its two token accounts must be exactly the ones Jupiter's program derives: a swap that
    // parks the agent's tokens in any other account is refused.
    if (at(7) !== o.mintIn) refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction's source mint is ${at(7)}, not ${o.mintIn}`));
    const progOf = (mint) => (o.tail && mint === o.tail.mint ? o.tail.program : TOKEN_PROGRAM_ADDRESS);
    const [authority] = await getProgramDerivedAddress({ programAddress: address(JUPITER_PROGRAM), seeds: [new TextEncoder().encode("authority"), Uint8Array.of(route.id)] });
    if (at(1) !== authority) {
      refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction's program authority is ${at(1)}, not the ${authority} that Jupiter's program derives for id ${route.id}`));
    } else {
      // Each is the program authority's associated account for the mint. Seen live (2026-10-09) for a Token-2022 output,
      // Jupiter names the agent's own account in the program-destination slot instead; that is still the agent's, so it passes.
      const wantSource = await derivedAta(authority, o.mintIn, progOf(o.mintIn));
      const wantDest = await derivedAta(authority, o.mintOut, progOf(o.mintOut));
      if (at(4) !== wantSource && at(4) !== ata[o.mintIn]) refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction moves the input into ${at(4)}, which is neither the program authority's ${nameOf(o.mintIn)} account (${wantSource}) nor the agent's own`));
      if (at(5) !== wantDest && at(5) !== ata[o.mintOut]) refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction collects the output in ${at(5)}, which is neither the program authority's ${nameOf(o.mintOut)} account (${wantDest}) nor the agent's own`));
    }
    if (at(10) !== JUPITER_PROGRAM && at(10) !== TOKEN_2022_PROGRAM) {
      refusals.push(refuse("solana_swap.jupiter_account_mismatch", `the Jupiter instruction names ${at(10)} as the Token-2022 program`));
    }
  }
  return route;
}

/**
 * Decode a swap transaction and run every check that needs no simulation.
 * `alts` maps each lookup table address to its list of addresses. Returns
 * { refusals, facts }; it never throws for a bad transaction, only for bad input.
 *
 * opts: agent, mintIn, mintOut, amountIn (base units), feeAccount (the disclosed fee
 * account or null), feeBps (disclosed), slippageBps (the most the owner allows),
 * minOut (the minimum output shown to the owner, base units), tail ({ mint, program }: the
 * long-tail token, when one side is neither USDC nor SOL; it enables the shared-accounts form
 * and one idempotent account creation for the agent's own account for that mint).
 */
export async function inspectSolanaSwapTransaction(swapTransaction, opts, alts) {
  const { agent, mintIn, amountIn, feeAccount } = opts;
  for (const k of ["mintOut", "feeBps", "slippageBps", "minOut"]) if (opts[k] === undefined) throw new Error(`inspectSolanaSwapTransaction needs ${k}`);
  const refusals = [];
  const facts = { programs: [], priority_lamports: 0n, keys: [], lookup_loaded: { writable: [], readonly: [] }, created_atas: [], route: null };
  const jupiterIxs = [];
  let tx;
  let compiled;
  let message;
  try {
    tx = decodeTxBase64(swapTransaction);
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: alts });
  } catch (err) {
    refusals.push(refuse("solana_swap.decode", `the transaction could not be decoded with its lookup tables (${String(err.message).slice(0, 160)})`));
    return { refusals, facts };
  }
  if (compiled.version !== 0) refusals.push(refuse("solana_swap.version", `expected a version 0 transaction, got ${compiled.version}`));

  // (a) fee payer and (b) the only signer.
  const statics = compiled.staticAccounts;
  const nSigners = compiled.header.numSignerAccounts;
  if (statics[0] !== agent) refusals.push(refuse("solana_swap.fee_payer", `the fee payer is ${statics[0]}, not the agent ${agent}`));
  if (nSigners !== 1) refusals.push(refuse("solana_swap.signers", `${nSigners} accounts must sign; only the agent may`));
  const sigKeys = Object.keys(tx.signatures);
  if (sigKeys.length !== 1 || sigKeys[0] !== agent) refusals.push(refuse("solana_swap.signers", `the transaction expects signatures from ${sigKeys.join(", ")}; only the agent may sign`));

  // Resolved account keys, in the order the runtime (and the simulation) report them.
  const lookups = compiled.addressTableLookups ?? [];
  const writable = lookups.flatMap((l) => l.writableIndexes.map((i) => alts[l.lookupTableAddress][i]));
  const readonly = lookups.flatMap((l) => l.readonlyIndexes.map((i) => alts[l.lookupTableAddress][i]));
  facts.lookup_loaded = { writable, readonly };
  facts.keys = [...statics, ...writable, ...readonly];

  const agentSplAta = {
    [USDC_MINT]: await derivedAta(agent, USDC_MINT),
    [WSOL_MINT]: await derivedAta(agent, WSOL_MINT),
  };
  // The long-tail token, when one side is neither USDC nor SOL: the agent's account for it is the associated
  // account under the token program that owns the mint (Token-2022 mints have their own derivation).
  const tail = opts.tail ?? null;
  if (tail) {
    if (tail.mint !== mintIn && tail.mint !== opts.mintOut) throw new Error("inspectSolanaSwapTransaction: tail is neither side of the swap");
    agentSplAta[tail.mint] = await derivedAta(agent, tail.mint, tail.program);
  }
  let tailCreations = 0;

  let limit = null;
  let price = null;
  let heap = 0;
  let loadedLimit = 0;
  let nonBudget = 0;
  let systemLamports = 0n;
  const pushOnce = (set, v) => set.includes(v) || set.push(v);

  for (const [n, ix] of message.instructions.entries()) {
    const prog = ix.programAddress;
    const data = ix.data ?? new Uint8Array();
    const accts = ix.accounts ?? [];
    pushOnce(facts.programs, prog);
    // No instruction may ask for anyone's signature but the agent's.
    for (const acc of accts) if (isSignerRole(acc.role) && acc.address !== agent) refusals.push(refuse("solana_swap.signers", `instruction ${n} needs a signature from ${acc.address}`));

    if (!SWAP_PROGRAM_ALLOWLIST[prog]) {
      refusals.push(refuse("solana_swap.program_allowlist", `instruction ${n} calls ${prog}, which is not an allowed program`));
      continue;
    }
    if (prog !== COMPUTE_BUDGET_PROGRAM) nonBudget++;

    if (prog === COMPUTE_BUDGET_PROGRAM) {
      const d0 = data[0];
      if (d0 === 2 && data.length === 5) {
        if (limit !== null) refusals.push(refuse("solana_swap.priority_fee", "two compute-unit-limit instructions"));
        limit = u32(data);
      } else if (d0 === 3 && data.length === 9) {
        if (price !== null) refusals.push(refuse("solana_swap.priority_fee", "two compute-unit-price instructions"));
        price = u64(data);
      } else if (d0 === 1 && data.length === 5) heap = u32(data);
      else if (d0 === 4 && data.length === 5) loadedLimit = u32(data);
      else refusals.push(refuse("solana_swap.compute_budget", `instruction ${n} is a ComputeBudget instruction this kit does not allow (type ${d0})`));
    } else if (prog === SYSTEM_PROGRAM) {
      // Only a SOL transfer from the agent into its own wrapped-SOL account (the wrap step).
      const kind = data.length >= 4 ? u32(data, 0) : -1;
      if (kind === 2 && data.length === 12) {
        const lamports = u64(data, 4);
        systemLamports += lamports;
        if (accts[0]?.address !== agent || accts[1]?.address !== agentSplAta[WSOL_MINT]) {
          refusals.push(refuse("solana_swap.system_transfer", `instruction ${n} moves SOL to ${accts[1]?.address}, which is not the agent's own wrapped-SOL account`));
        }
      } else refusals.push(refuse("solana_swap.system_instruction", `instruction ${n} is a System instruction this kit does not allow`));
    } else if (prog === ASSOCIATED_TOKEN_PROGRAM) {
      const kind = data.length === 0 ? 0 : data[0];
      const [payer, ata, owner, mint, , tokenProgram] = accts.map((x) => x.address);
      if ((kind !== 0 && kind !== 1) || accts.length < 6) {
        refusals.push(refuse("solana_swap.ata_instruction", `instruction ${n} is an Associated Token instruction this kit does not allow`));
      } else if (tail && mint === tail.mint) {
        // The long-tail token's account for the agent: exactly one, idempotent, under the token program that owns the mint.
        if (kind !== 1 || tailCreations > 0 || payer !== agent || owner !== agent || tokenProgram !== tail.program || ata !== agentSplAta[mint]) {
          refusals.push(refuse("solana_swap.ata_instruction", `instruction ${n} ${tailCreations > 0 ? "creates the agent's account for the token a second time" : "creates a token account that is not exactly the agent's own idempotent account for the token being swapped"}`));
        } else {
          tailCreations++;
          pushOnce(facts.created_atas, ata);
        }
      } else {
        const mintOk = mint === USDC_MINT || mint === WSOL_MINT;
        if (payer !== agent || owner !== agent || !mintOk || tokenProgram !== TOKEN_PROGRAM_ADDRESS || ata !== agentSplAta[mint]) {
          refusals.push(refuse("solana_swap.ata_instruction", `instruction ${n} creates a token account that is not the agent's own USDC, wrapped-SOL${tail ? " or swapped-token" : ""} account`));
        } else pushOnce(facts.created_atas, ata);
      }
    } else if (prog === TOKEN_PROGRAM_ADDRESS || prog === TOKEN_2022_PROGRAM) {
      const kind = data[0];
      if (kind === 6 || kind === 4 || kind === 13) {
        refusals.push(refuse("solana_swap.token_authority", `instruction ${n} is a token ${kind === 6 ? "SetAuthority" : kind === 4 ? "Approve" : "ApproveChecked"}, which gives someone control of the agent's tokens`));
      } else if (kind === 9) {
        // Closing the wrapped-SOL account after the swap: the lamports must come back to the agent.
        if (accts[1]?.address !== agent || accts[2]?.address !== agent) {
          refusals.push(refuse("solana_swap.token_close_destination", `instruction ${n} closes a token account into ${accts[1]?.address}, not the agent`));
        }
      } else if (kind === 17) {
        // SyncNative: credits the wrapped lamports; moves nothing.
      } else refusals.push(refuse("solana_swap.token_instruction", `instruction ${n} is a token instruction (type ${kind}) this kit does not allow at the top level`));
    }
    else if (prog === JUPITER_PROGRAM) jupiterIxs.push({ n, data, accts });
  }
  // Jupiter: its data and accounts are read below; what it does to the agent's balances
  // and token accounts is then checked by the simulation.
  facts.route = await checkJupiterRoute(jupiterIxs, { ...opts, agent, tail }, agentSplAta, refusals);

  // (e) the priority fee: price x limit, in lamports, rounded up.
  const effLimit = BigInt(limit ?? Math.min(200_000 * nonBudget, 1_400_000));
  facts.priority_lamports = price === null ? 0n : (price * effLimit + 999_999n) / 1_000_000n;
  facts.compute_unit_limit = Number(effLimit);
  facts.requested_heap = heap;
  facts.loaded_accounts_limit = loadedLimit;
  if (facts.priority_lamports > BigInt(PRIORITY_MAX_LAMPORTS)) {
    refusals.push(refuse("solana_swap.priority_fee", `the priority fee would be ${facts.priority_lamports} lamports, over the cap of ${PRIORITY_MAX_LAMPORTS}`));
  }
  if (mintIn === WSOL_MINT) {
    if (systemLamports > big(amountIn)) refusals.push(refuse("solana_swap.system_transfer", `the transaction wraps ${systemLamports} lamports, more than the ${amountIn} being swapped`));
  } else if (systemLamports > 0n) {
    refusals.push(refuse("solana_swap.system_transfer", "the transaction moves SOL, but this swap does not spend SOL"));
  }
  if (feeAccount && !facts.keys.includes(feeAccount)) refusals.push(refuse("solana_swap.fee_account_missing", `the disclosed fee account ${feeAccount} is not in the transaction`));
  facts.system_lamports = systemLamports;
  facts.instruction_count = message.instructions.length;
  return { refusals, facts };
}

// ---------------------------------------------------------------- balance deltas

/**
 * What a transaction (simulated or confirmed) did to the agent. Inputs are the
 * runtime's own arrays: `keys` (static + loaded writable + loaded readonly),
 * pre/post lamports, and pre/post token balances. All from one execution, so
 * there is no race between a "before" read and an "after" read.
 *
 *   usdc.delta   change in USDC across the agent's USDC token accounts (base units)
 *   sol.delta    change in the agent's SOL position: its lamports plus every wrapped-SOL
 *                account it owns, rent included (wrap, unwrap and close move value
 *                between those two and so net to zero)
 *   created_usdc_rent  lamports locked in USDC accounts the transaction created
 *   tail         with a `tailMint` (the long-tail token being swapped): the change in the agent's
 *                balance of it across all its accounts of that mint, null otherwise
 *   created_tail_rent  lamports locked in accounts of the tail mint the transaction created
 *   others       agent-owned token accounts of any other mint (the tail mint excluded) that changed
 */
export function balanceDeltas(view, agent, tailMint = null) {
  const keys = view.keys.map(String);
  const agentIndex = keys.indexOf(agent);
  const pre = view.preBalances.map(big);
  const post = view.postBalances.map(big);
  const mine = (list) => (list ?? []).filter((t) => t.owner === agent);
  const preTok = mine(view.preTokenBalances);
  const postTok = mine(view.postTokenBalances);
  const amount = (t) => big(t.uiTokenAmount?.amount ?? t.amount);
  const sumMint = (list, mint) => list.filter((t) => t.mint === mint).reduce((s, t) => s + amount(t), 0n);
  const indices = (list, mint) => new Set(list.filter((t) => t.mint === mint).map((t) => t.accountIndex));
  const lamportsOf = (set, arr) => [...set].reduce((s, i) => s + arr[i], 0n);

  // A wrapped-SOL account counts toward the agent's SOL only while the agent owns it.
  // `mine` already keeps only token balances whose owner is the agent in THAT state, so
  // each side uses its own list: an account whose owner changed during the transaction
  // is in the "before" set but not the "after" set, and its lamports leave the total.
  const solPre = (agentIndex >= 0 ? pre[agentIndex] : 0n) + lamportsOf(indices(preTok, WSOL_MINT), pre);
  const solPost = (agentIndex >= 0 ? post[agentIndex] : 0n) + lamportsOf(indices(postTok, WSOL_MINT), post);
  const preUsdcIdx = new Set(preTok.filter((t) => t.mint === USDC_MINT).map((t) => t.accountIndex));
  let createdRent = 0n;
  for (const t of postTok) if (t.mint === USDC_MINT && !preUsdcIdx.has(t.accountIndex)) createdRent += post[t.accountIndex];

  // The long-tail token being swapped (when there is one) is counted in its own line, and its new
  // account's rent separately, so it is not an "other" asset.
  const preTailIdx = new Set(preTok.filter((t) => t.mint === tailMint).map((t) => t.accountIndex));
  let createdTailRent = 0n;
  if (tailMint) for (const t of postTok) if (t.mint === tailMint && !preTailIdx.has(t.accountIndex)) createdTailRent += post[t.accountIndex];

  const others = [];
  const otherMints = new Set([...preTok, ...postTok].map((t) => t.mint).filter((m) => m !== USDC_MINT && m !== WSOL_MINT && m !== tailMint));
  for (const m of otherMints) {
    const delta = sumMint(postTok, m) - sumMint(preTok, m);
    if (delta !== 0n) others.push({ mint: m, delta });
  }
  const usdcPre = sumMint(preTok, USDC_MINT);
  const usdcPost = sumMint(postTok, USDC_MINT);
  return {
    usdc: { pre: usdcPre, post: usdcPost, delta: usdcPost - usdcPre },
    sol: { pre: solPre, post: solPost, delta: solPost - solPre },
    created_usdc_rent: createdRent,
    tail: tailMint ? { mint: tailMint, pre: sumMint(preTok, tailMint), post: sumMint(postTok, tailMint), delta: sumMint(postTok, tailMint) - sumMint(preTok, tailMint) } : null,
    created_tail_rent: createdTailRent,
    others,
    agent_in_transaction: agentIndex >= 0,
  };
}

/** The balance change of one token account (by address) between two states, or null if it is not in the transaction. */
function tokenAccountChange(view, accountAddress) {
  const idx = view.keys.map(String).indexOf(accountAddress);
  if (idx < 0) return null;
  const find = (list) => (list ?? []).find((t) => t.accountIndex === idx);
  const a = find(view.preTokenBalances);
  const z = find(view.postTokenBalances);
  return { index: idx, mint: (a ?? z)?.mint ?? null, existed: !!a, pre: a ? big(a.uiTokenAmount?.amount) : 0n, post: z ? big(z.uiTokenAmount?.amount) : 0n };
}

// ---------------------------------------------------------------- verify

/**
 * What the owner asked for, with each side resolved again here: a long-tail mint is read from
 * the chain (never taken from the plan), so its token program, decimals and extensions are the
 * chain's own and a mint that must be refused is refused again.
 */
async function intentOf(plan, intent, d) {
  const i = intent ?? {};
  const from = tokenSide(await resolveSolanaToken(i.from ?? plan.from, d));
  const to = tokenSide(await resolveSolanaToken(i.to ?? plan.to, d));
  let units = i.amount_in ?? plan.amount_in;
  if (i.amount !== undefined) units = unitsOf(from, i.amount);
  return { agent: i.agent ?? plan.agent, from, to, amountIn: big(units), slippageBps: i.slippage_bps, feeBps: i.fee_bps };
}

/** Wrapped-SOL and USDC token accounts are classic SPL Token accounts: 165 bytes, laid out as below. */
const TOKEN_ACCOUNT_SIZE = 165;

/**
 * Read an RPC `accounts` entry (base64) as an SPL Token account of `program`. Layout (spl-token
 * `Account`): mint 0..32, owner 32..64, amount 64..72, delegate COption<Pubkey> at 72
 * (u32 tag + 32), state at 108, is_native COption<u64> at 109, delegated_amount at 121,
 * close_authority COption<Pubkey> at 129 (u32 tag + 32). A Token-2022 account has the same
 * first 165 bytes, then (when it has extensions) the account-type byte 2 and a TLV list.
 */
function readTokenAccount(entry, program = TOKEN_PROGRAM_ADDRESS) {
  const raw = Buffer.from(String(entry?.data?.[0] ?? ""), "base64");
  if (entry?.owner !== program) return null;
  if (program === TOKEN_PROGRAM_ADDRESS ? raw.length !== TOKEN_ACCOUNT_SIZE : !(raw.length === TOKEN_ACCOUNT_SIZE || (raw.length > TOKEN_ACCOUNT_SIZE && raw[TOKEN_ACCOUNT_SIZE] === 2))) return null;
  const key = (at) => getAddressDecoder().decode(raw.subarray(at, at + 32));
  return {
    mint: key(0),
    owner: key(32),
    amount: raw.readBigUInt64LE(64),
    delegate: raw.readUInt32LE(72) === 0 ? null : key(76),
    state: raw[108],
    delegatedAmount: raw.readBigUInt64LE(121),
    closeAuthority: raw.readUInt32LE(129) === 0 ? null : key(133),
  };
}

/**
 * The state the simulation left the agent's own accounts in. Refusals for anything
 * that gives someone else a say over them: the wallet no longer owned by the System
 * program, or a USDC / wrapped-SOL / swapped-token account that is not a plain token
 * account (of the program that owns the mint) owned by the agent with no delegate and no
 * close authority. An account that no longer exists (the wrapped-SOL account, closed after
 * the swap) is fine.
 */
function checkAgentAccountsAfter(after, agent) {
  const out = [];
  const bad = (m) => out.push(refuse("solana_swap.account_authority_changed", m));
  const w = after.wallet;
  if (!w || w.owner !== SYSTEM_PROGRAM || Number(w.space ?? 0) !== 0 || w.executable) {
    bad("after the swap the agent's wallet account would no longer be an ordinary wallet owned by the System program");
  }
  for (const { mint, label, addr, entry, program } of after.tokens) {
    if (!entry || (big(entry.lamports) === 0n && Number(entry.space ?? 0) === 0)) continue; // does not exist (closed, or never made)
    const t = readTokenAccount(entry, program ?? TOKEN_PROGRAM_ADDRESS);
    if (!t) bad(`after the swap the agent's ${label} account ${addr} would not be a plain ${program === TOKEN_2022_PROGRAM ? "Token-2022" : "Token"} account`);
    else if (t.mint !== mint) bad(`after the swap the agent's ${label} account ${addr} would hold a different token (${t.mint})`);
    else if (t.owner !== agent) bad(`after the swap the agent's ${label} account ${addr} would be owned by ${t.owner}, not the agent`);
    else if (t.delegate) bad(`after the swap the agent's ${label} account ${addr} would have a delegate (${t.delegate}) that can spend from it`);
    else if (t.closeAuthority) bad(`after the swap the agent's ${label} account ${addr} would have a close authority (${t.closeAuthority})`);
  }
  return out;
}

/**
 * Check a built swap before anything is signed. Throws Refused (rule ids
 * `solana_swap.*`) on the first failing stage, listing every failure in it.
 * Returns { ok: true, ... } with the facts that were checked.
 *
 * `intent` is what the owner asked for ({ agent, from, to, amount_in | amount }),
 * checked against the plan and the decoded transaction, not copied from the plan.
 */
export async function verifySolanaSwapPlan(plan, intent, deps = {}) {
  const d0 = withDefaults(deps);
  const r = d0.rpc ?? defaultRpc();
  const d = { ...d0, rpc: r };
  const want = await intentOf(plan, intent, d);
  const refusals = [];
  const fail = (rule, msg) => refusals.push(refuse(rule, msg));

  // The plan must be the swap that was asked for.
  if (plan.chain !== "solana" || plan.venue !== "jupiter") fail("solana_swap.intent", "the plan is not a Solana / Jupiter swap");
  if (plan.agent !== want.agent) fail("solana_swap.intent", `the plan is for ${plan.agent}, not the agent ${want.agent}`);
  if (plan.from !== want.from.symbol || plan.to !== want.to.symbol || plan.mint_in !== want.from.mint || plan.mint_out !== want.to.mint) fail("solana_swap.intent", "the plan swaps different assets than asked");
  if (want.from.symbol === want.to.symbol) fail("solana_swap.intent", "a swap needs two different assets");
  // One side is USDC or SOL; the other may be any mint that is read and allowed again here, from the chain.
  if (!want.from.major && !want.to.major) fail("solana_swap.token_to_token", "one side of a swap must be USDC or SOL; swapping one token straight for another is not supported yet");
  for (const s of [want.from, want.to]) refusals.push(...s.info.refusals);
  const tail = want.from.major ? (want.to.major ? null : want.to) : want.from;
  if (tail && plan.token && plan.token.mint === tail.mint && (plan.token.decimals !== tail.decimals || plan.token.program !== tail.program)) {
    fail("solana_swap.intent", "the plan describes the token differently (decimals or token program) than the chain does");
  }
  if (String(plan.amount_in) !== want.amountIn.toString()) fail("solana_swap.intent", `the plan swaps ${plan.amount_in} base units, not the ${want.amountIn} asked for`);
  const minOut = (() => {
    try {
      return big(plan.quote?.min_out);
    } catch {
      return 0n;
    }
  })();
  if (minOut <= 0n) fail("solana_swap.intent", "the plan carries no minimum output");

  // The slippage the owner allows, and the minimum that follows from it. The limit is the
  // plan's own slippage, and the owner's (`intent.slippage_bps`, when the caller gives it)
  // if that is lower; neither may exceed the kit's cap. The minimum shown to the owner must
  // not be looser than the quote less that slippage: the transaction is then held to it.
  const planSlip = plan.quote?.slippage_bps;
  const okSlip = (x) => Number.isInteger(x) && x >= 1 && x <= SLIPPAGE_BPS_MAX;
  if (!okSlip(planSlip)) fail("solana_swap.intent", `the plan's slippage limit ${planSlip} is not a whole number of basis points from 1 to ${SLIPPAGE_BPS_MAX}`);
  if (want.slippageBps !== undefined && !okSlip(want.slippageBps)) fail("solana_swap.intent", `the slippage limit asked for, ${want.slippageBps}, is not a whole number of basis points from 1 to ${SLIPPAGE_BPS_MAX}`);
  if (okSlip(planSlip) && okSlip(want.slippageBps ?? planSlip) && planSlip > (want.slippageBps ?? planSlip)) fail("solana_swap.min_out_not_enforced", `the plan allows ${planSlip} bps of slippage; the limit asked for is ${want.slippageBps} bps`);
  const slipCap = okSlip(planSlip) ? Math.min(planSlip, okSlip(want.slippageBps) ? want.slippageBps : planSlip) : 0;
  try {
    const quotedFloor = minOutFor(plan.quote.out_amount, slipCap);
    if (minOut < quotedFloor) fail("solana_swap.min_out_not_enforced", `the minimum output in the plan (${minOut}) is below the quote (${plan.quote.out_amount}) less the ${slipCap} bps slippage limit (${quotedFloor})`);
  } catch {
    fail("solana_swap.intent", "the plan carries no quoted output");
  }

  // The disclosed fee: pinned account, sane rate, never above what the plan shows the owner.
  // The fee is on the USDC or SOL side only: the input (buying, or USDC <-> SOL) or the output (selling a long-tail
  // token). Never in the long-tail token, whatever the plan says.
  const feeBps = plan.fee?.bps ?? 0;
  const { side: feeSide, leg: feeLeg } = feeSideOf(want.from, want.to);
  const pinnedFee = SATO_FEE_ACCOUNTS[feeSide.mint]; // undefined when neither side is major (already refused above)
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) fail("solana_swap.fee_account", `the fee rate ${feeBps} bps is outside 0-${FEE_BPS_MAX}`);
  if (feeBps > 0 && plan.fee.account !== pinnedFee) fail("solana_swap.fee_account", `the fee account ${plan.fee?.account} is not the pinned ${feeSide.symbol} referral account ${pinnedFee}`);
  if (feeBps > 0 && plan.fee.mint !== undefined && plan.fee.mint !== feeSide.mint) fail("solana_swap.fee_account", `the plan takes its fee in ${plan.fee.mint}; the fee is only ever taken in ${feeSide.symbol}`);
  if (feeBps > 0 && plan.fee.leg !== undefined && plan.fee.leg !== feeLeg) fail("solana_swap.fee_account", `the plan takes its fee from the ${plan.fee.leg}; for this swap it comes from the ${feeLeg}`);
  if (feeBps === 0 && plan.fee?.account) fail("solana_swap.fee_account", "a fee account is set but the plan discloses no fee");
  if (want.feeBps !== undefined && want.feeBps !== feeBps) fail("solana_swap.fee_not_as_disclosed", `the plan charges ${feeBps} bps; ${want.feeBps} bps was disclosed`);
  const feeAccount = feeBps > 0 ? pinnedFee : null;
  // An input fee is a share of the amount swapped, known now. An output fee is a share of what the pool pays out,
  // known from the simulation below.
  const maxFeeInput = (want.amountIn * BigInt(Math.max(0, feeBps)) + 9_999n) / 10_000n + (feeBps > 0 ? 1n : 0n);
  if (refusals.length) throw new Refused(refusals);

  // Decode, resolving the address lookup tables from the chain (the transaction alone cannot name its accounts).
  let altTables = {};
  let tx;
  try {
    tx = decodeTxBase64(plan.swap_transaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const tables = [...new Set((compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
    if (tables.length) altTables = await withTimeout(fetchAddressesForLookupTables(tables, r), 20_000);
  } catch (err) {
    throw new Refused([refuse("solana_swap.decode", `the transaction could not be decoded or its lookup tables read (${String(err.message).slice(0, 160)}); nothing was signed`)]);
  }
  const { refusals: staticRefusals, facts } = await inspectSolanaSwapTransaction(
    plan.swap_transaction,
    { agent: want.agent, mintIn: want.from.mint, mintOut: want.to.mint, amountIn: want.amountIn, feeAccount, feeBps, slippageBps: slipCap, minOut, tail: tail ? { mint: tail.mint, program: tail.program } : null },
    altTables,
  );
  if (staticRefusals.length) throw new Refused(staticRefusals);

  // (f) Simulation: unsigned, fresh blockhash, then compare the agent's balances before and after.
  const usdcAta = await derivedAta(want.agent, USDC_MINT);
  const wsolAta = await derivedAta(want.agent, WSOL_MINT);
  const tailAta = tail ? await derivedAta(want.agent, tail.mint, tail.program) : null;
  // The order matters to the read-back below: the wallet, USDC, wSOL, then the fee account and the token's account when there are any.
  const watch = [want.agent, usdcAta, wsolAta, ...(feeAccount ? [feeAccount] : []), ...(tailAta ? [tailAta] : [])];
  const tailEntry = tailAta ? () => ({ mint: tail.mint, label: tail.label, addr: tailAta, program: tail.program, entry: sim.accounts[watch.length - 1] }) : null;
  let sim;
  try {
    const res = await withTimeout(
      r.simulateTransaction(plan.swap_transaction, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { addresses: watch, encoding: "base64" },
      }).send(),
      20_000,
    );
    sim = res.value;
  } catch (err) {
    throw new Refused([refuse("solana_swap.sim_unavailable", `the simulation could not run (${String(err.message).slice(0, 160)}); a swap is not signed without one`)]);
  }
  if (sim.err) throw new Refused([refuse("solana_swap.sim_failed", `the simulation failed: ${jsonSafe(sim.err).slice(0, 200)}`)]);
  if (!sim.preBalances || !sim.postBalances || !sim.preTokenBalances || !sim.postTokenBalances) {
    throw new Refused([refuse("solana_swap.sim_unavailable", "the simulation returned no balances; a swap is not signed without them")]);
  }

  const loaded = sim.loadedAddresses ?? { writable: [], readonly: [] };
  const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (!sameList(loaded.writable ?? [], facts.lookup_loaded.writable) || !sameList(loaded.readonly ?? [], facts.lookup_loaded.readonly)) {
    throw new Refused([refuse("solana_swap.sim_inconsistent", "the accounts the simulation loaded do not match the lookup tables this kit read")]);
  }
  const view = { keys: facts.keys, preBalances: sim.preBalances, postBalances: sim.postBalances, preTokenBalances: sim.preTokenBalances, postTokenBalances: sim.postTokenBalances };
  const deltas = balanceDeltas(view, want.agent, tail ? tail.mint : null);
  // The `accounts` read-back must agree with the runtime's own balances (guards a mismatched response).
  const post0 = sim.accounts?.[0];
  if (!Array.isArray(sim.accounts) || sim.accounts.length !== watch.length || !post0 || big(post0.lamports) !== big(sim.postBalances[0])) {
    throw new Refused([refuse("solana_swap.sim_inconsistent", "the simulated account state does not match the simulated balances")]);
  }

  const simFee = big(sim.fee);
  const feeCeiling = BASE_FEE_LAMPORTS + facts.priority_lamports;
  const rule = [...checkAgentAccountsAfter({
    wallet: sim.accounts[0],
    tokens: [
      { mint: USDC_MINT, label: "USDC", addr: usdcAta, entry: sim.accounts[1] },
      { mint: WSOL_MINT, label: "wrapped SOL", addr: wsolAta, entry: sim.accounts[2] },
      ...(tailEntry ? [tailEntry()] : []),
    ],
  }, want.agent)];
  if (simFee > feeCeiling) rule.push(refuse("solana_swap.priority_fee", `the simulated network fee is ${simFee} lamports, above the ${feeCeiling} the instructions imply`));
  const overhead = simFee + deltas.created_usdc_rent;
  if (overhead > SOL_OVERHEAD_CAP_LAMPORTS) rule.push(refuse("solana_swap.sim_input_outflow", `fees and new-account rent total ${overhead} lamports, over the cap of ${SOL_OVERHEAD_CAP_LAMPORTS}`));
  // A new account for the long-tail token holds its rent-exempt minimum, which depends on the account's size
  // (a Token-2022 account with extensions is larger than a classic one) and no more.
  let tailRent = 0n;
  if (tail) {
    tailRent = deltas.created_tail_rent;
    if (tailRent > 0n) {
      const e = sim.accounts[watch.length - 1];
      const space = BigInt(Number.isFinite(Number(e?.space)) && e?.space !== undefined ? Number(e.space) : Buffer.from(String(e?.data?.[0] ?? ""), "base64").length);
      const rentMin = (space + 128n) * RENT_LAMPORTS_PER_BYTE_YEAR * 2n;
      if (space < BigInt(TOKEN_ACCOUNT_SIZE) || space > MAX_TAIL_ACCOUNT_BYTES || tailRent > rentMin) {
        rule.push(refuse("solana_swap.sim_input_outflow", `the new account for the token holds ${tailRent} lamports (${space} bytes); the most this kit allows is the rent-exempt minimum for a token account of up to ${MAX_TAIL_ACCOUNT_BYTES} bytes`));
      }
    }
  }
  const overheadAll = overhead + tailRent;

  // Input leaves, output arrives: each by the asset's own kind of account, and only the amount swapped (plus fees and rent for SOL).
  let grossOut;
  if (want.from.major === "USDC") {
    const out = -deltas.usdc.delta;
    if (out > want.amountIn) rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${out} USDC units, more than the ${want.amountIn} being swapped`));
    if (deltas.created_usdc_rent > 0n) rule.push(refuse("solana_swap.sim_input_outflow", "a USDC swap should not create a USDC account"));
  } else if (want.from.major === "SOL") {
    const out = -deltas.sol.delta;
    if (out > want.amountIn + overheadAll) rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${out} lamports, more than the ${want.amountIn} swapped plus ${overheadAll} of fees and rent`));
  } else {
    const out = -deltas.tail.delta;
    if (out > want.amountIn) rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${out} base units of the token, more than the ${want.amountIn} being swapped`));
  }
  if (want.to.major === "USDC") grossOut = deltas.usdc.delta;
  else if (want.to.major === "SOL") grossOut = deltas.sol.delta + simFee; // SOL received, before the network fee
  else grossOut = deltas.tail.delta; // the token as it lands (after any transfer fee the mint charges)
  // Whatever the asset swapped, SOL does not leave beyond the network fee and the rent of the accounts the swap creates.
  if (want.from.major !== "SOL" && want.to.major !== "SOL" && -deltas.sol.delta > overheadAll) {
    rule.push(refuse("solana_swap.sim_input_outflow", `the swap would take ${-deltas.sol.delta} lamports of SOL, more than the ${overheadAll} of fees and rent`));
  }
  if (grossOut < minOut) rule.push(refuse("solana_swap.sim_output_inflow", `the simulation delivers ${grossOut} ${want.to.label} base units, below the minimum of ${minOut}`));
  for (const o of deltas.others) if (o.delta < 0n) rule.push(refuse("solana_swap.sim_other_asset", `the swap would reduce the agent's balance of ${o.mint} by ${-o.delta}`));

  // The fee in the fee account: an input fee is within a share of the amount swapped; an output fee is within a share
  // of what the pool paid out (what reached the agent plus the fee itself).
  let feeObserved = null;
  let maxFee = feeLeg === "input" ? maxFeeInput : null;
  if (feeAccount) {
    const ch = tokenAccountChange(view, feeAccount);
    if (!ch || !ch.existed || ch.mint !== feeSide.mint) {
      rule.push(refuse("solana_swap.fee_account", `the fee account ${feeAccount} is not an initialised ${feeSide.symbol} token account in the simulation`));
    } else {
      feeObserved = ch.post - ch.pre;
      if (feeLeg === "output") maxFee = ((grossOut + feeObserved) * BigInt(feeBps) + 9_999n) / 10_000n + 1n;
      if (feeObserved < 0n || feeObserved > maxFee) rule.push(refuse("solana_swap.fee_account", `the simulated fee is ${feeObserved} ${feeSide.symbol} base units, outside the disclosed 0 to ${maxFee}`));
    }
  }
  if (rule.length) throw new Refused(rule);

  return {
    ok: true,
    programs: facts.programs.map((p) => ({ id: p, name: SWAP_PROGRAM_ALLOWLIST[p] })),
    lookup_tables: Object.keys(altTables).length,
    instruction_count: facts.instruction_count,
    priority_lamports: Number(facts.priority_lamports),
    // Read out of Jupiter's instruction data, not out of the plan.
    jupiter: {
      instruction: facts.route.instruction,
      route_steps: facts.route.steps,
      in_amount: facts.route.inAmount.toString(),
      quoted_out: facts.route.quotedOut.toString(),
      slippage_bps: facts.route.slippageBps,
      platform_fee_bps: facts.route.platformFeeBps,
      enforced_min_out: minOutFor(facts.route.quotedOut, facts.route.slippageBps).toString(),
    },
    simulated: {
      network_fee_lamports: simFee.toString(),
      input_outflow: (want.from.major === "USDC" ? -deltas.usdc.delta : want.from.major === "SOL" ? -deltas.sol.delta : -deltas.tail.delta).toString(),
      output_inflow: grossOut.toString(),
      min_out: minOut.toString(),
      created_usdc_rent_lamports: deltas.created_usdc_rent.toString(),
      created_token_rent_lamports: tail ? deltas.created_tail_rent.toString() : null,
      fee_observed_units: feeObserved === null ? null : feeObserved.toString(),
      // An input fee: the most the amount swapped allows. An output fee: the most the simulated payout allows.
      fee_disclosed_max_units: feeAccount ? maxFee.toString() : null,
      fee_leg: feeAccount ? feeLeg : null,
    },
    token: tail ? { mint: tail.mint, program: tail.program, program_name: tail.info.program_name, decimals: tail.decimals, extensions: tail.info.extensions, transfer_fee_bps: tail.info.transfer_fee?.bps ?? null, freeze_authority: tail.info.freeze_authority, mint_authority: tail.info.mint_authority } : null,
  };
}

// ---------------------------------------------------------------- execute

async function assertPlanFresh(plan, r, d) {
  const age = d.now() - plan.built_at;
  if (!(age >= 0) || age > PLAN_MAX_AGE_MS) throw new PlanStale(`the swap was built ${Math.round(age / 1000)} s ago and its blockhash is about to expire; rebuild it (nothing was signed)`);
  // Ask the chain about the blockhash that is in the bytes about to be signed. Jupiter's
  // `lastValidBlockHeight` is not consulted: it is a claim next to the transaction, not
  // part of it.
  let blockhash;
  try {
    blockhash = getCompiledTransactionMessageDecoder().decode(decodeTxBase64(plan.swap_transaction).messageBytes).lifetimeToken;
  } catch (err) {
    throw new Error(`the swap transaction could not be read to check its blockhash (${String(err.message).slice(0, 120)}); nothing was signed`);
  }
  let valid;
  try {
    valid = (await withTimeout(r.isBlockhashValid(blockhash, { commitment: "confirmed" }).send())).value;
  } catch (err) {
    throw new Error(`could not check that the swap's blockhash is still valid (${String(err.message).slice(0, 120)}); nothing was signed`);
  }
  if (valid !== true) throw new PlanStale("the swap's blockhash is no longer valid; rebuild it (nothing was signed)");
}

/** Where the agent ended up, from a confirmed transaction. Null when the chain read fails (never zero). */
async function actualOutput(sig, plan, r) {
  try {
    const t = await withTimeout(r.getTransaction(sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
    if (!t?.meta) return null;
    const loaded = t.meta.loadedAddresses ?? { writable: [], readonly: [] };
    const keys = [...t.transaction.message.accountKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
    const tailOut = plan.mint_out !== USDC_MINT && plan.mint_out !== WSOL_MINT ? plan.mint_out : null;
    const tailIn = plan.mint_in !== USDC_MINT && plan.mint_in !== WSOL_MINT ? plan.mint_in : null;
    const deltas = balanceDeltas({ keys, preBalances: t.meta.preBalances, postBalances: t.meta.postBalances, preTokenBalances: t.meta.preTokenBalances, postTokenBalances: t.meta.postTokenBalances }, plan.agent, tailOut ?? tailIn);
    if (tailOut) return deltas.tail.delta; // the token as it landed (after any transfer fee the mint charges)
    return plan.mint_out === USDC_MINT ? deltas.usdc.delta : deltas.sol.delta + big(t.meta.fee) + deltas.created_usdc_rent;
  } catch {
    return null;
  }
}

/**
 * Sign and send a verified plan, under the owner's limits. Same order as
 * `sendUsdc`: verify, reserve, sign, record the signature, broadcast, poll.
 *
 *   Refused     the limits (or the verification) said no; nothing signed
 *   PlanStale   the blockhash is too old; rebuild the plan; nothing reserved
 *   Rejected    the RPC's preflight refused it; it never went out; released
 *   Pending     it may have gone out: stays counted, do NOT retry
 *   Error       it failed onchain (released) or something failed before signing (released)
 *
 * deps: rpc, signer (default: the wallet's Solana key), policy (default: policy.json),
 * intent (default: the plan's own; also takes slippage_bps and fee_bps to hold the
 * transaction to what the owner asked for and Sato Hub disclosed), usdNotional
 * (REQUIRED: the oracle-sized USD value the limits are checked against; the plan's own
 * estimate is never used in its place), now, sleep, pollMs, maxPolls.
 */
export async function executeSolanaSwap(plan, deps = {}) {
  const d = withDefaults(deps);
  const r = d.rpc ?? defaultRpc();
  const usd = d.usdNotional;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error("usdNotional is required: the USD size of this swap, measured independently of the quote, so the owner's limits can be checked; nothing was signed");
  }

  await assertPlanFresh(plan, r, d);
  const verification = await verifySolanaSwapPlan(plan, d.intent, d);

  const entry = await reserve(d.policy ?? loadPolicy(), {
    kind: "swap",
    chain: "solana",
    usd,
    to: "jupiter",
    asset_in: plan.from,
    asset_out: plan.to,
    amount_in: plan.amount_in,
    min_out: plan.quote.min_out,
    slippage_bps: plan.quote.slippage_bps, // held to the owner's cap again, under the lock
  });

  let signed;
  try {
    // The clock may have run while verifying and reserving: look again right before signing.
    await assertPlanFresh(plan, r, d);
    const signer = d.signer ?? (await createKeyPairSignerFromBytes(solanaSecret()));
    if (signer.address !== plan.agent) throw new Error("the signing key is not the agent the plan was built for");
    const tx = await signTransaction([signer.keyPair], decodeTxBase64(plan.swap_transaction));
    signed = { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
  } catch (err) {
    release(entry, "failed before signing; nothing sent", { error: String(err.message) });
    throw err;
  }

  const { wire, signature } = signed;
  record({ id: entry.id, status: "signed", tx: signature });
  try {
    await withTimeout(r.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  } catch (err) {
    const msg = `${err.message} ${jsonSafe(err.context ?? {})}`;
    if (/PREFLIGHT_FAILURE|preflight|-32002|Blockhash not found|insufficient (funds|lamports)/i.test(msg)) {
      release(entry, "rejected by the RPC preflight; never sent", { tx: signature, error: String(err.message) });
      throw new Rejected(`the RPC refused ${signature}: ${err.message}`);
    }
    throw new Pending(`broadcast of ${signature} reported an error (${err.message}).`, { tx: signature, explorer: explorer(signature) });
  }

  const pollMs = d.pollMs ?? 1500;
  for (let i = 0; i < (d.maxPolls ?? 40); i++) {
    await d.sleep(pollMs);
    let s;
    try {
      s = (await withTimeout(r.getSignatureStatuses([signature]).send())).value[0];
    } catch {
      continue; // a flaky status read is not a failed transaction
    }
    if (s?.err) {
      release(entry, "transaction failed onchain", { tx: signature });
      throw new Error(`transaction failed onchain: ${explorer(signature)}`);
    }
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      const out = await actualOutput(signature, plan, r);
      record({ id: entry.id, status: "confirmed", tx: signature, amount_out: out === null ? null : out.toString() });
      return {
        tx: signature,
        explorer: explorer(signature),
        usd,
        asset_in: plan.from,
        asset_out: plan.to,
        amount_in: plan.amount_in,
        amount_out: out === null ? null : out.toString(),
        min_out: plan.quote.min_out,
        fee: plan.fee,
        verification,
      };
    }
  }
  throw new Pending(`${signature} was sent but not confirmed within ${Math.round(((d.maxPolls ?? 40) * pollMs) / 1000)} s.`, { tx: signature, explorer: explorer(signature) });
}

// ---------------------------------------------------------------- dry run

/**
 * Plan and verify; reserve nothing, sign nothing, send nothing. Calls Jupiter's
 * public quote/build API and the RPC's simulation, both read-only. The returned
 * plan omits the transaction bytes unless `deps.includeTransaction` is set.
 */
export async function dryRunSolanaSwap(params, deps = {}) {
  const d = withDefaults(deps);
  const plan = await planSolanaSwap(params, d);
  const verification = await verifySolanaSwapPlan(plan, { agent: plan.agent, from: plan.from, to: plan.to, amount_in: plan.amount_in }, d);
  const { swap_transaction: tx, ...rest } = plan;
  return { dry_run: true, chain: "solana", plan: d.includeTransaction ? plan : rest, verification, simulated: true, usd: plan.usd_estimate };
}
