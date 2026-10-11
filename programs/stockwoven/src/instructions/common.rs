//! Remaining-account layouts shared by the instructions that touch every asset and pool.

use anchor_lang::prelude::*;

use crate::{
    cpi::{PoolSide, Position},
    error::ErrorCode,
    state::{Asset, PoolSlot, Vault},
};

/// Accounts per asset in `deposit` / `redeem`: the user's token account, the vault reserve, the mint.
pub const ACCOUNTS_PER_ASSET: usize = 3;
/// Accounts per pool in `deposit` / `redeem`: pool, position, position NFT account, token A vault,
/// token B vault.
pub const ACCOUNTS_PER_POOL: usize = 5;

pub struct AssetAccounts<'a, 'info> {
    pub user: &'a AccountInfo<'info>,
    pub reserve: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
}

pub struct PoolAccounts<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub nft_account: &'a AccountInfo<'info>,
    pub token_a_vault: &'a AccountInfo<'info>,
    pub token_b_vault: &'a AccountInfo<'info>,
}

/// Splits remaining accounts into one group per asset, then one per pool, in the vault's order,
/// and checks every vault-owned account against the vault's records.
pub fn split_remaining<'a, 'info>(
    vault: &Vault,
    remaining: &'a [AccountInfo<'info>],
) -> Result<(Vec<AssetAccounts<'a, 'info>>, Vec<PoolAccounts<'a, 'info>>)> {
    let assets_len = vault.num_assets as usize * ACCOUNTS_PER_ASSET;
    require!(
        remaining.len() == assets_len + vault.num_pools as usize * ACCOUNTS_PER_POOL,
        ErrorCode::WrongAccountCount
    );
    let (asset_infos, pool_infos) = remaining.split_at(assets_len);

    let assets = vault
        .assets()
        .iter()
        .zip(asset_infos.chunks_exact(ACCOUNTS_PER_ASSET))
        .map(|(asset, c)| {
            require_keys_eq!(c[1].key(), asset.reserve, ErrorCode::AccountMismatch);
            require_keys_eq!(c[2].key(), asset.mint, ErrorCode::AccountMismatch);
            Ok(AssetAccounts { user: &c[0], reserve: &c[1], mint: &c[2] })
        })
        .collect::<Result<Vec<_>>>()?;

    let pools = vault
        .pools()
        .iter()
        .zip(pool_infos.chunks_exact(ACCOUNTS_PER_POOL))
        .map(|(slot, c)| check_pool(slot, c))
        .collect::<Result<Vec<_>>>()?;

    Ok((assets, pools))
}

/// The token program an asset lives on, from the two the instruction carries.
pub fn program_for<'a, 'info>(
    asset: &Asset,
    token_program: &'a AccountInfo<'info>,
    token_2022_program: &'a AccountInfo<'info>,
) -> Result<&'a AccountInfo<'info>> {
    if asset.token_program == token_program.key() {
        Ok(token_program)
    } else if asset.token_program == token_2022_program.key() {
        Ok(token_2022_program)
    } else {
        err!(ErrorCode::AccountMismatch)
    }
}

/// A vault pool wired to the vault's reserves for its two assets.
pub fn pool_side<'a, 'info>(
    vault: &Vault,
    slot: &PoolSlot,
    pool: &PoolAccounts<'a, 'info>,
    assets: &[AssetAccounts<'a, 'info>],
    token_program: &'a AccountInfo<'info>,
    token_2022_program: &'a AccountInfo<'info>,
) -> Result<PoolSide<'a, 'info>> {
    let reserves: Vec<_> = assets.iter().map(|a| ReserveAccounts { reserve: a.reserve, mint: a.mint }).collect();
    reserve_side(vault, slot, pool, &reserves, token_program, token_2022_program)
}

/// The same, from the reserve-only layout of the single-token instructions.
pub fn reserve_side<'a, 'info>(
    vault: &Vault,
    slot: &PoolSlot,
    pool: &PoolAccounts<'a, 'info>,
    reserves: &[ReserveAccounts<'a, 'info>],
    token_program: &'a AccountInfo<'info>,
    token_2022_program: &'a AccountInfo<'info>,
) -> Result<PoolSide<'a, 'info>> {
    let (a, b) = (slot.asset_a as usize, slot.asset_b as usize);
    Ok(PoolSide {
        pool: pool.pool,
        token_a_vault: pool.token_a_vault,
        token_b_vault: pool.token_b_vault,
        mint_a: reserves[a].mint,
        mint_b: reserves[b].mint,
        program_a: program_for(&vault.assets[a], token_program, token_2022_program)?,
        program_b: program_for(&vault.assets[b], token_program, token_2022_program)?,
        reserve_a: reserves[a].reserve,
        reserve_b: reserves[b].reserve,
    })
}

