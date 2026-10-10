// A Solana transaction someone else built for the agent to sign: the Crossmint
// payment behind an Amazon order, or a Solana Pay transaction request from a
// merchant. Both are untrusted bytes. Nothing is signed until:
//
//   static     it decodes (legacy or v0, lookup tables read from the chain); every
//              top-level program is on a short list (Token, Token-2022, Associated
//              Token, ComputeBudget, Memo; System only for a Solana Pay request, and
//              then only a plain SOL transfer); a token instruction is only a transfer
//              (never an approval, a new authority, a close or a burn); the priority
//              fee is capped; the agent is a signer, and every other signer has ALREADY
//              signed (its signature is checked), so the only signature added is the agent's.
//   simulated  the RPC runs it (no signature check, the transaction's own blockhash):
//              what leaves the agent's wallet is read from the runtime's own balances.
//              The caller caps the USDC and SOL that may leave; no other token may leave;
//              the agent's USDC account must end with no delegate and no close authority.
//
// The simulation is the binding check, so the checks hold whatever shape the transaction
// has (a plain transfer, or a call into a program the merchant uses through CPI).

import {
  address,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getAddressDecoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSignerRole,
  signTransaction,
  verifySignature,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { Refused } from "./errors.js";
import { TOKEN_2022_PROGRAM, USDC_MINT } from "./solana.js";
import { PRIORITY_MAX_LAMPORTS, balanceDeltas } from "./swap/solana.js";
import { solanaSecret } from "./wallet.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxTfJ";
const BASE_FEE_PER_SIGNATURE = 5_000n;
/** Rent of one 165-byte token account: what creating the payee's USDC account can cost the agent. */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;

export const PURCHASE_PROGRAMS = Object.freeze({
  [TOKEN_PROGRAM_ADDRESS]: "Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [ATA_PROGRAM]: "Associated Token",
  [COMPUTE_BUDGET_PROGRAM]: "ComputeBudget",
  [MEMO_PROGRAM]: "Memo",
  [MEMO_V1_PROGRAM]: "Memo (v1)",
});

const r = (rule, message) => ({ rule, limit: null, observed: null, message });
const withTimeout = (p, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms} ms`)), ms);
    Promise.resolve(p).then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
const u32 = (d, at = 1) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);
const u64 = (d, at = 1) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const big = (x) => BigInt(typeof x === "number" ? Math.trunc(x) : (x ?? 0));

export async function agentUsdcAccount(agent) {
  const [ata] = await findAssociatedTokenPda({ owner: address(agent), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

/** Wire bytes from base64 (the default) or base58. Throws on anything else. */
export function decodeWire(text, encoding = "base64") {
  if (typeof text !== "string" || text.length > 4000) throw new Error("the transaction is not a string of reasonable size");
  let bytes;
  if (encoding === "base58") {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) throw new Error("the transaction is not base58");
    bytes = getBase58Encoder().encode(text);
  } else if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("the transaction is not base64");
    bytes = new Uint8Array(Buffer.from(text, "base64"));
  } else throw new Error(`unknown transaction encoding "${String(encoding).slice(0, 20)}"`);
  return getTransactionDecoder().decode(bytes);
}

/**
 * Static checks. opts: { agent, allowSystem (Solana Pay only), requireAgentFeePayer }. Returns facts, or throws
 * Refused with every problem found. deps: { rpc } (to read lookup tables, only when the transaction uses them).
 */
export async function inspectPurchaseTx(tx, { agent, allowSystem = false, requireAgentFeePayer = false }, { rpc } = {}) {
  const out = [];
  let compiled;
  let message;
  let alts = {};
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const tables = [...new Set((compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress))];
    if (tables.length) {
      if (!rpc) throw new Error("it uses lookup tables and no RPC was given to read them");
      alts = await withTimeout(fetchAddressesForLookupTables(tables, rpc));
    }
    message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: alts });
  } catch (err) {
    throw new Refused([r("purchase_tx.decode", `the transaction could not be decoded (${String(err.message).slice(0, 160)}); nothing was signed`)]);
  }
  if (compiled.version !== "legacy" && compiled.version !== 0) out.push(r("purchase_tx.version", `unsupported transaction version ${compiled.version}`));
  const statics = compiled.staticAccounts.map(String);
  const nSigners = compiled.header.numSignerAccounts;
  const signers = statics.slice(0, nSigners);
  const feePayer = statics[0];
  if (!signers.includes(agent)) out.push(r("purchase_tx.signers", "the agent is not a signer of this transaction"));
  if (requireAgentFeePayer && feePayer !== agent) out.push(r("purchase_tx.fee_payer", `the fee payer is ${feePayer}, not the agent`));
  // Every other signer must already have signed, with a signature that verifies: the agent's is the only one added.
  const partial = [];
  for (const s of signers) {
    if (s === agent) continue;
    const sig = tx.signatures[s];
    if (!sig) {
      out.push(r("purchase_tx.signers", `the transaction also needs a signature from ${s}, which it does not carry; only the agent signs here`));
      continue;
    }
    let ok = false;
    try {
      ok = await verifySignature(await getPublicKeyFromAddress(address(s)), sig, tx.messageBytes);
    } catch {
      ok = false;
    }
    if (!ok) out.push(r("purchase_tx.signers", `the signature already on the transaction from ${s} does not verify`));
    else partial.push(s);
  }

  const lookups = compiled.addressTableLookups ?? [];
  const writable = lookups.flatMap((l) => l.writableIndexes.map((i) => String(alts[l.lookupTableAddress][i])));
  const readonly = lookups.flatMap((l) => l.readonlyIndexes.map((i) => String(alts[l.lookupTableAddress][i])));
  const keys = [...statics, ...writable, ...readonly];
  const usdcAta = await agentUsdcAccount(agent);
  const programs = [];
  let limit = null;
  let price = null;
  let nonBudget = 0;
  let systemLamportsFromAgent = 0n;
  const systemPayees = [];

  for (const [n, ix] of message.instructions.entries()) {
    const prog = String(ix.programAddress);
    const data = ix.data ?? new Uint8Array();
    const accts = (ix.accounts ?? []).map((a) => ({ ...a, address: String(a.address) }));
    if (!programs.includes(prog)) programs.push(prog);
    for (const a of accts) if (isSignerRole(a.role) && a.address !== agent && !partial.includes(a.address)) out.push(r("purchase_tx.signers", `instruction ${n} needs a signature from ${a.address}`));
    const allowed = PURCHASE_PROGRAMS[prog] || (allowSystem && prog === SYSTEM_PROGRAM);
    if (!allowed) {
      out.push(r("purchase_tx.program_allowlist", `instruction ${n} calls ${prog}, which is not an allowed program (allowed: ${[...Object.values(PURCHASE_PROGRAMS), ...(allowSystem ? ["System"] : [])].join(", ")})`));
      continue;
    }
    if (prog !== COMPUTE_BUDGET_PROGRAM) nonBudget++;
    if (prog === COMPUTE_BUDGET_PROGRAM) {
      const t = data[0];
      if (t === 2 && data.length === 5) {
        if (limit !== null) out.push(r("purchase_tx.priority_fee", "two compute-unit-limit instructions"));
        limit = u32(data);
      } else if (t === 3 && data.length === 9) {
        if (price !== null) out.push(r("purchase_tx.priority_fee", "two compute-unit-price instructions"));
        price = u64(data);
      } else if (!((t === 1 || t === 4) && data.length === 5)) out.push(r("purchase_tx.compute_budget", `instruction ${n} is a ComputeBudget instruction this kit does not allow (type ${t})`));
    } else if (prog === SYSTEM_PROGRAM) {
      // A plain SOL transfer only: nothing that creates, assigns or reallocates an account.
      if (data.length === 12 && u32(data, 0) === 2) {
        if (accts[0]?.address === agent) {
          systemLamportsFromAgent += u64(data, 4);
          if (accts[1]?.address && !systemPayees.includes(accts[1].address)) systemPayees.push(accts[1].address);
        }
      } else out.push(r("purchase_tx.system_instruction", `instruction ${n} is a System instruction other than a plain SOL transfer`));
    } else if (prog === ATA_PROGRAM) {
      const t = data.length === 0 ? 0 : data[0];
      if (t !== 0 && t !== 1) out.push(r("purchase_tx.ata_instruction", `instruction ${n} is an Associated Token instruction other than creating an account`));
    } else if (prog === TOKEN_PROGRAM_ADDRESS || prog === TOKEN_2022_PROGRAM) {
      const t = data[0];
      if (t === 12) {
        // TransferChecked: source, mint, destination, authority. Out of the agent's accounts, only USDC.
        if (accts[3]?.address === agent && accts[1]?.address !== USDC_MINT) out.push(r("purchase_tx.token_mint", `instruction ${n} moves a token other than USDC (${accts[1]?.address}) out of the agent's wallet`));
      } else if (t === 3) {
        // Transfer (no mint named): out of the agent's accounts, only from its USDC account.
        if (accts[2]?.address === agent && accts[0]?.address !== usdcAta) out.push(r("purchase_tx.token_mint", `instruction ${n} moves tokens out of an agent account that is not its USDC account`));
      } else {
        const name = { 4: "Approve", 13: "ApproveChecked", 6: "SetAuthority", 9: "CloseAccount", 8: "Burn", 15: "BurnChecked", 7: "MintTo", 10: "FreezeAccount" }[t] ?? `type ${t}`;
        out.push(r("purchase_tx.token_instruction", `instruction ${n} is a token ${name} instruction; a payment only transfers USDC`));
      }
    }
  }
  const effLimit = BigInt(limit ?? Math.min(200_000 * Math.max(1, nonBudget), 1_400_000));
  const priorityLamports = price === null ? 0n : (price * effLimit + 999_999n) / 1_000_000n;
  if (priorityLamports > BigInt(PRIORITY_MAX_LAMPORTS)) out.push(r("purchase_tx.priority_fee", `the priority fee would be ${priorityLamports} lamports, over the cap of ${PRIORITY_MAX_LAMPORTS}`));
  if (out.length) throw new Refused(out);
  // What the agent pays the network, when it is the fee payer: a base fee per signature plus the priority fee.
  const networkFee = feePayer === agent ? BASE_FEE_PER_SIGNATURE * BigInt(nSigners) + priorityLamports : 0n;
  return {
    compiled,
    keys,
    lookup_loaded: { writable, readonly },
    fee_payer: feePayer,
    agent_pays_fee: feePayer === agent,
    partial_signers: partial,
    programs: programs.map((p) => ({ id: p, name: PURCHASE_PROGRAMS[p] ?? (p === SYSTEM_PROGRAM ? "System" : p) })),
    priority_lamports: priorityLamports,
    network_fee_lamports: networkFee,
    system_lamports_from_agent: systemLamportsFromAgent,
    system_payees: systemPayees,
    usdc_account: usdcAta,
    blockhash: compiled.lifetimeToken,
  };
}

