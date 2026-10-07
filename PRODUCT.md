# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, both served by the same vault:

- **Investors who hold tokenized stocks.** They use the Stockwoven app directly to deposit, follow the value of their sw token and redeem.
- **Partners: product leads, CTOs and heads of investments at neobanks and fintechs** who want to give their customers tokenized stocks under their own brand through the SDK. They use the devnet app to see the vault work end to end before integrating it; their end users are their own customers.

## Product Purpose

Several issuers tokenize the same stock, and each version trades in its own pools. The Stockwoven vault on Solana holds every issuer's version, provides liquidity with it in Meteora DAMM v2 pools it owns, and gives back one yield-bearing token per stock (`sw` prefix: swSPCX, swAAPL…). Three steps: **Deposit** (hand over the vault's current mix, or pay with one token and the app swaps it into the mix in the same transaction; receive the sw token), **Hold** (each token is a pro-rata slice of everything the vault holds, verifiable on-chain), **Redeem** (burn the sw token, take your slice of every token back in kind, or receive it all as USDC).

## Positioning

One stock, one token. For SpaceX, the vault holds liquidity in four Meteora DAMM v2 pools (SPCXx / SPCX, SPCXon / SPCXx, SPCX / USDC, SPCXx / SOL) plus idle reserves of each token, and swSPCX is a pro-rata claim on all of it. No oracle on-chain. Yield comes from three sources: pool fees that compound for holders, a keeper that moves liquidity toward the pools earning the most, and arbitrage cycles across pools that only land when the vault ends with more. Because two pools pair the stock with USDC and SOL, swSPCX is mostly SpaceX but not 100%; the app shows its USD value ("1 swSPCX = $X") and says so plainly.

## Operating Context

- Devnet only. Mock SPCXx (xStocks, 8 decimals), mock SPCX (Backpack, 6 decimals) and mock SPCXon (Ondo, 9 decimals) stand in for the three issuers' SpaceX tokens, alongside a test USDC and devnet SOL.
- Wallet Standard wallets (Phantom, Solflare, Backpack). A server faucet drips 10 mock SPCXx, 10 mock SPCX, 10 mock SPCXon, 2,000 test USDC and a little SOL, once a minute.
- Only swSPCX exists on-chain. swAAPL, swNVDA and swTSLA appear as not live yet, with no figures.

## Capabilities and Constraints

- Deposit swSPCX with the vault's mix or with any one token (SPCXx, SPCX, SPCXon, USDC or SOL), swapped into the mix in the same transaction.
- Redeem in kind (a slice of every token) or to USDC in the same transaction.
- Swaps between any of the tokens across the vault's pools and market pools.
- Permissionless `harvest` of the protocol's cut of pool fees to the treasury.
- Keeper bot: auto-balances liquidity toward the pools with the highest fee yield (`rebalance_remove`, `vault_swap`, `rebalance_add`, on-chain target weights) and runs 2–4 hop arbitrage cycles that must end with more of the starting token. It can't mint shares or move funds out of the vault.
- Test-token faucet; wallet activity history read from chain.
- Fee split per 0.30% pool fee: 64% compounds for holders, 16% treasury (via `harvest`), 20% Meteora. Arbitrage profit: 80% stays with holders, 20% treasury. Protocol revenue is those two treasury shares; there is no deposit or redemption fee.
- Redemptions are never paused by the vault; deposits can be paused by the admin.

## Brand Commitments

The Stockwoven design system (`app/src/design-system/stockwoven-design-system/`) is binding: ink/ivory with purple as the only accent, Bricolage Grotesque / Instrument Sans / JetBrains Mono, generated weave pattern, logo files only. English copy; direct, calm, specific; no hype, return promises or emoji.

## Evidence on Hand

Live devnet program, vault, pools and mint (`app/src/lib/devnet.json`). No customers, TVL, partner logos or benchmarks exist; never invent them.

## Product Principles

- Show the mechanism with live on-chain numbers, never claims.
- Every figure carries its unit and can be traced to an account on the explorer.
- Redeem is always one step away.

## Accessibility & Inclusion

WCAG AA contrast, 44px touch targets, visible focus, reduced motion respected, usable from 320px.
