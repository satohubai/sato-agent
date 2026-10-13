// `send --asset` on Solana: native SOL, USDC, wrapped SOL, or ANY SPL / Token-2022 mint. The mint is read from the chain (its program,
// decimals and, for Token-2022, its extensions): never from a resolver.
//
//   plan     resolve the asset, read the balances, work out the amount (`all` of SOL keeps the rent-exempt minimum and a fee reserve),
//            put the USD figure the limits see on it, build and sign the transaction in memory, and simulate it. The recipient's
//            associated token account is created only if it is missing, and its rent is shown. A Token-2022 transfer fee, transfer
//            hook or permanent delegate is shown.
//   execute  reserve against the limits, record the signature, broadcast, poll: the same tail every Solana spend shares
//            (`broadcastAndConfirm`, src/solana.js). A send is never retried.
//
// USD for the limits: USDC 1:1; SOL and wrapped SOL from the Chainlink feed (no feed, no send); any other mint has no price here: it counts
// $0 against the limits and is recorded `usd: null`, `unpriced: true`. It is never refused for lacking a price.

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { Refused } from "../errors.js";
import { loadPolicy } from "../policy.js";
import { release, reserve } from "../ledger.js";
import { PriceUnavailable, oraclePrice } from "../price.js";
import { unitsToText, unitsToUsd } from "../amount.js";
import { loadWallet, solanaSecret } from "../wallet.js";
import { otherStableByMint, otherStablesOf } from "../chains.js";
import { TOKEN_2022_PROGRAM, USDC_MINT, broadcastAndConfirm, explorer, rpc as defaultRpc } from "../solana.js";
import { WSOL_MINT, parseMintAccount, solLamports, tokenUnits } from "../swap/solana.js";
import { clean } from "../text.js";
import { ledgerSpend, refuse, tokenLabel, usdUp } from "./common.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** What an account with no data must hold to stay open (Solana's rent-exempt minimum for 0 bytes), if the RPC cannot say. */
const RENT_EXEMPT_ZERO_LAMPORTS = 890_880n;
/** The rent of a classic token account (165 bytes), if the RPC cannot say. */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** The network fee of a transaction with one signature. The kit adds no priority fee to a send. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** `send --amount all` of SOL keeps the rent-exempt minimum and twice the network fee. */
export const FEE_RESERVE_FACTOR = 2n;
const TRANSFER_FEE_BPS_DENOMINATOR = 10_000n;

const solText = (lamports) => unitsToText(lamports, 9);
const shortMint = (m) => `${String(m).slice(0, 4)}…${String(m).slice(-4)}`;
const jsonSafe = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** The issuer's powers and charges on a Token-2022 mint, in plain words (shown, not blocked). */
function describePowers(info) {
  const notes = [];
  const powers = [];
  const d = info.extension_details ?? {};
  if (info.extensions.includes("PermanentDelegate")) {
    powers.push("PermanentDelegate");
    notes.push(`This Token-2022 mint has a permanent delegate${d.PermanentDelegate?.delegate ? ` (${d.PermanentDelegate.delegate})` : ""}: the issuer can move or burn this token in any wallet, this one and the recipient's.`);
  }
  if (d.TransferHook?.program_id) {
    powers.push("TransferHook");
    notes.push(`This Token-2022 mint has a transfer hook (${d.TransferHook.program_id}): the issuer's program runs on every transfer and can block it.`);
  } else if (info.extensions.includes("TransferHook")) {
    notes.push("This Token-2022 mint has a transfer hook extension with no program set.");
  }
  if (info.freeze_authority) notes.push(`A freeze authority is set (${info.freeze_authority}): it can freeze a token account for this mint, this wallet's or the recipient's.`);
  if (d.PausableConfig) notes.push(`Transfers of this mint can be paused by ${d.PausableConfig.authority ?? "its authority"}.`);
  return { notes, powers };
}

