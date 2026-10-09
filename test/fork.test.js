// Against a local anvil fork of Base mainnet: the real USDC and ERC-8004
// contracts, test balances, nothing reaches the real chain. Opt-in:
//   SATO_AGENT_FORK=1 node --test test/fork.test.js
// Needs `anvil` (Foundry) on PATH. FORK_RPC overrides the upstream RPC.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { createPublicClient, erc20Abi, http, keccak256, encodeAbiParameters, pad, toHex } from "viem";
import { base } from "viem/chains";
import { freshHome } from "./helpers.js";

const enabled = process.env.SATO_AGENT_FORK === "1";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

freshHome();
process.env.SATO_AGENT_BASE_RPC = RPC;
const { initWallet } = await import("../src/wallet.js");
const { setPolicy, Refused } = await import("../src/policy.js");
const { USDC_BASE, IDENTITY_REGISTRY, sendUsdc, registerAgent, registrationUri } = await import("../src/base.js");

let anvil;
let me;
const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 30_000 }) });
const rpc = (method, params) => pub.request({ method, params });

async function giveUsdc(addr, units) {
  // FiatToken keeps balances in a mapping; find its slot by writing and reading back.
  for (let slot = 0; slot < 20; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
    await rpc("anvil_setStorageAt", [USDC_BASE, key, pad(toHex(units))]);
    const bal = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
    if (bal === units) return slot;
    await rpc("anvil_setStorageAt", [USDC_BASE, key, pad("0x0")]);
  }
  throw new Error("could not find the USDC balance slot");
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
  await rpc("anvil_setBalance", [me, toHex(10n ** 17n)]);
  await giveUsdc(me, 50_000_000n); // 50 USDC
});
after(() => anvil?.kill());

test("sends USDC on a Base fork, inside the owner's limits", { skip: !enabled }, async () => {
  const to = "0x000000000000000000000000000000000000dEaD";
  await assert.rejects(sendUsdc({ to, amount: "1" }), (e) => e instanceof Refused);
  setPolicy({ perTx: "20", perDay: "30" });
  const before = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  const r = await sendUsdc({ to, amount: "12.5" });
  const after = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  assert.equal(after - before, 12_500_000n);
  assert.match(r.tx, /^0x[0-9a-f]{64}$/);
  // 12.5 spent; another 20 would pass the per-tx limit but break the daily one.
  await assert.rejects(sendUsdc({ to, amount: "20" }), (e) => e instanceof Refused && e.refusals[0].rule === "max_usd_per_day");
});

test("registers as an ERC-8004 agent on the real registry contract, with a full onchain registration file", { skip: !enabled }, async () => {
  const r = await registerAgent({ name: "Sato Agent fork test", description: "Grok Bot onchain agent (fork test)" });
  assert.ok(Number(r.agent_id) > 0);
  assert.equal(r.uri_set, true);
  const uri = await pub.readContract({
    address: IDENTITY_REGISTRY,
    abi: [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] }],
    functionName: "tokenURI",
    args: [BigInt(r.agent_id)],
  });
  assert.equal(uri, registrationUri({ agentId: r.agent_id, name: "Sato Agent fork test", description: "Grok Bot onchain agent (fork test)" }));
  const card = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
  assert.equal(card.registrations[0].agentId, Number(r.agent_id));
  assert.equal(card.registrations[0].agentRegistry, `eip155:8453:${IDENTITY_REGISTRY}`);
  const owner = await pub.readContract({
    address: IDENTITY_REGISTRY,
    abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
    functionName: "ownerOf",
    args: [BigInt(r.agent_id)],
  });
  assert.equal(owner, me);
});
