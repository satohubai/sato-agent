// `send --asset` on the EVM chains, offline: the native coin, a stablecoin, a priced-by-oracle wrapped coin and an ordinary token with
// no price, the amount `all` and its gas reserve, the simulation's view of what the recipient gets, and the limits across all of them.
// The chain is a stand-in (test/swap-evm-helpers.js fakeChain) with the reads a send makes added; the simulation is injected.

import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, erc20Abi } from "viem";
import { freshHome } from "./helpers.js";
import { fakeChain, topicAddr, transferLog } from "./swap-evm-helpers.js";

freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy } = await import("../src/policy.js");
const { Pending, Refused } = await import("../src/errors.js");
const { actions, entries, spentLast24h } = await import("../src/ledger.js");
const { evmChain, NATIVE_PLACEHOLDER } = await import("../src/chains.js");
const { PriceUnavailable } = await import("../src/price.js");
const { SATO_FEE_RECIPIENT } = await import("../src/swap/evm.js");
const send = await import("../src/send/index.js");

initWallet();
const me = addresses().base;
const TO = "0x1111111111111111111111111111111111111111";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
// No dollar cap unless a test sets one: several sends here are worth thousands of dollars.
setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", perTx: "none", perDay: "none" });

// No test here may ask a venue for a quote: a send has no price lookup but the Chainlink read, which is injected.
globalThis.fetch = async (url) => assert.fail(`a send made a network request: ${url}`);

const wei = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const hex = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const oracle = (usd = 3000) => async (asset, { chain }) => ({ asset, usd, age_s: 12, source: `chainlink:${chain}:test`, updated_at: "2026-10-12T00:00:00.000Z" });

/**
 * A client for a send. `native`: the wallet's coin balance; `tokens`: { address: { balance, decimals, symbol, name } }; `code`: the
 * recipient has contract code. The gas fee the node quotes is `fee`.
 */
function world({ chainKey = "base", native = 10n ** 18n, tokens = {}, code = "0x", fee = 2_000_000_000n, receipts } = {}) {
  const { c, state } = fakeChain({ address: me, chainKey, receipts });
  const info = Object.fromEntries(Object.entries(tokens).map(([a, t]) => [a.toLowerCase(), t]));
  c.pub.getBalance = async () => native;
  c.pub.getCode = async ({ address }) => (info[address.toLowerCase()] ? "0x6080" : code);
  c.pub.estimateFeesPerGas = async () => ({ maxFeePerGas: fee, maxPriorityFeePerGas: 1n });
  c.pub.readContract = async ({ address, functionName, args }) => {
    const t = info[address.toLowerCase()];
    if (!t) throw new Error("no such token");
    if (functionName === "balanceOf") return t.balance;
    if (functionName === "decimals") return t.decimals ?? 18;
    if (functionName === "symbol") return t.symbol ?? "TKN";
    if (functionName === "name") return t.name ?? "Token";
    throw new Error(`unexpected ${functionName} ${args}`);
  };
  return { c, state };
}

/** A simulate() for a send: a native transfer (one call), or a token transfer bracketed by balance reads (five). */
function simulation({ native, units, got = units, senderLoses = units, gasUsed = 21_000n, revert, noTrace } = {}) {
  const seen = [];
  const fn = async (req) => {
    seen.push(req);
    if (native) {
      return [{ calls: [revert ? { status: "0x0", returnData: "0x", gasUsed: hex(gasUsed), error: { message: revert }, logs: [] } : { status: "0x1", returnData: "0x", gasUsed: hex(gasUsed), logs: noTrace ? [] : [transferLog(NATIVE_PLACEHOLDER, me, req.calls[0].to, got)] }] }];
    }
    const ok = (data) => ({ status: "0x1", returnData: hex(data), gasUsed: "0x5208", logs: [] });
    return [{ calls: [ok(1000n * units), ok(0n), revert ? { status: "0x0", returnData: "0x", gasUsed: hex(gasUsed), error: { message: revert }, logs: [] } : { status: "0x1", returnData: "0x", gasUsed: hex(gasUsed), logs: [] }, ok(1000n * units - senderLoses), ok(got)] }];
  };
  fn.seen = seen;
  return fn;
}

