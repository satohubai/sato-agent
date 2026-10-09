// x402 on Solana, offline. A local server answers 402 with Solana USDC
// requirements; a local JSON-RPC stands in for the Solana node; the fee payer
// and recipient are throwaway keypairs that never hold anything. The server
// decodes and checks the transaction the agent signed, and nothing is ever
// settled or broadcast.

import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from "@x402/svm";
import { freshHome } from "./helpers.js";

const home = freshHome();
const { initWallet, solanaSecret } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Pending, Refused } = await import("../src/errors.js");
const { pay, MAX_AUTH_WINDOW_S, BASE_NETWORK } = await import("../src/x402.js");
const { inspectSignedTransaction, SOLANA_NETWORK, USDC_MINT, MAX_BLOCKHASH_LIFETIME_BLOCKS } = await import("../src/x402-solana.js");
const { spentLast24h, entries } = await import("../src/ledger.js");
const { USDC_BASE } = await import("../src/base.js");
const { writeFileSync, appendFileSync } = await import("node:fs");
const { join } = await import("node:path");

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const FAKE_SETTLEMENT = getBase58Decoder().decode(new Uint8Array(64).fill(9));
const OTHER_MINT = getBase58Decoder().decode(new Uint8Array(32).fill(3));

const spent = () => spentLast24h().usd;
const rows = () => entries();
const lastFor = (id) => rows().filter((r) => r.id === id);

let wallet; // { solana: address }
let owner; // the agent's own signer
let feePayer; // throwaway: stands in for the facilitator
let payTo; // throwaway: stands in for the seller
let rpcServer;
let server;
let origin;
const rpcCalls = [];
let rpcHook = () => {}; // called with each method before it is answered
let rpcFail = null; // method name to answer with an error
let blockhashValid = true;
const payments = []; // what the 402 server received
let settle = true;
let nextOffer = null;
let nextOfferV1 = null;
const payments1 = []; // x402 v1 payments the server received

const ata = async (who, mint = USDC_MINT) => (await findAssociatedTokenPda({ owner: address(who), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

function mintAccount() {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(1, 0); // has a mint authority
  Buffer.alloc(32, 5).copy(b, 4);
  b.writeBigUInt64LE(1_000_000_000_000n, 36);
  b[44] = 6; // decimals
  b[45] = 1; // initialized
  return b;
}

function rpcResult(method, params) {
  switch (method) {
    case "getAccountInfo":
      return { context: { slot: 1 }, value: { data: [mintAccount().toString("base64"), "base64"], executable: false, lamports: 1461600, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } };
    case "getLatestBlockhash":
      return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000_150 } };
    case "isBlockhashValid":
      return { context: { slot: 1 }, value: blockhashValid };
    case "getBlockHeight":
      return 1_000_000;
    default:
      throw new Error(`mock RPC does not serve ${method}`);
  }
}

/** A Solana x402 "exact" requirement, with a throwaway fee payer and recipient. */
const requirement = (over = {}) => ({
  scheme: "exact",
  network: SOLANA_MAINNET_CAIP2,
  asset: USDC_MAINNET_ADDRESS,
  amount: "10000", // $0.01
  payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer },
  ...over,
});

/** The same offer as an x402 v1 server states it. */
const requirementV1 = (over = {}) => ({
  scheme: "exact",
  network: "solana",
  asset: USDC_MAINNET_ADDRESS,
  maxAmountRequired: "10000",
  resource: "http://x/",
  description: "",
  mimeType: "application/json",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer },
  ...over,
});

