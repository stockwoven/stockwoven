use anchor_lang::prelude::*;

/// One vault per stock. It owns a single DAMM v2 position in the cross-issuer pool, and each
/// share (swINTC) is a claim on a fixed amount of that position's liquidity.
///
/// Compounding fees raise the reserves behind every unit of liquidity, so a share is worth more
/// stock over time while `liquidity_per_share` never changes. Invariant:
/// `position.unlocked_liquidity >= share_supply * liquidity_per_share`.
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
    pub liquidity_per_share: u128,
    pub deposits_paused: bool,
    pub bump: u8,
}

impl Vault {
    pub fn shares_to_liquidity(&self, shares: u64) -> Option<u128> {
        (shares as u128).checked_mul(self.liquidity_per_share)
    }
}
