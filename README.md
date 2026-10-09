# Sato Agent

**Turn a Grok Bot into an onchain agent.** A Grok Bot already has its own always-on computer. Sato Agent gives it a wallet there (Base and Solana), lets it pay for APIs with x402, register an onchain identity (ERC-8004), and send USDC, all inside spending limits its owner sets. Sato Hub checks tools, payments and recipients before the agent acts.

It works on any always-on machine with Node 20.18+, not only Grok Bot.

## Quickstart (Grok Bot)

Tell your Bot:

> Read https://github.com/satohubai/sato-agent/blob/main/BOT.md and follow the setup. NAME = base, CHAIN = base.

It installs the kit, creates its wallet, asks you for your limits, and asks you to fund it. You fund it with what you are willing to let it spend.

Two Bots, one kit:

| Bot | Message | Today |
|---|---|---|
| **Sato Base Agent** | `NAME = base, CHAIN = base` | x402 payments, USDC sends, swaps USDC ↔ ETH/WETH, ERC-8004 identity, Sato Hub checks |
| **Sato Solana Agent** | `NAME = solana, CHAIN = solana` | x402 payments in USDC on Solana (`pay --chain solana`), USDC sends (wallet recipients only), swaps USDC ↔ SOL via Jupiter, Sato Hub checks |

Each Bot keeps its own wallet, limits and ledger, even on the same Grok Bot computer.

## Quickstart (any machine)

```sh
npm install --ignore-scripts --prefix ~/.sato-agent-cli github:satohubai/sato-agent#v0.2.0
alias sato-agent=~/.sato-agent-cli/node_modules/.bin/sato-agent
# npm may print "ERESOLVE overriding peer dependency" three times (the Solana x402
# library's helpers ask for an older @solana/kit). That is expected; the tests run on these versions.

sato-agent init                                     # this agent's own wallet
# The chains and both limits come from the owner; there are no defaults. "none" = no limit.
sato-agent policy set --chains <base|solana|base,solana> --per-tx <owner's amount> --per-day <owner's amount>
sato-agent policy set --approval ask --check-gate no                   # optional: ask first; let a `no` check stop a spend
sato-agent balance
sato-agent pay https://some-x402-api.example/data --chain base     # x402, USDC on Base
sato-agent pay https://some-x402-api.example/data --chain solana   # x402, USDC on Solana
sato-agent send --chain solana --to <address> --amount 5
sato-agent register --name "My agent" --description "What it does"
```

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the agent's Base + Solana keys in its folder (`~/.sato-agent/`, or `SATO_AGENT_HOME`). Never replaces an existing one. |
| `address` / `balance` | Address and USDC + gas balance for this agent's chain(s) |
| `policy set --chains <base\|solana\|base,solana> --per-tx <usd\|none> --per-day <usd\|none>` | The owner's choices (per day = rolling 24 hours). **There are no defaults:** nothing is spent until chains and both limits are set. |
| `policy set [--allow <addrs>\|any] [--approval ask\|auto] [--check-gate off\|no\|caution] [--on-check-unavailable allow\|refuse]` | Optional choices: a recipient allowlist; ask the owner before every spend; let a Sato Hub `no` (or `caution`) stop a spend; what to do when the check can't run. **Anything that loosens a choice is logged as a raise.** |
| `pay <url> [--chain base\|solana] [--method --data --header]` | Pays an x402 resource in USDC on Base or on Solana mainnet, after Sato Hub reads its payment terms. Any other token or chain is refused. The chain is the owner's: an agent set to one chain pays there (`--chain` may be left out), an agent set to both must say `--chain`, and a `--chain` the owner did not choose is refused before anything is reserved. A JSON `--data` gets a JSON content-type |
| `swap --chain base\|solana --from <asset> --to <asset> --amount <n> [--slippage-bps <n>] [--dry-run]` | Swaps with USDC on one side (Base: ETH, WETH; Solana: SOL). Off until the owner sets `--swap-slippage-bps` and `--max-trades-per-day`. See "How swaps are checked" below. |
| `send --chain base\|solana --to <addr> --amount <usdc>` | Sends USDC, after Sato Hub checks the recipient |
| `register --name --description [--image] [--service name=endpoint] [--x402-support]` | Registers in the ERC-8004 IdentityRegistry on Base (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), with the registration file stored onchain |
| `check "<install command>" [--cluster mainnet-beta\|devnet] [--skip-check]` | First, Solana build receipts for the npm packages in the command (see below). Then Sato Check: does an install take a key, does the key leave, can it move funds on its own |
| `recommend "<goal>"` | A stack for a build goal from Sato Hub's index |
| `status` | Limits, spend in the last 24 hours, limit changes, recent spends |