/** Build a transaction the way the exact scheme does, with chosen deviations; sign as the agent only. */
async function buildTx({ signer = owner, fee = feePayer, units = 10000n, to = payTo, mint = USDC_MINT, decimals = 6, extra = [], skipMemo = false, source, blockhash = BLOCKHASH } = {}) {
  const transfer = getTransferCheckedInstruction({
    source: address(source ?? (await ata(signer.address, mint))),
    mint: address(mint),
    destination: address(await ata(to, mint)),
    authority: signer,
    amount: units,
    decimals,
  });
  const limit = { programAddress: COMPUTE_BUDGET, data: Uint8Array.from([2, 0x20, 0x4e, 0, 0]) };
  const price = { programAddress: COMPUTE_BUDGET, data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) };
  const memo = { programAddress: MEMO, data: new TextEncoder().encode("00112233445566778899aabbccddeeff") };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(fee), m),
    (m) => appendTransactionMessageInstructions([limit, price, transfer, ...(skipMemo ? [] : [memo]), ...extra], m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1_000_150n }, m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/** A scheme that signs whatever transaction `make` builds, for testing what the agent does with a bad one. */
const fakeScheme = (make) => ({
  scheme: "exact",
  async createPaymentPayload(x402Version, req) {
    return { x402Version, payload: { transaction: await make(req) } };
  },
});

