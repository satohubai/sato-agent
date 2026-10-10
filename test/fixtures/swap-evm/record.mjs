// Re-records the fixtures in this folder from the real KyberSwap API and read-only
// eth_simulateV1 calls. Nothing here touches Sato Hub (its build-tx writes a public
// record) and nothing is signed or sent. Run by hand:
//   node test/fixtures/swap-evm/record.mjs [case ...]      (no argument: every case)
// The sender is a public, funded Base address used only as `sender` (never a key).
//
// The long-tail cases (DEGEN) need the sender to hold DEGEN for a SALE to simulate: the balance is
// given to the sender with a state override inside the simulation only, never onchain.
//
// A BUY case also records its sell-back: a second route + build, from the token back to the major for
// exactly the amount the buy delivered, with NO Sato fee (it is simulated, never sent), and the one
// simulation that runs [approve?, buy, approve(token), sell].

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, pad, toHex } from "viem";
import { buildSimulationRequest, KYBER_ROUTER_BASE, SATO_FEE_RECIPIENT, TOKENS } from "../../../src/swap/evm.js";

const dir = fileURLToPath(new URL("./", import.meta.url));
const SENDER = "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A";
const UA = "SatoHub-swap-dev/1.0";
const HOST = "https://aggregator-api.kyberswap.com/base/api/v1";
const RPC = process.env.SATO_AGENT_BASE_RPC || "https://mainnet.base.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  const res = await (
    await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) })
  ).json();
  if (res.error || res.result === undefined) throw new Error(`${method}: ${JSON.stringify(res).slice(0, 300)}`);
  return res.result;
};
const headers = { "user-agent": UA, "x-client-id": "satohub", accept: "application/json" };
const get = async (path, q) => (await fetch(`${HOST}${path}?${new URLSearchParams(q)}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
const post = async (path, body) => (await fetch(`${HOST}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })).json();

const DEGEN = { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18, native: false };
const deg = (n) => BigInt(n) * 10n ** 18n;

const cases = [
  // the three original major-to-major cases (do not re-record them casually: the offline tests were written against them)
  { name: "usdc-to-eth", from: TOKENS.USDC, to: TOKENS.ETH, units: 100_000_000n },
  { name: "eth-to-usdc", from: TOKENS.ETH, to: TOKENS.USDC, units: 10_000_000_000_000_000n },
  { name: "usdc-to-weth", from: TOKENS.USDC, to: TOKENS.WETH, units: 100_000_000n },
  // buying a long-tail token: the fee is on the input (the major); then its sell-back
  { name: "usdc-to-degen", from: TOKENS.USDC, to: DEGEN, units: 20_000_000n, sellBack: true },
  { name: "eth-to-degen", from: TOKENS.ETH, to: DEGEN, units: 10_000_000_000_000_000n, sellBack: true },
  // selling a long-tail token: the fee is on the output (the major)
  { name: "degen-to-usdc", from: DEGEN, to: TOKENS.USDC, units: deg(5000), feeBy: "currency_out" },
  { name: "degen-to-eth", from: DEGEN, to: TOKENS.ETH, units: deg(5000), feeBy: "currency_out" },
  // what a wrong-side build looks like: a SALE of the long-tail token with the fee on the input (so in the long-tail token). Route + build only.
  { name: "degen-to-usdc-feein", from: DEGEN, to: TOKENS.USDC, units: deg(5000), feeBy: "currency_in", buildOnly: true },
];

const write = (name, obj) => fs.writeFileSync(`${dir}${name}.json`, JSON.stringify(obj, null, 1) + "\n");

/** The storage key of balanceOf(owner) for a standard `mapping(address => uint256)` at `slot`, found by trying slots with a state override. */
async function balanceOverride(token, owner, amount) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  for (let slot = 0; slot < 20; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slot)]));
    const override = { [token]: { stateDiff: { [key]: pad(toHex(amount)) } } };
    try {
      if (BigInt(await rpc("eth_call", [{ to: token, data }, "latest", override])) === amount) return override;
    } catch {
      /* try the next slot */
    }
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