Add `--json` to any command for machine-readable output.

**Upgrading from v0.1.0:** a v0.1.0 policy never chose its chains, so spending is refused (`chains_not_set`) until you run `policy set --chains <base|solana|base,solana>`.

**Upgrading from v0.1.1:** `pay` now works on Solana too, and follows the chain(s) the owner chose, like `send`. An agent set to one chain pays there. An agent set to both chains must add `--chain base` or `--chain solana`; without it, `pay` stops with a usage error (exit 2) and nothing is reserved. In approval mode the intent the owner says yes to includes the chain.

**Secrets:** put API keys in `--header`, never in the URL or the `--data` body. Header values are hashed; the URL and body are shown to the owner and kept in the ledger, so they can be approved.

### Build receipts in `check`

`check` reads the npm packages out of an install command (`npm i`, `pnpm add`, `yarn add`, `bun add`, `npx [-y] pkg[@version]`; flags are ignored and nothing is ever run). For each `package@version` it reads Sato Check's **build receipt** straight from Solana and tells you if the tarball npm serves for that version is the build the receipt describes. If you give no version, `latest` is looked up on the npm registry and the output says so. Version ranges, paths, git and URL installs are listed as not looked up. So is any package in a command that installs from another registry (`--registry`, `--userconfig`, a scoped `--@scope:registry`, or an `npm_config_registry=` / `NPM_CONFIG_REGISTRY=` prefix, in any case): it is listed with "installs from another registry", because what it installs is not what registry.npmjs.org serves. A project or user `.npmrc` can also redirect an install; `check` does not read it, and the output says so.

A receipt is a dated Sato Check reading of one exact build, written onchain by Sato Hub. It describes; it does not decide. Reading it needs no key and makes no call to Sato Hub: just a Solana RPC (`SATO_AGENT_SOLANA_RPC`, or `SATO_AGENT_RECEIPTS_RPC` to use a different one just for this) and the npm registry.

Each package gets one of these:

| Status (`--json`) | Printed | Meaning |
|---|---|---|
| `same_build` | same build as recorded | The sha256 of the npm tarball equals the digest in the receipt. |
| `different_build` | different build | The tarball's sha256 differs from the digest in the receipt, so the reading is about another build. |
| `no_reading` | no reading for this build | No receipt exists for that exact version. It means no reading was written, nothing else. |
| `receipt_expired` | a receipt existed for this build but it has expired | A Sato Hub receipt is at the address, but its expiry has passed. `note` gives the date. Not shown as a current reading. |
| `not_a_sato_receipt` | an account exists at the receipt address but it is not a Sato Hub receipt | Something is at the address, but it failed a check (owner program, credential, schema, signer, nonce, data, or the schema is paused: `error` says which). Not a reading. |
| `chain_unreadable` | the chain could not be read | The RPC failed, or Sato Hub's schema account could not be read. Never the same as `no_reading`. |
| `build_unchecked` | this build could not be fetched to compare | The registry failed, the tarball is over 64 MB, or its bytes did not match npm's own integrity hash. The receipt, if any, is still shown. |

