// The RPC transport every EVM chain is read and written through: a list of endpoints, tried in order, that moves to the next one
// when the current one turns a call away. The public endpoints rate-limit (BNB's dataseed after about ten quick calls, Polygon's
// every other call) and some fail their TLS handshake from some networks, so one endpoint is not enough; an owner's own endpoint
// (SATO_AGENT_<CHAIN>_RPC, one URL or several separated by commas) replaces the list.
//
// WHEN IT MOVES ON. A call is retried on the next endpoint only when the first one provably did not (or could not) act on it:
//   reads    a rate limit, a 5xx, a timeout, a connection or TLS failure, a node that does not serve the method, and an error nothing
//            here recognizes (a node's "Temporary internal error"): a read has no side effect, so asking another node is always safe.
//            Only a node's definite answer (a revert, an invalid argument) is final;
//   sends    (eth_sendRawTransaction) ONLY an HTTP 429, a JSON-RPC rate-limit code (-32005 or 429), or a failure to connect at all.
//            Never by what the error's TEXT says: a message is not a status, and a node that took the transaction can word anything.
//            A timeout, a 5xx or a dropped connection after the request left may mean the node took the transaction; those are thrown
//            as they are, and the caller's "do not retry" handling applies.
// A node's real answer to a send (a revert, "nonce too low") is never retried: it is the answer. And because a send that has touched
// more than once (on another endpoint, or the same one) may have landed the first time, the error carries how many attempts it made
// (`sendAttempts`), and the caller reads a refusal ("nonce too low", "already known") after more than one as "may have landed"
// (Pending), never as a refusal (src/base.js). A send is also never retried by viem itself, with one endpoint or several.
//
// WHICH CHAIN. Before an endpoint is first used it is asked `eth_chainId` once, and one that answers with another chain is skipped
// (a mislabelled or hijacked URL, or an owner's SATO_AGENT_<CHAIN>_RPC pointing at the wrong network). If none answers with this
// chain's id the call is refused, whatever it was: nothing is read from, or sent to, a network that is not the one asked for.

import { createTransport, http } from "viem";
import { evmChain, rpcUrls } from "./chains.js";
import { userAgent } from "./version.js";

export const RPC_TIMEOUT_MS = 20_000;

const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);
/** Reads that only look something up: waiting for a receipt uses these. Never eth_call, eth_estimateGas or eth_simulateV1, whose
 *  "invalid params" can be the real answer to what was asked. */