/** The asset a send names, read from the chain. No `--asset` means USDC. */
export async function resolveSolanaAsset(raw, r) {
  let input = raw === undefined || raw === null || raw === "" ? "USDC" : String(raw).trim();
  // USDT and PYUSD (the registry's extra stablecoins) can be named by symbol; they are then read by their mint.
  const listed = otherStablesOf("solana").find((o) => o.symbol.toLowerCase() === input.toLowerCase());
  if (listed) input = listed.mint;
  if (/^sol$/i.test(input)) return { kind: "native", symbol: "SOL", name: "Solana", mint: null, address: null, decimals: 9, label: "SOL", id: "SOL", program: null, info: null };
  if (/^usdc$/i.test(input) || input === USDC_MINT) return { kind: "stable", symbol: "USDC", name: "USD Coin", mint: USDC_MINT, address: USDC_MINT, decimals: 6, label: "USDC", id: "USDC", program: TOKEN_PROGRAM_ADDRESS, info: null };
  if (!isAddress(input)) throw new Error(`--asset: "${clean(input, 60)}" is not SOL, USDC or a Solana mint address (a base58 address, 32 to 44 characters)`);
  let value;
  try {
    ({ value } = await withTimeout(r.getAccountInfo(address(input), { encoding: "base64", commitment: "confirmed" }).send()));
  } catch (err) {
    throw new Error(`the mint ${input} could not be read from the chain (${String(err.message).slice(0, 160)}); nothing was signed`);
  }
  let info;
  try {
    info = parseMintAccount(value, input);
  } catch (err) {
    if (!err.refusals) throw err;
    throw refuse("asset_not_a_mint", `--asset ${shortMint(input)}: ${String(err.refusals[0].message).split("; the kit")[0]}; nothing was signed`, null, input);
  }
  // What stops a transfer outright is refused; a new account that starts frozen is only told (describePowers).
  const stops = (info.refusals ?? []).filter((x) => !/DefaultAccountState/.test(x.message));
  if (stops.length) throw new Refused(stops.map((x) => ({ ...x, rule: "send.token_extension_refused" })));
  const wrapped = input === WSOL_MINT;
  const known = otherStableByMint(input);
  if (known) {
    // Counted 1:1 on the registry's word for WHICH mint this is; the chain's program and decimals must agree with the pin.
    if (info.decimals !== known.decimals || info.program !== known.program) {
      throw refuse("stable_mismatch", `the mint ${shortMint(input)} is ${info.program_name} with ${info.decimals} decimals, but the kit pins ${known.symbol} as ${known.program === TOKEN_2022_PROGRAM ? "Token-2022" : "Token"} with ${known.decimals}; it is not counted as a stablecoin and nothing was signed`);
    }
    return { kind: "stable", symbol: known.symbol, name: null, mint: input, address: input, decimals: info.decimals, label: tokenLabel(known.symbol, input, 4), id: input, program: info.program, info };
  }
  return {
    kind: wrapped ? "wrapped" : "token",
    symbol: wrapped ? "wSOL" : shortMint(input),
    name: null,
    mint: input,
    address: input,
    decimals: info.decimals,
    label: wrapped ? "wSOL" : tokenLabel(null, input, 4),
    id: wrapped ? "wSOL" : input,
    program: info.program,
    info,
  };
}

/** Token-2022's own fee on `units` (ceil(units x bps / 10,000), at most the mint's maximum). */
export function transferFeeOn(units, bps, maximum) {
  if (bps === 0 || units === 0n) return 0n;
  const raw = (units * BigInt(bps) + TRANSFER_FEE_BPS_DENOMINATOR - 1n) / TRANSFER_FEE_BPS_DENOMINATOR;
  return raw > maximum ? maximum : raw;
}

