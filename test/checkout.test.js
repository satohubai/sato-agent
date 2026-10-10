// `buy` routing and checkouts, offline: what each kind of input is classified as, Solana
// Pay transfer requests (parsing, and the instruction order the spec requires), Solana
// Pay transaction requests (an untrusted merchant transaction), and EIP-681 links.

import assert from "node:assert/strict";
import test from "node:test";
import { AccountRole, address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { freshHome } from "./helpers.js";
import { buildTx, fakeRpc, usdcSim, usdcTransferIx, ata } from "./purchase-solana-helpers.js";

freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { USDC_MINT } = await import("../src/solana.js");
const { USDC_BASE } = await import("../src/base.js");
const { MEMO_PROGRAM, SYSTEM_PROGRAM } = await import("../src/purchase-solana.js");
const { classifyBuy, parseSolanaPay, parseEip681, solanaPayInstructions, prepareSolanaPayTransaction, prepareSolanaPayTransfer } = await import("../src/checkout.js");
const { entries } = await import("../src/ledger.js");

initWallet();
setPolicy({ chains: "base,solana", perTx: "50", perDay: "100" });
const agent = addresses().solana;
const merchant = (await generateKeyPairSigner()).address;
const ref1 = (await generateKeyPairSigner()).address;
const ref2 = (await generateKeyPairSigner()).address;
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);

test("buy: each kind of input goes to the right place, and anything else is explained", () => {
  assert.deepEqual(classifyBuy(`solana:${merchant}?amount=1&spl-token=${USDC_MINT}`), { route: "checkout", kind: "solana-pay-transfer" });
  assert.deepEqual(classifyBuy("solana:https://pay.example.com/tx?order=1"), { route: "checkout", kind: "solana-pay-transaction" });
  assert.deepEqual(classifyBuy("solana:https%3A%2F%2Fpay.example.com%2Ftx%3Forder%3D1"), { route: "checkout", kind: "solana-pay-transaction" });
  assert.deepEqual(classifyBuy(`ethereum:${USDC_BASE}@8453/transfer?address=0x1111111111111111111111111111111111111111&uint256=1000000`), { route: "checkout", kind: "eip681" });
  assert.deepEqual(classifyBuy("https://www.amazon.com/Some-Pencil/dp/B0TESTASIN?ref=x"), { route: "order", kind: "amazon" });
  assert.deepEqual(classifyBuy("B0TESTASIN"), { route: "order", kind: "amazon" });
  assert.deepEqual(classifyBuy("https://www.amazon.de/dp/B0TESTASIN"), { route: "order", kind: "amazon" }, "routed to order, which refuses a non-US store");
  assert.deepEqual(classifyBuy("https://api.example.com/x402/data"), { route: "pay", kind: "x402" });
  assert.deepEqual(classifyBuy("https://payments.coinbase.com/x402/checkout/abc"), { route: "pay", kind: "x402" });
  for (const junk of ["", "a coffee", "http://plain.example.com/x", "bitcoin:bc1qxyz", "0x1111111111111111111111111111111111111111"]) assert.deepEqual(classifyBuy(junk), { route: null, kind: null }, junk);
});

test("Solana Pay transfer request: parsed by the spec (user units, references, memo, label, message)", () => {
  const uri = `solana:${merchant}?amount=12.5&spl-token=${USDC_MINT}&reference=${ref1}&reference=${ref2}&label=Corner%20Shop&message=Thanks%20for%20your%20order&memo=order%23123%2Bgift`;
  const p = parseSolanaPay(uri);
  assert.equal(p.type, "transfer");
  assert.equal(p.recipient, merchant);
  assert.equal(p.token, "USDC");
  assert.equal(p.units, 12_500_000n);
  assert.deepEqual(p.references, [ref1, ref2]);
  assert.equal(p.label, "Corner Shop");
  assert.equal(p.memo, "order#123+gift", "a '+' stays a '+' (RFC 3986), not a space");
  const sol = parseSolanaPay(`solana:${merchant}?amount=0.000000001`);
  assert.equal(sol.token, "SOL");
  assert.equal(sol.units, 1n);
});

test("Solana Pay transfer request: malformed amounts and other tokens are refused", () => {
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1e3&spl-token=${USDC_MINT}`), /scientific notation/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1.0000001&spl-token=${USDC_MINT}`), /more than 6 decimals/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1.0000000001`), /more than 9 decimals/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=-1`), /plain decimal/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=0`), /zero/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?spl-token=${USDC_MINT}`), /no amount/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1&amount=2`), /twice/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1&spl-token=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`), refused("checkout_token"));
  assert.throws(() => parseSolanaPay("solana:notanaddress?amount=1"), /not a Solana address/);
  assert.throws(() => parseSolanaPay(`solana:${merchant}?amount=1&reference=nope`), /reference/);
  assert.throws(() => parseSolanaPay("solana:http://pay.example.com/tx"), refused("checkout_not_https"));
});

