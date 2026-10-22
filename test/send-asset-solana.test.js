// `send --asset` on Solana, offline: SOL, USDC and other SPL / Token-2022 mints, the recipient's token account (created only if missing,
// its rent shown), a Token-2022 transfer fee / hook / permanent delegate shown, `--amount all` for SOL, and no Sato Hub fee in the transaction.
// The RPC is a stand-in that answers the reads a send makes; the transaction is the real one, signed in memory and decoded here.

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { address, generateKeyPairSigner, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { freshHome, raisesInForce } from "./helpers.js";

freshHome();
const { initWallet, addresses, solanaSecret } = await import("../src/wallet.js");
const { setPolicy: setPolicyAt } = await import("../src/policy.js");
const setPolicy = raisesInForce(setPolicyAt); // raises take effect at once here; the 24-hour wait is tested in test/hardening.test.js
const { Pending, Refused } = await import("../src/errors.js");
const { actions, entries, spentLast24h } = await import("../src/ledger.js");
const { PriceUnavailable } = await import("../src/price.js");
const { SATO_FEE_ACCOUNTS, SATO_REFERRAL_ACCOUNT } = await import("../src/swap/solana.js");
const { TOKEN_2022_PROGRAM, USDC_MINT } = await import("../src/solana.js");
const { transferFeeOn, tokenAccountSize } = await import("../src/send/solana.js");
const send = await import("../src/send/index.js");

initWallet();
const ME = addresses().solana;
const TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_2022 = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const SYSTEM = "11111111111111111111111111111111";
setPolicy({ chains: "solana,base", perTx: "none", perDay: "none" });
globalThis.fetch = async (url) => assert.fail(`a send made a network request: ${url}`);

const oracle = (usd = 150) => async () => ({ asset: "SOL", usd, age_s: 30, source: "chainlink:base:test" });
const rule = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refused, `expected a refusal, got ${e?.stack}`);
    return e.refusals[0].rule;
  }
  assert.fail("expected a refusal");
};

// ------------------------------------------------------------------ mints, as the chain stores them

function mintAccount({ program = TOKEN_PROGRAM_ADDRESS, decimals = 6, freeze = false, ext = [] } = {}) {
  let raw = Buffer.alloc(82);
  raw[44] = decimals;
  raw[45] = 1;
  if (freeze) {
    raw.writeUInt32LE(1, 46);
    Buffer.alloc(32, 7).copy(raw, 50);
  }
  if (program === TOKEN_2022_PROGRAM && ext.length) {
    const tlv = ext.map(([type, data]) => Buffer.concat([Buffer.from([type & 255, type >> 8, data.length & 255, data.length >> 8]), data]));
    raw = Buffer.concat([raw, Buffer.alloc(165 - 82), Buffer.from([1]), ...tlv]);
  }
  return { owner: program, data: [raw.toString("base64"), "base64"], lamports: 1_461_600n };
}
const feeConfig = ({ olderBps, newerBps, newerEpoch = 800n, max = 1_000_000_000n }) => {
  const d = Buffer.alloc(108);
  d.writeBigUInt64LE(0n, 72);
  d.writeBigUInt64LE(max, 80);
  d.writeUInt16LE(olderBps, 88);
  d.writeBigUInt64LE(newerEpoch, 90);
  d.writeBigUInt64LE(max, 98);
  d.writeUInt16LE(newerBps, 106);
  return [1, d];
};
const permanentDelegate = [12, Buffer.alloc(32, 9)];
const transferHook = [14, Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 5)])];

