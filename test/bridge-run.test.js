// The bridge orchestrator (src/bridge/run.js), offline: Sato Hub, the order check (src/bridge/dln.js has its own suite and is injected
// here), the chain, the simulation and deBridge's status API are all fakes. Nothing signs for real and no network is touched.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { freshHome } from "./helpers.js";
import { fakeChain, topicAddr, transferLog } from "./swap-evm-helpers.js";

freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy, bridgesEnabled, loadPolicy } = await import("../src/policy.js");
const { Refused, NeedsApproval, Pending } = await import("../src/errors.js");
const { PriceUnavailable } = await import("../src/price.js");
const { NATIVE_PLACEHOLDER, evmChain } = await import("../src/chains.js");
const { entries, actions, spentLast24h, record, VALUE_KINDS } = await import("../src/ledger.js");
const B = await import("../src/bridge/run.js");

initWallet();
const { DLN_SOURCE } = B;
const USDC_BASE = evmChain("base").stables.USDC.address;
const USDC_ARB = evmChain("arbitrum").stables.USDC.address;
const MAKER = getAddress("0x121cdcc80987a28ed4a8f8b1e1b733936d9113eb"); // the maker of the real order in the receipt fixture
const FIX_FEE = 10n ** 15n; // 0.001 ETH, as measured on Base
const ORDER_ID = "0xbe37408a454f92f13f34219a03316bcc0fed84183c89d8507c027c716ccb1c62";
const HINT_ID = "0x45c4d355d84d42f716d4d94af9b83b02cead4ed556330da3ec486bb3064fa981";
const ZERO = "0x0000000000000000000000000000000000000000";

const setup = (extra = {}) => setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", perTx: "5000", perDay: "20000", approval: "auto", bridges: "on", ...extra });
setup();

const rulesOf = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refused) return e.refusals.map((r) => r.rule);
    throw e;
  }
  return [];
};
const usdcUnits = (n) => BigInt(Math.round(n * 1e6));
const ethPrice = (usd) => async (asset) => ({ asset, usd, updated_at: "2026-10-16T00:00:00Z", age_s: 20, source: "chainlink:test" });

/** A CreatedOrder log as DlnSource emits it (the real ABI), for an order of ours. */
function createdOrderLog({ maker = MAKER, give, take, orderId = ORDER_ID, fixFee = FIX_FEE }) {
  const ev = B.CREATED_ORDER_EVENT[0];
  const order = {
    makerOrderNonce: 1n,
    makerSrc: maker,
    giveChainId: 8453n,
    giveTokenAddress: USDC_BASE,
    giveAmount: give,
    takeChainId: 42161n,
    takeTokenAddress: USDC_ARB,
    takeAmount: take,
    receiverDst: maker,
    givePatchAuthoritySrc: maker,
    orderAuthorityAddressDst: maker,
    allowedTakerDst: "0x11339397e4aa00814799197aa28438096d34c266",
    allowedCancelBeneficiarySrc: "0x",
    externalCall: "0x",
  };
  return {
    address: DLN_SOURCE.toLowerCase(),
    topics: encodeEventTopics({ abi: B.CREATED_ORDER_EVENT, eventName: "CreatedOrder" }),
    data: encodeAbiParameters(ev.inputs, [order, orderId, "0x", fixFee, 0n, 0, "0x"]),
  };
}

/**
 * One bridge world: Sato Hub's answer, the order check, a fake chain and a simulation. `o` overrides: give/take (base units),
 * tokenIn/tokenOut ("USDC"|"ETH"), chain/chainOut, receipts, logOrder (put a CreatedOrder log in the order receipt), etc.
 */
