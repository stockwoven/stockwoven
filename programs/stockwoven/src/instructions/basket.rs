//! Single-token deposits and redemptions, Sanctum Infinity style.
//!
//! - **Entry with any one token.** An issuer's token goes into its reserve, valued 1:1 with one
//!   share of the stock. USDC or SOL is converted on a cp-amm pool, inside the instruction, into
//!   an issuer token below its target weight, and valued as that token.
//! - **Target weights and caps.** Every asset has a target share of the vault's value and a cap.
//!   A deposit that would push its token over the cap is refused.
//! - **Dynamic fee.** Depositing an overweight token costs more; an underweight one costs less, or
//!   earns a small discount. Redemptions work the other way round, so the market itself keeps the
//!   vault balanced.
//! - **Circuit breaker.** 1:1 only holds inside a ±band: an issuer token whose market price leaves
//!   it is neither taken in nor paid out alone. USDC and SOL are valued at the keeper's prices,
//!   which must be fresh, and every vault pool must trade inside the band around them, so a pool
//!   pushed off its price within the transaction cannot skew the valuation.
//! - **Exit.** In-kind `redeem` stays the default and needs no price. `redeem_single` pays one
//!   issuer token, paying the dynamic fee; selling it for cash is a client-side swap.
//!
//! The fee stays in the vault, for the holders.

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
    events::{BasketSet, DepositedSingle, PricesSet, RedeemedSingle},
    instructions::{
        common::{position, program_for, reserve_side, split_single, PoolAccounts, ReserveAccounts},
        keeper::external_side,
    },
    math,
    state::{AssetWeights, Basket, BasketParams, Vault},
};

#[derive(Accounts)]
pub struct InitBasket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(has_one = admin @ ErrorCode::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Basket::INIT_SPACE,
        seeds = [BASKET_SEED, vault.key().as_ref()],
        bump
    )]
    pub basket: Box<Account<'info, Basket>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetBasket<'info> {
    pub admin: Signer<'info>,

    #[account(has_one = admin @ ErrorCode::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, has_one = vault, seeds = [BASKET_SEED, vault.key().as_ref()], bump = basket.bump)]
    pub basket: Box<Account<'info, Basket>>,
}

#[derive(Accounts)]
pub struct SetPrices<'info> {
    pub keeper: Signer<'info>,

    #[account(has_one = keeper @ ErrorCode::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, has_one = vault, seeds = [BASKET_SEED, vault.key().as_ref()], bump = basket.bump)]
    pub basket: Box<Account<'info, Basket>>,
}

/// Creates the vault's basket. Single-token deposits and redemptions stay closed until the keeper
/// posts prices.
pub fn handle_init_basket(ctx: Context<InitBasket>, params: BasketParams, weights: Vec<AssetWeights>) -> Result<()> {
    let basket = &mut ctx.accounts.basket;
    basket.vault = ctx.accounts.vault.key();
    basket.bump = ctx.bumps.basket;
    basket.prices_updated_at = 0;
    apply_settings(basket, &ctx.accounts.vault, params, weights)
}

/// Changes the fee, the band and the per-asset weights. Also used after `add_asset`, to cover
/// the new asset.
pub fn handle_set_basket(ctx: Context<SetBasket>, params: BasketParams, weights: Vec<AssetWeights>) -> Result<()> {
    apply_settings(&mut ctx.accounts.basket, &ctx.accounts.vault, params, weights)
}

fn apply_settings(basket: &mut Basket, vault: &Vault, params: BasketParams, weights: Vec<AssetWeights>) -> Result<()> {
    require!(weights.len() == vault.num_assets as usize, ErrorCode::WrongAccountCount);
    require!(
        params.band_bps <= MAX_BAND_BPS
            && params.base_fee_bps <= params.max_fee_bps
            && params.max_fee_bps <= MAX_BASKET_FEE_BPS
            && params.max_discount_bps <= MAX_BASKET_DISCOUNT_BPS
            && params.max_price_age > 0,
        ErrorCode::InvalidBasket
    );
    require!(
        weights.iter().all(|w| w.target_weight_bps <= w.max_weight_bps && w.max_weight_bps <= MAX_BASIS_POINTS),
        ErrorCode::InvalidWeight
    );
    require!(
        weights.iter().map(|w| w.target_weight_bps as u32).sum::<u32>() <= MAX_BASIS_POINTS as u32,
        ErrorCode::InvalidWeight
    );
    basket.params = params;
    for (asset, w) in basket.assets.iter_mut().zip(&weights) {
        asset.weights = *w;
    }
    basket.num_assets = vault.num_assets;
    emit!(BasketSet { vault: basket.vault, params, weights });
    Ok(())
}