/** The size of an associated token account for a mint: 165 bytes, plus (Token-2022) the account-type byte and the extensions its mint needs. */
export function tokenAccountSize(info, program) {
  if (program !== TOKEN_2022_PROGRAM) return 165n;
  let size = 165 + 1 + 4; // account type, ImmutableOwner (every associated token account has it)
  const ext = info?.extensions ?? [];
  if (ext.includes("TransferFeeConfig")) size += 4 + 8;
  if (ext.includes("TransferHook")) size += 4 + 1;
  if (ext.includes("NonTransferable")) size += 4;
  if (ext.includes("PausableConfig")) size += 4;
  return BigInt(size);
}

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** SystemProgram.transfer, built by hand (the instruction is a u32 index and a u64). */
function systemTransferIx({ signer, to, lamports }) {
  const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(lamports)]);
  return { programAddress: address(SYSTEM_PROGRAM), accounts: [{ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer }, { address: address(to), role: AccountRole.WRITABLE }], data: new Uint8Array(data) };
}

/** Token-2022's TransferCheckedWithFee: like TransferChecked, but it names the fee it expects and fails if the mint charges another. */
function transferCheckedWithFeeIx({ signer, source, mint, destination, units, decimals, fee }) {
  const data = Buffer.concat([Buffer.from([26, 1]), u64le(units), Buffer.from([decimals]), u64le(fee)]);
  return {
    programAddress: address(TOKEN_2022_PROGRAM),
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: address(mint), role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: signer.address, role: AccountRole.READONLY_SIGNER, signer },
    ],
    data: new Uint8Array(data),
  };
}

/** The accounts a transfer hook is run with when its list of extra accounts is empty: the validation account and the hook's program. */
async function hookAccounts(mint, hookProgram) {
  const [validation] = await getProgramDerivedAddress({ programAddress: address(hookProgram), seeds: [new TextEncoder().encode("extra-account-metas"), getAddressEncoder().encode(address(mint))] });
  return [
    { address: validation, role: AccountRole.READONLY },
    { address: address(hookProgram), role: AccountRole.READONLY },
  ];
}

/**
 * The send as a transaction message for `signer`. A plan or a dry run passes a NOOP signer (the wallet's address and no key): the message
 * is the same one, it is only compiled, and `simulateTransaction` runs it with `sigVerify: false`. `executeSolanaSend` passes the real signer.
 */
export async function buildSolanaMessage({ signer, to, asset, units, blockhash, createAta, fee = null, hook = null }) {
  let instructions;
  if (asset.kind === "native") {
    instructions = [systemTransferIx({ signer, to, lamports: units })];
  } else {
    const mint = address(asset.mint);
    const tokenProgram = address(asset.program);
    const owner = address(to);
    const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram });
    const [destination] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
    const transfer =
      fee !== null
        ? transferCheckedWithFeeIx({ signer, source, mint, destination, units, decimals: asset.decimals, fee })
        : getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: units, decimals: asset.decimals }, { programAddress: tokenProgram });
    const extras = hook ? await hookAccounts(asset.mint, hook) : [];
    instructions = [
      ...(createAta ? [getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner, mint, tokenProgram })] : []),
      extras.length ? { ...transfer, accounts: [...transfer.accounts, ...extras] } : transfer,
    ];
  }
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** The unsigned transaction, base64: every signature slot zero. This is the only form a plan or a dry run ever hands to an RPC. */
export const unsignedWire = (message) => getBase64EncodedWireTransaction(compileTransaction(message));

/** Build and sign the send. Only `executeSolanaSend` calls this, after the limits, the approval and the reservation. */
export async function buildSolanaSend({ secret, signer: given, ...spec }) {
  const signer = given ?? (await createKeyPairSignerFromBytes(secret));
  const message = await buildSolanaMessage({ ...spec, signer });
  const tx = await signTransactionMessageWithSigners(message);
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), from: signer.address };
}

/**
 * Work out one Solana send and prove it would go through. Reads the chain; reserves and broadcasts nothing (the transaction is signed in
 * memory so the RPC can simulate it).
 *
 * req:  { to, amount ("1.5" | "all"), asset (SOL, USDC, a mint; none = USDC) }
 * deps: { rpc, secret, oraclePrice }  (tests)
 */
