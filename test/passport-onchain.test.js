// What the kit writes onchain for a Sato Passport, offline: the registry metadata entry, the Base Builder Code
// suffix (ERC-8021), and `passport set-wallet` (setAgentWallet with its EIP-712 message). A stub client stands in for the chain; the CLI
// tests run against a tiny local JSON-RPC node. The same code against the REAL registry is test/passport-join-fork.test.js (opt-in, anvil).
//
// Pinned from outside the kit: the function selectors are Sourcify's own list for the registry implementation
// 0x7274e874CA62410a93Bd8bf61c69d8045E399c02 (chain 8453); the suffix is the EIP-8021 example ("baseapp" -> ...07 00 8021...), also what
// ox's Attribution.toDataSuffix gives; the EIP-712 digest below is recomputed by hand (keccak of the typehash, the struct and the domain).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, hexToString, keccak256, pad, parseTransaction, recoverTypedDataAddress, stringToHex, toFunctionSelector, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { freshHome } from "./helpers.js";

freshHome();
delete process.env.SATO_BUILDER_CODE;
const onchain = await import("../src/passport-onchain.js");
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { actions, entries } = await import("../src/ledger.js");
const { PlainError } = await import("../src/errors.js");
const { IDENTITY_REGISTRY, identityRegistryAbi, registerAgent, setAgentWallet } = await import("../src/base.js");

const BIN = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
const ID = "sato:agt:exmpexmpexmp";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUFFIX_BASEAPP = "0x62617365617070070080218021802180218021802180218021";
const BASE_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

// ---------------------------------------------------------------- the registry's functions, as Sourcify lists them

test("the registry's selectors are the ones Sourcify lists for the verified implementation", () => {
  assert.equal(IDENTITY_REGISTRY, BASE_REGISTRY);
  const sel = (sig) => toFunctionSelector(sig);
  assert.equal(sel("register(string)"), "0xf2c298be");
  assert.equal(sel("register(string,(string,bytes)[])"), "0x8ea42286", "the overload that takes metadata");
  assert.equal(sel("setAgentWallet(uint256,address,uint256,bytes)"), "0x2d1ef5ae");
  assert.equal(sel("getAgentWallet(uint256)"), "0x00339509");
  assert.equal(sel("getMetadata(uint256,string)"), "0xcb4799f2");
  assert.equal(sel("ownerOf(uint256)"), "0x6352211e");
  assert.equal(sel("setAgentURI(uint256,string)"), "0x0af28bd3");
  // The kit's ABI encodes each overload to those selectors (viem picks the overload by its arguments).
  const uri = "data:application/json;base64,e30=";
  const meta = onchain.passportMetadata(ID);
  assert.equal(decodeFunctionData({ abi: identityRegistryAbi, data: encodeCall("register", [uri]) }).args.length, 1);
  assert.equal(encodeCall("register", [uri]).slice(0, 10), "0xf2c298be");
  assert.equal(encodeCall("register", [uri, meta]).slice(0, 10), "0x8ea42286");
  assert.equal(encodeCall("setAgentWallet", [1n, ZERO, 2n, "0x00"]).slice(0, 10), "0x2d1ef5ae");
  // ...and the kit's own ABI produces exactly the bytes an independent encoding of those signatures does.
  assert.equal(encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri] }), encodeCall("register", [uri]));
  assert.equal(encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri, meta] }), encodeCall("register", [uri, meta]));
  assert.equal(encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentWallet", args: [1n, ZERO, 2n, "0x00"] }), encodeCall("setAgentWallet", [1n, ZERO, 2n, "0x00"]));
});

const encodeCall = (functionName, args) => concatHex([toFunctionSelector(sigOf(functionName, args)), encodeArgs(functionName, args)]);
function sigOf(functionName, args) {
  if (functionName === "register") return args.length === 1 ? "register(string)" : "register(string,(string,bytes)[])";
  return "setAgentWallet(uint256,address,uint256,bytes)";
}
function encodeArgs(functionName, args) {
  if (functionName === "register" && args.length === 1) return encodeAbiParameters([{ type: "string" }], args);
  if (functionName === "register") return encodeAbiParameters([{ type: "string" }, { type: "tuple[]", components: [{ type: "string" }, { type: "bytes" }] }], [args[0], args[1].map((m) => [m.metadataKey, m.metadataValue])]);
  return encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }], args);
}

// ---------------------------------------------------------------- the metadata entry