const rule = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refused, `expected a refusal, got ${e?.stack}`);
    return e.refusals[0].rule;
  }
  assert.fail("expected a refusal");
};

const run = async (req, w, extra = {}) => {
  const deps = { c: w.c, oraclePrice: oracle(), maxFeePerGas: undefined, ...extra };
  const plan = await send.planSend({ chain: req.chain ?? "base", to: TO, ...req }, deps);
  return { plan, deps };
};
const lastRow = () => actions().filter((a) => a.kind === "send").at(-1);

// ------------------------------------------------------------------ native coin

test("native ETH: priced from the Chainlink feed, sent as a plain value transfer, recorded with symbol, USD and no address", async () => {
  const w = world();
  const sim = simulation({ native: true, units: wei(0.001) });
  const { plan, deps } = await run({ amount: "0.001", asset: "ETH" }, w, { simulate: sim });
  assert.equal(plan.asset.kind, "native");
  assert.equal(plan.usd, 3);
  assert.equal(plan.unpriced, false);
  assert.equal(plan.units, wei(0.001));
  assert.equal(sim.seen[0].calls[0].value, wei(0.001), "the simulated call carries the value");
  const r = await send.executeSend(plan, deps);
  assert.match(r.explorer, /^https:\/\/basescan\.org\/tx\/0x/);
  assert.equal(w.state.sent.length, 1);
  assert.deepEqual([w.state.sent[0].to, w.state.sent[0].value, w.state.sent[0].gas], [TO, wei(0.001), 21_000n]);
  const row = lastRow();
  assert.deepEqual([row.chain, row.asset, row.asset_address, row.amount, row.usd, row.status, row.unpriced], ["base", "ETH", undefined, "0.001", 3, "confirmed", undefined]);
  assert.equal(entries().filter((e) => e.kind === "send" && e.status === "submitted").at(-1).asset_address, null, "the ledger line says null: there is no contract");
  assert.equal(row.explorer, r.explorer);
});

test("native: no Chainlink price means no send, and an unreadable fee means no send", async () => {
  const w = world();
  const down = async () => {
    throw new PriceUnavailable("the ETH/USD feed is stale");
  };
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "0.001", asset: "ETH" }, { c: w.c, oraclePrice: down, simulate: simulation({ native: true, units: wei(0.001) }) })), "price_unavailable");
  const noFee = world();
  noFee.c.pub.estimateFeesPerGas = async () => {
    throw new Error("down");
  };
  noFee.c.pub.getGasPrice = async () => {
    throw new Error("down");
  };
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "0.001", asset: "ETH" }, { c: noFee.c, oraclePrice: oracle(), simulate: simulation({ native: true, units: wei(0.001) }) })), "gas_price_unavailable");
});

test("native --amount all keeps a gas reserve (21,000 gas at the quoted fee, twice over), says what stays, and sends the rest", async () => {
  const balance = 10n ** 18n;
  const w = world({ native: balance, fee: 2_000_000_000n });
  const reserve = 21_000n * 2_000_000_000n * 2n;
  const sim = simulation({ native: true, units: balance - reserve });
  const { plan, deps } = await run({ amount: "all", asset: "ETH" }, w, { simulate: sim });
  assert.equal(plan.units, balance - reserve);
  assert.equal(plan.stays.wei, reserve);
  assert.equal(sim.seen[0].calls[0].gas, 21_000n, "the simulated gas fits what all kept");
  assert.match(plan.notes.join("\n"), /Sending everything except 0\.000084 ETH, which stays in the wallet for gas\./);
  assert.equal(send.sendIntent(plan).amount, "all", "a native all is bound as all: the gas it keeps moves with the fee");
  await send.executeSend(plan, deps);
  assert.equal(w.state.sent[0].value, balance - reserve);
});

