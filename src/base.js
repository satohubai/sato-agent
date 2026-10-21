// EVM chains (Base today; the registry in src/chains.js decides which): balances, stablecoin
// sends under the limits, and ERC-8004 self-registration. The file keeps its v0.3 name because
// Base was the only EVM chain; every function takes the chain KEY (default "base") and reads
// its facts from the registry.
//
// A send is reserved against the limits first, simulated, then signed HERE and
// its hash recorded before it is broadcast. If the broadcast or the receipt
// wait fails, the spend stays counted and the command says "do not retry"
// (Pending): the node may have accepted it.

import { randomUUID } from "node:crypto";
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
import { chainTransport, sendAttempts } from "./rpc.js";
import { CHAINS_USAGE, allowedChains, loadPolicy } from "./policy.js";
import { entries, record, release, reserve } from "./ledger.js";
import { Pending, PlainError, Rejected } from "./errors.js";
import { passportUrl, resolveForRegister, savePassport, withPassportService } from "./passport.js";
import { AGENT_WALLET_DEADLINE_S, PASSPORT_METADATA_KEY, agentWalletTypedData, builderCodeFromEnv, passportMetadata, registryPassportAbi, setAgentWalletData, withBuilderSuffix } from "./passport-onchain.js";
import { withLock } from "./store.js";
import { evmAccount, loadWallet } from "./wallet.js";

// Kept under their v0.3 names for callers and tests pinned to Base; the values live in src/chains.js.
export const USDC_BASE = evmChain("base").stables.USDC.address;
export const IDENTITY_REGISTRY = evmChain("base").erc8004Registry;
// (Where the code says "no chain given", it means DEFAULT_EVM_CHAIN: Base, as in every v0.3 command.)

export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
  // register(string, (string,bytes)[]), getAgentWallet, getMetadata, setAgentWallet: the Sato Passport tag and the payment wallet (src/passport-onchain.js).
  ...registryPassportAbi,
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
 * The client must be for the chain the transaction is for. A client carries its chain's key (`clients(account, chain)`); one with
 * none is Base's, as in v0.3. A mismatch is a programming error that would sign for one chain and broadcast on another, so it stops
 * before anything is signed.
 */
export function assertClientChain(c, chain, doing = "use") {
  const has = c?.chainKey ?? DEFAULT_EVM_CHAIN;
  if (has !== chain) throw new Error(`refusing to ${doing} for ${chain} with a client for ${has}: nothing was signed`);
}

/**
 * Sign locally, record the hash, broadcast, wait. Returns the receipt.
 * Nonce assignment through broadcast is serialized by a lock, so two commands
 * never sign with the same nonce. Throws Rejected when the node definitely
 * refused it, Pending when the outcome is unknown (kept counted), and Rejected
 * when another transaction took the nonce (ours can then never land).
 */
export async function signAndSend(c, { to, data, value = 0n, gas, nonce }, onSigned, { counted = true, chain: chainOpt } = {}) {
  const chain = chainOpt ?? c.chainKey ?? DEFAULT_EVM_CHAIN;
  assertClientChain(c, chain, "sign");
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
        // A send attempted more than once in total (another endpoint, or the same one again) cannot say that a "nonce too low" or an
        // "already known" is a refusal: an earlier attempt may have landed and this is the answer to the repeat. Pending.
        const repeated = sendAttempts(err) > 1;
        // "already known" means the node already has it: treat as sent, not rejected.
        if (!repeated && DEFINITE_REJECTION.test(msg) && !/already known/i.test(msg)) throw new Rejected(`the node refused ${h}: ${err.shortMessage || err.message}`);
        throw new Pending(`broadcast of ${h} reported an error (${err.shortMessage || err.message}).`, { tx: h, explorer: explorer(chain, h), counted });
      }
      return { signed: signedTx, hash: h, sentNonce: prepared.nonce };
    },
    { name: lockName(chain, "nonce"), waitMs: 60_000 },
  );
  // Wait up to two minutes in all. viem gives up on the first receipt lookup that errors, and on public endpoints a whole round can
  // fail at once (rate limits, an endpoint calling a lookup "Invalid parameters": Polygon, 2026-10-15), so an RPC error is waited out
  // and asked again until the deadline. A timeout, or anything that is not an RPC error, ends the wait as Pending. Reading never signs.
  let receipt;
  const deadline = Date.now() + 120_000;
  const pause = c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    try {
      receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: Math.max(1_000, deadline - Date.now()) });
      break;
    } catch (err) {
      const timedOut = err?.name === "WaitForTransactionReceiptTimeoutError";
      const rpcError = typeof (err?.code ?? err?.cause?.code) === "number" || /Rpc|Http|BlockNotFound|TransactionNotFound|^TimeoutError$/.test(err?.name ?? "");
      if (timedOut || !rpcError || Date.now() > deadline - 3_000) {
        throw new Pending(`no receipt for ${hash} yet (${err.shortMessage || err.message}).`, { tx: hash, explorer: explorer(chain, hash), counted });
      }
      await pause(3_000);
    }
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

