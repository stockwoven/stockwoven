//! CPIs the vault signs: cp-amm liquidity, swaps and fee claims, and token transfers out of its
//! reserves. Accounts come in as `AccountInfo`s because most instructions take their pools and
//! assets from remaining accounts.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::cp_amm::{
    self,
    types::{AddLiquidityParameters, RemoveLiquidityParameters, SwapParameters},
};

/// The cp-amm program and its fixed PDAs.
pub struct Damm<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub pool_authority: Option<&'a AccountInfo<'info>>,
}

/// A cp-amm pool as seen from the vault: the pool, its token vaults, both mints with their
/// token programs, and the vault reserves that pay or receive each side.
pub struct PoolSide<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub token_a_vault: &'a AccountInfo<'info>,
    pub token_b_vault: &'a AccountInfo<'info>,
    pub mint_a: &'a AccountInfo<'info>,
    pub mint_b: &'a AccountInfo<'info>,
    pub program_a: &'a AccountInfo<'info>,
    pub program_b: &'a AccountInfo<'info>,
    pub reserve_a: &'a AccountInfo<'info>,
    pub reserve_b: &'a AccountInfo<'info>,
}

/// The vault's position in a pool.
pub struct Position<'a, 'info> {
    pub position: &'a AccountInfo<'info>,
    pub nft_account: &'a AccountInfo<'info>,
}

/// The vault PDA and its signer seeds.
pub struct VaultSigner<'a, 'info> {
    pub vault: &'a AccountInfo<'info>,
    pub seeds: &'a [&'a [u8]],
}

pub fn add_liquidity<'info>(
    damm: &Damm<'_, 'info>,
    side: &PoolSide<'_, 'info>,
    position: &Position<'_, 'info>,
    signer: &VaultSigner<'_, 'info>,
    liquidity_delta: u128,
    max_a: u64,
    max_b: u64,
) -> Result<()> {
    cp_amm::cpi::add_liquidity(
        CpiContext::new_with_signer(
            damm.program.key(),
            cp_amm::cpi::accounts::AddLiquidity {
                pool: side.pool.clone(),
                position: position.position.clone(),
                token_a_account: side.reserve_a.clone(),
                token_b_account: side.reserve_b.clone(),
                token_a_vault: side.token_a_vault.clone(),
                token_b_vault: side.token_b_vault.clone(),
                token_a_mint: side.mint_a.clone(),
                token_b_mint: side.mint_b.clone(),
                position_nft_account: position.nft_account.clone(),
                signer: signer.vault.clone(),
                token_a_program: side.program_a.clone(),
                token_b_program: side.program_b.clone(),
                event_authority: damm.event_authority.clone(),
                program: damm.program.clone(),
            },
            &[signer.seeds],
        ),
        AddLiquidityParameters {
            liquidity_delta,
            token_a_amount_threshold: max_a,
            token_b_amount_threshold: max_b,
        },
    )
}

/// Removes liquidity into the vault's reserves (`side.reserve_a` / `side.reserve_b`).
pub fn remove_liquidity<'info>(
    damm: &Damm<'_, 'info>,
    side: &PoolSide<'_, 'info>,
    position: &Position<'_, 'info>,
    signer: &VaultSigner<'_, 'info>,
    liquidity_delta: u128,
    min_a: u64,
    min_b: u64,
) -> Result<()> {
    cp_amm::cpi::remove_liquidity(
        CpiContext::new_with_signer(
            damm.program.key(),
            cp_amm::cpi::accounts::RemoveLiquidity {
                pool_authority: damm.pool_authority.expect("pool authority").clone(),
                pool: side.pool.clone(),
                position: position.position.clone(),
                token_a_account: side.reserve_a.clone(),
                token_b_account: side.reserve_b.clone(),
                token_a_vault: side.token_a_vault.clone(),
                token_b_vault: side.token_b_vault.clone(),
                token_a_mint: side.mint_a.clone(),
                token_b_mint: side.mint_b.clone(),
                position_nft_account: position.nft_account.clone(),
                signer: signer.vault.clone(),
                token_a_program: side.program_a.clone(),
                token_b_program: side.program_b.clone(),
                event_authority: damm.event_authority.clone(),
                program: damm.program.clone(),
            },
            &[signer.seeds],
        ),
        RemoveLiquidityParameters {
            liquidity_delta,
            token_a_amount_threshold: min_a,
            token_b_amount_threshold: min_b,
        },
    )
}

/// Swaps between the vault's two reserves on any cp-amm pool.
pub fn swap<'info>(
    damm: &Damm<'_, 'info>,
    side: &PoolSide<'_, 'info>,
    signer: &VaultSigner<'_, 'info>,
    a_to_b: bool,
    amount_in: u64,
    minimum_amount_out: u64,
) -> Result<()> {
    let (input, output) = if a_to_b { (side.reserve_a, side.reserve_b) } else { (side.reserve_b, side.reserve_a) };
    cp_amm::cpi::swap(
        CpiContext::new_with_signer(
            damm.program.key(),
            cp_amm::cpi::accounts::Swap {
                pool_authority: damm.pool_authority.expect("pool authority").clone(),
                pool: side.pool.clone(),
                input_token_account: input.clone(),
                output_token_account: output.clone(),
                token_a_vault: side.token_a_vault.clone(),
                token_b_vault: side.token_b_vault.clone(),
                token_a_mint: side.mint_a.clone(),
                token_b_mint: side.mint_b.clone(),
                payer: signer.vault.clone(),
                token_a_program: side.program_a.clone(),
                token_b_program: side.program_b.clone(),
                referral_token_account: None,
                event_authority: damm.event_authority.clone(),
                program: damm.program.clone(),
            },
            &[signer.seeds],
        ),
        SwapParameters { amount_in, minimum_amount_out },
    )
}

/// Claims the position's fee: token A to `side.reserve_a`, token B to `side.reserve_b`.
pub fn claim_position_fee<'info>(
    damm: &Damm<'_, 'info>,
    side: &PoolSide<'_, 'info>,
    position: &Position<'_, 'info>,
    signer: &VaultSigner<'_, 'info>,
) -> Result<()> {
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
        damm.program.key(),
        cp_amm::cpi::accounts::ClaimPositionFee {
            pool_authority: damm.pool_authority.expect("pool authority").clone(),
            pool: side.pool.clone(),
            position: position.position.clone(),
            token_a_account: side.reserve_a.clone(),
            token_b_account: side.reserve_b.clone(),
            token_a_vault: side.token_a_vault.clone(),
            token_b_vault: side.token_b_vault.clone(),
            token_a_mint: side.mint_a.clone(),
            token_b_mint: side.mint_b.clone(),
            position_nft_account: position.nft_account.clone(),
            signer: signer.vault.clone(),
            token_a_program: side.program_a.clone(),
            token_b_program: side.program_b.clone(),
            event_authority: damm.event_authority.clone(),
            program: damm.program.clone(),
        },
        &[signer.seeds],
    ))
}

/// Moves tokens; `seeds` is `Some` when the vault PDA is the authority.
#[allow(clippy::too_many_arguments)]
pub fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = TransferChecked {
        from: from.clone(),
        mint: mint.clone(),
        to: to.clone(),
        authority: authority.clone(),
    };
    match seeds {
        Some(seeds) => token_interface::transfer_checked(
            CpiContext::new_with_signer(token_program.key(), accounts, &[seeds]),
            amount,
            decimals,
        ),
        None => token_interface::transfer_checked(CpiContext::new(token_program.key(), accounts), amount, decimals),
    }
}