test("native --amount all: a recipient with code reserves for 150,000 gas; nothing left after the reserve is refused", async () => {
  const w = world({ native: 10n ** 18n, code: "0x6080", fee: 2_000_000_000n });
  const { plan } = await run({ amount: "all", asset: "ETH" }, w, { simulate: simulation({ native: true, units: 10n ** 18n - 150_000n * 2_000_000_000n * 2n, gasUsed: 30_000n }) });
  assert.equal(plan.stays.wei, 150_000n * 2_000_000_000n * 2n);
  const poor = world({ native: 1000n });
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "all", asset: "ETH" }, { c: poor.c, oraclePrice: oracle(), simulate: simulation({ native: true, units: 1n }) })), "nothing_to_send");
});

test("native --amount all on Arbitrum adds the registry's data-cost pad and signs with at least the node's own estimate", async () => {
  const w = world({ chainKey: "arbitrum", native: 10n ** 18n, fee: 20_000_000n, receipts: undefined });
  w.c.pub.estimateGas = async () => 60_000n;
  const pad = evmChain("arbitrum").sendReserve.l1DataWei;
  assert.equal(pad, 50_000_000_000_000n);
  const reserve = 60_000n * 20_000_000n * 2n + pad;
  const { plan, deps } = await run({ chain: "arbitrum", amount: "all", asset: "ETH" }, w, { simulate: simulation({ native: true, units: 10n ** 18n - reserve }) });
  assert.equal(plan.stays.wei, reserve);
  assert.equal(plan.gas.limit, 60_000n, "the node's estimate covers the cost of posting the data");
  await send.executeSend(plan, deps);
  assert.equal(w.state.sent[0].gas, 60_000n);
});

test("native: more than the wallet holds, or an amount with no room for its gas, is refused with a plain rule", async () => {
  const w = world({ native: wei(0.001) });
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "0.002", asset: "ETH" }, { c: w.c, oraclePrice: oracle(), simulate: simulation({ native: true, units: wei(0.002) }) })), "insufficient_balance");
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "0.001", asset: "ETH" }, { c: w.c, oraclePrice: oracle(), simulate: simulation({ native: true, units: wei(0.001) }) })), "not_enough_eth");
});

test("native on BNB Chain and Polygon: the chain's own coin and feed; a revert in the simulation is refused", async () => {
  for (const [chain, coin] of [["bnb", "BNB"], ["polygon", "POL"]]) {
    const w = world({ chainKey: chain });
    const { plan } = await run({ chain, amount: "0.01", asset: coin.toLowerCase() }, w, { simulate: simulation({ native: true, units: wei(0.01) }) });
    assert.deepEqual([plan.asset.symbol, plan.asset.kind, plan.valuation.oracle.asset], [coin, "native", coin]);
  }
  const w = world();
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "0.001", asset: "ETH" }, { c: w.c, oraclePrice: oracle(), simulate: simulation({ native: true, units: wei(0.001), revert: "recipient rejects ETH" }) })), "send_would_fail");
});

// ------------------------------------------------------------------ stablecoins and the wrapped coin

test("a stablecoin by symbol counts 1:1, decimals-aware: BNB Chain's USDC has 18 decimals", async () => {
  const usdc = evmChain("bnb").stables.USDC.address;
  const w = world({ chainKey: "bnb", tokens: { [usdc]: { balance: 50n * 10n ** 18n } } });
  const units = 2_500_000_000_000_000_000n;
  const sim = simulation({ units });
  const { plan, deps } = await run({ chain: "bnb", amount: "2.5", asset: "USDC" }, w, { simulate: sim });
  assert.deepEqual([plan.asset.kind, plan.usd, plan.unpriced, plan.units], ["stable", 2.5, false, units]);
  await send.executeSend(plan, deps);
  const call = decodeFunctionData({ abi: erc20Abi, data: w.state.sent[0].data });
  assert.deepEqual([w.state.sent[0].to.toLowerCase(), call.functionName, call.args[0].toLowerCase(), call.args[1]], [usdc.toLowerCase(), "transfer", TO, units]);
  assert.equal(lastRow().asset_address, usdc);
});

test("no --asset and --amount all: the chain's default stable, the whole balance; a token sent in full needs no gas reserve", async () => {
  const usdt = evmChain("bnb").stables.USDT.address;
  const w = world({ chainKey: "bnb", tokens: { [usdt]: { balance: 4_200_000_000_000_000_000n } } });
  const { plan } = await run({ chain: "bnb", amount: "all" }, w, { simulate: simulation({ units: 4_200_000_000_000_000_000n }) });
  assert.deepEqual([plan.asset.symbol, plan.amountText, plan.usd, plan.stays], ["USDT", "4.2", 4.2, null]);
  assert.equal(send.sendIntent(plan).amount, "4.2", "a token is bound by its exact amount");
});

