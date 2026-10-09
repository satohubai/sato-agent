// The agent's own wallet: one EVM key (Base) and one Solana keypair, created on
// the machine the agent runs on. Nothing here talks to the network.
//
// `init` never replaces an existing wallet: replacing it would orphan whatever
// the owner already funded.

import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBase58Decoder } from "@solana/kit";
import { paths, readJson, writePrivate } from "./store.js";

const b58 = getBase58Decoder(); // bytes -> base58 string

function solanaKeypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { address: b58.decode(pub), secret: Buffer.concat([seed, pub]) }; // 64 bytes: seed || public key
}

export function walletExists() {
  return readJson(paths.wallet()) !== null;
}

/** Create the wallet. Throws if one already exists. Returns the public addresses only. */
export function initWallet() {
  if (walletExists()) throw new Error(`a wallet already exists at ${paths.wallet()}; it is never replaced`);
  const evmKey = generatePrivateKey();
  const sol = solanaKeypair();
  const wallet = {
    version: 1,
    created_at: new Date().toISOString(),
    evm: { address: privateKeyToAccount(evmKey).address, private_key: evmKey },
    solana: { address: sol.address, secret_key_b64: sol.secret.toString("base64") },
  };
  writePrivate(paths.wallet(), JSON.stringify(wallet, null, 2) + "\n", { exclusive: true });
  return addresses(wallet);
}

export function loadWallet() {
  const w = readJson(paths.wallet());
  if (!w) throw new Error("no wallet yet: run `sato-agent init` first");
  return w;
}

export function addresses(w = loadWallet()) {
  return { base: w.evm.address, solana: w.solana.address };
}

export function evmAccount(w = loadWallet()) {
  return privateKeyToAccount(w.evm.private_key);
}

export function solanaSecret(w = loadWallet()) {
  return new Uint8Array(Buffer.from(w.solana.secret_key_b64, "base64"));
}
