# Sato Agent

**Turn a Grok Bot into an onchain agent.** A Grok Bot already has its own always-on computer. Sato Agent gives it a wallet there (Base and Solana), lets it pay for APIs with x402, register an onchain identity (ERC-8004), and send USDC, all inside spending limits its owner sets. Sato Hub checks tools, payments and recipients before the agent acts.

It works on any always-on machine with Node 20.18+, not only Grok Bot.

## Quickstart (Grok Bot)

Tell your Bot:

> Read https://github.com/satohubai/sato-agent/blob/main/BOT.md and follow the setup. NAME = base, CHAIN = base.

It installs the kit, creates its wallet, asks you for your limits, and asks you to fund it. You fund it with what you are willing to let it spend.

Two Bots, one kit:

| Bot | Message | Today (v0.1) |
|---|---|---|
| **Sato Base Agent** | `NAME = base, CHAIN = base` | x402 payments, USDC sends, ERC-8004 identity, Sato Hub checks |
| **Sato Solana Agent** | `NAME = solana, CHAIN = solana` | USDC sends (wallet recipients only), Sato Hub checks. x402 on Solana and swaps are next. |

Each Bot keeps its own wallet, limits and ledger, even on the same Grok Bot computer.

## Quickstart (any machine)

```sh
npm install --ignore-scripts --prefix ~/.sato-agent-cli github:satohubai/sato-agent#v0.1.0
alias sato-agent=~/.sato-agent-cli/node_modules/.bin/sato-agent

sato-agent init                                     # this agent's own wallet
sato-agent policy set --per-tx 25 --per-day 100     # your limits; "none" = no limit
sato-agent balance
sato-agent pay https://some-x402-api.example/data   # x402, USDC on Base
sato-agent send --chain solana --to <address> --amount 5
sato-agent register --name "My agent" --description "What it does"
```

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the agent's Base + Solana wallet in `~/.sato-agent/`. Never replaces an existing one. |
| `address` / `balance` | Addresses; ETH + USDC on Base, SOL + USDC on Solana |
| `policy set --per-tx <usd\|none> --per-day <usd\|none> [--allow <addrs>\|any]` | The spending limits (per day = rolling 24 hours). **There are no defaults:** nothing is spent until both are set. Raises are logged and flagged. |
| `pay <url>` | Pays an x402 resource in USDC on Base, after Sato Hub reads its payment terms |
| `send --chain base\|solana --to <addr> --amount <usdc>` | Sends USDC, after Sato Hub checks the recipient |
| `register --name --description [--image]` | Registers in the ERC-8004 IdentityRegistry on Base (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), with the registration file stored onchain |
| `check "<install command>"` | Sato Check: does an install take a key, does the key leave, can it move funds on its own |
| `recommend "<goal>"` | A stack for a build goal from Sato Hub's index |
| `status` | Limits, spend in the last 24 hours, limit changes, recent spends |

Add `--json` to any command for machine-readable output.

Exit codes:
- `0`: done.
- `1`: error.
- `2`: usage error.
- `3`: refused by the limits. Nothing was signed; the message names the rule, the limit and what was observed.
- `4`: signed but not confirmed. It stays counted. **Do not retry**; check the explorer link.

Dependencies are locked by `npm-shrinkwrap.json` (every transitive version), and none has an install script.

Every limit change is written to the ledger and shown in `status`. `pay` frames the response body as untrusted content.

## How the limits work, and what they don't do

**What they do**
- The owner picks a per-transaction limit and a limit per rolling 24 hours, in USD (or "none"). There are no defaults.
- Every spend is checked and reserved under a lock before anything is signed, so two commands running at once can't both squeeze under the same limit.
- Spend is read from the ledger, so a restart doesn't reset it. If the ledger is unreadable, spending stops.
- x402 payments are checked twice: only a payment option inside the limits can be chosen, and the limits are checked again just before signing.
- Payment authorizations must expire within 5 minutes.
- A signed payment always counts, even if the server rejects it, because the server could still settle it.
- Every transaction is simulated before it is sent, and its hash is recorded before it is broadcast. Transactions from one wallet are signed one at a time, so two commands never reuse a nonce.
- If the outcome is unclear, the spend stays counted, and the command exits with code 4: **do not retry**.
- Solana sends to token accounts or other non-wallet addresses are refused.

**What they don't do**
- The limits are enforced by this program, on the same computer that holds the key. **The agent itself can raise its limits** with `policy set`. A raise is logged and flagged in `status`, but it isn't blocked.
- The agent can also edit these files, or write its own code that uses the key.
- So the limits stop mistakes, runaway loops, and an agent that follows its rules. They don't stop a compromised agent, or a prompt injection it obeys.
- **The hard bound is what you fund the wallet with.** Use a wallet dedicated to the agent, never your main wallet, and fund it with what you're willing to let it spend.
- On Grok Bot, every Bot in your account shares one computer, so every one of your Bots can read the key file.

## Files, network and privacy

- `~/.sato-agent/wallet.json` (mode 600): the keys. Never printed, never sent anywhere.
- `~/.sato-agent/policy.json`: the limits. `~/.sato-agent/ledger.jsonl`: every spend and every limit change.
- `SATO_AGENT_HOME` gives each agent its own folder. Two Bots on one computer should each use their own, so they get separate wallets and limits.
- Network calls:
  - Base and Solana RPCs (`SATO_AGENT_BASE_RPC`, `SATO_AGENT_SOLANA_RPC` to override; public endpoints by default);
  - the x402 resources you pay;
  - `https://satohub.ai/api/mcp` for checks (it receives the URL, recipient or install command being checked, never a key).
- Every request sends the user-agent `sato-agent/<version>`.

## What Sato Hub's checks are

They are dated evidence lines (when a project last shipped, whether an endpoint answered, what an install does with keys), not verdicts. `unknown` means Sato Hub holds no record, not that anything is wrong. Docs: https://satohub.ai/mcp

## Tests

```sh
npm test                                     # offline: limits, ledger, CLI, x402 handshake, Solana signing
SATO_AGENT_FORK=1 node --test test/fork.test.js   # real Base contracts on a local anvil fork
```

## License

MIT. Not affiliated with xAI or Cursor. Grok Bot is their product.