/** An RPC that answers a send's reads. `accounts`: address -> account; `held`: token accounts the wallet holds, as getTokenAccountsByOwner lists them. */
function chain({ lamports = 5_000_000_000n, accounts = {}, held = [], epoch = 700n, simErr = null, rentToken = 2_039_280n, status } = {}) {
  const calls = [];
  const wrap = (name, fn) => (...args) => ({ send: async () => (calls.push([name, args]), fn(...args)) });
  const rpc = {
    getBalance: wrap("getBalance", () => ({ value: lamports })),
    getAccountInfo: wrap("getAccountInfo", (a) => ({ value: accounts[a] ?? null })),
    getTokenAccountsByOwner: wrap("getTokenAccountsByOwner", () => ({ value: held })),
    getMinimumBalanceForRentExemption: wrap("rent", (size) => (BigInt(size) === 0n ? 890_880n : rentToken)),
    getEpochInfo: wrap("epoch", () => ({ epoch })),
    getLatestBlockhash: wrap("blockhash", () => ({ value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n } })),
    simulateTransaction: wrap("simulate", () => ({ value: { err: simErr } })),
    sendTransaction: wrap("send", () => "sig"),
    getSignatureStatuses: wrap("status", () => ({ value: [status ?? { confirmationStatus: "confirmed", err: null }] })),
  };
  return { rpc, calls };
}
const tokenAccount = async (mint, amount, program = TOKEN_PROGRAM_ADDRESS) => {
  const [pubkey] = await findAssociatedTokenPda({ owner: address(ME), mint: address(mint), tokenProgram: address(program) });
  return { pubkey, account: { data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } } };
};
const ataOf = async (owner, mint, program = TOKEN_PROGRAM_ADDRESS) => (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(program) }))[0];

/** The signed transaction, read back: its account keys and each instruction's program, accounts and data. */
function decode(plan) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(plan.unsignedWire));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return {
    keys: [...msg.staticAccounts],
    instructions: msg.instructions.map((i) => ({ program: msg.staticAccounts[i.programAddressIndex], accounts: (i.accountIndices ?? []).map((n) => msg.staticAccounts[n]), data: Buffer.from(i.data ?? []) })),
  };
}
const plan = (req, w, extra = {}) => send.planSend({ chain: "solana", to: TO, ...req }, { rpc: w.rpc, oraclePrice: oracle(), ...extra });
const confirm = { confirm: { sleep: async () => {}, pollMs: 0 } };

// ------------------------------------------------------------------ SOL

