use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    cp_amm,
    cpi::{self, Damm, VaultSigner},
    damm,
    error::ErrorCode,
    events::{Deposited, Redeemed},
    instructions::common::{pool_side, position, program_for, split_remaining},
    math,
    state::Vault,
};

/// Accounts for `deposit` and `redeem`. Remaining accounts, in the vault's order:
/// - per asset: the user's token account (w), the vault reserve (w), the mint;
/// - per pool: pool (w), position (w), position NFT account, token A vault (w), token B vault (w).
#[derive(Accounts)]
pub struct Holder<'info> {
    pub user: Signer<'info>,

    #[account(has_one = share_mint)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = share_mint, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: fixed cp-amm PDA.
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// CHECK: fixed cp-amm PDA.
    #[account(address = DAMM_EVENT_AUTHORITY)]
    pub damm_event_authority: UncheckedAccount<'info>,

    /// CHECK: the cp-amm program.
    #[account(address = cp_amm::ID)]
    pub damm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub share_token_program: Interface<'info, TokenInterface>,
}

/// Mints `shares` for their pro-rata slice of everything the vault holds: the liquidity of every
/// position (rounded up) and the idle balance of every reserve (rounded up).
///
/// Pulls `max_amounts[k]` of each asset into the vault's reserves, adds the liquidity, keeps the
/// idle slice, and refunds the rest. If the pools took more than the user sent, the shortfall
/// would come out of the idle balances, so the final check on every reserve also bounds slippage.
pub fn handle_deposit<'info>(ctx: Context<'info, Holder<'info>>, shares: u64, max_amounts: Vec<u64>) -> Result<()> {
    let accounts = &ctx.accounts;
    let vault = &accounts.vault;
    require!(!vault.deposits_paused, ErrorCode::DepositsPaused);
    require!(shares > 0, ErrorCode::ZeroAmount);
    require!(max_amounts.len() == vault.num_assets as usize, ErrorCode::WrongAccountCount);
    let supply = accounts.share_mint.supply;
    require!(supply > 0, ErrorCode::VaultEmpty);

    let (assets, pools) = split_remaining(vault, ctx.remaining_accounts)?;
    let token_program = accounts.token_program.to_account_info();
    let token_2022_program = accounts.token_2022_program.to_account_info();
    let user = accounts.user.to_account_info();
    let vault_info = accounts.vault.to_account_info();
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.stock.as_ref(), &[vault.bump]];
    let signer = VaultSigner { vault: &vault_info, seeds };
    let (damm_program, event_authority) = (accounts.damm_program.to_account_info(), accounts.damm_event_authority.to_account_info());
    let damm = Damm { program: &damm_program, event_authority: &event_authority, pool_authority: None };

    // The idle slice is computed on the balances before anything moves.
    let mut kept = Vec::with_capacity(assets.len());
    for (k, acc) in assets.iter().enumerate() {
        let asset = &vault.assets[k];
        let balance = damm::token_amount(acc.reserve)?;
        let owed = math::amount_for_shares(shares, balance, supply, true).ok_or(ErrorCode::MathOverflow)?;
        kept.push(balance.checked_add(owed).ok_or(ErrorCode::MathOverflow)?);
        let program = program_for(asset, &token_program, &token_2022_program)?;
        cpi::transfer(program, acc.user, acc.mint, acc.reserve, &user, None, max_amounts[k], asset.decimals)?;
    }

    for (slot, pool) in vault.pools().iter().zip(pools.iter()) {
        let liquidity = damm::position_liquidity(pool.position)?;
        let delta = math::liquidity_for_shares(shares, liquidity, supply, true).ok_or(ErrorCode::MathOverflow)?;
        if delta == 0 {
            continue;
        }
        let side = pool_side(vault, slot, pool, &assets, &token_program, &token_2022_program)?;
        cpi::add_liquidity(&damm, &side, &position(pool), &signer, delta, u64::MAX, u64::MAX)?;
    }

    let mut paid = Vec::with_capacity(assets.len());
    for (k, acc) in assets.iter().enumerate() {
        let asset = &vault.assets[k];
        let balance = damm::token_amount(acc.reserve)?;
        require!(balance >= kept[k], ErrorCode::SlippageExceeded);
        let refund = balance - kept[k];
        let program = program_for(asset, &token_program, &token_2022_program)?;
        cpi::transfer(program, acc.reserve, acc.mint, acc.user, &vault_info, Some(seeds), refund, asset.decimals)?;
        paid.push(max_amounts[k] - refund);
    }

    token_interface::mint_to(
        CpiContext::new_with_signer(
            accounts.share_token_program.key(),
            MintTo {
                mint: accounts.share_mint.to_account_info(),
                to: accounts.user_shares.to_account_info(),
                authority: vault_info.clone(),
            },
            &[seeds],
        ),
        shares,
    )?;

    emit!(Deposited { vault: vault.key(), user: user.key(), shares, amounts: paid });
    Ok(())
}

