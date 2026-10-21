// The Sato Passport registry writes against the REAL ERC-8004 registry on a local anvil fork of Base: nothing reaches the real chain. Opt-in:
//   SATO_AGENT_FORK=1 node --test test/passport-join-fork.test.js
// Needs `anvil` (Foundry) on PATH. FORK_RPC overrides the upstream RPC.
//
// What it proves, against the deployed contract rather than a stub:
//   - register(agentURI, metadata) with the "satohub.passport" entry works and the registry returns the id from getMetadata;
//   - the Base Builder Code suffix (ERC-8021) on the calldata does not stop register or setAgentURI from working, and is the last bytes sent;
//   - setAgentWallet with the kit's EIP-712 message (the domain, the struct, the 4-minute deadline) is accepted by the registry after an agent
//     is transferred to the bot's wallet (a transfer clears the agent's wallet), and is refused for an agent the wallet does not own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { createPublicClient, decodeEventLog, encodeFunctionData, hexToString, http, parseAbi, toHex } from "viem";
import { base } from "viem/chains";
import { freshHome } from "./helpers.js";

const enabled = process.env.SATO_AGENT_FORK === "1";
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

freshHome();
process.env.SATO_AGENT_BASE_RPC = RPC;
process.env.SATO_BUILDER_CODE = "bc_forktest1";
const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { IDENTITY_REGISTRY, clients, identityRegistryAbi, registerAgent, setAgentWallet } = await import("../src/base.js");
const { builderCodeSuffix, PASSPORT_METADATA_KEY } = await import("../src/passport-onchain.js");
const { entries } = await import("../src/ledger.js");

const ID = "sato:agt:exmpexmpexmp";
const REGISTRAR = "0x00000000000000000000000000000000000fe771"; // a stand-in for Sato Hub's registrar: impersonated on the fork only
const OTHER = "0x00000000000000000000000000000000000fe772";
const nftAbi = parseAbi(["function transferFrom(address from, address to, uint256 tokenId)"]);

let anvil;
let me;
const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 30_000 }) });
const rpc = (method, params) => pub.request({ method, params });

/** A transaction sent by an impersonated account; returns its receipt. */
async function sendAs(from, to, data) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: toHex(3_000_000n) }]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${from} -> ${to} reverted`);
  return receipt;
}

/** The registrar registers an agent and hands it to `to`, as Sato Hub's sponsored registration does. Returns the agent id. */
async function sponsoredAgent(to) {
  const receipt = await sendAs(REGISTRAR, IDENTITY_REGISTRY, encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: ["https://satohub.ai/passport/exmpexmpexmp/agent.json"] }));
  const log = receipt.logs.map((l) => { try { return decodeEventLog({ abi: identityRegistryAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "Registered");
  const agentId = log.args.agentId;
  await sendAs(REGISTRAR, IDENTITY_REGISTRY, encodeFunctionData({ abi: nftAbi, functionName: "transferFrom", args: [REGISTRAR, to, agentId] }));
  return agentId;
}

before(async () => {
  if (!enabled) return;
  anvil = spawn("anvil", ["--fork-url", process.env.FORK_RPC || "https://mainnet.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  me = initWallet().base;
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  await rpc("anvil_setBalance", [me, toHex(10n ** 17n)]);
  for (const a of [REGISTRAR, OTHER]) {
    await rpc("anvil_setBalance", [a, toHex(10n ** 18n)]);
    await rpc("anvil_impersonateAccount", [a]);
  }
});
after(() => anvil?.kill());

test("register with a passport: the registry holds satohub.passport, and the Builder Code is the last bytes of both transactions", { skip: !enabled }, async () => {
  const r = await registerAgent({ name: "Fork Agent", description: "fork test", passport: ID }, clients(undefined, "base"));
  assert.equal(r.passport_metadata, PASSPORT_METADATA_KEY);
  assert.equal(r.builder_code, "bc_forktest1");
  const agentId = BigInt(r.agent_id);
  const held = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getMetadata", args: [agentId, PASSPORT_METADATA_KEY] });
  assert.equal(hexToString(held), ID, "the registry returns the passport id under the tag");
  const wallet = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [agentId] });
  assert.equal(wallet.toLowerCase(), me.toLowerCase(), "a registration makes the registering wallet the payment wallet");
  const suffix = builderCodeSuffix("bc_forktest1");
  const sent = entries().filter((e) => e.kind === "register_sent").map((e) => e.tx);
  const hashes = [sent.at(-1), r.tx];
  for (const hash of hashes) {
    const tx = await pub.getTransaction({ hash });
    assert.ok(tx.input.endsWith(suffix.slice(2)), `${hash} ends with the ERC-8021 suffix`);
  }
  // The file the registry stores still names the SatoPassport entry (step two worked with the suffix on).
  const uri = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] }).catch(() => null);
  if (uri) assert.match(Buffer.from(uri.split(",")[1], "base64").toString(), /SatoPassport/);
});

test("a registration with no passport still uses register(string) and carries no metadata", { skip: !enabled }, async () => {
  const r = await registerAgent({ name: "Plain Agent", description: "fork test", again: true, passport: null }, clients(undefined, "base"));
  assert.equal(r.passport_metadata, undefined);
  const held = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getMetadata", args: [BigInt(r.agent_id), PASSPORT_METADATA_KEY] });
  assert.equal(held, "0x");
});

test("setAgentWallet: after an agent is handed to this wallet (its payment wallet is cleared), the kit sets it back; the registry accepts the EIP-712 message", { skip: !enabled }, async () => {
  const agentId = await sponsoredAgent(me);
  const before = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [agentId] });
  assert.match(before, /^0x0{40}$/, "a transfer clears the agent's wallet");
  const c = clients(undefined, "base");
  const dry = await setAgentWallet({ agentId, chain: "base", dryRun: true }, c);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.current_wallet, null);
  const r = await setAgentWallet({ agentId, chain: "base" }, c);
  assert.equal(r.agent_id, agentId.toString());
  const after = await pub.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [agentId] });
  assert.equal(after.toLowerCase(), me.toLowerCase());
  const tx = await pub.getTransaction({ hash: r.tx });
  assert.ok(tx.input.endsWith(builderCodeSuffix("bc_forktest1").slice(2)), "the Builder Code rides on this transaction too");
  // Run again: nothing to do, nothing sent.
  const again = await setAgentWallet({ agentId, chain: "base" }, c);
  assert.equal(again.already, true);
  assert.equal(again.tx, undefined);
});

test("setAgentWallet refuses an agent this wallet does not own, and a wallet with no gas, before anything is signed", { skip: !enabled }, async () => {
  const theirs = await sponsoredAgent(OTHER);
  await assert.rejects(setAgentWallet({ agentId: theirs, chain: "base" }, clients(undefined, "base")), /belongs to .*not this wallet.*nothing was signed/s);
  const mine = await sponsoredAgent(me);
  await rpc("anvil_setBalance", [me, "0x0"]);
  await assert.rejects(setAgentWallet({ agentId: mine, chain: "base" }, clients(undefined, "base")), /holds no ETH on Base.*nothing was signed/s);
  await rpc("anvil_setBalance", [me, toHex(10n ** 17n)]);
});