function world(o = {}) {
  const chain = o.chain ?? "base";
  const chainOut = o.chainOut ?? "arbitrum";
  const give = o.give ?? usdcUnits(1000);
  const take = o.take ?? usdcUnits(997.5);
  const native = o.native ?? false;
  const fee = o.fixFee ?? FIX_FEE;
  const value = fee + (native ? give : 0n);
  const seen = { hub: [], verify: [], sim: [], status: [] };
  const tokenIn = native ? ZERO : evmChain(chain).stables.USDC.address;
  const tokenOut = o.tokenOut ?? evmChain(chainOut).stables.USDC.address;
  const response = () => ({
    mode: "build-tx",
    chain: evmChain(chain).hubName,
    chain_out: evmChainName(chainOut),
    venue: "debridge",
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: give.toString(),
    amount_out: take.toString(),
    sato_fee_bps: 25,
    sato_fee_tier: "cross_chain",
    sato_fee_recipient: "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9",
    simulation: { ok: true },
    bridge: { protocol: "debridge-dln", order_id: HINT_ID, fix_fee_wei: fee.toString(), take_amount: take.toString(), allowed_taker_dst: "0x555c" },
    tx: { to: o.txTo ?? DLN_SOURCE, data: `0xb9303701${"00".repeat(64)}`, value: value.toString(), chain_id: evmChain(chain).chainId, approval_target: DLN_SOURCE },
    meta: { signature: { alg: "EdDSA", kid: "test", sig: "x", signed_at: new Date(o.signedAt ?? Date.now()).toISOString() } },
    ...(o.responseExtra ?? {}),
  });
  const facts = () => ({ order: {}, orderIdHint: HINT_ID, giveAmount: give, takeAmount: take, fixFeeWei: fee, value, feeBps: 25, feeAmount: (give * 25n) / 10_000n, approvalSpender: DLN_SOURCE, allowedTakerDst: "0x555c", ...(o.factsExtra ?? {}) });
  const logOrder = o.logOrder ?? true;
  const orderReceipt = { status: o.orderStatus ?? "success", logs: logOrder ? [createdOrderLog({ give, take })] : [], spends: native ? undefined : give };
  const receipts = o.receipts ?? (native ? [orderReceipt] : ["success", orderReceipt]);
  const { c, state } = fakeChain({ address: MAKER, allowance: o.allowance ?? 0n, receipts, chainKey: chain === "base" ? undefined : chain });
  const nativeOut = native ? give + fee : fee;
  const deps = {
    c,
    callTool: async (name, args) => {
      seen.hub.push({ name, args });
      return o.hubReply ? o.hubReply(response()) : { structured: response(), isError: false };
    },
    verifySignature: o.verifySignature ?? (async () => ({ ok: true })),
    verifyDlnTx: async (args) => {
      seen.verify.push(args);
      if (o.verifyThrows) throw o.verifyThrows;
      return facts();
    },
    readFixFee: async () => (o.readFee ? o.readFee() : fee),
    oraclePrice: o.oraclePrice ?? ethPrice(2500),
    simulate: async ({ calls, taker }) => {
      seen.sim.push(calls);
      if (o.simulate) return o.simulate(calls, taker);
      return [
        {
          calls: calls.map((call) => {
            if (call.data.startsWith("0x095ea7b3")) return { status: "0x1", gasUsed: "0x10000", logs: [] };
            const logs = [transferLog(NATIVE_PLACEHOLDER, MAKER, DLN_SOURCE, nativeOut), ...(native ? [] : [transferLog(tokenIn, MAKER, DLN_SOURCE, give)])];
            return { status: "0x1", gasUsed: "0x30000", logs };
          }),
        },
      ];
    },
    fetch: o.fetch,
    ...(o.deps ?? {}),
  };
  return { deps, state, seen, give, take, fee, c };
}
const evmChainName = (k) => (k === "solana" ? "Solana" : evmChain(k).hubName);
const req = (o = {}) => ({ chain: "base", toChain: "arbitrum", asset: "USDC", amount: "1000", ...o });

test("the bridge is a value kind, and the policy defaults bridges on and writes the choice explicitly", () => {
  assert.ok(VALUE_KINDS.includes("bridge"));
  const p = loadPolicy();
  assert.equal(p.bridges_off, false);
  assert.equal(bridgesEnabled(p), true);
  assert.equal(bridgesEnabled({ chains: ["base"] }), true, "a policy from before v0.5 has no key and reads as on");
});

test("turning bridges off is plain, turning them back on is a raise", () => {
  const off = setPolicy({ bridges: "off" });
  assert.equal(off.policy.bridges_off, true);
  assert.equal(off.raised, false);
  const stillOff = setPolicy({ perTx: "5000" });
  assert.equal(stillOff.policy.bridges_off, true, "a change to something else keeps the choice");
  const on = setPolicy({ bridges: "on" });
  assert.equal(on.raised, true);
  assert.ok(on.raises.includes("bridges turned on"));
  assert.throws(() => setPolicy({ bridges: "maybe" }), /--bridges must be one of: on, off/);
});

test("bridges off: refused before anything is asked of anyone", async () => {
  setPolicy({ bridges: "off" });
  const w = world();
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, w.deps)), ["bridges_not_enabled"]);
  assert.equal(w.seen.hub.length, 0, "Sato Hub is not asked");
  setPolicy({ bridges: "on" });
});

test("a source this version cannot read is refused with the plain reason, before the policy or the network", async () => {
  const w = world();
  for (const [chain, words] of [["bnb", /contract this kit does not read yet/], ["solana", /cannot read deBridge's Solana transactions yet/]]) {
    await assert.rejects(B.runBridge(req({ chain, toChain: "base" }), {}, w.deps), (e) => e instanceof Refused && e.refusals[0].rule === "bridge_source_unsupported" && words.test(e.refusals[0].message));
  }
  assert.equal(w.seen.hub.length, 0);
});

test("a destination outside the policy's chains is refused; so is a source outside it", async () => {
  setup({ chains: "base" });
  const w = world();
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, w.deps)), ["chain_not_allowed"]);
  assert.deepEqual(await rulesOf(B.runBridge(req({ chain: "arbitrum", toChain: "base" }), {}, w.deps)), ["chain_not_allowed"]);
  assert.equal(w.seen.hub.length, 0);
  setup({ chains: "arbitrum,base,bnb,polygon,solana" });
});