test("SOL --amount all keeps the rent-exempt minimum and twice the network fee, says what stays, priced from Chainlink", async () => {
  const w = chain({ lamports: 2_000_000_000n, accounts: { [TO]: { owner: SYSTEM, lamports: 1_000_000n, data: ["", "base64"] } } });
  const p = await plan({ amount: "all", asset: "SOL" }, w);
  const keep = 890_880n + 10_000n;
  assert.equal(p.units, 2_000_000_000n - keep);
  assert.equal(p.stays.text, "0.00090088 SOL");
  assert.match(p.notes.join("\n"), /Sending everything except 0\.00090088 SOL, which stays in the wallet/);
  assert.equal(p.usd, Math.ceil(1.99909912 * 150 * 1e6) / 1e6);
  assert.equal(p.unpriced, false);
  const d = decode(p);
  assert.equal(d.instructions.length, 1);
  assert.equal(d.instructions[0].program, SYSTEM);
  assert.deepEqual([...d.instructions[0].data.subarray(0, 4)], [2, 0, 0, 0]);
  assert.equal(d.instructions[0].data.readBigUInt64LE(4), p.units);
  assert.deepEqual(d.instructions[0].accounts, [ME, TO]);
  assert.equal(w.calls.filter(([n]) => n === "simulate").length, 1, "simulated before anything is signed for real");
  const r = await send.executeSend(p, { rpc: w.rpc, ...confirm });
  assert.match(r.explorer, /^https:\/\/solscan\.io\/tx\//);
  const row = actions().filter((a) => a.kind === "send").at(-1);
  assert.deepEqual([row.chain, row.asset, row.amount, row.status, row.usd], ["solana", "SOL", p.amountText, "confirmed", p.usd]);
});

test("SOL: a first transfer below the rent-exempt minimum, an amount that strands the wallet below it, and no SOL price are all refused", async () => {
  const fresh = chain({ lamports: 2_000_000_000n });
  assert.equal(await rule(plan({ amount: "0.0005", asset: "SOL" }, fresh)), "below_rent_minimum");
  assert.equal((await plan({ amount: "0.001", asset: "SOL" }, fresh)).units, 1_000_000n, "above the minimum it opens the account");
  assert.equal(await rule(plan({ amount: "1.9995", asset: "SOL" }, fresh)), "below_rent_minimum", "it would leave the wallet with less than it must hold");
  assert.equal(await rule(plan({ amount: "3", asset: "SOL" }, fresh)), "insufficient_balance");
  const down = async () => {
    throw new PriceUnavailable("stale");
  };
  assert.equal(await rule(plan({ amount: "0.01", asset: "SOL" }, fresh, { oraclePrice: down })), "price_unavailable");
});

// ------------------------------------------------------------------ USDC and other SPL tokens

test("USDC (the default asset): 1:1; the recipient's token account is created only if missing, and its rent is shown", async () => {
  const held = [await tokenAccount(USDC_MINT, 50_000_000n)];
  const missing = await plan({ amount: "12.5" }, chain({ held }));
  assert.deepEqual([missing.asset.kind, missing.usd, missing.rent.text], ["stable", 12.5, "0.00203928"]);
  assert.match(missing.notes.join("\n"), /pays about 0\.00203928 SOL in rent to create it/);
  assert.equal(decode(missing).instructions.length, 2, "create the token account, then transferChecked");
  const there = chain({ held, accounts: { [await ataOf(TO, USDC_MINT)]: { owner: TOKEN_PROGRAM_ADDRESS, data: ["", "base64"] } } });
  const present = await plan({ amount: "12.5", asset: "usdc" }, there);
  assert.equal(present.rent, null);
  assert.equal(decode(present).instructions.length, 1, "the account exists: no creation");
  assert.equal(decode(present).instructions[0].program, TOKEN_PROGRAM_ADDRESS);
  assert.equal(await rule(plan({ amount: "60" }, there)), "insufficient_balance");
  const poor = chain({ held, lamports: 1_000_000n });
  assert.equal(await rule(plan({ amount: "1" }, poor)), "not_enough_sol");
});

test("any SPL mint: read from the chain, shown by its short mint, counts $0 and is recorded unpriced; all sends the balance; never quoted", async () => {
  const w = chain({ held: [await tokenAccount(MINT, 123_456_789n)], accounts: { [MINT]: mintAccount({ decimals: 6 }) } });
  const p = await plan({ amount: "all", asset: MINT }, w);
  assert.deepEqual([p.asset.kind, p.asset.label, p.amountText, p.usd, p.unpriced], ["token", "DezX…B263", "123.456789", null, true]);
  const lines = send.sendLines(p);
  assert.ok(lines.includes("  Not counted against your USD limits (no price)."));
  assert.ok(lines.includes("  No Sato Hub fee; network gas only."));
  assert.equal(send.sendIntent(p).asset, MINT);
  assert.equal(send.sendIntent(p).amount, "123.456789");
  const before = spentLast24h().usd;
  await send.executeSend(p, { rpc: w.rpc, ...confirm });
  const row = actions().filter((a) => a.kind === "send").at(-1);
  assert.deepEqual([row.asset, row.asset_address, row.usd, row.unpriced, row.status], ["DezX…B263", MINT, null, true, "confirmed"]);
  assert.equal(spentLast24h().usd, before);
});

test("a mint that is not a mint, a token held outside the standard account, and a transfer the simulation rejects are refused before signing", async () => {
  assert.equal(await rule(plan({ amount: "1", asset: MINT }, chain({ accounts: { [MINT]: { owner: SYSTEM, data: ["", "base64"] } } }))), "asset_not_a_mint");
  await assert.rejects(plan({ amount: "1", asset: "DOGE" }, chain()), /--asset: "DOGE" is not SOL, USDC or a Solana mint address/);
  const elsewhere = { pubkey: "Fh1iDPeqBqRKeQv1Wi5Y7yNK8wFh5vVfSqwqKq6F9qBd", account: { data: { parsed: { info: { tokenAmount: { amount: "5" } } } } } };
  assert.equal(await rule(plan({ amount: "1", asset: MINT }, chain({ held: [elsewhere], accounts: { [MINT]: mintAccount() } }))), "token_account_not_standard");
  const w = chain({ held: [await tokenAccount(MINT, 5_000_000n)], accounts: { [MINT]: mintAccount() }, simErr: { InstructionError: [0, "Custom"] } });
  assert.equal(await rule(plan({ amount: "1", asset: MINT }, w)), "simulation_failed");
  assert.equal(w.calls.filter(([n]) => n === "send").length, 0);
});

test("wrapped SOL is a token with a price: its mint, Chainlink SOL/USD, 9 decimals", async () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const w = chain({ held: [await tokenAccount(WSOL, 2_000_000_000n)], accounts: { [WSOL]: mintAccount({ decimals: 9 }) } });
  const p = await plan({ amount: "1", asset: WSOL }, w);
  assert.deepEqual([p.asset.kind, p.asset.label, p.usd, p.unpriced], ["wrapped", "wSOL", 150, false]);
});

