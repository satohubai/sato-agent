// Sends, balances, payment links, ERC-8004 registration, gift cards and the referral report on BNB Chain, Arbitrum and Polygon, offline.
// The point of most of these: BNB Chain's stablecoins have 18 decimals, everything else 6, and the limits are always in USD.

import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256 } from "viem";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { freshHome } from "./helpers.js";
import { fakeChain } from "./swap-evm-helpers.js";
import { siwxInfo } from "./bitrefill-world.js";

freshHome();
const { initWallet, addresses } = await import("../src/wallet.js");
const { setPolicy, loadPolicy } = await import("../src/policy.js");
const { Refused } = await import("../src/errors.js");
const { entries, explorerFor, actions } = await import("../src/ledger.js");
const chainsMod = await import("../src/chains.js");
const { evmChain, defaultStable } = chainsMod;
const base = await import("../src/base.js");

initWallet();
const me = addresses().base;
const TO = "0x1111111111111111111111111111111111111111";
setPolicy({ chains: "arbitrum,base,bnb,polygon,solana", perTx: "5", perDay: "100" });

const withSim = (c) => ({ ...c, pub: { ...c.pub, simulateContract: async () => ({}) } });
const refused = (rule) => (e) => e instanceof Refused && e.refusals.some((r) => r.rule === rule);
const lastRow = (kind) => actions().filter((e) => e.kind === kind).at(-1);

// ------------------------------------------------------------------ sending a stablecoin

test("send on BNB Chain: USDT has 18 decimals — 1.5 USDT is 1.5e18 units, $1.50 against the limits, signed on chain 56 under the chain's own lock", async () => {
  const { c, state } = fakeChain({ address: me });
  const r = await base.sendStable({ to: TO, amount: "1.5", chain: "bnb" }, withSim(c));
  const usdt = evmChain("bnb").stables.USDT;
  assert.equal(state.sent[0].to, usdt.address);
  const call = decodeFunctionData({ abi: erc20Abi, data: state.sent[0].data });
  assert.deepEqual([call.functionName, call.args[0].toLowerCase(), call.args[1]], ["transfer", TO, 1_500_000_000_000_000_000n]);
  assert.equal(r.usd, 1.5);
  assert.match(r.explorer, /^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/);
  const row = lastRow("send");
  assert.deepEqual([row.chain, row.asset, row.usd, row.status], ["bnb", "USDT", 1.5, "confirmed"]);
  assert.equal(explorerFor(row), r.explorer);
});

test("send on BNB Chain: the other stablecoin by name; more than 18 decimals refused; the dollar limit reads USD, not token units", async () => {
  const { c, state } = fakeChain({ address: me });
  await base.sendStable({ to: TO, amount: "2", chain: "bnb", symbol: "USDC" }, withSim(c));
  assert.equal(state.sent[0].to, evmChain("bnb").stables.USDC.address);
  assert.equal(lastRow("send").asset, "USDC");
  await assert.rejects(base.sendStable({ to: TO, amount: "1.0000000000000000001", chain: "bnb" }, withSim(fakeChain({ address: me }).c)), /not a USDT amount: .* at most 18 decimals/);
  // 6 dollars against a $5 per-transaction limit: refused with the USD figure, however many units that is
  const refusal = await base.sendStable({ to: TO, amount: "6", chain: "bnb" }, withSim(fakeChain({ address: me }).c)).then(() => null, (e) => e);
  assert.ok(refusal instanceof Refused);
  assert.deepEqual([refusal.refusals[0].rule, refusal.refusals[0].observed], ["max_usd_per_tx", 6]);
  // the 24-hour total counts dollars too: 1.5 + 2 sent above, so $97 more is over the $100 a day
  const day = await base.sendStable({ to: TO, amount: "97", chain: "bnb" }, withSim(fakeChain({ address: me }).c)).then(() => null, (e) => e);
  assert.ok(day.refusals.some((r) => r.rule === "max_usd_per_tx" || r.rule === "max_usd_per_day"));
});

