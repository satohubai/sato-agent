# Sato Agent

**Turn a Grok Bot into an onchain agent.** A Grok Bot already has its own always-on computer. Sato Agent gives it a wallet there (Base and Solana), lets it trade tokens, buy gift cards and (once switched on) Amazon orders, pay checkouts and APIs (x402), register an onchain identity (ERC-8004), and send USDC, all inside spending limits its owner sets. Sato Hub checks tools, payments and recipients before the agent acts.

It works on any always-on machine with Node 20.18+, not only Grok Bot.

## Quickstart (Grok Bot)

Tell your Bot:

> Read https://github.com/satohubai/sato-agent/blob/main/BOT.md and follow the setup. NAME = base, CHAIN = base.

It installs the kit, creates its wallet, asks you for your limits, and asks you to fund it. You fund it with what you are willing to let it spend.

Two Bots, one kit:

| Bot | Message | Today |
|---|---|---|
| **Sato Base Agent** | `NAME = base, CHAIN = base` | buy or sell any Base token against USDC or ETH (by address or link), gift cards / eSIMs / top-ups (Bitrefill), Amazon US orders (once Sato Hub switches them on), USDC payment links (EIP-681), x402 payments, USDC sends, ERC-8004 identity, Sato Hub checks |
| **Sato Solana Agent** | `NAME = solana, CHAIN = solana` | buy or sell any Solana token against USDC or SOL via Jupiter (by mint or link), Amazon US orders (once switched on), Solana Pay requests (USDC or SOL), x402 payments in USDC on Solana (`pay --chain solana`), USDC sends (wallet recipients only), Sato Hub checks |

Each Bot keeps its own wallet, limits and ledger, even on the same Grok Bot computer.

## Quickstart (any machine)

