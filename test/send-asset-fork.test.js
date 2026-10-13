// `send --asset` against local anvil forks of Base and BNB Chain: the real chain's Chainlink feed, the real token contracts, the kit's own
// eth_simulateV1. A native send, `--amount all` of the native coin (the gas reserve against the real fee), and an ordinary ERC-20.
// Test balances only; nothing reaches a real chain.
//
//   SATO_AGENT_FORK=1 node --test test/send-asset-fork.test.js
//   FORK_CHAINS=base,bnb   which chains (default: both)
//   FORK_RPC_BASE / FORK_RPC_BNB   the upstream RPC to fork (default: the first registry endpoint that answers)
// Needs `anvil` (Foundry) on PATH and network access.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, pad, toHex } from "viem";
import { freshHome } from "./helpers.js";

const enabled = process.env.SATO_AGENT_FORK === "1";
const WANTED = (process.env.FORK_CHAINS || "base,bnb").split(",").map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

freshHome();
const { evmChain, rpcUrls } = await import("../src/chains.js");
const PORTS = { base: 23545, bnb: 24545 };
const offset = 100 + Math.floor(Math.random() * 400);
for (const k of WANTED) process.env[evmChain(k).rpcEnv] = `http://127.0.0.1:${PORTS[k] + offset}`;

const { initWallet } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { actions } = await import("../src/ledger.js");
const send = await import("../src/send/index.js");

