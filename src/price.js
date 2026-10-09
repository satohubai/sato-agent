// An independent USD price for ETH and SOL, read from Chainlink price feeds on
// Base, so the kit can compare a swap quote against a number Sato Hub did not
// produce.
//
// WHY: a quote comes from one aggregator, relayed by one service. Before the
// agent signs it, the kit asks "does this rate sit near the market?" and the
// answer should not come from the same place as the quote. A Chainlink feed is
// an onchain read through the owner's own RPC.
//
// LIMITS, said plainly:
//   - Only ETH and SOL. There is no feed here for owner-allowlisted ERC-20s,
//     and this module does not guess one.
//   - A feed updates on a heartbeat or when the price moves by its deviation
//     threshold, so it can be a little behind the market. It is a sanity
//     bound, not a price to trade at.
//   - It reads Base. The SOL/USD feed lives on Base too (Chainlink publishes
//     it there); that is the price of SOL, not a Solana-chain read.
//   - A stale, zero or unreadable feed throws PriceUnavailable. The caller
//     decides what to do without a check; this module never invents a price.

import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { USER_AGENT } from "./version.js";

const RPC_TIMEOUT_MS = 20_000;

export const FEEDS = {
  ETH: { address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAgeS: 2 * 3600 }, // heartbeat 20 min, deviation 0.15%
  SOL: { address: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D", maxAgeS: 26 * 3600 }, // heartbeat 24 h, deviation 0.5%
};

// How far a quote's implied USD price may sit from the feed before the kit
// stops and asks. Percent. Each number adds up the honest reasons two fair
// prices differ:
//   ETH 3: feed deviation threshold (0.15%) + the quote's own slippage
//          allowance and pool price impact on a small trade (about 1%) + the
//          router fee on the input leg (0.15% for a volatile pair) + room for
//          the feed being a few minutes behind in a fast market.
//   SOL 5: the same parts with a wider feed deviation threshold (0.5%) and a
//          24 h heartbeat, so the feed can be up to a day old in a quiet
//          market, and SOL pools are thinner than ETH's.
// These are judgement calls, not measurements. A quote outside them is a
// reason to stop and look, not proof that the quote is wrong.
export const ORACLE_TOLERANCE_PCT = { ETH: 3, SOL: 5 };

/** The feed could not give a usable price. Nothing was inferred in its place. */
export class PriceUnavailable extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PriceUnavailable";
    this.details = details;
  }
}

const aggregatorAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
];

// Same transport pattern as base.js: the owner's RPC, a timeout, our name.
function defaultClient() {
  const url = process.env.SATO_AGENT_BASE_RPC || "https://mainnet.base.org";
  return createPublicClient({ chain: base, transport: http(url, { timeout: RPC_TIMEOUT_MS, fetchOptions: { headers: { "user-agent": USER_AGENT } } }) });
}

/**
 * The USD price of "ETH" or "SOL" from its Chainlink feed on Base.
 * Returns { asset, usd, updated_at (ISO), age_s, source: "chainlink:base:<address>" }.
 * Throws PriceUnavailable when the read fails, the answer is not above zero,
 * or the feed has not updated within its allowance (2 h ETH, 26 h SOL).
 * `now` (ms) exists for tests.
 */
export async function oraclePrice(asset, { publicClient, now = Date.now() } = {}) {
  const feed = FEEDS[asset];
  if (!feed) throw new PriceUnavailable(`no price feed for ${asset}; only ETH and SOL are supported`, { asset });
  const source = `chainlink:base:${feed.address}`;
  const c = publicClient ?? defaultClient();

  let round;
  let decimals;
  try {
    [round, decimals] = await Promise.all([
      c.readContract({ address: feed.address, abi: aggregatorAbi, functionName: "latestRoundData" }),
      c.readContract({ address: feed.address, abi: aggregatorAbi, functionName: "decimals" }),
    ]);
  } catch (err) {
    throw new PriceUnavailable(`could not read the ${asset}/USD feed (${err.shortMessage || err.message})`, { asset, source });
  }

  const answer = BigInt(round[1]);
  const updatedAt = Number(round[3]);
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) throw new PriceUnavailable(`the ${asset}/USD feed reported odd decimals (${decimals})`, { asset, source });
  if (answer <= 0n) throw new PriceUnavailable(`the ${asset}/USD feed answered ${answer}, which is not a price`, { asset, source });
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new PriceUnavailable(`the ${asset}/USD feed has no update time`, { asset, source });

  const age_s = Math.max(0, Math.round(now / 1000 - updatedAt));
  if (age_s > feed.maxAgeS) {
    throw new PriceUnavailable(`the ${asset}/USD feed is stale: last updated ${age_s} s ago (allowed ${feed.maxAgeS} s)`, { asset, source, age_s });
  }
  const usd = Number(formatUnits(answer, dec));
  return { asset, usd, updated_at: new Date(updatedAt * 1000).toISOString(), age_s, source };
}

/**
 * Is the quote's implied USD price within `tolerancePct` percent of the
 * oracle's? Pure. Anything that is not a finite positive number is "not ok"
 * with deviation_pct null: an unknown is never treated as a match.
 */
export function quoteWithinOracle({ usdOracle, usdQuote, tolerancePct }) {
  const good = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!good(usdOracle) || !good(usdQuote) || typeof tolerancePct !== "number" || !Number.isFinite(tolerancePct) || tolerancePct < 0) {
    return { ok: false, deviation_pct: null };
  }
  // Rounded to 6 places so float noise cannot tip a quote exactly on the line.
  const deviation_pct = Math.round((Math.abs(usdQuote - usdOracle) / usdOracle) * 100 * 1e6) / 1e6;
  return { ok: deviation_pct <= tolerancePct, deviation_pct };
}
