# Sato Agent

**Turn a Grok Bot into an onchain agent.** A Grok Bot already has its own always-on computer. Sato Agent gives it a wallet there (Base and Solana), lets it pay for APIs with x402, register an onchain identity (ERC-8004), and send USDC, all inside spending limits its owner sets. Sato Hub checks tools, payments and recipients before the agent acts.

It works on any always-on machine with Node 20.18+, not only Grok Bot.

## Quickstart (Grok Bot)

Tell your Bot:

> Read https://github.com/satohubai/sato-agent/blob/main/BOT.md and follow the setup.

It installs the kit, creates its wallet, asks you for your limits, and asks you to fund it. You fund it with what you are willing to let it spend.

## Quickstart (any machine)

```sh
npm install --prefix ~/.sato-agent-cli github:satohubai/sato-agent#v0.1.0
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
| `policy set --per-tx <usd\|none> --per-day <usd\|none> [--allow <addrs>\|any]` | The owner's limits. **There are no defaults:** nothing is spent until they are set. |
| `pay <url>` | Pays an x402 resource in USDC on Base, after Sato Hub reads its payment terms |
| `send --chain base\|solana --to <addr> --amount <usdc>` | Sends USDC, after Sato Hub checks the recipient |
| `register --name --description [--image]` | Registers in the ERC-8004 IdentityRegistry on Base (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), with the registration file stored onchain |
| `check "<install command>"` | Sato Check: does an install take a key, does the key leave, can it move funds on its own |
| `recommend "<goal>"` | A stack for a build goal from Sato Hub's index |
| `status` | Limits, spend today (UTC), recent ledger lines |

Add `--json` to any command for machine-readable output. A refusal exits with code 3 and names the rule, the limit and what was observed.

## How the limits work, and what they don't do

- The owner sets a per-transaction and a per-day limit in USD (or "none"). Every spend is checked against them, and today's spend is read from an append-only ledger, so a restart does not reset it.
- x402 payments are limited twice: only a payment option inside the limits can be chosen, and the limits are checked again just before the payment is signed.
- Every transaction is simulated before it is sent.
- **What the limits are not:** they are enforced by this program, on the same computer that holds the key. Something that bypasses the program, such as a compromised Bot or a prompt injection that writes its own code, could spend past them. **The hard bound is what you fund the wallet with.** Use a wallet dedicated to the agent, never your main wallet, and fund it with what you are willing to let it spend.
- On Grok Bot, every Bot in your account shares one computer, so every one of your Bots can read the key file.

## Files, network and privacy

- `~/.sato-agent/wallet.json` (mode 600): the keys. Never printed, never sent anywhere.
- `~/.sato-agent/policy.json`: the owner's limits. `~/.sato-agent/ledger.jsonl`: every spend.
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