test("ask mode: the owner's yes comes before Sato Hub is asked (exit 5); the code then runs the bridge", async () => {
  setup({ approval: "ask" });
  const w = world();
  const err = await B.runBridge(req(), {}, w.deps).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.equal(err.intent.cmd, "bridge");
  assert.equal(err.intent.recipient, MAKER, "the intent names where the funds go");
  assert.equal(err.intent.fee_max_bps, 25);
  assert.equal(w.seen.hub.length, 0, "no quote, so no public record at Sato Hub");
  const run = await B.runBridge(req(), { approve: err.approval.code }, w.deps);
  assert.equal(run.prepared.confirm?.length ?? 0, 0);
  const done = await run.prepared.execute();
  assert.equal(done.state, "sent");
  // a used code does not work twice
  await assert.rejects(B.runBridge(req(), { approve: err.approval.code }, world().deps), /already used|not found/);
  setup({ approval: "auto" });
});

test("auto mode, low cost: the bridge runs: exact approval, the order, the id from the CreatedOrder log, the ledger says sent", async () => {
  const before = entries().length;
  const w = world();
  const { prepared } = await B.runBridge(req(), {}, w.deps);
  const d = prepared.display;
  assert.equal(d.arrives.amount, "997.5");
  assert.equal(d.arrives.exact, true);
  assert.equal(d.fix_fee.amount, "0.001");
  assert.equal(d.cost.usd, 5);
  assert.equal(d.cost.pct, 0.5);
  assert.equal(d.recipient.address, MAKER);
  assert.equal(d.approval.exact, true);
  const done = await prepared.execute();
  assert.equal(done.state, "sent");
  assert.equal(done.order_id, ORDER_ID, "read from the receipt's CreatedOrder event, not Sato Hub's hint");
  assert.equal(done.order_id_source, "log");
  assert.deepEqual(done.warnings.filter((x) => /differs/.test(x)).length, 1, "Sato Hub's differing hint is noted");
  assert.equal(done.allowance, "none_left");
  // approve (exact, to DlnSource), then the order with the fixed fee as value
  assert.equal(w.state.sent.length, 2);
  assert.match(w.state.sent[0].data, /^0x095ea7b3/);
  assert.equal(w.state.sent[0].to.toLowerCase(), USDC_BASE.toLowerCase());
  assert.ok(w.state.sent[0].data.toLowerCase().includes(DLN_SOURCE.slice(2).toLowerCase()));
  assert.equal(BigInt(`0x${w.state.sent[0].data.slice(-64)}`), w.give, "the approval is for exactly the amount");
  assert.equal(w.state.sent[1].to.toLowerCase(), DLN_SOURCE.toLowerCase());
  assert.equal(w.state.sent[1].value, FIX_FEE);
  // the ledger
  const rows = entries().slice(before).filter((e) => e.kind === "bridge" || (e.id && e.status));
  const row = actions().find((a) => a.kind === "bridge" && a.order_id === ORDER_ID);
  assert.equal(row.status, "sent");
  assert.equal(row.chain, "base");
  assert.equal(row.chain_out, "arbitrum");
  assert.equal(row.asset_in, "USDC");
  assert.equal(row.asset_out, "USDC");
  assert.equal(row.fix_fee_wei, FIX_FEE.toString());
  assert.equal(row.take_amount, "997.5");
  assert.equal(row.usd, 1002.5);
  assert.equal(row.order_id_source, "log");
  assert.equal(row.recipient, MAKER);
  assert.ok(row.tx && row.approve_tx && row.explorer.includes("basescan.org/tx/"));
  assert.deepEqual(rows.filter((e) => e.step).map((e) => e.status), ["approval_signed", "approved", "signed"]);
  assert.ok(spentLast24h().usd >= 1002.5);
});

