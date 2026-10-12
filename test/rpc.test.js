// The RPC transport (src/rpc.js): a chain's endpoints in order, moving on when one turns a call away, and never moving a SEND on when
// the first endpoint might have taken it. Local HTTP servers stand in for the public nodes.

import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { isRetryable, rotatingTransport, chainTransport } = await import("../src/rpc.js");
const { rpcUrls } = await import("../src/chains.js");
const { createPublicClient } = await import("viem");
const { bsc } = await import("viem/chains");

const servers = [];
/** A JSON-RPC server whose answer to each method is `handle(method, params, n)` -> { status?, body?, hang?, destroy? }. */
async function node(handle) {
  const calls = [];
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      calls.push(j.method);
      const out = handle(j.method, j.params, calls.length) ?? {};
      if (out.destroy) return req.socket.destroy();
      if (out.hang) return; // never answers
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? { jsonrpc: "2.0", id: j.id, result: out.result ?? "0x1" }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${s.address().port}`, calls };
}
after(() => servers.forEach((s) => s.closeAllConnections?.() ?? s.close()));

/** A URL nothing listens on: the port of a server that was just closed. */
async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const client = (urls, timeout = 2000) => createPublicClient({ chain: bsc, transport: rotatingTransport(urls, { timeout }) });
const rateLimited = { status: 429, body: { jsonrpc: "2.0", error: { code: -32029, message: "Too Many Requests, Please apply an API key" } } };

test("a read that is rate limited moves to the next endpoint, which keeps getting the next calls", async () => {
  const a = await node(() => rateLimited);
  const b = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : "0x10" }));
  const c = client([a.url, b.url]);
  assert.equal(await c.getChainId(), 56);
  assert.equal(Number(await c.getBlockNumber()), 16);
  assert.deepEqual(a.calls, ["eth_chainId"], "the first endpoint was tried once and then left alone");
  assert.deepEqual(b.calls, ["eth_chainId", "eth_blockNumber"]);
});

test("a rate limit that comes as a JSON-RPC error on a 200, a 5xx, a timeout and a dropped connection all move on", async () => {
  const limited200 = await node(() => ({ body: { jsonrpc: "2.0", error: { code: -32005, message: "Public endpoint rate limit" } } }));
  const down = await node(() => ({ status: 503, body: { error: "unavailable" } }));
  const slow = await node(() => ({ hang: true }));
  const dropped = await node(() => ({ destroy: true }));
  const good = await node(() => ({ result: "0x38" }));
  for (const bad of [limited200, down, slow, dropped]) assert.equal(await client([bad.url, good.url], 400).getChainId(), 56, bad.url);
  // and an endpoint nothing listens on
  assert.equal(await client([await deadUrl(), good.url], 400).getChainId(), 56);
});

test("a node's real answer is never retried: a revert, an invalid call", async () => {
  const a = await node(() => ({ body: { jsonrpc: "2.0", error: { code: 3, message: "execution reverted: nope", data: "0x" } } }));
  const b = await node(() => ({ result: "0x1" }));
  await assert.rejects(client([a.url, b.url]).call({ to: "0x000000000000000000000000000000000000dEaD", data: "0x" }), /revert/i);
  assert.deepEqual(b.calls, [], "the second endpoint was not asked");
});

test("a node that does not serve the method (eth_simulateV1) is skipped for a read", async () => {
  const a = await node((m) => (m === "eth_simulateV1" ? { body: { jsonrpc: "2.0", error: { code: -32601, message: "the method eth_simulateV1 does not exist/is not available" } } } : {}));
  const b = await node(() => ({ result: [{ calls: [] }] }));
  const c = client([a.url, b.url]);
  assert.deepEqual(await c.request({ method: "eth_simulateV1", params: [{}, "latest"] }), [{ calls: [] }]);
});

test("a SEND moves on only when the first endpoint did not act on it: a rate limit or no connection, never a timeout or a 5xx", async () => {
  const raw = "0x02f86c";
  const good = async () => node(() => ({ result: `0x${"ab".repeat(32)}` }));
  // rate limited: nothing was accepted, so it goes on
  const g1 = await good();
  const limited = await node(() => rateLimited);
  assert.equal(await client([limited.url, g1.url]).sendRawTransaction({ serializedTransaction: raw }), `0x${"ab".repeat(32)}`);
  assert.deepEqual(g1.calls, ["eth_sendRawTransaction"]);
  // no connection at all: nothing was sent
  const g2 = await good();
  assert.equal(await client([await deadUrl(), g2.url], 400).sendRawTransaction({ serializedTransaction: raw }), `0x${"ab".repeat(32)}`);
  // a 5xx, a timeout or a dropped connection AFTER the request left: the node may have taken it. Thrown as it is, not sent on elsewhere.
  for (const bad of [await node(() => ({ status: 502 })), await node(() => ({ hang: true })), await node(() => ({ destroy: true }))]) {
    const g = await good();
    await assert.rejects(client([bad.url, g.url], 400).sendRawTransaction({ serializedTransaction: raw }), undefined, bad.url);
    assert.deepEqual(g.calls, [], "the transaction was not sent to a second node");
  }
});

test("isRetryable: the classification itself", () => {
  const http = (status, details) => Object.assign(new Error(details ?? "x"), { name: "HttpRequestError", status, details });
  const rpc = (code, message) => Object.assign(new Error(message), { name: "RpcRequestError", code, details: message });
  assert.equal(isRetryable(http(429), "eth_call"), true);
  assert.equal(isRetryable(http(429), "eth_sendRawTransaction"), true);
  assert.equal(isRetryable(http(503), "eth_call"), true);
  assert.equal(isRetryable(http(503), "eth_sendRawTransaction"), false);
  assert.equal(isRetryable(rpc(-32005, "limit exceeded"), "eth_sendRawTransaction"), true);
  assert.equal(isRetryable(rpc(-32000, "cu limit exceeded for unregistered users"), "eth_call"), true, "ZAN's wording");
  assert.equal(isRetryable(rpc(-32000, "Public endpoint rate limit"), "eth_getBalance"), true, "BNB dataseed's wording");
  assert.equal(isRetryable(rpc(-32000, "nonce too low"), "eth_sendRawTransaction"), false, "a refusal is an answer");
  assert.equal(isRetryable(rpc(-32000, "insufficient funds for gas * price + value"), "eth_sendRawTransaction"), false);
  assert.equal(isRetryable(rpc(3, "execution reverted"), "eth_call"), false);
  assert.equal(isRetryable(Object.assign(new Error("timed out"), { name: "TimeoutError" }), "eth_call"), true);
  assert.equal(isRetryable(Object.assign(new Error("timed out"), { name: "TimeoutError" }), "eth_sendRawTransaction"), false);
  const tls = Object.assign(new Error("fetch failed"), { name: "HttpRequestError", cause: Object.assign(new Error("x"), { cause: Object.assign(new Error("ssl"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }) }) });
  assert.equal(isRetryable(tls, "eth_call"), true);
  assert.equal(isRetryable(tls, "eth_sendRawTransaction"), true, "a failed TLS handshake sent nothing");
});

test("the transport for a chain is its owner's endpoints, else the registry's list in order", () => {
  assert.ok(chainTransport("bnb"));
  assert.deepEqual(rpcUrls("bnb", {}), ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io", "https://bsc.drpc.org"]);
  assert.deepEqual(rpcUrls("arbitrum", {}).slice(0, 3), ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"]);
  assert.ok(rpcUrls("polygon", {}).includes("https://polygon.api.onfinality.io/public"));
  assert.deepEqual(rpcUrls("bnb", { SATO_AGENT_BNB_RPC: "http://a, http://b ,," }), ["http://a", "http://b"]);
  assert.deepEqual(rpcUrls("polygon", { SATO_AGENT_POLYGON_RPC: "https://mine" }), ["https://mine"]);
  assert.deepEqual(rpcUrls("arbitrum", { SATO_AGENT_ARBITRUM_RPC: "" }).length, 3);
  assert.throws(() => rotatingTransport([]), /at least one url/);
});
