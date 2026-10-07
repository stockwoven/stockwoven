//! What the keeper does with the vault's holdings: move liquidity between pools, swap between
//! reserves, and arbitrage price gaps between pools. Shares are a pro-rata claim on positions
//! and idle reserves alike, so none of these changes how many shares exist, and holders can
//! deposit or redeem between any two steps.

use anchor_lang::prelude::*;
use anchor_spl::{token::Token, token_2022::Token2022};

use crate::{
    constants::*,
    cp_amm,
    cpi::{self, Damm, PoolSide, Position, VaultSigner},
    damm,
    error::ErrorCode,
    events::{Arbitraged, Harvested, Rebalanced, VaultSwapped},
    instructions::common::program_for,
    math,
    state::Vault,
};

/// One of the vault's own pools, with the reserves of its two assets.
#[derive(Accounts)]
pub struct VaultPool<'info> {
    /// The keeper for rebalances; anyone for `harvest`.
    pub caller: Signer<'info>,

    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: matches the vault's pool slot.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: matches the vault's pool slot.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: matches the vault's pool slot.
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: matches the vault's pool slot.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: matches the vault's pool slot.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: the vault reserve of the pool's token A.
    #[account(mut)]
    pub reserve_a: UncheckedAccount<'info>,

    /// CHECK: the vault reserve of the pool's token B; for `harvest`, a treasury token account.
    #[account(mut)]
    pub reserve_b: UncheckedAccount<'info>,

    /// CHECK: matches the vault's asset.
    pub mint_a: UncheckedAccount<'info>,

    /// CHECK: matches the vault's asset.
    pub mint_b: UncheckedAccount<'info>,

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
}

/// The fixed accounts every keeper CPI needs, held as owned infos so the CPI helpers can borrow them.
struct Infos<'info> {
    vault: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    token_2022_program: AccountInfo<'info>,
    damm_program: AccountInfo<'info>,
    event_authority: AccountInfo<'info>,
    pool_authority: AccountInfo<'info>,
}

impl<'info> Infos<'info> {
    fn damm(&self) -> Damm<'_, 'info> {
        Damm { program: &self.damm_program, event_authority: &self.event_authority, pool_authority: Some(&self.pool_authority) }
    }
}

fn vault_infos<'info>(a: &VaultPool<'info>) -> Infos<'info> {
    Infos {
        vault: a.vault.to_account_info(),
        token_program: a.token_program.to_account_info(),
        token_2022_program: a.token_2022_program.to_account_info(),
        damm_program: a.damm_program.to_account_info(),
        event_authority: a.damm_event_authority.to_account_info(),
        pool_authority: a.damm_pool_authority.to_account_info(),
    }
}

/// Checks the accounts against pool slot `index`. `check_reserve_b` is false for `harvest`, whose
/// token B destination is a treasury account.
fn check_slot(a: &VaultPool, index: u8, check_reserve_b: bool) -> Result<()> {
    let vault = &a.vault;
    let slot = vault.pools().get(index as usize).ok_or(ErrorCode::UnknownPool)?;
    let (asset_a, asset_b) = (&vault.assets[slot.asset_a as usize], &vault.assets[slot.asset_b as usize]);
    require_keys_eq!(a.pool.key(), slot.pool, ErrorCode::AccountMismatch);
    require_keys_eq!(a.position.key(), slot.position, ErrorCode::AccountMismatch);
    require_keys_eq!(a.position_nft_account.key(), slot.position_nft_account, ErrorCode::AccountMismatch);
    require_keys_eq!(a.token_a_vault.key(), slot.token_a_vault, ErrorCode::AccountMismatch);
    require_keys_eq!(a.token_b_vault.key(), slot.token_b_vault, ErrorCode::AccountMismatch);
    require_keys_eq!(a.mint_a.key(), asset_a.mint, ErrorCode::AccountMismatch);
    require_keys_eq!(a.mint_b.key(), asset_b.mint, ErrorCode::AccountMismatch);
    require_keys_eq!(a.reserve_a.key(), asset_a.reserve, ErrorCode::AccountMismatch);
    if check_reserve_b {
        require_keys_eq!(a.reserve_b.key(), asset_b.reserve, ErrorCode::AccountMismatch);
    }
    Ok(())
}

fn side<'a, 'info>(a: &'a VaultPool<'info>, infos: &'a Infos<'info>, index: u8) -> Result<PoolSide<'a, 'info>> {
    let slot = &a.vault.pools[index as usize];
    Ok(PoolSide {
        pool: a.pool.as_ref(),
        token_a_vault: a.token_a_vault.as_ref(),
        token_b_vault: a.token_b_vault.as_ref(),
        mint_a: a.mint_a.as_ref(),
        mint_b: a.mint_b.as_ref(),
        program_a: program_for(&a.vault.assets[slot.asset_a as usize], &infos.token_program, &infos.token_2022_program)?,
        program_b: program_for(&a.vault.assets[slot.asset_b as usize], &infos.token_program, &infos.token_2022_program)?,
        reserve_a: a.reserve_a.as_ref(),
        reserve_b: a.reserve_b.as_ref(),
    })
}

