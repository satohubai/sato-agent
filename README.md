# Sato Agent

**Turn a Grok Bot into an onchain agent.** A Grok Bot already has its own always-on computer. Sato Agent gives it a wallet there (Base, BNB Chain, Arbitrum, Polygon and Solana), lets it trade tokens, buy gift cards and (once switched on) Amazon orders, pay checkouts and APIs (x402), register an onchain identity (ERC-8004), and send stablecoins, all inside spending limits its owner sets. Sato Hub checks tools, payments and recipients before the agent acts.

It works on any always-on machine with Node 20.18+, not only Grok Bot.

## Quickstart (Grok Bot)

Tell your Bot:

> Read https://github.com/satohubai/sato-agent/blob/main/BOT.md and follow the setup. NAME = bot, CHAIN = several.

That sets up **Sato Bot**: one Bot on every chain you choose. It asks which chains, installs the kit, creates its wallet, asks you for your limits (they cover all its chains together), and asks you to fund it on each chain. You fund it with what you are willing to let it spend. If someone shared this bot with you, tell the Bot their referral name (like `sunny-otter`) when it asks: they get 30% of Sato Hub's swap fee on your agent's swaps, at no cost to you. See "Referral share" below.

Prefer one chain per Bot? Use one of the chain Bots instead (for example `NAME = base, CHAIN = base`): one chain and one wallet for each Bot.

One agent or five Bots, one kit:

| Bot | Message | Gas | Stablecoin | Today |
|---|---|---|---|---|
| **Sato Bot** | `NAME = bot, CHAIN = several` | each chosen chain's gas coin | each chosen chain's stablecoin | on each chain you choose, what that chain's row says; your limits cover all of them together; it can move its own funds from Base, Arbitrum or Polygon to another of its chains (`bridge`, v0.5) |
| **Sato Base Bot** | `NAME = base, CHAIN = base` | ETH | USDC | buy or sell any Base token against USDC or ETH (by address or link), gift cards / eSIMs / top-ups (Bitrefill), USDC payment links (EIP-681), x402 payments, sends of the coin, USDC or any token, ERC-8004 identity, Sato Hub checks |
| **Sato BNB Bot** | `NAME = bnb, CHAIN = bnb` | BNB | USDT (18 decimals) | buy or sell any BNB Chain token against USDT, USDC or BNB, USDT / USDC payment links, sends of the coin, USDT or any token, ERC-8004 identity, Sato Hub checks. **No x402** (BNB Chain's USDC is Binance-Peg: it cannot sign the payment the kit uses, and no service takes it) and **no gift cards** (Bitrefill does not take BNB Chain: the bot points the owner to the Sato Base Bot) |
| **Sato Arbitrum Bot** | `NAME = arbitrum, CHAIN = arbitrum` | ETH | USDC | buy or sell any Arbitrum token against USDC, USDT or ETH, gift cards / eSIMs / top-ups (USDC on Arbitrum), payment links, x402 payments in USDC, sends of the coin, USDC or any token, ERC-8004 identity, Sato Hub checks |
| **Sato Polygon Bot** | `NAME = polygon, CHAIN = polygon` | POL | USDC | buy or sell any Polygon token against USDC, USDT or POL, gift cards / eSIMs / top-ups (USDC on Polygon), payment links, x402 payments in USDC, sends of the coin, USDC or any token, ERC-8004 identity, Sato Hub checks |
| **Sato Solana Bot** | `NAME = solana, CHAIN = solana` | SOL | USDC | buy or sell any Solana token against USDC or SOL via Jupiter (by mint or link), Solana Pay requests (USDC or SOL), x402 payments in USDC on Solana (`pay --chain solana`), sends of the coin, USDC or any token (wallet recipients only), Sato Hub checks |

The Bots run Sato Agent, this kit. Each Bot's name is yours to choose; these are the names the setup prompt uses. Amazon orders (when Sato Hub switches them on) are Base and Solana only.

Each Bot keeps its own wallet, limits and ledger, even on the same Grok Bot computer. The Base, BNB Chain, Arbitrum and Polygon Bots all use the kit's one EVM key, so a wallet has the same address on all four: fund it on the chain the Bot works on (Sato Bot: on each chain you chose).

### Chains

| Chain | Key (`--chain`) | Gas | Default stablecoin | Also a stable | Swaps | x402 | Gift cards | Payment links | ERC-8004 |
|---|---|---|---|---|---|---|---|---|---|
| Base | `base` | ETH | USDC | none | yes | yes | yes | yes | yes |
| BNB Chain | `bnb` | BNB | USDT | USDC (Binance-Peg) | yes | **no** | **no** | yes | yes |
| Arbitrum | `arbitrum` | ETH | USDC (Circle) | USDT (USDT0) | yes | yes | yes | yes | yes |
| Polygon | `polygon` | POL | USDC (Circle) | USDT (USDT0) | yes | yes | yes | yes | yes |
| Solana | `solana` | SOL | USDC | none | yes | yes | no | yes | no |

- **BNB Chain's stablecoins have 18 decimals.** Every amount is counted in the token's own decimals and every limit is in USD, so `--amount 1.5` is 1.5 USDT there and 1.5 USDC elsewhere; more decimals than the token has is refused, never rounded.
- **The bridged USDC.e** on Arbitrum and Polygon is not Circle's USDC and is never treated as the stablecoin.
- **Swaps are refused when the chain's own simulation (`eth_simulateV1`) cannot run**, never guessed. The public endpoints the kit tries first answer it on BNB Chain and Arbitrum; Polygon's public endpoints are rate limited, so a keyed endpoint is the dependable choice there. Avalanche is not supported.
- **RPC.** Each chain has a list of public endpoints, tried in order; one that rate-limits, times out or fails its handshake is skipped for the next. A transaction is sent once per endpoint, even with a single endpoint (the client's own retries never re-send it), and is only sent on to the next endpoint when the first one provably did not take it (an HTTP 429, a rate-limit code, or no connection at all), never after a timeout and never because of what an error's words say; if a send did touch more than one endpoint, a later "nonce too low" or "already known" is reported as unclear (exit code 4), not as a refusal. Each endpoint is asked which chain it is on (`eth_chainId`) before its first use, and one that answers as another chain is skipped; if none answers as the chain you asked for, nothing is read or sent. Use your own with `SATO_AGENT_BASE_RPC`, `SATO_AGENT_BNB_RPC`, `SATO_AGENT_ARBITRUM_RPC` or `SATO_AGENT_POLYGON_RPC` (one URL, or several separated by commas).
- **Which RPC to use.** The public endpoints answer both the simulation and the price reads, so whoever runs the endpoint you use is part of what those two checks rest on. They work, but they rate-limit and can lag: give each bot its own keyed endpoint (`SATO_AGENT_<CHAIN>_RPC`, such as `SATO_AGENT_POLYGON_RPC`), which is recommended for any bot that swaps.
- **Gas.** A swap's gas limit comes from the kit's own simulation, within a cap per chain (2,000,000 gas on Base, BNB Chain and Arbitrum, 5,000,000 on Polygon, whose routes can use more). On Arbitrum the gas also pays for posting the transaction's data to Ethereum, which the simulation does not show, so every transaction the kit signs there (the approval, the swap, the reset) carries the larger of its simulation-based limit and the node's own `eth_estimateGas` for that exact transaction; if the node will not estimate a swap or an approval, or estimates more than 10,000,000 gas, nothing is signed.
- **Arbitrum's ETH price** is read together with Chainlink's sequencer uptime feed: no price while the sequencer is down, or for an hour after it restarts.
- **Fees** are the same on every chain: 0.03% stablecoin pairs, 0.15% the chain's coin with a stablecoin, 0.75% any other token, never taken in the token you buy.

## Quickstart (any machine)

```sh
npm install --ignore-scripts --prefix ~/.sato-agent-cli github:satohubai/sato-agent#v0.5.1
alias sato-agent=~/.sato-agent-cli/node_modules/.bin/sato-agent
# npm may print "ERESOLVE overriding peer dependency" three times (the Solana x402
# library's helpers ask for an older @solana/kit). That is expected; the tests run on these versions.

sato-agent init                                     # this agent's own wallet
# The chains and both limits come from the owner; there are no defaults. "none" = no limit.
sato-agent policy set --chains <base|bnb|arbitrum|polygon|solana, or a comma-separated list> --per-tx <owner's amount> --per-day <owner's amount>
sato-agent policy set --approval ask --check-gate no                   # optional: ask first; let a `no` check stop a spend
sato-agent balance
sato-agent pay https://some-x402-api.example/data --chain base     # x402, USDC on Base
sato-agent pay https://some-x402-api.example/data --chain solana   # x402, USDC on Solana
sato-agent send --chain solana --to <address> --amount 5                # USDC
sato-agent send --chain base --to <address> --amount all --asset ETH    # the coin, keeping a reserve for gas
sato-agent send --chain base --to <address> --amount 100 --asset 0x…   # any token, by its contract address
sato-agent register --name "My agent" --description "What it does"
sato-agent giftcard search amazon --country US                      # gift cards on Base, Arbitrum or Polygon: search (with the values on offer)
sato-agent giftcard detail amazon_com-usa                           # the exact values it can be bought for
sato-agent giftcard buy amazon_com-usa --value 5                    # the price card; the owner's yes is --approve <code>
sato-agent buy "solana:<recipient>?amount=5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"   # a Solana Pay request
```

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the agent's EVM key (one address on Base, BNB Chain, Arbitrum and Polygon) and Solana key in its folder (`~/.sato-agent/`, or `SATO_AGENT_HOME`). Never replaces an existing one. |
| `address` / `balance` | Address and USDC + gas balance for this agent's chain(s) |
| `policy set --chains <base\|bnb\|arbitrum\|polygon\|solana, or a comma-separated list> --per-tx <usd\|none> --per-day <usd\|none>` | The owner's choices (per day = rolling 24 hours). **There are no defaults:** nothing is spent until chains and both limits are set. |
| `policy set [--allow <addrs>\|any] [--approval ask\|auto] [--check-gate off\|no\|caution] [--on-check-unavailable allow\|refuse]` | Optional choices: a recipient allowlist; ask the owner before every spend; let a Sato Hub `no` (or `caution`) stop a spend; what to do when the check can't run. **Anything that loosens a choice is logged as a raise.** |
| `pay <url> [--chain base\|arbitrum\|polygon\|solana] [--method --data --header]` | Pays an x402 resource in USDC on Base, Arbitrum, Polygon or Solana mainnet (not BNB Chain: refused with the reason), after the kit asks the server's price (one unpaid request) and Sato Hub reads its payment terms. Any other token or chain is refused before an approval is asked for. A server that does not ask for payment is not paid. `--dry-run` shows the quoted price, chain and payee. The chain is the owner's: an agent set to one chain pays there (`--chain` may be left out), an agent set to several chains must say `--chain`, and a `--chain` the owner did not choose is refused before anything is reserved. A JSON `--data` gets a JSON content-type |
| `token <address\|mint\|link> [--chain base\|bnb\|arbitrum\|polygon\|solana]` | A token card: what the token is (read from the chain), its price and liquidity with source and date, and Sato Hub's evidence about it. A bare 0x address is on the agent's own EVM chain (an agent set to several EVM chains must say `--chain`). Links from DexScreener, GeckoTerminal, Birdeye, pump.fun, gmgn, Basescan, BscScan, Arbiscan, Polygonscan, Solscan, jup.ag, Uniswap, Aerodrome, Zora and Clanker are resolved by Sato Hub, then re-read from the chain. |
| `swap --chain base\|bnb\|arbitrum\|polygon\|solana --from <asset> --to <asset> --amount <n\|all> [--slippage-bps <n>] [--no-referrer] [--dry-run]` | Buy or sell any token, with a main asset of the chain on one side (USDC, ETH or WETH on Base; USDT, USDC, BNB or WBNB on BNB Chain; USDC, USDT, ETH or WETH on Arbitrum; USDC, USDT, POL or WPOL on Polygon; USDC or SOL on Solana). An asset is a symbol for those majors, or a token's address, mint or link. `--amount all` sells a token's whole balance. On once the spending limits are set; `policy set --swaps off` turns it off. See "How swaps are checked" below. |
| `bridge --chain base\|arbitrum\|polygon --to-chain <chain> --asset <USDC\|USDT\|ETH> --amount <n\|all> [--receive <asset>] [--approve <code>] [--dry-run]` / `bridge status [--id <id>]` | Moves the agent's own funds from one of its chains to another through deBridge, to its own address there. Run it with `--dry-run` to see the amount leaving, deBridge's fixed fee, the exact amount arriving and the total cost. On for an agent set up with v0.5.0; off for one set up earlier until `policy set --bridges on`. See "Bridge (v0.5)" below. |
| `buy <request\|link\|ASIN>` | Reads what it is given and hands it on, changing nothing itself: a `solana:` or `ethereum:` request to `checkout`, an Amazon link or ASIN to `order`, any other https link to `pay` (x402, including a Coinbase Business checkout's `x402_url`). A link paid through `buy` is a purchase: price card, and the owner's yes unless both choices are auto. Anything else gets a list of what it accepts. |
| `giftcard search <words> [--country] [--kind giftcard\|esim\|topup]` / `giftcard detail <product id>` / `giftcard buy <product id> --value <n> [--refill <number>]` / `giftcard status <invoice>` | Gift cards, eSIMs and phone top-ups from Bitrefill, paid in USDC on Base, Arbitrum or Polygon (the Bot's own chain; `--chain` if the owner chose more than one) over x402 with no Bitrefill account. The price card comes first; the code is printed once, on the last line, and kept in a 0600 file. Paid but not delivered within `--wait` (default and most 240 s) exits **4**: do not buy again, check with `giftcard status`. `search` and `buy` (a dry run too) sign in to Bitrefill (a sign-in message, not a payment); a dry run creates an unpaid invoice. Not on BNB Chain or Solana: that agent is told so and pointed to the Sato Base Bot. See "How purchases are checked". |
| `order --available` / `order <amazon.com link\|ASIN> [--chain base\|solana]` / `orders [id]` | Amazon US, shipped to the owner's address, through Sato Hub (Crossmint), when Sato Hub has switched it on. `order --available` asks Sato Hub (`GET /api/commerce/order`, advisory and unsigned) and prints `Amazon orders: on` or `off (not switched on yet)`; it exits 0 either way and 1 if Sato Hub does not answer; anything but exactly `"on"` counts as off. BOT.md has the bot mention Amazon only when it is on. An order is refused with exit 3 until it is. `orders` shows status, delivery and refunds. An order `--dry-run` sends the shipping address to Sato Hub and creates a Crossmint quote (it expires unpaid). |
| `checkout <solana:...\|ethereum:...>` / `checkout --to <address> --amount <usdc> --chain base\|bnb\|arbitrum\|polygon\|solana` | Pays a Solana Pay request (a transfer request in USDC or SOL, or a transaction request link), an EIP-681 stablecoin payment link on Base, BNB Chain, Arbitrum or Polygon (the token and the chain id in the link must be one the kit knows), or an exact amount to a deposit address. Use the last for a **Stripe deposit address**: Stripe matches only the exact amount, on the right network. |
| `settings set --stdin` / `settings set --ship-name --ship-line1 [--ship-line2] --ship-city --ship-state <XX> --ship-zip --ship-country --ship-email` / `settings show` / `settings set --ship-clear` | The shipping address for Amazon orders, kept only in `settings.json` (mode 600) on this computer. `--stdin` reads it as a JSON object (`name, line1, line2, city, state, postalCode, country, email`) so it never sits in a command line. |
| `settings set --referrer <name\|address\|none>` | The referral name (like `sunny-otter`) or payout address (Base or Solana) of whoever shared this bot with the owner, or `none` to remove it. A name is checked with Sato Hub before it is saved. `--stdin` also accepts a `referrer` key. See "Referral share" below. `settings show`, `status` and `help` show it. |
| `referral create --chain base\|bnb\|arbitrum\|polygon\|solana [--payout <address>]` / `referral set-payout <address>` / `referral show` / `referral share-text` / `referral offer --when setup\|swap` / `referral decline` | Share this bot: Sato Hub gives it a referral name, and bots copied from its share are referred by that name. `create` signs one message with the bot's own key on that chain (no payment, no gas); the payout defaults to that wallet's address. `share-text` prints the three texts a share carries. `offer` prints a one-time offer when the bot has no name and has not said no; `decline` records the no. Nothing here posts or sends anything. See "Referral share" below. |
| `policy set --bridges on\|off` | Turns `bridge` on or off for this agent. A new policy has it on; a policy written before v0.5.0 has it off until this says on. Off to on is logged as a raise. |
| `policy set --purchases ask\|auto` | Purchases (gift cards, Amazon orders, checkouts, links paid through `buy`) ask the owner first unless BOTH `--purchases` and `--approval` are on auto. Unset means ask; ask → auto is logged as a raise. `pay` and `send` keep following `--approval`. |
| `send --chain base\|bnb\|arbitrum\|polygon\|solana --to <addr> --amount <amount\|all> [--asset <symbol\|0xToken\|mint>] [--dry-run]` | Sends anything in the wallet, after Sato Hub checks the recipient. With no `--asset`: the chain's stablecoin (USDC; USDT on BNB Chain), as before. `--asset`: the chain's coin (`ETH`, `BNB`, `POL`, `SOL`), a stablecoin, the wrapped coin, or any ERC-20 by its contract address (any SPL or Token-2022 token by its mint on Solana). **No Sato Hub fee; network gas only.** See "Sending any token" below |
| `register --name --description [--image] [--service name=endpoint] [--x402-support] [--chain base\|bnb\|arbitrum\|polygon]` | Registers in the ERC-8004 IdentityRegistry (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, the same address on every chain) on the agent's EVM chain, with the registration file stored onchain. An agent set to several EVM chains says `--chain` |
| `check "<install command>" [--cluster mainnet-beta\|devnet] [--skip-check]` | First, Solana build receipts for the npm packages in the command (see below). Then Sato Check: does an install take a key, does the key leave, can it move funds on its own |
| `recommend "<goal>"` | A stack for a build goal from Sato Hub's index |
| `status` | Limits, spend in the last 24 hours, limit changes, recent spends |

Add `--json` to any command for machine-readable output.

**Upgrading to v0.5.1:** nothing changes for a working agent. `bridge` refuses a POL bridge from Polygon up front, with the way round it (swap to USDC, then bridge), instead of after the quote; and an approval for a bridge that costs more than 3% is bound to a cost ceiling (what the owner saw, rounded up, plus 2 points; printed with the code) rather than to the exact percent, so a quote that moves a point between the yes and the run does not ask again.

**Upgrading to v0.5.0:** nothing changes for a working agent: its wallet, limits, chains, ledger and approvals stay as they were, and so does what its commands print. v0.5.0 adds `bridge`: an agent with two or more chains can move its own funds from Base, Arbitrum or Polygon to another of its chains (see "Bridge (v0.5)"). It is off after the upgrade, because the owner has not chosen it: `policy set --bridges on` turns it on (logged as a raise). A single-chain agent has nothing to bridge to. `history` and `status` show bridge rows.

**Upgrading to v0.4.4:** a send of a token with no price now always stops for the owner's approval (exit 5), even with `--approval auto`, because the USD limits cannot measure it. `token <0x…>` with no `--chain` now asks Sato Hub about the agent's own EVM chain (it assumed Base before, so a BNB Chain, Arbitrum or Polygon card lost Sato Hub's name, price and liquidity).

**Upgrading to v0.4.3:** nothing changes for a working agent. A transaction that landed is no longer reported as "no receipt" (exit 4) when one RPC endpoint answers "Invalid parameters": the kit asks the next one and keeps waiting (seen on Polygon). Gift cards accept Bitrefill's 1800 s payment authorization (gift cards only; the price and payee stay bound; every other x402 payment keeps the 300 s limit). A seller that answers 402 after a signed payment is reported plainly. Polygon's default endpoints drop polygon-rpc.com (its public key is disabled) and add 1rpc.io/matic. With a single endpoint of your own (`SATO_AGENT_POLYGON_RPC` set to one URL) there is no next endpoint to ask, so list two, comma-separated, if you can.

**Upgrading to v0.4.2:** nothing changes for a working agent: its wallet, limits, chains, ledger and approvals stay as they were, and `send` with no `--asset` binds and prints what it did before. v0.4.2 adds sending the chain's coin and any token in the wallet, with no Sato Hub fee (network gas only). v0.4.1 only added `SATO_AGENT_UA`. `init` on a folder that already holds a wallet now says plainly that it may be another bot's, and what to do (a new NAME); it still never replaces a wallet.

**Upgrading to v0.4.0:** nothing changes for a Base or Solana agent: its wallet, limits, chains, ledger and approvals stay as they were, and so does what its commands print. The new chains are off until the owner adds them with `policy set --chains` (adding one is logged as a raise). A v0.1 policy with no chains still means Base and Solana only.

**Upgrading from v0.1.0:** a v0.1.0 policy never chose its chains, so spending is refused (`chains_not_set`) until you run `policy set --chains <base|solana|base,solana>` (or a list that includes the new chains).

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
- Payment authorizations must expire within 5 minutes. The one exception is a gift-card invoice from Bitrefill, whose price and payee are bound before anything is signed: up to 30 minutes, because Bitrefill asks for that.
- A signed payment always counts, even if the server rejects it, because the server could still settle it.
- On Base, the agent signs EIP-3009 authorizations to valid Base addresses; a permit2 offer, or a recipient that is not a Base address, is refused before anything is reserved. After signing, the amount, recipient, payer and expiry are compared with what was reserved; anything else is not sent, stays counted, and the command exits with code 4.
- A payment receipt counts as settled when it names a transaction id in that chain's own form. Any other id is not stored or shown, and the payment is treated as unsettled (exit 4). Text from a server (addresses, receipts, error messages) is shown and logged on one cleaned line.
- A Solana RPC that does not answer ends the payment: before signing, nothing is sent and the reservation is released; after signing, nothing is sent and it stays counted (exit 4).
- On Solana, the agent reads the transaction it just signed before sending it. It sends only one USDC transfer of the reserved amount from its own USDC account to the recipient's, with the fee payer the server named. Anything else is not sent, stays counted, and the command exits with code 4. The agent pays no SOL for an x402 payment: the server's facilitator pays the fee. A Solana payment is valid for about a minute (the life of its blockhash).
- Every `send` transaction is simulated before it is sent, and its hash is recorded before it is broadcast. (An x402 payment is checked as described above and sent to the server, which settles it.) Transactions from one wallet are signed one at a time, so two commands never reuse a nonce.
- If the outcome is unclear, the spend stays counted, and the command exits with code 4: **do not retry**.
- Solana sends to token accounts or other non-wallet addresses are refused.

## Sending any token

`send` moves anything in the wallet, not only the stablecoin. **A send is a plain transfer: No Sato Hub fee; network gas only.**

- **Assets.** `--asset` takes the chain's coin (`ETH` on Base and Arbitrum, `BNB`, `POL`, `SOL`), a stablecoin the chain lists, the wrapped coin (`WETH`, `WBNB`, `WPOL`, `wSOL`'s mint), or any ERC-20 by its contract address (any SPL or Token-2022 token by its mint on Solana). A token's decimals and symbol are read from the chain, never from a resolver, and a token is always shown with its short address beside the symbol (a symbol is whatever its creator wrote).
- **`--amount all`.** A token: the whole balance. The chain's coin: the balance less a gas reserve (what the transfer costs at the fee the node quotes now, twice over, plus a fixed pad on Base and Arbitrum, where a transaction also pays for posting its data to Ethereum; on Solana, the rent-exempt minimum and twice the network fee). The command prints what is sent and what stays; if nothing would be left it refuses. In `ask` mode the approval of a native `all` binds the word `all` and the units shown: a re-run may send fewer (gas rose) but never more. To move everything to another wallet, send each token, then the coin last with `--amount all`.
- **USD limits.** Stablecoins count 1:1, decimals-aware: the chain's own, and the extra ones the registry pins (src/chains.js: USDbC, DAI, USDS, USDT on Base; USDC.e, DAI, USDS on Arbitrum; USDC.e and DAI on Polygon; BUSD, FDUSD, DAI, USD1 on BNB Chain; USDT and PYUSD on Solana), each by its address or mint and refused as a stablecoin if its decimals differ from the pin. The chain's coin and its wrapped form count at the Chainlink price; with no price the kit does not send them. **A wrapped BTC (WBTC, cbBTC) and any other token has no price here: it counts $0 against the USD limits, is never refused for lacking one, and is recorded with `usd: null` and `unpriced: true`.** No venue is asked for a quote. It follows the owner's normal approval mode: `ask` stops with exit code 5, `auto` goes. The chain, the recipient allowlist and the Sato Hub recipient check apply to every asset.
- **Checks before signing.** The transfer is simulated before anything is signed: `eth_simulateV1` on EVM chains; on Solana `simulateTransaction` runs an unsigned copy (no signature, `sigVerify` off), and the transaction is signed only afterwards, with a fresh blockhash, once the limits, the owner's approval and the reservation have passed. A plan or a dry run never hands a signature to an RPC. A transfer that would revert is refused, and so is a token whose `transfer` answers `false`. On EVM chains the recipient's balance is read before and after in the simulation: a token that takes a fee on transfer is shown (the recipient receives less than is sent, and by how much), and the approval binds that figure. On Solana the recipient's associated token account is created only if it is missing; its rent (about 0.002 SOL) is shown, paid by the agent, and not counted against the USD limits. A mint whose new accounts start frozen is refused when the recipient's account would have to be created. A Token-2022 transfer fee is worked out for the amount (and the instruction names it, so the transfer fails if the fee changes); a transfer hook or a permanent delegate is shown. Hooks that need more than their validation account are refused by the simulation, not sent.
- **Ledger.** Each send records the chain, the asset (symbol and short address, with the full address or mint in `asset_address`), the amount, the USD figure (or null), the transaction and its explorer link; `status`, `history` and `proof` show it (`no price` for an unpriced token). The hash is recorded before the broadcast, with the same exit codes, and a send is never retried.

**What they don't do**
- The limits are enforced by this program, on the same computer that holds the key. **The agent itself can loosen any choice** with `policy set`: raise a limit, add a recipient or chain, loosen the check gate, or switch "ask" to "auto". In approval mode it could also type the approval code itself. Every loosening is logged and flagged in `status`, but it isn't blocked.
- The agent can also edit these files, or write its own code that uses the key.
- So the limits stop mistakes, runaway loops, and an agent that follows its rules. They don't stop a compromised agent, or a prompt injection it obeys.
- **The hard bound is what you fund the wallet with.** Use a wallet dedicated to the agent, never your main wallet, and fund it with what you're willing to let it spend.
- On Grok Bot, every Bot in your account shares one computer, so every one of your Bots can read the key file.

## Bridge (v0.5)

`bridge` moves the agent's own funds from one of its chains to another, through [deBridge](https://debridge.com) (DLN). It never sends to anyone else's address: the funds arrive at the agent's own address on the destination chain.

```
sato-agent bridge --chain base --to-chain arbitrum --asset USDC --amount 25 --dry-run   # the cost and what arrives; nothing is signed
sato-agent bridge --chain base --to-chain arbitrum --asset USDC --amount 25             # the same, for real
sato-agent bridge status                                                                # where each bridge is
```

- **Scope.** Source: Base, Arbitrum or Polygon (from Polygon, send USDC: deBridge sends POL through a contract this kit does not read yet, so swap POL to USDC, then bridge the USDC). Destination: another chain the owner chose with `policy set --chains` (Base, Arbitrum, Polygon, BNB Chain or Solana). A bridge from BNB Chain or from Solana is not supported yet and is refused with the reason: deBridge sends BNB Chain orders through a contract this kit does not read yet, and returns Solana transactions in a form this kit does not decode yet. Assets: a stablecoin on the source, or ETH from Base or Arbitrum (`USDC`, `USDT`, `ETH`); `--receive` names what arrives (a stablecoin or the destination's coin, such as `BNB` or `SOL`; with no `--receive`, a stablecoin arrives as the destination's stablecoin and a coin as the same coin). No other tokens.
- **Cost.** deBridge charges a fixed fee per order, paid in the source chain's coin on top of the amount (about a few dollars on Base and Arbitrum, cents on Polygon), and the destination's cost comes out of the amount arriving. Small bridges are expensive: 5 USDC from Base to Arbitrum arrives as about 4.68 USDC, after the 0.001 ETH fee. The dry run prints the amount leaving, the fixed fee, the exact amount arriving, and the total cost in dollars and percent. Over 3% of the amount the kit asks the owner's yes even with `--approval auto` (exit 5); when more than half would be lost it refuses.
- **Sato Hub's fee** is 0.25% (25 bps, cross-chain), taken from the amount sent and shown before anything is signed. It is paid to Sato Hub after the order is filled. The kit refuses a bridge fee above 0.25%.
- **How it is checked.** Sato Hub builds the unsigned order. The kit decodes it itself and signs nothing unless every line holds: the contract is deBridge's `DlnSource` on that chain, the function is `createSaltedOrder`, the amount leaving and the token match the request, the destination chain and the exact amount arriving match the quote, the recipient (and the order authority on the destination) is the agent's own address, the cancel beneficiary is empty or the agent, there is no external call and no permit, the fee and its recipient are Sato Hub's, and the fixed fee sent equals `globalFixedNativeFee()`, read onchain. The kit then simulates the source transaction and requires that nothing but the amount leaving the wallet moves. If the simulation cannot run, nothing is signed.
- **Limits and approvals.** A bridge counts toward the same 24-hour and per-transaction USD limits as every other spend (the amount leaving plus the fixed fee). With `--approval ask` it stops with exit 5 and an approval code, like a swap; a coin with no price always asks, and so does a quote that pays out more than it sends (such an order may never be filled) or that names a solver the kit has not seen deBridge use.
- **After it is sent.** The order is filled by a solver, usually within a minute. `bridge status` asks deBridge and says "waiting for a solver", "arrived on <chain>" or "cancelled; refunded on <chain>"; if deBridge cannot be reached it says so and does not guess. A cancelled order is refunded on the source chain. An order still not filled after 30 minutes is reported as such: the agent's own address on the destination is its authority and can cancel it on deBridge (app.debridge.finance) for a refund on the source chain, which needs a little gas on the destination. This version has no cancel command. Exit 4 means the transaction was signed and not confirmed: do not run it again. `history` and `status` show bridge rows with the source transaction and the state.
- **Gas.** The source chain needs its coin for gas and for the fixed fee. Receiving needs no gas.

## How swaps are checked

Nothing is signed until all of these pass:
- **The owner's choices:** the USD limits (a swap counts against the same per-transaction and 24-hour limits as any spend; both legs of a round trip count, so buying $20 of a token and selling it back the same day uses about $40 of the 24-hour limit), and, only if the owner set them, a slippage cap and a trades-per-24h cap. Otherwise slippage is chosen per trade: 0.5% between majors, 1.5% with a token (plus a Solana token's own transfer fee), never above 5%.
- **The owner is asked, even in auto mode,** before a trade with slippage above 3%, a price impact or value gap above 3%, a simulated sell-back loss above 3% (Base), a Base token trade whose quote gives no USD figures to check price impact against, a Solana token transfer fee above 3%, or a Solana token whose issuer can move, freeze or pause holders' tokens, run code on every transfer, or hide balances (PermanentDelegate, TransferHook, a freeze authority, Pausable, confidential transfers). The approval covers the figure the owner saw, rounded up to the next whole percent; a worse quote asks again.
- **An independent price.** Chainlink's native/USD feed, read on the chain itself: ETH/USD on Base and Arbitrum, BNB/USD on BNB Chain, MATIC/USD (Chainlink's POL feed) on Polygon, and SOL/USD, read on Base, for Solana. On Arbitrum the sequencer uptime feed is read first: no price while the sequencer is down or for an hour after it restarts. Selling the chain's coin is valued at that price, never at the quote. With no fresh price, there is no swap. Between a stablecoin and the chain's coin, a quote more than 3% (ETH, BNB), 5% (POL, SOL) from it is refused. **A token has no independent price:** a token sale is valued from the stablecoin or coin its quote pays out, and the limits are checked on that before anything is signed. Stablecoin amounts are counted in the token's own decimals (18 on BNB Chain) and valued at one dollar each.
- **Tokens:** the kit reads each token from the chain itself (decimals, program, authorities, Token-2022 extensions); a resolver or link is only a hint.
  - **EVM chain buys (Base, BNB Chain, Arbitrum, Polygon):** before signing, the kit simulates buying the token and then, in a later simulated block, selling it straight back. A token that can't be sold back, or whose round trip loses far more than slippage and fees, is refused. A fee the token takes on transfer shows up in that round-trip loss; above 3% the owner is asked.
  - **Solana:** a token that can't be transferred, starts frozen, is paused right now, can be minted confidentially, or has an extension the kit doesn't know is refused. A transfer fee, a freeze authority and a mint authority are shown to the owner, and the issuer powers above ask for the owner's yes.
  - **Names:** every token other than USDC, ETH and SOL is shown with its short address beside its symbol (`DEGEN 0x4ed4…efed`), in the approval and the ledger too, because anyone can give a token any symbol.
  - **Links:** a link is resolved by Sato Hub, and its signed answer is required; the address it resolved to is printed. An unsigned answer is refused: send the contract address instead.
- **Sato Hub's signature** on the quote and on its fee disclosure.
- **The minimum you receive is the kit's, and it is written into the transaction.** The kit computes it from the quote less your slippage cap, then decodes the transaction it is about to sign. The minimum written into the transaction must be at least the kit's (on Base, KyberSwap's rounding may put it 1 base unit lower), and the output must go to the agent's own wallet; otherwise nothing is signed. Onchain, the swap reverts rather than pay less than that minimum.
- **On the EVM chains:** the transaction must go to the pinned KyberSwap router (the same address on all four, pinned per chain and checked against that chain's id), with the right value. A response that names another chain is refused. The simulation is run without block-number or time overrides on BNB Chain, Arbitrum and Polygon (their nodes refuse them) and, on BNB Chain, prices the calls by gas price because its base fee is zero; a simulation that cannot run is a refusal, never a guess. The kit decodes the router call: tokens, amount, recipient, minimum and fee must all match what was asked. It then runs its own simulation (`eth_simulateV1`) of the approval plus the swap: the wallet may lose at most the amount sold, must receive at least the minimum, and must lose nothing else. Approvals are for the exact amount only, never unlimited, and are set back to 0 afterwards. If a swap ends unclear (exit code 4) or the reset fails, the command says so; check the allowance before the next swap. One Base swap runs at a time.
- **On Solana:** the kit builds the transaction through Jupiter itself. It decodes it with its lookup tables and allows only pinned programs (and only the exact wrap, unwrap and create-account steps). It also decodes the Jupiter route: the amount, minimum, slippage, fee and destination must all match. The agent must be the only signer and the fee payer, the priority fee is capped, and the kit runs its own simulation of the balance changes and of who controls its token accounts afterwards. A transaction close to expiry is rebuilt, checked again (with a new price reading) and reported to you, never re-signed.
- **The Sato Hub fee** is tiered: **0.03%** for stablecoin pairs, **0.15%** for ETH/WETH/SOL ↔ USDC, **0.75%** for any other token. It is always shown before the trade, as a percent and in bps, and taken inside the swap, always in the stablecoin or the chain's own coin of the pair (USDC, ETH or SOL on Base and Solana; USDT, USDC, BNB, ETH or POL on the others, as in the table above): on the input when you buy a token, on the output when you sell one, never in the token you buy. A round trip (buy, then sell) pays it twice. Sato Hub sets its rate and states it, with its tier, in its signed quote; the kit checks:
  - the fee written into the transaction is exactly the disclosed one, on the disclosed side, paid to the pinned Sato Hub address and to no one else;
  - the pair's tier, read by the kit itself (stablecoin, the chain's coin with a stablecoin, or a token). A quote that names a MORE expensive tier than that is refused (`fee_tier_mismatch`). A cheaper one is accepted (Sato Hub counts more coins as majors, such as USDT or DAI, so on Base USDC → USDT can be a 0.03% stablecoin trade to it and a token trade to the kit), held to the ceiling of the tier Sato Hub named; the fee is still taken only in the pair's stablecoin or the chain's coin. A pair with neither side a stablecoin or the chain's coin of this kit (USDT ↔ DAI on Base, say) is refused before any quote. On BNB Chain, USDT and USDC are both the chain's stablecoins, so USDT ↔ USDC is a 0.03% stablecoin pair there, not a refusal: it is also checked to come back within 1% of one for one (`stable_pair_off_peg`), since no oracle prices a stablecoin pair;
  - each tier has its own ceiling: a stablecoin pair above **0.03%** and an ETH/SOL ↔ USDC (or the chain's coin with a stablecoin) pair above **0.15%** are refused (`fee_over_major_ceiling`), and **any fee above 1%** is refused (`fee_over_ceiling`). Within those ceilings Sato Hub can change its rate without a kit update; the approval binds the tier and the most that tier may cost.
- **What this does not cover:**
  - The simulation runs on the RPC you use (a public one by default), and prices can move between the quote and the block.
  - Whoever builds the route (Sato Hub and KyberSwap on the EVM chains, Jupiter on Solana) could route it so you get exactly the minimum and no more. On the EVM chains the kit only lets the tokens go to KyberSwap's own executor contract, pinned per chain, which narrows this.
  - The minimum written into the transaction bounds a single swap: the quote less the slippage. Between USDC and ETH/SOL the quote must also sit within 3% (ETH) or 5% (SOL) of the independent price; a token has no independent price, so for a token the quote itself is the reference. The 24-hour limit bounds the total.
  - A token's sale can be blocked later by things no simulation sees today: an owner who turns trading off, a blacklist, a time lock, an upgradeable contract, a freeze. The sell-back test and Sato Hub's evidence describe the token now, not what its issuer may do next.
- **Sato Hub checks and swaps:** `token` shows Sato Hub's evidence about a token (dated, not a verdict). The swap itself is held to the kit's own checks above, so `--check-gate` and `--skip-check` do not apply to swaps.
- **What a token check can't tell you:** whether a token is a good buy, whether its team is honest, or whether its price will hold. The kit never suggests what to buy or sell.
- **Sato Hub keeps a public record of every swap quote it gives:** the venue, the pair, the amounts and the fee, never the wallet address. A `--dry-run` asks for a quote too, so it is recorded the same way.

## Referral share

Anyone can share this bot with their own referral name (or, the older way, their own payout address), and receive a share of Sato Hub's swap fee on the swaps of the agents copied from it.

- **What counts.**
  - **Swaps only.** The referrer gets 30% of Sato Hub's swap fee (0.225% of a 0.75% token trade, 0.045% of a 0.15% ETH/SOL trade, 0.009% of a 0.03% stablecoin trade) on a swap by an agent set up with their address. x402 payments, sends and purchases carry no Sato Hub fee, so they carry no referral.
  - **Only a confirmed swap whose fee Sato Hub has read.** A swap counts once the trade is confirmed onchain and Sato Hub has read its fee payment there. A quote alone earns nothing, and a swap that carried no Sato Hub fee earns nothing.
  - **Paid weekly in USDC once the balance passes $10.** Smaller balances carry over to the next week. The payment goes to the referrer's address, on that address's chain.
  - **Self-referral is allowed:** an owner may use their own address.
- **What it costs the owner: nothing.** The owner pays the same fee, to the same pinned Sato Hub address, on the same side. The referral is a share of Sato Hub's fee; it is not added to the trade. The kit's fee checks (address, side, tier and ceiling) are the same with or without one, and it never changes an approval, a limit or an exit code.
- **How to set it.** `sato-agent settings set --referrer <name>` (like `sunny-otter`), `--referrer <address>` (a Base address, `0x` and 40 hex characters, or a Solana address), or a `referrer` key with `settings set --stdin`. `--referrer none` removes it. An address is checked for its format on this computer; a name is checked with Sato Hub first (`GET /api/referral/name/<name>`; no such name, or no answer, and nothing is saved). A change is written to the ledger. A share made by a Grok Bot carries a `Referral: <name>` memory and a "Sato referral" skill that set it up; the older `REFERRER = <address>` line in a setup prompt still works (see BOT.md).
- **Your own name.** `sato-agent referral create --chain base|bnb|arbitrum|polygon|solana [--payout <address>]` signs a short message (the action, the signer, the payout address and the time) with the bot's own key on that chain (every EVM chain is the same key, so the same name and the same payout class: USDC on Base), sends it to Sato Hub (`POST /api/referral/name`) and gets back a name. The signature proves the wallet; the key never leaves the computer, and nothing is paid or spent. One name per bot wallet: a second `create` returns the same one. The payout address defaults to the signing wallet's address and can be any Base or Solana address; `referral set-payout <address>` changes it later. Where payouts go is always the owner's decision: `set-payout`, and `create --payout` to an address other than the signing wallet's own, stop with exit code 5 and a one-time approval code (the full address is in the intent), whatever the approval mode; the same command with `--approve <code>` signs it. The ledger shows the new payout in short form. A bot has one name, so `create` on the other chain is refused, and `settings set --referrer` refuses the bot's own name. The name is the public handle; Sato Hub never shows the payout address to anyone but the wallet that signed. The name, payout and chain are saved in `settings.json`, and the change is written to the ledger.
- **What a share carries.** Three short texts, printed by `referral create` and again by `referral share-text`: a memory (`Referral: <name>`), an optional last line for the description (`This bot is referred by <name>.`) and the "Sato referral" skill. A share carries only those and the bot's instructions: no other memories, no wallet address, limits, history, shipping address or payout address. The kit never posts or sends a share; the owner reviews it and publishes it.
- **The offer.** A bot with no name of its own and no earlier "no" is offered the share once at setup (`referral offer --when setup`) and once after its first confirmed swap (the swap prints it). Never after a payment, a purchase or a send. `referral decline` records a no, and nothing is offered again.
- **What is sent.** With a referrer set, each swap request to Sato Hub carries `referrer`, and the quote shows "30% of it goes to the referrer 0x1234…abcd" when Sato Hub's signed answer records it. If the answer does not name the referrer that was sent, the kit warns ("Sato Hub didn't record your referrer on this swap") and carries on: the referral is the referrer's money, not the owner's. If Sato Hub refuses the address as invalid, nothing is signed and the kit says so; `--no-referrer` runs that one swap without it.
- **What is reported.** If you set a referrer, the kit tells Sato Hub which transaction each swap was, so the referrer can be paid. Sato Hub keeps it private. After a swap that carried a referrer is confirmed, the kit sends one request, `POST /api/route/settle` on the same host as `SATO_AGENT_MCP_URL`, with `{ route_id, chain, tx }` and nothing else (no wallet address, no amount). It has a short timeout and is never retried. Sato Hub answers `recorded` or a short error code; if it is not recorded the kit says so in one line ("the referral for this swap could not be recorded (<code>)"), and the swap, its result and its exit code do not change. With no referrer set, nothing is sent. A quote that carries no Sato Hub fee has nothing to share, so nothing is said or reported about the referrer for it.

## How purchases are checked

A purchase is a spend: it counts against the same per-transaction and 24-hour USD limits, is reserved under the same lock before anything is signed, and goes to the ledger like any other. On top of that:

- **Price first.** The owner sees the price before anything is paid: for a gift card, the value and the USDC price of Bitrefill's invoice; for an Amazon order, the item, tax, shipping, the total and where it ships; for a checkout, the amount and the merchant's label (and, for a Solana Pay transaction request, the cost the kit's own simulation measured). Purchases ask the owner first unless BOTH `--purchases` and `--approval` are on auto (the stricter choice wins); the owner's yes is bound to that exact price (and, for an order or a Solana Pay transaction request, to who is paid, shown on the card), and a run that gets another price or payee asks again.
- **Paid is not delivered.** A paid card that isn't delivered yet (within the wait, at most about 4 minutes), or whose code could not be saved, exits 4 and says "paid, not delivered yet — do not buy again", so a bot that follows exit codes does not buy it again. The kit does not stop a second, separate purchase of the same card. Polling stops at that deadline, and a refused Bitrefill sign-in is retried at most once per command.
- **Dry runs ask for real quotes.** An order dry run sends the shipping address to Sato Hub and creates a Crossmint quote; a gift card dry run signs in to Bitrefill and creates an unpaid invoice. Neither signs or pays anything.
- **No Sato Hub fee** on gift cards or Amazon orders. An Amazon quote that carries any Sato fee is refused. Sato Hub may earn Bitrefill's affiliate commission on delivered gift cards instead (paid by Bitrefill, not added to your price).
- **Gift cards (Bitrefill, Base).**
  - Bitrefill asks the wallet to sign in. This is the only plain message the kit ever signs (everything else it signs is a payment or a transaction), and only when it is a standard sign-in (EIP-4361) for `api.bitrefill.com`, on the chain the agent pays on (Base, Arbitrum or Polygon, by its chain id; a token saved for one chain is never used on another), for the agent's own address, mentioning no site but Bitrefill, and expiring within the hour. Anything else is refused (exit 3). The sign-in token is kept in a 0600 file with its expiry.
  - The price is read in explicit units: the x402 terms Bitrefill will charge for the invoice (one unpaid ask, nothing signed) give it in USDC base units, the invoice's own `price_usdc` (seen both as base units like `5250000` and as decimals) and `price_usd` must agree with them, and the limits, the card and the payment cap all use the same amount in dollars ($5.25, never 5,250,000). Anything that cannot be read as one amount is refused (`giftcard_price_unclear`).
  - The payment is the kit's own x402 payment (see "How the limits work"): bound to the invoice's price, to Bitrefill's payee `0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A` (the same on every chain), in Circle's USDC on the agent's chain (never the bridged USDC.e). A higher price or another payee at pay time is refused before anything is signed.
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
  - An EIP-681 link is paid only for one of the kit's stablecoins on the chain whose id the link names (`ethereum:<token>@<chain id>/transfer?address=…&uint256=…`: USDC on Base, USDT or USDC on BNB Chain, USDC or USDT on Arbitrum and Polygon), on a chain the owner chose, for the exact amount, through `send` (with its recipient check). A mixed-case recipient must carry a correct EIP-55 checksum.
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
- `settings.json` (mode 600): the shipping address for Amazon orders, the referral name or address if one is set, and this bot's own referral name, payout address, signing chain and offer state. `bitrefill-session.json` (mode 600): Bitrefill's sign-in token and its expiry. `giftcards/` (mode 700, files 600): delivered gift card codes. `local-hmac.key` (mode 600): a random key made once, used to bind a top-up's number into an approval without writing it down.
- They live in `~/.sato-agent/` by default. With the Grok Bot launchers from BOT.md, each Bot's files live in `~/.sato-agent/<NAME>/`.
- `SATO_AGENT_HOME` gives each agent its own folder. Two Bots on one computer should each use their own, so they get separate wallets and limits.
- Network calls:
  - Each chain's RPCs (`SATO_AGENT_BASE_RPC`, `SATO_AGENT_BNB_RPC`, `SATO_AGENT_ARBITRUM_RPC`, `SATO_AGENT_POLYGON_RPC` and `SATO_AGENT_SOLANA_RPC` to override; public endpoints by default, several per EVM chain);
  - `https://registry.npmjs.org/` for `check` (package versions and tarballs; only the package names you ask about);
  - the x402 resources you pay;
  - `https://satohub.ai/api/mcp` for checks (it receives the URL, recipient or install command being checked, never a key), and for swap quotes and fee disclosures (it receives the pair, the amount, the agent's address and, if one is set, the referral address; its public route record shows the pair and amounts, never the address);
  - for Solana swaps, Jupiter (`api.jup.ag`), which builds the transaction for the agent's address;
  - only when you set a referral name: `GET /api/referral/name/<name>` on the same host as `SATO_AGENT_MCP_URL`, to check the name (it receives the name);
  - only when you run `referral create` or `referral set-payout`: `POST /api/referral/name` on the same host (it receives the action, the name, the signing address, the payout address, the time and the signature; never a key);
  - only if a referral address is set: after a confirmed swap, `POST /api/route/settle` on the same host as `SATO_AGENT_MCP_URL` (`https://satohub.ai/api/route/settle` by default; it receives the route id, the chain and the transaction hash or signature, and nothing else);
  - for gift cards, `https://api.bitrefill.com` (the agent's Base address, the product, value and invoice; a top-up's number);
  - for Amazon orders, Sato Hub's order endpoint on the same host as `SATO_AGENT_MCP_URL` (`https://satohub.ai/api/commerce/order` by default; it receives the product, the chain, the agent's address and the shipping address, and passes them to Crossmint);
  - for a Solana Pay transaction request, the merchant's https link (it receives the agent's Solana address).
- Requests made by the kit itself send the user-agent `sato-agent/<version>`. Operators running their own fleet can set `SATO_AGENT_UA` (for example `SATO_AGENT_UA=acme-fleet/1.0`, using your own name) to send their own name instead, on every request the kit makes, so their calls are counted as the operator's. Do not use a `SatoHub-` name: that prefix is reserved for Sato Hub's own bots, and calls carrying it are counted as Sato Hub's, not yours. It must be one line of printable ASCII, at most 200 characters; anything else is ignored and the default is used. The Solana x402 library's own RPC reads (the USDC mint and a recent blockhash) go out with Node's default user-agent.

## What Sato Hub's checks are

They are dated evidence lines (when a project last shipped, whether an endpoint answered, what an install does with keys), not verdicts. A check stops a spend only if the owner chose that (`--check-gate`). With the gate on, the owner also chooses what happens when a check can't run, or when Sato Hub answered about something other than the target. A non-default Sato Hub address (`SATO_AGENT_MCP_URL`) is logged on every gated check. A `go` never means a recipient or resource is safe; it means nothing on record stood in the way. `unknown` means Sato Hub holds no record, not that anything is wrong. Docs: https://satohub.ai/mcp

## Tests

```sh
npm test                                     # offline: limits, ledger, CLI, x402 handshake, Solana signing
SATO_AGENT_FORK=1 node --test test/fork.test.js   # real Base contracts on a local anvil fork
SATO_AGENT_FORK=1 node --test test/chains-fork.test.js   # BNB Chain, Arbitrum and Polygon on anvil forks (FORK_CHAINS=bnb,arbitrum,polygon; FORK_RPC_<CHAIN> to choose the upstream)
node test/fixtures/swap-evm/record-chain.mjs <bnb|arbitrum|polygon>   # re-record a chain's KyberSwap fixtures (read-only)
```

## License

MIT. Not affiliated with xAI or Cursor. Grok Bot is their product.

"Sato Hub™" and "Sato Agent™" are trademarks of Prime Signal Labs, LLC. The MIT license covers the code, not the names: a modified version you distribute needs its own name (see [TRADEMARKS.md](TRADEMARKS.md)).
