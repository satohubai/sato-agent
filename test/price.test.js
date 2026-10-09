// Offline by default: a fake public client stands in for the RPC. The real
// feeds are read only with SATO_AGENT_FORK=1, through a local anvil fork of
// Base (needs `anvil` on PATH; FORK_RPC overrides the upstream RPC):
//   SATO_AGENT_FORK=1 node --test test/price.test.js

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { FEEDS, ORACLE_TOLERANCE_PCT, PriceUnavailable, oraclePrice, quoteWithinOracle } from "../src/price.js";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0); // ms
const secs = (n) => Math.floor(NOW / 1000) - n; // an updatedAt n seconds ago

// A fake viem public client answering the two reads oraclePrice makes.
function fakeClient({ answer = 248961370000n, updatedAt = secs(200), decimals = 8, fail } = {}) {
  const calls = [];
  return {
    calls,
    async readContract({ address, functionName }) {
      calls.push({ address, functionName });
      if (fail) throw Object.assign(new Error("rpc down"), { shortMessage: fail });
      if (functionName === "decimals") return decimals;
      if (functionName === "latestRoundData") return [1n, answer, 0n, BigInt(updatedAt), 1n];
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

test("ETH: reads latestRoundData and decimals from the ETH/USD feed", async () => {
  const c = fakeClient();
  const p = await oraclePrice("ETH", { publicClient: c, now: NOW });
  assert.equal(p.asset, "ETH");
  assert.equal(p.usd, 2489.6137);
  assert.equal(p.age_s, 200);
  assert.equal(p.updated_at, new Date(secs(200) * 1000).toISOString());
  assert.equal(p.source, "chainlink:base:0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  assert.deepEqual(c.calls.map((x) => x.functionName).sort(), ["decimals", "latestRoundData"]);
  assert.ok(c.calls.every((x) => x.address === FEEDS.ETH.address));
});

test("SOL: its own feed, and a 6 h old answer is fine (24 h heartbeat)", async () => {
  const c = fakeClient({ answer: 11003841768n, updatedAt: secs(6 * 3600) });
  const p = await oraclePrice("SOL", { publicClient: c, now: NOW });
  assert.equal(p.usd, 110.03841768);
  assert.equal(p.source, "chainlink:base:0x975043adBb80fc32276CbF9Bbcfd4A601a12462D");
  assert.ok(c.calls.every((x) => x.address === FEEDS.SOL.address));
});

test("stale: ETH older than 2 h, SOL older than 26 h", async () => {
  await assert.rejects(oraclePrice("ETH", { publicClient: fakeClient({ updatedAt: secs(2 * 3600 + 1) }), now: NOW }), (e) => e instanceof PriceUnavailable && /stale/.test(e.message));
  await oraclePrice("ETH", { publicClient: fakeClient({ updatedAt: secs(2 * 3600) }), now: NOW }); // the boundary is allowed
  await assert.rejects(oraclePrice("SOL", { publicClient: fakeClient({ updatedAt: secs(26 * 3600 + 1) }), now: NOW }), (e) => e instanceof PriceUnavailable && /stale/.test(e.message));
  await oraclePrice("SOL", { publicClient: fakeClient({ updatedAt: secs(25 * 3600) }), now: NOW });
});

test("an answer of zero or below is not a price", async () => {
  for (const answer of [0n, -5n]) {
    await assert.rejects(oraclePrice("ETH", { publicClient: fakeClient({ answer }), now: NOW }), (e) => e instanceof PriceUnavailable && /not a price/.test(e.message));
  }
});

test("a feed with no update time is unavailable", async () => {
  await assert.rejects(oraclePrice("ETH", { publicClient: fakeClient({ updatedAt: 0 }), now: NOW }), PriceUnavailable);
});

test("a failed read throws PriceUnavailable and says why", async () => {
  await assert.rejects(oraclePrice("SOL", { publicClient: fakeClient({ fail: "HTTP 429" }), now: NOW }), (e) => e instanceof PriceUnavailable && /HTTP 429/.test(e.message));
});

test("only ETH and SOL", async () => {
  await assert.rejects(oraclePrice("DOGE", { publicClient: fakeClient(), now: NOW }), PriceUnavailable);
});

test("quoteWithinOracle: the tolerance math", () => {
  assert.deepEqual(quoteWithinOracle({ usdOracle: 2000, usdQuote: 2000, tolerancePct: 3 }), { ok: true, deviation_pct: 0 });
  const edge = quoteWithinOracle({ usdOracle: 2000, usdQuote: 2060, tolerancePct: 3 });
  assert.equal(edge.ok, true, "exactly on the tolerance passes");
  assert.equal(edge.deviation_pct, 3);
  const over = quoteWithinOracle({ usdOracle: 2000, usdQuote: 1930, tolerancePct: 3 });
  assert.equal(over.ok, false, "a quote below the market is judged the same as above it");
  assert.equal(over.deviation_pct, 3.5);
  assert.equal(quoteWithinOracle({ usdOracle: 100, usdQuote: 104, tolerancePct: ORACLE_TOLERANCE_PCT.SOL }).ok, true);
  assert.equal(quoteWithinOracle({ usdOracle: 100, usdQuote: 106, tolerancePct: ORACLE_TOLERANCE_PCT.SOL }).ok, false);
});

test("quoteWithinOracle: unknowns are never a match", () => {
  const no = { ok: false, deviation_pct: null };
  assert.deepEqual(quoteWithinOracle({ usdOracle: 0, usdQuote: 10, tolerancePct: 3 }), no);
  assert.deepEqual(quoteWithinOracle({ usdOracle: 10, usdQuote: 0, tolerancePct: 3 }), no);
  assert.deepEqual(quoteWithinOracle({ usdOracle: NaN, usdQuote: 10, tolerancePct: 3 }), no);
  assert.deepEqual(quoteWithinOracle({ usdOracle: 10, usdQuote: undefined, tolerancePct: 3 }), no);
  assert.deepEqual(quoteWithinOracle({ usdOracle: 10, usdQuote: 10, tolerancePct: -1 }), no);
  assert.deepEqual(quoteWithinOracle({ usdOracle: 10, usdQuote: 10 }), no);
});

test("tolerances", () => {
  assert.deepEqual(ORACLE_TOLERANCE_PCT, { ETH: 3, SOL: 5 });
});

// ---- opt-in: the real feeds, through a local anvil fork of Base ----------------------------

const enabled = process.env.SATO_AGENT_FORK === "1";
const PORT = 19545 + Math.floor(Math.random() * 1000);
let anvil;
after(() => anvil?.kill());

test("fork: reads the real ETH/USD and SOL/USD feeds on Base", { skip: !enabled }, async () => {
  anvil = spawn("anvil", ["--fork-url", process.env.FORK_RPC || "https://mainnet.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  process.env.SATO_AGENT_BASE_RPC = `http://127.0.0.1:${PORT}`;
  const probe = async () => {
    const r = await fetch(process.env.SATO_AGENT_BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(2000) });
    return r.ok;
  };
  for (let i = 0; i < 60; i++) {
    try {
      if (await probe()) break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const eth = await oraclePrice("ETH"); // the default client, pointed at the fork by SATO_AGENT_BASE_RPC
  const sol = await oraclePrice("SOL");
  assert.ok(eth.usd > 100 && eth.usd < 100_000, `ETH ${eth.usd}`);
  assert.ok(sol.usd > 1 && sol.usd < 10_000, `SOL ${sol.usd}`);
  assert.ok(eth.age_s >= 0 && eth.age_s <= 2 * 3600);
  assert.ok(sol.age_s >= 0 && sol.age_s <= 26 * 3600);
  assert.match(eth.updated_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(eth.source, "chainlink:base:0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  console.log(`# fork read: ETH ${eth.usd} (${eth.age_s}s old), SOL ${sol.usd} (${sol.age_s}s old)`);
});
