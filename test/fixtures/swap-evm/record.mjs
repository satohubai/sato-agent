// Re-records the fixtures in this folder from the real KyberSwap API and one
// read-only eth_simulateV1 call. Nothing here touches Sato Hub (its build-tx
// writes a public record) and nothing is signed or sent. Run by hand:
//   node test/fixtures/swap-evm/record.mjs
// The sender is a public, funded Base address used only as `sender` (never a key).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi } from "viem";
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

const cases = [
  { name: "usdc-to-eth", from: "USDC", to: "ETH", units: 100_000_000n },
  { name: "eth-to-usdc", from: "ETH", to: "USDC", units: 10_000_000_000_000_000n },
  { name: "usdc-to-weth", from: "USDC", to: "WETH", units: 100_000_000n },
];

for (const k of cases) {
  const tin = TOKENS[k.from], tout = TOKENS[k.to];
  const q = new URLSearchParams({ tokenIn: tin.address, tokenOut: tout.address, amountIn: k.units.toString(), feeAmount: "15", chargeFeeBy: "currency_in", isInBps: "true", feeReceiver: SATO_FEE_RECIPIENT });
  const headers = { "user-agent": UA, "x-client-id": "satohub", accept: "application/json" };
  const route = await (await fetch(`${HOST}/routes?${q}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
  await sleep(2000);
  const build = await (
    await fetch(`${HOST}/route/build`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: SENDER, recipient: SENDER, slippageTolerance: 50, source: "satohub" }),
      signal: AbortSignal.timeout(30_000),
    })
  ).json();
  const b = build.data;
  const calls = [];
  if (!tin.native) calls.push({ to: tin.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER_BASE, k.units] }) });
  calls.push({ to: b.routerAddress, data: b.data, value: BigInt(b.transactionValue) });
  // the simulation carries the latest block's base fee, as the kit's own does
  const baseFeePerGas = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
  const sim = { result: await rpc("eth_simulateV1", buildSimulationRequest({ taker: SENDER, calls, baseFeePerGas, maxPriorityFeePerGas: 1_000_000n })) };
  // Keep the simulated calls and the block number; the rest of the block header is not read.
  const trimmed = { result: [{ number: sim.result[0].number, calls: sim.result[0].calls }] };
  fs.writeFileSync(`${dir}${k.name}-route.json`, JSON.stringify(route, null, 1) + "\n");
  fs.writeFileSync(`${dir}${k.name}-build.json`, JSON.stringify(build, null, 1) + "\n");
  fs.writeFileSync(`${dir}${k.name}-sim.json`, JSON.stringify(trimmed, null, 1) + "\n");
  console.log(k.name, "recorded", sim.result[0].calls.map((c) => c.status).join(","));
  await sleep(2000);
}
