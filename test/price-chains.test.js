// Independent prices on the new chains (src/price.js): each chain's own Chainlink native/USD feed, and on Arbitrum the sequencer
// uptime feed read first. A fake viem client answers the reads; nothing touches the network.

import assert from "node:assert/strict";
import test from "node:test";

const { oraclePrice, oracleTolerancePct, PriceUnavailable } = await import("../src/price.js");
const { chainlinkFeed, evmChain } = await import("../src/chains.js");

const NOW = 1_800_000_000_000; // ms
const secs = (ago) => Math.floor(NOW / 1000) - ago;

/** A client that answers latestRoundData / decimals per feed address. `feeds[address] = { answer, updatedAt, startedAt, decimals }`. */
function client(feeds) {
  const calls = [];
  return {
    calls,
    async readContract({ address, functionName }) {
      calls.push([address, functionName]);
      const f = feeds[address];
      if (!f) throw new Error(`no feed at ${address}`);
      if (f instanceof Error) throw f;
      if (functionName === "decimals") return f.decimals ?? 8;
      return [1n, BigInt(f.answer), BigInt(f.startedAt ?? f.updatedAt), BigInt(f.updatedAt), 1n];
    },
  };
}

test("BNB: BNB/USD from BNB Chain's own feed, source named for the chain; stale after 5 minutes (its heartbeat is 27 s)", async () => {
  const feed = chainlinkFeed("bnb", "BNB");
  assert.equal(feed.address, "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE");
  const c = client({ [feed.address]: { answer: 75_400_000_000, updatedAt: secs(20) } });
  const p = await oraclePrice("BNB", { publicClient: c, now: NOW, chain: "bnb" });
  assert.deepEqual([p.asset, p.usd, p.age_s, p.source], ["BNB", 754, 20, `chainlink:bnb:${feed.address}`]);
  await assert.rejects(oraclePrice("BNB", { publicClient: client({ [feed.address]: { answer: 75_400_000_000, updatedAt: secs(301) } }), now: NOW, chain: "bnb" }), (e) => e instanceof PriceUnavailable && /stale/.test(e.message));
  await oraclePrice("BNB", { publicClient: client({ [feed.address]: { answer: 75_400_000_000, updatedAt: secs(300) } }), now: NOW, chain: "bnb" }); // the boundary is allowed
  // ETH is not priced on BNB Chain: there is no such feed, and nothing is guessed
  await assert.rejects(oraclePrice("ETH", { publicClient: c, now: NOW, chain: "bnb" }), PriceUnavailable);
  assert.equal(oracleTolerancePct("BNB", "bnb"), 3);
});

test("Polygon: POL is priced by Chainlink's MATIC/USD feed (no separate POL feed), 5% tolerance", async () => {
  const feed = chainlinkFeed("polygon", "POL");
  assert.equal(feed.address, "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0");
  const p = await oraclePrice("POL", { publicClient: client({ [feed.address]: { answer: 10_429_000, updatedAt: secs(38) } }), now: NOW, chain: "polygon" });
  assert.deepEqual([p.asset, p.usd, p.source], ["POL", 0.10429, `chainlink:polygon:${feed.address}`]);
  assert.equal(oracleTolerancePct("POL", "polygon"), 5);
  assert.equal(chainlinkFeed("polygon", "MATIC"), null, "the asset is POL");
});

test("Arbitrum: the sequencer is read first; down, or back up less than an hour ago, and no price is given", async () => {
  const eth = chainlinkFeed("arbitrum", "ETH");
  const seq = evmChain("arbitrum").chainlink.sequencer;
  assert.equal(eth.address, "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612");
  assert.equal(seq.address, "0xFdB631F5EE196F0ed6FAa767959853A9F217697D");
  const priced = { answer: 256_000_000_000, updatedAt: secs(60) };
  const up = (ago) => ({ [eth.address]: priced, [seq.address]: { answer: 0, updatedAt: secs(ago), startedAt: secs(ago) } });

  const ok = client(up(10 * 86_400));
  const p = await oraclePrice("ETH", { publicClient: ok, now: NOW, chain: "arbitrum" });
  assert.deepEqual([p.asset, p.usd, p.source], ["ETH", 2560, `chainlink:arbitrum:${eth.address}`]);
  assert.equal(ok.calls[0][0], seq.address, "the sequencer feed is read before the price feed");

  // back up 30 minutes ago: inside the grace period
  const e1 = await oraclePrice("ETH", { publicClient: client(up(1800)), now: NOW, chain: "arbitrum" }).then(() => null, (e) => e);
  assert.ok(e1 instanceof PriceUnavailable);
  assert.match(e1.message, /sequencer came back up 1800 s ago; its ETH price is not trusted until 3600 s have passed/);
  assert.equal(e1.details.sequencer, "restarted");
  // exactly at the edge is still inside; one second past is out
  await assert.rejects(oraclePrice("ETH", { publicClient: client(up(3600)), now: NOW, chain: "arbitrum" }), PriceUnavailable);
  await oraclePrice("ETH", { publicClient: client(up(3601)), now: NOW, chain: "arbitrum" });

  // down (answer 1)
  const down = client({ [eth.address]: priced, [seq.address]: { answer: 1, updatedAt: secs(5), startedAt: secs(5) } });
  const e2 = await oraclePrice("ETH", { publicClient: down, now: NOW, chain: "arbitrum" }).then(() => null, (e) => e);
  assert.match(e2.message, /sequencer is reported down/);
  assert.equal(e2.details.sequencer, "down");
  assert.deepEqual(down.calls.map((x) => x[0]), [seq.address], "no price read while the sequencer is down");

  // a sequencer feed that cannot be read, or that has no start time, is not a licence to trust the price
  await assert.rejects(oraclePrice("ETH", { publicClient: client({ [eth.address]: priced, [seq.address]: new Error("HTTP 429") }), now: NOW, chain: "arbitrum" }), /could not read the Arbitrum sequencer uptime feed/);
  await assert.rejects(oraclePrice("ETH", { publicClient: client({ [eth.address]: priced, [seq.address]: { answer: 0, updatedAt: secs(5), startedAt: 0 } }), now: NOW, chain: "arbitrum" }), /not trusted/);
  // the price itself is also checked: stale after 2 hours
  await assert.rejects(oraclePrice("ETH", { publicClient: client({ [eth.address]: { ...priced, updatedAt: secs(7201) }, [seq.address]: up(10 * 86_400)[seq.address] }), now: NOW, chain: "arbitrum" }), /stale/);
  assert.equal(oracleTolerancePct("ETH", "arbitrum"), 3);
});

test("Base and the other chains without a sequencer feed do not read one", async () => {
  const eth = chainlinkFeed("base", "ETH");
  const c = client({ [eth.address]: { answer: 256_000_000_000, updatedAt: secs(60) } });
  await oraclePrice("ETH", { publicClient: c, now: NOW });
  assert.deepEqual(c.calls.map((x) => x[0]), [eth.address, eth.address]);
});
