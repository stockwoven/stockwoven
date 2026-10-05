pub mod constants;
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

    /// Creates the cross-issuer DAMM v2 pool (compounding fees) with the vault as its first LP,
    /// and the share mint. The admin seeds the pool and receives the matching shares.
    pub fn initialize_vault<'info>(
        ctx: Context<'info, InitializeVault<'info>>,
        args: InitializeVaultArgs,
    ) -> Result<()> {
        crate::instructions::initialize_vault::handle_initialize_vault(ctx, args)
    }

    /// Adds the liquidity behind `shares` (both tokens, at the pool's ratio) and mints `shares`.
    pub fn deposit(ctx: Context<Deposit>, shares: u64, max_a: u64, max_b: u64) -> Result<()> {
        crate::instructions::deposit::handle_deposit(ctx, shares, max_a, max_b)
    }

    /// Deposits one issuer's token: swaps part of it on the pool, adds both as liquidity, and
    /// mints shares net of the vault's zap fee. `min_shares` bounds slippage.
    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        input_is_a: bool,
        amount_in: u64,
        min_shares: u64,
    ) -> Result<()> {
        crate::instructions::deposit_single::handle_deposit_single(ctx, input_is_a, amount_in, min_shares)
    }

    /// Burns `shares` and pays out the matching liquidity in both tokens, in kind.
    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_a: u64, min_b: u64) -> Result<()> {
        crate::instructions::redeem::handle_redeem(ctx, shares, min_a, min_b)
    }

    /// Permissionless: sends the position's claimable fee (the protocol's cut) to the treasury.
    pub fn harvest(ctx: Context<Harvest>) -> Result<()> {
        crate::instructions::harvest::handle_harvest(ctx)
    }

    pub fn set_deposits_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        crate::instructions::admin::handle_set_deposits_paused(ctx, paused)
    }
}