// An ordinary token on each chain: AERO on Base, CAKE on BNB Chain.
const TOKEN = {
  base: { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  bnb: { symbol: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
};
const TO = "0x000000000000000000000000000000000000dEaD";
const procs = [];
after(() => procs.forEach((p) => p.kill()));
process.on("exit", () => procs.forEach((p) => p.kill()));

async function upstream(key) {
  const own = process.env[`FORK_RPC_${key.toUpperCase()}`];
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
for (const key of WANTED) {
  const c = evmChain(key);
  const port = PORTS[key] + offset;
  const pub = createPublicClient({ chain: c.viem, transport: http(`http://127.0.0.1:${port}`, { timeout: 90_000 }) });
  const rpc = (method, params) => pub.request({ method, params });
  const tokenBal = (a) => pub.readContract({ address: TOKEN[key].address, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const state = {};

  async function give(token, addr, units) {
    for (let slot = 0; slot < 60; slot++) {
      const k = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
      await rpc("anvil_setStorageAt", [token, k, pad(toHex(units))]);
      if ((await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [addr] })) === units) return;
      await rpc("anvil_setStorageAt", [token, k, pad("0x0")]);
    }
    throw new Error(`could not find the balance slot of ${token}`);
  }

  test(`send fork ${key}: anvil forks ${c.label}; the wallet holds ${c.native.symbol} and an ordinary token`, { skip: !enabled, timeout: 180_000 }, async () => {
    // Base is an OP-stack chain: its fork runs in anvil's Optimism mode (deposit transactions, the OP fee fields).
    const network = key === "base" ? ["--network", "optimism"] : [];
    const p = spawn("anvil", [...network, "--fork-url", await upstream(key), "--port", String(port), "--silent", "--retries", "12", "--fork-retry-backoff", "1500", "--timeout", "60000"], { stdio: "ignore" });
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
    await rpc("anvil_setBalance", [me, toHex(10n ** 18n)]);
    await give(TOKEN[key].address, me, 1000n * 10n ** 18n);
    setPolicy({ chains: "base,bnb", perTx: "100000", perDay: "1000000" });
    state.ready = true;
  });

  test(`send fork ${key}: ${c.native.symbol} is sent as a plain transfer, priced from the real Chainlink feed; a dry run moves nothing`, { skip: !enabled, timeout: 180_000 }, async () => {
    assert.ok(state.ready, "the fork started");
    const before = await pub.getBalance({ address: TO });
    const plan = await send.planSend({ chain: key, to: TO, amount: "0.001", asset: c.native.symbol });
    assert.equal(plan.asset.kind, "native");
    assert.ok(plan.usd > 0 && !plan.unpriced, `priced: ${plan.usd}`);
    assert.equal(await pub.getBalance({ address: TO }), before, "planning moves nothing");
    const r = await send.executeSend(plan);
    assert.equal((await pub.getBalance({ address: TO })) - before, 10n ** 15n);
    assert.match(r.tx, /^0x[0-9a-f]{64}$/);
    const row = actions().filter((a) => a.kind === "send" && a.chain === key).at(-1);
    assert.deepEqual([row.status, row.asset, row.amount, row.asset_address], ["confirmed", c.native.symbol, "0.001", undefined]);
  });

  if (key === "base") {
    test("send fork base: the registry's data-fee pad is far above what Base's GasPriceOracle charges for a transfer-sized transaction", { skip: !enabled, timeout: 180_000 }, async () => {
      assert.ok(state.ready, "the fork started");
      const abi = [{ type: "function", name: "getL1Fee", stateMutability: "view", inputs: [{ name: "_data", type: "bytes" }], outputs: [{ type: "uint256" }] }];
      const fee = await pub.readContract({ address: "0x420000000000000000000000000000000000000F", abi, functionName: "getL1Fee", args: [`0x${"ab".repeat(112)}`] });
      assert.ok(fee > 0n, "the oracle answers");
      assert.ok(fee * 100n < c.sendReserve.l1DataWei, `${fee} wei against a pad of ${c.sendReserve.l1DataWei}`);
    });
  }

  test(`send fork ${key}: ${c.native.symbol} --amount all leaves the gas reserve and the transfer lands`, { skip: !enabled, timeout: 180_000 }, async () => {
    assert.ok(state.ready, "the fork started");
    const before = await pub.getBalance({ address: TO });
    const wallet = await pub.getBalance({ address: me });
    const plan = await send.planSend({ chain: key, to: TO, amount: "all", asset: c.native.symbol });
    assert.equal(plan.units + plan.stays.wei, wallet);
    assert.ok(plan.stays.wei > 0n);
    await send.executeSend(plan);
    assert.equal((await pub.getBalance({ address: TO })) - before, plan.units);
    const left = await pub.getBalance({ address: me });
    assert.ok(left > 0n && left <= plan.stays.wei, `${left} stays, within the reserve ${plan.stays.wei}`);
  });

  test(`send fork ${key}: ${TOKEN[key].symbol}, an ordinary ERC-20, goes by address: no price, counted $0, the recipient's balance read in the simulation`, { skip: !enabled, timeout: 180_000 }, async () => {
    assert.ok(state.ready, "the fork started");
    await rpc("anvil_setBalance", [me, toHex(10n ** 18n)]); // gas again after the all-send
    const before = await tokenBal(TO);
    const plan = await send.planSend({ chain: key, to: TO, amount: "250.5", asset: TOKEN[key].address });
    assert.deepEqual([plan.unpriced, plan.usd, plan.asset.kind], [true, null, "token"]);
    assert.equal(plan.received, null, "no fee on transfer");
    assert.match(plan.asset.label, new RegExp(`^${TOKEN[key].symbol} 0x`, "i"));
    assert.equal(await tokenBal(TO), before);
    await send.executeSend(plan);
    assert.equal((await tokenBal(TO)) - before, 2505n * 10n ** 17n);
    const row = actions().filter((a) => a.kind === "send" && a.chain === key).at(-1);
    assert.deepEqual([row.status, row.usd, row.unpriced, row.asset_address.toLowerCase()], ["confirmed", null, true, TOKEN[key].address.toLowerCase()]);
    const all = await send.planSend({ chain: key, to: TO, amount: "all", asset: TOKEN[key].address });
    assert.equal(all.units, await tokenBal(me));
    await assert.rejects(send.planSend({ chain: key, to: TO, amount: "100000", asset: TOKEN[key].address }), /insufficient_balance|holds/);
  });
}
