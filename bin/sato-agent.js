#!/usr/bin/env node
// sato-agent: give this machine's agent its own onchain wallet, with limits its owner sets.
// Run `sato-agent help` for the commands.

import { parseArgs } from "node:util";
import { addresses, initWallet, walletExists } from "../src/wallet.js";
import { loadPolicy, Refused, setPolicy } from "../src/policy.js";
import { entries, spentOn } from "../src/ledger.js";
import { paths } from "../src/store.js";
import { VERSION } from "../src/version.js";
import * as baseChain from "../src/base.js";
import * as solana from "../src/solana.js";
import { pay } from "../src/x402.js";
import { advisory, checkInstall, preflight, recommend } from "../src/satohub.js";

const HELP = `sato-agent ${VERSION}: an onchain wallet for an always-on agent, with limits its owner sets

  init                                   create this agent's own Base + Solana wallet (never replaces one)
  address                                print the wallet addresses (fund these)
  balance                                ETH + USDC on Base, SOL + USDC on Solana
  policy show
  policy set --per-tx <usd|none> --per-day <usd|none> [--allow <addr,addr>|--allow any]
                                         the owner's spending limits; nothing is spent until they are set
  send --chain base|solana --to <address> --amount <usdc>
                                         send USDC under the limits (Sato Hub checks the recipient first)
  pay <url> [--method POST --data <body>]
                                         pay for an x402 resource in USDC on Base, under the limits
  register --name <name> --description <text> [--image <url>]
                                         register this agent in the ERC-8004 registry on Base (gas only)
  check "<install command>"              what an install does with keys and money (Sato Check)
  recommend "<goal>" [--chain <chain>]   a stack for a build goal, from Sato Hub
  status                                 limits, spend today, recent ledger lines
  help

Add --json for machine-readable output. Files live in ${paths.wallet().replace(/wallet\.json$/, "")} (SATO_AGENT_HOME to move).
The key never leaves this machine and is never printed. Fund the wallet with what you are willing to let the agent spend.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    chain: { type: "string" },
    to: { type: "string" },
    amount: { type: "string" },
    "per-tx": { type: "string" },
    "per-day": { type: "string" },
    allow: { type: "string" },
    method: { type: "string" },
    data: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    image: { type: "string" },
    "skip-check": { type: "boolean" },
  },
});

const [cmd = "help", ...rest] = positionals;

function out(human, obj) {
  if (flags.json) console.log(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else console.log(human);
}

function limitText(v) {
  return v === null ? "no limit (owner's choice)" : `$${v}`;
}

async function main() {
  switch (cmd) {
    case "init": {
      if (walletExists()) {
        const a = addresses();
        return out(`A wallet already exists (it is never replaced).\n  Base:   ${a.base}\n  Solana: ${a.solana}`, { existing: true, ...a });
      }
      const a = initWallet();
      return out(
        `Created this agent's wallet. Fund it with what you are willing to let it spend.\n  Base:   ${a.base}  (USDC for payments, a little ETH for gas)\n  Solana: ${a.solana}  (USDC, a little SOL for fees)\nNext: the owner sets limits with \`sato-agent policy set --per-tx <usd|none> --per-day <usd|none>\`.`,
        { created: true, ...a },
      );
    }
    case "address": {
      const a = addresses();
      return out(`Base:   ${a.base}\nSolana: ${a.solana}`, a);
    }
    case "balance": {
      const a = addresses();
      const [b, s] = await Promise.allSettled([baseChain.balances(a.base), solana.balances(a.solana)]);
      const res = {
        base: b.status === "fulfilled" ? b.value : { address: a.base, error: b.reason.message },
        solana: s.status === "fulfilled" ? s.value : { address: a.solana, error: s.reason.message },
      };
      const line = (r, gas) => (r.error ? `${r.address}: unavailable (${r.error})` : `${r.address}: ${r.usdc} USDC, ${r[gas]} ${gas.toUpperCase()}`);
      return out(`Base    ${line(res.base, "eth")}\nSolana  ${line(res.solana, "sol")}`, res);
    }
    case "policy": {
      if (rest[0] === "set") {
        const allow = flags.allow === undefined ? undefined : flags.allow === "any" ? null : flags.allow.split(",").map((s) => s.trim()).filter(Boolean);
        const p = setPolicy({ perTx: flags["per-tx"], perDay: flags["per-day"], allowRecipients: allow });
        return out(`Limits set by the owner:\n  per transaction: ${limitText(p.max_usd_per_tx)}\n  per day (UTC):   ${limitText(p.max_usd_per_day)}\n  recipients:      ${p.allow_recipients ? p.allow_recipients.join(", ") : "any"}`, p);
      }
      const p = loadPolicy();
      if (!p) return out("No limits set yet. Nothing will be spent until the owner runs `sato-agent policy set`.", { policy: null });
      return out(`per transaction: ${limitText(p.max_usd_per_tx)}\nper day (UTC):   ${limitText(p.max_usd_per_day)}\nrecipients:      ${p.allow_recipients ? p.allow_recipients.join(", ") : "any"}\nset at:          ${p.set_at}`, p);
    }
    case "send": {
      const chain = (flags.chain || "").toLowerCase();
      if (!["base", "solana"].includes(chain) || !flags.to || !flags.amount) throw new Error("usage: send --chain base|solana --to <address> --amount <usdc>");
      const a = addresses();
      const check = flags["skip-check"]
        ? null
        : await advisory(() => preflight({ address: flags.to, chain: chain === "base" ? "Base" : "Solana", from: chain === "base" ? a.base : a.solana }));
      if (check && !flags.json) console.log(`Sato Hub recipient check (evidence, not a verdict):\n${check}\n`);
      const r = chain === "base" ? await baseChain.sendUsdc({ to: flags.to, amount: flags.amount }) : await solana.sendUsdc({ to: flags.to, amount: flags.amount });
      return out(`Sent ${r.usd} USDC on ${chain} to ${r.to}\n  ${r.explorer}${r.note ? `\n  ${r.note}` : ""}`, { ...r, chain, sato_hub_check: check });
    }
    case "pay": {
      const url = rest[0];
      if (!url) throw new Error("usage: pay <url> [--method POST --data <body>]");
      const check = flags["skip-check"] ? null : await advisory(() => preflight({ x402: url }));
      if (check && !flags.json) console.log(`Sato Hub check of this x402 resource (evidence, not a verdict):\n${check}\n`);
      const r = await pay(url, { method: flags.method || "GET", body: flags.data });
      const head = r.paid ? `Paid ${r.usd} USDC to ${r.pay_to} (HTTP ${r.status})` : `No payment made (HTTP ${r.status})`;
      return out(`${head}${r.settlement?.transaction ? `\n  https://basescan.org/tx/${r.settlement.transaction}` : ""}\n\n${r.body.slice(0, 4000)}`, { ...r, sato_hub_check: check });
    }
    case "register": {
      const r = await baseChain.registerAgent({ name: flags.name, description: flags.description, image: flags.image });
      return out(`Registered as ERC-8004 agent ${r.agent_id} on Base (${r.registry})\n  ${r.explorer}${r.uri_set ? "" : "\n  note: the registration file was not updated; run again later"}`, r);
    }
    case "check": {
      const command = rest.join(" ");
      if (!command) throw new Error('usage: check "<install command>"');
      const r = await checkInstall(command);
      return out(r.text, r.structured ?? { text: r.text });
    }
    case "recommend": {
      const goal = rest.join(" ");
      if (!goal) throw new Error('usage: recommend "<goal>" [--chain <chain>]');
      const r = await recommend(goal, flags.chain);
      return out(r.text, r.structured ?? { text: r.text });
    }
    case "status": {
      const p = loadPolicy();
      const list = entries();
      const recent = list.slice(-10);
      return out(
        `limits: ${p ? `${limitText(p.max_usd_per_tx)} per transaction, ${limitText(p.max_usd_per_day)} per day` : "NOT SET"}\nspent today (UTC): $${spentOn(undefined, list)}\nrecent:\n${recent.map((e) => `  ${e.ts} ${e.status} ${e.kind ?? ""} ${e.chain ?? ""} ${e.usd ?? ""} ${e.to ?? ""} ${e.tx ?? ""}`).join("\n") || "  (none)"}`,
        { policy: p, spent_today_usd: spentOn(undefined, list), recent },
      );
    }
    case "help":
    case "--help":
      return console.log(HELP);
    default:
      throw new Error(`unknown command "${cmd}". Run \`sato-agent help\`.`);
  }
}

main().catch((err) => {
  if (err instanceof Refused) {
    if (flags.json) console.log(JSON.stringify({ refused: err.refusals }, null, 2));
    else console.error(err.message);
    process.exit(3);
  }
  console.error(`error: ${err.shortMessage || err.message}`);
  process.exit(1);
});