test("the request to Sato Hub: build-tx, debridge, no slippage, the bot's own address, the owner label, markers not symbols", async () => {
  const w = world();
  await B.runBridge(req(), { dryRun: true }, w.deps);
  const a = w.seen.hub[0].args;
  assert.equal(w.seen.hub[0].name, "onchain_agent_swap");
  assert.deepEqual(
    { mode: a.mode, chain_in: a.chain_in, chain_out: a.chain_out, venue: a.venue, slippage_bps: a.slippage_bps, recipient_owner: a.recipient_owner, response_format: a.response_format },
    { mode: "build-tx", chain_in: "Base", chain_out: "Arbitrum", venue: "debridge", slippage_bps: 0, recipient_owner: "self", response_format: "json" },
  );
  assert.equal(a.token_in, USDC_BASE);
  assert.equal(a.token_out, USDC_ARB);
  assert.equal(a.amount_in, "1000000000");
  assert.equal(a.taker, MAKER);
  assert.equal(a.recipient, MAKER);
  assert.ok(!("referrer" in a), "a bridge carries no referral address");
  // the order check got the intent and the onchain fee
  const v = w.seen.verify[0];
  assert.equal(v.fixFeeWei, FIX_FEE);
  assert.equal(v.intent.amountIn, 1_000_000_000n);
  assert.equal(v.intent.chainOut, "arbitrum");
  assert.equal(v.intent.recipient, MAKER);
  // native in, Solana out: zero address and the system address, the bot's own Solana address
  const n = world({ native: true, give: 5n * 10n ** 17n, take: usdcUnits(1200), tokenOut: B.DEBRIDGE_NATIVE_SOLANA, chainOut: "solana", deps: {} });
  const sol = await B.runBridge(req({ toChain: "solana", asset: "ETH", amount: "0.5", receive: "SOL" }), { dryRun: true }, { ...n.deps, oraclePrice: ethPrice(2500) }).catch((e) => e);
  const b = n.seen.hub[0].args;
  assert.equal(b.token_in, ZERO);
  assert.equal(b.token_out, B.DEBRIDGE_NATIVE_SOLANA);
  assert.equal(b.chain_out, "Solana");
  assert.equal(b.recipient, addresses().solana);
  assert.equal(b.recipient_owner, "self");
  assert.ok(sol.prepared || sol instanceof Error);
});

test("a bridge costing more than 3% needs the owner's yes even in auto mode; the code runs it, a worse band asks again", async () => {
  // 1000 USDC, 0.001 ETH ($2.50), arrives 960: cost $42.5 = 4.24% of $1002.50
  const mk = (take) => world({ take: usdcUnits(take) });
  const w = mk(960);
  const err = await B.runBridge(req(), {}, w.deps).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.deepEqual(err.intent.confirm_reasons, ["bridge_cost_over_3_pct_upto_5pct"]);
  assert.match(err.reasons[0], /costs 4\.24% of what it moves/);
  assert.equal(w.seen.hub.length, 1, "the cost is only known from the order");
  // dry run: no approval asked, reported
  const dry = await B.runBridge(req(), { dryRun: true }, mk(960).deps);
  assert.equal(dry.prepared.display.confirm_reasons.length, 1);
  assert.match(B.bridgeLines(dry.prepared.display).join("\n"), /Needs the owner's approval before it is signed, because: this bridge costs 4\.24%/);
  // the same bridge with the code goes through
  const ok = await B.runBridge(req(), { approve: err.approval.code }, mk(960).deps);
  assert.equal((await ok.prepared.execute()).state, "sent");
  // a worse cost (another band) is not approved by that code
  const e2 = await B.runBridge(req(), {}, mk(940).deps).catch((e) => e);
  assert.ok(e2 instanceof NeedsApproval);
  assert.deepEqual(e2.intent.confirm_reasons, ["bridge_cost_over_3_pct_upto_7pct"]);
  const stale = await B.runBridge(req(), { approve: e2.approval.code }, mk(900).deps).catch((e) => e);
  assert.ok(stale instanceof NeedsApproval, "a code for a 7% band does not cover 11%");
});

test("a bridge that would deliver less than half of what it spends is refused, saying what the fixed fee is", async () => {
  // 1 USDC + 0.001 ETH ($2.50): the fee swamps it
  const w = world({ give: usdcUnits(1), take: usdcUnits(0.8) });
  const err = await B.runBridge(req({ amount: "1" }), {}, w.deps).catch((e) => e);
  assert.ok(err instanceof Refused);
  assert.equal(err.refusals[0].rule, "bridge_cost_too_high");
  assert.match(err.refusals[0].message, /the fixed fee is about \$2\.50 on Base; bridge a larger amount/);
  assert.equal(w.state.sent.length, 0);
  assert.equal(entries().filter((e) => e.status === "submitted" && e.kind === "bridge" && e.amount_in === "1").length, 0, "nothing reserved");
});

test("an unpriced coin needs the owner's yes in auto mode, and says what it cannot price", async () => {
  const none = async () => {
    throw new PriceUnavailable("stale");
  };
  const w = world({ oraclePrice: none });
  const err = await B.runBridge(req(), {}, w.deps).catch((e) => e);
  assert.ok(err instanceof NeedsApproval);
  assert.deepEqual(err.intent.confirm_reasons, ["bridge_unpriced_native"]);
  assert.match(err.reasons[0], /no independent price for ETH on Base/);
  // approved, it runs, and the ledger keeps what is priced (the stablecoin leg) as the spend
  const ok = await B.runBridge(req(), { approve: err.approval.code }, world({ oraclePrice: none }).deps);
  const done = await ok.prepared.execute();
  assert.equal(done.usd, 1000, "only the priced leg counts, never zero for the whole");
});

test("limits are shared with swaps and sends: a spend already counted leaves less room, and a bridge counts for the next send", async () => {
  setup({ perDay: "1100" });
  const room = spentLast24h().usd;
  record({ kind: "send", status: "submitted", chain: "base", usd: 1100 - room - 500, to: "0x1" });
  const w = world();
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, w.deps)), ["max_usd_per_day"]);
  assert.equal(w.state.sent.length, 0);
  setup({ perDay: "20000", perTx: "100" });
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, world().deps)), ["max_usd_per_tx"], "the per-transaction limit is checked before anything is asked");
  setup({ perTx: "5000" });
});

