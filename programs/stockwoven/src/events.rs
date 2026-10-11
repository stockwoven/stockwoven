use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub stock: [u8; 8],
    pub share_mint: Pubkey,
}

#[event]
pub struct AssetAdded {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub reserve: Pubkey,
}

#[event]
pub struct PoolAdded {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub seed_shares: u64,
}

/// `amounts` is what the user paid, per asset in the vault's order.
#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
    pub amounts: Vec<u64>,
}

/// `amounts` is what the user received, per asset in the vault's order.
#[event]
pub struct Redeemed {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
    pub amounts: Vec<u64>,
}

#[event]
pub struct Rebalanced {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub added: bool,
    pub liquidity: u128,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[event]
pub struct VaultSwapped {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct Arbitraged {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub hops: u8,
    pub amount_in: u64,
    /// Profit kept by the vault, after the treasury's fee.
    pub profit: u64,
    pub fee: u64,
}

#[event]
pub struct Harvested {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[event]
pub struct BasketSet {
    pub vault: Pubkey,
    pub params: crate::state::BasketParams,
    pub weights: Vec<crate::state::AssetWeights>,
}

#[event]
pub struct PricesSet {
    pub vault: Pubkey,
    pub prices: Vec<u64>,
    pub updated_at: i64,
}

/// A deposit of one token. `mint_in`/`amount_in` is what the user paid; when the vault converted
/// it, `mint`/`amount` is the issuer token it became. `value` is in nano-shares of the stock and
/// `fee_bps` is negative for a discount.
#[event]
pub struct DepositedSingle {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub mint_in: Pubkey,
    pub amount_in: u64,
    pub mint: Pubkey,
    pub amount: u64,
    pub value: u64,
    pub fee_bps: i16,
    pub shares: u64,
}

#[event]
pub struct RedeemedSingle {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
    pub mint: Pubkey,
    pub amount: u64,
    pub value: u64,
    pub fee_bps: i16,
}