test("the registry tag: one entry, satohub.passport = the passport id as UTF-8 bytes; anything that is not a passport id is refused", () => {
  assert.equal(onchain.PASSPORT_METADATA_KEY, "satohub.passport");
  const m = onchain.passportMetadata(ID);
  assert.deepEqual(m, [{ metadataKey: "satohub.passport", metadataValue: stringToHex(ID) }]);
  assert.equal(m[0].metadataValue, "0x7361746f3a6167743a65786d7065786d7065786d70");
  assert.equal(hexToString(m[0].metadataValue), ID);
  for (const bad of ["sato:agt:ABCDEFGHJKMN", "sato:agt:short", "", null, undefined, 7, "https://satohub.ai/passport/exmpexmpexmp"]) {
    assert.throws(() => onchain.passportMetadata(bad), (e) => e instanceof PlainError && /not a Sato Passport id; nothing was signed/.test(e.message), String(bad));
  }
});

// ---------------------------------------------------------------- the Base Builder Code (ERC-8021)

test("the Builder Code suffix is the ERC-8021 schema 0 layout: codes, their length, schema 0, the marker; the EIP's own example", async () => {
  assert.equal(onchain.builderCodeSuffix("baseapp"), SUFFIX_BASEAPP, "txData || codes || codesLength (7) || schemaId (0) || 0x8021 x8");
  assert.equal(onchain.ERC8021_MARKER, `0x${"8021".repeat(8)}`);
  assert.equal(onchain.builderCodeSuffix("bc_abc123"), `0x${Buffer.from("bc_abc123").toString("hex")}0900${"8021".repeat(8)}`);
  assert.equal(onchain.builderCodeSuffix("x"), `0x78010080218021802180218021802180218021`);
  // ox (a dependency of viem) builds the same bytes.
  try {
    const { Attribution } = await import("ox/erc8021");
    for (const code of ["baseapp", "bc_abc123", "x", "a".repeat(64)]) assert.equal(onchain.builderCodeSuffix(code), Attribution.toDataSuffix({ codes: [code] }), code);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" && err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err;
  }
  for (const bad of ["", "two words", "a,b", "café", "a".repeat(65), "tab\there", null, undefined, 7]) assert.throws(() => onchain.builderCodeSuffix(bad), (e) => e instanceof PlainError && /a Builder Code is one code/.test(e.message), JSON.stringify(bad));
});

test("SATO_BUILDER_CODE: unset or empty is none; a code is used (trimmed); a value that is not a code stops the command; the suffix goes on Base only", () => {
  assert.equal(onchain.builderCodeFromEnv({}), null);
  assert.equal(onchain.builderCodeFromEnv({ SATO_BUILDER_CODE: "" }), null);
  assert.equal(onchain.builderCodeFromEnv({ SATO_BUILDER_CODE: "   " }), null);
  assert.equal(onchain.builderCodeFromEnv({ SATO_BUILDER_CODE: " baseapp " }), "baseapp");
  for (const bad of ["a,b", "two words", "café", "x".repeat(65)]) {
    assert.throws(() => onchain.builderCodeFromEnv({ SATO_BUILDER_CODE: bad }), (e) => e instanceof PlainError && /SATO_BUILDER_CODE is not a valid Builder Code.*nothing was signed/.test(e.message), bad);
  }
  const data = "0xdeadbeef";
  const env = { SATO_BUILDER_CODE: "baseapp" };
  assert.equal(onchain.withBuilderSuffix("base", data, env), `${data}${SUFFIX_BASEAPP.slice(2)}`);
  for (const chain of ["bnb", "arbitrum", "polygon"]) assert.equal(onchain.withBuilderSuffix(chain, data, env), data, `${chain}: no Base Builder Code off Base`);
  assert.equal(onchain.withBuilderSuffix("base", data, {}), data, "no code, no suffix");
});

// ---------------------------------------------------------------- a stub client for register

function registerClient(me, { chain = "base", agentId = 99046n } = {}) {
  const state = { sent: [], simulated: [], called: [] };
  const registryAddr = IDENTITY_REGISTRY;
  const registered = {
    address: registryAddr,
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId, owner: me } }),
    data: encodeAbiParameters([{ type: "string" }], ["data:application/json;base64,e30="]),
  };
  return {
    state,
    c: {
      chainKey: chain,
      account: { address: me },
      sleep: async () => {},
      wallet: {
        async prepareTransactionRequest(req) {
          state.sent.push(req);
          return { ...req, nonce: req.nonce ?? 7 };
        },
        async signTransaction(p) {
          return `0x${String(p.nonce).padStart(8, "0")}${keccak256(p.data).slice(2)}`;
        },
      },
      pub: {
        async simulateContract(args) {
          state.simulated.push(args);
          return {};
        },
        async readContract({ functionName }) {
          if (functionName === "ownerOf") return me;
          throw new Error(`unexpected read ${functionName}`);
        },
        async getTransactionReceipt({ hash }) {
          return { transactionHash: hash, status: "success", logs: [] };
        },
        async call(args) {
          state.called.push(args);
          return { data: "0x" };
        },
        async sendRawTransaction() {},
        async waitForTransactionReceipt({ hash }) {
          return { transactionHash: hash, status: "success", logs: state.sent.length === 1 ? [registered] : [] };
        },
      },
    },
  };
}

