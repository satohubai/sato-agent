// BNB Chain, Arbitrum and Polygon against local anvil forks: the real stablecoin contracts, the real ERC-8004 registry, the real
// KyberSwap router and pools, and the kit's own eth_simulateV1. A test wallet is funded with test balances; nothing reaches a real chain.
// The route and its calldata are built LIVE by KyberSwap's public API for the fork wallet; Sato Hub is not called (its build-tx writes
// a public record), so the Sato-shaped answer is wrapped around Kyber's and a passing signature check is injected.
//
//   SATO_AGENT_FORK=1 node --test test/chains-fork.test.js
//   FORK_CHAINS=bnb,arbitrum   which chains (default: all three)
//   FORK_RPC_BNB / FORK_RPC_ARBITRUM / FORK_RPC_POLYGON   the upstream RPC to fork (default: the first registry endpoint that answers)
// Needs `anvil` (Foundry) on PATH and network access. The Polygon public endpoints are rate limited: give it a keyed one if it stalls.
//
// Per chain: send the chain's stable (decimals-aware), swap native -> stable with the 15 bps fee decoded and found in the kit's own
// simulation, swap stable -> native with the exact approval reset to zero, buy a long-tail token with its sell-back simulated in a
// second block, register in ERC-8004.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, erc20Abi, http, keccak256, pad, toHex } from "viem";
import { freshHome, raisesInForce } from "./helpers.js";
import { passes, satoResponseFrom } from "./swap-evm-helpers.js";

const enabled = process.env.SATO_AGENT_FORK === "1";
const WANTED = (process.env.FORK_CHAINS || "bnb,arbitrum,polygon").split(",").map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

freshHome();
const chainsMod = await import("../src/chains.js");
const { evmChain, kyberApiBase, majorTokens, rpcUrls } = chainsMod;
const PORTS = { bnb: 20545, arbitrum: 21545, polygon: 22545 };
const base = 100 + Math.floor(Math.random() * 400);
for (const k of WANTED) process.env[evmChain(k).rpcEnv] = `http://127.0.0.1:${PORTS[k] + base}`;

const { initWallet } = await import("../src/wallet.js");
const { setPolicy: setPolicyAt } = await import("../src/policy.js");
const setPolicy = raisesInForce(setPolicyAt); // raises take effect at once here; the 24-hour wait is tested in test/hardening.test.js
const { Refused } = await import("../src/errors.js");
const { actions, spentLast24h } = await import("../src/ledger.js");
const baseMod = await import("../src/base.js");
const evm = await import("../src/swap/evm.js");

const LONG_TAIL = {
  bnb: { symbol: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18, name: "PancakeSwap Token", native: false, major: false },
  arbitrum: { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, name: "Arbitrum", native: false, major: false },
  polygon: { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, name: "Aave Token", native: false, major: false },
};
const NATIVE_AMOUNT = { bnb: "0.02", arbitrum: "0.005", polygon: "20" };
const procs = [];
after(() => procs.forEach((p) => p.kill()));
process.on("exit", () => procs.forEach((p) => p.kill()));

// Anvil reads state (storage, code, balances) from the upstream, never eth_call: ZAN's free Polygon endpoint serves that fast enough, where
// OnFinality's rate limit stalls the fork for minutes. Everything else forks from the first registry endpoint that answers.
const FORK_DEFAULT = { polygon: "https://api.zan.top/polygon-mainnet" };

async function upstream(key) {
  const own = process.env[`FORK_RPC_${key.toUpperCase()}`] || FORK_DEFAULT[key];
  if (own) return own;
  for (const url of rpcUrls(key, {})) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(8000) })).json();
        if (r.result) return url;
      } catch {
        /* next */
      }
      await sleep(1000);
    }
  }
  throw new Error(`no upstream RPC answered for ${key}`);
}

let me;
const forks = {};