/**
 * The ERC-8004 registration file, as a data: URI stored fully onchain.
 * `passport` (a Sato Passport id, sato:agt:...) adds one entry to `services` that links this registration to that passport:
 * the agent's own declaration, never checked against Sato Hub here. An invalid id throws before anything is built; with no
 * passport the file is exactly what it was before the option existed.
 */
export function registrationUri({ agentId, name, description, image = "", services = [], x402Support = false, chain = DEFAULT_EVM_CHAIN, passport }) {
  const c = evmChain(chain);
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description,
    image,
    services: withPassportService(services, passport),
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
 * True when `resume` names an agent this wallet registered on the chain AFTER its first one (a `--again` registration being finished):
 * not the agent a saved Sato Passport belongs to. `done` is `registeredIds(chain).done`, oldest first. An id the ledger does not know is
 * not "later": a resume of it behaves as it always did.
 */
export const isLaterAgent = (resume, done) => /^\d+$/.test(String(resume)) && done.indexOf(BigInt(resume).toString()) > 0;

/**
 * Register this agent in the ERC-8004 IdentityRegistry on an EVM chain. Two transactions:
 * register (the id is only known after it), then setAgentURI with the full
 * registration file naming that id. Gas only, not counted against the USD limits.
 * `resume` finishes step two for an id whose first step already landed.
 */
/** How many times step two of a fresh registration is tried while the RPC catches up (2 s apart; nothing signed is retried). */
const REGISTER_STEP2_TRIES = 6;

export async function registerAgent({ name, description, image, services = [], x402Support = false, passport, again = false, resume, chain = DEFAULT_EVM_CHAIN }, c = clients(undefined, chain)) {
  if (!name || !description) throw new Error("--name and --description are required");
  // The Sato Passport link (see src/passport.js): checked first, so a bad id stops here with nothing read from a chain or sent. `passport`
  // undefined = the one saved on this computer, an id = that one (saved below), null = none from now on. No call to Sato Hub is made.
  // Another agent from the same wallet (`again`, or a --resume of one registered after the first) never takes the saved one: a passport
  // belongs to one agent. Only an id given on that command is used, for that file alone, and nothing saved is changed.
  const prior = registeredIds(chain);
  const pp = resolveForRegister(passport, { again, resume, laterAgent: isLaterAgent(resume, prior.done) });
  const keepPassport = () => {
    if (pp.save) savePassport(pp.passport); // only once every check below has passed, and before anything is signed, so a --resume keeps it
  };
  // The registry's metadata entry ("satohub.passport", the id) goes with the registration itself, so only a fresh registration (step one) can
  // carry it; a --resume writes the file only. The Base Builder Code (SATO_BUILDER_CODE, Base only) goes on every registry transaction sent
  // here. Both are checked now, before anything is read from a chain or signed: a bad env value stops the command.
  const passportMeta = pp.passport ? passportMetadata(pp.passport) : null;
  const builderCode = chain === DEFAULT_EVM_CHAIN ? builderCodeFromEnv() : null;
  const sfx = (data) => withBuilderSuffix(chain, data);
  const ch = evmChain(chain);
  const registry = ch.erc8004Registry;
  const registryId = `${ch.caip2}:${registry}`;
  const policy = loadPolicy();
  if (policy && !Array.isArray(policy.chains)) throw new Error("choose which chain(s) this agent works on first: `sato-agent policy set --chains <" + CHAINS_USAGE + ">`");
  if (policy && !allowedChains(policy).includes(chain)) throw new Error(`this agent is set to work on ${allowedChains(policy).join(" and ")} only; ERC-8004 registration is on ${ch.label}`);
  let agentId;
  let r1; // step one's receipt (a fresh registration only)
  if (resume !== undefined) {
    if (!/^\d+$/.test(String(resume))) throw new Error("--resume takes the agent id");
    agentId = BigInt(resume);
    // Only this wallet's own agent: setAgentURI also lets an approved address through, and a resume records the id as this
    // wallet's registration. Read before anything is signed.
    const owner = await c.pub.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] });
    if (String(owner).toLowerCase() !== c.account.address.toLowerCase()) {
      throw new Error(`agent ${agentId} on ${ch.label} belongs to ${owner}, not this wallet (${c.account.address}); nothing was signed`);
    }
    keepPassport();
  } else {
    if (prior.done.length && !again) throw new Error(`this wallet already registered agent id ${prior.done.join(", ")}; add --again to register another`);
    if (prior.pending.length && !again) throw new Error(`a registration was sent but never confirmed (${prior.pending.map((h) => explorer(chain, h)).join(", ")}); check it, then use --resume <agent id> or --again`);
    const first = registrationUri({ name, description, image, services, x402Support, chain, passport: pp.passport });
    const registerArgs = passportMeta ? [first, passportMeta] : [first];
    const registerData = sfx(encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: registerArgs }));
    // With a Builder Code the simulation runs on the exact calldata that will be signed (the suffix included).
    if (builderCode) await c.pub.call({ account: c.account, to: registry, data: registerData });
    else await c.pub.simulateContract({ account: c.account, address: registry, abi: identityRegistryAbi, functionName: "register", args: registerArgs });
    keepPassport();
    r1 = await signAndSend(
      c,
      { to: registry, data: registerData },
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

  const full = registrationUri({ agentId, name, description, image, services, x402Support, chain, passport: pp.passport });
  const data = sfx(encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: [agentId, full] }));
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
    // A resume that finished step two also records the registration itself, so `proof` and a later `register` see it (the id was
    // checked above to be this wallet's own). It names step one's transaction only when that transaction registered this very id.
    if (resume !== undefined && !prior.done.includes(agentId.toString())) {
      let tx;
      for (const h of prior.pending) {
        try {
          const rc = await c.pub.getTransactionReceipt({ hash: h });
          const ev = parseEventLogs({ abi: identityRegistryAbi, logs: rc.logs ?? [], eventName: "Registered" }).find((l) => l.address.toLowerCase() === registry.toLowerCase());
          if (ev && ev.args.agentId === agentId) tx = h;
        } catch {
          /* unreadable: recorded without it */
        }
      }
      record({ kind: "register", status: "registered", chain, usd: 0, agent_id: agentId.toString(), ...(tx ? { tx } : {}) });
    }
    return {
      agent_id: agentId.toString(),
      registry: registryId,
      tx: r2.transactionHash,
      explorer: explorer(chain, r2.transactionHash),
      ...(pp.passport ? { passport: pp.passport, passport_url: passportUrl(pp.passport) } : {}),
      ...(pp.skippedSaved ? { passport_skipped: pp.skippedSaved } : {}),
      // What this call wrote besides the file: the registry tag (a fresh registration only) and the Base Builder Code.
      ...(passportMeta && resume === undefined ? { passport_metadata: PASSPORT_METADATA_KEY } : {}),
      ...(builderCode ? { builder_code: builderCode } : {}),
    };
  } catch (err) {
    throw new Error(`registered as agent ${agentId}, but writing its registration file failed (${err.shortMessage || err.message}). Finish with: sato-agent register --resume ${agentId} --name ... --description ...${pp.another && pp.passport ? ` --passport ${pp.passport}` : ""}`);
  }
}