A found receipt is printed with its fields and dates: `key_access`, `key_egress`, `fund_action_count` (stored as -1 when unknown; printed and returned as `unknown`/`null`, never as -1 or 0), `method_version`, `as_of`, the full reading URL, the attestation address and a Solana Explorer link. Before any of it is used, the account's owner must be the Solana Attestation Service program, its credential, schema and signer must be Sato Hub's, and the schema must not be paused; otherwise the status is `not_a_sato_receipt`. The tarball is downloaded only from `https://registry.npmjs.org/`, only where a receipt exists to compare it to, and its bytes are checked against the registry's own sha512 integrity first.

Then Sato Check's own text is shown, as before. `--skip-check` leaves that out and makes no request to Sato Hub at all. `--cluster devnet` reads the test deployment instead of mainnet. A receipt never changes the exit code: a different build or no reading still exits `0`.

`check --json` prints:

```json
{
  "command": "npm i solana-agent-kit@2.0.10",
  "receipts": [
    {
      "subject_id": "npm:solana-agent-kit",
      "package": "solana-agent-kit",
      "version": "2.0.10",
      "version_requested": "2.0.10",
      "version_resolved_from_latest": false,
      "version_resolved_from": null,
      "status": "same_build",
      "installed_sha256": "<sha256 of the tarball npm serves for this version>",
      "integrity_check": "match",
      "receipt": {
        "subject_kind": "package", "subject_id": "npm:solana-agent-kit", "version": "2.0.10",
        "digest_hex": "<sha256 recorded in the receipt>",
        "key_access": "declared", "key_egress": "not_observed",
        "fund_action_count": null,
        "method_version": "custody-2", "as_of": "2026-10-05",
        "reading_url": "https://satohub.ai/check/package/...",
        "attestation_address": "<base58>", "cluster": "mainnet-beta",
        "explorer_url": "https://explorer.solana.com/address/<base58>"
      }
    }
  ],
  "skipped": [{ "spec": "./local", "reason": "..." }],
  "deployment": { "cluster": "mainnet-beta", "credential": "...", "schema": "...", "authority": "...", "program": "22zoJMtd..." },
  "rpc_host": "api.mainnet-beta.solana.com",
  "registry_note": "Compared with what registry.npmjs.org serves. A project or user .npmrc can redirect ...",
  "sato_hub_check": { }
}
```

`receipt` is `null` when no current receipt was found (`no_reading`, `receipt_expired`, `not_a_sato_receipt`, `chain_unreadable`); an `error` string is added when the status is `not_a_sato_receipt`, `chain_unreadable` or `build_unchecked`, and a `note` (the expiry date) for `receipt_expired`. `integrity_check` is `match` or `not_published`. `version_resolved_from` is `"latest"` (also `version_resolved_from_latest: true`) or a dist-tag when no exact version was given. `sato_hub_check` is `null` with `--skip-check`. If Sato Hub cannot be reached, the receipts are still printed, `sato_hub_check_error` is added, and the exit code is `1` as before.

Exit codes:
- `0`: done.
- `1`: error.
- `2`: usage error.
- `3`: refused by the limits. Nothing was signed; the message names the rule, the limit and what was observed.
- `4`: signed but not confirmed. It stays counted. **Do not retry**; check the explorer link.
- `5`: needs the owner's approval (approval mode). Nothing was spent. Re-run the same command with `--approve <code>` after the owner says yes. The code works once, for that exact intent, for 15 minutes. For `pay`, the approval covers the URL and request; the server sets the price and payee at pay time, capped by the per-transaction limit. Header values are never stored or printed (names plus a hash only). `register` also asks in approval mode.

Dependencies are locked by `npm-shrinkwrap.json` (every transitive version), and none has an install script. They are pinned exactly and never updated on their own: a fix in a dependency (viem, @solana/kit, the @x402 packages) reaches this kit in a new release of it, after it has been tested here, not before.

