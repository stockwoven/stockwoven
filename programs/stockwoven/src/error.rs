use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the vault admin can do this")]
    Unauthorized,
    #[msg("Only the vault keeper can do this")]
    NotKeeper,
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Trading fee must be between 1 bp and the maximum")]
    InvalidTradeFee,
    #[msg("Compounding share must be between 1 and 10000 bps")]
    InvalidCompoundingFee,
    #[msg("Arbitrage fee is above the maximum")]
    InvalidArbFee,
    #[msg("Weight is above 10000 bps")]
    InvalidWeight,
    #[msg("The first pool must mint seed shares; later pools must not")]
    InvalidSeedShares,
    #[msg("Pool address does not match the cp-amm customizable pool for these mints")]
    InvalidPool,
    #[msg("The vault already holds the maximum number of assets")]
    TooManyAssets,
    #[msg("The vault already holds the maximum number of pools")]
    TooManyPools,
    #[msg("This mint is already a vault asset")]
    AssetExists,
    #[msg("This mint is not a vault asset")]
    UnknownAsset,
    #[msg("No vault pool at this index")]
    UnknownPool,
    #[msg("An account does not match the vault's records")]
    AccountMismatch,
    #[msg("Wrong number of accounts or amounts for this vault")]
    WrongAccountCount,
    #[msg("Token account is not owned by the treasury")]
    NotTreasury,
    #[msg("The vault has no shares yet")]
    VaultEmpty,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Account is not the expected cp-amm pool or position")]
    InvalidDammAccount,
    #[msg("Account is not a token account")]
    InvalidTokenAccount,
    #[msg("The amounts moved are worse than the limits")]
    SlippageExceeded,
    #[msg("Arbitrage route must start and end in the same token, with at most 4 hops")]
    InvalidRoute,
    #[msg("Arbitrage did not reach the minimum profit")]
    NotProfitable,
    #[msg("Basket settings are invalid or do not cover every vault asset")]
    InvalidBasket,
    #[msg("The keeper's prices are too old")]
    PricesStale,
    #[msg("A vault pool's price is outside the band around the keeper's prices")]
    PoolOutOfBand,
    #[msg("This token's price is outside the 1:1 band; the vault stopped accepting it")]
    TokenDepegged,
    #[msg("This deposit would put the token above its cap")]
    AssetAtCap,
    #[msg("Only issuer tokens of the stock are taken in or paid out alone; convert the rest")]
    NotAStock,
    #[msg("Converted deposits must go into a token below its target weight")]
    NotUnderweight,
    #[msg("The vault does not hold enough of this token")]
    InsufficientLiquidity,
}