const ownerKey = () => {
  freshHome();
  return initWallet().base;
};
const uriIn = (req) => {
  const { functionName, args } = decodeFunctionData({ abi: identityRegistryAbi, data: req.data });
  return { functionName, args };
};

test("register with a passport: the first transaction is register(uri, [satohub.passport = the id]); the second is setAgentURI; neither has a suffix when no Builder Code is set", async () => {
  const me = ownerKey();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  const { c, state } = registerClient(me);
  const r = await registerAgent({ name: "Sato Base Agent", description: "test", passport: ID }, c);
  assert.equal(r.passport_metadata, "satohub.passport");
  assert.equal(r.builder_code, undefined);
  assert.equal(state.sent.length, 2);
  const one = state.sent[0];
  assert.equal(one.to, IDENTITY_REGISTRY);
  assert.equal(one.data.slice(0, 10), "0x8ea42286", "the metadata overload");
  const { args } = uriIn(one);
  assert.deepEqual(args[1], [{ metadataKey: "satohub.passport", metadataValue: stringToHex(ID) }]);
  assert.match(args[0], /^data:application\/json;base64,/);
  assert.equal(uriIn(state.sent[1]).functionName, "setAgentURI");
  assert.equal(state.sent[1].data.slice(0, 10), "0x0af28bd3");
  assert.equal(state.simulated.length, 1, "step one is simulated as before, with the same arguments that are signed");
  assert.equal(state.simulated[0].functionName, "register");
  assert.deepEqual(state.simulated[0].args[1], args[1]);
  for (const req of state.sent) assert.ok(!req.data.endsWith("80218021"), "no Builder Code suffix without SATO_BUILDER_CODE");
});

test("register with no passport anywhere: register(string), exactly what it was before this option", async () => {
  const me = ownerKey();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  const { c, state } = registerClient(me);
  const r = await registerAgent({ name: "Sato Base Agent", description: "test" }, c);
  assert.equal(r.passport_metadata, undefined);
  assert.equal(state.sent[0].data.slice(0, 10), "0xf2c298be", "the one-argument overload");
  assert.equal(uriIn(state.sent[0]).args.length, 1);
  assert.equal(state.sent[0].data, encodeCall("register", [uriIn(state.sent[0]).args[0]]), "byte for byte the old calldata");
});

test("register with SATO_BUILDER_CODE on Base: both transactions end with the ERC-8021 suffix, the simulation runs on the same bytes, and the calldata still decodes", async () => {
  const me = ownerKey();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  process.env.SATO_BUILDER_CODE = "baseapp";
  try {
    const { c, state } = registerClient(me);
    const r = await registerAgent({ name: "Sato Base Agent", description: "test", passport: ID }, c);
    assert.equal(r.builder_code, "baseapp");
    assert.equal(state.sent.length, 2);
    for (const req of state.sent) assert.ok(req.data.endsWith(SUFFIX_BASEAPP.slice(2)), "the suffix is the last bytes");
    // The suffix changes nothing the registry reads: the same call decodes to the same arguments with and without it.
    const bare = state.sent[0].data.slice(0, state.sent[0].data.length - (SUFFIX_BASEAPP.length - 2));
    assert.deepEqual(uriIn({ data: bare }).args, uriIn(state.sent[0]).args);
    // Step one is simulated as a call on the exact calldata that is signed.
    assert.equal(state.simulated.length, 0);
    assert.equal(state.called[0].data, state.sent[0].data);
    assert.equal(state.called[0].to, IDENTITY_REGISTRY);
    // A --resume (step two only) carries the suffix too, and no metadata: the registration it finishes already happened.
    const resumed = registerClient(me);
    resumed.c.pub.readContract = async ({ functionName }) => (functionName === "ownerOf" ? me : (() => { throw new Error("x"); })());
    const again = await registerAgent({ name: "Sato Base Agent", description: "test", passport: ID, resume: 4242 }, resumed.c);
    assert.equal(again.passport_metadata, undefined, "metadata goes with a fresh registration only");
    assert.equal(again.builder_code, "baseapp");
    assert.equal(resumed.state.sent.length, 1);
    assert.equal(uriIn(resumed.state.sent[0]).functionName, "setAgentURI");
    assert.ok(resumed.state.sent[0].data.endsWith(SUFFIX_BASEAPP.slice(2)));
  } finally {
    delete process.env.SATO_BUILDER_CODE;
  }
});

test("register on another EVM chain: the metadata entry yes, the Base Builder Code no, even with SATO_BUILDER_CODE set", async () => {
  const me = ownerKey();
  setPolicy({ chains: "base,bnb", perTx: "1", perDay: "2" });
  process.env.SATO_BUILDER_CODE = "baseapp";
  try {
    const { c, state } = registerClient(me, { chain: "bnb" });
    const r = await registerAgent({ name: "Sato BNB Agent", description: "test", passport: ID, chain: "bnb" }, c);
    assert.equal(r.passport_metadata, "satohub.passport");
    assert.equal(r.builder_code, undefined);
    assert.equal(state.sent[0].data.slice(0, 10), "0x8ea42286");
    for (const req of state.sent) assert.ok(!req.data.includes("80218021"), "no Base attribution on BNB Chain");
    assert.equal(state.simulated.length, 1, "simulated the usual way");
  } finally {
    delete process.env.SATO_BUILDER_CODE;
  }
});

