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
