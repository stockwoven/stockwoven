use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::Vault};

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