/** A simulation request with the sender's token balance overridden (for a sale of a token the sender does not hold). */
async function simulate(calls, override) {
  const baseFeePerGas = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
  const params = buildSimulationRequest({ taker: SENDER, calls, baseFeePerGas, maxPriorityFeePerGas: 1_000_000n });
  if (override) params[0].blockStateCalls[0].stateOverrides = override;
  const result = await rpc("eth_simulateV1", params);
  // Keep the simulated calls and the block number; the rest of the block header is not read.
  return { result: [{ number: result[0].number, calls: result[0].calls }] };
}

const received = (sim, token) => {
  let net = 0n;
  const me = SENDER.toLowerCase().replace("0x", "").padStart(64, "0");
  for (const call of sim.result[0].calls) {
    for (const l of call.logs) {
      if (l.address.toLowerCase() !== token.address.toLowerCase() || l.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
      if (l.topics[2].toLowerCase().endsWith(me)) net += BigInt(l.data);
      if (l.topics[1].toLowerCase().endsWith(me)) net -= BigInt(l.data);
    }
  }
  return net;
};

const wanted = process.argv.slice(2);
for (const k of cases) {
  if (wanted.length && !wanted.includes(k.name)) continue;
  const tin = k.from, tout = k.to;
  const feeBy = k.feeBy ?? "currency_in";
  const route = await get("/routes", { tokenIn: tin.address, tokenOut: tout.address, amountIn: k.units.toString(), feeAmount: "15", chargeFeeBy: feeBy, isInBps: "true", feeReceiver: SATO_FEE_RECIPIENT });
  if (route.code !== 0) throw new Error(`${k.name} route: ${JSON.stringify(route).slice(0, 300)}`);
  await sleep(2000);
  const build = await post("/route/build", { routeSummary: route.data.routeSummary, sender: SENDER, recipient: SENDER, slippageTolerance: 50, source: "satohub" });
  if (build.code !== 0) throw new Error(`${k.name} build: ${JSON.stringify(build).slice(0, 300)}`);
  write(`${k.name}-route`, route);
  write(`${k.name}-build`, build);
  if (k.buildOnly) {
    console.log(k.name, "recorded (route + build only)");
    await sleep(2000);
    continue;
  }
  const b = build.data;
  const longTailIn = tin.address === DEGEN.address;
  const override = longTailIn ? await balanceOverride(tin.address, SENDER, k.units) : undefined;
  const swapCall = { to: b.routerAddress, data: b.data, value: BigInt(b.transactionValue) };
  const approve = (token, amount) => ({ to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, amount] }) });
  const calls = [];
  if (!tin.native) calls.push(approve(tin, k.units));
  calls.push(swapCall);
  const sim = await simulate(calls, override);
  write(`${k.name}-sim`, sim);
  console.log(k.name, "recorded", sim.result[0].calls.map((c) => c.status).join(","));

  if (k.sellBack) {
    // sell back exactly what the buy delivered, from the token to the major, with no Sato fee
    const got = received(sim, tout);
    await sleep(2000);
    const sRoute = await get("/routes", { tokenIn: tout.address, tokenOut: tin.address, amountIn: got.toString() });
    if (sRoute.code !== 0) throw new Error(`${k.name} sell-back route: ${JSON.stringify(sRoute).slice(0, 300)}`);
    await sleep(2000);
    const sBuild = await post("/route/build", { routeSummary: sRoute.data.routeSummary, sender: SENDER, recipient: SENDER, slippageTolerance: 1000, source: "satohub" });
    if (sBuild.code !== 0) throw new Error(`${k.name} sell-back build: ${JSON.stringify(sBuild).slice(0, 300)}`);
    write(`${k.name}-sellback-route`, sRoute);
    write(`${k.name}-sellback-build`, sBuild);
    const sell = { to: sBuild.data.routerAddress, data: sBuild.data.data, value: 0n };
    const full = await simulate([...calls, approve(tout, got), sell]);
    write(`${k.name}-sellback-sim`, full);
    console.log(k.name, "sell-back recorded", full.result[0].calls.map((c) => `${c.status}/${c.gasUsed}`).join(","), "bought", got.toString());
  }
  await sleep(2000);
}
