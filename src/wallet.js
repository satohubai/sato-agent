// The agent's own wallet: one EVM key (Base) and one Solana keypair, created on
// the machine the agent runs on. Nothing here talks to the network.
//
// `init` never replaces an existing wallet: replacing it would orphan whatever
// the owner already funded. A folder that had a wallet never takes another one
// (src/integrity.js seals its addresses): `restore` only puts back the same
// wallet, or brings one into a new folder.

import fs from "node:fs";
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { home, paths, readJson, writePrivate } from "./store.js";
import { isEvm } from "./chains.js";
import { PlainError } from "./errors.js";
import { PAUSE_MS, commitWallet, sameWallet, sealedWallet, withLedgerLock } from "./integrity.js";

const b58 = getBase58Decoder(); // bytes -> base58 string
const fromB58 = getBase58Encoder(); // base58 string -> bytes
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex"); // DER prefix of a raw 32-byte ed25519 seed

function solanaKeypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { address: b58.decode(pub), secret: Buffer.concat([seed, pub]) }; // 64 bytes: seed || public key
}

/** The public key of a 32-byte ed25519 seed. */
function solanaPublic(seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url");
}

export function walletExists() {
  return readJson(paths.wallet()) !== null;
}

/** Create the wallet. Throws if one already exists, or if this folder had one. Returns the public addresses only. */
export function initWallet() {
  return withLedgerLock(() => {
    if (walletExists()) throw new Error(`a wallet already exists at ${paths.wallet()}; it is never replaced`);
    const sealed = sealedWallet();
    if (sealed) {
      throw new PlainError(
        `This folder's wallet file is missing (it was ${sealed.evm} / ${sealed.solana}). A folder that had a wallet never gets a new one. If the owner kept the backup, \`restore\` puts that wallet back; otherwise use a new NAME (a new launcher and folder).`,
      );
    }
    const evmKey = generatePrivateKey();
    const sol = solanaKeypair();
    const wallet = {
      version: 1,
      created_at: new Date().toISOString(),
      evm: { address: privateKeyToAccount(evmKey).address, private_key: evmKey },
      solana: { address: sol.address, secret_key_b64: sol.secret.toString("base64") },
    };
    writePrivate(paths.wallet(), JSON.stringify(wallet, null, 2) + "\n", { exclusive: true });
    const a = { evm: wallet.evm.address, solana: wallet.solana.address };
    commitWallet(a, { id: randomUUID(), ts: wallet.created_at, kind: "wallet", status: "created", evm: a.evm, solana: a.solana });
    return addresses(wallet);
  });
}

export function loadWallet() {
  const w = readJson(paths.wallet());
  if (!w) throw new Error("no wallet yet: run `sato-agent init` first");
  return w;
}

export function addresses(w = loadWallet()) {
  return { base: w.evm.address, solana: w.solana.address };
}

/**
 * The wallet's address on a chain, given by its key: every EVM chain uses the one 0x key, kept under `addresses().base`
 * (the name the wallet file and every JSON output already use), and Solana has its own.
 */
export const addressFor = (chain, a = addresses()) => (isEvm(chain) ? a.base : a[chain]);

export function evmAccount(w = loadWallet()) {
  return privateKeyToAccount(w.evm.private_key);
}

export function solanaSecret(w = loadWallet()) {
  return new Uint8Array(Buffer.from(w.solana.secret_key_b64, "base64"));
}

/**
 * The two private keys in the forms other wallets import: the EVM key as 0x hex (MetaMask: Import account), the Solana key as
 * base58 of its 64 bytes (Phantom and Solflare: Import private key). Only `backup --reveal` prints them.
 */
export function backupKeys(w = loadWallet()) {
  return { evm_address: w.evm.address, evm_private_key: w.evm.private_key, solana_address: w.solana.address, solana_private_key: b58.decode(new Uint8Array(Buffer.from(w.solana.secret_key_b64, "base64"))) };
}

const BASE58 = /[1-9A-HJ-NP-Za-km-z]{80,100}/g;
const byteArray = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

function solanaCandidates(text) {
  const out = [];
  for (const s of new Set(text.match(BASE58) ?? [])) {
    try {
      const b = fromB58.encode(s);
      if (b.length === 64) out.push(Buffer.from(b));
    } catch {
      /* not base58 */
    }
  }
  for (const s of new Set(text.match(byteArray) ?? [])) {
    const b = JSON.parse(s);
    if (b.every((n) => n <= 255)) out.push(Buffer.from(b));
  }
  return [...new Map(out.map((b) => [b.toString("hex"), b])).values()];
}

/**
 * Read a backup: the lines `backup --reveal` printed, the two private keys in any order (EVM as 0x + 64 hex; Solana as base58 of
 * 64 bytes, or the 64-number array some wallets export), or a wallet.json as this kit writes it. Addresses in the text must be
 * the keys' own. Nothing is echoed: errors name what is wrong, never a key.
 */