for (const key of WANTED) {
  const c = evmChain(key);
  const T = majorTokens(key);
  const stable = T[c.defaultStable];
  const native = T[c.native.symbol];
  const tail = LONG_TAIL[key];
  const port = PORTS[key] + base;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: c.viem, transport: http(rpcUrl, { timeout: 90_000 }) });
  const rpc = (method, params) => pub.request({ method, params });
  const bal = (token, a) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  async function give(token, addr, units) {
    for (let slot = 0; slot < 60; slot++) {
      const k = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
      await rpc("anvil_setStorageAt", [token, k, pad(toHex(units))]);
      if ((await bal(token, addr)) === units) return slot;
      await rpc("anvil_setStorageAt", [token, k, pad("0x0")]);
    }
    throw new Error(`could not find the balance slot of ${token}`);
  }

  /** A live KyberSwap route + build for the fork wallet, wrapped the way Sato Hub answers (the fee on the input, or on the output when a token is sold). */
  async function liveSatoResponse({ tokenIn, tokenOut, units, slippageBps }) {
    const host = kyberApiBase(key);
    const headers = { "user-agent": "SatoHub-swap-dev/1.0", "x-client-id": "satohub", accept: "application/json" };
    const majors = new Set(Object.values(T).map((t) => t.address.toLowerCase()));
    const sells = !majors.has(tokenIn.toLowerCase());
    const buys = !majors.has(tokenOut.toLowerCase());
    const bothStable = [tokenIn, tokenOut].every((a) => Object.values(c.stables).some((s) => s.address.toLowerCase() === a.toLowerCase()));
    const bps = sells || buys ? 75 : bothStable ? 3 : 15;
    const tier = sells || buys ? "token" : bothStable ? "stable" : "major";
    const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: units.toString(), feeAmount: String(bps), chargeFeeBy: sells ? "currency_out" : "currency_in", isInBps: "true", feeReceiver: evm.SATO_FEE_RECIPIENT });
    let route;
    for (let i = 0; i < 4; i++) {
      route = await (await fetch(`${host}/routes?${q}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
      if (route.code === 0) break;
      await sleep(2000);
    }
    assert.equal(route.code, 0, `kyber routes: ${route.message}`);
    await sleep(1500);
    const build = await (await fetch(`${host}/route/build`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: me, recipient: me, slippageTolerance: slippageBps, source: "satohub" }), signal: AbortSignal.timeout(30_000) })).json();
    assert.equal(build.code, 0, `kyber build: ${build.message}`);
    await sleep(1500);
    return satoResponseFrom(route, build, { feeSide: sells ? "out" : "in", market: true, hubName: c.hubName, chainId: c.chainId, feeBps: bps, feeTier: tier });
  }

  const planLive = async ({ from, to, amount, slippageBps = 150 }) => {
    const { response, intent } = await evm.planBaseSwap(
      { from, to, amount, slippageBps },
      {
        taker: me,
        chain: key,
        callTool: async (_n, args) => ({ text: "", structured: await liveSatoResponse({ tokenIn: args.token_in, tokenOut: args.token_out, units: BigInt(args.amount_in), slippageBps: args.slippage_bps }), isError: false }),
      },
    );
    return { response, intent, verify: (extra = {}) => evm.verifyBaseSwapPlan(response, intent, { verifySignature: passes, ...extra }) };
  };

  test(`fork ${key}: anvil forks ${c.label} and the wallet is funded`, { skip: !enabled, timeout: 180_000 }, async () => {
    const url = await upstream(key);
    const p = spawn("anvil", ["--fork-url", url, "--port", String(port), "--silent", "--retries", "12", "--fork-retry-backoff", "1500", "--timeout", "60000"], { stdio: "ignore" });
    procs.push(p);
    for (let i = 0; i < 120; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await sleep(500);
      }
    }
    assert.equal(await pub.getChainId(), c.chainId);
    me ??= initWallet().base;
    await rpc("anvil_setBalance", [me, toHex(10n ** 20n)]);
    await give(stable.address, me, 500n * 10n ** BigInt(stable.decimals));
    setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", perTx: "1000", perDay: "100000", swapSlippageBps: "300", maxTradesPerDay: "none" });
    forks[key] = true;
    assert.equal(await bal(stable.address, me), 500n * 10n ** BigInt(stable.decimals));
  });

  test(`fork ${key}: send ${c.defaultStable} (${stable.decimals} decimals) inside the limits; a dry run moves nothing; the daily limit counts dollars`, { skip: !enabled, timeout: 180_000 }, async () => {
    assert.ok(forks[key], "the fork started");
    const to = "0x000000000000000000000000000000000000dEaD";
    const before = await bal(stable.address, to);
    const dry = await baseMod.dryRunSendStable({ to, amount: "12.5", chain: key });
    assert.deepEqual([dry.simulated, dry.chain, dry.usd], [true, key, 12.5]);
    assert.equal(await bal(stable.address, to), before);
    await assert.rejects(baseMod.dryRunSendStable({ to, amount: "5000", chain: key }), /exceeds balance|revert|insufficient/i, "a dry run that would fail says so");
    const r = await baseMod.sendStable({ to, amount: "12.5", chain: key });
    assert.equal((await bal(stable.address, to)) - before, 125n * 10n ** BigInt(stable.decimals - 1));
    assert.match(r.tx, /^0x[0-9a-f]{64}$/);
    assert.ok(r.explorer.startsWith(c.explorer.url), r.explorer);
    const row = actions().filter((a) => a.kind === "send" && a.chain === key).at(-1);
    assert.deepEqual([row.status, row.asset, row.usd], ["confirmed", c.defaultStable, 12.5]);
    setPolicy({ perDay: "20" });
    await assert.rejects(baseMod.sendStable({ to, amount: "10", chain: key }), (e) => e instanceof Refused && e.refusals[0].rule === "max_usd_per_day");
    setPolicy({ perDay: "100000" });
  });

  test(`fork ${key}: ${c.native.symbol} -> ${c.defaultStable}: real route, the 15 bps fee decoded, found in the kit's own simulation, balances move within min_out`, { skip: !enabled, timeout: 240_000 }, async () => {
    const s0 = await bal(stable.address, me);
    const n0 = await pub.getBalance({ address: me });
    const { verify } = await planLive({ from: c.native.symbol, to: c.defaultStable, amount: NATIVE_AMOUNT[key] });
    const plan = await verify({ usdNotional: 1 });
    assert.equal(plan.chain, key);
    assert.equal(plan.router, c.kyber.router);
    assert.equal(plan.approval.needed, false);
    assert.equal(plan.simulation.source, "eth_simulateV1");
    assert.deepEqual([plan.fee.tier, plan.fee.bps, plan.fee.side], ["major", 15, "in"]);
    assert.equal(plan.simulation.fee_seen, (plan.tx.value * 15n) / 10_000n, "15 bps of the coin sold reached the fee address");
    const out = await evm.executeBaseSwap(plan, { usdNotional: plan.usd });
    const s1 = await bal(stable.address, me);
    assert.ok(s1 - s0 >= plan.min_out, `received ${s1 - s0} >= min_out ${plan.min_out}`);
    assert.equal(out.received.amount, evm.unitsToDecimal(s1 - s0, stable.decimals));
    assert.ok(n0 - (await pub.getBalance({ address: me })) >= plan.tx.value, "the coin left");
    assert.equal(out.approve_tx, null);
    assert.ok(out.explorer.startsWith(c.explorer.url));
    const row = actions().filter((a) => a.kind === "swap" && a.chain === key).at(-1);
    assert.deepEqual([row.status, row.asset_in, row.asset_out, row.chain], ["confirmed", c.native.symbol, c.defaultStable, key]);
  });

  test(`fork ${key}: ${c.defaultStable} -> ${c.native.symbol}: exact approval to the pinned router, reset to zero after, the stable counted in dollars`, { skip: !enabled, timeout: 240_000 }, async () => {
    const s0 = await bal(stable.address, me);
    const { verify } = await planLive({ from: c.defaultStable, to: c.native.symbol, amount: "20" });
    const plan = await verify();
    assert.equal(plan.approval.needed, true);
    assert.equal(plan.usd, 20, "decimals-aware: 20 tokens are twenty dollars");
    const out = await evm.executeBaseSwap(plan, { usdNotional: plan.usd });
    assert.equal(s0 - (await bal(stable.address, me)), 20n * 10n ** BigInt(stable.decimals));
    const approveTx = await pub.getTransaction({ hash: out.approve_tx });
    const a = decodeFunctionData({ abi: erc20Abi, data: approveTx.input });
    assert.deepEqual([approveTx.to.toLowerCase(), a.functionName, a.args[0], a.args[1]], [stable.address.toLowerCase(), "approve", c.kyber.router, 20n * 10n ** BigInt(stable.decimals)]);
    assert.equal(await pub.readContract({ address: stable.address, abi: erc20Abi, functionName: "allowance", args: [me, c.kyber.router] }), 0n, "nothing is left open");
    assert.deepEqual(out.warnings, []);
    assert.equal(spentLast24h().usd > 0, true);
  });

  test(`fork ${key}: buy ${tail.symbol} with ${c.defaultStable}: the fee in ${c.defaultStable}, the sell-back simulated in a second block and never sent`, { skip: !enabled, timeout: 300_000 }, async () => {
    const tail0 = await bal(tail.address, me);
    const { verify } = await planLive({ from: c.defaultStable, to: tail, amount: "15" });
    const plan = await verify();
    assert.deepEqual([plan.fee.tier, plan.fee.bps, plan.fee.side, plan.long_tail], ["token", 75, "in", "out"]);
    assert.equal(plan.sell_back.checked, true);
    assert.ok(plan.sell_back.loss_bps <= plan.sell_back.allowed_loss_bps);
    assert.equal(await bal(tail.address, me), tail0, "the sell-back is only simulated");
    const out = await evm.executeBaseSwap(plan, { usdNotional: plan.usd });
    assert.ok((await bal(tail.address, me)) - tail0 >= plan.min_out);
    assert.deepEqual(out.warnings, []);
  });

  test(`fork ${key}: register in ERC-8004 on the real registry: a full onchain card naming ${c.caip2}`, { skip: !enabled, timeout: 180_000 }, async () => {
    const r = await baseMod.registerAgent({ name: `Sato ${c.label} fork test`, description: "fork test", chain: key });
    assert.ok(Number(r.agent_id) > 0);
    assert.equal(r.registry, `${c.caip2}:${c.erc8004Registry}`);
    await assert.rejects(baseMod.registerAgent({ name: "x", description: "y", chain: key }), /already registered agent id/);
    const uri = await pub.readContract({ address: c.erc8004Registry, abi: [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] }], functionName: "tokenURI", args: [BigInt(r.agent_id)] });
    const card = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    assert.deepEqual(card.registrations, [{ agentId: Number(r.agent_id), agentRegistry: `${c.caip2}:${c.erc8004Registry}` }]);
    const owner = await pub.readContract({ address: c.erc8004Registry, abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }], functionName: "ownerOf", args: [BigInt(r.agent_id)] });
    assert.equal(owner, me);
  });
}