test("send on Arbitrum and Polygon: USDC with 6 decimals; a stablecoin Base does not have is refused there", async () => {
  for (const [chain, scan] of [["arbitrum", "https://arbiscan.io"], ["polygon", "https://polygonscan.com"]]) {
    const { c, state } = fakeChain({ address: me });
    const r = await base.sendStable({ to: TO, amount: "1.25", chain }, withSim(c));
    const call = decodeFunctionData({ abi: erc20Abi, data: state.sent[0].data });
    assert.equal(state.sent[0].to, evmChain(chain).stables.USDC.address);
    assert.equal(call.args[1], 1_250_000n);
    assert.equal(r.usd, 1.25);
    assert.ok(r.explorer.startsWith(`${scan}/tx/`), r.explorer);
    assert.deepEqual([lastRow("send").chain, lastRow("send").asset], [chain, "USDC"]);
    await assert.rejects(base.sendStable({ to: TO, amount: "1.0000001", chain }, withSim(fakeChain({ address: me }).c)), /at most 6 decimals/);
  }
  await assert.rejects(base.sendStable({ to: TO, amount: "1", chain: "base", symbol: "USDT" }, withSim(fakeChain({ address: me }).c)), /USDT is not a stablecoin this kit sends on Base/);
  // sendUsdc still means USDC: on BNB Chain that is the 18-decimal Binance-Peg token, by name, never USDT
  const { c, state } = fakeChain({ address: me });
  await base.sendUsdc({ to: TO, amount: "1", chain: "bnb" }, withSim(c));
  assert.equal(state.sent[0].to, evmChain("bnb").stables.USDC.address);
});

test("a chain the owner did not choose is refused before anything is signed", async () => {
  const keep = loadPolicy();
  setPolicy({ chains: "base" });
  const { c, state } = fakeChain({ address: me });
  await assert.rejects(base.sendStable({ to: TO, amount: "1", chain: "bnb" }, withSim(c)), refused("chain_not_allowed"));
  assert.equal(state.sent.length, 0);
  setPolicy({ chains: keep.chains.join(",") });
});

test("a dry run of a send simulates the transfer in the chain's own token and signs nothing", async () => {
  const seen = [];
  const { c, state } = fakeChain({ address: me });
  const d = await base.dryRunSendStable({ to: TO, amount: "3", chain: "bnb" }, { ...c, pub: { ...c.pub, simulateContract: async (a) => (seen.push(a), {}) } });
  assert.deepEqual([d.dry_run, d.chain, d.usd, d.simulated], [true, "bnb", 3, true]);
  assert.equal(seen[0].address, evmChain("bnb").stables.USDT.address);
  assert.equal(seen[0].args[1], 3_000_000_000_000_000_000n);
  assert.equal(state.sent.length, 0);
});

// ------------------------------------------------------------------ balances, through the chain's own endpoint(s)