const LOOKUP_METHODS = new Set([
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_chainId", "eth_getTransactionCount", "eth_getBalance", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);

const text = (err) => `${err?.name ?? ""} ${err?.shortMessage ?? ""} ${err?.details ?? ""} ${err?.message ?? ""} ${err?.cause?.shortMessage ?? ""} ${err?.cause?.details ?? ""}`;
const codeOf = (err) => err?.code ?? err?.cause?.code;
const statusOf = (err) => err?.status ?? err?.cause?.status;
/** The code Node's network stack puts on a failed connection: it may sit a few causes down. */
function netCode(err) {
  for (let e = err, i = 0; e && i < 6; e = e.cause, i++) if (typeof e.code === "string" && /^(E[A-Z]+|ERR_|UND_ERR|CERT_|DEPTH_|UNABLE_TO)/.test(e.code)) return e.code;
  return null;
}

const RATE_LIMIT = /too many requests|rate.?limit|limit exceeded|cu limit|exceeded .*(quota|capacity|limit)|throttl|capacity|apply .* api key|api key|unauthorized|over (the )?limit|request limit/i;
const NOT_SERVED = /method (does not exist|not found|not supported|is not available)|-32601|invalid method|only core evm|not available on|not enabled|unsupported method/i;
/** A node's definite answer to a read: asking another would only ask the same question again. */
const DEFINITE_ANSWER = /execution reverted|revert|invalid (argument|params|opcode|sender|input|address)|insufficient funds|out of gas|gas required exceeds|stack (overflow|underflow)|cannot unmarshal|invalid hex|header not found|missing trie node/i;
/** A connection that never reached a server: nothing was sent. */
const NEVER_CONNECTED = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SSL_|ERR_TLS|CERT_|DEPTH_ZERO|UNABLE_TO|UND_ERR_CONNECT_TIMEOUT)/;

/** Is this a limit the endpoint put on us before doing anything with the call? (By status and code, and for a READ by wording.) */
export const isRateLimited = (err) => statusOf(err) === 429 || codeOf(err) === -32005 || codeOf(err) === 429 || RATE_LIMIT.test(text(err));
/** The same, by status and code ONLY: what a send may be moved on for. */
const isRateLimitedByStatus = (err) => statusOf(err) === 429 || codeOf(err) === -32005 || codeOf(err) === 429;

/** Should `method` go to the next endpoint after `err`? (See the header for the rules.) */
export function isRetryable(err, method) {
  const net = netCode(err);
  const neverConnected = Boolean(net && NEVER_CONNECTED.test(net));
  // A send: only an HTTP 429, a rate-limit code, or no connection at all. No wording is read.
  if (SEND_METHODS.has(method)) return isRateLimitedByStatus(err) || neverConnected;
  if (isRateLimited(err) || neverConnected) return true;
  const status = statusOf(err);
  if (typeof status === "number" && status >= 500) return true;
  if (err?.name === "TimeoutError" || /timed? ?out/i.test(text(err))) return true;
  if (NOT_SERVED.test(text(err)) || codeOf(err) === -32601) return true;
  // A fetch that failed with no response and no HTTP status: the network, not the node's answer.
  if (err?.name === "HttpRequestError" && typeof status !== "number" && /fetch failed|network|socket|ECONNRESET|EPIPE/i.test(text(err))) return true;
  // A lookup by hash, block or address carries no argument a node could fairly call wrong, so an endpoint that does (-32602, -32600,
  // "invalid params") is that endpoint's quirk, not the answer: ask the next one. Seen on Polygon (2026-10-15): every write ended in
  // "no receipt … Invalid parameters" while the transactions had landed and other endpoints served their receipts.
  // (Only an error that came back from an endpoint: a bug in our own code is not an endpoint's failure and surfaces at once.)
  if (LOOKUP_METHODS.has(method) && (typeof codeOf(err) === "number" || /Rpc|Http|Unknown|Internal/.test(err?.name ?? ""))) return true;
  // A node's definite answer to this read ends it.
  const code = codeOf(err);
  if (code === 3 || code === -32602 || code === -32600 || code === -32015 || DEFINITE_ANSWER.test(text(err))) return false;
  // Anything else that came from an RPC call (a node's "Temporary internal error"): a read is harmless to ask again elsewhere.
  return typeof code === "number" || /Rpc|Http|Unknown|Internal/.test(err?.name ?? "");
}

/**
 * How many times a failed SEND was attempted in total (one per endpoint it reached; viem never re-sends it), read off the error or its
 * causes (0 when it carries none). More than one means an earlier attempt may have landed.
 */
export function sendAttempts(err) {
  let n = 0;
  for (let e = err, i = 0; e && i < 8; e = e.cause, i++) if (typeof e.satoSendAttempts === "number") n = Math.max(n, e.satoSendAttempts);
  return n;
}

/** The name this had before it counted same-endpoint repeats too. */
export const hostsTried = sendAttempts;

const markAttempts = (err, n) => {
  try {
    Object.defineProperty(err, "satoSendAttempts", { value: n, configurable: true, enumerable: false });
  } catch {
    // a frozen or primitive error: it simply carries no count
  }
};

/**
 * fetch that does not lose an HTTP 429. viem hands a JSON-RPC error body back as a normal answer even on a non-2xx status, so a node
 * that says "429" with a JSON body (ZAN, dRPC) would reach us as a bare RPC error code and its status would be gone; a SEND is moved
 * on only for a 429 or a rate-limit code, never for its words, so the status has to survive. The error thrown here carries
 * `status: 429` and viem wraps it as the HttpRequestError's cause (`statusOf` finds it there).
 */
async function fetchKeepingRateLimit(input, init) {
  const res = await globalThis.fetch(input, init);
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`HTTP 429 Too Many Requests${body ? `: ${body.slice(0, 200)}` : ""}`), { name: "RateLimitedError", status: 429 });
  }
  return res;
}