test("Solana Pay transfer request: create the payee's account, then the memo right before the transfer, references read-only at the end", async () => {
  const signer = await generateKeyPairSigner();
  const req = parseSolanaPay(`solana:${merchant}?amount=2&spl-token=${USDC_MINT}&reference=${ref1}&reference=${ref2}&memo=inv-77`);
  const ixs = await solanaPayInstructions(req, signer);
  assert.equal(ixs.length, 3);
  assert.equal(String(ixs[0].programAddress), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(String(ixs[1].programAddress), MEMO_PROGRAM);
  assert.equal(Buffer.from(ixs[1].data).toString("utf8"), "inv-77");
  const t = ixs[2];
  assert.equal(String(t.programAddress), TOKEN_PROGRAM_ADDRESS);
  assert.equal(t.data[0], 12, "TransferChecked");
  assert.equal(t.data.readBigUInt64LE ? t.data.readBigUInt64LE(1) : new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(1, true), 2_000_000n);
  const tail = t.accounts.slice(-2);
  assert.deepEqual(tail.map((a) => String(a.address)), [ref1, ref2]);
  for (const a of tail) assert.equal(a.role, AccountRole.READONLY, "a reference is read-only and never a signer");
  assert.equal(String(t.accounts[2].address), String(await ata(merchant)), "paid to the merchant's USDC account");

  const sol = await solanaPayInstructions(parseSolanaPay(`solana:${merchant}?amount=0.5&reference=${ref1}&memo=hi`), signer);
  assert.deepEqual(sol.map((i) => String(i.programAddress)), [MEMO_PROGRAM, SYSTEM_PROGRAM]);
  assert.deepEqual(sol[1].accounts.map((a) => String(a.address)), [signer.address, merchant, ref1]);
  assert.equal(sol[1].accounts[2].role, AccountRole.READONLY);
  const noMemo = await solanaPayInstructions(parseSolanaPay(`solana:${merchant}?amount=1&spl-token=${USDC_MINT}`), signer);
  assert.equal(noMemo.length, 2, "no memo instruction without a memo");
});

test("Solana Pay transfer request: a token account as recipient is refused; a good one is priced, carded and paid under the limits", async () => {
  const req = parseSolanaPay(`solana:${merchant}?amount=3&spl-token=${USDC_MINT}&reference=${ref1}&label=Shop`);
  await assert.rejects(prepareSolanaPayTransfer(req, { rpc: fakeRpc({ recipientOwner: TOKEN_PROGRAM_ADDRESS }) }), refused("recipient_not_wallet"));
  const rpc = fakeRpc({ sim: () => ({ err: null }) });
  const p = await prepareSolanaPayTransfer(req, { rpc, broadcast: { sleep: async () => {}, pollMs: 0 } });
  assert.equal(p.usd, 3);
  assert.match(p.card[0], /pay 3 USDC on Solana to .* \(Shop\)/);
  assert.deepEqual(p.intent.references, [ref1]);
  const r = await p.execute();
  assert.ok(rpc.calls.some((c) => c.m === "send"), "broadcast");
  assert.match(r.explorer, /solscan/);
  const row = entries().filter((e) => e.kind === "checkout").at(-1);
  assert.equal(row.usd, 3);
  assert.equal(row.checkout, "solana-pay-transfer");
  // Over the per-transaction limit: refused before anything is built.
  await assert.rejects(prepareSolanaPayTransfer(parseSolanaPay(`solana:${merchant}?amount=60&spl-token=${USDC_MINT}`), { rpc }), refused("max_usd_per_tx"));
});

// ---------------------------------------------------------------- transaction requests

const LINK = "https://pay.example.com/solana-pay?order=9";
function merchantFetch(wire, { label = "Example Shop" } = {}) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body, ua: init.headers["user-agent"] });
    if (init.method === "GET") return new Response(JSON.stringify({ label, icon: "https://pay.example.com/i.png" }), { status: 200 });
    return new Response(JSON.stringify({ transaction: wire, message: "Order 9" }), { status: 200 });
  };
  return { f, seen };
}

test("Solana Pay transaction request: a merchant transaction that calls a program outside the list is refused, nothing signed", async () => {
  const foreign = { programAddress: address("Stake11111111111111111111111111111111111111"), accounts: [{ address: address(agent), role: AccountRole.WRITABLE }], data: new Uint8Array([2, 0, 0, 0]) };
  const { wire } = await buildTx({ feePayer: agent, instructions: [await usdcTransferIx(agent, merchant, 1_000_000), foreign] });
  const { f, seen } = merchantFetch(wire);
  const rpc = fakeRpc({ sim: () => assert.fail("never simulated") });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: f, rpc }), refused("purchase_tx.program_allowlist"));
  assert.equal(seen[1].method, "POST");
  assert.deepEqual(JSON.parse(seen[1].body), { account: agent });
  assert.match(seen[0].ua, /^sato-agent\//);
  assert.equal(rpc.calls.length, 0);
});