before(async () => {
  wallet = initWallet();
  owner = await createKeyPairSignerFromBytes(solanaSecret());
  assert.equal(owner.address, wallet.solana);
  feePayer = (await generateKeyPairSigner()).address;
  payTo = (await generateKeyPairSigner()).address;

  rpcServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      rpcCalls.push(method);
      rpcHook(method);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpcFail === method) return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "mock node is unhealthy" } }));
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: rpcResult(method, params) }));
      } catch (err) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: err.message } }));
      }
    });
  });
  await new Promise((r) => rpcServer.listen(0, "127.0.0.1", r));
  process.env.SATO_AGENT_SOLANA_RPC = `http://127.0.0.1:${rpcServer.address().port}`;

  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const sig = req.headers["payment-signature"];
    if (path.startsWith("/v1/")) {
      const xp = req.headers["x-payment"];
      if (!xp) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, error: "payment required", accepts: nextOfferV1 ?? [requirementV1()] }));
      }
      payments1.push({ path, payload: JSON.parse(Buffer.from(xp, "base64").toString()) });
      res.writeHead(200, { "content-type": "application/json", "X-PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: FAKE_SETTLEMENT, network: "solana", payer: owner.address }) });
      return res.end(JSON.stringify({ data: "paid content (v1)" }));
    }
    if (path === "/hangup" && sig) return void req.socket.destroy(); // took the payment, never answers
    const required = () => encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${path}` }, accepts: nextOffer ?? [requirement()] });
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": required() });
      return res.end("{}");
    }
    const payload = decodePaymentSignatureHeader(sig);
    payments.push({ path, payload, ua: req.headers["user-agent"], headers: req.headers, ledger: rows().slice() });
    if (!settle) {
      res.writeHead(402, { "PAYMENT-REQUIRED": required() });
      return res.end("{}");
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: FAKE_SETTLEMENT, network: SOLANA_MAINNET_CAIP2, payer: owner.address }),
    });
    res.end(JSON.stringify({ data: "paid content" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rpcServer.close();
});

const reset = () => {
  rpcHook = () => {};
  rpcFail = null;
  blockhashValid = true;
  settle = true;
  nextOffer = null;
  nextOfferV1 = null;
};

// ---------------------------------------------------------------- constants

test("the network and the mint are the ones this agent pays: Solana mainnet and USDC", () => {
  assert.equal(SOLANA_NETWORK, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(SOLANA_NETWORK, SOLANA_MAINNET_CAIP2);
  assert.equal(USDC_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(USDC_MINT, USDC_MAINNET_ADDRESS);
  assert.equal(MAX_AUTH_WINDOW_S, 300);
});

// ---------------------------------------------------------------- refusals before anything is signed

test("no limits set: nothing is reserved or signed", async () => {
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals[0].rule === "limits_not_set");
  assert.equal(payments.length, 0);
  assert.equal(rpcCalls.length, 0, "no node was asked for anything");
});

test("an unknown chain is refused", async () => {
  await assert.rejects(pay(`${origin}/a`, { chain: "ethereum" }), /--chain base\|solana/);
});

test("wrong mint, wrong network, Base-only offers: refused with the rule, nothing signed", async () => {
  setPolicy({ chains: "solana", perTx: "1", perDay: "1000" });
  const cases = {
    "another token on Solana": requirement({ asset: OTHER_MINT }),
    "Solana devnet": requirement({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
    "the v1 network name": requirement({ network: "solana" }),
    "USDC on Base": requirement({ network: BASE_NETWORK, asset: USDC_BASE, extra: { name: "USD Coin", version: "2" } }),
  };
  for (const [name, offer] of Object.entries(cases)) {
    nextOffer = [offer];
    const before = rows().length;
    await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "asset"), name);
    assert.equal(rows().length, before, `${name}: nothing was reserved`);
  }
  assert.equal(payments.length, 0);
  assert.equal(rpcCalls.length, 0);
  reset();
});

test("an authorization window that is not an integer <= 300 is refused, nothing signed", async () => {
  for (const w of [1.5, "60", "300", 301, 1e12, 0, -5, null]) {
    nextOffer = [requirement({ maxTimeoutSeconds: w })];
    await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "authorization_window"), String(w));
  }
  nextOffer = [requirement({ maxTimeoutSeconds: MAX_AUTH_WINDOW_S })]; // exactly 300 is allowed
  const r = await pay(`${origin}/a`, { chain: "solana" });
  assert.equal(r.status, 200);
  assert.equal(payments.length, 1);
  reset();
});

test("chain binding: a Solana-bound agent pays on Solana with no flag; a chain the owner did not choose is refused before anything is reserved", async () => {
  const n = payments.length;
  const r = await pay(`${origin}/a`); // no chain given: the policy's one chain
  assert.equal(r.chain, "solana");
  assert.equal(r.settled, true);
  assert.equal(payments.length, n + 1);
  const before = rows().length;
  await assert.rejects(pay(`${origin}/a`, { chain: "base" }), (e) => e instanceof Refused && e.refusals.some((x) => x.rule === "chain_not_allowed"));
  assert.equal(rows().length, before, "nothing reserved");
  assert.equal(payments.length, n + 1, "nothing sent");
  // An owner who chose both chains must say which: a missing flag never picks one.
  setPolicy({ chains: "base,solana" });
  const reservedBefore = rows().filter((x) => x.status === "submitted").length;
  await assert.rejects(pay(`${origin}/a`), /say which with --chain/);
  assert.equal(rows().filter((x) => x.status === "submitted").length, reservedBefore, "nothing reserved");
  assert.equal(payments.length, n + 1);
  setPolicy({ chains: "solana" });
  reset();
});

test("payment headers are reserved on Solana too; other headers reach the server", async () => {
  for (const h of ["PAYMENT-SIGNATURE", "X-PAYMENT", "user-agent"]) {
    await assert.rejects(pay(`${origin}/a`, { chain: "solana", headers: { [h]: "x" } }), /reserved for the payment exchange/, h);
  }
  const n = payments.length;
  const r = await pay(`${origin}/a`, { chain: "solana", method: "POST", body: '{"q":1}', headers: { "content-type": "application/json", "x-api-tag": "sato" } });
  assert.equal(r.settled, true);
  assert.equal(payments.length, n + 1);
  assert.equal(payments.at(-1).headers["content-type"], "application/json");
  assert.equal(payments.at(-1).headers["x-api-tag"], "sato");
  assert.match(payments.at(-1).ua, /^sato-agent\//);
  reset();
});

test("a missing, invalid or own-wallet fee payer is refused, nothing signed", async () => {
  const n = payments.length;
  for (const extra of [{}, { feePayer: "not an address" }, { feePayer: owner.address }]) {
    nextOffer = [requirement({ extra })];
    await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "fee_payer"), JSON.stringify(extra));
  }
  nextOffer = [requirement({ payTo: "nope" })];
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "pay_to"));
  assert.equal(payments.length, n);
  reset();
});

test("over the per-transaction limit, or the 24 h limit: refused before signing", async () => {
  setPolicy({ perTx: "0.005", perDay: "1000" });
  const n = payments.length;
  const calls = rpcCalls.length;
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "max_usd_per_tx"));
  setPolicy({ perTx: "1", perDay: String(spent() + 0.005) });
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "max_usd_per_day"));
  assert.equal(payments.length, n);
  assert.equal(rpcCalls.length, calls, "no signing step ran");
  setPolicy({ perTx: "1", perDay: "1000" });
});

test("an unreadable ledger stops spending", async () => {
  const ledger = join(home, "ledger.jsonl");
  appendFileSync(ledger, "{this line is not json\n");
  const n = payments.length;
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "ledger_unreadable"));
  assert.equal(payments.length, n);
  // Put the ledger back the way it was (drop the junk line) for the tests that follow.
  const { readFileSync } = await import("node:fs");
  writeFileSync(ledger, readFileSync(ledger, "utf8").split("\n").filter((l) => l !== "{this line is not json").join("\n"));
});

// ---------------------------------------------------------------- the handshake

test("pays with the agent's wallet: reserve first, sign, record the signature, then send", async () => {
  reset();
  const before = spent();
  let ledgerAtBlockhash = null;
  rpcHook = (m) => {
    if (m === "getLatestBlockhash") ledgerAtBlockhash = rows().filter((r) => r.status === "submitted" && r.url?.includes("/handshake"));
  };
  const r = await pay(`${origin}/handshake`, { chain: "solana" });
  rpcHook = () => {};

  // Reserved BEFORE the scheme went to the node to build the transaction.
  assert.equal(ledgerAtBlockhash?.length, 1, "the spend was reserved before signing started");
  assert.equal(ledgerAtBlockhash[0].chain, "solana");

  assert.equal(r.status, 200);
  assert.equal(r.chain, "solana");
  assert.equal(r.network, SOLANA_MAINNET_CAIP2);
  assert.equal(r.asset, USDC_MINT);
  assert.equal(r.amount_atomic, "10000");
  assert.equal(r.usd, 0.01);
  assert.equal(r.pay_to, payTo);
  assert.equal(r.settled, true);
  assert.equal(r.settlement.transaction, FAKE_SETTLEMENT);
  assert.equal(r.explorer, `https://solscan.io/tx/${FAKE_SETTLEMENT}`);
  assert.match(r.body, /paid content/);
  assert.equal(spent(), before + 0.01);

  // What the server received, checked here independently of the agent's own checks.
  const { payload, ua, ledger } = payments.at(-1);
  assert.match(ua, /^sato-agent\//);
  assert.equal(payload.x402Version, 2);
  assert.equal(payload.accepted.network, SOLANA_MAINNET_CAIP2);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(payload.payload.transaction));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], feePayer, "the facilitator pays the fee");
  assert.equal(msg.staticAccounts[1], owner.address);
  assert.equal(tx.signatures[feePayer], null, "the fee payer has not signed: nothing can land until the facilitator does");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(owner.address))]);
  assert.equal(edVerify(null, Buffer.from(tx.messageBytes), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(tx.signatures[owner.address])), true, "signed by the agent's key");
  assert.equal(msg.instructions.length, 4);
  const t = msg.instructions[2];
  assert.equal(msg.staticAccounts[t.programAddressIndex], TOKEN_PROGRAM_ADDRESS);
  const [src, mint, dst, auth] = t.accountIndices.map((i) => msg.staticAccounts[i]);
  assert.equal(src, await ata(owner.address));
  assert.equal(mint, USDC_MINT);
  assert.equal(dst, await ata(payTo));
  assert.equal(auth, owner.address);
  assert.equal(t.data[0], 12, "TransferChecked");
  assert.equal(Buffer.from(t.data).readBigUInt64LE(1), 10000n);
  assert.equal(t.data[9], 6);

  // The signature was in the ledger before the request that carried it arrived.
  const ours = getBase58Decoder().decode(tx.signatures[owner.address]);
  const recorded = ledger.find((e) => e.status === "signed" && e.payer_signature === ours);
  assert.ok(recorded, "the signature was recorded before the payment was sent");
  assert.equal(recorded.chain, "solana");
  assert.equal(recorded.blockhash, BLOCKHASH);
  assert.equal(recorded.fee_payer, feePayer);
  assert.ok(recorded.last_valid_block_height <= 1_000_000 + MAX_BLOCKHASH_LIFETIME_BLOCKS);
  assert.equal(r.signature, ours);
  assert.equal(lastFor(recorded.id).at(-1).status, "confirmed");
  assert.equal(lastFor(recorded.id).at(-1).tx, FAKE_SETTLEMENT);
});