const servers = [];
after(() => servers.forEach((s) => s.closeAllConnections?.() ?? s.close()));
async function rpcServer(handler) {
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const j = JSON.parse(raw);
      const out = handler(j);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? { jsonrpc: "2.0", id: j.id, result: out.result }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

test("balance on BNB Chain: gas in BNB and both stablecoins with 18 decimals, read through the owner's RPC list (the first is rate limited)", async () => {
  const limited = await rpcServer(() => ({ status: 429, body: { jsonrpc: "2.0", error: { code: -32029, message: "Too Many Requests" } } }));
  const good = await rpcServer((j) => ({ result: j.method === "eth_getBalance" ? "0xde0b6b3a7640000" : `0x${(2_500_000_000_000_000_000n).toString(16).padStart(64, "0")}` }));
  process.env.SATO_AGENT_BNB_RPC = `${limited},${good}`;
  try {
    assert.deepEqual(await base.balances(me, "bnb"), { address: me, bnb: "1", usdt: "2.5", usdc: "2.5" });
  } finally {
    delete process.env.SATO_AGENT_BNB_RPC;
  }
});

test("balance on Arbitrum: the old shape — { address, eth, usdc, usdt } — with 6-decimal stablecoins", async () => {
  const good = await rpcServer((j) => ({ result: j.method === "eth_getBalance" ? "0x2386f26fc10000" : `0x${(12_340_000n).toString(16).padStart(64, "0")}` }));
  process.env.SATO_AGENT_ARBITRUM_RPC = good;
  try {
    assert.deepEqual(await base.balances(me, "arbitrum"), { address: me, eth: "0.01", usdc: "12.34", usdt: "12.34" });
  } finally {
    delete process.env.SATO_AGENT_ARBITRUM_RPC;
  }
});

// ------------------------------------------------------------------ EIP-681 payment links

test("EIP-681: each chain's stablecoins, at the chain's decimals; a token on the wrong chain, the bridged USDC.e and an absurd amount are refused", async () => {
  const { parseEip681, classifyBuy, BUY_ACCEPTS } = await import("../src/checkout.js");
  const link = (chain, token, units, to = TO) => `ethereum:${token}@${evmChain(chain).chainId}/transfer?address=${to}&uint256=${units}`;
  const bnb = evmChain("bnb").stables;
  assert.deepEqual(parseEip681(link("bnb", bnb.USDT.address, 1_500_000_000_000_000_000n)), { chain: "bnb", to: TO, units: 1_500_000_000_000_000_000n, amount: "1.5" });
  assert.deepEqual(parseEip681(link("bnb", bnb.USDC.address, 10n ** 18n)), { chain: "bnb", to: TO, units: 10n ** 18n, amount: "1", symbol: "USDC" }, "the non-default stable says which");
  assert.equal(parseEip681(link("bnb", bnb.USDT.address, 1)).amount, "0.000000000000000001");
  const arb = evmChain("arbitrum").stables;
  assert.deepEqual(parseEip681(link("arbitrum", arb.USDC.address, 2_500_000)), { chain: "arbitrum", to: TO, units: 2_500_000n, amount: "2.5" });
  assert.equal(parseEip681(link("arbitrum", arb.USDT.address, 2_500_000)).symbol, "USDT");
  const pol = evmChain("polygon").stables;
  assert.equal(parseEip681(link("polygon", pol.USDC.address, 1_000_000)).chain, "polygon");
  assert.equal(parseEip681(link("polygon", pol.USDT.address, 1_000_000)).symbol, "USDT");
  // the same link with the chain id of a chain the token is not on
  assert.throws(() => parseEip681(link("polygon", bnb.USDT.address, 1)), refused("checkout_token"));
  assert.throws(() => parseEip681(`ethereum:${arb.USDC.address}@56/transfer?address=${TO}&uint256=1`), refused("checkout_token"));
  assert.throws(() => parseEip681(link("polygon", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 1)), refused("checkout_token"), "USDC.e is not Circle's");
  assert.throws(() => parseEip681(`ethereum:${arb.USDC.address}/transfer?address=${TO}&uint256=1`), refused("checkout_chain"), "no chain means Ethereum mainnet");
  assert.throws(() => parseEip681(`ethereum:${arb.USDC.address}@10/transfer?address=${TO}&uint256=1`), refused("checkout_chain"));
  // about nine billion dollars is the most that converts exactly; ten billion BNB-Chain dollars is refused, not rounded
  assert.throws(() => parseEip681(link("bnb", bnb.USDT.address, 10n ** 28n)), /not a positive whole number of USDT units/);
  assert.equal(parseEip681(link("bnb", bnb.USDT.address, 5n * 10n ** 27n)).amount, "5000000000");
  assert.equal(classifyBuy(link("bnb", bnb.USDT.address, 1)).route, "checkout");
  assert.match(BUY_ACCEPTS[1], /^an Ethereum payment link for USDC or USDT on Base, BNB Chain, Arbitrum or Polygon \(ethereum:0x8335\.\.\.@8453\/transfer\?address=\.\.\.&uint256=\.\.\.\)$/);
});

// ------------------------------------------------------------------ ERC-8004 registration

function registryClient(chain) {
  const reg = evmChain(chain).erc8004Registry;
  const state = { sent: [], tos: [] };
  const registered = (agentId) => ({
    address: reg,
    topics: encodeEventTopics({ abi: base.identityRegistryAbi, eventName: "Registered", args: { agentId, owner: me } }),
    data: encodeAbiParameters([{ type: "string" }], ["data:application/json;base64,e30="]),
  });
  return {
    state,
    c: {
      account: { address: me },
      sleep: async () => {},
      wallet: {
        async prepareTransactionRequest(req) {
          state.sent.push(req);
          return { ...req, nonce: req.nonce ?? 3, chain: req.chain };
        },
        async signTransaction(p) {
          return `0x${String(p.nonce).padStart(8, "0")}${keccak256(p.data).slice(2)}`;
        },
      },
      pub: {
        async simulateContract({ address }) {
          state.tos.push(address);
          return {};
        },
        async call() {
          return { data: "0x" };
        },
        async sendRawTransaction() {},
        async waitForTransactionReceipt({ hash }) {
          return { transactionHash: hash, status: "success", logs: state.sent.length === 1 ? [registered(770n)] : [] };
        },
      },
    },
  };
}

test("register on Arbitrum: the same registry address, this chain's CAIP-2 in the card and the result, rows that say arbitrum, its explorer", async () => {
  const { c, state } = registryClient("arbitrum");
  const r = await base.registerAgent({ name: "Sato Arbitrum Bot", description: "test", chain: "arbitrum" }, c);
  const reg = evmChain("arbitrum").erc8004Registry;
  assert.deepEqual([r.agent_id, r.registry], ["770", `eip155:42161:${reg}`]);
  assert.match(r.explorer, /^https:\/\/arbiscan\.io\/tx\//);
  assert.ok(state.sent.every((t) => t.to === reg && t.chain.id === 42161), "both steps went to the registry, signed for chain 42161");
  const card = JSON.parse(Buffer.from(decodeURIComponent(decodeFunctionData({ abi: base.identityRegistryAbi, data: state.sent[1].data }).args[1].split(",")[1]), "base64").toString());
  assert.deepEqual(card.registrations, [{ agentId: 770, agentRegistry: `eip155:42161:${reg}` }]);
  const rows = entries().filter((e) => e.kind === "register" || e.kind === "register_uri" || e.kind === "register_sent");
  assert.ok(rows.length >= 3 && rows.every((e) => e.chain === "arbitrum"));
});

test("register: one registration per chain — a Base id does not stop Arbitrum's, a second one on the same chain is refused; a chain the owner did not choose too", async () => {
  // a v0.3 row has no chain: it was Base
  const { record } = await import("../src/ledger.js");
  record({ kind: "register", status: "registered", usd: 0, agent_id: "5", tx: "0xold" });
  assert.deepEqual(base.registeredIds("base").done, ["5"]);
  assert.deepEqual(base.registeredIds("arbitrum").done, ["770"]);
  assert.deepEqual(base.registeredIds("polygon").done, []);
  await assert.rejects(base.registerAgent({ name: "x", description: "y", chain: "arbitrum" }, registryClient("arbitrum").c), /already registered agent id 770; add --again/);
  const { c } = registryClient("polygon");
  const r = await base.registerAgent({ name: "Sato Polygon Bot", description: "test", chain: "polygon" }, c);
  assert.match(r.explorer, /^https:\/\/polygonscan\.com\/tx\//);
  setPolicy({ chains: "base" });
  await assert.rejects(base.registerAgent({ name: "x", description: "y", chain: "bnb" }, registryClient("bnb").c), /set to work on base only; ERC-8004 registration is on BNB Chain/);
  setPolicy({ chains: "arbitrum,base,bnb,polygon,solana" });
});

// ------------------------------------------------------------------ gift cards: the sign-in and the payment are for one of Bitrefill's chains

test("gift cards: the chain a command runs on", async () => {
  const B = await import("../src/bitrefill.js");
  assert.deepEqual(B.GIFT_CHAINS, ["base", "arbitrum", "polygon"]);
  assert.equal(B.giftcardChain(undefined, null), "base", "no policy yet: v0.3's Base");
  assert.equal(B.giftcardChain(undefined, { chains: ["polygon", "solana"] }), "polygon");
  assert.equal(B.giftcardChain("arbitrum", { chains: ["arbitrum", "base"] }), "arbitrum");
  assert.throws(() => B.giftcardChain(undefined, { chains: ["base", "arbitrum"] }), /may buy gift cards on Base and Arbitrum: say which with --chain base\|arbitrum/);
  // BNB Chain and Solana: never offered; the way forward is the Base bot
  for (const chains of [["bnb"], ["solana"], ["bnb", "solana"]]) {
    assert.throws(() => B.giftcardChain(undefined, { chains }), (e) => refused("giftcards_base_only")(e) && /Sato Base Bot/.test(e.message) && /paid in USDC on Base, Arbitrum and Polygon/.test(e.message), chains.join());
    assert.throws(() => B.assertBaseAgent({ chains }), refused("giftcards_base_only"));
  }
  B.assertBaseAgent({ chains: ["bnb", "polygon"] });
  assert.throws(() => B.giftcardChain("bnb", { chains: ["bnb", "base"] }), (e) => refused("giftcards_not_on_chain")(e) && /Bitrefill takes Base, Arbitrum and Polygon, not BNB Chain/.test(e.message));
  assert.throws(() => B.giftcardChain("eth", null), /--chain must be base, arbitrum or polygon/);
});

test("gift cards: a sign-in on Arbitrum or Polygon is for that chain's id, and Bitrefill's challenge must offer it", async () => {
  const B = await import("../src/bitrefill.js");
  const { parseSiweMessage } = await import("viem/siwe");
  const offer = (...ids) => ids.map((chainId) => ({ chainId, type: "eip191" }));
  for (const [chain, id] of [["arbitrum", 42161], ["polygon", 137], ["base", 8453]]) {
    const { message, payload } = B.checkSiwxChallenge({ info: siwxInfo(), supportedChains: offer("eip155:8453", "eip155:42161", "eip155:137") }, { address: me, chain });
    assert.equal(parseSiweMessage(message).chainId, id, chain);
    assert.equal(payload.chainId, `eip155:${id}`);
  }
  // a challenge that does not list the chain, or names another in its info, is refused
  assert.throws(() => B.checkSiwxChallenge({ info: siwxInfo(), supportedChains: offer("eip155:8453") }, { address: me, chain: "arbitrum" }), refused("siwx_refused"));
  assert.throws(() => B.checkSiwxChallenge({ info: siwxInfo(Date.now(), { chainId: "eip155:8453" }), supportedChains: offer("eip155:8453", "eip155:42161") }, { address: me, chain: "arbitrum" }), refused("siwx_refused"));
  assert.throws(() => B.checkSiwxChallenge({ info: siwxInfo(), supportedChains: offer("eip155:56") }, { address: me, chain: "bnb" }), /Bitrefill takes Base, Arbitrum and Polygon, not BNB Chain/);
});

test("gift cards: the invoice's payment terms are read for this chain's offer, in this chain's native Circle USDC, paid to Bitrefill's one payee", async () => {
  const B = await import("../src/bitrefill.js");
  const payTo = B.BITREFILL_PAY_TO;
  const accepts = [
    { scheme: "exact", network: "eip155:8453", asset: evmChain("base").stables.USDC.address, amount: "1111", payTo },
    { scheme: "exact", network: "eip155:42161", asset: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", amount: "9999", payTo }, // USDC.e
    { scheme: "exact", network: "eip155:42161", asset: evmChain("arbitrum").stables.USDC.address, amount: "2222", payTo },
    { scheme: "exact", network: "eip155:137", asset: evmChain("polygon").stables.USDC.address.toLowerCase(), amount: "3333", payTo },
  ];
  const fetchImpl = async () => new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "https://api.bitrefill.com/x402/invoice/pay" }, accepts }) } });
  const d = (chain) => ({ chain, base: B.BITREFILL_API, fetchImpl, now: Date.now });
  assert.deepEqual(await B.invoiceTerms("inv_1", "tok", d("base")), { units: 1111n, pay_to: payTo });
  assert.deepEqual(await B.invoiceTerms("inv_1", "tok", d("arbitrum")), { units: 2222n, pay_to: payTo }, "the native USDC offer, not the bridged one");
  assert.deepEqual(await B.invoiceTerms("inv_1", "tok", d("polygon")), { units: 3333n, pay_to: payTo });
  await assert.rejects(B.invoiceTerms("inv_1", "tok", d("bnb")), /Bitrefill takes Base, Arbitrum and Polygon/);
});