/// Keeper: market prices, in nano-shares of the stock per whole token, one per asset in the
/// vault's order. USDC and SOL are valued at them; issuer tokens are always valued 1:1, and their
/// price only feeds the circuit breaker.
pub fn handle_set_prices(ctx: Context<SetPrices>, prices: Vec<u64>) -> Result<()> {
    let basket = &mut ctx.accounts.basket;
    require!(basket.num_assets == ctx.accounts.vault.num_assets, ErrorCode::InvalidBasket);
    require!(prices.len() == basket.num_assets as usize, ErrorCode::WrongAccountCount);
    require!(prices.iter().all(|&p| p > 0), ErrorCode::ZeroAmount);
    for (asset, &price) in basket.assets.iter_mut().zip(&prices) {
        asset.price = price;
    }
    let now = Clock::get()?.unix_timestamp;
    basket.prices_updated_at = now;
    emit!(PricesSet { vault: ctx.accounts.vault.key(), prices, updated_at: now });
    Ok(())
}

/// Accounts for `deposit_single` and `redeem_single`. Remaining accounts, in the vault's order:
/// - per asset: the vault reserve (w), the mint;
/// - per pool: pool (w), position (w), position NFT account, token A vault (w), token B vault (w);
/// - `deposit_single` only, to convert the token first: a cp-amm pool (w), its token A vault (w),
///   token B vault (w), mint A and mint B. Both mints must be vault assets, one of them `mint`.
#[derive(Accounts)]
pub struct Single<'info> {
    pub user: Signer<'info>,

    #[account(has_one = share_mint)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(has_one = vault, seeds = [BASKET_SEED, vault.key().as_ref()], bump = basket.bump)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = share_mint, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the user's account of `mint`: where a deposit comes from, or where a redemption
    /// goes. The token program checks it against `mint`.
    #[account(mut)]
    pub user_token: UncheckedAccount<'info>,

    /// CHECK: a vault asset, checked in the handler.
    pub mint: UncheckedAccount<'info>,

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

/// Everything the vault holds, per asset and in total, valued in nano-shares of the stock.
struct Book {
    /// Raw amounts: the idle reserve plus the vault's slice of every pool's reserves.
    amounts: Vec<u64>,
    /// Issuer tokens at 1:1, USDC and SOL at the keeper's prices.
    values: Vec<u128>,
    nav: u128,
}

impl Book {
    fn weight(&self, k: usize) -> i64 {
        math::weight_bps(self.values[k], self.nav)
    }
}

/// What the vault values an asset at: one share per issuer token, the keeper's price otherwise.
fn valuation_price(basket: &Basket, k: usize) -> u64 {
    if basket.assets[k].weights.is_stock {
        NANO_SHARES_PER_SHARE
    } else {
        basket.assets[k].price
    }
}

/// Values the vault and trips the circuit breaker on stale prices or a pool outside the band.
fn book(vault: &Vault, basket: &Basket, reserves: &[ReserveAccounts], pools: &[PoolAccounts]) -> Result<Book> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        basket.prices_updated_at > 0 && now.saturating_sub(basket.prices_updated_at) <= basket.params.max_price_age as i64,
        ErrorCode::PricesStale
    );

    let mut amounts = reserves.iter().map(|r| damm::token_amount(r.reserve)).collect::<Result<Vec<_>>>()?;
    for (slot, pool) in vault.pools().iter().zip(pools) {
        let state = damm::read_pool(pool.pool)?;
        let (a, b) = (slot.asset_a as usize, slot.asset_b as usize);
        let (asset_a, asset_b) = (&vault.assets[a], &vault.assets[b]);
        // A constant-product pool holds equal value on both sides at its own price, so equal
        // value at the keeper's prices means the pool trades at them.
        require!(
            math::within_band(
                math::value_of(state.token_a_amount, asset_a.decimals, basket.assets[a].price),
                math::value_of(state.token_b_amount, asset_b.decimals, basket.assets[b].price),
                basket.params.band_bps,
            ),
            ErrorCode::PoolOutOfBand
        );
        let liquidity = damm::position_liquidity(pool.position)?;
        amounts[a] = amounts[a].saturating_add(math::pro_rata(state.token_a_amount, liquidity, state.liquidity));
        amounts[b] = amounts[b].saturating_add(math::pro_rata(state.token_b_amount, liquidity, state.liquidity));
    }

    let values: Vec<u128> = amounts
        .iter()
        .enumerate()
        .map(|(k, &amount)| math::value_of(amount, vault.assets[k].decimals, valuation_price(basket, k)))
        .collect();
    let nav = values.iter().sum();
    require!(nav > 0, ErrorCode::VaultEmpty);
    Ok(Book { amounts, values, nav })
}