/// Accounts per asset in `deposit_single` / `redeem_single`: the vault reserve, the mint.
pub const RESERVE_ACCOUNTS_PER_ASSET: usize = 2;
/// Accounts of the optional conversion swap in `deposit_single`: pool, token A vault, token B
/// vault, mint A, mint B.
pub const SWAP_ACCOUNTS: usize = 5;

pub struct ReserveAccounts<'a, 'info> {
    pub reserve: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
}

pub struct SwapAccounts<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub token_a_vault: &'a AccountInfo<'info>,
    pub token_b_vault: &'a AccountInfo<'info>,
    pub mint_a: &'a AccountInfo<'info>,
    pub mint_b: &'a AccountInfo<'info>,
}

/// Splits the remaining accounts of the single-token instructions: one group per asset (reserve,
/// mint), one per pool (as in `deposit`), then, if `allow_swap`, an optional conversion swap.
#[allow(clippy::type_complexity)]
pub fn split_single<'a, 'info>(
    vault: &Vault,
    remaining: &'a [AccountInfo<'info>],
    allow_swap: bool,
) -> Result<(Vec<ReserveAccounts<'a, 'info>>, Vec<PoolAccounts<'a, 'info>>, Option<SwapAccounts<'a, 'info>>)> {
    let assets_len = vault.num_assets as usize * RESERVE_ACCOUNTS_PER_ASSET;
    let base = assets_len + vault.num_pools as usize * ACCOUNTS_PER_POOL;
    let with_swap = allow_swap && remaining.len() == base + SWAP_ACCOUNTS;
    require!(remaining.len() == base || with_swap, ErrorCode::WrongAccountCount);
    let (asset_infos, rest) = remaining.split_at(assets_len);
    let (pool_infos, swap_infos) = rest.split_at(base - assets_len);

    let reserves = vault
        .assets()
        .iter()
        .zip(asset_infos.chunks_exact(RESERVE_ACCOUNTS_PER_ASSET))
        .map(|(asset, c)| {
            require_keys_eq!(c[0].key(), asset.reserve, ErrorCode::AccountMismatch);
            require_keys_eq!(c[1].key(), asset.mint, ErrorCode::AccountMismatch);
            Ok(ReserveAccounts { reserve: &c[0], mint: &c[1] })
        })
        .collect::<Result<Vec<_>>>()?;

    let pools = vault
        .pools()
        .iter()
        .zip(pool_infos.chunks_exact(ACCOUNTS_PER_POOL))
        .map(|(slot, c)| check_pool(slot, c))
        .collect::<Result<Vec<_>>>()?;

    let swap = with_swap.then(|| SwapAccounts {
        pool: &swap_infos[0],
        token_a_vault: &swap_infos[1],
        token_b_vault: &swap_infos[2],
        mint_a: &swap_infos[3],
        mint_b: &swap_infos[4],
    });
    Ok((reserves, pools, swap))
}

fn check_pool<'a, 'info>(slot: &PoolSlot, c: &'a [AccountInfo<'info>]) -> Result<PoolAccounts<'a, 'info>> {
    require_keys_eq!(c[0].key(), slot.pool, ErrorCode::AccountMismatch);
    require_keys_eq!(c[1].key(), slot.position, ErrorCode::AccountMismatch);
    require_keys_eq!(c[2].key(), slot.position_nft_account, ErrorCode::AccountMismatch);
    require_keys_eq!(c[3].key(), slot.token_a_vault, ErrorCode::AccountMismatch);
    require_keys_eq!(c[4].key(), slot.token_b_vault, ErrorCode::AccountMismatch);
    Ok(PoolAccounts { pool: &c[0], position: &c[1], nft_account: &c[2], token_a_vault: &c[3], token_b_vault: &c[4] })
}

pub fn position<'a, 'info>(pool: &PoolAccounts<'a, 'info>) -> Position<'a, 'info> {
    Position { position: pool.position, nft_account: pool.nft_account }
}
