// deBridge DLN, source side: the order Sato Hub builds for a bridge, read again by the kit before anything is signed.
//
// A DLN order is created by ONE call on the DlnSource contract, `createSaltedOrder(order, salt, affiliateFee, referralCode,
// permitEnvelope, metadata)` (selector 0xb9303701), and a solver later fills it on the other chain for exactly `takeAmount`.
// Sato Hub builds the transaction; this module decodes its calldata and checks every field that decides where the money goes:
//
//   - the transaction goes to the DlnSource of the source chain, and nowhere else (the BNB Chain forwarder is refused here);
//   - the order gives the token and amount asked for, takes the token asked for on the chain asked for, for the amount Sato Hub
//     quoted, and delivers to the bot's OWN address on the destination (receiver and the order authority that may cancel it);
//   - nothing else rides along: no external call, no permit, no other cancel beneficiary, no other patch authority;
//   - the native value sent is the protocol's fixed fee (read onchain by the caller) plus the amount given when that is the native coin;
//   - the Sato Hub fee is paid to the Sato fee address, at most 25 bps, and equals what Sato Hub disclosed.
//
// Pure: no network. The caller reads `globalFixedNativeFee()` from the source chain and passes it in. A refusal is a `Refused`
// with a plain sentence for the owner that ends with "nothing was signed".

import { decodeFunctionData, encodeFunctionData, isAddress, zeroAddress } from "viem";
import { getAddressEncoder } from "@solana/kit";
import { Refused } from "../errors.js";
import { NATIVE_PLACEHOLDER, debridgeChainIdOf, dlnSourceOf, evmChain, isEvm, isKnownChain, isSolana, labelOf } from "../chains.js";
import { SATO_FEE_RECIPIENT } from "../swap/evm.js";
import { BRIDGE_FEE_TIER, TIER_CEILING_BPS, feePercent } from "../swap/fee-tier.js";

/** The DlnSource proxy: one address on Base, Arbitrum, Polygon and BNB Chain (the registry's pin, src/chains.js). */
export const DLN_SOURCE = evmChain("base").dln.source;
/** `createSaltedOrder`, the one function this kit accepts. */
export const CREATE_SALTED_ORDER_SELECTOR = "0xb9303701";
/** A bridge fee above this is refused, whatever Sato Hub discloses. */
export const BRIDGE_FEE_CEILING_BPS = TIER_CEILING_BPS[BRIDGE_FEE_TIER];
/** How deBridge writes a chain's native coin on an EVM chain (the 0xEeee... placeholder is not accepted by its API)... */
export const DEBRIDGE_NATIVE_EVM = zeroAddress;
/** ...and on Solana: the system program's address, 32 zero bytes. */
export const DEBRIDGE_NATIVE_SOLANA = "11111111111111111111111111111111";

