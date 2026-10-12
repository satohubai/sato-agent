// The RPC transport every EVM chain is read and written through: a list of endpoints, tried in order, that moves to the next one
// when the current one turns a call away. The public endpoints rate-limit (BNB's dataseed after about ten quick calls, Polygon's
// every other call) and some fail their TLS handshake from some networks, so one endpoint is not enough; an owner's own endpoint
// (SATO_AGENT_<CHAIN>_RPC, one URL or several separated by commas) replaces the list.
//
// WHEN IT MOVES ON. A call is retried on the next endpoint only when the first one provably did not (or could not) act on it:
//   reads    a rate limit, a 5xx, a timeout, a connection or TLS failure, a node that does not serve the method;
//   sends    (eth_sendRawTransaction) ONLY a rate limit or a failure to connect at all. A timeout or a 5xx after the request left
//            may mean the node took the transaction, and sending it on elsewhere could make a later "nonce too low" look like a
//            refusal of a transaction that landed. Those are thrown as they are, and the caller's "do not retry" handling applies.
// A node's real answer (a revert, an invalid argument, "nonce too low") is never retried: it is the answer.

import { createTransport, http } from "viem";
import { evmChain, rpcUrls } from "./chains.js";
import { USER_AGENT } from "./version.js";

export const RPC_TIMEOUT_MS = 20_000;

const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);

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
/** A connection that never reached a server: nothing was sent. */
const NEVER_CONNECTED = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SSL_|ERR_TLS|CERT_|DEPTH_ZERO|UNABLE_TO|UND_ERR_CONNECT_TIMEOUT)/;

/** Is this a limit the endpoint put on us before doing anything with the call? */
export const isRateLimited = (err) => statusOf(err) === 429 || codeOf(err) === -32005 || codeOf(err) === 429 || RATE_LIMIT.test(text(err));

/** Should `method` go to the next endpoint after `err`? (See the header for the rules.) */
export function isRetryable(err, method) {
  if (isRateLimited(err)) return true;
  const net = netCode(err);
  if (net && NEVER_CONNECTED.test(net)) return true;
  if (SEND_METHODS.has(method)) return false;
  const status = statusOf(err);
  if (typeof status === "number" && status >= 500) return true;
  if (err?.name === "TimeoutError" || /timed? ?out/i.test(text(err))) return true;
  if (NOT_SERVED.test(text(err)) || codeOf(err) === -32601) return true;
  // A fetch that failed with no response and no HTTP status: the network, not the node's answer.
  if (err?.name === "HttpRequestError" && typeof status !== "number" && /fetch failed|network|socket|ECONNRESET|EPIPE/i.test(text(err))) return true;
  return false;
}

/**
 * A viem transport over several endpoints. `urls` in order of preference; the one that last worked is tried first next time.
 * Each endpoint is an ordinary viem http transport with no retries of its own (the next endpoint is the retry).
 */
export function rotatingTransport(urls, { timeout = RPC_TIMEOUT_MS, headers = { "user-agent": USER_AGENT } } = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("rotatingTransport needs at least one url");
  return ({ chain, retryCount: _ignored, timeout: t }) => {
    // With several endpoints the next one is the retry. A single endpoint (an owner's own) keeps viem's own retries, as in v0.3.
    const own = urls.length > 1 ? { retryCount: 0 } : {};
    const parts = urls.map((u) => http(u, { timeout: t ?? timeout, ...own, fetchOptions: { headers } })({ chain, ...own, timeout: t ?? timeout }));
    let current = 0;
    return createTransport(
      {
        key: "rotating",
        name: "Sato rotating JSON-RPC",
        retryCount: 0,
        timeout: t ?? timeout,
        type: "rotating",
        async request(req) {
          let last;
          for (let i = 0; i < parts.length; i++) {
            const at = (current + i) % parts.length;
            try {
              const out = await parts[at].request(req);
              current = at;
              return out;
            } catch (err) {
              last = err;
              if (!isRetryable(err, req.method)) throw err;
            }
          }
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