// ------------------------------------------------------------------ Token-2022

test("Token-2022 with a transfer fee: the fee is worked out for this amount (the epoch picks the rate), shown, bound in the intent, and named in the instruction", async () => {
  const mint = mintAccount({ program: TOKEN_2022_PROGRAM, decimals: 6, ext: [feeConfig({ olderBps: 100, newerBps: 500 })] });
  const held = [await tokenAccount(MINT_2022, 10_000_000n, TOKEN_2022_PROGRAM)];
  const w = chain({ held, accounts: { [MINT_2022]: mint }, epoch: 700n }); // the newer rate starts at epoch 800
  const p = await plan({ amount: "2", asset: MINT_2022 }, w);
  assert.equal(p.received.text, "1.98", "1% of 2 is 0.02");
  assert.match(p.notes.join("\n"), /charges a transfer fee of 1% .*the recipient would receive 1\.98 of the 2 sent \(0\.02 less\)/);
  assert.equal(send.sendIntent(p).received, "1.98");
  const d = decode(p);
  const transfer = d.instructions.at(-1);
  assert.equal(transfer.program, TOKEN_2022_PROGRAM);
  assert.deepEqual([transfer.data[0], transfer.data[1]], [26, 1], "TransferCheckedWithFee");
  assert.deepEqual([transfer.data.readBigUInt64LE(2), transfer.data[10], transfer.data.readBigUInt64LE(11)], [2_000_000n, 6, 20_000n]);
  const later = chain({ held, accounts: { [MINT_2022]: mint }, epoch: 800n });
  assert.equal((await plan({ amount: "2", asset: MINT_2022 }, later)).received.text, "1.9", "from epoch 800 the 5% rate applies");
  assert.equal(transferFeeOn(1_000_000n, 500, 20_000n), 20_000n, "capped at the mint's maximum");
  assert.equal(transferFeeOn(1n, 100, 1_000n), 1n, "rounded up");
  assert.equal(transferFeeOn(10n, 0, 1_000n), 0n);
});

