// What the kit writes onchain for a Sato Passport, kept apart from src/base.js so it can be tested without a chain:
//
//   1. the registry metadata entry ("satohub.passport", the passport id) a registration carries, through the registry's
//      register(string agentURI, MetadataEntry[] metadata) overload;
//   2. the Base Builder Code (ERC-8021, schema 0): a short suffix appended to a registry transaction's calldata on Base when the operator sets
//      SATO_BUILDER_CODE;
//   3. setAgentWallet: the EIP-712 message and the calldata that point an ERC-8004 agent's payment wallet at this bot's own wallet, which
//      Sato Hub's hand-over of a sponsored registration clears (the registry empties an agent's wallet when it is transferred).
//
// Sources, read 2026-10-21: the registry's verified source on Sourcify (IdentityRegistryUpgradeable, the implementation behind the proxy in
// src/chains.js; the proxy resolves to the same implementation on Base, Arbitrum and Polygon, and BNB Chain's has the same ABI):
// register(string) and register(string,(string,bytes)[]) both exist; setAgentWallet(uint256 agentId, address newWallet, uint256 deadline,
// bytes signature) requires the caller to own or be approved for the agent, `deadline` at most 5 minutes past the block time, and a
// signature BY newWallet over the EIP-712 struct AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline) in the
// domain EIP712("ERC8004IdentityRegistry", "1") with the chain id and the registry proxy as verifying contract (confirmed live: the
// registry's eip712Domain() on Base and Arbitrum returns exactly that, no salt, no extensions).
// This file only builds bytes. It never signs a transaction or sends anything.

import { concatHex, encodeFunctionData, stringToHex } from "viem";
import { PlainError } from "./errors.js";
import { evmChain } from "./chains.js";
import { PASSPORT_ID_RE } from "./passport.js";

// ---------------------------------------------------------------- the registry's extra functions

/** The registry functions this file uses, beyond register(string), setAgentURI and ownerOf (src/base.js). */
export const registryPassportAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentURI", type: "string" },
      { name: "metadata", type: "tuple[]", components: [{ name: "metadataKey", type: "string" }, { name: "metadataValue", type: "bytes" }] },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  { type: "function", name: "getAgentWallet", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getMetadata", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }], outputs: [{ name: "", type: "bytes" }] },
  {
    type: "function",
    name: "setAgentWallet",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }],
    outputs: [],
  },
];

// ---------------------------------------------------------------- 1. the registry metadata entry

/** The metadata key Sato Hub tags a registration with, so every Sato agent can be listed from the registry's metadata events. */
export const PASSPORT_METADATA_KEY = "satohub.passport";

/**
 * The metadata array for register(agentURI, metadata): one entry, the passport id as UTF-8 bytes. An id that is not a passport id throws, so a
 * wrong value is never written to a chain. `register` has no way to change an entry afterwards except setMetadata by the owner.
 */
export function passportMetadata(passportId) {
  if (typeof passportId !== "string" || !PASSPORT_ID_RE.test(passportId)) throw new PlainError("not a Sato Passport id; nothing was signed");
  return [{ metadataKey: PASSPORT_METADATA_KEY, metadataValue: stringToHex(passportId) }];
}

// ---------------------------------------------------------------- 2. the Base Builder Code (ERC-8021, schema 0)

export const BUILDER_CODE_ENV = "SATO_BUILDER_CODE";
/** ERC-8021's marker: "8021" repeated 8 times (16 bytes), the last bytes of the calldata. */
export const ERC8021_MARKER = "0x80218021802180218021802180218021";
// One code: printable ASCII, no space and no comma (the comma separates several codes in the suffix). The registry decides which are real.
const CODE_RE = /^[\x21\x23-\x2b\x2d-\x7e]{1,64}$/;

/**
 * The ERC-8021 schema 0 suffix for one code: codes (ASCII) || codesLength (1 byte) || schemaId 0 (1 byte) || the marker. The same bytes as
 * ox's Attribution.toDataSuffix({ codes: [code] }) and the EIP's own example ("baseapp" -> 0x62617365617070 07 00 80218021...).
 */
export function builderCodeSuffix(code) {
  if (typeof code !== "string" || !CODE_RE.test(code)) throw new PlainError(`a Builder Code is one code of printable characters (no space, no comma), up to 64 long (got "${String(code).slice(0, 40)}")`);
  const hex = Buffer.from(code, "ascii").toString("hex");
  return `0x${hex}${(hex.length / 2).toString(16).padStart(2, "0")}00${ERC8021_MARKER.slice(2)}`;
}

/** The Builder Code from the environment, or null when it is not set. A value that is not a code is refused (nothing is signed with it). */
export function builderCodeFromEnv(env = process.env) {
  const raw = env[BUILDER_CODE_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const v = raw.trim();
  if (!CODE_RE.test(v)) throw new PlainError(`${BUILDER_CODE_ENV} is not a valid Builder Code (one code of printable characters, no space, no comma, up to 64 long); nothing was signed.`);
  return v;
}

/** `data` with the Builder Code suffix appended, on Base and only when the operator set one; unchanged on every other chain. */
export function withBuilderSuffix(chain, data, env = process.env) {
  if (chain !== "base") return data;
  const code = builderCodeFromEnv(env);
  return code ? concatHex([data, builderCodeSuffix(code)]) : data;
}

// ---------------------------------------------------------------- 3. setAgentWallet

export const REGISTRY_EIP712_NAME = "ERC8004IdentityRegistry";
export const REGISTRY_EIP712_VERSION = "1";
/** The registry refuses a deadline more than 5 minutes past the block time; the kit asks for 4 so the transaction has room to land. */
export const AGENT_WALLET_MAX_DEADLINE_S = 300;
export const AGENT_WALLET_DEADLINE_S = 240;

export const AGENT_WALLET_TYPES = Object.freeze({
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
});

/**
 * The EIP-712 message the NEW wallet signs: { domain, types, primaryType, message } in viem's signTypedData shape. `owner` is who owns the
 * agent now (the registry puts it into the struct), `newWallet` the wallet to set; for this kit both are the bot's own address.
 */
export function agentWalletTypedData({ chain = "base", agentId, newWallet, owner, deadline }) {
  const c = evmChain(chain);
  return {
    domain: { name: REGISTRY_EIP712_NAME, version: REGISTRY_EIP712_VERSION, chainId: c.viem.id, verifyingContract: c.erc8004Registry },
    types: AGENT_WALLET_TYPES,
    primaryType: "AgentWalletSet",
    message: { agentId: BigInt(agentId), newWallet, owner, deadline: BigInt(deadline) },
  };
}

/** The setAgentWallet(agentId, newWallet, deadline, signature) calldata, with the Builder Code suffix when one is set (Base only). */
export function setAgentWalletData({ chain = "base", agentId, newWallet, deadline, signature }, env = process.env) {
  const data = encodeFunctionData({ abi: registryPassportAbi, functionName: "setAgentWallet", args: [BigInt(agentId), newWallet, BigInt(deadline), signature] });
  return withBuilderSuffix(chain, data, env);
}