test("a Builder Code that is not a code stops register before anything is read, simulated or signed", async () => {
  const me = ownerKey();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  process.env.SATO_BUILDER_CODE = "two words";
  try {
    const { c, state } = registerClient(me);
    await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test", passport: ID }, c), (e) => e instanceof PlainError && /SATO_BUILDER_CODE is not a valid Builder Code/.test(e.message));
    assert.equal(state.sent.length + state.simulated.length + state.called.length, 0);
    const { loadSettings } = await import("../src/settings.js");
    assert.equal(loadSettings()?.passport, undefined, "and the passport id was not saved");
  } finally {
    delete process.env.SATO_BUILDER_CODE;
  }
});

// ---------------------------------------------------------------- setAgentWallet: the message and the calldata

const KEY = `0x${"11".repeat(32)}`;
const acct = privateKeyToAccount(KEY);
const AGENT = 4242n;
const DEADLINE = 1_800_000_000n;
// Pinned from a run against the REAL registry on an anvil fork (test/passport-join-fork.test.js accepts the same message), and the digest
// below was recomputed by hand: keccak256(0x1901 || domainSeparator || structHash).
const PINNED_DIGEST = "0x30ab1a6eb8b619dd7e358e1302349bab4e4c67870907aa96744f5e696cf48f37";
const PINNED_SIGNATURE = "0x78d19772da59a04fe98a8339e0c3fb385c03dddc122785bc045b80d6e5d978253266ff5aa9e1c840d47c1c98c48f68a412cb300430f2dbb1070c843693ca709e1c";
const PINNED_CALLDATA =
  "0x2d1ef5ae000000000000000000000000000000000000000000000000000000000000109200000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a000000000000000000000000000000000000000000000000000000006b49d2000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004178d19772da59a04fe98a8339e0c3fb385c03dddc122785bc045b80d6e5d978253266ff5aa9e1c840d47c1c98c48f68a412cb300430f2dbb1070c843693ca709e1c00000000000000000000000000000000000000000000000000000000000000";

test("the EIP-712 message: domain ERC8004IdentityRegistry v1, the chain id and the registry proxy, struct AgentWalletSet(agentId, newWallet, owner, deadline)", async () => {
  assert.equal(acct.address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
  const td = onchain.agentWalletTypedData({ chain: "base", agentId: AGENT, newWallet: acct.address, owner: acct.address, deadline: DEADLINE });
  assert.deepEqual(td.domain, { name: "ERC8004IdentityRegistry", version: "1", chainId: 8453, verifyingContract: BASE_REGISTRY });
  assert.equal(td.primaryType, "AgentWalletSet");
  assert.deepEqual(td.types.AgentWalletSet.map((f) => `${f.type} ${f.name}`), ["uint256 agentId", "address newWallet", "address owner", "uint256 deadline"]);
  assert.deepEqual(td.message, { agentId: AGENT, newWallet: acct.address, owner: acct.address, deadline: DEADLINE });
  // The digest, by viem and by hand.
  assert.equal(hashTypedData(td), PINNED_DIGEST);
  const typehash = keccak256(stringToHex("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"));
  const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [typehash, AGENT, acct.address, acct.address, DEADLINE]));
  const domainTypehash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const separator = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }], [domainTypehash, keccak256(stringToHex("ERC8004IdentityRegistry")), keccak256(stringToHex("1")), 8453n, BASE_REGISTRY]));
  assert.equal(keccak256(concatHex(["0x1901", separator, structHash])), PINNED_DIGEST);
  // Another chain, another domain.
  assert.equal(onchain.agentWalletTypedData({ chain: "arbitrum", agentId: AGENT, newWallet: acct.address, owner: acct.address, deadline: DEADLINE }).domain.chainId, 42161);
  assert.notEqual(hashTypedData(onchain.agentWalletTypedData({ chain: "arbitrum", agentId: AGENT, newWallet: acct.address, owner: acct.address, deadline: DEADLINE })), PINNED_DIGEST);
  // The new wallet's own key signs it, and the signer is recovered from it.
  const signature = await acct.signTypedData(td);
  assert.equal(signature, PINNED_SIGNATURE, "RFC 6979: the same key signs the same bytes");
  assert.equal(await recoverTypedDataAddress({ ...td, signature }), acct.address);
});

