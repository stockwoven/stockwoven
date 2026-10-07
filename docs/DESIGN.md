# Stockwoven vault program: design

One stock, one token. The swSPCX vault takes every issuer's SpaceX token (SPCXx from xStocks,
SPCX from Backpack, SPCXon from Ondo), plus USDC and SOL, and spreads them across several
**Meteora DAMM v2** pools it owns. Holders own **swSPCX**, a pro-rata claim on everything the vault
holds. A keeper moves the vault's liquidity towards the pools that earn the most and arbitrages
price gaps between pools.

```
users ── USDC, SOL, SPCXx, SPCX, SPCXon ──▶ vault ──▶ SPCXx / SPCX     (stock–stock)
                                              │    ├▶ SPCXon / SPCXx   (stock–stock)
   ◀── swSPCX (pro-rata: positions + idle) ───┤    ├▶ SPCX / USDC      (stock–USDC)
                                              │    └▶ SPCXx / SOL      (stock–SOL)
                                              │
                    keeper ── rebalance_remove / vault_swap / rebalance_add (towards target weights)
                           └─ arbitrage: a cycle through vault and market pools that must end richer
```

## Where the yield comes from

1. **Pool fees.** Every vault pool is a full-range DAMM v2 pool in compounding mode. Per swap fee:
   20% to Meteora, `compounding_fee_bps` (80%) of the rest stays in the pool's reserves, so the
   vault's liquidity is backed by more tokens, and the remainder is claimable by the position
   (`harvest` sends it to the treasury). With the devnet settings (0.30% fee, 8000 bps) that is
   64% for holders, 16% for the protocol. Stock/USDC and stock/SOL pools see far more volume than
   stock/stock pools.
2. **Auto-balancing.** The keeper measures each pool's fee yield (growth of `sqrt(reserve_a ·
   reserve_b) / liquidity`, which price moves leave unchanged on x·y = k) and sets target weights
   with `set_pool_weights`. It then takes liquidity out of overweight pools, swaps the idle tokens
   into the pair an underweight pool needs, and adds it there.
3. **Arbitrage.** When the same SpaceX trades at different prices across pools, the keeper runs a
   2–4 hop swap cycle through the vault's reserves. The program checks that the start reserve grew
   by at least `min_profit` and that every other reserve ended where it started. The treasury takes
   `arb_fee_bps` (20%) of the profit; the rest stays with holders. Arbitraging its own pools keeps
   the value that would otherwise leak to outside arbitrageurs.

**Exposure.** Because two pools pair SpaceX with USDC and SOL, swSPCX is mostly SpaceX but not
entirely: its value is a mix of SpaceX, USDC and SOL, and the app shows it in USD.

## Share accounting

A share is a pro-rata claim on **every** position's liquidity and **every** reserve's idle balance.
No oracle is involved on-chain:

- deposit `s` shares → add `s × ceil(L_i / supply)` liquidity to each pool `i`, and pay
  `ceil(s × idle_k / supply)` of each reserve `k`;
- redeem `s` shares → remove `s × floor(L_i / supply)` from each pool, and receive
  `floor(s × idle_k / supply)` of each reserve.

The first pool's `add_pool` mints the seed shares to the admin; later pools may not mint shares, so
liquidity seeded into them belongs to the existing holders. On devnet the seed is sized so that
one swSPCX was worth about one SpaceX share at launch.

Consequences:

- **Rebalancing and arbitrage never change the share count.** They only move value between
  positions and reserves, both of which shares claim, so holders can deposit or redeem between any
  two keeper steps.
- **Deposits are bounded by their limits.** The user sends up to `max_amounts[k]` of each asset to
  the reserves, cp-amm pulls what the liquidity needs, and the program checks that every reserve
  still holds its old balance plus the user's idle slice before refunding the rest. If a pool took
  more than the user sent, the shortfall would have come out of holders' idle tokens, and this
  check rejects it.
- **Rounding favours the vault** everywhere. Redeeming a few raw share units can pay out zero of a
  pool's token; cp-amm rejects that (`AmountIsZero`) and the holder keeps the shares.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize_vault(stock, keeper, treasury, arb_fee_bps)` | admin | The vault PDA `["vault", stock]` and the share mint. |
