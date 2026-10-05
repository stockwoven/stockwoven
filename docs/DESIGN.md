# Stockwoven vault program: design

One stock, one token. The vault holds liquidity in a **Meteora DAMM v2** pool that pairs two
issuers' tokens of the same stock (MVP: INTCx from xStocks and INTC from Backpack). Holders
own **swINTC**, a pro-rata claim on that liquidity. Conversions between issuers pay fees,
and DAMM v2's compounding mode puts most of each fee back into the pool, so every swINTC is
backed by more stock over time.

## How it fits together

```
traders / Jupiter ──swap──▶ DAMM v2 pool (INTCx ↔ INTC, collect_fee_mode = Compounding)
                              │  fee split per swap:
                              │   20%  Meteora protocol fee
                              │   LP fee × compounding_fee_bps  → stays in reserves (holders' yield)
                              │   LP fee × the rest             → claimable by positions, in token B
                              ▼
                    position NFT owned by the vault PDA
                              │
          deposit / redeem ───┤ shares ↔ fixed liquidity units
                              ▼
                     swINTC (SPL mint, authority = vault PDA)
```

The vault program is not in the swap path. Swaps go straight to cp-amm, so any router can
fill them.

## Share accounting

A share is a pro-rata claim on the vault's position liquidity, `L_vault`:

- deposit `s` shares → add `s × ceil(L_vault / supply)` liquidity
- redeem `s` shares → remove `s × floor(L_vault / supply)` liquidity
- single-token deposit adding `ΔL` → mint `ΔL × (1 − zap fee) / ceil(L_vault / supply)` shares

`liquidity_per_share` is only the launch ratio. It applies when the supply is zero.

Two things make a share worth more stock over time:

1. **Pool fees.** Compounding fees grow `pool.token_b_amount` while `pool.liquidity` stays the
   same, so every unit of liquidity is backed by more tokens.
2. **Vault fees.** The single-token deposit keeps `ZAP_FEE_BPS` (0.05%) of the liquidity it adds
   in the position without minting shares for it, so `L_vault / supply` rises for existing
   holders.

This design has three consequences:

- **No oracle, no NAV math on-chain.** cp-amm's own `L × reserve / L_total` rule prices deposits
  and withdrawals. Every rounding favours the vault.
- **No donation or inflation attack.** Only the vault can add liquidity to its position. Tokens
  sent to the vault do not change what a share is worth.
- **Dust.** Redeeming a few raw share units can pay out zero of a token. cp-amm rejects that
  (`AmountIsZero`), so the transaction fails and the holder keeps the shares.

The value of one share, which the app shows, is:
`(L_vault / supply) × (token_a_amount / 10^dec_a + token_b_amount / 10^dec_b) / pool.liquidity`,
counting one token of either issuer as one share of stock.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize_vault` | admin | Creates the pool via `initialize_customizable_pool` (compounding, full range, flat fee). The vault PDA is the pool creator, so it owns the first position NFT. The admin supplies the seed tokens and receives `(L − dead) / liquidity_per_share` shares. Also creates the share mint, two reserve token accounts, and the admin's share ATA. |
| `deposit(shares, max_a, max_b)` | anyone | Pulls up to `max_a`/`max_b` into vault-owned reserves, CPIs `add_liquidity` signed by the vault, refunds what cp-amm did not take, and mints `shares`. |
| `deposit_single(input_is_a, amount_in, min_shares)` | anyone | Takes one issuer's token, swaps `sqrt(r × (r + a)) − r` of it on the pool (at the pool's price, never an assumed 1:1), adds both as liquidity, refunds the dust, and mints shares net of the 0.05% vault fee. `min_shares` bounds slippage. |
| `redeem(shares, min_a, min_b)` | holder | Burns shares, then CPIs `remove_liquidity` straight to the holder in both tokens. Never paused by the vault. |
| `harvest` | anyone | CPIs `claim_position_fee` to the treasury. In compounding pools that fee is in token B only. It is the protocol's cut. |
| `set_deposits_paused` | admin | Circuit breaker for issuer events (pause, freeze, depeg). Redemptions stay open. |

Reserve token accounts exist because cp-amm pulls liquidity from token accounts owned by the
position's signer, which is the vault PDA.

## Fee split with the deck's numbers

With `trade_fee_bps = 10` and `compounding_fee_bps = 8000`, a 0.10% conversion fee splits into:

- 20% to Meteora (fixed by cp-amm),
- 64% compounded for swINTC holders,
- 16% to the Stockwoven treasury.

## Decisions and limits

- **Single-token deposits pay the swap fee** on the swapped part, plus price impact and the vault fee. In tests, a deposit of 0.1% of the pool gets back 99.74% on an immediate redeem.
- **One customizable pool per mint pair, ever** (cp-amm seeds `["cpool", max, min]`). On mainnet,
  check that nobody created INTCx/INTC first, and choose token A/B on purpose: fees accrue in B.
- **Token-2022 issuer tokens** need Meteora token badges, which INTCx and Backpack INTC already
  have. They are passed as remaining accounts to `initialize_vault`.
- **Issuer powers stay.** Pause, freeze and permanent delegate can still halt or drain the pool
  vaults; the vault cannot prevent that. The scaled-UI multiplier (dividends, splits) shifts the
  fair raw price, and arbitrage takes that value from LPs. That is why there is a pause and a
  per-issuer watcher (the Tape).
- **Full range (x·y = k).** Capital is used less efficiently than in a concentrated pool. The
  production path is a DLMM position concentrated at the peg, with a keeper that compounds fees.

## Testing

`programs/stockwoven/tests/test_vault.rs` runs in LiteSVM against the real cp-amm binary
(`scripts/fetch-fixtures.sh` dumps it from mainnet). It covers:

- pool creation, with plain SPL tokens and with Token-2022 issuer tokens (a permanent delegate, like xStocks and Backpack), with and without token badges,
- deposit with refund, and single-token deposits from either issuer,
- 40 direct swaps, harvest to the treasury, and redeeming more stock than was deposited,
- rounding across several holders, dust redeems, slippage limits and pause behaviour.

Unit tests cover the integer math in `src/math.rs`.

```
scripts/fetch-fixtures.sh            # once
anchor build --arch v0 && cargo test -- --nocapture
```

Build with `--arch v0`. Anchor 1.2 defaults to SBPF v3, which LiteSVM's default feature set
cannot load. cp-amm itself ships as v0.
