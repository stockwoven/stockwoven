use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, cp_amm, events::Harvested, state::Vault};

#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(
        has_one = pool,
        has_one = position,
        has_one = position_nft_account,
        has_one = token_a_mint,
        has_one = token_b_mint,
        has_one = reserve_a,
        has_one = treasury,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// Receives fee A, which is always zero in compounding pools.
    #[account(mut)]
    pub reserve_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_a_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_b_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: matches `vault.pool`.
    pub pool: UncheckedAccount<'info>,

    /// CHECK: matches `vault.position`.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: matches `vault.position_nft_account`.
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: cp-amm checks it against `pool.token_a_vault`.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: cp-amm checks it against `pool.token_b_vault`.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: fixed cp-amm PDA.
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// CHECK: fixed cp-amm PDA.
    #[account(address = DAMM_EVENT_AUTHORITY)]
    pub damm_event_authority: UncheckedAccount<'info>,

    /// CHECK: the cp-amm program.
    #[account(address = cp_amm::ID)]
    pub damm_program: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,
}

/// The pool splits each LP fee: `compounding_fee_bps` stays in the reserves (holders' yield)
/// and the rest accrues to the position as a claimable fee in token B. That claimable part is
/// the protocol's cut, so anyone may sweep it to the treasury.
pub fn handle_harvest(ctx: Context<Harvest>) -> Result<()> {
    let accounts = &ctx.accounts;
    let treasury_before = accounts.treasury.amount;

    let pool_key = accounts.pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[accounts.vault.bump]];
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
        accounts.damm_program.key(),
        cp_amm::cpi::accounts::ClaimPositionFee {
            pool_authority: accounts.damm_pool_authority.to_account_info(),
            pool: accounts.pool.to_account_info(),
            position: accounts.position.to_account_info(),
            token_a_account: accounts.reserve_a.to_account_info(),
            token_b_account: accounts.treasury.to_account_info(),
            token_a_vault: accounts.token_a_vault.to_account_info(),
            token_b_vault: accounts.token_b_vault.to_account_info(),
            token_a_mint: accounts.token_a_mint.to_account_info(),
            token_b_mint: accounts.token_b_mint.to_account_info(),
            position_nft_account: accounts.position_nft_account.to_account_info(),
            signer: accounts.vault.to_account_info(),
            token_a_program: accounts.token_a_program.to_account_info(),
            token_b_program: accounts.token_b_program.to_account_info(),
            event_authority: accounts.damm_event_authority.to_account_info(),
            program: accounts.damm_program.to_account_info(),
        },
        &[vault_seeds],
    ))?;

    ctx.accounts.treasury.reload()?;
    emit!(Harvested {
        vault: ctx.accounts.vault.key(),
        treasury: ctx.accounts.treasury.key(),
        amount_b: ctx.accounts.treasury.amount.saturating_sub(treasury_before),
    });
    Ok(())
}