test("a server that supplies the blockhash and a plausible last-valid height is accepted; an inflated height is not", async () => {
  nextOffer = [requirement({ extra: { feePayer, recentBlockhash: BLOCKHASH, lastValidBlockHeight: "1000100" } })];
  const ok = await pay(`${origin}/a`, { chain: "solana" });
  assert.equal(ok.status, 200);
  assert.equal(entries().filter((e) => e.status === "signed").at(-1).last_valid_block_height, 1000100);

  nextOffer = [requirement({ extra: { feePayer, recentBlockhash: BLOCKHASH, lastValidBlockHeight: "1999999999" } })];
  const n = payments.length;
  const before = spent();
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Pending && /allows at most/.test(e.message));
  assert.equal(payments.length, n, "not sent");
  assert.equal(spent(), before + 0.01, "signed, so it stays counted");
  reset();
});

test("a blockhash the node says is not valid: the payment is not sent and stays counted", async () => {
  blockhashValid = false;
  const n = payments.length;
  const before = spent();
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Pending && /blockhash is not valid/.test(e.message) && e.details.sent === false);
  assert.equal(payments.length, n);
  assert.equal(spent(), before + 0.01);
  reset();
});

test("a node that cannot confirm the blockhash after signing: not sent, stays counted", async () => {
  rpcFail = "isBlockhashValid";
  const n = payments.length;
  const before = spent();
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), (e) => e instanceof Pending);
  assert.equal(payments.length, n);
  assert.equal(spent(), before + 0.01);
  reset();
});