Every limit change is written to the ledger and shown in `status`. `pay` frames the response body as untrusted content.

## How the limits work, and what they don't do

**What they do**
- The owner picks a per-transaction limit and a limit per rolling 24 hours, in USD (or "none"). There are no defaults.
- Every spend is checked and reserved under a lock before anything is signed, so two commands running at once can't both squeeze under the same limit.
- Spend is read from the ledger, so a restart doesn't reset it. If the ledger is unreadable, spending stops.
- x402 payments are checked twice: only a payment option inside the limits can be chosen, and the limits are checked again just before signing.
- Payment authorizations must expire within 5 minutes.
- A signed payment always counts, even if the server rejects it, because the server could still settle it.
- On Base, the agent signs EIP-3009 authorizations to valid Base addresses; a permit2 offer, or a recipient that is not a Base address, is refused before anything is reserved. After signing, the amount, recipient, payer and expiry are compared with what was reserved; anything else is not sent, stays counted, and the command exits with code 4.
- A payment receipt counts as settled when it names a transaction id in that chain's own form. Any other id is not stored or shown, and the payment is treated as unsettled (exit 4). Text from a server (addresses, receipts, error messages) is shown and logged on one cleaned line.
- A Solana RPC that does not answer ends the payment: before signing, nothing is sent and the reservation is released; after signing, nothing is sent and it stays counted (exit 4).
- On Solana, the agent reads the transaction it just signed before sending it. It sends only one USDC transfer of the reserved amount from its own USDC account to the recipient's, with the fee payer the server named. Anything else is not sent, stays counted, and the command exits with code 4. The agent pays no SOL for an x402 payment: the server's facilitator pays the fee. A Solana payment is valid for about a minute (the life of its blockhash).
- Every `send` transaction is simulated before it is sent, and its hash is recorded before it is broadcast. (An x402 payment is checked as described above and sent to the server, which settles it.) Transactions from one wallet are signed one at a time, so two commands never reuse a nonce.
- If the outcome is unclear, the spend stays counted, and the command exits with code 4: **do not retry**.
- Solana sends to token accounts or other non-wallet addresses are refused.

**What they don't do**
- The limits are enforced by this program, on the same computer that holds the key. **The agent itself can loosen any choice** with `policy set`: raise a limit, add a recipient or chain, loosen the check gate, or switch "ask" to "auto". In approval mode it could also type the approval code itself. Every loosening is logged and flagged in `status`, but it isn't blocked.
- The agent can also edit these files, or write its own code that uses the key.
- So the limits stop mistakes, runaway loops, and an agent that follows its rules. They don't stop a compromised agent, or a prompt injection it obeys.
- **The hard bound is what you fund the wallet with.** Use a wallet dedicated to the agent, never your main wallet, and fund it with what you're willing to let it spend.
- On Grok Bot, every Bot in your account shares one computer, so every one of your Bots can read the key file.

## How swaps are checked

