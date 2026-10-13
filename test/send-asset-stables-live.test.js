// Re-reads every extra stablecoin the registry pins (src/chains.js `otherStables`) from the chain: a contract at that address, the symbol the
// issuer uses, the decimals the registry says. Opt-in (it reads live public RPCs):
//   SATO_AGENT_LIVE_READ=1 node --test test/send-asset-stables-live.test.js
// A chain none of whose endpoints answers is reported and skipped, not failed (Polygon's public endpoints did not answer from the research Mac).

import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, erc20Abi } from "viem";
import { address } from "@solana/kit";
import { freshHome } from "./helpers.js";

const enabled = process.env.SATO_AGENT_LIVE_READ === "1";
freshHome();
const { evmChain, evmChainKeys, otherStablesOf, rpcUrls } = await import("../src/chains.js");
const { chainTransport } = await import("../src/rpc.js");
const { parseMintAccount } = await import("../src/swap/solana.js");
const { rpc } = await import("../src/solana.js");

// The chain's own symbol for a bridged token: Arbitrum's and Polygon's USDC.e call themselves "USDC".
const ONCHAIN_SYMBOL = { "USDC.e": "USDC" };

for (const key of evmChainKeys()) {
  const c = evmChain(key);
  for (const entry of otherStablesOf(key)) {
    test(`live read ${key} ${entry.symbol} ${entry.address}`, { skip: !enabled, timeout: 60_000 }, async (t) => {
      const pub = createPublicClient({ chain: c.viem, transport: chainTransport(key) });
      let read;
      try {
        read = await Promise.all(["symbol", "decimals"].map((functionName) => pub.readContract({ address: entry.address, abi: erc20Abi, functionName })));
      } catch (err) {
        if (/none of this chain|fetch failed|HTTP request failed|RPC Request failed|timed out|rate/i.test(`${err.message} ${err.shortMessage}`)) return t.skip(`${c.label}: no endpoint answered (${rpcUrls(key, {}).length} tried)`);
        throw err;
      }
      assert.deepEqual(read, [ONCHAIN_SYMBOL[entry.symbol] ?? entry.symbol, entry.decimals]);
    });
  }
}

for (const entry of otherStablesOf("solana")) {
  test(`live read solana ${entry.symbol} ${entry.mint}`, { skip: !enabled, timeout: 60_000 }, async () => {
    const { value } = await rpc().getAccountInfo(address(entry.mint), { encoding: "base64" }).send();
    const info = parseMintAccount(value, entry.mint);
    assert.deepEqual([info.program, info.decimals], [entry.program, entry.decimals]);
  });
}