/// Burns `shares` and pays out their pro-rata slice of everything the vault holds, in kind: the
/// liquidity of every position (rounded down) and the idle balance of every reserve (rounded
/// down). Never paused by the vault; an issuer freezing its own token still blocks that transfer.
pub fn handle_redeem<'info>(ctx: Context<'info, Holder<'info>>, shares: u64, min_amounts: Vec<u64>) -> Result<()> {
    let accounts = &ctx.accounts;
    let vault = &accounts.vault;
    require!(shares > 0, ErrorCode::ZeroAmount);
    require!(min_amounts.len() == vault.num_assets as usize, ErrorCode::WrongAccountCount);
    let supply = accounts.share_mint.supply;
    require!(supply > 0, ErrorCode::VaultEmpty);

    let (assets, pools) = split_remaining(vault, ctx.remaining_accounts)?;
    let token_program = accounts.token_program.to_account_info();
    let token_2022_program = accounts.token_2022_program.to_account_info();
    let vault_info = accounts.vault.to_account_info();
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.stock.as_ref(), &[vault.bump]];
    let signer = VaultSigner { vault: &vault_info, seeds };
    let (damm_program, event_authority, pool_authority) = (
        accounts.damm_program.to_account_info(),
        accounts.damm_event_authority.to_account_info(),
        accounts.damm_pool_authority.to_account_info(),
    );
    let damm = Damm { program: &damm_program, event_authority: &event_authority, pool_authority: Some(&pool_authority) };

    let mut before = Vec::with_capacity(assets.len());
    for acc in assets.iter() {
        before.push(damm::token_amount(acc.reserve)?);
    }

    for (slot, pool) in vault.pools().iter().zip(pools.iter()) {
        let liquidity = damm::position_liquidity(pool.position)?;
        let delta = math::liquidity_for_shares(shares, liquidity, supply, false).ok_or(ErrorCode::MathOverflow)?;
        if delta == 0 {
            continue;
        }
        let side = pool_side(vault, slot, pool, &assets, &token_program, &token_2022_program)?;
        cpi::remove_liquidity(&damm, &side, &position(pool), &signer, delta, 0, 0)?;
    }

    let mut received = Vec::with_capacity(assets.len());
    for (k, acc) in assets.iter().enumerate() {
        let asset = &vault.assets[k];
        let from_pools = damm::token_amount(acc.reserve)? - before[k];
        let idle = math::amount_for_shares(shares, before[k], supply, false).ok_or(ErrorCode::MathOverflow)?;
        let payout = from_pools.checked_add(idle).ok_or(ErrorCode::MathOverflow)?;
        require!(payout >= min_amounts[k], ErrorCode::SlippageExceeded);
        let program = program_for(asset, &token_program, &token_2022_program)?;
        cpi::transfer(program, acc.reserve, acc.mint, acc.user, &vault_info, Some(seeds), payout, asset.decimals)?;
        received.push(payout);
    }

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

    emit!(Redeemed { vault: vault.key(), user: accounts.user.key(), shares, amounts: received });
    Ok(())
}
