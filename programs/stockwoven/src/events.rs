use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub seed_shares: u64,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[event]
pub struct Redeemed {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
}

#[event]
pub struct Harvested {
    pub vault: Pubkey,
    pub treasury: Pubkey,
    pub amount_b: u64,
}
