use anchor_lang::prelude::*;

/// One vault per stock. It owns a single DAMM v2 position in the cross-issuer pool, and each
/// share (swINTC) is a pro-rata claim on that position's liquidity.
///
/// Two things make a share worth more stock over time:
/// - the pool's compounding fees raise the reserves behind every unit of liquidity;
/// - the vault's own zap fee adds liquidity to the position without minting shares.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,
    /// Receives the claimable part of the pool's LP fee (the protocol's cut), in token B.
    pub treasury: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub position_nft_account: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    /// Vault-owned token accounts that stage deposits, because cp-amm pulls liquidity from
    /// accounts owned by the position owner.
    pub reserve_a: Pubkey,
    pub reserve_b: Pubkey,
    pub share_mint: Pubkey,
    /// Liquidity per raw share unit at launch; used again only if the share supply returns to 0.
    pub liquidity_per_share: u128,
    pub deposits_paused: bool,
    pub bump: u8,
}
