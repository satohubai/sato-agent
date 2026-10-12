// The RPC transport (src/rpc.js): a chain's endpoints in order, moving on when one turns a call away, and never moving a SEND on when
// the first endpoint might have taken it. Local HTTP servers stand in for the public nodes.

import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { isRetryable, rotatingTransport, chainTransport, sendAttempts } = await import("../src/rpc.js");
const { rpcUrls } = await import("../src/chains.js");
const { createPublicClient } = await import("viem");
const { bsc } = await import("viem/chains");

const servers = [];
/** A JSON-RPC server whose answer to each method is `handle(method, params, n)` -> { status?, body?, hang?, destroy? }. */
async function node(handle, { chain = "auto" } = {}) {
  const calls = [];
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      calls.push(j.method);
      // Every endpoint is asked eth_chainId once before its first real call (src/rpc.js); it answers as BNB Chain unless a test says
      // { chain: "handler" }, when the handler decides (a wrong chain, a flaky check).
      const out = (chain === "auto" && j.method === "eth_chainId" ? { result: "0x38" } : handle(j.method, j.params, calls.length)) ?? {};
      if (out.destroy) return req.socket.destroy();
      if (out.hang) return; // never answers
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? { jsonrpc: "2.0", id: j.id, result: out.result ?? (j.method === "eth_chainId" ? "0x38" : "0x1") }));
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
  const a = await node(() => rateLimited, { chain: "handler" });
  const b = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : "0x10" }));
  const c = client([a.url, b.url]);
  assert.equal(await c.getChainId(), 56);
  assert.equal(Number(await c.getBlockNumber()), 16);
  assert.deepEqual(a.calls, ["eth_chainId"], "the first endpoint was tried once and then left alone");
  assert.deepEqual(b.calls, ["eth_chainId", "eth_chainId", "eth_blockNumber"], "the chain check, the caller's own eth_chainId, then the block number");
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
  assert.deepEqual(g1.calls, ["eth_chainId", "eth_sendRawTransaction"], "the chain check, then the send");
  // no connection at all: nothing was sent
  const g2 = await good();
  assert.equal(await client([await deadUrl(), g2.url], 400).sendRawTransaction({ serializedTransaction: raw }), `0x${"ab".repeat(32)}`);
  // a 5xx, a timeout or a dropped connection AFTER the request left: the node may have taken it. Thrown as it is, not sent on elsewhere.
  const sendFails = (out) => (m) => (m === "eth_chainId" ? { result: "0x38" } : out); // answers the chain check, then fails the send
  for (const bad of [await node(sendFails({ status: 502 })), await node(sendFails({ hang: true })), await node(sendFails({ destroy: true }))]) {
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

test("isRetryable for a SEND: only an HTTP 429, a -32005 / 429 code, or no connection; never by what the message says", () => {
  const http = (status, details) => Object.assign(new Error(details ?? "x"), { name: "HttpRequestError", status, details });
  const rpc = (code, message) => Object.assign(new Error(message), { name: "RpcRequestError", code, details: message });
  const SEND = "eth_sendRawTransaction";
  assert.equal(isRetryable(http(429), SEND), true);
  assert.equal(isRetryable(rpc(-32005, "anything"), SEND), true);
  assert.equal(isRetryable(rpc(429, "anything"), SEND), true);
  const refused = Object.assign(new Error("fetch failed"), { name: "HttpRequestError", cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
  assert.equal(isRetryable(refused, SEND), true);
  // wording alone is not a status: a node that took the transaction can word anything, and a send is never moved on for it
  for (const message of ["Public endpoint rate limit", "Too Many Requests", "cu limit exceeded", "request limit reached", "throttled", "capacity exceeded", "api key required", "unauthorized"]) {
    assert.equal(isRetryable(rpc(-32000, message), SEND), false, message);
    assert.equal(isRetryable(http(400, message), SEND), false, message);
    assert.equal(isRetryable(rpc(-32000, message), "eth_call"), true, `${message}: a read still moves on`);
  }
  // the same message with the status or code is a rate limit
  assert.equal(isRetryable(http(429, "Too Many Requests"), SEND), true);
  assert.equal(isRetryable(rpc(-32005, "Public endpoint rate limit"), SEND), true);
  // a refusal and every kind of "may have been taken" stay with the caller
  for (const err of [rpc(-32000, "nonce too low"), rpc(-32000, "already known"), http(502), http(500), Object.assign(new Error("timed out"), { name: "TimeoutError" }), rpc(-32000, "Temporary internal error")]) assert.equal(isRetryable(err, SEND), false, err.message);
});

test("isRetryable for a READ: an error nothing recognizes (\"Temporary internal error\") moves on; a node's definite answer does not", () => {
  const rpc = (code, message) => Object.assign(new Error(message), { name: "RpcRequestError", code, details: message });
  for (const method of ["eth_call", "eth_getBalance", "eth_estimateGas", "eth_getLogs", "eth_simulateV1", "eth_chainId"]) {
    assert.equal(isRetryable(rpc(-32000, "Temporary internal error"), method), true, method);
    assert.equal(isRetryable(rpc(-32603, "Internal error"), method), true, method);
    assert.equal(isRetryable(rpc(-32000, "request failed, please retry"), method), true, method);
  }
  assert.equal(isRetryable(rpc(3, "execution reverted: nope"), "eth_call"), false);
  assert.equal(isRetryable(rpc(-32000, "execution reverted"), "eth_estimateGas"), false);
  assert.equal(isRetryable(rpc(-32602, "invalid argument 0: hex string without 0x prefix"), "eth_call"), false);
  assert.equal(isRetryable(rpc(-32000, "insufficient funds for gas * price + value"), "eth_estimateGas"), false);
  assert.equal(isRetryable(new TypeError("x is not a function"), "eth_call"), false, "a bug in the caller is not an endpoint's failure");
  // and over the wire, a read that one node cannot serve moves to the next
});

test("a read that one endpoint answers with \"Temporary internal error\" is asked of the next; a send is not", async () => {
  const flaky = (m) => (m === "eth_chainId" ? { result: "0x38" } : { body: { jsonrpc: "2.0", error: { code: -32000, message: "Temporary internal error" } } });
  const readOk = await node((m) => (m === "eth_chainId" ? { result: "0x38" } : { result: "0x2a" }));
  assert.equal(Number(await client([(await node(flaky)).url, readOk.url]).getBlockNumber()), 42);
  const sendOk = await node(() => ({ result: `0x${"ab".repeat(32)}` }));
  await assert.rejects(client([(await node(flaky)).url, sendOk.url]).sendRawTransaction({ serializedTransaction: "0x02f86c" }), /Temporary internal error/);
  assert.deepEqual(sendOk.calls, [], "the transaction was not sent to a second node");
});

test("a SEND is not moved on for a rate-limit WORD on a 200 or a 400; it is for a 429 and for -32005", async () => {
  const raw = "0x02f86c";
  const ok = (m) => (m === "eth_chainId" ? { result: "0x38" } : { result: `0x${"ab".repeat(32)}` });
  const wordOnly = (code, status = 200) => (m) => (m === "eth_chainId" ? { result: "0x38" } : { status, body: { jsonrpc: "2.0", error: { code, message: "Public endpoint rate limit, too many requests" } } });
  const next = await node(ok);
  await assert.rejects(client([(await node(wordOnly(-32000))).url, next.url]).sendRawTransaction({ serializedTransaction: raw }), /rate limit/i);
  await assert.rejects(client([(await node(wordOnly(-32000, 400))).url, next.url]).sendRawTransaction({ serializedTransaction: raw }), undefined);
  assert.deepEqual(next.calls, [], "neither went on");
  assert.equal(await client([(await node(wordOnly(-32005))).url, next.url]).sendRawTransaction({ serializedTransaction: raw }), `0x${"ab".repeat(32)}`);
  assert.equal(await client([(await node(wordOnly(-32000, 429))).url, next.url]).sendRawTransaction({ serializedTransaction: raw }), `0x${"ab".repeat(32)}`);
});

test("a failed send says how many attempts it made (sendAttempts), through viem's own wrapping", async () => {
  const raw = "0x02f86c";
  const nonceLow = (m) => (m === "eth_chainId" ? { result: "0x38" } : { body: { jsonrpc: "2.0", error: { code: -32000, message: "nonce too low" } } });
  const limited = (m) => (m === "eth_chainId" ? { result: "0x38" } : rateLimited);
  // one endpoint answered: one touched
  const one = await client([(await node(nonceLow)).url]).sendRawTransaction({ serializedTransaction: raw }).then(() => null, (e) => e);
  assert.equal(sendAttempts(one), 1);
  // the first turned the send away with a 429, the second said "nonce too low": two touched
  const two = await client([(await node(limited)).url, (await node(nonceLow)).url]).sendRawTransaction({ serializedTransaction: raw }).then(() => null, (e) => e);
  assert.match(String(two?.message), /nonce too low/);
  assert.equal(sendAttempts(two), 2);
  // every endpoint rate limited: all of them touched
  const all = await client([(await node(limited)).url, (await node(limited)).url]).sendRawTransaction({ serializedTransaction: raw }).then(() => null, (e) => e);
  assert.equal(sendAttempts(all), 2);
  assert.equal(sendAttempts(new Error("not from the transport")), 0);
});

test("a send is attempted exactly once per endpoint: viem's own retries never re-send it (one endpoint, or two)", async () => {
  // The first answer arrives after the client's timeout, and the node DID take the transaction: a re-send would meet "nonce too low".
  const mk = async () => {
    const state = { sends: 0 };
    const server = await node((m) => {
      if (m !== "eth_sendRawTransaction") return { result: "0x1" };
      state.sends++;
      if (state.sends === 1) return { hang: true }; // taken, never answered in time
      return { body: { jsonrpc: "2.0", error: { code: -32000, message: "nonce too low" } } };
    });
    return { state, server };
  };
  for (const extra of [[], [await deadUrl()]]) {
    const n = await mk();
    const err = await client([n.server.url, ...extra], 300).sendRawTransaction({ serializedTransaction: "0x02f86c" }).then(() => null, (e) => e);
    assert.ok(err, "the timeout is thrown");
    assert.equal(n.state.sends, 1, `${extra.length + 1} endpoint(s): the node received the send exactly once`);
    assert.doesNotMatch(String(err.message), /nonce too low/);
    assert.equal(sendAttempts(err), 1);
  }
  // a READ on a single endpoint still keeps viem's retries (v0.3)
  let reads = 0;
  const flakyRead = await node((m) => (m === "eth_blockNumber" ? (++reads < 3 ? { status: 503, body: { error: "busy" } } : { result: "0x7" }) : {}));
  assert.equal(await client([flakyRead.url]).request({ method: "eth_blockNumber" }), "0x7");
});

test("signAndSend over a single endpoint whose send times out after the node took it: Pending (exit 4), one send, never Rejected", async () => {
  const { fakeChain } = await import("./swap-evm-helpers.js");
  const { Pending } = await import("../src/errors.js");
  const { signAndSend } = await import("../src/base.js");
  const state = { sends: 0 };
  const server = await node((m) => {
    if (m !== "eth_sendRawTransaction") return { result: "0x1" };
    state.sends++;
    return state.sends === 1 ? { hang: true } : { body: { jsonrpc: "2.0", error: { code: -32000, message: "nonce too low" } } };
  });
  const { c } = fakeChain({ address: "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A", chainKey: "bnb" });
  const pub = client([server.url], 300);
  c.pub.sendRawTransaction = (a) => pub.sendRawTransaction(a);
  const err = await signAndSend(c, { to: "0x000000000000000000000000000000000000dEaD", data: "0x" }, undefined, { chain: "bnb" }).then(() => null, (e) => e);
  assert.ok(err instanceof Pending, `${err?.constructor?.name}: ${err?.message}`);
  assert.equal(state.sends, 1);
});

// ------------------------------------------------------------------ the chain id check

test("an endpoint that answers eth_chainId with another chain is skipped, once, and the next one is used", async () => {
  const wrong = await node((m) => (m === "eth_chainId" ? { result: "0x1" } : { result: "0x99" }), { chain: "handler" });
  const right = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : "0x10" }), { chain: "handler" });
  const c = client([wrong.url, right.url]);
  assert.equal(await c.request({ method: "eth_blockNumber" }), "0x10");
  assert.equal(await c.request({ method: "eth_blockNumber" }), "0x10");
  assert.deepEqual(wrong.calls, ["eth_chainId"], "the wrong chain was asked once and never given a real call");
  assert.deepEqual(right.calls, ["eth_chainId", "eth_blockNumber", "eth_blockNumber"], "the right one was checked once, then used");
});