fn require_keeper(a: &VaultPool) -> Result<()> {
    require_keys_eq!(a.caller.key(), a.vault.keeper, ErrorCode::NotKeeper);
    Ok(())
}

/// Moves `liquidity` out of pool `index` into the vault's reserves.
pub fn handle_rebalance_remove(ctx: Context<VaultPool>, index: u8, liquidity: u128, min_a: u64, min_b: u64) -> Result<()> {
    let a = &ctx.accounts;
    require_keeper(a)?;
    check_slot(a, index, true)?;
    require!(liquidity > 0, ErrorCode::ZeroAmount);
    let infos = vault_infos(a);
    let seeds: &[&[u8]] = &[VAULT_SEED, a.vault.stock.as_ref(), &[a.vault.bump]];
    let signer = VaultSigner { vault: &infos.vault, seeds };
    let (before_a, before_b) = (damm::token_amount(&a.reserve_a)?, damm::token_amount(&a.reserve_b)?);
    let position = Position { position: a.position.as_ref(), nft_account: a.position_nft_account.as_ref() };
    cpi::remove_liquidity(&infos.damm(), &side(a, &infos, index)?, &position, &signer, liquidity, min_a, min_b)?;
    emit!(Rebalanced {
        vault: a.vault.key(),
        pool: a.pool.key(),
        added: false,
        liquidity,
        amount_a: damm::token_amount(&a.reserve_a)? - before_a,
        amount_b: damm::token_amount(&a.reserve_b)? - before_b,
    });
    Ok(())
}

/// Adds liquidity to pool `index` from the vault's reserves. `liquidity == 0` adds the most the
/// two idle balances cover at the pool's current reserves.
pub fn handle_rebalance_add(ctx: Context<VaultPool>, index: u8, liquidity: u128, max_a: u64, max_b: u64) -> Result<()> {
    let a = &ctx.accounts;
    require_keeper(a)?;
    check_slot(a, index, true)?;
    let (before_a, before_b) = (damm::token_amount(&a.reserve_a)?, damm::token_amount(&a.reserve_b)?);
    let (liquidity, max_a, max_b) = if liquidity == 0 {
        let pool = damm::read_pool(&a.pool)?;
        let all = math::liquidity_for_amounts(before_a, before_b, pool.liquidity, pool.token_a_amount, pool.token_b_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        (all, before_a, before_b)
    } else {
        (liquidity, max_a, max_b)
    };
    require!(liquidity > 0, ErrorCode::ZeroAmount);
    let infos = vault_infos(a);
    let seeds: &[&[u8]] = &[VAULT_SEED, a.vault.stock.as_ref(), &[a.vault.bump]];
    let signer = VaultSigner { vault: &infos.vault, seeds };
    let position = Position { position: a.position.as_ref(), nft_account: a.position_nft_account.as_ref() };
    cpi::add_liquidity(&infos.damm(), &side(a, &infos, index)?, &position, &signer, liquidity, max_a, max_b)?;
    emit!(Rebalanced {
        vault: a.vault.key(),
        pool: a.pool.key(),
        added: true,
        liquidity,
        amount_a: before_a - damm::token_amount(&a.reserve_a)?,
        amount_b: before_b - damm::token_amount(&a.reserve_b)?,
    });
    Ok(())
}

/// Permissionless: claims pool `index`'s non-compounding fee. Token B goes to the treasury's
/// token account (`reserve_b`), token A (always zero in compounding pools) to the vault reserve.
pub fn handle_harvest(ctx: Context<VaultPool>, index: u8) -> Result<()> {
    let a = &ctx.accounts;
    check_slot(a, index, false)?;
    let slot = &a.vault.pools[index as usize];
    let (mint, owner) = damm::token_mint_and_owner(&a.reserve_b)?;
    require_keys_eq!(mint, a.vault.assets[slot.asset_b as usize].mint, ErrorCode::AccountMismatch);
    require_keys_eq!(owner, a.vault.treasury, ErrorCode::NotTreasury);

    let infos = vault_infos(a);
    let seeds: &[&[u8]] = &[VAULT_SEED, a.vault.stock.as_ref(), &[a.vault.bump]];
    let signer = VaultSigner { vault: &infos.vault, seeds };
    let (before_a, before_b) = (damm::token_amount(&a.reserve_a)?, damm::token_amount(&a.reserve_b)?);
    let position = Position { position: a.position.as_ref(), nft_account: a.position_nft_account.as_ref() };
    cpi::claim_position_fee(&infos.damm(), &side(a, &infos, index)?, &position, &signer)?;
    emit!(Harvested {
        vault: a.vault.key(),
        pool: a.pool.key(),
        amount_a: damm::token_amount(&a.reserve_a)? - before_a,
        amount_b: damm::token_amount(&a.reserve_b)? - before_b,
    });
    Ok(())
}

/// Any cp-amm pool whose two tokens are vault assets, with the vault's reserves for them.
#[derive(Accounts)]
pub struct VaultSwap<'info> {
    pub keeper: Signer<'info>,

    #[account(has_one = keeper @ ErrorCode::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: any cp-amm pool; cp-amm checks it against its vaults and mints.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: checked by cp-amm.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: checked by cp-amm.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: the vault reserve of `mint_a`.
    #[account(mut)]
    pub reserve_a: UncheckedAccount<'info>,

    /// CHECK: the vault reserve of `mint_b`.
    #[account(mut)]
    pub reserve_b: UncheckedAccount<'info>,

    /// CHECK: a vault asset.
    pub mint_a: UncheckedAccount<'info>,

    /// CHECK: a vault asset.
    pub mint_b: UncheckedAccount<'info>,

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
}