test("the setAgentWallet calldata is pinned: selector 0x2d1ef5ae, the agent, the wallet, the deadline, the signature; the Builder Code only on Base", async () => {
  const td = onchain.agentWalletTypedData({ chain: "base", agentId: AGENT, newWallet: acct.address, owner: acct.address, deadline: DEADLINE });
  const signature = await acct.signTypedData(td);
  const data = onchain.setAgentWalletData({ chain: "base", agentId: AGENT, newWallet: acct.address, deadline: DEADLINE, signature }, {});
  assert.equal(data, PINNED_CALLDATA);
  const { functionName, args } = decodeFunctionData({ abi: identityRegistryAbi, data });
  assert.equal(functionName, "setAgentWallet");
  assert.deepEqual(args, [AGENT, acct.address, DEADLINE, PINNED_SIGNATURE]);
  const withCode = onchain.setAgentWalletData({ chain: "base", agentId: AGENT, newWallet: acct.address, deadline: DEADLINE, signature }, { SATO_BUILDER_CODE: "baseapp" });
  assert.equal(withCode, `${PINNED_CALLDATA}${SUFFIX_BASEAPP.slice(2)}`);
  assert.equal(onchain.setAgentWalletData({ chain: "arbitrum", agentId: AGENT, newWallet: acct.address, deadline: DEADLINE, signature }, { SATO_BUILDER_CODE: "baseapp" }), PINNED_CALLDATA);
  assert.ok(onchain.AGENT_WALLET_DEADLINE_S < onchain.AGENT_WALLET_MAX_DEADLINE_S && onchain.AGENT_WALLET_MAX_DEADLINE_S === 300, "4 minutes asked for, 5 allowed by the registry");
});

// ---------------------------------------------------------------- setAgentWallet: the flow, with a stub client

function chainClient({ owner = acct.address, agentWallet = ZERO, balance = 10n ** 15n, blockTime = 1_800_000_000n, simulateFails = false, withBlock = true } = {}) {
  const state = { prepared: [], typed: [], called: [], events: [] };
  const account = { ...acct, signTypedData: async (td) => (state.events.push("sign"), state.typed.push(td), acct.signTypedData(td)) };
  const c = {
    chainKey: "base",
    account,
    sleep: async () => {},
    wallet: {
      async prepareTransactionRequest(req) {
        state.events.push("prepare");
        state.prepared.push(req);
        return { ...req, nonce: 7 };
      },
      async signTransaction(p) {
        return `0x${String(p.nonce).padStart(8, "0")}${keccak256(p.data).slice(2)}`;
      },
    },
    pub: {
      async readContract({ functionName }) {
        state.events.push(`read:${functionName}`);
        if (functionName === "ownerOf") return owner;
        if (functionName === "getAgentWallet") return agentWallet;
        throw new Error(`unexpected read ${functionName}`);
      },
      async getBalance() {
        state.events.push("balance");
        return balance;
      },
      ...(withBlock ? { async getBlock() { return { timestamp: blockTime }; } } : {}),
      async call(args) {
        state.events.push("call");
        state.called.push(args);
        if (simulateFails) throw Object.assign(new Error("Execution reverted: invalid wallet sig"), { shortMessage: "Execution reverted: invalid wallet sig" });
        return { data: "0x" };
      },
      async sendRawTransaction() {},
      async waitForTransactionReceipt({ hash }) {
        return { transactionHash: hash, status: "success", logs: [] };
      },
    },
  };
  return { c, state };
}

const walletSetup = () => {
  freshHome();
  initWallet();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
};

test("setAgentWallet: read-only checks, then the owner's approval, then the signature, a simulation of the exact calldata, and one transaction to the registry (pinned bytes)", async () => {
  walletSetup();
  const { c, state } = chainClient();
  const order = [];
  const r = await setAgentWallet({ agentId: "4242" }, c, { deadline: DEADLINE, authorize: async () => order.push([...state.events]) });
  assert.deepEqual(order[0], ["read:ownerOf", "read:getAgentWallet", "balance"], "the approval is asked for only after every read-only check passed, and before anything is signed");
  assert.deepEqual(state.events, ["read:ownerOf", "read:getAgentWallet", "balance", "sign", "call", "prepare"]);
  assert.equal(state.prepared.length, 1, "one transaction");
  assert.equal(state.prepared[0].to, IDENTITY_REGISTRY);
  assert.equal(state.prepared[0].data, PINNED_CALLDATA, "the calldata is the pinned one");
  assert.equal(state.called[0].data, PINNED_CALLDATA, "the simulation ran on the exact calldata");
  assert.equal(state.called[0].to, IDENTITY_REGISTRY);
  assert.equal(state.typed[0].message.deadline, DEADLINE);
  assert.equal(r.agent_id, "4242");
  assert.equal(r.wallet, acct.address);
  assert.equal(r.registry, `eip155:8453:${BASE_REGISTRY}`);
  assert.match(r.explorer, /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
  // The ledger has one row for the action (signed, then confirmed), usd 0, and history can show it with its explorer link.
  const rows = entries().filter((e) => e.kind === "set_agent_wallet");
  assert.deepEqual(rows.map((e) => e.status), ["signed", "confirmed"]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].agent_id, "4242");
  const row = actions().find((a) => a.kind === "set_agent_wallet");
  assert.equal(row.status, "confirmed");
  assert.equal(row.explorer, r.explorer);
});