test("a revert gives the reservation back and sets the approval back to 0", async () => {
  const w = world({ receipts: ["success", { status: "revert", logs: [] }, "success"] });
  const { prepared } = await B.runBridge(req(), {}, w.deps);
  const before = spentLast24h().usd;
  await assert.rejects(prepared.execute(), /reverted.*basescan|transaction reverted/);
  assert.equal(spentLast24h().usd, before - 0, "nothing was reserved by this attempt that stays counted");
  const row = actions().filter((a) => a.kind === "bridge").at(-1);
  assert.equal(row.status, "failed");
  assert.equal(w.state.sent.length, 3, "approve, order, then approve(0)");
  assert.equal(BigInt(`0x${w.state.sent[2].data.slice(-64)}`), 0n);
});

test("an order whose outcome is unknown stays counted and is pending (exit 4), with the approval left alone", async () => {
  const w = world({ receipts: ["success", "nonce"] });
  const { prepared } = await B.runBridge(req(), {}, w.deps);
  const before = spentLast24h().usd;
  const err = await prepared.execute().catch((e) => e);
  assert.ok(err instanceof Pending);
  assert.match(err.message, /Do NOT retry/);
  const row = actions().filter((a) => a.kind === "bridge").at(-1);
  assert.equal(row.status, "pending");
  assert.ok(row.tx);
  assert.ok(spentLast24h().usd >= before + 1002.5 - 0.01, "the spend stays counted");
  assert.equal(w.state.sent.length, 2, "no reset after an unknown outcome");
});

test("a node that refuses the order before it lands releases the reservation", async () => {
  const w = world({ receipts: ["success", "reject", "success"] });
  const { prepared } = await B.runBridge(req(), {}, w.deps);
  await assert.rejects(prepared.execute(), /refused|insufficient/);
  assert.equal(actions().filter((a) => a.kind === "bridge").at(-1).status, "failed");
});

test("the coin as the amount: value is the fee plus the amount, no approval, and the order id falls back to Sato Hub's hint, labelled", async () => {
  const give = 5n * 10n ** 17n; // 0.5 ETH = $1250
  const w = world({ native: true, give, take: usdcUnits(1240), logOrder: false });
  const { prepared } = await B.runBridge(req({ asset: "ETH", amount: "0.5", receive: "USDC" }), {}, w.deps);
  assert.equal(prepared.display.approval, null);
  const done = await prepared.execute();
  assert.equal(w.state.sent.length, 1);
  assert.equal(w.state.sent[0].value, give + FIX_FEE);
  assert.equal(done.order_id, HINT_ID);
  assert.equal(done.order_id_source, "sato_hub");
  assert.ok(done.warnings.some((x) => /from Sato Hub and is not confirmed by the chain/.test(x)));
});

test("the order id is read from the real CreatedOrder event of a real transaction", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/bridge/created-order-receipt.json", import.meta.url), "utf8"));
  const plan = { giveAmount: 3_313_256n, takeAmount: 3_000_016n, taker: MAKER };
  const got = B.readCreatedOrder(fx.receipt, plan);
  assert.equal(got.order_id, ORDER_ID);
  // another amount, another maker, or an event from another contract is not this order
  assert.equal(B.readCreatedOrder(fx.receipt, { ...plan, giveAmount: 3_313_257n }), null);
  assert.equal(B.readCreatedOrder(fx.receipt, { ...plan, taker: getAddress("0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A") }), null);
  const moved = { ...fx.receipt, logs: fx.receipt.logs.map((l) => ({ ...l, address: "0x4f01251b0a11ca9bcc01ac3726ee779cff9298f5" })) };
  assert.equal(B.readCreatedOrder(moved, plan), null);
});

test("Sato Hub's answer is held to the signature and to the order check: nothing is signed otherwise", async () => {
  // unsigned
  const unsigned = world({ hubReply: (r) => ({ structured: { ...r, meta: {} } }) });
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, unsigned.deps)), ["signature_unverified"]);
  // a signature that does not check
  const bad = world({ verifySignature: async () => { throw new Error("bad_signature"); } });
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, bad.deps)), ["signature_unverified"]);
  // signed three minutes ago
  const old = world({ signedAt: Date.now() - 180_000 });
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, old.deps)), ["signature_stale"]);
  // an error from Sato Hub is said plainly
  const down = world({ hubReply: () => ({ isError: true, text: "deBridge declined to quote this address (its compliance check flagged it)" }) });
  const err = await B.runBridge(req(), {}, down.deps).catch((e) => e);
  assert.equal(err.refusals[0].rule, "bridge_quote_unavailable");
  assert.match(err.refusals[0].message, /compliance check flagged it/);
  // the order check says no
  const rule = (r) => new Refused([{ rule: r, limit: null, observed: null, message: "x; nothing was signed" }]);
  const wrong = world({ verifyThrows: rule("bridge_recipient_not_own") });
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, wrong.deps)), ["bridge_recipient_not_own"]);
  assert.equal(wrong.state.sent.length, 0);
});