test("WETH is a token with a price: Chainlink ETH/USD, 18 decimals", async () => {
  const weth = evmChain("base").wrappedNative.address;
  const w = world({ tokens: { [weth]: { balance: 10n ** 18n } } });
  const { plan } = await run({ amount: "0.001", asset: "WETH" }, w, { simulate: simulation({ units: wei(0.001) }) });
  assert.deepEqual([plan.asset.kind, plan.usd, plan.unpriced], ["wrapped", 3, false]);
});

// ------------------------------------------------------------------ any other token: no price, still sent

test("an ordinary token by address: read from the chain, shown with symbol AND short address, counts $0, recorded unpriced, never quoted", async () => {
  const w = world({ tokens: { [PEPE]: { balance: 5_000_000n * 10n ** 18n, symbol: "PEPE", name: "Pepe" } } });
  const units = 1000n * 10n ** 18n;
  const { plan, deps } = await run({ amount: "1000", asset: PEPE }, w, { simulate: simulation({ units }) });
  assert.deepEqual([plan.asset.kind, plan.asset.label, plan.usd, plan.unpriced], ["token", "PEPE 0x6982…1933", null, true]);
  const lines = send.sendLines(plan);
  assert.match(lines.join("\n"), /Send 1000 PEPE 0x6982…1933 on base to 0x1111/);
  assert.ok(lines.includes("  Not counted against your USD limits (no price)."));
  assert.ok(lines.includes("  No Sato Hub fee; network gas only."));
  const before = spentLast24h().usd;
  const r = await send.executeSend(plan, deps);
  assert.match(r.tx, /^0x/);
  const row = lastRow();
  assert.deepEqual([row.asset, row.asset_address, row.amount, row.usd, row.unpriced, row.status], ["PEPE 0x6982…1933", PEPE, "1000", null, true, "confirmed"]);
  assert.equal(entries().filter((e) => e.kind === "send" && e.status === "submitted").at(-1).usd, null, "the ledger line says usd: null");
  assert.equal(spentLast24h().usd, before, "it counts $0 against the 24 hours");
});

test("an unpriced token follows the normal limits: the chain and the allowlist still apply, the dollar caps never refuse it, and no approval is forced", async () => {
  const w = world({ tokens: { [PEPE]: { balance: 5_000_000n * 10n ** 18n, symbol: "PEPE" } } });
  const { plan, deps } = await run({ amount: "4000000", asset: PEPE }, w, { simulate: simulation({ units: 4_000_000n * 10n ** 18n }) });
  assert.equal(plan.unpriced, true);
  await send.executeSend(plan, deps); // far more than any dollar cap could say; $0 against them
  setPolicy({ allowRecipients: ["0x2222222222222222222222222222222222222222"] });
  try {
    const again = await send.planSend({ chain: "base", to: TO, amount: "1", asset: PEPE }, { c: w.c, simulate: simulation({ units: 10n ** 18n }) });
    await assert.rejects(send.executeSend(again, { c: w.c }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "allow_recipients"));
  } finally {
    setPolicy({ allowRecipients: null });
  }
  setPolicy({ chains: "base" });
  try {
    const off = await send.planSend({ chain: "bnb", to: TO, amount: "0.5", asset: "BNB" }, { c: world({ chainKey: "bnb" }).c, oraclePrice: oracle(), simulate: simulation({ native: true, units: wei(0.5) }) });
    await assert.rejects(send.executeSend(off, { c: world({ chainKey: "bnb" }).c }), (e) => e instanceof Refused && e.refusals.some((r) => r.rule === "chain_not_allowed"));
  } finally {
    setPolicy({ chains: "arbitrum,base,bnb,polygon,solana" });
  }
});

