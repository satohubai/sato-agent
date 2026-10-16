// The deBridge DLN order decoder and verifier (src/bridge/dln.js), offline. The calldata is real: each fixture is a
// create-tx answer deBridge gave on 2026-10-16 (test/fixtures/bridge/), and the "signed Sato Hub response" around it is built here
// from the fixture. Every rule has a tamper test: one field of the real calldata is changed, re-encoded, and must be refused.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { getAddressDecoder } from "@solana/kit";
import { freshHome } from "./helpers.js";

freshHome();
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", "bridge", `${name}.json`), "utf8"));
const ABI = fixture("dln-create-salted-order-abi");

const dln = await import("../src/bridge/dln.js");
const { Refused } = await import("../src/errors.js");
const chains = await import("../src/chains.js");
const { SATO_FEE_RECIPIENT } = await import("../src/swap/evm.js");
const F = await import("../src/swap/fee-tier.js");
const { DLN_SOURCE, CREATE_SALTED_ORDER_SELECTOR, BRIDGE_FEE_CEILING_BPS, DEBRIDGE_NATIVE_EVM, DEBRIDGE_NATIVE_SOLANA, encodeDestAddress, decodeCreateSaltedOrder, verifyDlnTx } = dln;

const OWN_EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OWN_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_EVM = "0x1111111111111111111111111111111111111111";
const OTHER_SOL = "So11111111111111111111111111111111111111112";

// ---------------------------------------------------------------- the cases: one per real fixture

const stable = (chain, symbol) => {
  const s = chains.stableBySymbol(chain, symbol);
  return { address: s.address ?? s.mint, native: false, decimals: s.decimals, symbol };
};
const native = (chain, address = chains.NATIVE_PLACEHOLDER) => ({ address, native: true, decimals: chains.getChain(chain).native.decimals, symbol: chains.getChain(chain).native.symbol });

const CASES = [
  { file: "base-usdc-to-arbitrum-usdc", chain: "base", chainOut: "arbitrum", tokenIn: stable("base", "USDC"), tokenOut: stable("arbitrum", "USDC") },
  { file: "base-eth-to-arbitrum-usdc", chain: "base", chainOut: "arbitrum", tokenIn: native("base"), tokenOut: stable("arbitrum", "USDC") },
  { file: "base-usdc-to-arbitrum-eth", chain: "base", chainOut: "arbitrum", tokenIn: stable("base", "USDC"), tokenOut: native("arbitrum") },
  { file: "polygon-usdc-to-base-usdc", chain: "polygon", chainOut: "base", tokenIn: stable("polygon", "USDC"), tokenOut: stable("base", "USDC") },
  { file: "arbitrum-usdc-to-bnb-usdt", chain: "arbitrum", chainOut: "bnb", tokenIn: stable("arbitrum", "USDC"), tokenOut: stable("bnb", "USDT") },
  { file: "base-usdc-to-solana-usdc", chain: "base", chainOut: "solana", tokenIn: stable("base", "USDC"), tokenOut: stable("solana", "USDC") },
  { file: "base-usdc-to-solana-sol", chain: "base", chainOut: "solana", tokenIn: stable("base", "USDC"), tokenOut: native("solana", DEBRIDGE_NATIVE_SOLANA) },
];

const ownOn = (chainKey) => (chainKey === "solana" ? OWN_SOL : OWN_EVM);
const hubName = (chainKey) => (chainKey === "solana" ? "Solana" : chains.evmChain(chainKey).hubName);
const NATIVE_MARKERS = [DEBRIDGE_NATIVE_EVM, chains.NATIVE_PLACEHOLDER];

/** The intent the kit would hold for a case, and the signed Sato Hub answer built around the fixture's real transaction. */
function build(c) {
  const fx = fixture(c.file);
  const decoded = decodeCreateSaltedOrder(fx.tx.data);
  const intent = { chain: c.chain, chainOut: c.chainOut, tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: BigInt(fx.request.srcChainTokenInAmount), taker: OWN_EVM, recipient: ownOn(c.chainOut) };
  const response = {
    mode: "build-tx",
    venue: "debridge",
    chain: hubName(c.chain),
    chain_out: hubName(c.chainOut),
    recipient: intent.recipient,
    token_in: c.tokenIn.native ? DEBRIDGE_NATIVE_EVM : c.tokenIn.address,
    token_out: c.tokenOut.native ? (c.chainOut === "solana" ? DEBRIDGE_NATIVE_SOLANA : DEBRIDGE_NATIVE_EVM) : c.tokenOut.address,
    amount_in: intent.amountIn.toString(),
    amount_out: decoded.order.takeAmount.toString(),
    sato_fee_bps: 25,
    sato_fee_recipient: SATO_FEE_RECIPIENT,
    sato_fee_tier: "cross_chain",
    tx: { to: fx.tx.to, data: fx.tx.data, value: fx.tx.value, approval_target: fx.tx.to },
    bridge: { protocol: "debridge-dln", order_id: fx.orderId, fix_fee_wei: fx.fixFee, take_amount: decoded.order.takeAmount.toString(), allowed_taker_dst: decoded.order.allowedTakerDst },
  };
  return { fx, decoded, intent, response, fixFeeWei: BigInt(fx.fixFee) };
}

