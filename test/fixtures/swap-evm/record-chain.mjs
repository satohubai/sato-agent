// Records KyberSwap fixtures for one EVM chain of the registry (BNB Chain, Arbitrum, Polygon): the real aggregator route + build, and
// the kit's OWN eth_simulateV1 request (buildSimulationRequest for that chain) run against a public node. Nothing here touches Sato
// Hub (its build-tx writes a public record) and nothing is signed or sent. Run by hand:
//   node test/fixtures/swap-evm/record-chain.mjs <bnb|arbitrum|polygon> [case ...]    (no case: every case of the chain)
// Files go to test/fixtures/swap-evm/<chain>/<case>-{route,build,sim}.json (+ -sellback-* for a buy of a long-tail token).
//
// The sender is a public address used only as `sender`/taker (never a key). It holds nothing on these chains, so the simulation gives it
// the input token with a state override INSIDE the simulation only (the native coin by balance, a token by its balance slot).
// The long-tail tokens are ordinary liquid tokens of each chain: CAKE (BNB Chain), ARB (Arbitrum), AAVE (Polygon).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, pad, toHex } from "viem";
import { buildSimulationRequest, SATO_FEE_RECIPIENT, sellBackCalls, swapCalls } from "../../../src/swap/evm.js";
import { evmChain, kyberApiBase, majorTokens, rpcUrls } from "../../../src/chains.js";

const chainKey = process.argv[2];
const wanted = process.argv.slice(3);
if (!chainKey || !["bnb", "arbitrum", "polygon", "base"].includes(chainKey)) throw new Error("usage: record-chain.mjs <bnb|arbitrum|polygon> [case ...]");
const chain = evmChain(chainKey);
const TOK = majorTokens(chainKey);
const dir = fileURLToPath(new URL(`./${chainKey}/`, import.meta.url));
fs.mkdirSync(dir, { recursive: true });

const SENDER = "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A";
const UA = "SatoHub-swap-dev/1.0";
const HOST = kyberApiBase(chainKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URLS = rpcUrls(chainKey);
let at = 0;

/** A JSON-RPC call that moves to the next endpoint, and waits, when one is rate-limited or down. */
async function rpc(method, params) {
  let last;
  for (let i = 0; i < 12; i++) {
    const url = URLS[(at + i) % URLS.length];
    try {
      const res = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) })).json();
      if (res.error || res.result === undefined) throw new Error(`${method}: ${JSON.stringify(res).slice(0, 200)}`);
      at = (at + i) % URLS.length;
      return res.result;
    } catch (err) {
      last = err;
      await sleep(i < URLS.length ? 300 : 1500);
    }
  }
  throw last;
}
const headers = { "user-agent": UA, "x-client-id": "satohub", accept: "application/json" };
/** A request to KyberSwap's API that tries again, a few times, when the network drops it (this Mac's path to some hosts is flaky). */
async function kyber(url, init) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      return await (await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })).json();
    } catch (err) {
      last = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}