test("gift cards: a token saved for one chain is not used on another", async () => {
  const fs = await import("node:fs");
  const { home } = await import("../src/store.js");
  const { join } = await import("node:path");
  const B = await import("../src/bitrefill.js");
  const future = new Date(Date.now() + 3600_000).toISOString();
  const write = (s) => fs.writeFileSync(join(home(), "bitrefill-session.json"), JSON.stringify(s));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    return new Response("{}", { status: 500 });
  };
  write({ service: "bitrefill", address: me, chain: "arbitrum", token: "TOKEN-FOR-ARBITRUM", expires_at: future });
  assert.equal(await B.signIn({ fetchImpl, chain: "arbitrum" }), "TOKEN-FOR-ARBITRUM");
  assert.deepEqual(calls, [], "the saved token was used: no request");
  await assert.rejects(B.signIn({ fetchImpl, chain: "polygon" }), /answered HTTP 500/);
  assert.equal(calls.length, 1, "another chain asks Bitrefill for its own sign-in");
  // a session saved by v0.3 has no chain: it is Base's
  write({ service: "bitrefill", address: me, token: "TOKEN-V03", expires_at: future });
  assert.equal(await B.signIn({ fetchImpl, chain: "base" }), "TOKEN-V03");
  await assert.rejects(B.signIn({ fetchImpl, chain: "arbitrum" }), /answered HTTP 500/);
});