```sh
npm install --ignore-scripts --prefix ~/.sato-agent-cli github:satohubai/sato-agent#v0.3.0
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
sato-agent giftcard search amazon --country US                      # gift cards on Base: search (with the values on offer)
sato-agent giftcard detail amazon_com-usa                           # the exact values it can be bought for
sato-agent giftcard buy amazon_com-usa --value 5                    # the price card; the owner's yes is --approve <code>
sato-agent buy "solana:<recipient>?amount=5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"   # a Solana Pay request
```

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the agent's Base + Solana keys in its folder (`~/.sato-agent/`, or `SATO_AGENT_HOME`). Never replaces an existing one. |
| `address` / `balance` | Address and USDC + gas balance for this agent's chain(s) |
| `policy set --chains <base\|solana\|base,solana> --per-tx <usd\|none> --per-day <usd\|none>` | The owner's choices (per day = rolling 24 hours). **There are no defaults:** nothing is spent until chains and both limits are set. |
| `policy set [--allow <addrs>\|any] [--approval ask\|auto] [--check-gate off\|no\|caution] [--on-check-unavailable allow\|refuse]` | Optional choices: a recipient allowlist; ask the owner before every spend; let a Sato Hub `no` (or `caution`) stop a spend; what to do when the check can't run. **Anything that loosens a choice is logged as a raise.** |
| `pay <url> [--chain base\|solana] [--method --data --header]` | Pays an x402 resource in USDC on Base or on Solana mainnet, after the kit asks the server's price (one unpaid request) and Sato Hub reads its payment terms. Any other token or chain is refused before an approval is asked for. A server that does not ask for payment is not paid. `--dry-run` shows the quoted price, chain and payee. The chain is the owner's: an agent set to one chain pays there (`--chain` may be left out), an agent set to both must say `--chain`, and a `--chain` the owner did not choose is refused before anything is reserved. A JSON `--data` gets a JSON content-type |
| `token <address\|mint\|link> [--chain base\|solana]` | A token card: what the token is (read from the chain), its price and liquidity with source and date, and Sato Hub's evidence about it. Links from DexScreener, GeckoTerminal, Birdeye, pump.fun, gmgn, Basescan, Solscan, jup.ag, Uniswap, Aerodrome, Zora and Clanker are resolved by Sato Hub, then re-read from the chain. |
| `swap --chain base\|solana --from <asset> --to <asset> --amount <n\|all> [--slippage-bps <n>] [--dry-run]` | Buy or sell any token, with USDC, ETH or WETH (Base) or USDC or SOL (Solana) on one side. An asset is a symbol for those majors, or a token's address, mint or link. `--amount all` sells a token's whole balance. On once the spending limits are set; `policy set --swaps off` turns it off. See "How swaps are checked" below. |
| `buy <request\|link\|ASIN>` | Reads what it is given and hands it on, changing nothing itself: a `solana:` or `ethereum:` request to `checkout`, an Amazon link or ASIN to `order`, any other https link to `pay` (x402, including a Coinbase Business checkout's `x402_url`). A link paid through `buy` is a purchase: price card, and the owner's yes unless both choices are auto. Anything else gets a list of what it accepts. |
| `giftcard search <words> [--country] [--kind giftcard\|esim\|topup]` / `giftcard detail <product id>` / `giftcard buy <product id> --value <n> [--refill <number>]` / `giftcard status <invoice>` | Gift cards, eSIMs and phone top-ups from Bitrefill, paid in USDC on Base over x402 with no Bitrefill account. The price card comes first; the code is printed once, on the last line, and kept in a 0600 file. Paid but not delivered within `--wait` (default and most 240 s) exits **4**: do not buy again, check with `giftcard status`. `search` and `buy` (a dry run too) sign in to Bitrefill (a sign-in message, not a payment); a dry run creates an unpaid invoice. Base only (a Solana-only agent is told so). See "How purchases are checked". |
| `order --available` / `order <amazon.com link\|ASIN> [--chain base\|solana]` / `orders [id]` | Amazon US, shipped to the owner's address, through Sato Hub (Crossmint), when Sato Hub has switched it on. `order --available` asks Sato Hub (`GET /api/commerce/order`, advisory and unsigned) and prints `Amazon orders: on` or `off (not switched on yet)`; it exits 0 either way and 1 if Sato Hub does not answer; anything but exactly `"on"` counts as off. BOT.md has the bot mention Amazon only when it is on. An order is refused with exit 3 until it is. `orders` shows status, delivery and refunds. An order `--dry-run` sends the shipping address to Sato Hub and creates a Crossmint quote (it expires unpaid). |
| `checkout <solana:...\|ethereum:...>` / `checkout --to <address> --amount <usdc> --chain base\|solana` | Pays a Solana Pay request (a transfer request in USDC or SOL, or a transaction request link), an EIP-681 USDC-on-Base payment link, or an exact amount to a deposit address. Use the last for a **Stripe deposit address**: Stripe matches only the exact amount, on the right network. |
| `settings set --stdin` / `settings set --ship-name --ship-line1 [--ship-line2] --ship-city --ship-state <XX> --ship-zip --ship-country --ship-email` / `settings show` / `settings set --ship-clear` | The shipping address for Amazon orders, kept only in `settings.json` (mode 600) on this computer. `--stdin` reads it as a JSON object (`name, line1, line2, city, state, postalCode, country, email`) so it never sits in a command line. |
| `policy set --purchases ask\|auto` | Purchases (gift cards, Amazon orders, checkouts, links paid through `buy`) ask the owner first unless BOTH `--purchases` and `--approval` are on auto. Unset means ask; ask → auto is logged as a raise. `pay` and `send` keep following `--approval`. |
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
- `5`: needs the owner's approval (approval mode). Nothing was spent. Re-run the same command with `--approve <code>` after the owner says yes. The code works once, for that exact intent, for 15 minutes. For `pay`, the kit first asks the server its price with one unpaid request; the approval covers the URL, the request and that quoted price and payee. A higher price (or another payee) at pay time is refused (`price_changed`, exit 3) and nothing is signed. That first ask never carries your body or headers: a POST asks with an empty body, a GET with `--header` asks without them, and a PUT, PATCH or DELETE is not asked at all (it could act on the first request). So your data and keys only go out after the Sato Hub check and the approval. If the server does not state its price to that ask, the approval says the price and payee are NOT bound and names the cap, your per-transaction limit; with no per-transaction limit, such a payment is refused (`price_unknown_no_limit`). Header values are never stored or printed (names plus a hash only). `register` also asks in approval mode.

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
- **The owner's choices:** the USD limits (a swap counts against the same per-transaction and 24-hour limits as any spend; both legs of a round trip count, so buying $20 of a token and selling it back the same day uses about $40 of the 24-hour limit), and, only if the owner set them, a slippage cap and a trades-per-24h cap. Otherwise slippage is chosen per trade: 0.5% between majors, 1.5% with a token (plus a Solana token's own transfer fee), never above 5%.
- **The owner is asked, even in auto mode,** before a trade with slippage above 3%, a price impact or value gap above 3%, a simulated sell-back loss above 3% (Base), a Base token trade whose quote gives no USD figures to check price impact against, a Solana token transfer fee above 3%, or a Solana token whose issuer can move, freeze or pause holders' tokens, run code on every transfer, or hide balances (PermanentDelegate, TransferHook, a freeze authority, Pausable, confidential transfers). The approval covers the figure the owner saw, rounded up to the next whole percent; a worse quote asks again.
- **An independent price.** Chainlink ETH/USD or SOL/USD, read on Base. Selling ETH or SOL is valued at that price, never at the quote. With no fresh price, there is no swap. Between USDC and ETH/SOL, a quote more than 3% (ETH) or 5% (SOL) from it is refused. **A token has no independent price:** a token sale is valued from the USDC/ETH/SOL its quote pays out, and the limits are checked on that before anything is signed.
- **Tokens:** the kit reads each token from the chain itself (decimals, program, authorities, Token-2022 extensions); a resolver or link is only a hint.
  - **Base buys:** before signing, the kit simulates buying the token and then, in a later simulated block, selling it straight back. A token that can't be sold back, or whose round trip loses far more than slippage and fees, is refused. A fee the token takes on transfer shows up in that round-trip loss; above 3% the owner is asked.
  - **Solana:** a token that can't be transferred, starts frozen, is paused right now, can be minted confidentially, or has an extension the kit doesn't know is refused. A transfer fee, a freeze authority and a mint authority are shown to the owner, and the issuer powers above ask for the owner's yes.
  - **Names:** every token other than USDC, ETH and SOL is shown with its short address beside its symbol (`DEGEN 0x4ed4…efed`), in the approval and the ledger too, because anyone can give a token any symbol.
  - **Links:** a link is resolved by Sato Hub, and its signed answer is required; the address it resolved to is printed. An unsigned answer is refused: send the contract address instead.