test("setAgentWallet: with SATO_BUILDER_CODE the transaction ends with the suffix, and the simulation saw the same bytes", async () => {
  walletSetup();
  const { c, state } = chainClient();
  await setAgentWallet({ agentId: 4242 }, c, { deadline: DEADLINE, env: { SATO_BUILDER_CODE: "baseapp" } });
  assert.equal(state.prepared[0].data, `${PINNED_CALLDATA}${SUFFIX_BASEAPP.slice(2)}`);
  assert.equal(state.called[0].data, state.prepared[0].data);
});

test("setAgentWallet: a SATO_BUILDER_CODE that is not a code stops it before anything is read or signed (on Base only)", async () => {
  walletSetup();
  const bad = chainClient();
  await assert.rejects(setAgentWallet({ agentId: 4242 }, bad.c, { deadline: DEADLINE, env: { SATO_BUILDER_CODE: "two words" } }), (e) => e instanceof PlainError && /SATO_BUILDER_CODE is not a valid Builder Code.*nothing was signed/.test(e.message));
  assert.deepEqual(bad.state.events, [], "not even a read");
  assert.equal(bad.state.typed.length, 0);
});

test("setAgentWallet: the deadline is the chain's own block time plus 4 minutes (never this computer's clock), and a clock is the fallback only when the block cannot be read", async () => {
  walletSetup();
  const a = chainClient({ blockTime: 1_900_000_000n });
  await setAgentWallet({ agentId: 1 }, a.c);
  assert.equal(a.state.typed[0].message.deadline, 1_900_000_240n);
  walletSetup();
  const b = chainClient({ withBlock: false });
  const before = BigInt(Math.floor(Date.now() / 1000));
  await setAgentWallet({ agentId: 1 }, b.c);
  const dl = b.state.typed[0].message.deadline;
  assert.ok(dl >= before + 239n && dl <= before + 245n, `a clock fallback, 4 minutes ahead: ${dl - before}`);
});

test("setAgentWallet refuses before anything is signed: not the owner, already set, no gas, a bad id, a chain the agent does not work on", async () => {
  walletSetup();
  const stranger = "0x00000000000000000000000000000000000000aa";
  const mine = chainClient({ owner: stranger });
  await assert.rejects(setAgentWallet({ agentId: 7 }, mine.c, { authorize: async () => { throw new Error("must not ask"); } }), (e) => e instanceof PlainError && e.message.includes(`agent 7 on Base belongs to ${stranger}, not this wallet (${acct.address}); nothing was signed`) && /wait until Sato Hub has handed it over/.test(e.message));
  assert.ok(!mine.state.events.includes("sign") && mine.state.prepared.length === 0);

  const done = chainClient({ agentWallet: acct.address.toLowerCase() });
  const r = await setAgentWallet({ agentId: 7 }, done.c, { authorize: async () => { throw new Error("must not ask"); } });
  assert.equal(r.already, true, "its payment wallet is already this wallet: nothing to do");
  assert.deepEqual(done.state.events, ["read:ownerOf", "read:getAgentWallet"]);
  assert.equal(done.state.prepared.length, 0);

  const broke = chainClient({ balance: 0n });
  await assert.rejects(setAgentWallet({ agentId: 7 }, broke.c, { authorize: async () => { throw new Error("must not ask"); } }), (e) => e instanceof PlainError && e.message.includes(`this wallet holds no ETH on Base, so it cannot pay the gas for this. Send a little ETH to ${acct.address} and run it again; nothing was signed.`));
  assert.ok(!broke.state.events.includes("sign"));

  for (const bad of ["abc", "-1", "1.5", "", undefined, "0x10"]) {
    await assert.rejects(setAgentWallet({ agentId: bad }, chainClient().c), (e) => e instanceof PlainError && /--agent-id takes the ERC-8004 agent id/.test(e.message), String(bad));
  }
  // The agent works on Base only: another chain is refused, with nothing read.
  const other = chainClient();
  await assert.rejects(setAgentWallet({ agentId: 7, chain: "bnb" }, { ...other.c, chainKey: "bnb" }), (e) => e instanceof PlainError && /this agent is set to work on base only; the ERC-8004 registry meant here is on BNB Chain\. Nothing was signed\./.test(e.message));
  assert.equal(other.state.events.length, 0);
});