const get = (path, q) => kyber(`${HOST}${path}?${new URLSearchParams(q)}`, { headers });
const post = (path, body) => kyber(`${HOST}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

const LONG_TAIL = {
  bnb: { symbol: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18, native: false },
  arbitrum: { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, native: false },
  polygon: { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, native: false },
}[chainKey];
const stable = TOK[chain.defaultStable];
const other = Object.values(TOK).find((t) => !t.native && t.address !== stable.address && chain.stables[t.symbol]); // the second stablecoin
const native = TOK[chain.native.symbol];
const u = (n, d) => BigInt(Math.round(n * 1e6)) * 10n ** BigInt(d - 6);

const tail = LONG_TAIL;
const cases = [
  // major <-> stable, the fee on the input (15 bps)
  { name: "native-to-stable", from: native, to: stable, units: u(chainKey === "bnb" ? 0.02 : chainKey === "polygon" ? 20 : 0.005, 18), bps: 15 },
  { name: "stable-to-native", from: stable, to: native, units: u(10, stable.decimals), bps: 15 },
  // stable <-> stable (3 bps). The input is the default stable except on BNB, where the bridge-peg USDC is the output.
  { name: "stable-to-stable", from: stable, to: other, units: u(10, stable.decimals), bps: 3 },
  // a long-tail token: buying (fee on the input, then its sell-back) and selling (fee on the output)
  { name: "stable-to-tail", from: stable, to: tail, units: u(10, stable.decimals), bps: 75, sellBack: true },
  { name: "tail-to-stable", from: tail, to: stable, units: u(10, 18), bps: 75, feeBy: "currency_out" },
];

const write = (name, obj) => fs.writeFileSync(`${dir}${name}.json`, JSON.stringify(obj, null, 1) + "\n");

/** A state override that gives `owner` `amount` of `token`: found by trying the standard mapping slots with eth_call. */
async function balanceOverride(token, owner, amount) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  for (let slot = 0; slot < 60; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slot)]));
    const override = { [token]: { stateDiff: { [key]: pad(toHex(amount)) } } };
    try {
      // Probed with eth_simulateV1, the method the kit itself needs (some endpoints that simulate refuse eth_call: ZAN on Polygon).
      const res = await rpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: override, calls: [{ to: token, data }] }], validation: false }, "latest"]);
      if (BigInt(res[0].calls[0].returnData) === amount) return override;
    } catch {
      /* try the next slot */
    }
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

/** The kit's own request for these calls (its fees, its block settings for this chain), with the sender funded inside the simulation. */
async function simulate(calls, funded) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFeePerGas = BigInt(block.baseFeePerGas ?? 0);
  const legacyGasPrice = baseFeePerGas === 0n ? BigInt(await rpc("eth_gasPrice", [])) : undefined;
  const params = buildSimulationRequest({
    taker: SENDER,
    calls,
    baseFeePerGas,
    maxPriorityFeePerGas: chain.simulation.tipFallbackWei,
    ...(legacyGasPrice ? { legacyGasPrice } : {}),
    chain: chainKey,
    ...(chain.simulation.timedBlocks ? { blockNumber: BigInt(block.number), timestamp: BigInt(block.timestamp) } : {}),
    splitAt: calls.splitAt,
  });
  params[0].blockStateCalls[0].stateOverrides = { ...(funded ?? {}), [SENDER]: { balance: toHex(10n ** 22n) } };
  const result = await rpc("eth_simulateV1", params);
  return { result: [{ number: result[0].number, calls: result[0].calls }, ...(result[1] ? [{ number: result[1].number, calls: result[1].calls }] : [])], request_blocks: params[0].blockStateCalls.length };
}

const received = (sim, token) => {
  let net = 0n;
  const me = SENDER.toLowerCase().replace("0x", "").padStart(64, "0");
  for (const call of sim.result.flatMap((b) => b.calls)) {
    for (const l of call.logs ?? []) {
      if (l.address.toLowerCase() !== token.address.toLowerCase() || l.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
      if (l.topics[2].toLowerCase().endsWith(me)) net += BigInt(l.data);
      if (l.topics[1].toLowerCase().endsWith(me)) net -= BigInt(l.data);
    }
  }
  return net;
};

for (const k of cases) {
  if (wanted.length && !wanted.includes(k.name)) continue;
  const tin = k.from;
  const tout = k.to;
  const feeBy = k.feeBy ?? "currency_in";
  const route = await get("/routes", { tokenIn: tin.address, tokenOut: tout.address, amountIn: k.units.toString(), feeAmount: String(k.bps), chargeFeeBy: feeBy, isInBps: "true", feeReceiver: SATO_FEE_RECIPIENT });
  if (route.code !== 0) throw new Error(`${k.name} route: ${JSON.stringify(route).slice(0, 300)}`);
  await sleep(2000);
  const build = await post("/route/build", { routeSummary: route.data.routeSummary, sender: SENDER, recipient: SENDER, slippageTolerance: 50, source: "satohub" });
  if (build.code !== 0) throw new Error(`${k.name} build: ${JSON.stringify(build).slice(0, 300)}`);
  write(`${k.name}-route`, route);
  write(`${k.name}-build`, build);
  const b = build.data;
  const funded = tin.native ? undefined : await balanceOverride(tin.address, SENDER, k.units * 3n);
  // The calls are the KIT's own (swapCalls / sellBackCalls in src/swap/evm.js), gas limits included: what is recorded is what the kit
  // would send to eth_simulateV1, so a route that needs more gas than the chain's cap (`simulation.swapGas`) shows up here.
  const calls = swapCalls({ intent: { chain: chainKey, tokenIn: tin, amountIn: k.units }, facts: { value: BigInt(b.transactionValue) }, tx: { to: b.routerAddress, data: b.data }, approvalNeeded: !tin.native });
  const sim = await simulate(calls, funded);
  write(`${k.name}-sim`, sim);
  console.log(chainKey, k.name, "recorded", sim.result.flatMap((x) => x.calls).map((c) => c.status).join(","), "blocks", sim.request_blocks);

  if (k.sellBack) {
    // sell back exactly what the buy delivered, from the token to the input, with no Sato fee; the buy in one block, the sell in the next
    const got = received(sim, tout);
    await sleep(2000);
    const sRoute = await get("/routes", { tokenIn: tout.address, tokenOut: tin.address, amountIn: got.toString() });
    if (sRoute.code !== 0) throw new Error(`${k.name} sell-back route: ${JSON.stringify(sRoute).slice(0, 300)}`);
    await sleep(2000);
    const sBuild = await post("/route/build", { routeSummary: sRoute.data.routeSummary, sender: SENDER, recipient: SENDER, slippageTolerance: 1000, source: "satohub" });
    if (sBuild.code !== 0) throw new Error(`${k.name} sell-back build: ${JSON.stringify(sBuild).slice(0, 300)}`);
    write(`${k.name}-sellback-route`, sRoute);
    write(`${k.name}-sellback-build`, sBuild);
    const all = [...calls, ...sellBackCalls({ chain: chainKey, token: tout, units: got, data: sBuild.data.data })];
    all.splitAt = calls.length;
    const full = await simulate(all, funded);
    write(`${k.name}-sellback-sim`, full);
    console.log(chainKey, k.name, "sell-back recorded", full.result.flatMap((x) => x.calls).map((c) => `${c.status}/${c.gasUsed}`).join(","), "bought", got.toString(), "blocks", full.request_blocks);
  }
  await sleep(2000);
}
