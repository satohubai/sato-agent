// Base (chain id 8453): balances, USDC sends under the limits, and ERC-8004
// self-registration.
//
// A send is reserved against the limits first, simulated, then signed HERE and
// its hash recorded before it is broadcast. If the broadcast or the receipt
// wait fails, the spend stays counted and the command says "do not retry"
// (Pending): the node may have accepted it.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
} from "viem";
import { usdcUnits, unitsToUsd } from "./amount.js";
import { base } from "viem/chains";
import { allowedChains, loadPolicy } from "./policy.js";
import { entries, record, release, reserve } from "./ledger.js";
import { Pending, Rejected } from "./errors.js";
import { withLock } from "./store.js";
import { evmAccount, loadWallet } from "./wallet.js";
import { USER_AGENT } from "./version.js";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// ERC-8004 IdentityRegistry on Base mainnet (github.com/erc-8004/erc-8004-contracts).
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
];

const RPC_TIMEOUT_MS = 20_000;
const explorer = (hash) => `https://basescan.org/tx/${hash}`;

function transport() {
  const url = process.env.SATO_AGENT_BASE_RPC || "https://mainnet.base.org";
  return http(url, { timeout: RPC_TIMEOUT_MS, fetchOptions: { headers: { "user-agent": USER_AGENT } } });
}

export function clients(account = evmAccount()) {
  const t = transport();
  return {
    account,
    pub: createPublicClient({ chain: base, transport: t }),
    wallet: createWalletClient({ account, chain: base, transport: t }),
  };
}

export async function balances(addr = loadWallet().evm.address) {
  const pub = createPublicClient({ chain: base, transport: transport() });
  const [eth, usdc] = await Promise.all([
    pub.getBalance({ address: addr }),
    pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
  ]);
  return { address: addr, eth: formatEther(eth), usdc: formatUnits(usdc, 6) };
}

// Errors that mean the node refused the transaction outright: it never entered
// the mempool and can never land, so it is safe to release.
const DEFINITE_REJECTION = /insufficient funds|nonce too low|nonce has already been used|replacement transaction underpriced|intrinsic gas too low|exceeds block gas limit|invalid sender|already known/i;

/**
 * Sign locally, record the hash, broadcast, wait. Returns the receipt.
 * Nonce assignment through broadcast is serialized by a lock, so two commands
 * never sign with the same nonce. Throws Rejected when the node definitely
 * refused it, Pending when the outcome is unknown (kept counted), and Rejected
 * when another transaction took the nonce (ours can then never land).
 */
export async function signAndSend(c, { to, data, value = 0n, gas }, onSigned, { counted = true } = {}) {
  const { signed, hash } = await withLock(
    async () => {
      const prepared = await c.wallet.prepareTransactionRequest({ account: c.account, to, data, value: BigInt(value), ...(gas ? { gas: BigInt(gas) } : {}), chain: base });
      const signedTx = await c.wallet.signTransaction(prepared);
      const h = keccak256(signedTx);
      onSigned?.(h);
      try {
        await c.pub.sendRawTransaction({ serializedTransaction: signedTx });
      } catch (err) {
        const msg = `${err.shortMessage || ""} ${err.details || ""} ${err.message || ""}`;
        // "already known" means the node already has it: treat as sent, not rejected.
        if (DEFINITE_REJECTION.test(msg) && !/already known/i.test(msg)) throw new Rejected(`the node refused ${h}: ${err.shortMessage || err.message}`);
        throw new Pending(`broadcast of ${h} reported an error (${err.shortMessage || err.message}).`, { tx: h, explorer: explorer(h), counted });
      }
      return { signed: signedTx, hash: h };
    },
    { name: "base-nonce", waitMs: 60_000 },
  );
  let receipt;
  try {
    receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (err) {
    throw new Pending(`no receipt for ${hash} yet (${err.shortMessage || err.message}).`, { tx: hash, explorer: explorer(hash), counted });
  }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Rejected(`${hash} was replaced by ${receipt.transactionHash} (its nonce was used by another transaction); ${hash} itself never landed`);
  }
  void signed;
  return receipt;
}

/** Send USDC on Base. Throws Refused when the limits say no; nothing is signed then. */
export async function sendUsdc({ to, amount }, c = clients()) {
  if (!isAddress(to)) throw new Error(`not a Base address: ${to}`);
  const units = usdcUnits(amount); // never rounded: more than 6 decimals is refused
  const usd = unitsToUsd(units);
  const entry = await reserve(loadPolicy(), { kind: "send", chain: "base", asset: "USDC", usd, to });

  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
  try {
    await c.pub.simulateContract({ account: c.account, address: USDC_BASE, abi: erc20Abi, functionName: "transfer", args: [to, units] });
  } catch (err) {
    release(entry, "simulation failed; nothing signed", { error: String(err.shortMessage || err.message) });
    throw err;
  }
  let receipt;
  try {
    receipt = await signAndSend(c, { to: USDC_BASE, data }, (hash) => record({ id: entry.id, status: "signed", tx: hash }));
  } catch (err) {
    // Pending = it may have gone out: stays counted. Anything else (an error before
    // signing, a definite rejection, a replaced nonce) never moved funds.
    if (!(err instanceof Pending)) release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: String(err.shortMessage || err.message) });
    throw err;
  }
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    throw new Error(`transaction reverted: ${explorer(receipt.transactionHash)}`);
  }
  record({ id: entry.id, status: "confirmed", tx: receipt.transactionHash });
  return { tx: receipt.transactionHash, explorer: explorer(receipt.transactionHash), usd, to };
}