test("setAgentWallet: an owner who says no stops it before the signature; a dry run signs and sends nothing and does not ask; a registry that would refuse is caught by the simulation", async () => {
  walletSetup();
  const no = chainClient();
  await assert.rejects(setAgentWallet({ agentId: 9 }, no.c, { authorize: async () => { throw new Error("needs approval"); } }), /needs approval/);
  assert.ok(!no.state.events.includes("sign") && no.state.prepared.length === 0);
  const dry = chainClient();
  const r = await setAgentWallet({ agentId: 9, dryRun: true }, dry.c, { authorize: async () => { throw new Error("a dry run asks nothing"); } });
  assert.equal(r.dry_run, true);
  assert.equal(r.current_wallet, null, "the registry's empty wallet reads as not set");
  assert.deepEqual(dry.state.events, ["read:ownerOf", "read:getAgentWallet", "balance"]);
  const somewhere = chainClient({ agentWallet: "0x00000000000000000000000000000000000000bb" });
  assert.equal((await setAgentWallet({ agentId: 9, dryRun: true }, somewhere.c)).current_wallet, "0x00000000000000000000000000000000000000bb");
  const bad = chainClient({ simulateFails: true });
  await assert.rejects(setAgentWallet({ agentId: 9 }, bad.c, { deadline: DEADLINE }), (e) => e instanceof PlainError && /the registry would refuse this \(Execution reverted: invalid wallet sig\); nothing was sent\./.test(e.message));
  assert.equal(bad.state.prepared.length, 0, "never sent");
  assert.equal(entries().filter((e) => e.kind === "set_agent_wallet").length, 0, "nothing in the ledger for a send that never happened");
});

// ---------------------------------------------------------------- the CLI against a tiny JSON-RPC node

const pad32 = (a) => pad(a.toLowerCase(), { size: 32 });