test("if no endpoint answers as this chain, the call is refused and nothing is read or sent", async () => {
  const wrongA = await node((m) => ({ result: m === "eth_chainId" ? "0x1" : "0x99" }), { chain: "handler" });
  const wrongB = await node((m) => ({ result: m === "eth_chainId" ? "0x89" : "0x99" }), { chain: "handler" });
  const c = client([wrongA.url, wrongB.url]);
  await assert.rejects(c.getBlockNumber(), /none of this chain's RPC endpoints answers as BNB Smart Chain \(56\)/);
  await assert.rejects(c.sendRawTransaction({ serializedTransaction: "0x02f86c" }), /none of this chain's RPC endpoints/);
  assert.deepEqual(wrongA.calls, ["eth_chainId"], "asked once; the answer is remembered and no real call or send was made");
  assert.deepEqual(wrongB.calls, ["eth_chainId"]);
  // a single (owner's) endpoint on the wrong network is refused the same way
  const mine = await node((m) => ({ result: m === "eth_chainId" ? "0x1" : "0x99" }), { chain: "handler" });
  await assert.rejects(client([mine.url]).getBalance({ address: "0x000000000000000000000000000000000000dEaD" }), /none of this chain's RPC endpoints/);
  assert.deepEqual(mine.calls, ["eth_chainId"]);
});

test("an endpoint whose chain check fails (down, rate limited) is moved on from and asked again later, not remembered as wrong", async () => {
  let n = 0;
  const flaky = await node((m) => (m === "eth_chainId" ? (++n === 1 ? rateLimited : { result: "0x38" }) : { result: "0x7" }), { chain: "handler" });
  const other = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : "0x8" }));
  const c = client([flaky.url, other.url]);
  assert.equal(await c.request({ method: "eth_blockNumber" }), "0x8", "the first check hit a rate limit: the second endpoint answered");
  assert.deepEqual(flaky.calls, ["eth_chainId"]);
  // a transport that starts with a good endpoint never needs the check to repeat
  const good = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : "0x9" }));
  const d = client([good.url]);
  await d.request({ method: "eth_blockNumber" });
  await d.request({ method: "eth_blockNumber" });
  assert.deepEqual(good.calls, ["eth_chainId", "eth_blockNumber", "eth_blockNumber"]);
});

