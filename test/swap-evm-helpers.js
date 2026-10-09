// Shared by the swap tests (not itself a test file).
//
// The Sato Hub response is BUILT here from a real KyberSwap route + build
// (test/fixtures/swap-evm/*.json, recorded by record.mjs), wrapped in the shape
// SWAP-CONTRACT section 1 gives. Its signature is a stand-in: the tests inject
// a verifier. Sato Hub itself is never called (build-tx writes a public record).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

export const FIXTURES = fileURLToPath(new URL("./fixtures/swap-evm/", import.meta.url));
export const SENDER = "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A"; // public, funded; the taker in the recorded fixtures

export const load = (name) => JSON.parse(fs.readFileSync(`${FIXTURES}${name}.json`, "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A Sato-shaped build-tx response for one recorded case ("usdc-to-eth" | "eth-to-usdc" | "usdc-to-weth"). */
export function satoResponse(name, opts = {}) {
  return satoResponseFrom(load(`${name}-route`), load(`${name}-build`), opts);
}

/** The same shape from a KyberSwap `routes` body and a `route/build` body (recorded, or fetched live by the fork test). */
export function satoResponseFrom(routeBody, buildBody, { signedAt = new Date().toISOString(), tokenIn, tokenOut } = {}) {
  const route = routeBody.data.routeSummary;
  const build = buildBody.data;
  return {
    mode: "build-tx",
    route_id: "rt_fixture00001",
    venue: "kyberswap",
    chain: "Base",
    token_in: tokenIn ?? route.tokenIn,
    token_out: tokenOut ?? route.tokenOut,
    amount_in: route.amountIn,
    amount_out: route.amountOut,
    sato_fee_bps: 15,
    sato_fee_recipient: "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9",
    disclosure:
      "On KyberSwap the fee is the feeAmount/feeReceiver parameter on the route itself (chargeFeeBy=currency_in, in bps), taken by the KyberSwap router on the input token; the quoted amountOut already reflects it.",
    chosen_by: [],
    alternatives: [],
    preflight: null,
    unavailable_venues: [],
    gate: { verdict: "caution", refusals: [], policy_id: null, policy_version: null },
    gate_result: null,
    simulation: { ok: true, lane: "evm_rpc+override", gas: build.gas, expectedOut: null, revert: null, reason: null, preconditions: [], precondition_only: false, overrides: [], checked_at: signedAt, digest: "fixture" },
    preconditions: [],
    tx: {
      to: build.routerAddress,
      approval_target: build.routerAddress,
      data: build.data,
      value: build.transactionValue,
      gas: build.gas,
      chain_id: 8453,
      transaction_base64: null,
    },
    withheld: null,
    checked_at: signedAt,
    caveat: "fixture",
    lane: "same-chain",
    receipt_url: "https://satohub.ai/swap/receipts/rt_fixture00001",
    non_custodial: "Sato Hub holds no keys, signs nothing and broadcasts nothing.",
    meta: { signature: { alg: "EdDSA", kid: "b04bd38b", sig: "fixture-not-a-real-signature", signed_at: signedAt, jwks_url: "https://satohub.ai/.well-known/jwks.json", canonicalization: "fixture" } },
  };
}

export const recordedSimulation = (name) => clone(load(`${name}-sim`));
export const passes = async () => ({ ok: true });

/** A simulate() that replays a recorded eth_simulateV1 result and remembers what it was asked. */
export function replay(sim, seen = []) {
  return async (req) => {
    seen.push(req);
    return clone(sim.result);
  };
}

// ----------------------------------------------------------------- a fake chain, for the execute tests

const APPROVE = "0x095ea7b3";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const topicAddr = (a) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
export const transferLog = (token, from, to, value) => ({
  address: token,
  topics: [TRANSFER, topicAddr(from), topicAddr(to)],
  data: `0x${BigInt(value).toString(16).padStart(64, "0")}`,
});

/**
 * Just enough of a viem client for signAndSend and executeBaseSwap. `script.receipts`
 * says what each broadcast does, in order: "success", "revert", "reject" (the node
 * refuses it), "nonce" (no receipt ever: Pending), or a { status, logs } object.
 * `state.allowance` is read by allowance(), set by a successful approve.
 */
export function fakeChain({ address, allowance = 0n, receipts = [], balance = 0n, balanceAfter = 0n } = {}) {
  const state = { allowance, sent: [], hashes: [] };
  let n = 0;
  const account = { address };
  const wallet = {
    async prepareTransactionRequest(req) {
      state.sent.push({ to: req.to, data: req.data, value: req.value });
      return { ...req, nonce: state.sent.length };
    },
    async signTransaction(prepared) {
      return `0x${String(prepared.nonce).padStart(8, "0")}`;
    },
  };
  const pub = {
    async sendRawTransaction({ serializedTransaction }) {
      const step = receipts[n++] ?? "success";
      state.hashes.push({ hash: keccak256(serializedTransaction), step, tx: state.sent[state.hashes.length] });
      if (step === "reject") throw Object.assign(new Error("insufficient funds for gas"), { shortMessage: "insufficient funds", details: "insufficient funds for gas * price + value" });
    },
    async waitForTransactionReceipt({ hash }) {
      const h = state.hashes.find((x) => x.hash === hash);
      if (h.step === "nonce") throw new Error("timed out");
      const spec = typeof h.step === "string" ? { status: h.step } : h.step;
      const status = spec.status === "revert" ? "reverted" : "success";
      if (status === "success" && h.tx.data?.startsWith(APPROVE)) state.allowance = BigInt(`0x${h.tx.data.slice(-64)}`);
      if (status === "success" && spec.spends !== undefined) state.allowance -= spec.spends;
      return { transactionHash: hash, status, logs: spec.logs ?? [], blockNumber: 100n, gasUsed: 100_000n, effectiveGasPrice: 1_000_000n, l1Fee: 0n };
    },
    async readContract() {
      return state.allowance;
    },
    async getBalance({ blockNumber }) {
      return blockNumber === 100n ? balanceAfter : balance;
    },
  };
  return { c: { account, wallet, pub }, state };
}