test("Token-2022 with a permanent delegate and a transfer hook: both are SHOWN and bound in the intent, not forced to an approval; the hook's accounts ride along", async () => {
  const mint = mintAccount({ program: TOKEN_2022_PROGRAM, decimals: 9, freeze: true, ext: [permanentDelegate, transferHook] });
  const w = chain({ held: [await tokenAccount(MINT_2022, 5_000_000_000n, TOKEN_2022_PROGRAM)], accounts: { [MINT_2022]: mint } });
  const p = await plan({ amount: "1", asset: MINT_2022 }, w);
  const said = p.notes.join("\n");
  assert.match(said, /permanent delegate .*the issuer can move or burn this token in any wallet/);
  assert.match(said, /transfer hook .*the issuer's program runs on every transfer and can block it/);
  assert.match(said, /A freeze authority is set/);
  assert.deepEqual(send.sendIntent(p).powers, ["PermanentDelegate", "TransferHook"]);
  assert.equal(p.unpriced, true);
  const transfer = decode(p).instructions.at(-1);
  assert.equal(transfer.accounts.length, 6, "source, mint, destination, authority, and the hook's validation account and program");
  assert.equal(transfer.program, TOKEN_2022_PROGRAM);
  assert.equal(tokenAccountSize({ extensions: ["TransferFeeConfig", "TransferHook"] }, TOKEN_2022_PROGRAM), 165n + 1n + 4n + 12n + 5n);
  await send.executeSend(p, { rpc: w.rpc, ...confirm });
});

test("Token-2022 refusals: a non-transferable mint is refused; a frozen-by-default mint is refused only when the recipient's account would have to be created", async () => {
  const none = mintAccount({ program: TOKEN_2022_PROGRAM, ext: [[9, Buffer.alloc(0)]] });
  assert.equal(await rule(plan({ amount: "1", asset: MINT_2022 }, chain({ accounts: { [MINT_2022]: none } }))), "send.token_extension_refused");
  const frozen = mintAccount({ program: TOKEN_2022_PROGRAM, ext: [[6, Buffer.from([2])]] });
  const held = [await tokenAccount(MINT_2022, 5_000_000n, TOKEN_2022_PROGRAM)];
  assert.equal(await rule(plan({ amount: "1", asset: MINT_2022 }, chain({ held, accounts: { [MINT_2022]: frozen } }))), "recipient_account_would_be_frozen");
  const there = chain({ held, accounts: { [MINT_2022]: frozen, [await ataOf(TO, MINT_2022, TOKEN_2022_PROGRAM)]: { owner: TOKEN_2022_PROGRAM, data: ["", "base64"] } } });
  const p = await plan({ amount: "1", asset: MINT_2022 }, there);
  assert.equal(p.rent, null);
  assert.doesNotMatch(p.notes.join("\n"), /frozen/, "no note: an existing account is not affected");
});

// ------------------------------------------------------------------ nothing signed leaves the machine before the limits, the approval and the reservation

const sigsOf = (wire) => getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures;
const unsigned = (wire) => Object.values(sigsOf(wire)).every((sig) => sig === null || Buffer.from(sig).every((b) => b === 0));

test("a plan simulates an UNSIGNED copy (sigVerify off, the node's own blockhash) and sends nothing; the key is first used by execute, after the reservation, with a fresh blockhash", async () => {
  const held = [await tokenAccount(USDC_MINT, 50_000_000n)];
  const w = chain({ held });
  const seen = [];
  const order = [];
  const spentRows = () => entries().filter((e) => e.kind === "send" && e.status === "submitted").length;
  const sim = w.rpc.simulateTransaction;
  w.rpc.simulateTransaction = (wire, cfg) => (seen.push({ wire, cfg }), sim(wire, cfg));
  const bh = w.rpc.getLatestBlockhash;
  w.rpc.getLatestBlockhash = (cfg) => (order.push(spentRows()), bh(cfg));
  const p = await plan({ amount: "3" }, w);
  assert.equal(seen.length, 1);
  assert.ok(unsigned(seen[0].wire), "the wire handed to the RPC carries no signature");
  assert.deepEqual([seen[0].cfg.sigVerify, seen[0].cfg.replaceRecentBlockhash], [false, true]);
  assert.equal(w.calls.filter(([n]) => n === "send").length, 0);
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(seen[0].wire)).messageBytes);
  assert.equal(msg.header.numSignerAccounts, 1, "the wallet is still marked as the signer: it is the same message that is signed later");
  assert.equal(p.unsignedWire, seen[0].wire);
  assert.equal(order.length, 1);
  // execute: reserved first, then a fresh blockhash, then the signed wire is broadcast
  const before = spentRows();
  await send.executeSend(p, { rpc: w.rpc, ...confirm });
  assert.equal(order.length, 2);
  assert.equal(order[1], before + 1, "the blockhash for signing was asked for after the reservation");
  const sentWire = w.calls.find(([n]) => n === "send")[1][0];
  assert.ok(!unsigned(sentWire), "what is broadcast is signed");
  assert.equal(seen.length, 1, "execute simulates nothing more");
});

test("a dry run, a refused plan and an ask-mode plan never hand a signature to the RPC; the v0.4.0 Solana USDC dry run is the same", async () => {
  const held = [await tokenAccount(USDC_MINT, 50_000_000n)];
  const w = chain({ held });
  const wires = [];
  const sim = w.rpc.simulateTransaction;
  w.rpc.simulateTransaction = (wire, cfg) => (wires.push(wire), sim(wire, cfg));
  await plan({ amount: "1" }, w); // what a dry run and an ask-mode run both do
  const { dryRunSendUsdc } = await import("../src/solana.js");
  await dryRunSendUsdc({ to: TO, amount: "1" }, w.rpc);
  assert.equal(wires.length, 2);
  assert.ok(wires.every(unsigned), "no signature-valid wire was sent");
  assert.equal(w.calls.filter(([n]) => n === "send").length, 0);
  const failing = chain({ held, simErr: { InstructionError: [0, "x"] } });
  const seen = [];
  const sim2 = failing.rpc.simulateTransaction;
  failing.rpc.simulateTransaction = (wire, cfg) => (seen.push(wire), sim2(wire, cfg));
  await rule(plan({ amount: "1" }, failing));
  assert.ok(seen.length === 1 && seen.every(unsigned));
});

