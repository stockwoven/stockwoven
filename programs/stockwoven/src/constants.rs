use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"shares";

#[constant]
pub const RESERVE_SEED: &[u8] = b"reserve";

/// swSPCX uses the same precision as xStocks tokens.
#[constant]
pub const SHARE_DECIMALS: u8 = 8;

/// Tokens a vault can hold: three issuers, USDC and SOL, plus one spare.
pub const MAX_ASSETS: usize = 6;

/// DAMM v2 positions a vault can hold.
pub const MAX_POOLS: usize = 6;

/// Hops in one arbitrage cycle.
pub const MAX_ARB_HOPS: usize = 4;

/// Upper bound on a pool's trading fee, in basis points (10%).
pub const MAX_TRADE_FEE_BPS: u16 = 1_000;

/// Upper bound on the arbitrage fee, in basis points (50%).
pub const MAX_ARB_FEE_BPS: u16 = 5_000;

pub const MAX_BASIS_POINTS: u16 = 10_000;

/// DAMM v2 expresses fees as a numerator over 1e9, so 1 bp = 100_000.
pub const FEE_NUMERATOR_PER_BPS: u64 = 100_000;

/// cp-amm `collect_fee_mode`: part of every fee is added back to the pool's reserves.
pub const COLLECT_FEE_MODE_COMPOUNDING: u8 = 2;

/// cp-amm `activation_type`: 1 = timestamp.
pub const ACTIVATION_TYPE_TIMESTAMP: u8 = 1;

/// Full-range bounds of cp-amm. Compounding pools ignore them, but they are passed anyway.
pub const DAMM_MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const DAMM_MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

/// Fixed cp-amm PDAs: `["pool_authority"]` and `["__event_authority"]`.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

pub const DAMM_CUSTOMIZABLE_POOL_SEED: &[u8] = b"cpool";

#[constant]
pub const BASKET_SEED: &[u8] = b"basket";

/// Value unit of the basket: one share of the stock is 1e9 nano-shares.
pub const NANO_SHARES_PER_SHARE: u64 = 1_000_000_000;

/// Upper bound on the circuit-breaker band, in basis points (10%).
pub const MAX_BAND_BPS: u16 = 1_000;

/// Upper bound on the basket's fee and discount, in basis points (10% and 1%).
pub const MAX_BASKET_FEE_BPS: u16 = 1_000;
pub const MAX_BASKET_DISCOUNT_BPS: u16 = 100;