Nothing is signed until all of these pass:
- **The owner's choices:** swaps turned on, slippage under the owner's cap, trades per 24 hours, the USD limits. A swap counts against the same per-transaction and 24-hour limits as any spend.
- **An independent price.** Chainlink ETH/USD or SOL/USD, read on Base. Selling ETH or SOL is valued at that price, never at the quote. With no fresh price, there is no swap, and a quote more than 3% (ETH) or 5% (SOL) from it is refused.
- **Sato Hub's signature** on the quote and on its fee disclosure.
- **The minimum you receive is the kit's, and it is written into the transaction.** The kit computes it from the quote less your slippage cap, then decodes the transaction it is about to sign. The minimum written into the transaction must match, and the output must go to the agent's own wallet; otherwise nothing is signed. Onchain, the swap reverts rather than pay less than that minimum.
- **On Base:** the transaction must go to the pinned KyberSwap router on chain 8453, with the right value. The kit decodes the router call: tokens, amount, recipient, minimum and fee must all match what was asked. It then runs its own simulation (`eth_simulateV1`) of the approval plus the swap: the wallet may lose at most the amount sold, must receive at least the minimum, and must lose nothing else. Approvals are for the exact amount only, never unlimited, and are set back to 0 afterwards. If a swap ends unclear (exit code 4) or the reset fails, the command says so; check the allowance before the next swap. One Base swap runs at a time.
- **On Solana:** the kit builds the transaction through Jupiter itself. It decodes it with its lookup tables and allows only pinned programs (and only the exact wrap, unwrap and create-account steps). It also decodes the Jupiter route: the amount, minimum, slippage, fee and destination must all match. The agent must be the only signer and the fee payer, the priority fee is capped, and the kit runs its own simulation of the balance changes and of who controls its token accounts afterwards. A transaction close to expiry is rebuilt, checked again (with a new price reading) and reported to you, never re-signed.
- **The Sato Hub fee** is shown before signing. It is taken inside the swap (3 bps for stablecoin pairs, 15 bps with ETH or SOL). The kit checks that the fee written into the transaction is exactly the disclosed one, paid to the pinned Sato Hub address and to no one else, and refuses anything above 15 bps.
- **What this does not cover:** the simulation runs on the RPC you use (a public one by default), and prices can move between the quote and the block. The minimum in the transaction is what bounds that, and the 24-hour limit bounds the total.
- **Sato Hub keeps a public record of every swap quote it gives:** the venue, the pair, the amounts and the fee, never the wallet address. A `--dry-run` asks for a quote too, so it is recorded the same way.

## Files, network and privacy

- `wallet.json` (mode 600): the keys. Never printed, never sent anywhere.
- `policy.json`: the owner's choices. `ledger.jsonl`: every spend, limit change, skipped check and approval. `approvals.json`: pending approval codes.
- They live in `~/.sato-agent/` by default. With the Grok Bot launchers from BOT.md, each Bot's files live in `~/.sato-agent/<NAME>/`.
- `SATO_AGENT_HOME` gives each agent its own folder. Two Bots on one computer should each use their own, so they get separate wallets and limits.
- Network calls:
  - Base and Solana RPCs (`SATO_AGENT_BASE_RPC`, `SATO_AGENT_SOLANA_RPC` to override; public endpoints by default);
  - `https://registry.npmjs.org/` for `check` (package versions and tarballs; only the package names you ask about);
  - the x402 resources you pay;
  - `https://satohub.ai/api/mcp` for checks (it receives the URL, recipient or install command being checked, never a key), and for swap quotes and fee disclosures (it receives the pair, the amount and the agent's address; its public route record shows the pair and amounts, never the address);
  - for Solana swaps, Jupiter (`api.jup.ag`), which builds the transaction for the agent's address.
- Requests made by the kit itself send the user-agent `sato-agent/<version>`. The Solana x402 library's own RPC reads (the USDC mint and a recent blockhash) go out with Node's default user-agent.

## What Sato Hub's checks are

They are dated evidence lines (when a project last shipped, whether an endpoint answered, what an install does with keys), not verdicts. A check stops a spend only if the owner chose that (`--check-gate`). With the gate on, the owner also chooses what happens when a check can't run, or when Sato Hub answered about something other than the target. A non-default Sato Hub address (`SATO_AGENT_MCP_URL`) is logged on every gated check. A `go` never means a recipient or resource is safe; it means nothing on record stood in the way. `unknown` means Sato Hub holds no record, not that anything is wrong. Docs: https://satohub.ai/mcp

## Tests

```sh
npm test                                     # offline: limits, ledger, CLI, x402 handshake, Solana signing
SATO_AGENT_FORK=1 node --test test/fork.test.js   # real Base contracts on a local anvil fork
```

## License

MIT. Not affiliated with xAI or Cursor. Grok Bot is their product.
