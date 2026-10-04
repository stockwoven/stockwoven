use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    cp_amm::{self, types::RemoveLiquidityParameters},
    error::ErrorCode,
    events::Redeemed,
    state::Vault,
};

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub user: Signer<'info>,

    #[account(
        has_one = pool,
        has_one = position,
        has_one = position_nft_account,
        has_one = token_a_mint,
        has_one = token_b_mint,
        has_one = share_mint,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = share_mint, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = token_a_mint, token::token_program = token_a_program)]
    pub user_token_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = token_b_mint, token::token_program = token_b_program)]
    pub user_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_a_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_b_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: matches `vault.pool`.
    #[account(mut)]
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
    pub share_token_program: Interface<'info, TokenInterface>,
}

/// Burns `shares` and removes `shares * liquidity_per_share` liquidity straight to the user,
/// in both tokens at the pool's reserve ratio. Never paused by the vault: holders can always
/// leave in kind (an issuer pausing its own token still blocks that token's transfers).
pub fn handle_redeem(ctx: Context<Redeem>, shares: u64, min_a: u64, min_b: u64) -> Result<()> {
    require!(shares > 0, ErrorCode::ZeroAmount);
    let accounts = &ctx.accounts;
    let liquidity_delta = accounts
        .vault
        .shares_to_liquidity(shares)
        .ok_or(ErrorCode::MathOverflow)?;

    token_interface::burn(
        CpiContext::new(
            accounts.share_token_program.key(),
            Burn {
                mint: accounts.share_mint.to_account_info(),
                from: accounts.user_shares.to_account_info(),
                authority: accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    let pool_key = accounts.pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[accounts.vault.bump]];
    cp_amm::cpi::remove_liquidity(
        CpiContext::new_with_signer(
            accounts.damm_program.key(),
            cp_amm::cpi::accounts::RemoveLiquidity {
                pool_authority: accounts.damm_pool_authority.to_account_info(),
                pool: accounts.pool.to_account_info(),
                position: accounts.position.to_account_info(),
                token_a_account: accounts.user_token_a.to_account_info(),
                token_b_account: accounts.user_token_b.to_account_info(),
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
        ),
        RemoveLiquidityParameters {
            liquidity_delta,
            token_a_amount_threshold: min_a,
            token_b_amount_threshold: min_b,
        },
    )?;

    emit!(Redeemed {
        vault: accounts.vault.key(),
        user: accounts.user.key(),
        shares,
    });
    Ok(())
}