export async function planSolanaSend({ to, amount, asset: rawAsset }, deps = {}) {
  const r = deps.rpc ?? defaultRpc();
  if (!isAddress(to)) throw new Error(`not a Solana address: ${to}`);
  // A plan needs the wallet's ADDRESS only. The key is not touched until `executeSolanaSend`.
  const me = deps.agent ?? loadWallet().solana.address;
  const asset = await resolveSolanaAsset(rawAsset, r);
  const native = asset.kind === "native";
  const all = /^all$/i.test(String(amount));
  const read = async (what, p) => {
    try {
      return await withTimeout(p);
    } catch (err) {
      throw new Error(`could not read ${what} from Solana (${String(err.message).slice(0, 160)}); nothing was signed`);
    }
  };

  const lamports = BigInt((await read("the wallet's SOL balance", r.getBalance(address(me), { commitment: "confirmed" }).send())).value);
  let rentZero = RENT_EXEMPT_ZERO_LAMPORTS;
  try {
    rentZero = BigInt(await withTimeout(r.getMinimumBalanceForRentExemption(0n).send()));
  } catch {
    /* the pinned figure */
  }

  let oracle = null;
  if (native || asset.kind === "wrapped") {
    try {
      oracle = await (deps.oraclePrice ?? oraclePrice)("SOL", {});
    } catch (err) {
      if (err instanceof PriceUnavailable) throw refuse("price_unavailable", `no independent SOL price right now (${err.message}); the kit does not send ${asset.symbol} without one`);
      throw err;
    }
  }

  const notes = [];
  let units;
  let stays = null;
  let rent = null;
  let createAta = false;
  let fee = null;
  let received = null;
  let hook = null;
  let powers = [];
  let spendLamports = SIGNATURE_FEE_LAMPORTS; // what leaves the wallet besides the amount: the network fee and any new account's rent

  if (native) {
    if (all) {
      units = lamports - rentZero - SIGNATURE_FEE_LAMPORTS * FEE_RESERVE_FACTOR;
      if (units <= 0n) throw refuse("nothing_to_send", `the wallet holds ${solText(lamports)} SOL; after keeping the ${solText(rentZero)} SOL a wallet must hold to stay open and the network fee, nothing would be left to send`, null, solText(lamports));
      stays = { lamports: lamports - units, text: `${solText(lamports - units)} SOL` };
      notes.push(`Sending everything except ${stays.text}, which stays in the wallet: the ${solText(rentZero)} SOL a wallet must hold to stay open, and a reserve for the network fee.`);
    } else {
      units = solLamports(amount);
    }
    if (units + SIGNATURE_FEE_LAMPORTS > lamports) {
      throw refuse("insufficient_balance", `the wallet holds ${solText(lamports)} SOL, less than the ${solText(units)} SOL asked for plus the network fee; nothing was signed`, solText(lamports), solText(units));
    }
    const left = lamports - units - SIGNATURE_FEE_LAMPORTS;
    if (left > 0n && left < rentZero) {
      throw refuse("below_rent_minimum", `after this send the wallet would hold ${solText(left)} SOL, less than the ${solText(rentZero)} SOL a wallet must hold to stay open; send a smaller amount, or --amount all`, solText(rentZero), solText(left));
    }
    const dest = (await read("the recipient's account", r.getAccountInfo(address(to), { encoding: "base64", commitment: "confirmed" }).send())).value;
    if (!dest && units < rentZero) {
      throw refuse("below_rent_minimum", `${to} holds no SOL yet, and a first transfer to an address must be at least ${solText(rentZero)} SOL for the account to open; nothing was signed`, solText(rentZero), solText(units));
    }
  } else {
    // Which token account the wallet sends from: the standard (associated) one; the kit does not guess among others.
    const [source] = await findAssociatedTokenPda({ owner: me, mint: address(asset.mint), tokenProgram: address(asset.program) });
    const held = (await read("the wallet's token accounts", r.getTokenAccountsByOwner(address(me), { mint: address(asset.mint) }, { encoding: "jsonParsed" }).send())).value;
    const standard = held.find((a) => a.pubkey === source);
    const total = held.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const balance = standard ? BigInt(standard.account.data.parsed.info.tokenAmount.amount) : 0n;
    if (!standard && total > 0n) {
      throw refuse("token_account_not_standard", `the wallet holds ${asset.label} in a token account that is not its standard one (${source}); this kit sends from the standard account only. Nothing was signed.`);
    }
    if (all) {
      units = balance;
      if (units <= 0n) throw refuse("no_balance", `the wallet holds none of ${asset.label}, so there is nothing to send`);
      notes.push("Sending the whole balance.");
    } else {
      units = tokenUnits(amount, asset.decimals, asset.symbol);
      if (units > balance) {
        throw refuse("insufficient_balance", `the wallet holds ${unitsToText(balance, asset.decimals)} ${asset.label}, less than the ${unitsToText(units, asset.decimals)} asked for; nothing was signed`, unitsToText(balance, asset.decimals), unitsToText(units, asset.decimals));
      }
    }

    // Token-2022: what the mint charges and what its issuer can do. A transfer fee is worked out for this amount.
    const info = asset.info;
    if (info) {
      const d = describePowers(info);
      powers = d.powers;
      notes.push(...d.notes);
      if (info.transfer_fee) {
        let epoch;
        try {
          epoch = BigInt((await withTimeout(r.getEpochInfo({ commitment: "confirmed" }).send())).epoch);
        } catch (err) {
          throw new Error(`could not read the current epoch from Solana (${String(err.message).slice(0, 120)}), which this token's transfer fee depends on; nothing was signed`);
        }
        const applies = BigInt(info.transfer_fee.newer.epoch) <= epoch ? info.transfer_fee.newer : info.transfer_fee.older;
        fee = transferFeeOn(units, applies.bps, BigInt(applies.maximum_fee));
        received = { units: units - fee, text: unitsToText(units - fee, asset.decimals) };
        notes.push(`This Token-2022 mint charges a transfer fee of ${applies.bps / 100}% (at most ${applies.maximum_fee} base units): the recipient would receive ${received.text} of the ${unitsToText(units, asset.decimals)} sent (${unitsToText(fee, asset.decimals)} less).`);
      }
      hook = info.extension_details?.TransferHook?.program_id ?? null;
    }

    // The recipient's associated token account: created only if it is missing, and its rent is shown.
    const [destination] = await findAssociatedTokenPda({ owner: address(to), mint: address(asset.mint), tokenProgram: address(asset.program) });
    const destInfo = (await read("the recipient's token account", r.getAccountInfo(destination, { encoding: "base64", commitment: "confirmed" }).send())).value;
    if (!destInfo) {
      // A mint whose new accounts start frozen would leave the recipient with a frozen account: what arrives could not be moved until the
      // issuer thaws it. Creating that account is refused; to a recipient who already has one, the send is fine.
      if (info?.extension_details?.DefaultAccountState?.state === "frozen") {
        throw refuse("recipient_account_would_be_frozen", `${asset.label} starts every new token account frozen, and ${shortMint(to)} has none yet, so what arrives could not be moved until the issuer thaws it; nothing was signed`, null, to);
      }
      createAta = true;
      let lam = TOKEN_ACCOUNT_RENT_LAMPORTS;
      try {
        lam = BigInt(await withTimeout(r.getMinimumBalanceForRentExemption(tokenAccountSize(info, asset.program)).send()));
      } catch {
        if (asset.program === TOKEN_2022_PROGRAM) throw new Error("could not read the rent for the recipient's new token account from Solana; nothing was signed");
      }
      rent = { lamports: lam, text: solText(lam) };
      spendLamports += lam;
      notes.push(`The recipient has no token account for this token yet. This wallet pays about ${rent.text} SOL in rent to create it (a cost beyond the amount; not counted against your USD limits).`);
    }
    if (lamports < spendLamports || (lamports - spendLamports > 0n && lamports - spendLamports < rentZero)) {
      throw refuse("not_enough_sol", `the wallet holds ${solText(lamports)} SOL; this send needs about ${solText(spendLamports)} SOL for the network fee${rent ? " and the recipient's new token account" : ""}, and the wallet must keep at least ${solText(rentZero)} SOL or be empty. Add a little SOL and try again (nothing was signed).`, solText(spendLamports), solText(lamports));
    }
  }

  // USD for the limits.
  let usd = null;
  let unpriced = false;
  let valuation;
  if (asset.kind === "stable") {
    usd = unitsToUsd(units, asset.decimals);
    valuation = { basis: "stable" };
  } else if (oracle) {
    usd = usdUp(Number(unitsToText(units, asset.decimals)) * oracle.usd);
    valuation = { basis: "oracle", oracle: { asset: "SOL", usd: oracle.usd, age_s: oracle.age_s, source: oracle.source } };
  } else {
    unpriced = true;
    valuation = { basis: "none" };
  }

  // Simulate the transaction UNSIGNED (no signature at all, `sigVerify: false`, a fresh blockhash the node substitutes): nothing a
  // plan or a dry run sends to an RPC can be broadcast. The real transaction is signed in `executeSolanaSend`, after the limits, the
  // owner's approval and the reservation. A simulation that fails refuses the send.
  const { value: blockhash } = await read("a recent blockhash", r.getLatestBlockhash({ commitment: "confirmed" }).send());
  const spec = { to, asset, units, createAta, fee, hook };
  const wire = unsignedWire(await buildSolanaMessage({ signer: createNoopSigner(address(me)), blockhash, ...spec }));
  const sim = await read("the simulation", r.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send());
  if (sim.value.err) throw refuse("simulation_failed", `the simulation of this transfer failed (${jsonSafe(sim.value.err).slice(0, 200)}); nothing was signed or sent`, null, jsonSafe(sim.value.err).slice(0, 200));

  return {
    chain: "solana",
    from: me,
    to,
    asset,
    all,
    units,
    amountText: unitsToText(units, asset.decimals),
    usd,
    unpriced,
    valuation,
    received,
    notes,
    powers,
    stays,
    rent,
    spec,
    unsignedWire: wire,
    explorer,
  };
}

