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

`liquidity_per_share` is fixed when the vault is created:

- deposit `s` shares → add exactly `s × liquidity_per_share` liquidity to the vault's position
- redeem `s` shares → remove exactly `s × liquidity_per_share` liquidity

Compounding fees grow `pool.token_b_amount` while `pool.liquidity` stays the same, so every unit
of liquidity, and therefore every share, is worth more tokens over time. This has three
consequences:

- **No oracle, no NAV math on-chain.** cp-amm's own `L × reserve / L_total` rule prices deposits
  and withdrawals, rounding against the user.
- **No donation or inflation attack.** Shares track liquidity units, not token balances.
  Tokens sent to the vault do not change what a share is worth.
- **Invariant:** `position.unlocked_liquidity ≥ share_supply × liquidity_per_share`. The
  remainder is rounding dust from the seed.

The value of one share, which the app shows, is:
`liquidity_per_share × (token_a_amount / 10^dec_a + token_b_amount / 10^dec_b) / pool.liquidity`,
counting one token of either issuer as one share of stock.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize_vault` | admin | Creates the pool via `initialize_customizable_pool` (compounding, full range, flat fee). The vault PDA is the pool creator, so it owns the first position NFT. The admin supplies the seed tokens and receives `(L − dead) / liquidity_per_share` shares. Also creates the share mint, two reserve token accounts, and the admin's share ATA. |
| `deposit(shares, max_a, max_b)` | anyone | Pulls up to `max_a`/`max_b` into vault-owned reserves, CPIs `add_liquidity` signed by the vault, refunds what cp-amm did not take, and mints `shares`. |
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

- **Proportional deposits only.** cp-amm's compounding mode has no single-sided add. A
  single-token "zap" (swap half, then deposit) belongs in the client or a later instruction.
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

- pool creation,
- deposit with refund,
- 40 direct swaps,
- harvest to the treasury,
- redeeming more stock than was deposited,
- pause behaviour.

```
scripts/fetch-fixtures.sh            # once
anchor build --arch v0 && cargo test -- --nocapture
```

Build with `--arch v0`. Anchor 1.2 defaults to SBPF v3, which LiteSVM's default feature set
cannot load. cp-amm itself ships as v0.