/** A USDC token account read back from the simulation: owner, delegate, close authority. Null if it is not one. */
function readUsdcAccount(entry) {
  const raw = Buffer.from(String(entry?.data?.[0] ?? ""), "base64");
  if (entry?.owner !== TOKEN_PROGRAM_ADDRESS || raw.length !== 165) return null;
  const key = (at) => getAddressDecoder().decode(raw.subarray(at, at + 32));
  return { mint: key(0), owner: key(32), delegate: raw.readUInt32LE(72) === 0 ? null : key(76), closeAuthority: raw.readUInt32LE(129) === 0 ? null : key(133) };
}

/**
 * Simulate and measure what the transaction takes from the agent. Returns { usdc_out, lamports_out, network_fee,
 * payees, simulated }: `lamports_out` is SOL leaving the agent beyond the network fee (a SOL payment, or rent for an
 * account it creates). Throws Refused when the simulation fails, cannot be read, or shows any other token leaving or
 * the agent's USDC account handed to someone.
 */
export async function simulatePurchaseTx(tx, facts, { agent }, { rpc }) {
  const wire = getBase64EncodedWireTransaction(tx);
  const watch = [agent, facts.usdc_account];
  let sim;
  try {
    const res = await withTimeout(rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { addresses: watch, encoding: "base64" } }).send());
    sim = res.value;
  } catch (err) {
    throw new Refused([r("purchase_tx.sim_unavailable", `the simulation could not run (${String(err.message).slice(0, 160)}); nothing is signed without one`)]);
  }
  if (sim.err) {
    const why = JSON.stringify(sim.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200);
    throw new Refused([r("purchase_tx.sim_failed", /BlockhashNotFound/i.test(why) ? "the transaction has expired (its blockhash is gone); ask for a new one" : `the simulation failed: ${why}`)]);
  }
  if (!sim.preBalances || !sim.postBalances || !sim.preTokenBalances || !sim.postTokenBalances || !Array.isArray(sim.accounts) || sim.accounts.length !== watch.length) {
    throw new Refused([r("purchase_tx.sim_unavailable", "the simulation returned no balances; nothing is signed without them")]);
  }
  const loaded = sim.loadedAddresses ?? { writable: [], readonly: [] };
  const sameList = (x, y) => x.length === y.length && x.every((v, i) => String(v) === y[i]);
  if (!sameList(loaded.writable ?? [], facts.lookup_loaded.writable) || !sameList(loaded.readonly ?? [], facts.lookup_loaded.readonly)) {
    throw new Refused([r("purchase_tx.sim_inconsistent", "the accounts the simulation loaded do not match the lookup tables this kit read")]);
  }
  const view = { keys: facts.keys, preBalances: sim.preBalances, postBalances: sim.postBalances, preTokenBalances: sim.preTokenBalances, postTokenBalances: sim.postTokenBalances };
  const deltas = balanceDeltas(view, agent);
  const problems = [];
  for (const o of deltas.others) if (o.delta < 0n) problems.push(r("purchase_tx.other_token_leaves", `the transaction would take ${-o.delta} base units of ${o.mint} from the agent; only USDC may leave`));
  const usdcOut = -deltas.usdc.delta;
  const solOut = -deltas.sol.delta;
  const lamportsOut = solOut - facts.network_fee_lamports;
  // The agent's wallet stays an ordinary wallet, and its USDC account stays its own, with no delegate or close authority.
  const w = sim.accounts[0];
  if (!w || w.owner !== SYSTEM_PROGRAM || w.executable) problems.push(r("purchase_tx.account_authority_changed", "after this transaction the agent's wallet would no longer be an ordinary wallet"));
  const u = sim.accounts[1];
  if (u && !(big(u.lamports) === 0n && Number(u.space ?? 0) === 0)) {
    const t = readUsdcAccount(u);
    if (!t || t.mint !== USDC_MINT || t.owner !== agent) problems.push(r("purchase_tx.account_authority_changed", "after this transaction the agent's USDC account would not be a plain USDC account it owns"));
    else if (t.delegate) problems.push(r("purchase_tx.lingering_approval", `after this transaction someone (${t.delegate}) could still spend from the agent's USDC account`));
    else if (t.closeAuthority) problems.push(r("purchase_tx.account_authority_changed", `after this transaction ${t.closeAuthority} could close the agent's USDC account`));
  }
  if (problems.length) throw new Refused(problems);
  // Who received USDC: the owners of USDC accounts (not the agent's) whose balance went up.
  const payees = [];
  const amount = (t) => big(t.uiTokenAmount?.amount ?? t.amount);
  for (const post of sim.postTokenBalances) {
    if (post.mint !== USDC_MINT || post.owner === agent) continue;
    const pre = sim.preTokenBalances.find((p) => p.accountIndex === post.accountIndex);
    if (amount(post) > (pre ? amount(pre) : 0n) && post.owner && !payees.includes(post.owner)) payees.push(post.owner);
  }
  return {
    usdc_out: usdcOut,
    lamports_out: lamportsOut < 0n ? 0n : lamportsOut,
    network_fee: facts.network_fee_lamports,
    payees,
    simulated: { usdc_out_units: usdcOut.toString(), sol_out_lamports: solOut.toString(), network_fee_lamports: facts.network_fee_lamports.toString(), programs: facts.programs.map((p) => p.name) },
  };
}

/** Is the transaction's own blockhash still valid? (It cannot be replaced: another party may already have signed it.) */
export async function blockhashValid(blockhash, rpc) {
  return (await withTimeout(rpc.isBlockhashValid(blockhash, { commitment: "confirmed" }).send())).value === true;
}

/** Add the agent's signature (keeping any already present). Throws unless the result is fully signed. */
export async function signWithAgent(tx, signer) {
  const s = signer ?? (await createKeyPairSignerFromBytes(solanaSecret()));
  const signed = await signTransaction([s.keyPair], tx);
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}