// ------------------------------------------------------------------ purchases that exist only on some chains

test("Amazon orders stay Base and Solana: a bot on another chain gets a plain refusal", async () => {
  const { purchaseChain } = await import("../src/purchase.js");
  const amazon = chainsMod.chainsWith("amazon");
  assert.deepEqual(amazon, ["base", "solana"]);
  assert.equal(purchaseChain("base", amazon, { chains: ["base", "bnb"] }), "base");
  assert.throws(() => purchaseChain("bnb", amazon, { chains: ["base", "bnb"] }), refused("chain_not_supported"));
  assert.throws(() => purchaseChain(undefined, amazon, { chains: ["arbitrum"] }), (e) => refused("chain_not_supported")(e) && /not available on Arbitrum; it works on Base and Solana/.test(e.message));
  assert.throws(() => purchaseChain("bnb", amazon, { chains: ["base"] }), refused("chain_not_allowed"));
  assert.throws(() => purchaseChain("eth", amazon, { chains: ["base"] }), /--chain must be base, bnb, arbitrum, polygon or solana/);
  // payment links and deposit addresses are on all five
  assert.equal(purchaseChain("bnb", undefined, { chains: ["bnb"] }), "bnb");
});

// ------------------------------------------------------------------ the referral: one name, one payout class, the real chain in the settle report

