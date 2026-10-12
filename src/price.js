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

import { createPublicClient, formatUnits } from "viem";
import { DEFAULT_EVM_CHAIN, chainlinkFeed, evmChain, sequencerFeed } from "./chains.js";
import { chainTransport } from "./rpc.js";

// The feeds themselves (addresses, how stale one may be, the tolerance) are pinned per chain in src/chains.js.
// This table is the Base reading of them, kept under its v0.3 name: ETH/USD (heartbeat 20 min, deviation 0.15%) and
// SOL/USD (heartbeat 24 h, deviation 0.5%), both read on Base.
export const FEEDS = {
  ETH: (({ address, maxAgeS }) => ({ address, maxAgeS }))(chainlinkFeed("base", "ETH")),
  SOL: (({ address, maxAgeS }) => ({ address, maxAgeS }))(chainlinkFeed("base", "SOL")),
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
export const ORACLE_TOLERANCE_PCT = { ETH: chainlinkFeed("base", "ETH").tolerancePct, SOL: chainlinkFeed("base", "SOL").tolerancePct };

/** The tolerance (percent) for `asset` priced through chain `chain`'s feeds; null if that chain has no such feed. */
export const oracleTolerancePct = (asset, chain = DEFAULT_EVM_CHAIN) => chainlinkFeed(chain, asset)?.tolerancePct ?? null;

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

// Same transport as base.js: the chain's endpoints (the owner's, else the registry's), a timeout, our name.
function defaultClient(chain) {
  return createPublicClient({ chain: evmChain(chain).viem, transport: chainTransport(chain) });
}

/**
 * The USD price of an asset ("ETH" or "SOL" on Base) from its Chainlink feed on `chain` (default Base).
 * Returns { asset, usd, updated_at (ISO), age_s, source: "chainlink:<chain>:<address>" }.
 * Throws PriceUnavailable when the read fails, the answer is not above zero,
 * or the feed has not updated within its allowance (2 h ETH, 26 h SOL).
 * `now` (ms) exists for tests.
 */
export async function oraclePrice(asset, { publicClient, now = Date.now(), chain = DEFAULT_EVM_CHAIN } = {}) {
  const feed = chainlinkFeed(chain, asset);
  if (!feed) throw new PriceUnavailable(`no price feed for ${asset}; only ETH and SOL are supported`, { asset });
  const source = `chainlink:${chain}:${feed.address}`;
  const c = publicClient ?? defaultClient(chain);

  // An L2 whose sequencer is down (or has just come back) can show a price that is not the market's: Chainlink's own guidance is to
  // read the sequencer uptime feed first, and not to trust a price until a grace period after it restarts.
  const seq = sequencerFeed(chain);
  if (seq) {
    let s;
    try {
      s = await c.readContract({ address: seq.address, abi: aggregatorAbi, functionName: "latestRoundData" });
    } catch (err) {
      throw new PriceUnavailable(`could not read the ${evmChain(chain).label} sequencer uptime feed (${err.shortMessage || err.message}), so its ${asset} price is not trusted`, { asset, source });
    }
    const startedAt = Number(s[2]);
    if (BigInt(s[1]) !== 0n) throw new PriceUnavailable(`the ${evmChain(chain).label} sequencer is reported down, so its ${asset} price is not trusted`, { asset, source, sequencer: "down" });
    const up_s = Math.round(now / 1000 - startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0 || up_s <= seq.graceS) {
      throw new PriceUnavailable(`the ${evmChain(chain).label} sequencer came back up ${Number.isFinite(up_s) && startedAt > 0 ? `${Math.max(0, up_s)} s ago` : "at a time that could not be read"}; its ${asset} price is not trusted until ${seq.graceS} s have passed`, { asset, source, sequencer: "restarted", up_s });
    }
  }

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
