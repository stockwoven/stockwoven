use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    cp_amm::{
        self,
        types::{AddLiquidityParameters, SwapParameters},
    },
    damm,
    error::ErrorCode,
    events::DepositedSingle,
    instructions::deposit::{refund, transfer_in},
    math,
    state::Vault,
};

#[derive(Accounts)]
pub struct DepositSingle<'info> {
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

    /// The user's account for each issuer token: one is the input, both receive refunds.
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

    /// CHECK: matches `vault.pool`; read through `damm::read_pool`, which checks owner and type.
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

/// Deposits one issuer's token. The vault swaps the right part of it to the other issuer on the
/// DAMM v2 pool (at the pool's price, never at an assumed 1:1), adds both as liquidity, refunds
/// the dust, and mints shares for all but `ZAP_FEE_BPS` of the liquidity added. That fee stays
/// in the position, so it raises the value of every existing share.
pub fn handle_deposit_single(
    ctx: Context<DepositSingle>,
    input_is_a: bool,
    amount_in: u64,
    min_shares: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.deposits_paused, ErrorCode::DepositsPaused);
    require!(amount_in > 0, ErrorCode::ZeroAmount);

    let accounts = &ctx.accounts;
    let pool_key = accounts.pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[accounts.vault.bump]];
    let (reserve_a_before, reserve_b_before) = (accounts.reserve_a.amount, accounts.reserve_b.amount);

    let (user_in, reserve_in, mint_in, program_in, reserve_out) = if input_is_a {
        (&accounts.user_token_a, &accounts.reserve_a, &accounts.token_a_mint, &accounts.token_a_program, &accounts.reserve_b)
    } else {
        (&accounts.user_token_b, &accounts.reserve_b, &accounts.token_b_mint, &accounts.token_b_program, &accounts.reserve_a)
    };
    transfer_in(program_in, user_in, mint_in, reserve_in, &accounts.user, amount_in)?;

    let pool = damm::read_pool(&accounts.pool)?;
    let pool_reserve_in = if input_is_a { pool.token_a_amount } else { pool.token_b_amount };
    let swapped = math::zap_swap_amount(pool_reserve_in, amount_in).ok_or(ErrorCode::MathOverflow)?;
    if swapped > 0 {
        // Slippage is enforced once, on the shares minted (`min_shares`).
        cp_amm::cpi::swap(
            CpiContext::new_with_signer(
                accounts.damm_program.key(),
                cp_amm::cpi::accounts::Swap {
                    pool_authority: accounts.damm_pool_authority.to_account_info(),
                    pool: accounts.pool.to_account_info(),
                    input_token_account: reserve_in.to_account_info(),
                    output_token_account: reserve_out.to_account_info(),
                    token_a_vault: accounts.token_a_vault.to_account_info(),
                    token_b_vault: accounts.token_b_vault.to_account_info(),
                    token_a_mint: accounts.token_a_mint.to_account_info(),
                    token_b_mint: accounts.token_b_mint.to_account_info(),
                    payer: accounts.vault.to_account_info(),
                    token_a_program: accounts.token_a_program.to_account_info(),
                    token_b_program: accounts.token_b_program.to_account_info(),
                    referral_token_account: None,
                    event_authority: accounts.damm_event_authority.to_account_info(),
                    program: accounts.damm_program.to_account_info(),
                },
                &[vault_seeds],
            ),
            SwapParameters { amount_in: swapped, minimum_amount_out: 0 },
        )?;
    }

    ctx.accounts.reserve_a.reload()?;
    ctx.accounts.reserve_b.reload()?;
    let accounts = &ctx.accounts;
    let balance_a = accounts.reserve_a.amount - reserve_a_before;
    let balance_b = accounts.reserve_b.amount - reserve_b_before;

    // The most liquidity both balances cover at the post-swap reserves. cp-amm rounds the
    // amounts it pulls up, and floor(balance * L / reserve) keeps them within the balances.
    let pool = damm::read_pool(&accounts.pool)?;
    let liquidity_delta = math::mul_div_floor(balance_a, pool.liquidity, pool.token_a_amount)
        .zip(math::mul_div_floor(balance_b, pool.liquidity, pool.token_b_amount))
        .map(|(a, b)| a.min(b))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(liquidity_delta > 0, ErrorCode::ZeroAmount);

    let liquidity_for_holder = liquidity_delta
        .checked_mul((MAX_BASIS_POINTS - ZAP_FEE_BPS) as u128)
        .ok_or(ErrorCode::MathOverflow)?
        / MAX_BASIS_POINTS as u128;
    let shares = math::shares_for_liquidity(
        liquidity_for_holder,
        damm::position_liquidity(&accounts.position)?,
        accounts.share_mint.supply,
        accounts.vault.liquidity_per_share,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    require!(shares > 0 && shares >= min_shares, ErrorCode::SlippageExceeded);

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
            token_a_amount_threshold: balance_a,
            token_b_amount_threshold: balance_b,
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

    emit!(DepositedSingle {
        vault: accounts.vault.key(),
        user: accounts.user.key(),
        input_is_a,
        amount_in,
        swapped,
        shares,
        refund_a,
        refund_b,
    });
    Ok(())
}
