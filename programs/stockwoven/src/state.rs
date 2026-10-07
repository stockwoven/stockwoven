use anchor_lang::prelude::*;

use crate::constants::{MAX_ASSETS, MAX_POOLS};

/// A token the vault can hold: an issuer's version of the stock, USDC or wrapped SOL. Each one
/// has a vault-owned reserve account that stages deposits, redemptions and keeper trades.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Asset {
    pub mint: Pubkey,
    pub reserve: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
}

/// One DAMM v2 position owned by the vault. The pool pairs two registered assets: SOL–stock,
/// USDC–stock or stock–stock.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PoolSlot {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub position_nft_account: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    /// Indexes into `Vault::assets`.
    pub asset_a: u8,
    pub asset_b: u8,
    /// The keeper's target share of the vault's value in this pool. Informational on-chain.
    pub target_weight_bps: u16,
}

/// One vault per stock (swSPCX for SpaceX). Each share is a pro-rata claim on everything the
/// vault owns: its liquidity in every pool and the idle balance of every reserve.
///
/// Holders earn three ways, and none needs an oracle:
/// - every pool's compounding fees raise the reserves behind each unit of liquidity;
/// - the keeper moves liquidity towards the pools that earn the most;
/// - the keeper's cycle arbitrage only lands when the vault ends with more of the token it
///   started from, and the profit stays in the reserves.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,
    /// Signs rebalances, vault swaps and arbitrage.
    pub keeper: Pubkey,
    /// Wallet whose token accounts receive the protocol's cut (pool fees and arbitrage fee).
    pub treasury: Pubkey,
    /// Ticker of the underlying stock, zero-padded (b"SPCX\0\0\0\0"). Part of the vault's seeds.
    pub stock: [u8; 8],
    pub share_mint: Pubkey,
    /// Share of each arbitrage profit sent to the treasury, in basis points.
    pub arb_fee_bps: u16,
    pub deposits_paused: bool,
    pub bump: u8,
    pub num_assets: u8,
    pub assets: [Asset; MAX_ASSETS],
    pub num_pools: u8,
    pub pools: [PoolSlot; MAX_POOLS],
}

impl Vault {
    pub fn assets(&self) -> &[Asset] {
        &self.assets[..self.num_assets as usize]
    }

    pub fn pools(&self) -> &[PoolSlot] {
        &self.pools[..self.num_pools as usize]
    }

    pub fn asset_index(&self, mint: &Pubkey) -> Option<usize> {
        self.assets().iter().position(|a| a.mint == *mint)
    }
}
