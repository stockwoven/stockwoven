use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    cp_amm::{
        self,
        types::{BaseFeeParameters, InitializeCustomizablePoolParameters, PoolFeeParameters},
    },
    error::ErrorCode,
    events::{AssetAdded, PoolAdded, VaultInitialized},
    state::{Asset, PoolSlot, Vault},
};

#[derive(Accounts)]
#[instruction(stock: [u8; 8])]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, stock.as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = SHARE_DECIMALS,
        mint::authority = vault,
        mint::token_program = share_token_program
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Creates the vault for one stock and its share mint. Assets and pools come next.
pub fn handle_initialize_vault(
    ctx: Context<InitializeVault>,
    stock: [u8; 8],
    keeper: Pubkey,
    treasury: Pubkey,
    arb_fee_bps: u16,
) -> Result<()> {
    require!(arb_fee_bps <= MAX_ARB_FEE_BPS, ErrorCode::InvalidArbFee);
    let vault = &mut ctx.accounts.vault;
    vault.set_inner(Vault {
        admin: ctx.accounts.admin.key(),
        keeper,
        treasury,
        stock,
        share_mint: ctx.accounts.share_mint.key(),
        arb_fee_bps,
        deposits_paused: false,
        bump: ctx.bumps.vault,
        num_assets: 0,
        assets: Default::default(),
        num_pools: 0,
        pools: Default::default(),
    });
    emit!(VaultInitialized {
        vault: vault.key(),
        stock,
        share_mint: ctx.accounts.share_mint.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin @ ErrorCode::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [RESERVE_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Registers a token the vault may hold (an issuer's stock token, USDC or wSOL) and creates its
/// reserve. Assets are only ever appended, so their indexes are stable.
pub fn handle_add_asset(ctx: Context<AddAsset>) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    let vault = &mut ctx.accounts.vault;
    require!((vault.num_assets as usize) < MAX_ASSETS, ErrorCode::TooManyAssets);
    require!(vault.asset_index(&mint).is_none(), ErrorCode::AssetExists);
    let index = vault.num_assets as usize;
    vault.assets[index] = Asset {
        mint,
        reserve: ctx.accounts.reserve.key(),
        token_program: ctx.accounts.token_program.key(),
        decimals: ctx.accounts.mint.decimals,
    };
    vault.num_assets += 1;
    emit!(AssetAdded { vault: vault.key(), mint, reserve: ctx.accounts.reserve.key() });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AddPoolArgs {
    /// Seed liquidity (Q64.64), paid by the admin.
    pub liquidity: u128,
    /// Initial sqrt(B/A) in raw units, Q64.64.
    pub sqrt_price: u128,
    pub trade_fee_bps: u16,
    /// Share of the LP fee that compounds into the pool for holders; the rest is the
    /// protocol's cut, collected by `harvest`.
    pub compounding_fee_bps: u16,
    /// Shares minted to the admin. Only the first pool mints shares; liquidity seeded into
    /// later pools belongs to the existing holders.
    pub seed_shares: u64,
    pub target_weight_bps: u16,
}

#[derive(Accounts)]
pub struct AddPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin @ ErrorCode::Unauthorized, has_one = share_mint)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = share_mint, token::token_program = share_token_program)]
    pub admin_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: a vault asset (checked in the handler); cp-amm checks it against its token program.
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: a vault asset (checked in the handler); cp-amm checks it against its token program.
    pub token_b_mint: UncheckedAccount<'info>,

    /// CHECK: the admin's token A account; the token program checks the admin signs for it.
    #[account(mut)]
    pub admin_token_a: UncheckedAccount<'info>,

    /// CHECK: the admin's token B account; the token program checks the admin signs for it.
    #[account(mut)]
    pub admin_token_b: UncheckedAccount<'info>,

    /// CHECK: created by cp-amm; the handler checks it is the customizable-pool PDA of the mints.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// Fresh keypair for the position NFT, which cp-amm mints to `position_nft_account`.
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK: cp-amm PDA `["position_nft_account", position_nft_mint]`, created by cp-amm.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["position", position_nft_mint]`, created by cp-amm.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["token_vault", token_a_mint, pool]`, created by cp-amm.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["token_vault", token_b_mint, pool]`, created by cp-amm.
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
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Creates a full-range compounding DAMM v2 pool for two registered assets with the vault as its
/// creator, so the vault owns the first position. The admin pays the seed tokens.
///
/// Remaining accounts: cp-amm token badges, `[0]` for mint A and `[1]` for mint B, when a mint
/// uses Token-2022 extensions that cp-amm only accepts with a badge (xStocks, Backpack, Ondo).
pub fn handle_add_pool<'info>(ctx: Context<'info, AddPool<'info>>, args: AddPoolArgs) -> Result<()> {
    require!(
        args.trade_fee_bps >= 1 && args.trade_fee_bps <= MAX_TRADE_FEE_BPS,
        ErrorCode::InvalidTradeFee
    );
    require!(
        args.compounding_fee_bps >= 1 && args.compounding_fee_bps <= MAX_BASIS_POINTS,
        ErrorCode::InvalidCompoundingFee
    );
    require!(args.target_weight_bps <= MAX_BASIS_POINTS, ErrorCode::InvalidWeight);

    let accounts = &ctx.accounts;
    let vault = &accounts.vault;
    require!((vault.num_pools as usize) < MAX_POOLS, ErrorCode::TooManyPools);
    let first_pool = accounts.share_mint.supply == 0;
    require!(first_pool == (args.seed_shares > 0), ErrorCode::InvalidSeedShares);

    let mint_a = accounts.token_a_mint.key();
    let mint_b = accounts.token_b_mint.key();
    let asset_a = vault.asset_index(&mint_a).ok_or(ErrorCode::UnknownAsset)?;
    let asset_b = vault.asset_index(&mint_b).ok_or(ErrorCode::UnknownAsset)?;
    let (expected_pool, _) = Pubkey::find_program_address(
        &[DAMM_CUSTOMIZABLE_POOL_SEED, mint_a.max(mint_b).as_ref(), mint_a.min(mint_b).as_ref()],
        &cp_amm::ID,
    );
    require_keys_eq!(accounts.pool.key(), expected_pool, ErrorCode::InvalidPool);

    let pool_params = InitializeCustomizablePoolParameters {
        pool_fees: PoolFeeParameters {
            base_fee: flat_base_fee(args.trade_fee_bps),
            compounding_fee_bps: args.compounding_fee_bps,
            padding: 0,
            dynamic_fee: None,
        },
        sqrt_min_price: DAMM_MIN_SQRT_PRICE,
        sqrt_max_price: DAMM_MAX_SQRT_PRICE,
        has_alpha_vault: false,
        liquidity: args.liquidity,
        sqrt_price: args.sqrt_price,
        activation_type: ACTIVATION_TYPE_TIMESTAMP,
        collect_fee_mode: COLLECT_FEE_MODE_COMPOUNDING,
        activation_point: None,
    };

    // The vault PDA is the pool's creator, so cp-amm hands it the first position NFT. The admin
    // pays and supplies the seed tokens; no PDA signature is needed here.
    cp_amm::cpi::initialize_customizable_pool(
        CpiContext::new(
            accounts.damm_program.key(),
            cp_amm::cpi::accounts::InitializeCustomizablePool {
                creator: accounts.vault.to_account_info(),
                position_nft_mint: accounts.position_nft_mint.to_account_info(),
                position_nft_account: accounts.position_nft_account.to_account_info(),
                payer: accounts.admin.to_account_info(),
                pool_authority: accounts.damm_pool_authority.to_account_info(),
                pool: accounts.pool.to_account_info(),
                position: accounts.position.to_account_info(),
                token_a_mint: accounts.token_a_mint.to_account_info(),
                token_b_mint: accounts.token_b_mint.to_account_info(),
                token_a_vault: accounts.token_a_vault.to_account_info(),
                token_b_vault: accounts.token_b_vault.to_account_info(),
                payer_token_a: accounts.admin_token_a.to_account_info(),
                payer_token_b: accounts.admin_token_b.to_account_info(),
                token_a_program: accounts.token_a_program.to_account_info(),
                token_b_program: accounts.token_b_program.to_account_info(),
                token_2022_program: accounts.token_2022_program.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                event_authority: accounts.damm_event_authority.to_account_info(),
                program: accounts.damm_program.to_account_info(),
            },
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        pool_params,
    )?;

    if first_pool {
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, vault.stock.as_ref(), &[vault.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                accounts.share_token_program.key(),
                MintTo {
                    mint: accounts.share_mint.to_account_info(),
                    to: accounts.admin_shares.to_account_info(),
                    authority: accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            args.seed_shares,
        )?;
    }

    let slot = PoolSlot {
        pool: accounts.pool.key(),
        position: accounts.position.key(),
        position_nft_account: accounts.position_nft_account.key(),
        token_a_vault: accounts.token_a_vault.key(),
        token_b_vault: accounts.token_b_vault.key(),
        asset_a: asset_a as u8,
        asset_b: asset_b as u8,
        target_weight_bps: args.target_weight_bps,
    };
    let vault_key = accounts.vault.key();
    let vault = &mut ctx.accounts.vault;
    let index = vault.num_pools as usize;
    vault.pools[index] = slot;
    vault.num_pools += 1;

    emit!(PoolAdded {
        vault: vault_key,
        pool: slot.pool,
        position: slot.position,
        seed_shares: args.seed_shares,
    });
    Ok(())
}

/// A constant fee: cp-amm's time scheduler (mode 0) with no periods, Borsh-encoded as
/// `{ cliff_fee_numerator: u64, number_of_period: u16, period_frequency: u64,
///    reduction_factor: u64, base_fee_mode: u8 }`.
fn flat_base_fee(trade_fee_bps: u16) -> BaseFeeParameters {
    let mut data = [0u8; 27];
    let cliff_fee_numerator = trade_fee_bps as u64 * FEE_NUMERATOR_PER_BPS;
    data[..8].copy_from_slice(&cliff_fee_numerator.to_le_bytes());
    BaseFeeParameters { data }
}