// ---------------------------------------------------------------- release only when nothing was signed

test("the reservation is released ONLY when the payment could not be created (nothing signed)", async () => {
  rpcFail = "getLatestBlockhash"; // the scheme cannot build the transaction
  const before = spent();
  const n = payments.length;
  await assert.rejects(pay(`${origin}/a`, { chain: "solana" }), /Failed to create payment payload/);
  assert.equal(payments.length, n);
  assert.equal(spent(), before, "released: back to where it was");
  const trail = rows().filter((r) => r.url === `${origin}/a` || r.status === "failed").slice(-2);
  assert.deepEqual(trail.map((r) => r.status), ["submitted", "failed"]);
  assert.match(trail[1].reason, /nothing signed/);
  reset();
});

// ---------------------------------------------------------------- the signed transaction must be exactly what was reserved

const deviations = {
  "a larger amount": { make: () => buildTx({ units: 10001n }), why: /transfer amount is 10001, reserved 10000/ },
  "a smaller amount": { make: () => buildTx({ units: 9999n }), why: /transfer amount is 9999/ },
  "a different recipient": { make: async () => buildTx({ to: (await generateKeyPairSigner()).address }), why: /does not go to the recipient/ },
  "a different mint": { make: () => buildTx({ mint: OTHER_MINT }), why: /not USDC/ },
  "an extra instruction": { make: () => buildTx({ extra: [{ programAddress: MEMO, data: new TextEncoder().encode("extra") }] }), why: /has 5 instructions/ },
  "a missing memo": { make: () => buildTx({ skipMemo: true }), why: /has 3 instructions/ },
  "a different fee payer": { make: async () => buildTx({ fee: (await generateKeyPairSigner()).address }), why: /fee payer is .* not the one the server named/ },
  "this wallet as the fee payer": { make: () => buildTx({ fee: owner.address }), why: /this wallet is the fee payer/ },
  "someone else's token account as the source": { make: async () => buildTx({ source: await ata(payTo) }), why: /does not come from this wallet's USDC account/ },
  "wrong decimals": { make: () => buildTx({ decimals: 9 }), why: /decimals is 9/ },
  "something that is not a transaction": { make: async () => "AAAA", why: /could not be decoded/ },
};

for (const [name, { make, why }] of Object.entries(deviations)) {
  test(`signed payload with ${name}: not sent, stays counted, exit-4 error`, async () => {
    reset();
    const n = payments.length;
    const before = spent();
    const rowsBefore = rows().length;
    await assert.rejects(
      pay(`${origin}/a`, { chain: "solana", scheme: fakeScheme(make) }),
      (e) => e instanceof Pending && e.details.sent === false && why.test(e.message) && /Do NOT retry/.test(e.message) && /stays counted/.test(e.message),
    );
    assert.equal(payments.length, n, "nothing reached the server");
    assert.equal(spent(), before + 0.01, "still counted");
    const added = rows().slice(rowsBefore).map((r) => r.status);
    assert.deepEqual(added, ["submitted", "signed_not_sent"], "never released");
  });
}

test("a payload signed by someone else's key is not accepted as this wallet's", async () => {
  const stranger = await generateKeyPairSigner();
  // Built so the stranger is the token owner; the agent is not a signer at all.
  const make = () => buildTx({ signer: stranger });
  await assert.rejects(pay(`${origin}/a`, { chain: "solana", scheme: fakeScheme(make) }), (e) => e instanceof Pending && /second signer is not this wallet|not authorized by this wallet|signature is missing/.test(e.message));
});

test("inspectSignedTransaction accepts exactly the transaction the scheme builds, and nothing looser", async () => {
  const req = requirement();
  const good = await buildTx();
  const { problems, info } = await inspectSignedTransaction(good, { req, owner: owner.address, units: 10000n });
  assert.deepEqual(problems, []);
  assert.equal(info.blockhash, BLOCKHASH);
  assert.equal(info.fee_payer, feePayer);
  assert.match(info.message_hash, /^[0-9a-f]{64}$/);
  // The same bytes against different expectations are refused.
  assert.ok((await inspectSignedTransaction(good, { req, owner: owner.address, units: 10001n })).problems.length);
  assert.ok((await inspectSignedTransaction(good, { req: requirement({ payTo: (await generateKeyPairSigner()).address }), owner: owner.address, units: 10000n })).problems.length);
  assert.ok((await inspectSignedTransaction(good, { req: requirement({ extra: { feePayer: (await generateKeyPairSigner()).address } }), owner: owner.address, units: 10000n })).problems.length);
});

test("a tampered message no longer verifies against the wallet's signature", async () => {
  const good = getBase64Encoder().encode(await buildTx());
  const tx = getTransactionDecoder().decode(good);
  const bytes = Uint8Array.from(tx.messageBytes);
  bytes[bytes.length - 2] ^= 1; // the last byte of the memo (the very last byte is the lookup-table count)
  // Re-encode with the original signatures but a changed message.
  const wire = Buffer.concat([Buffer.from(good.slice(0, 1 + 64 * 2)), Buffer.from(bytes)]);
  const { problems } = await inspectSignedTransaction(getBase64Decoder().decode(wire), { req: requirement(), owner: owner.address, units: 10000n });
  assert.ok(problems.some((p) => /does not verify/.test(p)), `got: ${problems.join("; ")}`);
});

// ---------------------------------------------------------------- signed, sent, not settled

test("a signed payment the server answers with 402 STAYS counted; the CLI exits 4 and prints the fields", async () => {
  reset();
  settle = false;
  const before = spent();
  const r = await pay(`${origin}/unsettled`, { chain: "solana" });
  assert.equal(r.status, 402);
  assert.equal(r.signed, true);
  assert.equal(r.settled, false);
  assert.equal(spent(), before + 0.01);
  assert.equal(entries().at(-1).status, "signed_unsettled");
  assert.match(r.explorer, /^https:\/\/solscan\.io\/account\//);

  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const out = [];
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, "pay", `${origin}/unsettled`, "--chain", "solana", "--skip-check", "--json"], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (c) => out.push(c));
    p.on("exit", resolve);
  });
  assert.equal(code, 4, "signed but unsettled: do not retry");
  const j = JSON.parse(Buffer.concat(out).toString());
  assert.equal(j.chain, "solana");
  assert.equal(j.network, SOLANA_MAINNET_CAIP2);
  assert.equal(j.asset, USDC_MINT);
  assert.equal(j.amount_atomic, "10000");
  assert.equal(j.pay_to, payTo);
  assert.match(j.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(j.settled, false);
  settle = true;
});

