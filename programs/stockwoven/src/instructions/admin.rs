use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_ARB_FEE_BPS, MAX_BASIS_POINTS},
    error::ErrorCode,
    state::Vault,
};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
}

/// Stops new deposits, e.g. when an issuer pauses or freezes its token. Redemptions stay open.
pub fn handle_set_deposits_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.vault.deposits_paused = paused;
    msg!("deposits_paused = {}", paused);
    Ok(())
}

pub fn handle_set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
    ctx.accounts.vault.keeper = keeper;
    Ok(())
}

pub fn handle_set_arb_fee(ctx: Context<AdminOnly>, arb_fee_bps: u16) -> Result<()> {
    require!(arb_fee_bps <= MAX_ARB_FEE_BPS, ErrorCode::InvalidArbFee);
    ctx.accounts.vault.arb_fee_bps = arb_fee_bps;
    Ok(())
}

/// The keeper's target share of the vault's value per pool, in the vault's pool order.
pub fn handle_set_pool_weights(ctx: Context<AdminOnly>, weights: Vec<u16>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(weights.len() == vault.num_pools as usize, ErrorCode::WrongAccountCount);
    require!(
        weights.iter().map(|&w| w as u32).sum::<u32>() <= MAX_BASIS_POINTS as u32,
        ErrorCode::InvalidWeight
    );
    for (slot, weight) in vault.pools.iter_mut().zip(weights) {
        slot.target_weight_bps = weight;
    }
    Ok(())
}
