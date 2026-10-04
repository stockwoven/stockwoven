use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
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
    events::VaultInitialized,
    state::Vault,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeVaultArgs {
    /// Seed liquidity (Q64.64). cp-amm keeps `DAMM_DEAD_LIQUIDITY` of it locked forever.
    pub liquidity: u128,
    /// Initial sqrt(B/A) in raw units, Q64.64. For two tokens of the same share this is the
    /// decimals ratio: sqrt(10^decimals_b / 10^decimals_a) * 2^64.
    pub sqrt_price: u128,
    /// Liquidity behind one raw unit of the share token. Fixed for the life of the vault.
    pub liquidity_per_share: u128,
    pub trade_fee_bps: u16,
    /// Share of the LP fee that compounds into the pool for holders; the rest is the
    /// protocol's cut, collected by `harvest`.
    pub compounding_fee_bps: u16,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, pool.key().as_ref()],
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

    #[account(
        init,
        payer = admin,
        associated_token::mint = share_mint,
        associated_token::authority = admin,
        associated_token::token_program = share_token_program
    )]
    pub admin_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [RESERVE_SEED, vault.key().as_ref(), token_a_mint.key().as_ref()],
        bump,
        token::mint = token_a_mint,
        token::authority = vault,
        token::token_program = token_a_program
    )]
    pub reserve_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [RESERVE_SEED, vault.key().as_ref(), token_b_mint.key().as_ref()],
        bump,
        token::mint = token_b_mint,
        token::authority = vault,
        token::token_program = token_b_program
    )]
    pub reserve_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(token::mint = token_b_mint, token::token_program = token_b_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mint::token_program = token_a_program)]
    pub token_a_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mint::token_program = token_b_program)]
    pub token_b_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = token_a_mint,
        token::authority = admin,
        token::token_program = token_a_program
    )]
    pub admin_token_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_b_mint,
        token::authority = admin,
        token::token_program = token_b_program
    )]
    pub admin_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: created by cp-amm; the handler checks it is the customizable-pool PDA of the mints.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// Fresh keypair for the position NFT, which cp-amm mints to `position_nft_account`.
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK: cp-amm PDA `["position_nft_account", position_nft_mint]`, created and checked by cp-amm.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["position", position_nft_mint]`, created and checked by cp-amm.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["token_vault", token_a_mint, pool]`, created and checked by cp-amm.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: cp-amm PDA `["token_vault", token_b_mint, pool]`, created and checked by cp-amm.
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Remaining accounts: cp-amm token badges, `[0]` for mint A and `[1]` for mint B, when a mint
/// uses Token-2022 extensions that cp-amm only accepts with a badge (xStocks, Backpack).
pub fn handle_initialize_vault<'info>(
    ctx: Context<'info, InitializeVault<'info>>,
    args: InitializeVaultArgs,
) -> Result<()> {
    require!(
        args.trade_fee_bps >= 1 && args.trade_fee_bps <= MAX_TRADE_FEE_BPS,
        ErrorCode::InvalidTradeFee
    );
    require!(
        args.compounding_fee_bps >= 1 && args.compounding_fee_bps <= MAX_BASIS_POINTS,
        ErrorCode::InvalidCompoundingFee
    );
    require!(args.liquidity_per_share > 0, ErrorCode::InvalidLiquidityPerShare);

    let mint_a = ctx.accounts.token_a_mint.key();
    let mint_b = ctx.accounts.token_b_mint.key();
    let (expected_pool, _) = Pubkey::find_program_address(
        &[
            DAMM_CUSTOMIZABLE_POOL_SEED,
            mint_a.max(mint_b).as_ref(),
            mint_a.min(mint_b).as_ref(),
        ],
        &cp_amm::ID,
    );
    require_keys_eq!(ctx.accounts.pool.key(), expected_pool, ErrorCode::InvalidPool);

    let seed_liquidity = args
        .liquidity
        .checked_sub(DAMM_DEAD_LIQUIDITY)
        .ok_or(ErrorCode::SeedTooSmall)?;
    let seed_shares: u64 = (seed_liquidity / args.liquidity_per_share)
        .try_into()
        .map_err(|_| ErrorCode::MathOverflow)?;
    require!(seed_shares > 0, ErrorCode::SeedTooSmall);

    let accounts = &ctx.accounts;
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

    let pool_key = accounts.pool.key();
    let bump = ctx.bumps.vault;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[bump]];
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
        seed_shares,
    )?;

    let vault_key = accounts.vault.key();
    let vault = &mut ctx.accounts.vault;
    vault.set_inner(Vault {
        admin: ctx.accounts.admin.key(),
        treasury: ctx.accounts.treasury.key(),
        pool: pool_key,
        position: ctx.accounts.position.key(),
        position_nft_account: ctx.accounts.position_nft_account.key(),
        token_a_mint: mint_a,
        token_b_mint: mint_b,
        reserve_a: ctx.accounts.reserve_a.key(),
        reserve_b: ctx.accounts.reserve_b.key(),
        share_mint: ctx.accounts.share_mint.key(),
        liquidity_per_share: args.liquidity_per_share,
        deposits_paused: false,
        bump,
    });

    emit!(VaultInitialized {
        vault: vault_key,
        pool: pool_key,
        position: ctx.accounts.position.key(),
        seed_shares,
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