test("CLI --json for a settled Solana payment includes chain, network, asset, amount, payTo, signature and the receipt", async () => {
  reset();
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const out = [];
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, "pay", `${origin}/cli`, "--chain", "solana", "--skip-check", "--json"], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (c) => out.push(c));
    p.on("exit", resolve);
  });
  assert.equal(code, 0);
  const j = JSON.parse(Buffer.concat(out).toString());
  assert.deepEqual(
    { chain: j.chain, network: j.network, asset: j.asset, amount_atomic: j.amount_atomic, pay_to: j.pay_to, settled: j.settled },
    { chain: "solana", network: SOLANA_MAINNET_CAIP2, asset: USDC_MINT, amount_atomic: "10000", pay_to: payTo, settled: true },
  );
  assert.equal(j.settlement.transaction, FAKE_SETTLEMENT);
  assert.ok(j.signature);
});

test("CLI: --chain must be base or solana (exit 2)", async () => {
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const code = await new Promise((resolve) => spawn(process.execPath, [bin, "pay", `${origin}/cli`, "--chain", "ethereum", "--skip-check"], { env: process.env, stdio: "ignore" }).on("exit", resolve));
  assert.equal(code, 2);
});

/** Run the CLI; resolves { code, stdout, stderr }. */
function cli(args, extraEnv = {}) {
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, SATO_AGENT_MCP_URL: "http://127.0.0.1:9/unreachable", ...extraEnv } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI: chain binding for pay works like send (wrong chain exit 3, both chains need --chain exit 2), nothing reserved", async () => {
  reset();
  const n = payments.length;
  const reserved = () => rows().filter((x) => x.status === "submitted").length;
  const r0 = reserved();
  const wrong = await cli(["pay", `${origin}/cli`, "--chain", "base", "--skip-check"]);
  assert.equal(wrong.code, 3);
  assert.match(wrong.stderr, /chain_not_allowed/);
  const bound = await cli(["pay", `${origin}/cli`, "--skip-check", "--json"]);
  assert.equal(bound.code, 0, bound.stderr);
  assert.equal(JSON.parse(bound.stdout).chain, "solana", "no flag: the policy's one chain");
  setPolicy({ chains: "base,solana" });
  const both = await cli(["pay", `${origin}/cli`, "--skip-check"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--chain/);
  assert.equal(reserved(), r0 + 1, "only the one bound payment was reserved");
  assert.equal(payments.length, n + 1);
  setPolicy({ chains: "solana" });
});