/**
 * Dry run of a USDC send: the same simulation a real send runs, nothing
 * reserved, signed or sent. Throws with the simulation's reason if it would fail.
 */
export async function dryRunSendUsdc({ to, amount }, c = clients()) {
  if (!isAddress(to)) throw new Error(`not a Base address: ${to}`);
  const units = usdcUnits(amount);
  await c.pub.simulateContract({ account: c.account, address: USDC_BASE, abi: erc20Abi, functionName: "transfer", args: [to, units] });
  return { dry_run: true, chain: "base", usd: unitsToUsd(units), to, simulated: true };
}

/** The ERC-8004 registration file, as a data: URI stored fully onchain. */
export function registrationUri({ agentId, name, description, image = "", services = [], x402Support = false }) {
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description,
    image,
    services,
    // In ERC-8004 this advertises that the agent ACCEPTS x402 for its services.
    // An agent that only pays must not claim it.
    x402Support: Boolean(x402Support),
    active: true,
    registrations: agentId === undefined ? [] : [{ agentId: Number(agentId), agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` }],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
}

/** Agent ids this wallet already registered, and registrations sent but never confirmed, from the ledger. */
export function registeredIds() {
  const rows = entries();
  const done = rows.filter((e) => e.kind === "register" && e.agent_id).map((e) => e.agent_id);
  const doneTx = new Set(rows.filter((e) => e.kind === "register").map((e) => e.tx));
  const pending = rows.filter((e) => e.kind === "register_sent" && !doneTx.has(e.tx)).map((e) => e.tx);
  return { done, pending };
}

/**
 * Register this agent in the ERC-8004 IdentityRegistry on Base. Two transactions:
 * register (the id is only known after it), then setAgentURI with the full
 * registration file naming that id. Gas only, not counted against the USD limits.
 * `resume` finishes step two for an id whose first step already landed.
 */
export async function registerAgent({ name, description, image, services = [], x402Support = false, again = false, resume }, c = clients()) {
  if (!name || !description) throw new Error("--name and --description are required");
  const policy = loadPolicy();
  if (policy && !Array.isArray(policy.chains)) throw new Error("choose which chain(s) this agent works on first: `sato-agent policy set --chains <base|solana|base,solana>`");
  if (policy && !allowedChains(policy).includes("base")) throw new Error(`this agent is set to work on ${allowedChains(policy).join(" and ")} only; ERC-8004 registration is on Base`);
  let agentId;
  if (resume !== undefined) {
    if (!/^\d+$/.test(String(resume))) throw new Error("--resume takes the agent id");
    agentId = BigInt(resume);
  } else {
    const prior = registeredIds();
    if (prior.done.length && !again) throw new Error(`this wallet already registered agent id ${prior.done.join(", ")}; add --again to register another`);
    if (prior.pending.length && !again) throw new Error(`a registration was sent but never confirmed (${prior.pending.map(explorer).join(", ")}); check it, then use --resume <agent id> or --again`);
    const first = registrationUri({ name, description, image, services, x402Support });
    await c.pub.simulateContract({ account: c.account, address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "register", args: [first] });
    const r1 = await signAndSend(
      c,
      { to: IDENTITY_REGISTRY, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [first] }) },
      (hash) => record({ kind: "register_sent", status: "signed", chain: "base", usd: 0, tx: hash }),
      { counted: false },
    );
    if (r1.status !== "success") throw new Error(`register reverted: ${explorer(r1.transactionHash)}`);
    const ev = parseEventLogs({ abi: identityRegistryAbi, logs: r1.logs, eventName: "Registered" }).find(
      (l) => l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase(),
    );
    if (!ev) throw new Error(`no Registered event in ${explorer(r1.transactionHash)}`);
    agentId = ev.args.agentId;
    record({ kind: "register", status: "registered", chain: "base", usd: 0, agent_id: agentId.toString(), tx: r1.transactionHash });
  }

  const full = registrationUri({ agentId, name, description, image, services, x402Support });
  const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: [agentId, full] });
  try {
    await c.pub.call({ account: c.account, to: IDENTITY_REGISTRY, data });
    const r2 = await signAndSend(c, { to: IDENTITY_REGISTRY, data }, undefined, { counted: false });
    if (r2.status !== "success") throw new Error(`setAgentURI reverted: ${explorer(r2.transactionHash)}`);
    record({ kind: "register_uri", status: "confirmed", chain: "base", usd: 0, agent_id: agentId.toString(), tx: r2.transactionHash });
    return { agent_id: agentId.toString(), registry: `eip155:8453:${IDENTITY_REGISTRY}`, tx: r2.transactionHash, explorer: explorer(r2.transactionHash) };
  } catch (err) {
    throw new Error(`registered as agent ${agentId}, but writing its registration file failed (${err.shortMessage || err.message}). Finish with: sato-agent register --resume ${agentId} --name ... --description ...`);
  }
}
