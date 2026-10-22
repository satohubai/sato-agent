// ERC-8004 registration, offline: step two right after step one, against an RPC that
// has not seen step one yet (seen live on Base 2026-10-09: "Execution reverted for an
// unknown reason", and a --resume a minute later worked).

import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import { freshHome, raisesInForce } from "./helpers.js";

freshHome();
const { initWallet } = await import("../src/wallet.js");
const { setPolicy: setPolicyAt } = await import("../src/policy.js");
const setPolicy = raisesInForce(setPolicyAt); // raises take effect at once here; the 24-hour wait is tested in test/hardening.test.js
const { registerAgent, IDENTITY_REGISTRY, identityRegistryAbi } = await import("../src/base.js");

const me = initWallet().base;
setPolicy({ chains: "base", perTx: "1", perDay: "2" });

/** A client whose node answers step two's check with a revert `staleCalls` times, then catches up. */
function staleClient({ staleCalls }) {
  const state = { sent: [], calls: 0, slept: 0 };
  const registered = {
    address: IDENTITY_REGISTRY,
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: 99046n, owner: me } }),
    data: encodeAbiParameters([{ type: "string" }], ["data:application/json;base64,e30="]),
  };
  const c = {
    account: { address: me },
    sleep: async () => {
      state.slept++;
    },
    wallet: {
      async prepareTransactionRequest(req) {
        state.sent.push(req);
        return { ...req, nonce: req.nonce ?? 7 };
      },
      async signTransaction(p) {
        return `0x${String(p.nonce).padStart(8, "0")}${keccak256(p.data).slice(2)}`;
      },
    },
    pub: {
      async simulateContract() {
        return {};
      },
      async readContract({ functionName }) {
        if (functionName === "ownerOf") return state.owner ?? me;
        throw new Error(`unexpected read ${functionName}`);
      },
      async getTransactionReceipt({ hash }) {
        return { transactionHash: hash, status: "success", logs: state.pendingLogs?.[hash] ?? [] };
      },
      async call() {
        state.calls++;
        if (state.calls <= staleCalls) throw Object.assign(new Error("Execution reverted for an unknown reason."), { shortMessage: "Execution reverted for an unknown reason." });
        return { data: "0x" };
      },
      async sendRawTransaction() {},
      async waitForTransactionReceipt({ hash }) {
        const first = state.sent.length === 1;
        return { transactionHash: hash, status: "success", logs: first ? [registered] : [] };
      },
    },
  };
  return { c, state };
}

test("step two waits for a node that has not seen the new agent, then sends with the next nonce", async () => {
  const { c, state } = staleClient({ staleCalls: 2 });
  const r = await registerAgent({ name: "Sato Base Agent", description: "test" }, c);
  assert.equal(r.agent_id, "99046");
  assert.equal(state.calls, 3, "the check was tried again while the node caught up");
  assert.equal(state.slept, 2);
  assert.equal(state.sent.length, 2, "register, then setAgentURI: nothing was sent twice");
  assert.equal(state.sent[1].nonce, 8, "step two takes the nonce after step one, not the node's view");
});

test("a node that never catches up: stops after a few tries with the --resume hint, having signed nothing more", async () => {
  freshHome();
  initWallet();
  setPolicy({ chains: "base", perTx: "1", perDay: "2" });
  const { c, state } = staleClient({ staleCalls: 100 });
  await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test" }, c), /registered as agent 99046, but writing its registration file failed.*--resume 99046/s);
  assert.equal(state.sent.length, 1, "only step one was ever sent");
  assert.equal(state.calls, 6);
});

test("a --resume that finishes step two records the registration, so proof and a later register see it (Polygon, 2026-10-15)", async () => {
  const { entries } = await import("../src/ledger.js");
  const { registeredIds } = await import("../src/base.js");
  const { c } = staleClient({ staleCalls: 0 });
  const r = await registerAgent({ name: "Sato Base Agent", description: "test", resume: 4242 }, c);
  assert.equal(r.agent_id, "4242");
  const rows = entries().filter((e) => e.agent_id === "4242");
  assert.ok(rows.some((e) => e.kind === "register" && e.status === "registered"), "a register row was written");
  assert.ok(rows.some((e) => e.kind === "register_uri"), "and the registration file row");
  assert.ok(registeredIds("base").done.includes("4242"));
  await registerAgent({ name: "Sato Base Agent", description: "test", resume: 4242 }, c);
  assert.equal(entries().filter((e) => e.agent_id === "4242" && e.kind === "register").length, 1, "a second resume does not record it twice");
});

test("--resume refuses an agent this wallet does not own, before anything is signed", async () => {
  const { c, state } = staleClient({ staleCalls: 0 });
  state.owner = "0x9999999999999999999999999999999999999999";
  await assert.rejects(registerAgent({ name: "Sato Base Agent", description: "test", resume: 5151 }, c), /belongs to 0x9999.*not this wallet.*nothing was signed/s);
  assert.equal(state.sent.length, 0, "nothing prepared or sent");
});

test("--resume names step one's transaction only when that transaction registered this very id", async () => {
  const { record, entries } = await import("../src/ledger.js");
  const other = `0x${"77".repeat(32)}`;
  record({ kind: "register_sent", status: "signed", chain: "base", usd: 0, tx: other });
  const { c, state } = staleClient({ staleCalls: 0 });
  state.pendingLogs = { [other]: [{ address: IDENTITY_REGISTRY, topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: 1n, owner: me } }), data: encodeAbiParameters([{ type: "string" }], ["x"]) }] };
  await registerAgent({ name: "Sato Base Agent", description: "test", resume: 6262 }, c);
  const row = entries().find((e) => e.kind === "register" && e.agent_id === "6262");
  assert.ok(row, "recorded");
  assert.equal(row.tx, undefined, "the pending transaction registered another id, so it is not attached");
});
