// Base (chain id 8453): balances, USDC sends under the owner's limits, and
// ERC-8004 self-registration. Every transaction is simulated before it is sent.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
} from "viem";
import { base } from "viem/chains";
import { evaluate, loadPolicy, Refused } from "./policy.js";
import { record, spentOn } from "./ledger.js";
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

/** Send USDC on Base. Refuses (throws Refused) when the owner's limits say no. */
export async function sendUsdc({ to, amount }, c = clients()) {
  if (!isAddress(to)) throw new Error(`not a Base address: ${to}`);
  const units = parseUnits(String(amount), 6);
  const usd = Number(formatUnits(units, 6));
  const refusals = evaluate(loadPolicy(), { usd, to }, spentOn());
  if (refusals.length) throw new Refused(refusals);

  const { request } = await c.pub.simulateContract({
    account: c.account,
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, units],
  });
  const entry = record({ status: "submitted", kind: "send", chain: "base", asset: "USDC", usd, to });
  let hash;
  try {
    hash = await c.wallet.writeContract(request);
  } catch (err) {
    record({ id: entry.id, status: "failed", reason: "not broadcast", error: String(err.shortMessage || err.message) });
    throw err;
  }
  const receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    record({ id: entry.id, status: "failed", reason: "reverted", tx: hash });
    throw new Error(`transaction reverted: ${hash}`);
  }
  record({ id: entry.id, status: "confirmed", tx: hash });
  return { tx: hash, explorer: `https://basescan.org/tx/${hash}`, usd, to };
}

/** The ERC-8004 registration file, as a data: URI stored fully onchain. */
export function registrationUri({ agentId, name, description, image = "", services = [] }) {
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description,
    image,
    services,
    x402Support: true,
    active: true,
    registrations: agentId === undefined ? [] : [{ agentId: Number(agentId), agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` }],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
}

/**
 * Register this agent in the ERC-8004 IdentityRegistry on Base. Two transactions:
 * register (the id is only known after it), then setAgentURI with the full
 * registration file that names that id. Costs gas only.
 */
export async function registerAgent({ name, description, image, services }, c = clients()) {
  if (!name || !description) throw new Error("--name and --description are required");
  const first = registrationUri({ name, description, image, services });
  const { request } = await c.pub.simulateContract({ account: c.account, address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "register", args: [first] });
  const hash1 = await c.wallet.writeContract(request);
  const r1 = await c.pub.waitForTransactionReceipt({ hash: hash1, timeout: 120_000 });
  if (r1.status !== "success") throw new Error(`register reverted: ${hash1}`);
  const ev = parseEventLogs({ abi: identityRegistryAbi, logs: r1.logs, eventName: "Registered" }).find(
    (l) => l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase(),
  );
  if (!ev) throw new Error(`no Registered event in ${hash1}`);
  const agentId = ev.args.agentId;

  const full = registrationUri({ agentId, name, description, image, services });
  const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: [agentId, full] });
  await c.pub.call({ account: c.account, to: IDENTITY_REGISTRY, data }); // simulate
  const hash2 = await c.wallet.sendTransaction({ to: IDENTITY_REGISTRY, data });
  const r2 = await c.pub.waitForTransactionReceipt({ hash: hash2, timeout: 120_000 });
  record({ status: "confirmed", kind: "register", chain: "base", usd: 0, agent_id: agentId.toString(), tx: [hash1, hash2] });
  return {
    agent_id: agentId.toString(),
    registry: `eip155:8453:${IDENTITY_REGISTRY}`,
    tx: [hash1, hash2],
    uri_set: r2.status === "success",
    explorer: `https://basescan.org/tx/${hash1}`,
  };
}
