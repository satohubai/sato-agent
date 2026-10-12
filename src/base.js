// EVM chains (Base today; the registry in src/chains.js decides which): balances, stablecoin
// sends under the limits, and ERC-8004 self-registration. The file keeps its v0.3 name because
// Base was the only EVM chain; every function takes the chain KEY (default "base") and reads
// its facts from the registry.
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
  formatUnits,
  isAddress,
  keccak256,
  parseEventLogs,
} from "viem";
import { usdcUnits, unitsToUsd } from "./amount.js";
import { DEFAULT_EVM_CHAIN, defaultStable, evmChain, explorerTx, lockName, stableBySymbol } from "./chains.js";
import { chainTransport } from "./rpc.js";
import { allowedChains, loadPolicy } from "./policy.js";
import { entries, record, release, reserve } from "./ledger.js";
import { Pending, Rejected } from "./errors.js";
import { withLock } from "./store.js";
import { evmAccount, loadWallet } from "./wallet.js";

// Kept under their v0.3 names for callers and tests pinned to Base; the values live in src/chains.js.
export const USDC_BASE = evmChain("base").stables.USDC.address;
export const IDENTITY_REGISTRY = evmChain("base").erc8004Registry;
// (Where the code says "no chain given", it means DEFAULT_EVM_CHAIN: Base, as in every v0.3 command.)

export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
];

const explorer = (chain, hash) => explorerTx(chain, hash);

// The chain's endpoints, in order, moving on when one turns a call away (src/rpc.js): the owner's own, else the registry's list.
const transport = (chain) => chainTransport(chain);

/** Viem clients for an EVM chain. `chainKey` rides on the object so the helpers below know which chain they are on. */
export function clients(account = evmAccount(), chain = DEFAULT_EVM_CHAIN) {
  const t = transport(chain);
  const viem = evmChain(chain).viem;
  return {
    account,
    chainKey: chain,
    pub: createPublicClient({ chain: viem, transport: t }),
    wallet: createWalletClient({ account, chain: viem, transport: t }),
  };
}

/**
 * The wallet's balances on a chain: { address, <native symbol lower case>: "…", <stable symbol lower case>: "…" … }.
 * On Base that is { address, eth, usdc }, the shape v0.3 printed.
 */