/** The order's shape, as published on Sourcify (DlnSource implementation, exact match). Only this function is embedded. */
const DLN_SOURCE_ABI = [
  {
    type: "function",
    name: "createSaltedOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "_orderCreation",
        type: "tuple",
        components: [
          { name: "giveTokenAddress", type: "address" },
          { name: "giveAmount", type: "uint256" },
          { name: "takeTokenAddress", type: "bytes" },
          { name: "takeAmount", type: "uint256" },
          { name: "takeChainId", type: "uint256" },
          { name: "receiverDst", type: "bytes" },
          { name: "givePatchAuthoritySrc", type: "address" },
          { name: "orderAuthorityAddressDst", type: "bytes" },
          { name: "allowedTakerDst", type: "bytes" },
          { name: "externalCall", type: "bytes" },
          { name: "allowedCancelBeneficiarySrc", type: "bytes" },
        ],
      },
      { name: "_salt", type: "uint64" },
      { name: "_affiliateFee", type: "bytes" },
      { name: "_referralCode", type: "uint32" },
      { name: "_permitEnvelope", type: "bytes" },
      { name: "_metadata", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

const lc = (s) => String(s).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);
const refusal = (rule, message, limit = null, observed = null) => ({ rule, limit, observed, message });
const isHex = (s) => typeof s === "string" && /^0x([0-9a-fA-F]{2})*$/.test(s);
const NOTHING = "nothing was signed";
const clip = (v, n = 80) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** A non-negative integer from a number, a digit string or a bigint; null for anything else (a hex string, a fraction, a negative). */
function uintOf(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
  return null;
}

// ---------------------------------------------------------------- addresses as deBridge writes them

/**
 * An address as the `bytes` field of an order: an EVM address is 20 bytes, a Solana address (a wallet or a mint) is the 32 bytes
 * it base58-decodes to. Returns lower-case 0x hex. Throws on an address that is not one for that chain.
 */
export function encodeDestAddress(chainKey, address) {
  if (isEvm(chainKey)) {
    if (typeof address !== "string" || !isAddress(address, { strict: false })) throw new Error(`"${clip(address, 50)}" is not an EVM address`);
    return lc(address);
  }
  if (isSolana(chainKey)) {
    let bytes;
    try {
      bytes = getAddressEncoder().encode(address);
    } catch {
      throw new Error(`"${clip(address, 50)}" is not a Solana address`);
    }
    return `0x${Buffer.from(bytes).toString("hex")}`;
  }
  throw new Error(`"${clip(chainKey, 40)}" is not a chain the kit bridges to`);
}

// ---------------------------------------------------------------- decoding

/**
 * Read the calldata of `createSaltedOrder`. Anything that is another function, does not decode, or does not re-encode to the very
 * same bytes (so this reader and the contract could read it differently, or bytes trail the call) is refused whole.
 * Returns the order with bigints and lower-case hex for every `bytes` field, the 52-byte affiliate fee split into
 * { recipient, amount } (null when the order has none), and the rest as the contract reads it.
 */
export function decodeCreateSaltedOrder(data) {
  const unreadable = (why) => new Refused([refusal("bridge_calldata_unreadable", `the bridge order cannot be read (${why}), so this kit will not sign it; ${NOTHING}`, CREATE_SALTED_ORDER_SELECTOR, clip(data, 10))]);
  if (!isHex(data) || data.length < 10) throw unreadable("it is not call data");
  let args;
  try {
    ({ args } = decodeFunctionData({ abi: DLN_SOURCE_ABI, data }));
    const again = encodeFunctionData({ abi: DLN_SOURCE_ABI, functionName: "createSaltedOrder", args });
    if (lc(again) !== lc(data)) throw unreadable("its encoding is not the standard one");
  } catch (err) {
    if (err instanceof Refused) throw err;
    throw unreadable("it does not decode as the order call");
  }
  const [o, salt, affiliate, referralCode, permitEnvelope, metadata] = args;
  let affiliateFee = null;
  if (affiliate !== "0x") {
    // abi.encodePacked(address recipient, uint256 amount)
    if (affiliate.length !== 2 + 52 * 2) throw unreadable("its fee field is not a recipient and an amount");
    affiliateFee = { recipient: lc(`0x${affiliate.slice(2, 42)}`), amount: BigInt(`0x${affiliate.slice(42)}`) };
  }
  return {
    order: {
      giveTokenAddress: o.giveTokenAddress,
      giveAmount: o.giveAmount,
      takeTokenAddress: lc(o.takeTokenAddress),
      takeAmount: o.takeAmount,
      takeChainId: o.takeChainId,
      receiverDst: lc(o.receiverDst),
      givePatchAuthoritySrc: o.givePatchAuthoritySrc,
      orderAuthorityAddressDst: lc(o.orderAuthorityAddressDst),
      allowedTakerDst: lc(o.allowedTakerDst),
      externalCall: lc(o.externalCall),
      allowedCancelBeneficiarySrc: lc(o.allowedCancelBeneficiarySrc),
    },
    salt,
    affiliateFee,
    referralCode,
    permitEnvelope: lc(permitEnvelope),
    metadata: lc(metadata),
  };
}

// ---------------------------------------------------------------- verifying

/** Sato Hub names a chain by its display name ("Base", "BNB Chain", "Solana"); the kit's key ("bnb") is accepted too. Nothing else is. */
const namesChain = (given, key) => typeof given === "string" && [key, lc(isEvm(key) ? evmChain(key).hubName : "Solana")].includes(lc(given));

/** Every way Sato Hub may write the native coin of a token field: the zero address, the 0xEeee... placeholder, the system program. */
const NATIVE_MARKERS = new Set([lc(DEBRIDGE_NATIVE_EVM), lc(NATIVE_PLACEHOLDER), lc(DEBRIDGE_NATIVE_SOLANA)]);

/** Is `given` (a token field of the response) the token the intent asked for? Native matches any native marker. */
function sameToken(chainKey, given, token) {
  if (typeof given !== "string") return false;
  if (token.native) return NATIVE_MARKERS.has(lc(given));
  const want = token.address ?? token.mint;
  return isSolana(chainKey) ? given === want : same(given, want);
}

/**
 * Throws Refused unless every check passes. Pure: no network.
 *
 * @param response  the signed Sato Hub build-tx answer (its signature already checked by the caller)
 * @param intent    { chain, chainOut, tokenIn, tokenOut, amountIn: bigint, taker, recipient }: what the owner asked for, in the kit's words;
 *                  tokenIn / tokenOut are { address (or mint), native, decimals, symbol }, recipient is the bot's own address on chainOut
 * @param fixFeeWei bigint read onchain from `globalFixedNativeFee()` on the source chain
 * @returns facts { order, orderIdHint, giveAmount, takeAmount, fixFeeWei, value, feeBps, feeAmount, approvalSpender, allowedTakerDst }
 */
export function verifyDlnTx({ response, intent, fixFeeWei }) {
  const out = [];
  const fail = () => {
    throw new Refused(out);
  };
  const { chain, chainOut, tokenIn, tokenOut, taker, recipient } = intent ?? {};
  if (!response || typeof response !== "object") throw new Refused([refusal("response_mismatch", `Sato Hub's answer cannot be read; ${NOTHING}`)]);

  // (a) which chain the money leaves from. Checked first: a source the kit does not read has nothing more to check.
  const source = dlnSourceOf(chain);
  if (source === null) {
    const why = chain === "solana" ? "this kit cannot read deBridge's Solana transactions yet" : isEvm(chain) ? `deBridge sends ${labelOf(chain)} orders through a contract this kit does not read yet` : "this kit does not know that chain";
    throw new Refused([refusal("bridge_source_unsupported", `the kit does not bridge from ${isKnownChain(chain) ? labelOf(chain) : clip(chain, 30)}: ${why}; ${NOTHING}`, "base, arbitrum or polygon", clip(chain, 30))]);
  }
  if (!isKnownChain(chainOut) || chainOut === chain || !isAddress(taker ?? "") || typeof fixFeeWei !== "bigint" || typeof intent.amountIn !== "bigint" || intent.amountIn <= 0n) {
    throw new Refused([refusal("response_mismatch", `a bridge needs two different chains, an amount and the bot's own address; ${NOTHING}`, null, clip(chainOut, 30))]);
  }
  let wantDest;
  let wantTakeToken;
  try {
    wantDest = encodeDestAddress(chainOut, recipient);
    wantTakeToken = encodeDestAddress(chainOut, tokenOut.native ? (isSolana(chainOut) ? DEBRIDGE_NATIVE_SOLANA : DEBRIDGE_NATIVE_EVM) : (tokenOut.address ?? tokenOut.mint));
  } catch (err) {
    throw new Refused([refusal("response_mismatch", `the destination address or token is not one for ${labelOf(chainOut)} (${err.message}); ${NOTHING}`)]);
  }
  const ch = evmChain(chain);

  // (b) the answer is the one asked for
  if (response.mode !== "build-tx") out.push(refusal("response_mismatch", `Sato Hub's answer is not a transaction to sign; ${NOTHING}`, "build-tx", clip(response.mode, 30)));
  if (response.venue !== "debridge") out.push(refusal("response_mismatch", `Sato Hub did not route this through deBridge; ${NOTHING}`, "debridge", clip(response.venue, 30)));
  if (!namesChain(response.chain, chain)) out.push(refusal("response_mismatch", `Sato Hub's answer is for another source chain than ${ch.label}; ${NOTHING}`, chain, clip(response.chain, 30)));
  if (!namesChain(response.chain_out, chainOut)) out.push(refusal("response_mismatch", `Sato Hub's answer is for another destination chain than ${labelOf(chainOut)}; ${NOTHING}`, chainOut, clip(response.chain_out, 30)));
  if (!sameToken(chain, response.token_in, tokenIn)) out.push(refusal("response_mismatch", `Sato Hub's answer is about a different token to send than ${tokenIn.symbol}; ${NOTHING}`, tokenIn.address ?? null, clip(response.token_in, 60)));
  if (!sameToken(chainOut, response.token_out, tokenOut)) out.push(refusal("response_mismatch", `Sato Hub's answer is about a different token to receive than ${tokenOut.symbol}; ${NOTHING}`, tokenOut.address ?? tokenOut.mint ?? null, clip(response.token_out, 60)));
  if (String(response.amount_in) !== intent.amountIn.toString()) out.push(refusal("response_mismatch", `Sato Hub's answer is about a different amount than the one asked for; ${NOTHING}`, intent.amountIn.toString(), clip(response.amount_in, 40)));
  const sameRecipient = isSolana(chainOut) ? response.recipient === recipient : same(response.recipient, recipient);
  if (!sameRecipient) out.push(refusal("response_mismatch", `Sato Hub's answer sends to a different address than this bot's own on ${labelOf(chainOut)}; ${NOTHING}`, recipient, clip(response.recipient, 60)));

  const tx = response.tx;
  if (!tx || typeof tx !== "object") {
    out.push(refusal("response_mismatch", `Sato Hub returned no transaction${response.withheld?.reason ? `: ${String(response.withheld.reason).slice(0, 300)}` : ""}; ${NOTHING}`, null, clip(response.withheld?.rule, 60)));
    fail();
  }

  // (c) the contract and the function. Anything else is not decoded: its calldata would mean something else.
  if (!same(tx.to, source) || (tx.approval_target != null && !same(tx.approval_target, source))) {
    out.push(refusal("bridge_wrong_contract", `the transaction does not go to deBridge's order contract on ${ch.label}${tx.approval_target != null && same(tx.to, source) ? " (Sato Hub names another contract to approve)" : ""}; ${NOTHING}`, source, clip(same(tx.to, source) ? tx.approval_target : tx.to, 60)));
    fail();
  }
  if (tx.chain_id != null && Number(tx.chain_id) !== ch.chainId) out.push(refusal("response_mismatch", `the transaction is not for ${ch.label} (chain id ${ch.chainId}); ${NOTHING}`, ch.chainId, clip(tx.chain_id, 20)));
  if (typeof tx.data !== "string" || lc(tx.data.slice(0, 10)) !== CREATE_SALTED_ORDER_SELECTOR) {
    out.push(refusal("bridge_wrong_function", `the transaction calls a function other than creating a deBridge order; ${NOTHING}`, CREATE_SALTED_ORDER_SELECTOR, clip(tx.data, 10)));
    fail();
  }

  // (d) the order itself
  let decoded;
  try {
    decoded = decodeCreateSaltedOrder(tx.data);
  } catch (err) {
    if (err instanceof Refused) out.push(...err.refusals);
    else throw err;
    fail();
  }
  const { order, affiliateFee, permitEnvelope } = decoded;
  const takerBytes = lc(taker);

  const wantGiveToken = tokenIn.native ? DEBRIDGE_NATIVE_EVM : tokenIn.address;
  if (!same(order.giveTokenAddress, wantGiveToken)) out.push(refusal("bridge_give_mismatch", `the order gives a different token than ${tokenIn.symbol}; ${NOTHING}`, wantGiveToken, order.giveTokenAddress));
  if (order.giveAmount !== intent.amountIn) out.push(refusal("bridge_give_mismatch", `the order gives a different amount than the one asked for; ${NOTHING}`, intent.amountIn.toString(), order.giveAmount.toString()));

  const wantChainId = BigInt(debridgeChainIdOf(chainOut));
  const quotedOut = uintOf(response.amount_out);
  if (order.takeChainId !== wantChainId) out.push(refusal("bridge_take_mismatch", `the order pays out on a different chain than ${labelOf(chainOut)}; ${NOTHING}`, wantChainId.toString(), order.takeChainId.toString()));
  if (order.takeTokenAddress !== wantTakeToken) out.push(refusal("bridge_take_mismatch", `the order pays out a different token than ${tokenOut.symbol}; ${NOTHING}`, wantTakeToken, order.takeTokenAddress));
  if (quotedOut === null || quotedOut <= 0n || order.takeAmount !== quotedOut) out.push(refusal("bridge_take_mismatch", `the order pays out a different amount than the one Sato Hub quoted; ${NOTHING}`, clip(response.amount_out, 40), order.takeAmount.toString()));
  if (response.bridge?.take_amount != null && String(response.bridge.take_amount) !== order.takeAmount.toString()) out.push(refusal("bridge_take_mismatch", `Sato Hub's two figures for the amount paid out disagree; ${NOTHING}`, order.takeAmount.toString(), clip(response.bridge.take_amount, 40)));

  if (order.receiverDst !== wantDest) out.push(refusal("bridge_recipient_not_own", `the order pays out to an address that is not this bot's own on ${labelOf(chainOut)}; ${NOTHING}`, wantDest, order.receiverDst));
  if (order.orderAuthorityAddressDst !== wantDest) out.push(refusal("bridge_recipient_not_own", `the order lets an address that is not this bot's own cancel it from ${labelOf(chainOut)}; ${NOTHING}`, wantDest, order.orderAuthorityAddressDst));
  if (!same(order.givePatchAuthoritySrc, taker)) out.push(refusal("bridge_patch_authority_not_own", `the order lets an address that is not this bot's own change it on ${ch.label}; ${NOTHING}`, taker, order.givePatchAuthoritySrc));
  if (order.allowedCancelBeneficiarySrc !== "0x" && order.allowedCancelBeneficiarySrc !== takerBytes) out.push(refusal("bridge_cancel_beneficiary", `a cancelled order would refund an address that is not this bot's own; ${NOTHING}`, takerBytes, order.allowedCancelBeneficiarySrc));
  if (order.externalCall !== "0x") out.push(refusal("bridge_external_call", `the order carries an extra call to run on the destination, which this kit does not allow; ${NOTHING}`, "0x", clip(order.externalCall, 74)));
  if (permitEnvelope !== "0x") out.push(refusal("bridge_permit_present", `the order carries a token permit, which this kit does not allow; ${NOTHING}`, "0x", clip(permitEnvelope, 74)));

  // (e) the native coin sent: the protocol's fixed fee, plus the amount given when that is the native coin
  const value = tx.value == null ? 0n : uintOf(tx.value);
  const wantValue = fixFeeWei + (tokenIn.native ? order.giveAmount : 0n);
  if (value === null || value !== wantValue) out.push(refusal("bridge_value_mismatch", `the ${ch.native.symbol} sent with the order is not deBridge's fixed fee${tokenIn.native ? " plus the amount sent" : ""}; ${NOTHING}`, wantValue.toString(), clip(tx.value, 40)));

  // (f) the Sato Hub fee. It is inside giveAmount and reaches Sato Hub only when the order is filled.
  const feeBps = response.sato_fee_bps;
  const bpsOk = Number.isInteger(feeBps) && feeBps >= 0;
  if (response.sato_fee_tier != null && response.sato_fee_tier !== BRIDGE_FEE_TIER) out.push(refusal("fee_tier_mismatch", `Sato Hub priced this as a "${clip(response.sato_fee_tier, 20)}" trade, not as a bridge; ${NOTHING}`, BRIDGE_FEE_TIER, clip(response.sato_fee_tier, 20)));
  if (bpsOk && feeBps > BRIDGE_FEE_CEILING_BPS) out.push(refusal("fee_over_ceiling", `the fee is ${feePercent(feeBps)} (${feeBps} bps), above the ${feePercent(BRIDGE_FEE_CEILING_BPS)} this kit accepts on a bridge; ${NOTHING}`, BRIDGE_FEE_CEILING_BPS, feeBps));
  if (response.sato_fee_recipient != null && !same(response.sato_fee_recipient, SATO_FEE_RECIPIENT)) out.push(refusal("fee_recipient_mismatch", `Sato Hub names a fee address this kit does not know; ${NOTHING}`, SATO_FEE_RECIPIENT, clip(response.sato_fee_recipient, 60)));
  if (affiliateFee !== null && !same(affiliateFee.recipient, SATO_FEE_RECIPIENT)) out.push(refusal("fee_recipient_mismatch", `the order pays its fee to an address that is not Sato Hub's; ${NOTHING}`, SATO_FEE_RECIPIENT, affiliateFee.recipient));
  const feeAmount = affiliateFee?.amount ?? 0n;
  if (affiliateFee !== null && feeAmount * 10_000n > order.giveAmount * BigInt(BRIDGE_FEE_CEILING_BPS) + 10_000n) {
    // The order's own fee, read from the bytes, whatever Sato Hub said: more than 25 bps of the amount given (one base unit of rounding allowed).
    out.push(refusal("fee_over_ceiling", `the order takes a fee of more than ${feePercent(BRIDGE_FEE_CEILING_BPS)} of the amount sent; ${NOTHING}`, BRIDGE_FEE_CEILING_BPS, `${feeAmount} of ${order.giveAmount}`));
  }
  if (!bpsOk) {
    out.push(refusal("fee_amount_mismatch", `Sato Hub does not state its fee as a whole number of basis points; ${NOTHING}`, "0-25", clip(feeBps, 20)));
  } else {
    const wantFee = (order.giveAmount * BigInt(feeBps)) / 10_000n;
    const gap = feeAmount > wantFee ? feeAmount - wantFee : wantFee - feeAmount;
    if (gap > 1n) out.push(refusal("fee_amount_mismatch", `the fee in the order is not the ${feePercent(feeBps)} of the amount sent that Sato Hub disclosed; ${NOTHING}`, wantFee.toString(), feeAmount.toString()));
  }

  if (out.length) fail();
  return {
    order,
    orderIdHint: response.bridge?.order_id ?? null,
    giveAmount: order.giveAmount,
    takeAmount: order.takeAmount,
    fixFeeWei,
    value,
    feeBps,
    feeAmount,
    approvalSpender: source,
    allowedTakerDst: order.allowedTakerDst,
  };
}