test("a send is never issued to an endpoint on the wrong chain, and a wrong-chain answer is not a 'send touched' count", async () => {
  const wrong = await node((m) => ({ result: m === "eth_chainId" ? "0x1" : `0x${"cd".repeat(32)}` }), { chain: "handler" });
  const right = await node((m) => ({ result: m === "eth_chainId" ? "0x38" : `0x${"ab".repeat(32)}` }));
  assert.equal(await client([wrong.url, right.url]).sendRawTransaction({ serializedTransaction: "0x02f86c" }), `0x${"ab".repeat(32)}`);
  assert.deepEqual(wrong.calls, ["eth_chainId"], "no send reached the wrong chain");
});

test("the transport for a chain is its owner's endpoints, else the registry's list in order", () => {
  assert.ok(chainTransport("bnb"));
  assert.deepEqual(rpcUrls("bnb", {}), ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io", "https://bsc.drpc.org"]);
  assert.deepEqual(rpcUrls("arbitrum", {}).slice(0, 3), ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"]);
  assert.deepEqual(rpcUrls("polygon", {}), ["https://polygon.api.onfinality.io/public", "https://api.zan.top/polygon-mainnet", "https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com", "https://polygon.drpc.org"], "the endpoints seen to answer eth_simulateV1 come first");
  assert.deepEqual(rpcUrls("bnb", { SATO_AGENT_BNB_RPC: "http://a, http://b ,," }), ["http://a", "http://b"]);
  assert.deepEqual(rpcUrls("polygon", { SATO_AGENT_POLYGON_RPC: "https://mine" }), ["https://mine"]);
  assert.deepEqual(rpcUrls("arbitrum", { SATO_AGENT_ARBITRUM_RPC: "" }).length, 3);
  assert.throws(() => rotatingTransport([]), /at least one url/);
});