test("Solana Pay transaction request: the agent must pay the fee, no unsigned stranger may sign, approvals and other tokens are refused", async () => {
  const stranger = await generateKeyPairSigner();
  const noFeePayer = await buildTx({ feePayer: merchant, instructions: [await usdcTransferIx(agent, merchant, 1_000_000)] });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(noFeePayer.wire).f, rpc: fakeRpc() }), (e) => refused("purchase_tx.fee_payer")(e) && refused("purchase_tx.signers")(e));
  const approve = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [{ address: await ata(agent), role: AccountRole.WRITABLE }, { address: stranger.address, role: AccountRole.READONLY }, { address: address(agent), role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0, 0]) };
  const withApprove = await buildTx({ feePayer: agent, instructions: [approve] });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(withApprove.wire).f, rpc: fakeRpc() }), refused("purchase_tx.token_instruction"));
  const bonk = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const otherToken = await buildTx({ feePayer: agent, instructions: [await usdcTransferIx(agent, merchant, 5, bonk)] });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(otherToken.wire).f, rpc: fakeRpc() }), refused("purchase_tx.token_mint"));
});

test("Solana Pay transaction request: a plain USDC payment is simulated, carded with its cost, and that cost is what the owner approves", async () => {
  const { wire, keys } = await buildTx({ feePayer: agent, instructions: [await usdcTransferIx(agent, merchant, 2_000_000)] });
  const agentAta = String(await ata(agent));
  const merchantAta = String(await ata(merchant));
  const rpc = fakeRpc({ sim: () => usdcSim({ keys, agent, agentAta, merchant, merchantAta, out: 2_000_000n }) });
  const p = await prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(wire).f, rpc, broadcast: { sleep: async () => {}, pollMs: 0 } });
  assert.equal(p.usd, 2);
  assert.match(p.card[0], /"Example Shop" at pay.example.com/);
  assert.match(p.card.join("\n"), /Simulated cost: 2 USDC/);
  assert.equal(p.intent.usdc_units, "2000000");
  assert.equal(rpc.calls[0].cfg.sigVerify, false);
  assert.equal(rpc.calls[0].cfg.replaceRecentBlockhash, false, "the merchant's blockhash is never replaced");
  const r = await p.execute();
  assert.match(r.explorer, /solscan/);
  // Taking more than it shows elsewhere: a second token leaving the wallet is refused.
  const bonk = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const extra = { pre: [{ accountIndex: keys.length - 1, mint: bonk, owner: agent, uiTokenAmount: { amount: "10" } }], post: [{ accountIndex: keys.length - 1, mint: bonk, owner: agent, uiTokenAmount: { amount: "0" } }] };
  const rpc2 = fakeRpc({ sim: () => usdcSim({ keys, agent, agentAta, merchant, merchantAta, out: 2_000_000n, extra }) });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(wire).f, rpc: rpc2 }), refused("purchase_tx.other_token_leaves"));
  // A delegate left on the agent's USDC account is refused.
  const rpc3 = fakeRpc({ sim: () => usdcSim({ keys, agent, agentAta, merchant, merchantAta, out: 2_000_000n, delegate: merchant }) });
  await assert.rejects(prepareSolanaPayTransaction(LINK, { fetchImpl: merchantFetch(wire).f, rpc: rpc3 }), refused("purchase_tx.lingering_approval"));
});

// ---------------------------------------------------------------- EIP-681

test("EIP-681: only a USDC transfer on Base, for an exact amount", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const ok = parseEip681(`ethereum:${USDC_BASE}@8453/transfer?address=${to}&uint256=1010000`);
  assert.deepEqual(ok, { chain: "base", to: "0x1111111111111111111111111111111111111111", units: 1_010_000n, amount: "1.01" });
  assert.equal(parseEip681(`ethereum:pay-${USDC_BASE.toLowerCase()}@8453/transfer?address=${to}&uint256=2.5e6`).amount, "2.5");
  assert.equal(parseEip681(`ethereum:${USDC_BASE}@8453/transfer?address=${to}&uint256=5000000&gas=60000`).amount, "5");
  assert.throws(() => parseEip681(`ethereum:0x2222222222222222222222222222222222222222@8453/transfer?address=${to}&uint256=1`), refused("checkout_token"));
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}/transfer?address=${to}&uint256=1`), refused("checkout_chain"));
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}@1/transfer?address=${to}&uint256=1`), refused("checkout_chain"));
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}@8453/approve?address=${to}&uint256=1`), refused("checkout_function"));
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}@8453/transfer?address=${to}&uint256=1.5`), /whole number/);
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}@8453/transfer?address=${to}&uint256=1&value=5`), /does not pay with/);
  assert.throws(() => parseEip681(`ethereum:${USDC_BASE}@8453/transfer?uint256=1`), /recipient/);
});