// ------------------------------------------------------------------ the extra stablecoins count 1:1

const STABLES = (await import("../src/chains.js")).otherStablesOf("solana");
for (const entry of STABLES) {
  test(`stable solana ${entry.symbol} ${entry.mint}: counted 1:1 (${entry.decimals} decimals), by mint and by symbol, ${entry.program === TOKEN_2022_PROGRAM ? "Token-2022 with its powers shown" : "Token program"}`, async () => {
    const t22 = entry.program === TOKEN_2022_PROGRAM;
    const mint = mintAccount({ program: entry.program, decimals: entry.decimals, freeze: true, ext: t22 ? [feeConfig({ olderBps: 0, newerBps: 0 }), permanentDelegate] : [] });
    const w = chain({ held: [await tokenAccount(entry.mint, 90_000_000n, entry.program)], accounts: { [entry.mint]: mint } });
    for (const asset of [entry.mint, entry.symbol, entry.symbol.toLowerCase()]) {
      const p = await plan({ amount: "12.34", asset }, w);
      assert.deepEqual([p.asset.kind, p.usd, p.unpriced, p.units], ["stable", 12.34, false, 12_340_000n]);
      assert.equal(p.asset.label, `${entry.symbol} ${entry.mint.slice(0, 4)}…${entry.mint.slice(-4)}`);
      assert.equal(send.sendIntent(p).asset, entry.mint);
    }
    if (t22) assert.match((await plan({ amount: "1", asset: entry.symbol }, w)).notes.join("\n"), /permanent delegate/);
    // the same address on another program is not counted
    const wrong = mintAccount({ program: t22 ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM, decimals: entry.decimals });
    assert.equal(await rule(plan({ amount: "1", asset: entry.mint }, chain({ accounts: { [entry.mint]: wrong } }))), "stable_mismatch");
  });
}

// ------------------------------------------------------------------ what is signed is what was simulated

/** A compiled message, read back, without its blockhash. */
const messageWithoutBlockhash = (wire) => {
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  const { lifetimeToken, ...rest } = msg;
  return { rest: JSON.parse(JSON.stringify(rest, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v))), lifetimeToken };
};

test("the transaction broadcast after the approval is the one that was simulated, byte for byte except the blockhash: SOL, USDC with a new token account, Token-2022 with a fee", async () => {
  const cases = [
    ["SOL", { amount: "0.25", asset: "SOL" }, () => chain({ lamports: 2_000_000_000n, accounts: { [TO]: { owner: SYSTEM, lamports: 1_000_000n, data: ["", "base64"] } } })],
    ["USDC + new account", { amount: "3" }, async () => chain({ held: [await tokenAccount(USDC_MINT, 50_000_000n)] })],
    ["Token-2022 fee", { amount: "2", asset: MINT_2022 }, async () => chain({ held: [await tokenAccount(MINT_2022, 10_000_000n, TOKEN_2022_PROGRAM)], accounts: { [MINT_2022]: mintAccount({ program: TOKEN_2022_PROGRAM, decimals: 6, ext: [feeConfig({ olderBps: 100, newerBps: 100 }), transferHook] }) } })],
  ];
  for (const [name, req, make] of cases) {
    const w = await make();
    const later = (await generateKeyPairSigner()).address; // the blockhash execute fetches is another one
    let n = 0;
    const bh = w.rpc.getLatestBlockhash;
    w.rpc.getLatestBlockhash = (cfg) => (++n === 2 ? { send: async () => ({ value: { blockhash: later, lastValidBlockHeight: 2n } }) } : bh(cfg));
    const p = await plan(req, w);
    if (name === "USDC + new account") assert.ok(p.rent, "this case creates the recipient's token account");
    await send.executeSend(p, { rpc: w.rpc, ...confirm });
    const sentWire = w.calls.find(([c]) => c === "send")[1][0];
    const a = messageWithoutBlockhash(p.unsignedWire);
    const b = messageWithoutBlockhash(sentWire);
    assert.deepEqual(b.rest, a.rest, `${name}: the same accounts, header, instructions and data`);
    assert.notEqual(b.lifetimeToken, a.lifetimeToken, `${name}: only the blockhash moved`);
    assert.equal(b.lifetimeToken, later);
    const sigs = Object.values(getTransactionDecoder().decode(getBase64Encoder().encode(sentWire)).signatures);
    assert.ok(sigs.length === 1 && sigs[0] && Buffer.from(sigs[0]).some((x) => x !== 0), `${name}: one real signature`);
  }
});

