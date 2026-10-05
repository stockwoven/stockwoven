use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"shares";

#[constant]
pub const RESERVE_SEED: &[u8] = b"reserve";

/// swINTC uses the same precision as xStocks tokens.
#[constant]
pub const SHARE_DECIMALS: u8 = 8;

/// Upper bound on the pool's trading fee, in basis points (10%).
pub const MAX_TRADE_FEE_BPS: u16 = 1_000;

pub const MAX_BASIS_POINTS: u16 = 10_000;

/// DAMM v2 expresses fees as a numerator over 1e9, so 1 bp = 100_000.
pub const FEE_NUMERATOR_PER_BPS: u64 = 100_000;

/// cp-amm `collect_fee_mode`: part of every fee is added back to the pool's reserves.
pub const COLLECT_FEE_MODE_COMPOUNDING: u8 = 2;

/// cp-amm `activation_type`: 1 = timestamp.
pub const ACTIVATION_TYPE_TIMESTAMP: u8 = 1;

/// cp-amm keeps this much liquidity from the first deposit locked forever.
pub const DAMM_DEAD_LIQUIDITY: u128 = 100 << 64;

/// Full-range bounds of cp-amm. Compounding pools ignore them, but they are passed anyway.
pub const DAMM_MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const DAMM_MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

/// Fixed cp-amm PDAs: `["pool_authority"]` and `["__event_authority"]`.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

pub const DAMM_CUSTOMIZABLE_POOL_SEED: &[u8] = b"cpool";

/// Vault fee on single-token deposits, in basis points of the liquidity added. It stays in the
/// position without minting shares, so it accrues to existing holders.
#[constant]
pub const ZAP_FEE_BPS: u16 = 5;
