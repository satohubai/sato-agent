// `send --asset` on Solana, offline: SOL, USDC and other SPL / Token-2022 mints, the recipient's token account (created only if missing,
// its rent shown), a Token-2022 transfer fee / hook / permanent delegate shown, `--amount all` for SOL, and no Sato Hub fee in the transaction.
// The RPC is a stand-in that answers the reads a send makes; the transaction is the real one, signed in memory and decoded here.

import assert from "node:assert/strict";
import test from "node:test";
import { address, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { freshHome } from "./helpers.js";

freshHome();
const { initWallet, addresses, solanaSecret } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Pending, Refused } = await import("../src/errors.js");
const { actions, spentLast24h } = await import("../src/ledger.js");
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
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(plan.built.wire));
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

test("Token-2022 refusals and the frozen-by-default note: a non-transferable mint is refused, a frozen default only told", async () => {
  const none = mintAccount({ program: TOKEN_2022_PROGRAM, ext: [[9, Buffer.alloc(0)]] });
  assert.equal(await rule(plan({ amount: "1", asset: MINT_2022 }, chain({ accounts: { [MINT_2022]: none } }))), "send.token_extension_refused");
  const frozen = mintAccount({ program: TOKEN_2022_PROGRAM, ext: [[6, Buffer.from([2])]] });
  const p = await plan({ amount: "1", asset: MINT_2022 }, chain({ held: [await tokenAccount(MINT_2022, 5_000_000n, TOKEN_2022_PROGRAM)], accounts: { [MINT_2022]: frozen } }));
  assert.match(p.notes.join("\n"), /New token accounts for this mint start frozen/);
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