/// An issuer token whose market price is inside the 1:1 band.
fn pegged(basket: &Basket, k: usize) -> bool {
    let asset = &basket.assets[k];
    asset.weights.is_stock
        && math::within_band(asset.price as u128, NANO_SHARES_PER_SHARE as u128, basket.params.band_bps)
}

fn require_pegged(basket: &Basket, k: usize) -> Result<()> {
    require!(basket.assets[k].weights.is_stock, ErrorCode::NotAStock);
    require!(pegged(basket, k), ErrorCode::TokenDepegged);
    Ok(())
}

fn require_ready(vault: &Vault, basket: &Basket) -> Result<()> {
    require!(basket.num_assets == vault.num_assets, ErrorCode::InvalidBasket);
    Ok(())
}

/// Takes `amount_in` of one token and mints shares for its value after the dynamic fee.
///
/// An issuer token is valued 1:1. With the conversion swap accounts, the token is first swapped
/// into another asset inside the vault, which must be an issuer token below its target weight
/// (or the most underweight one): this is how USDC and SOL come in, and how a token at its cap
/// is redirected. `min_shares` bounds the whole trade, swap included.
pub fn handle_deposit_single<'info>(ctx: Context<'info, Single<'info>>, amount_in: u64, min_shares: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let (vault, basket) = (&accounts.vault, &accounts.basket);
    require!(!vault.deposits_paused, ErrorCode::DepositsPaused);
    require!(amount_in > 0, ErrorCode::ZeroAmount);
    let supply = accounts.share_mint.supply;
    require!(supply > 0, ErrorCode::VaultEmpty);
    require_ready(vault, basket)?;

    let (reserves, pools, swap) = split_single(vault, ctx.remaining_accounts, true)?;
    let book = book(vault, basket, &reserves, &pools)?;
    let k_in = vault.asset_index(&accounts.mint.key()).ok_or(ErrorCode::UnknownAsset)?;

    let token_program = accounts.token_program.to_account_info();
    let token_2022_program = accounts.token_2022_program.to_account_info();
    let user = accounts.user.to_account_info();
    let vault_info = accounts.vault.to_account_info();
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.stock.as_ref(), &[vault.bump]];
    let signer = VaultSigner { vault: &vault_info, seeds };
    let (damm_program, event_authority, pool_authority) = (
        accounts.damm_program.to_account_info(),
        accounts.damm_event_authority.to_account_info(),
        accounts.damm_pool_authority.to_account_info(),
    );
    let damm = Damm { program: &damm_program, event_authority: &event_authority, pool_authority: Some(&pool_authority) };

    // Measured, not assumed: a token with a transfer fee delivers less than was sent.
    let asset_in = &vault.assets[k_in];
    let reserve_in = reserves[k_in].reserve;
    let before = damm::token_amount(reserve_in)?;
    let program_in = program_for(asset_in, &token_program, &token_2022_program)?;
    cpi::transfer(program_in, accounts.user_token.as_ref(), reserves[k_in].mint, reserve_in, &user, None, amount_in, asset_in.decimals)?;
    let received = damm::token_amount(reserve_in)? - before;
    require!(received > 0, ErrorCode::ZeroAmount);

    let (k, amount) = match swap {
        None => (k_in, received),
        Some(s) => {
            let a = vault.asset_index(&s.mint_a.key()).ok_or(ErrorCode::UnknownAsset)?;
            let b = vault.asset_index(&s.mint_b.key()).ok_or(ErrorCode::UnknownAsset)?;
            require!(k_in == a || k_in == b, ErrorCode::InvalidRoute);
            let (a_to_b, k_out) = if k_in == a { (true, b) } else { (false, a) };
            require!(k_out != k_in, ErrorCode::InvalidRoute);
            require_underweight(basket, &book, k_out)?;
            let side = external_side(
                vault,
                s.pool,
                s.token_a_vault,
                s.token_b_vault,
                s.mint_a,
                s.mint_b,
                reserves[a].reserve,
                reserves[b].reserve,
                &token_program,
                &token_2022_program,
            )?;
            let out_before = damm::token_amount(reserves[k_out].reserve)?;
            cpi::swap(&damm, &side, &signer, a_to_b, received, 0)?;
            (k_out, damm::token_amount(reserves[k_out].reserve)? - out_before)
        }
    };
    require_pegged(basket, k)?;

    let weights = &basket.assets[k].weights;
    let value = math::value_of(amount, vault.assets[k].decimals, NANO_SHARES_PER_SHARE);
    require!(value > 0, ErrorCode::ZeroAmount);
    let held = book.values[k];
    let (w0, w1) = (book.weight(k), math::weight_bps(held + value, book.nav + value));
    require!(w1 <= weights.max_weight_bps as i64, ErrorCode::AssetAtCap);
    let fee_bps = math::dynamic_fee_bps(w0, w1, weights.target_weight_bps, true, &basket.params);
    let shares = math::after_fee(value, fee_bps)
        .checked_mul(supply as u128)
        .map(|n| n / book.nav)
        .and_then(|s| u64::try_from(s).ok())
        .ok_or(ErrorCode::MathOverflow)?;
    require!(shares > 0 && shares >= min_shares, ErrorCode::SlippageExceeded);

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

    emit!(DepositedSingle {
        vault: vault.key(),
        user: user.key(),
        mint_in: accounts.mint.key(),
        amount_in: received,
        mint: vault.assets[k].mint,
        amount,
        value: value as u64,
        fee_bps: fee_bps as i16,
        shares,
    });
    Ok(())
}