/**
 * Reserve the send against the limits, THEN sign it with a fresh blockhash, record the signature, broadcast, poll. Never retried; unclear
 * stays counted (Pending). The key is first used here: after the limits, the approval and the reservation.
 */
export async function executeSolanaSend(plan, deps = {}) {
  const r = deps.rpc ?? defaultRpc();
  const entry = await reserve(deps.policy ?? loadPolicy(), ledgerSpend(plan));
  let built;
  try {
    // The key must be the wallet the plan was made for: the plan checked THAT wallet's balances and simulated ITS transfer.
    const signer = await createKeyPairSignerFromBytes(deps.secret ?? solanaSecret());
    if (signer.address !== plan.from) {
      throw new Error(`the signing key's address (${shortMint(signer.address)}) is not the wallet this send was planned for (${shortMint(plan.from)}); nothing was signed`);
    }
    const { value: blockhash } = await withTimeout(r.getLatestBlockhash({ commitment: "confirmed" }).send());
    built = await buildSolanaSend({ signer, blockhash, ...plan.spec });
  } catch (err) {
    release(entry, "failed before signing; nothing sent", { error: String(err.message) });
    throw err;
  }
  const out = await broadcastAndConfirm(entry, built, r, deps.confirm ?? {});
  return { tx: out.tx, explorer: out.explorer };
}
