use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    cp_amm::{self, types::AddLiquidityParameters},
    error::ErrorCode,
    events::Deposited,
    state::Vault,
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,

    #[account(
        has_one = pool,
        has_one = position,
        has_one = position_nft_account,
        has_one = token_a_mint,
        has_one = token_b_mint,
        has_one = reserve_a,
        has_one = reserve_b,
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

    #[account(mut)]
    pub reserve_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub reserve_b: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_a_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_b_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: matches `vault.pool`; cp-amm checks its vaults and mints.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: matches `vault.position`; cp-amm checks it belongs to `pool`.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: matches `vault.position_nft_account`; cp-amm checks it holds the position NFT.
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: cp-amm checks it against `pool.token_a_vault`.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: cp-amm checks it against `pool.token_b_vault`.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

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

/// Pulls up to `max_a`/`max_b` into the vault's reserves, adds exactly
/// `shares * liquidity_per_share` liquidity (cp-amm takes tokens at the pool's current reserve
/// ratio), refunds whatever cp-amm did not take, and mints `shares`.
pub fn handle_deposit(ctx: Context<Deposit>, shares: u64, max_a: u64, max_b: u64) -> Result<()> {
    require!(!ctx.accounts.vault.deposits_paused, ErrorCode::DepositsPaused);
    require!(shares > 0, ErrorCode::ZeroAmount);

    let liquidity_delta = ctx
        .accounts
        .vault
        .shares_to_liquidity(shares)
        .ok_or(ErrorCode::MathOverflow)?;

    let accounts = &ctx.accounts;
    let reserve_a_before = accounts.reserve_a.amount;
    let reserve_b_before = accounts.reserve_b.amount;

    transfer_in(
        &accounts.token_a_program,
        &accounts.user_token_a,
        &accounts.token_a_mint,
        &accounts.reserve_a,
        &accounts.user,
        max_a,
    )?;
    transfer_in(
        &accounts.token_b_program,
        &accounts.user_token_b,
        &accounts.token_b_mint,
        &accounts.reserve_b,
        &accounts.user,
        max_b,
    )?;

    let pool_key = accounts.pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[accounts.vault.bump]];
    cp_amm::cpi::add_liquidity(
        CpiContext::new_with_signer(
            accounts.damm_program.key(),
            cp_amm::cpi::accounts::AddLiquidity {
                pool: accounts.pool.to_account_info(),
                position: accounts.position.to_account_info(),
                token_a_account: accounts.reserve_a.to_account_info(),
                token_b_account: accounts.reserve_b.to_account_info(),
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
        AddLiquidityParameters {
            liquidity_delta,
            token_a_amount_threshold: max_a,
            token_b_amount_threshold: max_b,
        },
    )?;

    ctx.accounts.reserve_a.reload()?;
    ctx.accounts.reserve_b.reload()?;
    let accounts = &ctx.accounts;
    let refund_a = accounts.reserve_a.amount.saturating_sub(reserve_a_before);
    let refund_b = accounts.reserve_b.amount.saturating_sub(reserve_b_before);
    refund(
        &accounts.token_a_program,
        &accounts.reserve_a,
        &accounts.token_a_mint,
        &accounts.user_token_a,
        &accounts.vault,
        vault_seeds,
        refund_a,
    )?;
    refund(
        &accounts.token_b_program,
        &accounts.reserve_b,
        &accounts.token_b_mint,
        &accounts.user_token_b,
        &accounts.vault,
        vault_seeds,
        refund_b,
    )?;

    token_interface::mint_to(
        CpiContext::new_with_signer(
            accounts.share_token_program.key(),
            MintTo {
                mint: accounts.share_mint.to_account_info(),
                to: accounts.user_shares.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares,
    )?;

    emit!(Deposited {
        vault: accounts.vault.key(),
        user: accounts.user.key(),
        shares,
        amount_a: max_a - refund_a,
        amount_b: max_b - refund_b,
    });
    Ok(())
}

fn transfer_in<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

fn refund<'info>(
    token_program: &Interface<'info, TokenInterface>,
    reserve: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    vault: &Account<'info, Vault>,
    vault_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: reserve.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        amount,
        mint.decimals,
    )
}