export async function balances(addr = loadWallet().evm.address, chain = DEFAULT_EVM_CHAIN) {
  const c = evmChain(chain);
  const pub = createPublicClient({ chain: c.viem, transport: transport(chain) });
  const stables = Object.values(c.stables);
  const [native, ...tokens] = await Promise.all([
    pub.getBalance({ address: addr }),
    ...stables.map((s) => pub.readContract({ address: s.address, abi: erc20Abi, functionName: "balanceOf", args: [addr] })),
  ]);
  return {
    address: addr,
    [c.native.symbol.toLowerCase()]: formatUnits(native, c.native.decimals),
    ...Object.fromEntries(stables.map((s, i) => [s.symbol.toLowerCase(), formatUnits(tokens[i], s.decimals)])),
  };
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
export async function signAndSend(c, { to, data, value = 0n, gas, nonce }, onSigned, { counted = true, chain: chainOpt } = {}) {
  const chain = chainOpt ?? c.chainKey ?? DEFAULT_EVM_CHAIN;
  const viem = evmChain(chain).viem;
  const { signed, hash, sentNonce } = await withLock(
    async () => {
      // `nonce` (and `gas`) can be given when the caller already knows them: right after
      // a transaction lands, a public RPC can still answer from a node that has not seen it.
      const prepared = await c.wallet.prepareTransactionRequest({
        account: c.account,
        to,
        data,
        value: BigInt(value),
        ...(gas ? { gas: BigInt(gas) } : {}),
        ...(nonce !== undefined ? { nonce: Number(nonce) } : {}),
        chain: viem,
      });
      const signedTx = await c.wallet.signTransaction(prepared);
      const h = keccak256(signedTx);
      onSigned?.(h);
      try {
        await c.pub.sendRawTransaction({ serializedTransaction: signedTx });
      } catch (err) {
        const msg = `${err.shortMessage || ""} ${err.details || ""} ${err.message || ""}`;
        // "already known" means the node already has it: treat as sent, not rejected.
        if (DEFINITE_REJECTION.test(msg) && !/already known/i.test(msg)) throw new Rejected(`the node refused ${h}: ${err.shortMessage || err.message}`);
        throw new Pending(`broadcast of ${h} reported an error (${err.shortMessage || err.message}).`, { tx: h, explorer: explorer(chain, h), counted });
      }
      return { signed: signedTx, hash: h, sentNonce: prepared.nonce };
    },
    { name: lockName(chain, "nonce"), waitMs: 60_000 },
  );
  let receipt;
  try {
    receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (err) {
    throw new Pending(`no receipt for ${hash} yet (${err.shortMessage || err.message}).`, { tx: hash, explorer: explorer(chain, hash), counted });
  }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Rejected(`${hash} was replaced by ${receipt.transactionHash} (its nonce was used by another transaction); ${hash} itself never landed`);
  }
  void signed;
  // The nonce this transaction used, so a follow-up can take the next one without asking the RPC.
  return Object.assign(receipt, { sentNonce });
}

/** The stable a send names (by symbol), or the chain's default. */
function stableFor(chain, symbol) {
  const s = symbol === undefined ? defaultStable(chain) : stableBySymbol(chain, symbol);
  if (!s) throw new Error(`${symbol} is not a stablecoin this kit sends on ${evmChain(chain).label}`);
  return s;
}

/**
 * Send a stablecoin (the chain's default stable unless `symbol` names another) on an EVM chain.
 * Throws Refused when the limits say no; nothing is signed then.
 */
export async function sendStable({ to, amount, checkout, chain = DEFAULT_EVM_CHAIN, symbol }, c = clients(undefined, chain)) {
  const label = evmChain(chain).label;
  const stable = stableFor(chain, symbol);
  if (!isAddress(to)) throw new Error(`not a ${label} address: ${to}`);
  const units = usdcUnits(amount, stable.decimals, stable.symbol); // never rounded: more decimals than the token has is refused
  const usd = unitsToUsd(units, stable.decimals);
  // A checkout (a payment link or a deposit address) is the same transfer, recorded as what it is: kind "checkout" with
  // its subtype, so `status` and `history` show a purchase, not a send. It counts against the limits the same way.
  const entry = await reserve(loadPolicy(), { kind: checkout ? "checkout" : "send", ...(checkout ? { checkout } : {}), chain, asset: stable.symbol, usd, to });

  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
  try {
    await c.pub.simulateContract({ account: c.account, address: stable.address, abi: erc20Abi, functionName: "transfer", args: [to, units] });
  } catch (err) {
    release(entry, "simulation failed; nothing signed", { error: String(err.shortMessage || err.message) });
    throw err;
  }
  let receipt;
  try {
    receipt = await signAndSend(c, { to: stable.address, data }, (hash) => record({ id: entry.id, status: "signed", tx: hash }), { chain });
  } catch (err) {
    // Pending = it may have gone out: stays counted. Anything else (an error before
    // signing, a definite rejection, a replaced nonce) never moved funds.
    if (!(err instanceof Pending)) release(entry, err instanceof Rejected ? "rejected; never landed" : "failed before broadcast", { error: String(err.shortMessage || err.message) });
    throw err;
  }
  if (receipt.status !== "success") {
    release(entry, "reverted onchain", { tx: receipt.transactionHash });
    throw new Error(`transaction reverted: ${explorer(chain, receipt.transactionHash)}`);
  }
  record({ id: entry.id, status: "confirmed", tx: receipt.transactionHash });
  return { tx: receipt.transactionHash, explorer: explorer(chain, receipt.transactionHash), usd, to };
}

/** Send USDC on Base (the v0.3 entry point; `chain` / `symbol` select another stable or chain). */
export const sendUsdc = (args, c) => sendStable({ symbol: "USDC", ...args }, c ?? clients(undefined, args.chain ?? DEFAULT_EVM_CHAIN));

/**
 * Dry run of a stablecoin send: the same simulation a real send runs, nothing
 * reserved, signed or sent. Throws with the simulation's reason if it would fail.
 */
export async function dryRunSendStable({ to, amount, chain = DEFAULT_EVM_CHAIN, symbol }, c = clients(undefined, chain)) {
  const stable = stableFor(chain, symbol);
  if (!isAddress(to)) throw new Error(`not a ${evmChain(chain).label} address: ${to}`);
  const units = usdcUnits(amount, stable.decimals, stable.symbol);
  await c.pub.simulateContract({ account: c.account, address: stable.address, abi: erc20Abi, functionName: "transfer", args: [to, units] });
  return { dry_run: true, chain, usd: unitsToUsd(units, stable.decimals), to, simulated: true };
}

export const dryRunSendUsdc = (args, c) => dryRunSendStable({ symbol: "USDC", ...args }, c ?? clients(undefined, args.chain ?? DEFAULT_EVM_CHAIN));

/** The ERC-8004 registration file, as a data: URI stored fully onchain. */
export function registrationUri({ agentId, name, description, image = "", services = [], x402Support = false, chain = DEFAULT_EVM_CHAIN }) {
  const c = evmChain(chain);
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
    registrations: agentId === undefined ? [] : [{ agentId: Number(agentId), agentRegistry: `${c.caip2}:${c.erc8004Registry}` }],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
}

/** Agent ids this wallet already registered on `chain`, and registrations sent but never confirmed, from the ledger. */
export function registeredIds(chain = DEFAULT_EVM_CHAIN) {
  // A row with no chain is one of v0.1's: written before there was a second EVM chain.
  const rows = entries().filter((e) => (e.chain ?? DEFAULT_EVM_CHAIN) === chain);
  const done = rows.filter((e) => e.kind === "register" && e.agent_id).map((e) => e.agent_id);
  const doneTx = new Set(rows.filter((e) => e.kind === "register").map((e) => e.tx));
  const pending = rows.filter((e) => e.kind === "register_sent" && !doneTx.has(e.tx)).map((e) => e.tx);
  return { done, pending };
}

/**
 * Register this agent in the ERC-8004 IdentityRegistry on an EVM chain. Two transactions:
 * register (the id is only known after it), then setAgentURI with the full
 * registration file naming that id. Gas only, not counted against the USD limits.
 * `resume` finishes step two for an id whose first step already landed.
 */
/** How many times step two of a fresh registration is tried while the RPC catches up (2 s apart; nothing signed is retried). */
const REGISTER_STEP2_TRIES = 6;

export async function registerAgent({ name, description, image, services = [], x402Support = false, again = false, resume, chain = DEFAULT_EVM_CHAIN }, c = clients(undefined, chain)) {
  if (!name || !description) throw new Error("--name and --description are required");
  const ch = evmChain(chain);
  const registry = ch.erc8004Registry;
  const registryId = `${ch.caip2}:${registry}`;
  const policy = loadPolicy();
  if (policy && !Array.isArray(policy.chains)) throw new Error("choose which chain(s) this agent works on first: `sato-agent policy set --chains <base|solana|base,solana>`");
  if (policy && !allowedChains(policy).includes(chain)) throw new Error(`this agent is set to work on ${allowedChains(policy).join(" and ")} only; ERC-8004 registration is on ${ch.label}`);
  let agentId;
  let r1; // step one's receipt (a fresh registration only)
  if (resume !== undefined) {
    if (!/^\d+$/.test(String(resume))) throw new Error("--resume takes the agent id");
    agentId = BigInt(resume);
  } else {
    const prior = registeredIds(chain);
    if (prior.done.length && !again) throw new Error(`this wallet already registered agent id ${prior.done.join(", ")}; add --again to register another`);
    if (prior.pending.length && !again) throw new Error(`a registration was sent but never confirmed (${prior.pending.map((h) => explorer(chain, h)).join(", ")}); check it, then use --resume <agent id> or --again`);
    const first = registrationUri({ name, description, image, services, x402Support, chain });
    await c.pub.simulateContract({ account: c.account, address: registry, abi: identityRegistryAbi, functionName: "register", args: [first] });
    r1 = await signAndSend(
      c,
      { to: registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [first] }) },
      (hash) => record({ kind: "register_sent", status: "signed", chain, usd: 0, tx: hash }),
      { counted: false, chain },
    );
    if (r1.status !== "success") throw new Error(`register reverted: ${explorer(chain, r1.transactionHash)}`);
    const ev = parseEventLogs({ abi: identityRegistryAbi, logs: r1.logs, eventName: "Registered" }).find(
      (l) => l.address.toLowerCase() === registry.toLowerCase(),
    );
    if (!ev) throw new Error(`no Registered event in ${explorer(chain, r1.transactionHash)}`);
    agentId = ev.args.agentId;
    record({ kind: "register", status: "registered", chain, usd: 0, agent_id: agentId.toString(), tx: r1.transactionHash });
  }

  const full = registrationUri({ agentId, name, description, image, services, x402Support, chain });
  const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: [agentId, full] });
  // Right after step one, a load-balanced public RPC can answer from a node that has not seen the
  // new agent yet, so the check and the gas estimate revert (seen live 2026-10-09; a --resume a
  // minute later worked). Step two then takes the next nonce, and a revert BEFORE anything is
  // signed is retried a few times while the node catches up. Nothing signed is ever retried.
  const fresh = resume === undefined && Number.isInteger(r1?.sentNonce);
  const sleep = c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    let r2;
    for (let attempt = 1; ; attempt++) {
      try {
        await c.pub.call({ account: c.account, to: registry, data });
        r2 = await signAndSend(c, { to: registry, data, ...(fresh ? { nonce: r1.sentNonce + 1 } : {}) }, undefined, { counted: false, chain });
        break;
      } catch (err) {
        if (!fresh || err instanceof Pending || err instanceof Rejected || attempt >= REGISTER_STEP2_TRIES) throw err;
        await sleep(2_000);
      }
    }
    if (r2.status !== "success") throw new Error(`setAgentURI reverted: ${explorer(chain, r2.transactionHash)}`);
    record({ kind: "register_uri", status: "confirmed", chain, usd: 0, agent_id: agentId.toString(), tx: r2.transactionHash });
    return { agent_id: agentId.toString(), registry: registryId, tx: r2.transactionHash, explorer: explorer(chain, r2.transactionHash) };
  } catch (err) {
    throw new Error(`registered as agent ${agentId}, but writing its registration file failed (${err.shortMessage || err.message}). Finish with: sato-agent register --resume ${agentId} --name ... --description ...`);
  }
}