/// Wires a cp-amm pool to the vault reserves of its two mints, which must be vault assets.
#[allow(clippy::too_many_arguments)]
fn external_side<'a, 'info>(
    vault: &Vault,
    pool: &'a AccountInfo<'info>,
    token_a_vault: &'a AccountInfo<'info>,
    token_b_vault: &'a AccountInfo<'info>,
    mint_a: &'a AccountInfo<'info>,
    mint_b: &'a AccountInfo<'info>,
    reserve_a: &'a AccountInfo<'info>,
    reserve_b: &'a AccountInfo<'info>,
    token_program: &'a AccountInfo<'info>,
    token_2022_program: &'a AccountInfo<'info>,
) -> Result<PoolSide<'a, 'info>> {
    let asset_a = &vault.assets[vault.asset_index(&mint_a.key()).ok_or(ErrorCode::UnknownAsset)?];
    let asset_b = &vault.assets[vault.asset_index(&mint_b.key()).ok_or(ErrorCode::UnknownAsset)?];
    require_keys_eq!(reserve_a.key(), asset_a.reserve, ErrorCode::AccountMismatch);
    require_keys_eq!(reserve_b.key(), asset_b.reserve, ErrorCode::AccountMismatch);
    Ok(PoolSide {
        pool,
        token_a_vault,
        token_b_vault,
        mint_a,
        mint_b,
        program_a: program_for(asset_a, token_program, token_2022_program)?,
        program_b: program_for(asset_b, token_program, token_2022_program)?,
        reserve_a,
        reserve_b,
    })
}

/// Swaps between two of the vault's reserves on any cp-amm pool, to change what the vault holds
/// before adding liquidity elsewhere. `min_out` bounds the price.
pub fn handle_vault_swap(ctx: Context<VaultSwap>, a_to_b: bool, amount_in: u64, min_out: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount_in > 0, ErrorCode::ZeroAmount);
    let vault_info = a.vault.to_account_info();
    let (token_program, token_2022_program) = (a.token_program.to_account_info(), a.token_2022_program.to_account_info());
    let (damm_program, event_authority, pool_authority) = (
        a.damm_program.to_account_info(),
        a.damm_event_authority.to_account_info(),
        a.damm_pool_authority.to_account_info(),
    );
    let damm = Damm { program: &damm_program, event_authority: &event_authority, pool_authority: Some(&pool_authority) };
    let side = external_side(
        &a.vault,
        a.pool.as_ref(),
        a.token_a_vault.as_ref(),
        a.token_b_vault.as_ref(),
        a.mint_a.as_ref(),
        a.mint_b.as_ref(),
        a.reserve_a.as_ref(),
        a.reserve_b.as_ref(),
        &token_program,
        &token_2022_program,
    )?;
    let seeds: &[&[u8]] = &[VAULT_SEED, a.vault.stock.as_ref(), &[a.vault.bump]];
    let signer = VaultSigner { vault: &vault_info, seeds };

    let output = if a_to_b { &a.reserve_b } else { &a.reserve_a };
    let before = damm::token_amount(output)?;
    cpi::swap(&damm, &side, &signer, a_to_b, amount_in, min_out)?;
    emit!(VaultSwapped {
        vault: a.vault.key(),
        pool: a.pool.key(),
        a_to_b,
        amount_in,
        amount_out: damm::token_amount(output)? - before,
    });
    Ok(())
}

/// Accounts per hop in `arbitrage`: pool (w), token A vault (w), token B vault (w), mint A,
/// mint B, the vault reserve of mint A (w), the vault reserve of mint B (w).
pub const ACCOUNTS_PER_HOP: usize = 7;