test("the kit looks at what the order check returned too: a wrong contract, value, amount, spender or fee is refused", async () => {
  const cases = [
    [{ txTo: "0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251" }, "bridge_wrong_contract"],
    [{ factsExtra: { value: FIX_FEE * 2n } }, "bridge_value_mismatch"],
    [{ factsExtra: { giveAmount: usdcUnits(999) } }, "bridge_give_mismatch"],
    [{ factsExtra: { approvalSpender: "0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251" } }, "bridge_spender_mismatch"],
    [{ factsExtra: { feeBps: 26 } }, "fee_over_ceiling"],
    [{ factsExtra: { takeAmount: 0n } }, "bridge_take_mismatch"],
  ];
  for (const [o, rule] of cases) {
    const w = world(o);
    const r = await rulesOf(B.runBridge(req(), {}, w.deps));
    assert.ok(r.includes(rule), `${rule}: got ${r}`);
    assert.equal(w.state.sent.length, 0);
  }
});

test("the protocol's fixed fee is read onchain: unreadable or above the ceiling is refused", async () => {
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, world({ readFee: () => { throw new Error("rpc down"); } }).deps)), ["fix_fee_unreadable"]);
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, world({ readFee: () => 10n ** 17n }).deps)), ["fix_fee_over_ceiling"]);
});

test("the kit's own simulation: it must run, must pass, and nothing but the amount and the fee may leave", async () => {
  const sim = (fn) => world({ simulate: fn });
  const ok = (logs) => (calls) => [{ calls: calls.map((c) => (c.data.startsWith("0x095ea7b3") ? { status: "0x1", gasUsed: "0x1", logs: [] } : { status: "0x1", gasUsed: "0x2", logs })) }];
  const give = usdcUnits(1000);
  const good = [transferLog(NATIVE_PLACEHOLDER, MAKER, DLN_SOURCE, FIX_FEE), transferLog(USDC_BASE, MAKER, DLN_SOURCE, give)];
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(ok(good)).deps)), []);
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(() => { throw new Error("method not found"); }).deps)), ["simulation_unavailable"]);
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(() => { throw Object.assign(new Error("x"), { details: "insufficient funds for gas" }); }).deps)), ["not_enough_eth"]);
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(() => [{ calls: [{ status: "0x1", logs: [] }] }]).deps)), ["simulation_unavailable"], "an answer it cannot read");
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim((calls) => [{ calls: calls.map(() => ({ status: "0x0", returnData: "0x", logs: [] })) }]).deps)), ["simulation_failed"]);
  const more = [transferLog(NATIVE_PLACEHOLDER, MAKER, DLN_SOURCE, FIX_FEE), transferLog(USDC_BASE, MAKER, DLN_SOURCE, give + 1n)];
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(ok(more)).deps)), ["bridge_outflow_mismatch"]);
  const dai = [...good, transferLog("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", MAKER, DLN_SOURCE, 5n)];
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(ok(dai)).deps)), ["other_token_leaves"]);
  const moreEth = [transferLog(NATIVE_PLACEHOLDER, MAKER, DLN_SOURCE, FIX_FEE * 2n), transferLog(USDC_BASE, MAKER, DLN_SOURCE, give)];
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(ok(moreEth)).deps)), ["outflow_exceeds_amount"]);
  // what comes back to the wallet is not a leak
  const back = [...good, transferLog(USDC_BASE, DLN_SOURCE, MAKER, 1n)];
  assert.deepEqual(await rulesOf(B.runBridge(req(), {}, sim(ok(back)).deps)), ["bridge_outflow_mismatch"], "a net outflow other than the amount is not accepted either way");
});

test("a dry run reserves nothing, signs nothing and asks nobody, even in ask mode", async () => {
  setup({ approval: "ask" });
  const approvalsBefore = entries().filter((e) => e.kind === "approval").length;
  const countBefore = entries().filter((e) => e.kind === "bridge").length;
  const w = world();
  const { prepared } = await B.runBridge(req(), { dryRun: true }, w.deps);
  assert.ok(prepared.display.arrives);
  assert.equal(w.state.sent.length, 0);
  assert.equal(entries().filter((e) => e.kind === "bridge").length, countBefore);
  assert.equal(entries().filter((e) => e.kind === "approval").length, approvalsBefore);
  setup({ approval: "auto" });
});