| `add_asset` | admin | Registers a mint and creates its reserve `["reserve", vault, mint]`. Up to 6 assets. |
| `add_pool(args)` | admin | Creates a customizable compounding DAMM v2 pool for two assets with the vault as creator, so the vault owns the first position. The admin pays the seed. Up to 6 pools. |
| `deposit(shares, max_amounts)` | anyone | Pro-rata into every pool and reserve; remaining accounts per asset and per pool. |
| `redeem(shares, min_amounts)` | holder | Pro-rata out of every pool and reserve, in kind. Never paused. |
| `rebalance_remove(index, liquidity, min_a, min_b)` | keeper | Pool liquidity into the reserves. |
| `rebalance_add(index, liquidity, max_a, max_b)` | keeper | Reserves into pool liquidity; `liquidity = 0` adds everything both sides cover. |
| `vault_swap(a_to_b, amount_in, min_out)` | keeper | Swaps between two reserves on any cp-amm pool whose tokens are vault assets. |
| `arbitrage(a_to_b[], amount_in, min_profit)` | keeper | A cycle of 2–4 swaps that must return more of the start token. |
| `harvest(index)` | anyone | Claims a pool's non-compounding fee to the treasury's token account. |
| `set_deposits_paused`, `set_keeper`, `set_arb_fee`, `set_pool_weights` | admin | Settings. Weights sum to at most 10000 bps; the rest is the idle buffer. |

`deposit` and `redeem` touch about 45 accounts (10 fixed, 3 per asset, 5 per pool), so clients send
them as v0 transactions with the vault's address lookup table.

## What the keeper can and cannot do

The keeper signs rebalances, vault swaps and arbitrage. It chooses sizes and price limits, so it is
trusted not to sell the vault's tokens at bad prices through `vault_swap`; every arbitrage is
checked on-chain. It cannot mint or burn shares, move tokens out of the vault's reserves except into
cp-amm pools, or block redemptions. `scripts/keeper.ts` is the devnet keeper; it caps every swap at
2% of the pool it trades in.

## Decisions and limits

- **One customizable pool per mint pair, ever** (cp-amm seeds `["cpool", max, min]`). Market pools
  for arbitrage must use other pairs, or config-based pools.
- **Token-2022 issuer tokens** need Meteora token badges, which SPCXx, Backpack SPCX and SPCXon have
  on mainnet for the pairs that exist. They are passed as remaining accounts to `add_pool`.
- **Issuer powers stay.** Pause, freeze and permanent delegate can halt or drain a pool or a reserve.
  A frozen token blocks redemptions in kind until it is unfrozen, because every redemption pays out
  every asset; deposits can be paused by the admin.
- **Full range (x·y = k).** Volatile pairs (stock/USDC, stock/SOL) take divergence loss when prices
  move; fees and arbitrage have to beat it. Concentrated DLMM positions are the next step.
- **Arbitrage on mainnet** would also route through Jupiter; the program only knows cp-amm pools.

## Testing

`programs/stockwoven/tests/test_vault.rs` runs in LiteSVM against the real cp-amm binary
(`scripts/fetch-fixtures.sh` dumps it from mainnet), with the five assets and four pools, using v0
transactions and a lookup table like the app. It covers setup with plain SPL and Token-2022 issuer
tokens, pro-rata deposit and redeem, deposit limits protecting idle reserves, fees compounding for
holders and harvest, rebalancing between pools, profitable and rejected arbitrage (including an
Ondo price gap), keeper and treasury checks, account-order checks, rounding, pause, admin settings
and a compute-unit profile (deposit ≈ 264k CU, redeem ≈ 238k, 3-hop arbitrage ≈ 144k).

```
scripts/fetch-fixtures.sh            # once
cargo build-sbf --manifest-path programs/stockwoven/Cargo.toml --arch v0 && cargo test -p stockwoven
```

Build with `--arch v0`: Anchor 1.2 defaults to SBPF v3, which LiteSVM's default feature set cannot
load. The release profile uses `opt-level = "s"` to keep the program near its devnet allocation.

## Devnet

```
KEYPAIR=//wsl.localhost/Ubuntu/home/pedro/.config/solana/id.json \
FAUCET_KEYPAIR=C:/Users/pedro/.stockwoven/faucet-keypair.json npm run devnet:setup
KEYPAIR=… npm run keeper     # every minute: arbitrage, weights, rebalance, hourly harvest
KEYPAIR=… npm run traffic    # random swaps, so pools earn fees and prices drift apart
```

The setup writes every address to `scripts/devnet.json` and `app/src/lib/devnet.json`.