const clone = (o) => structuredClone(o);

/** Re-encode a case's calldata after `edit(order, args)` changed a field of the decoded call (a deep copy). */
function retx(b, edit) {
  const { args } = decodeFunctionData({ abi: ABI, data: b.fx.tx.data });
  const a = [{ ...args[0] }, ...args.slice(1)];
  edit(a[0], a);
  return encodeFunctionData({ abi: ABI, functionName: "createSaltedOrder", args: a });
}
/** A tampered copy of a case's response: `edit(response)` may change the answer; `data` swaps the calldata. */
function tampered(b, { data, edit } = {}) {
  const response = clone(b.response);
  if (data) response.tx.data = data;
  edit?.(response);
  return response;
}
const rulesOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Refused, `a Refused, got ${e?.stack ?? e}`);
    return e.refusals.map((r) => r.rule);
  }
  return [];
};
const verify = (b, response = b.response, extra = {}) => verifyDlnTx({ response, intent: b.intent, fixFeeWei: b.fixFeeWei, ...extra });
const refuses = (b, rule, response, intent) => {
  const got = rulesOf(() => verifyDlnTx({ response, intent: intent ?? b.intent, fixFeeWei: b.fixFeeWei }));
  assert.ok(got.includes(rule), `expected ${rule}, got [${got.join(", ")}]`);
  return got;
};
const base = () => build(CASES[0]);

// ---------------------------------------------------------------- registry