test("the plan goes stale after two minutes, before and after the approval", async () => {
  const w = world({ signedAt: 1_000_000 });
  const { prepared } = await B.runBridge(req(), {}, { ...w.deps, now: 1_000_000, clock: () => 1_000_000 + 130_000 });
  await assert.rejects(prepared.execute(), (e) => e instanceof Refused && e.refusals[0].rule === "plan_stale");
  assert.equal(w.state.sent.length, 0, "nothing was reserved or signed");
  // after the approval: the clock moves between the two signings
  const w2 = world({ signedAt: 5_000_000 });
  let t = 5_000_000;
  const { prepared: p2 } = await B.runBridge(req(), {}, { ...w2.deps, now: t, clock: () => ((t += 100_000), t) });
  const err = await p2.execute().catch((e) => e);
  assert.ok(err instanceof Refused);
  assert.equal(err.refusals[0].rule, "plan_expired");
  assert.equal(w2.state.sent.length, 2, "approve, then approve(0)");
  assert.equal(BigInt(`0x${w2.state.sent[1].data.slice(-64)}`), 0n);
});

test("which asset arrives: the destination's first stablecoin; the same coin for a coin; a different coin must be named", async () => {
  const w = world();
  const d = async (r, o = {}) => (await B.sizeBridge(r, { ...w.deps, ...o }));
  assert.equal((await d(req({ toChain: "bnb" }))).tokenOut.symbol, "USDT", "BNB Chain's first stablecoin is USDT");
  assert.equal((await d(req({ toChain: "solana" }))).tokenOut.symbol, "USDC");
  assert.equal((await d(req({ asset: "ETH", amount: "0.1" }))).tokenOut.symbol, "ETH", "ETH to ETH");
  await assert.rejects(d(req({ asset: "ETH", amount: "0.1", toChain: "polygon" })), (e) => e instanceof B.BridgeUsage && /--receive is needed/.test(e.message));
  assert.equal((await d(req({ asset: "ETH", amount: "0.1", toChain: "polygon", receive: "POL" }))).tokenOut.native, true);
  await assert.rejects(d(req({ asset: "PEPE" })), (e) => e instanceof B.BridgeUsage && /is none of those/.test(e.message));
  await assert.rejects(d(req({ receive: "WETH" })), B.BridgeUsage);
  await assert.rejects(d(req({ toChain: "base" })), /same chain/);
  await assert.rejects(d(req({ amount: "1.0000001" })), /not a USDC amount/);
  // all: the whole stablecoin balance; refused for a coin
  const all = await d(req({ amount: "all" }), { tokenBalance: async () => usdcUnits(42.5) });
  assert.equal(all.amountText, "42.5");
  assert.equal(all.amountIsAll, true);
  await assert.rejects(d(req({ asset: "ETH", amount: "all" })), /give an amount/);
});

test("Arbitrum as the source asks the node for the gas of the approval and the order", async () => {
  const w = world({ chain: "arbitrum", chainOut: "base" });
  const { prepared } = await B.runBridge(req({ chain: "arbitrum", toChain: "base" }), {}, w.deps);
  await prepared.execute();
  assert.equal(w.c.chainKey, "arbitrum");
  assert.equal(w.state.estimated.length, 2, "approval and order each get the node's estimate");
});

