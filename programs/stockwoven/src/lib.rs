pub mod constants;
pub mod cpi;
pub mod damm;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("H9ZJiWoKXGrje8Y3errCSh2uXUiNpf8mDmjJ7TapZm7b");

// Meteora DAMM v2 bindings, generated from idls/cp_amm.json (cp-amm 0.2.5 IDL).
declare_program!(cp_amm);

#[program]
pub mod stockwoven {
    use super::*;

    /// Creates the vault for one stock (e.g. b"SPCX") and its share mint.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        stock: [u8; 8],
        keeper: Pubkey,
        treasury: Pubkey,
        arb_fee_bps: u16,
    ) -> Result<()> {
        crate::instructions::setup::handle_initialize_vault(ctx, stock, keeper, treasury, arb_fee_bps)
    }

    /// Registers a token the vault may hold and creates its reserve.
    pub fn add_asset(ctx: Context<AddAsset>) -> Result<()> {
        crate::instructions::setup::handle_add_asset(ctx)
    }

    /// Creates a compounding DAMM v2 pool for two assets, owned by the vault. The admin seeds it.
    pub fn add_pool<'info>(ctx: Context<'info, AddPool<'info>>, args: AddPoolArgs) -> Result<()> {
        crate::instructions::setup::handle_add_pool(ctx, args)
    }

    /// Mints `shares` for their pro-rata slice of every position and reserve.
    pub fn deposit<'info>(ctx: Context<'info, Holder<'info>>, shares: u64, max_amounts: Vec<u64>) -> Result<()> {
        crate::instructions::holders::handle_deposit(ctx, shares, max_amounts)
    }

    /// Burns `shares` and pays out their pro-rata slice of every position and reserve, in kind.
    pub fn redeem<'info>(ctx: Context<'info, Holder<'info>>, shares: u64, min_amounts: Vec<u64>) -> Result<()> {
        crate::instructions::holders::handle_redeem(ctx, shares, min_amounts)
    }

    /// Keeper: moves liquidity out of a vault pool into the reserves.
    pub fn rebalance_remove(ctx: Context<VaultPool>, index: u8, liquidity: u128, min_a: u64, min_b: u64) -> Result<()> {
        crate::instructions::keeper::handle_rebalance_remove(ctx, index, liquidity, min_a, min_b)
    }

    /// Keeper: adds liquidity to a vault pool from the reserves (`liquidity == 0`: all it can).
    pub fn rebalance_add(ctx: Context<VaultPool>, index: u8, liquidity: u128, max_a: u64, max_b: u64) -> Result<()> {
        crate::instructions::keeper::handle_rebalance_add(ctx, index, liquidity, max_a, max_b)
    }

    /// Keeper: swaps between two reserves on any cp-amm pool.
    pub fn vault_swap(ctx: Context<VaultSwap>, a_to_b: bool, amount_in: u64, min_out: u64) -> Result<()> {
        crate::instructions::keeper::handle_vault_swap(ctx, a_to_b, amount_in, min_out)
    }

    /// Keeper: a swap cycle across cp-amm pools that must return more than it started with.
    pub fn arbitrage<'info>(
        ctx: Context<'info, Arbitrage<'info>>,
        a_to_b: Vec<bool>,
        amount_in: u64,
        min_profit: u64,
    ) -> Result<()> {
        crate::instructions::keeper::handle_arbitrage(ctx, a_to_b, amount_in, min_profit)
    }

    /// Permissionless: sends a pool's claimable fee (the protocol's cut) to the treasury.
    pub fn harvest(ctx: Context<VaultPool>, index: u8) -> Result<()> {
        crate::instructions::keeper::handle_harvest(ctx, index)
    }

    pub fn set_deposits_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        crate::instructions::admin::handle_set_deposits_paused(ctx, paused)
    }

    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        crate::instructions::admin::handle_set_keeper(ctx, keeper)
    }

    pub fn set_arb_fee(ctx: Context<AdminOnly>, arb_fee_bps: u16) -> Result<()> {
        crate::instructions::admin::handle_set_arb_fee(ctx, arb_fee_bps)
    }

    pub fn set_pool_weights(ctx: Context<AdminOnly>, weights: Vec<u16>) -> Result<()> {
        crate::instructions::admin::handle_set_pool_weights(ctx, weights)
    }
}