export function parseBackup(text) {
  if (typeof text !== "string" || !text.trim()) throw new PlainError("restore reads the backup on standard input: paste the lines `backup --reveal` printed (or the wallet's two private keys).");
  let evmKey = null;
  let sol = null;
  try {
    const j = JSON.parse(text);
    if (typeof j?.evm?.private_key === "string" && typeof j?.solana?.secret_key_b64 === "string") {
      evmKey = j.evm.private_key;
      sol = Buffer.from(j.solana.secret_key_b64, "base64");
    }
  } catch {
    /* not a wallet.json */
  }
  if (!evmKey) {
    const evm = [...new Set((text.match(/\b0x[0-9a-fA-F]{64}\b/g) ?? []).map((k) => k.toLowerCase()))];
    if (evm.length !== 1) throw new PlainError(evm.length ? "The backup has more than one EVM private key; paste only this wallet's." : "No EVM private key found (0x followed by 64 hex characters).");
    evmKey = evm[0];
    const sols = solanaCandidates(text);
    if (sols.length !== 1) throw new PlainError(sols.length ? "The backup has more than one Solana private key; paste only this wallet's." : "No Solana private key found (base58 of 64 bytes, as `backup --reveal` prints it).");
    sol = sols[0];
  }
  let evmAddress;
  try {
    evmAddress = privateKeyToAccount(evmKey).address;
  } catch {
    throw new PlainError("The EVM private key is not a valid key.");
  }
  if (sol.length !== 64) throw new PlainError("The Solana private key must be 64 bytes.");
  const pub = solanaPublic(sol.subarray(0, 32));
  if (!pub.equals(sol.subarray(32))) throw new PlainError("The Solana private key does not hold together (its public half is not its own): check it was copied whole.");
  const solanaAddress = b58.decode(pub);
  for (const a of text.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? []) {
    if (a.toLowerCase() !== evmAddress.toLowerCase()) throw new PlainError(`The backup names the EVM address ${a}, but its key is the key of ${evmAddress}. Check it was copied whole.`);
  }
  const labelled = /Solana address[^:\n]*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i.exec(text);
  if (labelled && labelled[1] !== solanaAddress) throw new PlainError(`The backup names the Solana address ${labelled[1]}, but its key is the key of ${solanaAddress}. Check it was copied whole.`);
  return { evmKey: `0x${evmKey.slice(2).toLowerCase()}`, evm: evmAddress, solSecret: sol, solana: solanaAddress };
}

/** Another folder on this computer that holds the same wallet (one bot folder next to this one), or null. */
function otherFolderWith(a) {
  const mine = resolve(home());
  const dirs = new Set();
  for (const root of [dirname(mine), mine]) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) dirs.add(resolve(join(root, d.name)));
    } catch {
      /* no such folder */
    }
  }
  dirs.add(dirname(mine));
  dirs.delete(mine);
  for (const d of dirs) {
    let w;
    try {
      w = JSON.parse(fs.readFileSync(join(d, "wallet.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof w?.evm?.address === "string" && (w.evm.address.toLowerCase() === a.evm.toLowerCase() || w.solana?.address === a.solana)) return d;
  }
  return null;
}

/**
 * Put a wallet back from the owner's backup. In a folder that had this very wallet (its seal names it), the file is put back and
 * the spend record carries on. In a new folder, the wallet comes in and spending is paused for 24 hours: the kit cannot see
 * what it spent before (a Grok Reset loses those lines too). A folder that holds or held a DIFFERENT wallet never takes this
 * one, and a wallet another bot folder on this computer already uses is refused. Returns the addresses, never a key.
 */
export function restoreWallet(text, { now = Date.now() } = {}) {
  const k = parseBackup(text);
  const a = { evm: k.evm, solana: k.solana };
  return withLedgerLock(() => {
    let here;
    try {
      here = readJson(paths.wallet());
    } catch {
      throw new PlainError("The wallet file here cannot be read. A restore never replaces a wallet file: use a new NAME (a new launcher and folder) and restore there.");
    }
    if (here) {
      if (sameWallet({ evm: here.evm?.address, solana: here.solana?.address }, a)) return { restored: false, already: true, base: a.evm, solana: a.solana, paused_until: null };
      throw new PlainError(`This folder already holds a different wallet (${here.evm?.address} / ${here.solana?.address}). A restore never replaces a wallet. To bring back ${a.evm} / ${a.solana}, use a new NAME (a new launcher and folder) and restore there.`);
    }
    const sealed = sealedWallet();
    if (sealed && !sameWallet(sealed, a)) throw new PlainError(`This folder belonged to another wallet (${sealed.evm} / ${sealed.solana}). A folder that had a wallet never takes another one: use a new NAME (a new launcher and folder) and restore there.`);
    const other = otherFolderWith(a);
    if (other) throw new PlainError(`This wallet is already in use on this computer, in ${other}. Two bots must never share a wallet: each would keep its own limits, so together they could spend twice as much. Use that bot, or ask the owner.`);
    // Only a folder sealed with this very wallet still holds its spend record.
    const pausedUntil = sealed ? null : new Date(now + PAUSE_MS).toISOString();
    const at = new Date(now).toISOString();
    const wallet = { version: 1, created_at: at, restored: true, evm: { address: a.evm, private_key: k.evmKey }, solana: { address: a.solana, secret_key_b64: k.solSecret.toString("base64") } };
    writePrivate(paths.wallet(), JSON.stringify(wallet, null, 2) + "\n", { exclusive: true });
    commitWallet(a, { id: randomUUID(), ts: at, kind: "wallet", status: "restored", evm: a.evm, solana: a.solana, ...(pausedUntil ? { paused_until: pausedUntil } : {}) });
    return { restored: true, already: false, base: a.evm, solana: a.solana, paused_until: pausedUntil };
  });
}