test("status: deBridge's words, the ledger follows, and a service that is down is said, not guessed", async () => {
  const mk = (id, extra) => {
    record({ id, kind: "bridge", status: "submitted", chain: "base", chain_out: "arbitrum", usd: 10, asset_in: "USDC", amount_in: "10", asset_out: "USDC", take_amount: "9.5", to: DLN_SOURCE });
    record({ id, status: "sent", tx: `0x${id.replace(/-/g, "").padEnd(64, "a").slice(0, 64)}`, ...extra });
  };
  const oid = (n) => `0x${String(n).repeat(64)}`;
  mk("s-waiting", { order_id: oid(1) });
  mk("s-filled", { order_id: oid(2) });
  mk("s-cancelled", { order_id: oid(3) });
  mk("s-unknown", { order_id: oid(4) });
  mk("s-odd", { order_id: oid(5) });
  const statuses = { [oid(1)]: "Created", [oid(2)]: "ClaimedUnlock", [oid(3)]: "OrderCancelled", [oid(5)]: "Mystery" };
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, init });
    const id = url.match(/order\/(0x[0-9a-f]{64})\/status/)?.[1];
    if (statuses[id]) return { status: 200, json: async () => ({ status: statuses[id], orderId: id }) };
    return { status: 400, json: async () => ({ errorCode: 15, errorId: "UNKNOWN_ORDER", errorMessage: "Order not found." }) };
  };
  const view = async (id) => (await B.bridgeStatus({ id }, { fetch })).bridges[0];
  assert.equal((await view("s-waiting")).plain, "waiting for a solver to fill it");
  const filled = await view("s-filled");
  assert.equal(filled.plain, "arrived on Arbitrum");
  assert.equal(actions().find((a) => a.id === "s-filled").status, "filled");
  assert.equal((await view("s-cancelled")).plain, "cancelled; the refund on Base is on its way");
  assert.equal(actions().find((a) => a.id === "s-cancelled").status, "cancelled");
  assert.equal(actions().find((a) => a.id === "s-cancelled").usd, 10, "a cancelled order stays counted");
  assert.match((await view("s-unknown")).plain, /has not listed this order yet/);
  assert.equal(actions().find((a) => a.id === "s-unknown").status, "sent", "an unlisted order is not touched");
  assert.match((await view("s-odd")).plain, /reports "Mystery", which this kit does not know/);
  assert.equal(actions().find((a) => a.id === "s-odd").status, "sent");
  // every call named the kit, with a timeout signal
  assert.ok(asked.every((a) => /^sato-agent\//.test(a.init.headers["user-agent"]) && a.init.signal));
  // a terminal row is not asked again
  const n = asked.length;
  await view("s-filled");
  assert.equal(asked.length, n);
  // the service is down
  mk("s-down", { order_id: oid(6) });
  const down = await B.bridgeStatus({ id: "s-down" }, { fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(down.bridges[0].state, "unavailable");
  assert.match(down.bridges[0].plain, /status service did not answer/);
  assert.equal(actions().find((a) => a.id === "s-down").status, "sent");
  assert.match(down.note, /not lost/);
  const http500 = await B.bridgeStatus({ id: "s-down" }, { fetch: async () => ({ status: 503, json: async () => ({}) }) });
  assert.equal(http500.bridges[0].state, "unavailable");
  // a listing: everything in flight, newest last, with lines
  const all = await B.bridgeStatus({}, { fetch });
  assert.ok(all.bridges.length >= 5);
  assert.match(B.bridgeStatusLines(all).join("\n"), /Base -> Arbitrum {2}10 USDC -> 9\.5 USDC: /);
  await assert.rejects(B.bridgeStatus({ id: "nonexistent" }, { fetch }), /no bridge in this wallet's ledger matches/);
});

test("status: a signed order with no id is looked up from its transaction; an order id of someone else's is only read", async () => {
  record({ id: "s-pend", kind: "bridge", status: "submitted", chain: "polygon", chain_out: "base", usd: 5, asset_in: "USDC", amount_in: "5", asset_out: "USDC", take_amount: "4", to: DLN_SOURCE });
  record({ id: "s-pend", status: "signed", step: "order", tx: `0x${"b".repeat(64)}` });
  record({ id: "s-pend", status: "pending", step: "order" });
  const idNew = `0x${"c".repeat(64)}`;
  const fetch = async (url) => {
    if (url.includes("/tx/")) return { status: 200, json: async () => ({ orderIds: [idNew] }) };
    if (url.includes(idNew)) return { status: 200, json: async () => ({ status: "Fulfilled", orderId: idNew }) };
    return { status: 400, json: async () => ({ errorId: "UNKNOWN_ORDER" }) };
  };
  const r = await B.bridgeStatus({ id: "s-pend" }, { fetch });
  assert.equal(r.bridges[0].plain, "arrived on Base");
  const row = actions().find((a) => a.id === "s-pend");
  assert.equal(row.status, "filled");
  assert.equal(row.order_id, idNew);
  assert.equal(row.order_id_source, "debridge_api");
  // an unknown tx: said, with "do not retry"
  record({ id: "s-lost", kind: "bridge", status: "submitted", chain: "base", chain_out: "arbitrum", usd: 5, to: DLN_SOURCE });
  record({ id: "s-lost", status: "signed", tx: `0x${"d".repeat(64)}` });
  const lost = await B.bridgeStatus({ id: "s-lost" }, { fetch: async () => ({ status: 200, json: async () => ({ orderIds: [] }) }) });
  assert.match(lost.bridges[0].plain, /does not list an order for this transaction yet.*Do NOT retry/);
  // an order id not in the ledger
  const other = `0x${"e".repeat(64)}`;
  const foreign = await B.bridgeStatus({ id: other }, { fetch: async () => ({ status: 200, json: async () => ({ status: "Fulfilled", orderId: other }) }) });
  assert.equal(foreign.bridges[0].foreign, true);
  assert.match(foreign.note, /nothing was written/);
});

test("the lines never call a sent order bridged, and carry the sentence about Sato Hub's fee", async () => {
  const w = world();
  const { prepared } = await B.runBridge(req(), { dryRun: true }, w.deps);
  const text = B.bridgeLines(prepared.display).join("\n");
  assert.match(text, /Sato Hub fee: 0\.25% \(25 bps, cross-chain\), taken from the amount sent; Sato Hub receives it once the order is filled, not before\./);
  assert.match(text, /Recipient: this bot's own address on Arbitrum/);
  assert.match(text, /Arrives on Arbitrum: exactly 997\.5 USDC/);
  assert.match(text, /Bridge Base -> Arbitrum via deBridge/);
  assert.match(text, /fixed fee of 0\.001 ETH/);
  assert.doesNotMatch(text, /\b(bridged|safe|secure|trusted|verified|guaranteed|profit)\b/i);
});