test("a token that takes a fee on transfer: the recipient's balance change is read from the simulation and shown; the intent binds it", async () => {
  const w = world({ tokens: { [PEPE]: { balance: 10n ** 21n, symbol: "PEPE" } } });
  const units = 100n * 10n ** 18n;
  const { plan } = await run({ amount: "100", asset: PEPE }, w, { simulate: simulation({ units, got: 90n * 10n ** 18n }) });
  assert.equal(plan.received.text, "90");
  assert.match(plan.notes.join("\n"), /takes a fee on transfer: the recipient would receive 90 of the 100 sent \(10 less\)/);
  assert.equal(send.sendIntent(plan).received, "90");
  const plain = await send.planSend({ chain: "base", to: TO, amount: "100", asset: PEPE }, { c: w.c, simulate: simulation({ units }) });
  assert.equal(send.sendIntent(plain).received, undefined);
});

test("a token transfer that reverts, delivers nothing, or takes more than asked is refused before anything is signed", async () => {
  const w = world({ tokens: { [PEPE]: { balance: 10n ** 21n, symbol: "PEPE" } } });
  const units = 10n ** 18n;
  const plan = (sim) => send.planSend({ chain: "base", to: TO, amount: "1", asset: PEPE }, { c: w.c, simulate: sim });
  assert.equal(await rule(plan(simulation({ units, revert: "ERC20: transfer amount exceeds balance" }))), "send_would_fail");
  assert.equal(await rule(plan(simulation({ units, got: 0n }))), "send_delivers_nothing");
  assert.equal(await rule(plan(simulation({ units, senderLoses: 2n * units }))), "send_takes_more");
  assert.equal(w.state.sent.length, 0);
});

