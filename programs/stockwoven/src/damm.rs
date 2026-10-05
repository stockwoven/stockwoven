//! Read-only views of cp-amm accounts. Offsets include the 8-byte discriminator
//! (cp-amm 0.2.4 / 0.2.5 zero-copy layouts).

use anchor_lang::prelude::*;

use crate::{cp_amm, error::ErrorCode};

const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

const POOL_LIQUIDITY: usize = 360;
const POOL_TOKEN_A_AMOUNT: usize = 680;
const POOL_TOKEN_B_AMOUNT: usize = 688;
const POSITION_UNLOCKED_LIQUIDITY: usize = 152;

pub struct PoolReserves {
    pub liquidity: u128,
    pub token_a_amount: u64,
    pub token_b_amount: u64,
}

fn read<const N: usize>(data: &[u8], offset: usize) -> [u8; N] {
    data[offset..offset + N].try_into().unwrap()
}

fn checked_data<'a>(
    account: &'a AccountInfo,
    discriminator: &[u8; 8],
    min_len: usize,
) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*account.owner, cp_amm::ID, ErrorCode::InvalidDammAccount);
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= min_len && data[..8] == discriminator[..],
        ErrorCode::InvalidDammAccount
    );
    Ok(data)
}

/// Total pool liquidity and the reserves that back it. Compounding fees raise the reserves
/// while the liquidity stays the same.
pub fn read_pool(pool: &AccountInfo) -> Result<PoolReserves> {
    let data = checked_data(pool, &POOL_DISCRIMINATOR, POOL_TOKEN_B_AMOUNT + 8)?;
    Ok(PoolReserves {
        liquidity: u128::from_le_bytes(read(&data, POOL_LIQUIDITY)),
        token_a_amount: u64::from_le_bytes(read(&data, POOL_TOKEN_A_AMOUNT)),
        token_b_amount: u64::from_le_bytes(read(&data, POOL_TOKEN_B_AMOUNT)),
    })
}

/// The vault's liquidity. It never vests or locks its position, so all of it is unlocked.
pub fn position_liquidity(position: &AccountInfo) -> Result<u128> {
    let data = checked_data(position, &POSITION_DISCRIMINATOR, POSITION_UNLOCKED_LIQUIDITY + 16)?;
    Ok(u128::from_le_bytes(read(&data, POSITION_UNLOCKED_LIQUIDITY)))
}