/** A minimal Base node: enough for the kit's reads, its simulation, one transaction and its receipt. The agent's wallet changes when a setAgentWallet lands. */
async function fakeChain({ owners = {}, wallets = {}, balance = 10n ** 15n } = {}) {
  const state = { sent: [], reads: [], wallets: { ...wallets }, balance };
  const result = (m, ctx) => {
    switch (m.method) {
      case "eth_chainId":
        return "0x2105";
      case "eth_blockNumber":
        return "0x64";
      case "eth_getBalance":
        return toHex(state.balance);
      case "eth_getBlockByNumber":
        return { number: "0x64", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, timestamp: toHex(1_800_000_000n), baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x1", miner: ZERO, transactions: [], uncles: [], difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, size: "0x1", mixHash: `0x${"00".repeat(32)}` };
      case "eth_maxPriorityFeePerGas":
        return "0xf4240";
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_estimateGas":
        return "0x30d40";
      case "eth_getTransactionCount":
        return "0x7";
      case "eth_feeHistory":
        return { oldestBlock: "0x60", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0xf4240"]] };
      case "eth_call": {
        const data = (m.params[0].data ?? m.params[0].input ?? "0x").toLowerCase();
        const sel = data.slice(0, 10);
        const agent = data.length >= 74 ? BigInt(`0x${data.slice(10, 74)}`).toString() : "0";
        state.reads.push(sel);
        if (sel === "0x6352211e") return pad32(owners[agent] ?? ctx.me);
        if (sel === "0x00339509") return pad32(state.wallets[agent] ?? ZERO);
        if (sel === "0x2d1ef5ae") return "0x";
        throw Object.assign(new Error(`unexpected eth_call ${sel}`), { code: -32000 });
      }
      case "eth_sendRawTransaction": {
        const raw = m.params[0];
        const hash = keccak256(raw);
        const tx = parseTransaction(raw);
        state.sent.push({ raw, hash, to: tx.to, data: tx.data });
        // setAgentWallet(agentId, ...): the agent's payment wallet becomes the sender's.
        const agent = BigInt(`0x${tx.data.slice(10, 74)}`).toString();
        state.wallets[agent] = ctx.me;
        return hash;
      }
      case "eth_getTransactionReceipt":
        return { transactionHash: m.params[0], status: "0x1", blockNumber: "0x65", blockHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0", from: ZERO, to: BASE_REGISTRY, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null };
      default:
        throw Object.assign(new Error(`unexpected ${m.method}`), { code: -32601 });
    }
  };
  const ctx = { me: null };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = (m) => {
      try {
        return { jsonrpc: "2.0", id: m.id, result: result(m, ctx) };
      } catch (e) {
        return { jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32000, message: e.message } };
      }
    };
    const msg = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, ctx, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

const chains = [];
after(async () => {
  for (const c of chains) await c.close();
});

async function walletBot(chain, policyArgs = ["--approval", "ask"]) {
  const dir = join(mkdtempSync(join(tmpdir(), "sato-agent-setwallet-")), "agent");
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SATO_AGENT_HOME: dir, SATO_AGENT_BASE_RPC: chain.url, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/api/mcp" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end("");
    });
  assert.equal((await run(["init"])).status, 0);
  chain.ctx.me = JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8")).evm.address.toLowerCase();
  assert.equal((await run(["policy", "set", "--chains", "base", "--per-tx", "5", "--per-day", "50", ...policyArgs])).status, 0);
  return { dir, run, me: chain.ctx.me, ledger: () => readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

test("CLI passport set-wallet in 'ask' mode: the checks run first, then exit 5 with an intent that names the agent, the chain and the wallet; the SAME command with that code sends one transaction", async () => {
  const chain = await fakeChain();
  chains.push(chain);
  const b = await walletBot(chain);
  const ask = await b.run(["passport", "set-wallet", "--agent-id", "77", "--json"]);
  assert.equal(ask.status, 5, ask.stderr);
  const { code, intent } = JSON.parse(ask.stdout).needs_approval;
  assert.deepEqual(intent, { cmd: "passport set-wallet", chain: "base", agent_id: "77", wallet: b.me });
  assert.equal(chain.state.sent.length, 0, "nothing was sent");
  assert.ok(chain.state.reads.includes("0x6352211e") && chain.state.reads.includes("0x00339509"), "the owner and the current wallet were read first");
  // A code for one agent is no use for another.
  const wrong = await b.run(["passport", "set-wallet", "--agent-id", "78", "--approve", code]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /different intent/);
  assert.equal(chain.state.sent.length, 0);
  const ok = await b.run(["passport", "set-wallet", "--agent-id", "77", "--approve", code]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Set agent 77's payment wallet on Base to 0x[0-9a-fA-F]{40}\.\n {2}https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}/);
  assert.equal(chain.state.sent.length, 1);
  assert.equal(chain.state.sent[0].to.toLowerCase(), BASE_REGISTRY.toLowerCase());
  assert.equal(chain.state.sent[0].data.slice(0, 10), "0x2d1ef5ae", "the transaction is setAgentWallet");
  // Again: nothing to do, nothing sent (it is set now).
  const again = await b.run(["passport", "set-wallet", "--agent-id", "77"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Nothing to do: agent 77 on Base already has this wallet/);
  assert.equal(chain.state.sent.length, 1);
  // history shows it with its link.
  const hist = await b.run(["history"]);
  assert.match(hist.stdout, /set_agent_wallet\s+confirmed\s+base\s+agent 77\s*\n\s+https:\/\/basescan\.org\/tx\//);
  assert.ok(b.ledger().some((e) => e.kind === "approval" && e.status === "requested" && e.intent.cmd === "passport set-wallet"));
});

test("CLI passport set-wallet: with the owner acting on its own (approval auto) it goes ahead with no code; a dry run only reports; refusals are exit 1 and send nothing", async () => {
  const stranger = "0x00000000000000000000000000000000000000aa";
  const chain = await fakeChain({ owners: { 81: stranger } });
  chains.push(chain);
  const b = await walletBot(chain, ["--approval", "auto"]);
  const dry = await b.run(["passport", "set-wallet", "--agent-id", "79", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^DRY RUN: agent 79 on Base belongs to this wallet, its payment wallet is not set, and this wallet holds gas\..*Nothing was signed or sent\./s);
  assert.equal(chain.state.sent.length, 0);
  const go = await b.run(["passport", "set-wallet", "--agent-id", "80"]);
  assert.equal(go.status, 0, go.stderr);
  assert.equal(chain.state.sent.length, 1, "no approval code needed in auto mode");
  const notMine = await b.run(["passport", "set-wallet", "--agent-id", "81"]);
  assert.equal(notMine.status, 1);
  assert.match(notMine.stderr, /agent 81 on Base belongs to 0x0{38}aa, not this wallet \(.*\); nothing was signed\./i);
  chain.state.balance = 0n;
  const broke = await b.run(["passport", "set-wallet", "--agent-id", "82"]);
  assert.equal(broke.status, 1);
  assert.match(broke.stderr, /this wallet holds no ETH on Base, so it cannot pay the gas for this\./);
  assert.equal(chain.state.sent.length, 1, "only the one that was allowed");
});

test("CLI passport set-wallet: usage errors are exit 2 before any read; a chain the owner did not choose is refused (exit 3)", async () => {
  const chain = await fakeChain();
  chains.push(chain);
  const b = await walletBot(chain);
  for (const args of [["passport", "set-wallet"], ["passport", "set-wallet", "--agent-id", "abc"], ["passport", "set-wallet", "--agent-id", "5", "extra"], ["passport", "set-wallet", "--agent-id", "5", "--chain", "solana"]]) {
    const r = await b.run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^usage: /);
  }
  const notChosen = await b.run(["passport", "set-wallet", "--agent-id", "5", "--chain", "polygon"]);
  assert.equal(notChosen.status, 3, notChosen.stderr);
  assert.match(notChosen.stderr, /this agent is set to work on base only/);
  assert.equal(chain.state.reads.length, 0, "no read for any of them");
  assert.equal(existsSync(join(b.dir, "approvals.json")), false);
});