test("token amounts: all is the whole balance, more than the balance and more decimals than the token has are refused, a token's own address is not a recipient", async () => {
  const w = world({ tokens: { [PEPE]: { balance: 1_500_000n, decimals: 6, symbol: "PEPE" } } });
  const { plan } = await run({ amount: "all", asset: PEPE }, w, { simulate: simulation({ units: 1_500_000n }) });
  assert.equal(plan.amountText, "1.5");
  assert.equal(await rule(send.planSend({ chain: "base", to: TO, amount: "1.6", asset: PEPE }, { c: w.c, simulate: simulation({ units: 1n }) })), "insufficient_balance");
  await assert.rejects(send.planSend({ chain: "base", to: TO, amount: "1.0000001", asset: PEPE }, { c: w.c, simulate: simulation({ units: 1n }) }), /at most 6 decimals/);
  assert.equal(await rule(send.planSend({ chain: "base", to: PEPE, amount: "1", asset: PEPE }, { c: w.c, simulate: simulation({ units: 1n }) })), "recipient_is_token_contract");
  assert.equal(await rule(send.planSend({ chain: "base", to: "0x0000000000000000000000000000000000000000", amount: "1", asset: PEPE }, { c: w.c, simulate: simulation({ units: 1n }) })), "recipient_zero_address");
  await assert.rejects(send.planSend({ chain: "base", to: TO, amount: "1", asset: "0x2222222222222222222222222222222222222222" }, { c: w.c, simulate: simulation({ units: 1n }) }), /there is no contract at/);
  await assert.rejects(send.planSend({ chain: "base", to: TO, amount: "1", asset: "DOGE" }, { c: w.c, simulate: simulation({ units: 1n }) }), /--asset: "DOGE" is not USDC, ETH, WETH or a token's 0x contract address on Base/);
});

// ------------------------------------------------------------------ limits across kinds, and the broadcast rules

test("the USD limits count stables, native coins and tokens together, in dollars", async () => {
  const used = spentLast24h().usd;
  setPolicy({ perTx: "5", perDay: String(Number((used + 9).toFixed(6))) });
  try {
    const usdc = evmChain("polygon").stables.USDC.address;
    const w = world({ chainKey: "polygon", native: 100n * 10n ** 18n, tokens: { [usdc]: { balance: 100n * 10n ** 6n }, [PEPE]: { balance: 10n ** 24n, symbol: "PEPE" } } });
    const go = async (req, sim) => {
      const { plan, deps } = await run({ chain: "polygon", ...req }, w, { simulate: sim, oraclePrice: oracle(0.5) });
      return send.executeSend(plan, deps);
    };
    await go({ amount: "3", asset: "USDC" }, simulation({ units: 3_000_000n })); // $3
    await assert.rejects(go({ amount: "12", asset: "POL" }, simulation({ native: true, units: wei(12) })), (e) => e.refusals?.[0]?.rule === "max_usd_per_tx" && e.refusals[0].observed === 6, "12 POL at $0.50 is $6, over the $5 per-transaction cap");
    await go({ amount: "8", asset: "POL" }, simulation({ native: true, units: wei(8) })); // $4
    assert.equal(spentLast24h().usd - used, 7);
    await go({ amount: "99999", asset: PEPE }, simulation({ units: 99_999n * 10n ** 18n })); // no price: $0
    assert.equal(spentLast24h().usd - used, 7, "the token counted nothing");
    // $2 more would be $9: allowed exactly; one more cent is over the day
    await go({ amount: "4", asset: "POL" }, simulation({ native: true, units: wei(4) }));
    await assert.rejects(go({ amount: "0.02", asset: "POL" }, simulation({ native: true, units: wei(0.02) })), (e) => e.refusals?.some((r) => r.rule === "max_usd_per_day"));
  } finally {
    setPolicy({ perTx: "none", perDay: "none" });
  }
});

test("a signed send whose outcome is unknown stays counted and is not retried; a revert onchain gives the reservation back", async () => {
  const usdc = evmChain("base").stables.USDC.address;
  const w = world({ tokens: { [usdc]: { balance: 100n * 10n ** 6n } }, receipts: ["nonce"] });
  const { plan, deps } = await run({ amount: "1", asset: "USDC" }, w, { simulate: simulation({ units: 1_000_000n }) });
  const before = spentLast24h().usd;
  await assert.rejects(send.executeSend(plan, deps), (e) => e instanceof Pending);
  assert.equal(w.state.sent.length, 1, "sent once");
  assert.equal(spentLast24h().usd - before, 1, "still counted");
  assert.equal(lastRow().status, "signed");
  const w2 = world({ tokens: { [usdc]: { balance: 100n * 10n ** 6n } }, receipts: ["revert"] });
  const again = await run({ amount: "1", asset: "USDC" }, w2, { simulate: simulation({ units: 1_000_000n }) });
  const mid = spentLast24h().usd;
  await assert.rejects(send.executeSend(again.plan, again.deps), /transaction reverted/);
  assert.equal(spentLast24h().usd, mid, "given back");
});

// ------------------------------------------------------------------ no Sato Hub fee

test("a send is one plain transfer to the recipient: no transaction, call or log goes to the Sato fee address", async () => {
  const usdc = evmChain("base").stables.USDC.address;
  const w = world({ tokens: { [usdc]: { balance: 100n * 10n ** 6n }, [PEPE]: { balance: 10n ** 24n, symbol: "PEPE" } } });
  for (const req of [{ amount: "0.001", asset: "ETH" }, { amount: "1", asset: "USDC" }, { amount: "5", asset: PEPE }]) {
    const sim = simulation({ native: req.asset === "ETH", units: req.asset === "ETH" ? wei(0.001) : req.asset === "USDC" ? 1_000_000n : 5n * 10n ** 18n });
    const { plan, deps } = await run(req, w, { simulate: sim });
    await send.executeSend(plan, deps);
    const everything = JSON.stringify([sim.seen, w.state.sent], (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    assert.ok(!everything.includes(SATO_FEE_RECIPIENT.toLowerCase().slice(2)), `${req.asset}: the Sato fee address appears in the transaction`);
    assert.match(send.sendLines(plan).at(-1), /No Sato Hub fee; network gas only\./);
    assert.equal(send.sendIntent(plan).fee, "No Sato Hub fee; network gas only.");
  }
  assert.equal(w.state.sent.length, 3, "one transaction per send");
  const tokenCall = decodeFunctionData({ abi: erc20Abi, data: w.state.sent[2].data });
  assert.deepEqual([w.state.sent[2].to.toLowerCase(), tokenCall.args[0].toLowerCase()], [PEPE.toLowerCase(), TO]);
});

void topicAddr;
