# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Product leads, CTOs and heads of investments at neobanks and fintechs who want to give their customers tokenized stocks. They use the devnet app to see the vault work end to end before integrating it. Their end users are "your customers"; Stockwoven has no end users of its own.

## Product Purpose

Several issuers tokenize the same stock, and each version trades in its own pool. The Stockwoven vault on Solana takes every issuer's version in and gives back one yield-bearing token per stock (`sw` prefix: swINTC, swAAPL…). Three steps: **Deposit** (hand over the vault's current mix, receive the sw token), **Hold** (each token is a slice of the vault's value, verifiable on-chain), **Redeem** (burn the sw token, take your share of every token in the vault).

## Positioning

One stock, one token, with all issuers' liquidity in one Meteora DAMM v2 pool. No oracle: shares are a pro-rata claim on the vault's pool liquidity, and conversion fees compound into the pool, so each sw token is backed by more stock over time.

## Operating Context

- Devnet only. Mock issuer tokens (mINTCx for xStocks, mINTC for Backpack) stand in for INTCx and Backpack INTC.
- Wallet Standard wallets (Phantom, Solflare, Backpack). A server faucet drips test tokens and a little SOL.
- Only swINTC exists on-chain. swAAPL, swNVDA and swTSLA appear as not live yet, with no figures.

## Capabilities and Constraints

- Deposit swINTC with both tokens or just one issuer's, redeem it, direct issuer-to-issuer conversion on DAMM v2, permissionless harvest of the protocol fee, test-token faucet, wallet activity history read from chain.
- Fee split per 0.10% conversion: 64% compounds for holders, 16% treasury, 20% Meteora.
- Redemptions are never paused by the vault; deposits can be paused by the admin.

## Brand Commitments

The Stockwoven design system (`app/src/design-system/stockwoven-design-system/`) is binding: ink/ivory with purple as the only accent, Bricolage Grotesque / Instrument Sans / JetBrains Mono, generated weave pattern, logo files only. English copy; direct, calm, specific; no hype, return promises or emoji.

## Evidence on Hand

Live devnet program, pool and mint (`app/src/lib/devnet.json`). No customers, TVL, partner logos or benchmarks exist; never invent them.

## Product Principles

- Show the mechanism with live on-chain numbers, never claims.
- Every figure carries its unit and can be traced to an account on the explorer.
- Redeem is always one step away.

## Accessibility & Inclusion

WCAG AA contrast, 44px touch targets, visible focus, reduced motion respected, usable from 320px.
