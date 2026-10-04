use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the vault admin can do this")]
    Unauthorized,
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Trading fee must be between 1 bp and the maximum")]
    InvalidTradeFee,
    #[msg("Compounding share must be between 1 and 10000 bps")]
    InvalidCompoundingFee,
    #[msg("Liquidity per share must be greater than zero")]
    InvalidLiquidityPerShare,
    #[msg("Seed liquidity does not cover a single share")]
    SeedTooSmall,
    #[msg("Pool address does not match the cp-amm customizable pool for these mints")]
    InvalidPool,
    #[msg("Math overflow")]
    MathOverflow,
}