test("a signing key that is not the wallet the send was planned for is refused after the reservation: the reservation is released and nothing is signed or sent", async () => {
  const w = chain({ held: [await tokenAccount(USDC_MINT, 50_000_000n)] });
  const p = await plan({ amount: "3" }, w);
  assert.equal(p.from, ME);
  // another wallet's key, in the 64-byte seed || public key form the wallet file holds
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const other = new Uint8Array(Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]));
  const before = spentLast24h().usd;
  await assert.rejects(send.executeSend(p, { rpc: w.rpc, secret: other, ...confirm }), /is not the wallet this send was planned for/);
  assert.equal(spentLast24h().usd, before, "the reservation was given back");
  assert.equal(w.calls.filter(([c]) => c === "send").length, 0);
  assert.equal(actions().filter((a) => a.kind === "send").at(-1).status, "failed");
  await send.executeSend(p, { rpc: w.rpc, ...confirm }); // the right key still works
});

// ------------------------------------------------------------------ outcomes, and no fee

test("a signed Solana send whose outcome is unknown stays counted (never retried); a failure onchain gives the reservation back", async () => {
  const held = [await tokenAccount(USDC_MINT, 50_000_000n)];
  const hang = chain({ held });
  const p = await plan({ amount: "3" }, hang);
  const before = spentLast24h().usd;
  hang.rpc.sendTransaction = () => ({ send: async () => Promise.reject(new Error("socket hang up")) });
  await assert.rejects(send.executeSend(p, { rpc: hang.rpc, ...confirm }), (e) => e instanceof Pending);
  assert.equal(spentLast24h().usd - before, 3);
  const bad = chain({ held, status: { confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } } });
  const q = await plan({ amount: "1" }, bad);
  const mid = spentLast24h().usd;
  await assert.rejects(send.executeSend(q, { rpc: bad.rpc, ...confirm }), /failed onchain/);
  assert.equal(spentLast24h().usd, mid);
});

test("a send carries no Sato Hub fee: its transaction has no account of Sato's fee or referral, and only the transfer (plus a token account when missing)", async () => {
  const feeAccounts = [...Object.values(SATO_FEE_ACCOUNTS), SATO_REFERRAL_ACCOUNT];
  const cases = [
    [{ amount: "0.01", asset: "SOL" }, chain({ lamports: 2_000_000_000n })],
    [{ amount: "5" }, chain({ held: [await tokenAccount(USDC_MINT, 50_000_000n)] })],
    [{ amount: "1", asset: MINT }, chain({ held: [await tokenAccount(MINT, 5_000_000n)], accounts: { [MINT]: mintAccount() } })],
  ];
  for (const [req, w] of cases) {
    const p = await plan(req, w);
    const d = decode(p);
    for (const k of feeAccounts) assert.ok(!d.keys.includes(k), `${req.asset ?? "USDC"}: the transaction names ${k}`);
    const programs = d.instructions.map((i) => i.program);
    assert.ok(programs.every((x) => [SYSTEM, TOKEN_PROGRAM_ADDRESS, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"].includes(x)), programs.join());
    assert.ok(d.keys.includes(TO) || d.instructions.length > 0);
    assert.match(send.sendLines(p).at(-1), /No Sato Hub fee; network gas only\./);
    assert.equal(send.sendIntent(p).fee, "No Sato Hub fee; network gas only.");
  }
});