test("CLI: approval mode (exit 5) and the Sato Hub gate apply to a Solana pay exactly as to Base", async () => {
  reset();
  const n = payments.length;
  setPolicy({ approval: "ask" });
  const ask = await cli(["pay", `${origin}/cli`, "--chain", "solana", "--skip-check", "--json"]);
  assert.equal(ask.code, 5, "nothing spent: needs the owner's approval");
  const { code, intent } = JSON.parse(ask.stdout).needs_approval;
  assert.equal(intent.chain, "solana", "the approval binds the chain");
  const yes = await cli(["pay", `${origin}/cli`, "--chain", "solana", "--skip-check", "--approve", code, "--json"]);
  assert.equal(yes.code, 0, yes.stderr);
  assert.equal(payments.length, n + 1);
  setPolicy({ approval: "auto" });
  // Gate on, check unreachable, owner chose refuse: stopped before anything is reserved.
  setPolicy({ checkGate: "no", onCheckUnavailable: "refuse" });
  const gated = await cli(["pay", `${origin}/cli`, "--chain", "solana"]);
  assert.equal(gated.code, 3);
  assert.match(gated.stderr, /check_unavailable/);
  const skipped = await cli(["pay", `${origin}/cli`, "--chain", "solana", "--skip-check"]);
  assert.equal(skipped.code, 3);
  assert.match(skipped.stderr, /check_required/);
  assert.equal(payments.length, n + 1, "nothing paid while gated");
  setPolicy({ checkGate: "off" });
});