/** An endpoint that answered `eth_chainId` with another chain's id, or not at all. */
class WrongNetwork extends Error {
  constructor(message) {
    super(message);
    this.name = "WrongNetwork";
  }
}

/**
 * A viem transport over several endpoints. `urls` in order of preference; the one that last worked is tried first next time.
 * Each endpoint is an ordinary viem http transport with no retries of its own (the next endpoint is the retry).
 */
export function rotatingTransport(urls, { timeout = RPC_TIMEOUT_MS, headers = { "user-agent": userAgent() } } = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("rotatingTransport needs at least one url");
  // Which endpoints have been asked for their chain id: url -> true (the right chain) | the wrong id it answered. Shared by every
  // client built from this transport, so the check runs once per endpoint, not once per client.
  const checked = new Map();
  return ({ chain, retryCount: _ignored, timeout: t }) => {
    // READS: with several endpoints the next one is the retry; a single endpoint (an owner's own) keeps viem's own retries, as in v0.3.
    const own = urls.length > 1 ? { retryCount: 0 } : {};
    const parts = urls.map((u) => http(u, { timeout: t ?? timeout, ...own, fetchFn: fetchKeepingRateLimit, fetchOptions: { headers } })({ chain, ...own, timeout: t ?? timeout }));
    // SENDS never use viem's retries, whatever the number of endpoints: viem re-sends on a timeout, a 5xx or -32603, and a first send
    // that landed would then answer the second with "nonce too low" (a landed payment reported as refused). One attempt per endpoint.
    const sendParts = urls.map((u) => http(u, { timeout: t ?? timeout, retryCount: 0, fetchFn: fetchKeepingRateLimit, fetchOptions: { headers } })({ chain, retryCount: 0, timeout: t ?? timeout }));
    let current = 0;

    /** Throws WrongNetwork for an endpoint on another chain; any other failure is the endpoint's (and is read-retryable). */
    async function assertChain(at) {
      if (!chain?.id) return;
      const seen = checked.get(urls[at]);
      if (seen === true) return;
      if (seen !== undefined) throw new WrongNetwork(`${urls[at]} is chain ${seen}, not ${chain.name ?? chain.id} (${chain.id})`);
      const answer = await parts[at].request({ method: "eth_chainId" });
      let id;
      try {
        id = BigInt(answer);
      } catch {
        throw new WrongNetwork(`${urls[at]} did not answer eth_chainId with a number (${String(answer).slice(0, 40)})`);
      }
      if (id !== BigInt(chain.id)) {
        checked.set(urls[at], String(id));
        throw new WrongNetwork(`${urls[at]} is chain ${id}, not ${chain.name ?? chain.id} (${chain.id})`);
      }
      checked.set(urls[at], true);
    }

    return createTransport(
      {
        key: "rotating",
        name: "Sato rotating JSON-RPC",
        retryCount: 0,
        timeout: t ?? timeout,
        type: "rotating",
        async request(req) {
          const isSend = SEND_METHODS.has(req.method);
          let last;
          let wrong = 0;
          let touched = 0;
          for (let i = 0; i < parts.length; i++) {
            const at = (current + i) % parts.length;
            // Not a send yet: asking an endpoint which chain it is on sends nothing, so any failure here just moves on.
            try {
              await assertChain(at);
            } catch (err) {
              last = err;
              if (err instanceof WrongNetwork) wrong++;
              continue;
            }
            touched++;
            try {
              const out = await (isSend ? sendParts : parts)[at].request(req);
              current = at;
              return out;
            } catch (err) {
              last = err;
              if (isSend) markAttempts(err, touched);
              if (!isRetryable(err, req.method)) throw err;
            }
          }
          if (wrong === parts.length) throw new WrongNetwork(`none of this chain's RPC endpoints answers as ${chain?.name ?? chain?.id} (${chain?.id}); nothing was read or sent. ${last.message}`);
          if (isSend && last && touched) markAttempts(last, touched);
          throw last;
        },
      },
      { urls },
    );
  };
}

/** The transport for an EVM chain: its owner-set endpoint(s), else the registry's list. */
export function chainTransport(chainKey, opts = {}) {
  evmChain(chainKey);
  return rotatingTransport(rpcUrls(chainKey), opts);
}