- **Sato Hub's signature** on the quote and on its fee disclosure.
- **The minimum you receive is the kit's, and it is written into the transaction.** The kit computes it from the quote less your slippage cap, then decodes the transaction it is about to sign. The minimum written into the transaction must be at least the kit's (on Base, KyberSwap's rounding may put it 1 base unit lower), and the output must go to the agent's own wallet; otherwise nothing is signed. Onchain, the swap reverts rather than pay less than that minimum.
- **On Base:** the transaction must go to the pinned KyberSwap router on chain 8453, with the right value. The kit decodes the router call: tokens, amount, recipient, minimum and fee must all match what was asked. It then runs its own simulation (`eth_simulateV1`) of the approval plus the swap: the wallet may lose at most the amount sold, must receive at least the minimum, and must lose nothing else. Approvals are for the exact amount only, never unlimited, and are set back to 0 afterwards. If a swap ends unclear (exit code 4) or the reset fails, the command says so; check the allowance before the next swap. One Base swap runs at a time.
- **On Solana:** the kit builds the transaction through Jupiter itself. It decodes it with its lookup tables and allows only pinned programs (and only the exact wrap, unwrap and create-account steps). It also decodes the Jupiter route: the amount, minimum, slippage, fee and destination must all match. The agent must be the only signer and the fee payer, the priority fee is capped, and the kit runs its own simulation of the balance changes and of who controls its token accounts afterwards. A transaction close to expiry is rebuilt, checked again (with a new price reading) and reported to you, never re-signed.
- **The Sato Hub fee** is tiered: **0.03%** for stablecoin pairs, **0.15%** for ETH/WETH/SOL ↔ USDC, **0.75%** for any other token. It is always shown before the trade, as a percent and in bps, and taken inside the swap, always in USDC, ETH or SOL: on the input when you buy a token, on the output when you sell one, never in the token you buy. A round trip (buy, then sell) pays it twice. Sato Hub sets its rate and states it, with its tier, in its signed quote; the kit checks:
  - the fee written into the transaction is exactly the disclosed one, on the disclosed side, paid to the pinned Sato Hub address and to no one else;
  - the pair's tier, read by the kit itself (stablecoin, ETH/SOL with USDC, or a token). A quote that names a MORE expensive tier than that is refused (`fee_tier_mismatch`). A cheaper one is accepted (Sato Hub counts more coins as majors, such as USDT or DAI, so USDC → USDT can be a 0.03% stablecoin trade to it and a token trade to the kit), held to the ceiling of the tier Sato Hub named; the fee is still taken only in USDC, ETH or SOL. A pair with neither side USDC, ETH or SOL (USDT ↔ DAI) is refused before any quote;
  - a stablecoin or ETH/SOL ↔ USDC fee above **0.15%** is refused (`fee_over_major_ceiling`), and **any fee above 1%** is refused (`fee_over_ceiling`). Within those ceilings Sato Hub can change its rate without a kit update; the approval binds the tier and the most that tier may cost.
- **What this does not cover:**
  - The simulation runs on the RPC you use (a public one by default), and prices can move between the quote and the block.
  - Whoever builds the route (Sato Hub and KyberSwap on Base, Jupiter on Solana) could route it so you get exactly the minimum and no more. On Base the kit only lets the tokens go to KyberSwap's own executor contract, which narrows this.
  - The minimum written into the transaction bounds a single swap: the quote less the slippage. Between USDC and ETH/SOL the quote must also sit within 3% (ETH) or 5% (SOL) of the independent price; a token has no independent price, so for a token the quote itself is the reference. The 24-hour limit bounds the total.
  - A token's sale can be blocked later by things no simulation sees today: an owner who turns trading off, a blacklist, a time lock, an upgradeable contract, a freeze. The sell-back test and Sato Hub's evidence describe the token now, not what its issuer may do next.
- **Sato Hub checks and swaps:** `token` shows Sato Hub's evidence about a token (dated, not a verdict). The swap itself is held to the kit's own checks above, so `--check-gate` and `--skip-check` do not apply to swaps.
- **What a token check can't tell you:** whether a token is a good buy, whether its team is honest, or whether its price will hold. The kit never suggests what to buy or sell.
- **Sato Hub keeps a public record of every swap quote it gives:** the venue, the pair, the amounts and the fee, never the wallet address. A `--dry-run` asks for a quote too, so it is recorded the same way.

## How purchases are checked

A purchase is a spend: it counts against the same per-transaction and 24-hour USD limits, is reserved under the same lock before anything is signed, and goes to the ledger like any other. On top of that:

- **Price first.** The owner sees the price before anything is paid: for a gift card, the value and the USDC price of Bitrefill's invoice; for an Amazon order, the item, tax, shipping, the total and where it ships; for a checkout, the amount and the merchant's label (and, for a Solana Pay transaction request, the cost the kit's own simulation measured). Purchases ask the owner first unless BOTH `--purchases` and `--approval` are on auto (the stricter choice wins); the owner's yes is bound to that exact price (and, for an order or a Solana Pay transaction request, to who is paid, shown on the card), and a run that gets another price or payee asks again.
- **Paid is not delivered.** A paid card that isn't delivered yet (within the wait, at most about 4 minutes), or whose code could not be saved, exits 4 and says "paid, not delivered yet — do not buy again", so a bot that follows exit codes does not buy it again. The kit does not stop a second, separate purchase of the same card. Polling stops at that deadline, and a refused Bitrefill sign-in is retried at most once per command.
- **Dry runs ask for real quotes.** An order dry run sends the shipping address to Sato Hub and creates a Crossmint quote; a gift card dry run signs in to Bitrefill and creates an unpaid invoice. Neither signs or pays anything.
- **No Sato Hub fee** on gift cards or Amazon orders. An Amazon quote that carries any Sato fee is refused. Sato Hub may earn Bitrefill's affiliate commission on delivered gift cards instead (paid by Bitrefill, not added to your price).
- **Gift cards (Bitrefill, Base).**
  - Bitrefill asks the wallet to sign in. This is the only plain message the kit ever signs (everything else it signs is a payment or a transaction), and only when it is a standard sign-in (EIP-4361) for `api.bitrefill.com`, on Base (chain 8453), for the agent's own address, mentioning no site but Bitrefill, and expiring within the hour. Anything else is refused (exit 3). The sign-in token is kept in a 0600 file with its expiry.
  - The price is read in explicit units: the x402 terms Bitrefill will charge for the invoice (one unpaid ask, nothing signed) give it in USDC base units, the invoice's own `price_usdc` (seen both as base units like `5250000` and as decimals) and `price_usd` must agree with them, and the limits, the card and the payment cap all use the same amount in dollars ($5.25, never 5,250,000). Anything that cannot be read as one amount is refused (`giftcard_price_unclear`).
  - The payment is the kit's own x402 payment (see "How the limits work"): bound to the invoice's price, to Bitrefill's payee `0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A`, in USDC on Base. A higher price or another payee at pay time is refused before anything is signed.
  - The code is a bearer secret: it is printed once, on the last line of the command's output, and kept in `giftcards/<invoice>.json` (0600). It never goes in the ledger, an error message or Sato Hub.
- **Amazon orders (through Sato Hub and Crossmint).**
  - The shipping address lives only in `settings.json` (0600). It is sent only inside the order request to Sato Hub; never to the ledger, another command's output, an error message (text a server echoes back is scrubbed of it) or telemetry. `status` only says whether it is set.
  - Sato Hub's quote must carry its signature (the same one it signs swap answers with), be for this wallet and chain, be unexpired, carry no fee, add up (item + tax + shipping = total), and name the same address: `recipient_sha256` is checked against the SHA-256 of the address this bot holds, in the form Sato Hub passes to the merchant (`{ email, physicalAddress: { name, line1, line2?, city, state, postalCode, country } }`, canonical JSON: keys sorted at every level, no whitespace, absent keys left out). The state and country are stored as upper-case two-letter codes so both sides hash the same bytes.
  - The product is sent as its ASIN, from an amazon.com product link (`/dp/<ASIN>`) or given directly. Short links (a.co, amzn.to) are never opened, by the kit or by Sato Hub: send the full link or the ASIN.
  - A quote marked as anything but a production order (Sato Hub's test lane) is refused.
  - The payment transaction Crossmint builds is decoded and simulated before signing. It may move only USDC (Base `0x8335…2913`, Solana `EPjF…Dt1v`), at most the quoted total, out of the agent's wallet, plus network fees and, on Solana, if the merchant's USDC account must be created, about 0.002 SOL of rent. The item must be the ASIN asked for. On Base the kit's own `eth_simulateV1` must show USDC-only loss and no allowance left behind (any approval the transaction gives is read back after it, and must be 0), and the payment is signed with the simulated gas plus 30% (never an estimate from the target contract). On Solana only Token, Token-2022, Associated Token, ComputeBudget (priority fee capped) and Memo may be called, the agent's must be the only signature added (any other must already be there and valid), and the simulated balance changes must show USDC-only loss. The checks do not depend on the transaction's shape: a plain transfer and a payment-contract call are held to the same balance changes.
- **Checkouts.**
  - A Solana Pay transfer request is paid in USDC or SOL only, built by the kit itself: `TransferChecked` (or a SOL transfer) with each `reference` attached as a read-only key and the memo just before it, to a wallet address (never a token account). Amounts are plain decimals (no exponent) with no more decimals than the token has. A SOL amount is valued at Chainlink's SOL/USD price for the limits.
  - A Solana Pay transaction request is fetched over https only, and the merchant's transaction is treated as untrusted: allowed programs only (the list above, plus plain SOL transfers), the agent as fee payer and the only signature added, simulated, and approved at the cost the simulation showed.
  - An EIP-681 link is paid only for USDC on Base (`ethereum:<USDC>@8453/transfer?address=…&uint256=…`), for the exact amount, through `send` (with its recipient check). A mixed-case recipient must carry a correct EIP-55 checksum.
  - A deposit address (`checkout --to --amount --chain`) is paid the exact amount, with `send`'s checks, as a purchase.
  - A checkout is recorded as kind `checkout` with its subtype (`eip681`, `solana_pay`, `deposit`), shown as `checkout:<subtype>` in `status`, `history` and `proof`, never as a send. It counts toward the limits like any spend.
  - A top-up's phone number is bound into the approval by an HMAC under a random key kept on this computer (`local-hmac.key`, 0600), never as plain text or a plain hash.
- **What this does not cover:**
  - **Delivery.** Paid is not delivered. A gift card can be delayed or fail; an Amazon parcel can be late, lost or wrong. The kit reports what Bitrefill and Sato Hub report (`giftcard status`, `orders`), nothing more.
  - **Returns and refunds.** Bitrefill and Crossmint refund failed orders to the paying wallet, on their own timelines; returns of a delivered item follow the merchant's rules, not the kit's.
  - **Merchant behaviour.** The kit checks what is signed, not what a merchant does afterwards: whether a code works, whether a shop ships, whether a Solana Pay merchant honours its reference. A simulation runs on your RPC at one moment.
  - **What to buy.** The kit never suggests what to buy, and buys only what the owner asked for.

## Files, network and privacy

- `wallet.json` (mode 600): the keys. Never printed, never sent anywhere.
- `policy.json`: the owner's choices. `ledger.jsonl`: every spend, limit change, skipped check and approval. `approvals.json`: pending approval codes.
- `settings.json` (mode 600): the shipping address for Amazon orders. `bitrefill-session.json` (mode 600): Bitrefill's sign-in token and its expiry. `giftcards/` (mode 700, files 600): delivered gift card codes. `local-hmac.key` (mode 600): a random key made once, used to bind a top-up's number into an approval without writing it down.
- They live in `~/.sato-agent/` by default. With the Grok Bot launchers from BOT.md, each Bot's files live in `~/.sato-agent/<NAME>/`.
- `SATO_AGENT_HOME` gives each agent its own folder. Two Bots on one computer should each use their own, so they get separate wallets and limits.
- Network calls:
  - Base and Solana RPCs (`SATO_AGENT_BASE_RPC`, `SATO_AGENT_SOLANA_RPC` to override; public endpoints by default);
  - `https://registry.npmjs.org/` for `check` (package versions and tarballs; only the package names you ask about);
  - the x402 resources you pay;
  - `https://satohub.ai/api/mcp` for checks (it receives the URL, recipient or install command being checked, never a key), and for swap quotes and fee disclosures (it receives the pair, the amount and the agent's address; its public route record shows the pair and amounts, never the address);
  - for Solana swaps, Jupiter (`api.jup.ag`), which builds the transaction for the agent's address;
  - for gift cards, `https://api.bitrefill.com` (the agent's Base address, the product, value and invoice; a top-up's number);
  - for Amazon orders, Sato Hub's order endpoint on the same host as `SATO_AGENT_MCP_URL` (`https://satohub.ai/api/commerce/order` by default; it receives the product, the chain, the agent's address and the shipping address, and passes them to Crossmint);
  - for a Solana Pay transaction request, the merchant's https link (it receives the agent's Solana address).
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