// ---------------------------------------------------------------- a payment that was sent, then the connection died

test("signed and sent, then the connection is reset: Pending (exit 4), stays counted, never released", async () => {
  reset();
  const before = spent();
  const n = rows().length;
  await assert.rejects(pay(`${origin}/hangup`, { chain: "solana" }), (e) => e instanceof Pending && e.details.chain === "solana" && /Do NOT retry/.test(e.message) && /stays counted/.test(e.message) && /may still land/.test(e.message));
  assert.equal(spent(), before + 0.01);
  assert.deepEqual(rows().slice(n).map((r) => r.status), ["submitted", "signed", "signed_unconfirmed"]);
});

test("the CLI exits 4 when the connection dies after the Solana payment was sent", async () => {
  const bin = fileURLToPath(new URL("../bin/sato-agent.js", import.meta.url));
  const code = await new Promise((resolve) => spawn(process.execPath, [bin, "pay", `${origin}/hangup`, "--chain", "solana", "--skip-check", "--json"], { env: process.env, stdio: "ignore" }).on("exit", resolve));
  assert.equal(code, 4);
});

// ---------------------------------------------------------------- x402 v1 servers, same guard

test("v1: a valid Solana 402 (maxAmountRequired, network \"solana\") is paid, and the signed transaction is checked the same way", async () => {
  reset();
  const before = spent();
  const r = await pay(`${origin}/v1/ok`, { chain: "solana" });
  assert.equal(r.status, 200);
  assert.equal(r.x402_version, 1);
  assert.equal(r.network, SOLANA_MAINNET_CAIP2);
  assert.equal(r.amount_atomic, "10000");
  assert.equal(r.settled, true);
  assert.equal(spent(), before + 0.01);
  const { payload } = payments1.at(-1);
  assert.equal(payload.x402Version, 1);
  assert.equal(payload.network, "solana");
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(payload.payload.transaction));
  const { problems } = await inspectSignedTransaction(payload.payload.transaction, { req: { extra: { feePayer }, payTo }, owner: owner.address, units: 10000n });
  assert.deepEqual(problems, []);
  assert.ok(tx.signatures[owner.address]);
  assert.equal(rows().filter((e) => e.status === "signed").at(-1).x402_version, 1);
});

test("v1: wrong asset, window, network, amount or fee payer: refused, nothing signed", async () => {
  const n = payments1.length;
  const rowsBefore = rows().length;
  const cases = {
    asset: requirementV1({ asset: OTHER_MINT }),
    authorization_window: requirementV1({ maxTimeoutSeconds: 301 }),
    "authorization_window (string)": requirementV1({ maxTimeoutSeconds: "60" }),
    "authorization_window (fraction)": requirementV1({ maxTimeoutSeconds: 1.5 }),
    amount: requirementV1({ maxAmountRequired: "0x2710" }),
    "amount (v2 field only)": (() => { const r = requirementV1(); delete r.maxAmountRequired; r.amount = "10000"; return r; })(),
    fee_payer: requirementV1({ extra: { feePayer: owner.address } }),
  };
  for (const [name, offer] of Object.entries(cases)) {
    nextOfferV1 = [offer];
    const rule = name.split(" ")[0].replace("amount", "amount");
    await assert.rejects(pay(`${origin}/v1/x`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule), name);
  }
  nextOfferV1 = [requirementV1({ network: "solana-devnet" })];
  await assert.rejects(pay(`${origin}/v1/x`, { chain: "solana" }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "asset"));
  assert.equal(payments1.length, n);
  assert.equal(rows().length, rowsBefore, "nothing was reserved");
  reset();
});