/**
 * Point an ERC-8004 agent's payment wallet at THIS bot's own wallet: setAgentWallet(agentId, wallet, deadline, signature). The registry
 * empties an agent's wallet whenever the agent is transferred, so after Sato Hub hands a sponsored registration to the bot's wallet, the
 * agent has no payment wallet until its new owner sets one. The bot is both the owner and the new wallet here, so one key signs the EIP-712
 * message AgentWalletSet and sends the transaction (gas only, not counted against the USD limits).
 *
 * Read-only checks first, and nothing signed until they pass: the agent is this wallet's (ownerOf), its payment wallet is not already this
 * wallet (then nothing is sent), and the wallet holds some of the chain's coin for gas. Then `deps.authorize()` (the owner's approval, when
 * the owner chose "ask"; it throws to stop), then the signature, a simulation of the exact calldata, and the transaction.
 * `dryRun` stops after the checks. deps: authorize, deadline (seconds, for the tests), env.
 * Returns { already: true, ... } when nothing needed doing, { dry_run: true, ... } for a dry run, else { tx, explorer, ... }.
 */
export async function setAgentWallet({ agentId, chain = DEFAULT_EVM_CHAIN, dryRun = false }, c = clients(undefined, chain), deps = {}) {
  if (!/^\d+$/.test(String(agentId))) throw new PlainError("--agent-id takes the ERC-8004 agent id (a whole number)");
  const env = deps.env ?? process.env;
  if (chain === DEFAULT_EVM_CHAIN) builderCodeFromEnv(env); // a bad SATO_BUILDER_CODE stops it now, before anything is read or signed
  const ch = evmChain(chain);
  const registry = ch.erc8004Registry;
  const policy = loadPolicy();
  if (policy && !Array.isArray(policy.chains)) throw new Error("choose which chain(s) this agent works on first: `sato-agent policy set --chains <" + CHAINS_USAGE + ">`");
  if (policy && !allowedChains(policy).includes(chain)) throw new PlainError(`this agent is set to work on ${allowedChains(policy).join(" and ")} only; the ERC-8004 registry meant here is on ${ch.label}. Nothing was signed.`);
  const id = BigInt(agentId);
  const wallet = c.account.address;
  const owner = await c.pub.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] });
  if (String(owner).toLowerCase() !== wallet.toLowerCase()) {
    throw new PlainError(`agent ${id} on ${ch.label} belongs to ${owner}, not this wallet (${wallet}); nothing was signed. Only the wallet that owns an agent can set its payment wallet: wait until Sato Hub has handed it over.`);
  }
  const current = await c.pub.readContract({ address: registry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [id] });
  const base = { agent_id: id.toString(), wallet, chain, registry: `${ch.caip2}:${registry}` };
  if (String(current).toLowerCase() === wallet.toLowerCase()) return { ...base, already: true };
  const gas = await c.pub.getBalance({ address: wallet });
  if (gas === 0n) {
    throw new PlainError(`this wallet holds no ${ch.native.symbol} on ${ch.label}, so it cannot pay the gas for this. Send a little ${ch.native.symbol} to ${wallet} and run it again; nothing was signed.`);
  }
  if (dryRun) return { ...base, dry_run: true, current_wallet: /^0x0{40}$/i.test(String(current)) ? null : current };
  await deps.authorize?.();

  // The deadline is read from the chain's own clock (4 minutes ahead; the registry allows 5), so a skewed clock on this computer cannot make it expire.
  let nowS;
  try {
    nowS = (await c.pub.getBlock()).timestamp;
  } catch {
    nowS = BigInt(Math.floor(Date.now() / 1000));
  }
  const deadline = deps.deadline !== undefined ? BigInt(deps.deadline) : BigInt(nowS) + BigInt(AGENT_WALLET_DEADLINE_S);
  const signature = await c.account.signTypedData(agentWalletTypedData({ chain, agentId: id, newWallet: wallet, owner: wallet, deadline }));
  const data = setAgentWalletData({ chain, agentId: id, newWallet: wallet, deadline, signature }, env);
  try {
    await c.pub.call({ account: c.account, to: registry, data });
  } catch (err) {
    throw new PlainError(`the registry would refuse this (${err.shortMessage || err.message}); nothing was sent.`);
  }
  const ledgerId = randomUUID();
  const receipt = await signAndSend(c, { to: registry, data }, (hash) => record({ id: ledgerId, kind: "set_agent_wallet", status: "signed", chain, usd: 0, agent_id: id.toString(), tx: hash }), { counted: false, chain });
  if (receipt.status !== "success") throw new Error(`setAgentWallet reverted: ${explorer(chain, receipt.transactionHash)}`);
  record({ id: ledgerId, kind: "set_agent_wallet", status: "confirmed", tx: receipt.transactionHash });
  return { ...base, tx: receipt.transactionHash, explorer: explorer(chain, receipt.transactionHash) };
}
