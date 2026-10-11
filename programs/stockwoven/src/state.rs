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

/// Fee and circuit-breaker settings of a vault's basket.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct BasketParams {
    /// The ±band, in bps, inside which issuer tokens are priced 1:1. A token whose market price
    /// leaves it is refused, and a vault pool whose price drifts this far from the keeper's prices
    /// halts every single-token deposit and redemption.
    pub band_bps: u16,
    /// Fee for a deposit or redemption that leaves the token exactly at its target weight.
    pub base_fee_bps: u16,
    /// Fee added per 100 bps (one percentage point) the token ends up away from its target, in
    /// the direction that hurts the vault: overweight on deposits, underweight on redemptions.
    /// Moving towards the target lowers the fee by the same slope.
    pub fee_slope_bps: u16,
    pub max_fee_bps: u16,
    /// The largest discount (negative fee) a deposit or redemption that rebalances the vault earns.
    pub max_discount_bps: u16,
    /// Single-token deposits and redemptions stop when the keeper's prices are older than this.
    pub max_price_age: u32,
}

/// Per-asset weights, in the vault's asset order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct AssetWeights {
    /// An issuer's token of the stock, valued 1:1 with one share of it. Otherwise USDC or SOL,
    /// valued at the keeper's price and only accepted by converting it into an issuer token.
    pub is_stock: bool,
    /// Target share of the vault's value, in bps.
    pub target_weight_bps: u16,
    /// Cap on the share of the vault's value, in bps. Deposits that would cross it are refused.
    pub max_weight_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct BasketAsset {
    pub weights: AssetWeights,
    /// The keeper's market price, in nano-shares of the stock per whole token (1e9 = one share).
    /// For issuer tokens it only feeds the circuit breaker: the vault always values them 1:1.
    pub price: u64,
}

/// Single-token deposits and redemptions, Sanctum Infinity style: the vault takes or pays one
/// token, values issuer tokens 1:1, and charges a fee that depends on how the trade moves that
/// token's weight against its target. Lives next to the vault at `["basket", vault]`.
#[account]
#[derive(InitSpace)]
pub struct Basket {
    pub vault: Pubkey,
    pub bump: u8,
    pub params: BasketParams,
    /// Assets configured; must match the vault's.
    pub num_assets: u8,
    pub assets: [BasketAsset; MAX_ASSETS],
    /// Unix time of the keeper's last `set_prices`.
    pub prices_updated_at: i64,
}