#[derive(Accounts)]
pub struct Arbitrage<'info> {
    pub keeper: Signer<'info>,

    #[account(has_one = keeper @ ErrorCode::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: a treasury token account for the route's start mint; checked in the handler.
    #[account(mut)]
    pub treasury_token: UncheckedAccount<'info>,

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
}

/// Runs `amount_in` of a reserve through a cycle of cp-amm pools (`a_to_b[h]` is hop h's
/// direction; each hop swaps exactly what the previous one returned) and back into the same
/// reserve. Lands only if that reserve grew by at least `min_profit`; every other reserve ends
/// where it started. The treasury takes `arb_fee_bps` of the profit; the rest stays with holders.
///
/// The pools can be the vault's own or anyone's. Arbitraging its own pools keeps value the
/// vault's positions would otherwise leak to outside arbitrageurs.
pub fn handle_arbitrage<'info>(
    ctx: Context<'info, Arbitrage<'info>>,
    a_to_b: Vec<bool>,
    amount_in: u64,
    min_profit: u64,
) -> Result<()> {
    let a = &ctx.accounts;
    let hops = a_to_b.len();
    require!((2..=MAX_ARB_HOPS).contains(&hops), ErrorCode::InvalidRoute);
    require!(ctx.remaining_accounts.len() == hops * ACCOUNTS_PER_HOP, ErrorCode::WrongAccountCount);
    require!(amount_in > 0 && min_profit > 0, ErrorCode::ZeroAmount);

    let vault_info = a.vault.to_account_info();
    let (token_program, token_2022_program) = (a.token_program.to_account_info(), a.token_2022_program.to_account_info());
    let (damm_program, event_authority, pool_authority) = (
        a.damm_program.to_account_info(),
        a.damm_event_authority.to_account_info(),
        a.damm_pool_authority.to_account_info(),
    );
    let damm = Damm { program: &damm_program, event_authority: &event_authority, pool_authority: Some(&pool_authority) };
    let seeds: &[&[u8]] = &[VAULT_SEED, a.vault.stock.as_ref(), &[a.vault.bump]];
    let signer = VaultSigner { vault: &vault_info, seeds };

    let sides = ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_HOP)
        .map(|c| external_side(&a.vault, &c[0], &c[1], &c[2], &c[3], &c[4], &c[5], &c[6], &token_program, &token_2022_program))
        .collect::<Result<Vec<_>>>()?;

    // (input, output) of each hop: mint and reserve.
    let ends = |h: usize| {
        let s = &sides[h];
        if a_to_b[h] { ((s.mint_a, s.reserve_a), (s.mint_b, s.reserve_b)) } else { ((s.mint_b, s.reserve_b), (s.mint_a, s.reserve_a)) }
    };
    let (start_mint, start_reserve) = ends(0).0;
    require_keys_eq!(ends(hops - 1).1 .0.key(), start_mint.key(), ErrorCode::InvalidRoute);
    for h in 0..hops - 1 {
        let out = ends(h).1 .0.key();
        require_keys_eq!(out, ends(h + 1).0 .0.key(), ErrorCode::InvalidRoute);
        require!(out != start_mint.key(), ErrorCode::InvalidRoute);
    }

    let start_before = damm::token_amount(start_reserve)?;
    let mut amount = amount_in;
    for (h, side) in sides.iter().enumerate() {
        let out_reserve = ends(h).1 .1;
        let before = damm::token_amount(out_reserve)?;
        cpi::swap(&damm, side, &signer, a_to_b[h], amount, 0)?;
        amount = damm::token_amount(out_reserve)? - before;
    }
    let start_after = damm::token_amount(start_reserve)?;
    let gross = start_after.saturating_sub(start_before);
    require!(start_after >= start_before && gross >= min_profit, ErrorCode::NotProfitable);

    let start_asset = &a.vault.assets[a.vault.asset_index(&start_mint.key()).ok_or(ErrorCode::UnknownAsset)?];
    let fee = math::bps_of(gross, a.vault.arb_fee_bps);
    if fee > 0 {
        let (mint, owner) = damm::token_mint_and_owner(&a.treasury_token)?;
        require_keys_eq!(mint, start_mint.key(), ErrorCode::AccountMismatch);
        require_keys_eq!(owner, a.vault.treasury, ErrorCode::NotTreasury);
        let program = program_for(start_asset, &token_program, &token_2022_program)?;
        cpi::transfer(program, start_reserve, start_mint, a.treasury_token.as_ref(), &vault_info, Some(seeds), fee, start_asset.decimals)?;
    }

    emit!(Arbitraged {
        vault: a.vault.key(),
        mint: start_mint.key(),
        hops: hops as u8,
        amount_in,
        profit: gross - fee,
        fee,
    });
    Ok(())
}