/// A converted deposit must land in an issuer token below its target weight, or, if none is,
/// in the most underweight one that is still inside the band.
fn require_underweight(basket: &Basket, book: &Book, k: usize) -> Result<()> {
    let gap = |j: usize| book.weight(j) - basket.assets[j].weights.target_weight_bps as i64;
    let most_underweight = (0..book.values.len()).filter(|&j| pegged(basket, j)).min_by_key(|&j| gap(j));
    require!(
        basket.assets[k].weights.is_stock && (gap(k) < 0 || most_underweight == Some(k)),
        ErrorCode::NotUnderweight
    );
    Ok(())
}

/// Burns `shares` and pays their value, after the dynamic fee, in one issuer token. Pays from the
/// idle reserve first, then takes liquidity out of the vault pools that hold the token; the other
/// side of that liquidity stays in the vault, idle, until the keeper puts it back to work.
pub fn handle_redeem_single<'info>(ctx: Context<'info, Single<'info>>, shares: u64, min_amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let (vault, basket) = (&accounts.vault, &accounts.basket);
    require!(shares > 0, ErrorCode::ZeroAmount);
    let supply = accounts.share_mint.supply;
    require!(supply > 0, ErrorCode::VaultEmpty);
    require_ready(vault, basket)?;

    let (reserves, pools, _) = split_single(vault, ctx.remaining_accounts, false)?;
    let book = book(vault, basket, &reserves, &pools)?;
    let k = vault.asset_index(&accounts.mint.key()).ok_or(ErrorCode::UnknownAsset)?;
    require_pegged(basket, k)?;

    let weights = &basket.assets[k].weights;
    let value = (shares as u128).checked_mul(book.nav).ok_or(ErrorCode::MathOverflow)? / supply as u128;
    let held = book.values[k];
    let w1 = if book.nav > value { math::weight_bps(held.saturating_sub(value), book.nav - value) } else { 0 };
    let fee_bps = math::dynamic_fee_bps(book.weight(k), w1, weights.target_weight_bps, false, &basket.params);
    let decimals = vault.assets[k].decimals;
    let amount = math::amount_for_value(math::after_fee(value, fee_bps), decimals, NANO_SHARES_PER_SHARE)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(amount > 0 && amount >= min_amount, ErrorCode::SlippageExceeded);
    require!(amount <= book.amounts[k], ErrorCode::InsufficientLiquidity);

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

    let reserve = reserves[k].reserve;
    let mut idle = damm::token_amount(reserve)?;
    for (slot, pool) in vault.pools().iter().zip(&pools) {
        if idle >= amount {
            break;
        }
        let side_k = if slot.asset_a as usize == k {
            true
        } else if slot.asset_b as usize == k {
            false
        } else {
            continue;
        };
        let state = damm::read_pool(pool.pool)?;
        let pool_amount = if side_k { state.token_a_amount } else { state.token_b_amount };
        let owned = damm::position_liquidity(pool.position)?;
        if owned == 0 || pool_amount == 0 {
            continue;
        }
        // One extra unit covers cp-amm rounding the amounts it pays out down.
        let delta = math::mul_div_ceil(amount - idle + 1, state.liquidity, pool_amount)
            .ok_or(ErrorCode::MathOverflow)?
            .min(owned);
        let side = reserve_side(vault, slot, pool, &reserves, &token_program, &token_2022_program)?;
        cpi::remove_liquidity(&damm, &side, &position(pool), &signer, delta, 0, 0)?;
        idle = damm::token_amount(reserve)?;
    }
    require!(idle >= amount, ErrorCode::InsufficientLiquidity);

    let asset = &vault.assets[k];
    let program = program_for(asset, &token_program, &token_2022_program)?;
    cpi::transfer(program, reserve, reserves[k].mint, accounts.user_token.as_ref(), &vault_info, Some(seeds), amount, asset.decimals)?;

    emit!(RedeemedSingle {
        vault: vault.key(),
        user: accounts.user.key(),
        shares,
        mint: asset.mint,
        amount,
        value: value as u64,
        fee_bps: fee_bps as i16,
    });
    Ok(())
}
