// Preloaded (node --import) into a spawned CLI so a test can run the real purchase
// commands end to end with no network. Any URL not answered here throws.
//
//   SATO_TEST_BITREFILL  JSON: shapes the offline Bitrefill (test/bitrefill-world.js)
//   SATO_TEST_HUB        JSON: { order: { status, json }, jwks, simLogs }
//                          order   Sato Hub's answer to POST /api/commerce/order
//                          jwks    served at https://satohub.ai/.well-known/jwks.json
//                          simLogs the logs eth_simulateV1 returns for the payment, on the Base RPC
//                                  at SATO_AGENT_BASE_RPC (https://base-rpc.test)

import { bitrefillWorld } from "./bitrefill-world.js";

const world = bitrefillWorld(JSON.parse(process.env.SATO_TEST_BITREFILL || "{}"));
const hub = JSON.parse(process.env.SATO_TEST_HUB || "{}");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function rpc(body) {
  const { id, method } = JSON.parse(body);
  const result = {
    eth_getBlockByNumber: { number: "0x100", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6700000", baseFeePerGas: "0x3b9aca00", mixHash: `0x${"33".repeat(32)}`, gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] },
    eth_maxPriorityFeePerGas: "0xf4240",
    eth_simulateV1: [{ calls: [{ status: "0x1", logs: hub.simLogs ?? [], returnData: "0x", gasUsed: "0x5208" }] }],
    eth_chainId: "0x2105",
  }[method];
  if (result === undefined) return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `offline test RPC: ${method} not stubbed` } });
  return json({ jsonrpc: "2.0", id, result });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://api.bitrefill.com") return world.fetch(input, init);
  if (url.pathname.startsWith("/api/commerce/order") && hub.order) return json(hub.order.json, hub.order.status ?? 200);
  if (url.href === "https://satohub.ai/.well-known/jwks.json" && hub.jwks) return json(hub.jwks);
  if (url.host === "base-rpc.test") return rpc(input instanceof Request ? await input.text() : init.body);
  throw new Error(`offline test: no network to ${url.origin}`);
};