test("the registry: DlnSource on every EVM chain, supported as a source on Base, Arbitrum and Polygon, deBridge's chain ids", () => {
  assert.equal(DLN_SOURCE, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66");
  assert.equal(CREATE_SALTED_ORDER_SELECTOR, "0xb9303701");
  for (const k of ["base", "arbitrum", "polygon"]) assert.equal(chains.dlnSourceOf(k), DLN_SOURCE, k);
  for (const k of ["bnb", "solana", "nowhere"]) assert.equal(chains.dlnSourceOf(k), null, k);
  assert.equal(chains.evmChain("bnb").dln.source, DLN_SOURCE, "BNB Chain has the address; the kit does not bridge from it");
  assert.equal(chains.evmChain("bnb").dln.sourceSupported, false);
  for (const k of chains.evmChainKeys()) assert.equal(chains.debridgeChainIdOf(k), chains.evmChain(k).chainId, k);
  assert.equal(chains.debridgeChainIdOf("solana"), 7565164);
  assert.throws(() => chains.debridgeChainIdOf("nowhere"));
  assert.equal(BRIDGE_FEE_CEILING_BPS, 25);
});

test("fee tier: cross_chain is a ceiling and a display tier; a swap can never claim it", () => {
  assert.equal(F.TIER_CEILING_BPS.cross_chain, 25);
  assert.equal(F.PUBLISHED_FEE_BPS.cross_chain, 25);
  assert.equal(F.feeText(25, "cross_chain"), "0.25% (25 bps, cross-chain)");
  assert.ok(!F.FEE_TIERS.includes("cross_chain"));
  assert.equal(F.BRIDGE_FEE_TIER, "cross_chain");
  for (const tier of ["stable", "major", "token"]) {
    const got = F.feeTierRefusals({ bps: 3, tier, disclosedTier: "cross_chain" });
    assert.deepEqual(got.map((r) => r.rule), ["fee_tier_mismatch"], `a ${tier} swap that claims cross_chain is refused`);
  }
});

// ---------------------------------------------------------------- addresses

test("encodeDestAddress: 20 bytes for EVM, the 32 base58-decoded bytes for Solana, and a round trip", () => {
  assert.equal(encodeDestAddress("base", OWN_EVM), OWN_EVM.toLowerCase());
  assert.equal(encodeDestAddress("bnb", OWN_EVM.toLowerCase()), OWN_EVM.toLowerCase());
  const hex = encodeDestAddress("solana", OWN_SOL);
  assert.match(hex, /^0x[0-9a-f]{64}$/);
  assert.equal(getAddressDecoder().decode(Buffer.from(hex.slice(2), "hex")), OWN_SOL);
  assert.equal(encodeDestAddress("solana", DEBRIDGE_NATIVE_SOLANA), `0x${"00".repeat(32)}`);
  assert.equal(encodeDestAddress("base", DEBRIDGE_NATIVE_EVM), `0x${"00".repeat(20)}`);
  // the Solana USDC mint is what the fixture's take token holds
  assert.equal(encodeDestAddress("solana", chains.stableBySymbol("solana", "USDC").mint), decodeCreateSaltedOrder(fixture("base-usdc-to-solana-usdc").tx.data).order.takeTokenAddress);
  assert.throws(() => encodeDestAddress("solana", OWN_EVM), /not a Solana address/);
  assert.throws(() => encodeDestAddress("solana", "not base58 !"), /not a Solana address/);
  assert.throws(() => encodeDestAddress("base", OWN_SOL), /not an EVM address/);
  assert.throws(() => encodeDestAddress("base", undefined), /not an EVM address/);
  assert.throws(() => encodeDestAddress("nowhere", OWN_EVM), /not a chain/);
});

// ---------------------------------------------------------------- decoding

test("every fixture decodes: the selector, the order fields and the 52-byte fee", () => {
  for (const c of CASES) {
    const fx = fixture(c.file);
    assert.equal(fx.tx.data.slice(0, 10), CREATE_SALTED_ORDER_SELECTOR, c.file);
    const d = decodeCreateSaltedOrder(fx.tx.data);
    assert.equal(d.order.giveAmount, BigInt(fx.request.srcChainTokenInAmount), c.file);
    assert.equal(d.order.takeChainId, BigInt(chains.debridgeChainIdOf(c.chainOut)), c.file);
    assert.equal(d.order.externalCall, "0x");
    assert.equal(d.order.allowedCancelBeneficiarySrc, "0x");
    assert.equal(d.permitEnvelope, "0x");
    assert.equal(d.referralCode, 0);
    assert.equal(d.affiliateFee.recipient, SATO_FEE_RECIPIENT.toLowerCase());
    assert.equal(d.affiliateFee.amount, (d.order.giveAmount * 25n) / 10_000n, `${c.file}: the fee is 25 bps of the amount given, exactly`);
    assert.equal(typeof d.salt, "bigint");
    assert.equal(d.order.receiverDst, encodeDestAddress(c.chainOut, ownOn(c.chainOut)));
  }
  // the one known number: 5 USDC at 25 bps is 12,500 base units
  assert.equal(decodeCreateSaltedOrder(fixture("base-usdc-to-arbitrum-usdc").tx.data).affiliateFee.amount, 12_500n);
});

test("a fee-less order decodes to affiliateFee null", () => {
  const b = base();
  const data = retx(b, (o, a) => (a[2] = "0x"));
  assert.equal(decodeCreateSaltedOrder(data).affiliateFee, null);
});

test("bridge_calldata_unreadable: not hex, too short, truncated, trailing bytes, a fee field of the wrong length", () => {
  const b = base();
  const good = b.fx.tx.data;
  for (const [what, data] of [
    ["not a string", undefined],
    ["not hex", "0xb93037zz"],
    ["only the selector", CREATE_SALTED_ORDER_SELECTOR],
    ["truncated", good.slice(0, good.length - 130)],
    ["trailing bytes", `${good}00`],
    ["a 20-byte fee field", retx(b, (o, a) => (a[2] = SATO_FEE_RECIPIENT.toLowerCase()))],
  ]) {
    assert.throws(() => decodeCreateSaltedOrder(data), (e) => e instanceof Refused && e.refusals[0].rule === "bridge_calldata_unreadable", what);
  }
  // and through the verifier
  for (const data of [good.slice(0, good.length - 130), `${good}00`, retx(b, (o, a) => (a[2] = SATO_FEE_RECIPIENT.toLowerCase()))]) refuses(b, "bridge_calldata_unreadable", tampered(b, { data }));
});

// ---------------------------------------------------------------- the real orders pass

for (const c of CASES) {
  test(`fixture ${c.file}: passes, with the facts a caller needs`, () => {
    const b = build(c);
    const facts = verify(b);
    assert.equal(facts.giveAmount, b.intent.amountIn);
    assert.equal(facts.takeAmount, b.decoded.order.takeAmount);
    assert.equal(facts.fixFeeWei, b.fixFeeWei);
    assert.equal(facts.value, BigInt(b.fx.tx.value));
    assert.equal(facts.value, b.fixFeeWei + (c.tokenIn.native ? b.intent.amountIn : 0n));
    assert.equal(facts.feeBps, 25);
    assert.equal(facts.feeAmount, 12_500n * (c.tokenIn.native ? 400_000_000n : 1n));
    assert.equal(facts.approvalSpender, DLN_SOURCE);
    assert.equal(facts.orderIdHint, b.fx.orderId);
    assert.equal(facts.allowedTakerDst, b.decoded.order.allowedTakerDst);
    assert.equal(facts.order.receiverDst, encodeDestAddress(c.chainOut, ownOn(c.chainOut)));
    assert.deepEqual(Object.keys(facts).sort(), ["allowedTakerDst", "approvalSpender", "feeAmount", "feeBps", "fixFeeWei", "giveAmount", "order", "orderIdHint", "takeAmount", "value"]);
  });
}

test("the signed answer may omit the optional parts: no bridge block, no tier, no approval target, tx.value as a number", () => {
  const b = base();
  const r = tampered(b, { edit: (x) => { delete x.bridge; delete x.sato_fee_tier; delete x.tx.approval_target; x.tx.value = Number(x.tx.value); } });
  assert.equal(verify(b, r).orderIdHint, null);
});

test("native is accepted as the zero address or the 0xEeee placeholder in the answer; the calldata must say zero", () => {
  const eth = build(CASES[1]);
  for (const marker of NATIVE_MARKERS) assert.ok(verify(eth, tampered(eth, { edit: (r) => (r.token_in = marker) })));
  const out = build(CASES[2]);
  for (const marker of NATIVE_MARKERS) assert.ok(verify(out, tampered(out, { edit: (r) => (r.token_out = marker) })));
  // the placeholder is not what the order may carry
  refuses(eth, "bridge_give_mismatch", tampered(eth, { data: retx(eth, (o) => (o.giveTokenAddress = chains.NATIVE_PLACEHOLDER)) }));
  refuses(out, "bridge_take_mismatch", tampered(out, { data: retx(out, (o) => (o.takeTokenAddress = chains.NATIVE_PLACEHOLDER.toLowerCase())) }));
  // a Solana native out: the system program, 32 zero bytes
  const sol = build(CASES[6]);
  assert.ok(verify(sol, tampered(sol, { edit: (r) => (r.token_out = DEBRIDGE_NATIVE_EVM) })));
  refuses(sol, "bridge_take_mismatch", tampered(sol, { data: retx(sol, (o) => (o.takeTokenAddress = `0x${"00".repeat(20)}`)) }));
});

test("address comparisons ignore letter case for EVM; the chain may be named by Sato Hub's display name or the kit's key", () => {
  const b = base();
  const r = tampered(b, { edit: (x) => { x.tx.to = x.tx.to.toLowerCase(); x.token_in = x.token_in.toLowerCase(); x.token_out = x.token_out.toUpperCase().replace(/^0X/, "0x"); x.recipient = x.recipient.toLowerCase(); x.sato_fee_recipient = x.sato_fee_recipient.toLowerCase(); x.chain = "base"; x.chain_out = "ARBITRUM"; } });
  assert.ok(verify(b, r));
  const bnb = build(CASES[4]);
  assert.ok(verify(bnb, tampered(bnb, { edit: (x) => (x.chain_out = "bnb") })), "the kit's key");
  assert.equal(bnb.response.chain_out, "BNB Chain");
  assert.ok(verify(bnb), "Sato Hub's display name");
});

// ---------------------------------------------------------------- bridge_source_unsupported

test("bridge_source_unsupported: BNB Chain and Solana as the source, and a chain the kit does not know", () => {
  const b = base();
  for (const [chain, words] of [["bnb", /BNB Chain.*contract this kit does not read yet/], ["solana", /Solana transactions yet/], ["nowhere", /does not know that chain/]]) {
    assert.throws(
      () => verify(b, b.response, { intent: { ...b.intent, chain } }),
      (e) => e instanceof Refused && e.refusals.length === 1 && e.refusals[0].rule === "bridge_source_unsupported" && words.test(e.message) && /nothing was signed/.test(e.message),
      chain,
    );
  }
  assert.ok(!rulesOf(() => verify(b)).length);
});

// ---------------------------------------------------------------- bridge_wrong_contract

test("bridge_wrong_contract: the BNB Chain forwarder fixture, another contract, and another approval target", () => {
  const f = fixture("bnb-bnb-to-base-usdc-FORWARDER");
  assert.equal(f.tx.data.slice(0, 10), "0x4d8160ba");
  assert.notEqual(f.tx.to.toLowerCase(), DLN_SOURCE.toLowerCase());
  // as the kit would meet it from Base (the BNB source itself is refused first, as bridge_source_unsupported)
  const b = base();
  const forwarded = tampered(b, { edit: (r) => (r.tx = { to: f.tx.to, data: f.tx.data, value: f.tx.value }) });
  assert.deepEqual(rulesOf(() => verify(b, forwarded)).filter((r) => r.startsWith("bridge_")), ["bridge_wrong_contract"]);
  refuses(b, "bridge_wrong_contract", tampered(b, { edit: (r) => (r.tx.to = OTHER_EVM) }));
  refuses(b, "bridge_wrong_contract", tampered(b, { edit: (r) => (r.tx.approval_target = OTHER_EVM) }));
  // the same address on another chain's pin is still this chain's DlnSource (one address on every chain)
  assert.ok(verify(b, tampered(b, { edit: (r) => (r.tx.to = DLN_SOURCE.toLowerCase()) })));
});

// ---------------------------------------------------------------- bridge_wrong_function

test("bridge_wrong_function: another selector on the right contract (and none)", () => {
  const b = base();
  refuses(b, "bridge_wrong_function", tampered(b, { data: `0x4d8160ba${b.fx.tx.data.slice(10)}` }));
  refuses(b, "bridge_wrong_function", tampered(b, { data: "0x" }));
  refuses(b, "bridge_wrong_function", tampered(b, { edit: (r) => delete r.tx.data }));
});

// ---------------------------------------------------------------- response_mismatch

test("response_mismatch: mode, venue, either chain, either token, the amount, the recipient, no transaction, another chain id", () => {
  const b = base();
  const edits = {
    mode: (r) => (r.mode = "quote"),
    venue: (r) => (r.venue = "kyberswap"),
    chain: (r) => (r.chain = "Arbitrum"),
    chain_out: (r) => (r.chain_out = "Polygon"),
    token_in: (r) => (r.token_in = OTHER_EVM),
    token_out: (r) => (r.token_out = OTHER_EVM),
    amount_in: (r) => (r.amount_in = "5000001"),
    recipient: (r) => (r.recipient = OTHER_EVM),
    tx_chain_id: (r) => (r.tx.chain_id = 1),
  };
  for (const [what, edit] of Object.entries(edits)) refuses(b, "response_mismatch", tampered(b, { edit }));
  const none = tampered(b, { edit: (r) => { delete r.tx; r.withheld = { rule: "gate", reason: "no" }; } });
  assert.deepEqual(rulesOf(() => verify(b, none)), ["response_mismatch"]);
  assert.throws(() => verify(b, null), Refused);
  // native: a response that names a token for a native intent
  const eth = build(CASES[1]);
  refuses(eth, "response_mismatch", tampered(eth, { edit: (r) => (r.token_in = eth.intent.tokenIn.address.replace(/E/g, "D")) }));
  // an intent that asks for a bridge to the same chain, or without an amount, is refused too
  refuses(b, "response_mismatch", b.response, { ...b.intent, chainOut: "base", recipient: OWN_EVM });
  refuses(b, "response_mismatch", b.response, { ...b.intent, amountIn: 0n });
  refuses(b, "response_mismatch", b.response, { ...b.intent, recipient: OWN_SOL });
});

test("Solana destination: the recipient is compared exactly (base58 has no case to ignore) and must be a Solana address", () => {
  const b = build(CASES[5]);
  refuses(b, "response_mismatch", tampered(b, { edit: (r) => (r.recipient = r.recipient.toLowerCase()) }));
  refuses(b, "response_mismatch", tampered(b, { edit: (r) => (r.recipient = OTHER_SOL) }));
  refuses(b, "response_mismatch", tampered(b, { edit: (r) => (r.token_out = OTHER_SOL) }));
});

// ---------------------------------------------------------------- bridge_give_mismatch

test("bridge_give_mismatch: another token given, another amount given", () => {
  const b = base();
  refuses(b, "bridge_give_mismatch", tampered(b, { data: retx(b, (o) => (o.giveTokenAddress = OTHER_EVM)) }));
  refuses(b, "bridge_give_mismatch", tampered(b, { data: retx(b, (o) => (o.giveAmount += 1n)) }));
  // a native intent whose order gives an ERC-20
  const eth = build(CASES[1]);
  refuses(eth, "bridge_give_mismatch", tampered(eth, { data: retx(eth, (o) => (o.giveTokenAddress = b.intent.tokenIn.address)) }));
});

// ---------------------------------------------------------------- bridge_take_mismatch

test("bridge_take_mismatch: another chain, another token, another amount than the order, and Sato Hub's two figures disagreeing", () => {
  const b = base();
  refuses(b, "bridge_take_mismatch", tampered(b, { data: retx(b, (o) => (o.takeChainId = 137n)) }));
  refuses(b, "bridge_take_mismatch", tampered(b, { data: retx(b, (o) => (o.takeTokenAddress = OTHER_EVM)) }));
  refuses(b, "bridge_take_mismatch", tampered(b, { data: retx(b, (o) => (o.takeAmount -= 1n)) }));
  refuses(b, "bridge_take_mismatch", tampered(b, { edit: (r) => (r.amount_out = (BigInt(r.amount_out) + 1n).toString()) }));
  refuses(b, "bridge_take_mismatch", tampered(b, { edit: (r) => delete r.amount_out }));
  refuses(b, "bridge_take_mismatch", tampered(b, { edit: (r) => (r.bridge.take_amount = "1") }));
  // an order that takes a 20-byte token on Solana's chain id, or Solana's id for an EVM destination
  const s = build(CASES[5]);
  refuses(s, "bridge_take_mismatch", tampered(s, { data: retx(s, (o) => (o.takeChainId = 42161n)) }));
  refuses(s, "bridge_take_mismatch", tampered(s, { data: retx(s, (o) => (o.takeTokenAddress = OTHER_EVM)) }));
  refuses(b, "bridge_take_mismatch", tampered(b, { data: retx(b, (o) => (o.takeChainId = 7565164n)) }));
});

// ---------------------------------------------------------------- bridge_recipient_not_own

test("bridge_recipient_not_own: the receiver, or the order authority that may cancel, is not the bot's own address", () => {
  for (const c of [CASES[0], CASES[5]]) {
    const b = build(c);
    const other = encodeDestAddress(c.chainOut, c.chainOut === "solana" ? OTHER_SOL : OTHER_EVM);
    refuses(b, "bridge_recipient_not_own", tampered(b, { data: retx(b, (o) => (o.receiverDst = other)) }));
    refuses(b, "bridge_recipient_not_own", tampered(b, { data: retx(b, (o) => (o.orderAuthorityAddressDst = other)) }));
  }
  // the right Solana key in 20 bytes, or an EVM address for a Solana destination
  const s = build(CASES[5]);
  refuses(s, "bridge_recipient_not_own", tampered(s, { data: retx(s, (o) => (o.receiverDst = OWN_EVM.toLowerCase())) }));
  // the intent's own address is what counts, not the response's
  const b = base();
  refuses(b, "bridge_recipient_not_own", b.response, { ...b.intent, recipient: OTHER_EVM });
});

// ---------------------------------------------------------------- bridge_patch_authority_not_own, bridge_cancel_beneficiary

test("bridge_patch_authority_not_own: another address may change the order on the source chain", () => {
  const b = base();
  refuses(b, "bridge_patch_authority_not_own", tampered(b, { data: retx(b, (o) => (o.givePatchAuthoritySrc = OTHER_EVM)) }));
  refuses(b, "bridge_patch_authority_not_own", b.response, { ...b.intent, taker: OTHER_EVM });
});

test("bridge_cancel_beneficiary: a cancel may refund nobody but the bot (empty or its own address is fine)", () => {
  const b = base();
  refuses(b, "bridge_cancel_beneficiary", tampered(b, { data: retx(b, (o) => (o.allowedCancelBeneficiarySrc = OTHER_EVM.toLowerCase())) }));
  refuses(b, "bridge_cancel_beneficiary", tampered(b, { data: retx(b, (o) => (o.allowedCancelBeneficiarySrc = `0x${"ab".repeat(32)}`)) }));
  assert.ok(verify(b, tampered(b, { data: retx(b, (o) => (o.allowedCancelBeneficiarySrc = OWN_EVM.toLowerCase())) })));
});

// ---------------------------------------------------------------- bridge_external_call, bridge_permit_present

test("bridge_external_call: an order that runs a call on the destination is refused", () => {
  const b = base();
  refuses(b, "bridge_external_call", tampered(b, { data: retx(b, (o) => (o.externalCall = "0x01")) }));
});

test("bridge_permit_present: a permit envelope is refused", () => {
  const b = base();
  refuses(b, "bridge_permit_present", tampered(b, { data: retx(b, (o, a) => (a[4] = "0xdeadbeef")) }));
});

// ---------------------------------------------------------------- bridge_value_mismatch

test("bridge_value_mismatch: the native value must be the fixed fee (plus the amount sent, for a native give)", () => {
  const b = base();
  refuses(b, "bridge_value_mismatch", tampered(b, { edit: (r) => (r.tx.value = "1000000000000001") }));
  refuses(b, "bridge_value_mismatch", tampered(b, { edit: (r) => (r.tx.value = "0") }));
  refuses(b, "bridge_value_mismatch", tampered(b, { edit: (r) => delete r.tx.value }));
  refuses(b, "bridge_value_mismatch", tampered(b, { edit: (r) => (r.tx.value = "0x38d7ea4c68000") }));
  // the caller's onchain read decides, not the response
  assert.deepEqual(rulesOf(() => verify(b, b.response, { fixFeeWei: 2_000_000_000_000_000n })), ["bridge_value_mismatch"]);
  // a native give sends the amount on top of the fee, and not twice
  const eth = build(CASES[1]);
  assert.equal(eth.response.tx.value, "3000000000000000");
  refuses(eth, "bridge_value_mismatch", tampered(eth, { edit: (r) => (r.tx.value = "1000000000000000") }));
  refuses(eth, "bridge_value_mismatch", tampered(eth, { edit: (r) => (r.tx.value = "5000000000000000") }));
  // a non-numeric fee from the caller is not guessed at
  assert.throws(() => verifyDlnTx({ response: b.response, intent: b.intent, fixFeeWei: "1000000000000000" }), (e) => e instanceof Refused);
});

// ---------------------------------------------------------------- the fee

test("fee_over_ceiling: 26 bps is refused, 25 is accepted, whatever the calldata", () => {
  const b = base();
  // Sato Hub says 26 and the order carries exactly 26 bps
  const fee26 = (13_000n).toString(16).padStart(64, "0");
  const data26 = retx(b, (o, a) => (a[2] = `${SATO_FEE_RECIPIENT.toLowerCase()}${fee26}`));
  const got = refuses(b, "fee_over_ceiling", tampered(b, { data: data26, edit: (r) => (r.sato_fee_bps = 26) }));
  assert.ok(!got.includes("fee_amount_mismatch"), "a consistent 26 bps is over the ceiling, not a mismatch");
  // Sato Hub says 25 but the order takes more
  const over = refuses(b, "fee_over_ceiling", tampered(b, { data: data26 }));
  assert.ok(over.includes("fee_amount_mismatch"));
  // 26 bps disclosed with a 25-bps order
  refuses(b, "fee_over_ceiling", tampered(b, { edit: (r) => (r.sato_fee_bps = 26) }));
  assert.ok(verify(b, tampered(b, { edit: (r) => (r.sato_fee_bps = 25) })));
  // one base unit of rounding either way is allowed, two are not
  const at = (units) => tampered(b, { data: retx(b, (o, a) => (a[2] = `${SATO_FEE_RECIPIENT.toLowerCase()}${units.toString(16).padStart(64, "0")}`)) });
  for (const u of [12_499n, 12_500n, 12_501n]) assert.ok(verify(b, at(u)), String(u));
  refuses(b, "fee_amount_mismatch", at(12_498n));
  refuses(b, "fee_over_ceiling", at(12_502n));
});

test("fee_recipient_mismatch: the order's fee address, or the address Sato Hub names, is not the Sato fee address", () => {
  const b = base();
  refuses(b, "fee_recipient_mismatch", tampered(b, { data: retx(b, (o, a) => (a[2] = `${OTHER_EVM}${(12_500n).toString(16).padStart(64, "0")}`)) }));
  refuses(b, "fee_recipient_mismatch", tampered(b, { edit: (r) => (r.sato_fee_recipient = OTHER_EVM) }));
});

test("fee_amount_mismatch: the fee in the order is not the fee Sato Hub disclosed", () => {
  const b = base();
  const withFee = (units) => retx(b, (o, a) => (a[2] = `${SATO_FEE_RECIPIENT.toLowerCase()}${units.toString(16).padStart(64, "0")}`));
  refuses(b, "fee_amount_mismatch", tampered(b, { data: withFee(12_000n) }));
  refuses(b, "fee_amount_mismatch", tampered(b, { data: withFee(0n) }));
  refuses(b, "fee_amount_mismatch", tampered(b, { edit: (r) => (r.sato_fee_bps = 10) }), undefined);
  // an order that carries no fee while Sato Hub says it takes one
  refuses(b, "fee_amount_mismatch", tampered(b, { data: retx(b, (o, a) => (a[2] = "0x")) }));
  // no stated rate is not guessed at
  for (const bad of [undefined, null, "25", 25.5, -1]) refuses(b, "fee_amount_mismatch", tampered(b, { edit: (r) => (r.sato_fee_bps = bad) }));
  // an order with no fee, disclosed as no fee, is allowed
  const free = tampered(b, { data: retx(b, (o, a) => (a[2] = "0x")), edit: (r) => (r.sato_fee_bps = 0) });
  const facts = verify(b, free);
  assert.equal(facts.feeAmount, 0n);
  assert.equal(facts.feeBps, 0);
});

test("fee_tier_mismatch: a tier other than cross_chain is refused; no tier is read as cross_chain", () => {
  const b = base();
  for (const tier of ["major", "stable", "token", "x"]) refuses(b, "fee_tier_mismatch", tampered(b, { edit: (r) => (r.sato_fee_tier = tier) }));
  assert.ok(verify(b, tampered(b, { edit: (r) => delete r.sato_fee_tier })));
  assert.ok(verify(b, tampered(b, { edit: (r) => (r.sato_fee_tier = null) })));
});

// ---------------------------------------------------------------- messages

test("every refusal says what happened in plain words, ends with 'nothing was signed', and avoids the words the kit never uses", () => {
  const b = base();
  const bads = [
    tampered(b, { edit: (r) => { r.mode = "quote"; r.venue = "x"; r.recipient = OTHER_EVM; r.sato_fee_bps = 99; r.sato_fee_tier = "major"; r.sato_fee_recipient = OTHER_EVM; r.tx.value = "1"; } }),
    tampered(b, { data: retx(b, (o, a) => { o.giveTokenAddress = OTHER_EVM; o.giveAmount += 1n; o.takeChainId = 1n; o.takeTokenAddress = OTHER_EVM; o.takeAmount += 1n; o.receiverDst = OTHER_EVM; o.orderAuthorityAddressDst = OTHER_EVM; o.givePatchAuthoritySrc = OTHER_EVM; o.allowedCancelBeneficiarySrc = OTHER_EVM; o.externalCall = "0x01"; a[4] = "0x01"; }) }),
    tampered(b, { edit: (r) => (r.tx.to = OTHER_EVM) }),
    tampered(b, { data: "0x12345678" }),
    tampered(b, { data: `${b.fx.tx.data}00` }),
  ];
  const seen = new Set();
  for (const r of bads) {
    try {
      verify(b, r);
      assert.fail("expected a refusal");
    } catch (e) {
      assert.ok(e instanceof Refused);
      for (const x of e.refusals) {
        seen.add(x.rule);
        assert.match(x.message, /; nothing was signed$/, x.rule);
        assert.doesNotMatch(x.message, /\b(safe|secure|trusted|verified|guaranteed|only|first)\b/i, x.message);
        assert.ok(x.message.length < 260, x.rule);
      }
    }
  }
  for (const rule of ["bridge_calldata_unreadable", "bridge_wrong_contract", "bridge_wrong_function", "response_mismatch", "bridge_give_mismatch", "bridge_take_mismatch", "bridge_recipient_not_own", "bridge_patch_authority_not_own", "bridge_cancel_beneficiary", "bridge_external_call", "bridge_permit_present", "bridge_value_mismatch", "fee_over_ceiling", "fee_recipient_mismatch", "fee_tier_mismatch"]) assert.ok(seen.has(rule), `${rule} was exercised`);
});

test("verifyDlnTx does not touch the network", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  try {
    for (const c of CASES) assert.ok(verify(build(c)));
  } finally {
    globalThis.fetch = realFetch;
  }
});