test("referral create on any EVM chain signs with the same key and keeps the payout class 'base'; the settle report carries the real chain", async () => {
  const names = await import("../src/referral-names.js");
  const { settleReferral, reportSettlement } = await import("../src/swap/referral.js");
  const { loadSettings } = await import("../src/settings.js");
  const posts = [];
  const hub = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true, name: "sunny-otter", created: true, payout_chain: "base" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const r = await names.createReferralName({ chain: "bnb" }, { fetchImpl: hub, origin: "https://hub.test" });
  assert.deepEqual([r.name, r.chain, r.payout_chain], ["sunny-otter", "base", "base"]);
  assert.equal(posts[0].body.signer, me.toLowerCase(), "the same EVM key signs, whichever EVM chain was named");
  assert.equal(loadSettings().referral_chain, "base");
  const again = await names.createReferralName({ chain: "polygon" }, { fetchImpl: hub, origin: "https://hub.test" });
  assert.equal(again.name, "sunny-otter");
  await assert.rejects(names.createReferralName({ chain: "nope" }, { fetchImpl: hub }), /referral create needs --chain base, bnb, arbitrum, polygon or solana\./);
  assert.equal(names.payoutClass("arbitrum"), "base");
  assert.equal(names.payoutClass("solana"), "solana");

  // the settle report: the real chain key, the route id and the tx; nothing else
  const settleBodies = [];
  const settleHub = async (url, init) => (settleBodies.push({ url: String(url), body: JSON.parse(init.body) }), new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 }));
  for (const chain of ["base", "bnb", "arbitrum", "polygon", "solana"]) {
    const tx = `0x${chain.length.toString(16).padStart(64, "a")}`;
    const out = await settleReferral({ routeId: `rt_${chain}`, chain, tx }, { fetchImpl: settleHub, origin: "https://hub.test" });
    assert.deepEqual([out.ok, out.recorded], [true, true], chain);
  }
  assert.deepEqual(settleBodies.map((s) => s.body.chain), ["base", "bnb", "arbitrum", "polygon", "solana"]);
  assert.deepEqual(Object.keys(settleBodies[1].body).sort(), ["chain", "route_id", "tx"]);
  assert.ok(settleBodies.every((s) => s.url === "https://hub.test/api/route/settle"));
  // and from a confirmed swap's display: the chain it ran on
  const sent = [];
  const rep = await reportSettlement({ chain: "bnb", route_id: "rt_9", referral: { sent: "sunny-otter" } }, { tx: `0x${"cd".repeat(32)}` }, { fetchImpl: async (u, i) => (sent.push(JSON.parse(i.body)), new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 })), origin: "https://hub.test" });
  assert.equal(rep.ok, true);
  assert.deepEqual(sent[0], { route_id: "rt_9", chain: "bnb", tx: `0x${"cd".repeat(32)}` });
});

test("defaults: Base is the stable and the chain when nothing says otherwise; every chain's default stable is one of its own", () => {
  assert.equal(defaultStable("base").symbol, "USDC");
  assert.equal(defaultStable("bnb").symbol, "USDT");
  assert.equal(defaultStable("arbitrum").symbol, "USDC");
  assert.equal(defaultStable("polygon").symbol, "USDC");
  assert.equal(explorerFor({ chain: "polygon", tx: "0xabc" }), "https://polygonscan.com/tx/0xabc");
  assert.equal(explorerFor({ chain: "nope", tx: "0xabc" }), "https://basescan.org/tx/0xabc", "an unknown or missing chain reads as Base, as in v0.3");
});
