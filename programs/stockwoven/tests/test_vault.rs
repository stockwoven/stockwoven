//! End-to-end test against the real Meteora DAMM v2 program (dumped from mainnet by
//! `scripts/fetch-fixtures.sh`). Two mock issuer tokens of the same stock: A has 8 decimals
//! (like xStocks), B has 6 (like Backpack).

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::AccountMeta,
        solana_program::instruction::Instruction, solana_program::system_program,
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    stockwoven::{cp_amm, InitializeVaultArgs, Vault, DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY},
};

const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;
const TOKEN_2022_PROGRAM: Pubkey = anchor_spl::token_2022::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const COMPUTE_BUDGET_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

const DECIMALS_A: u8 = 8;
const DECIMALS_B: u8 = 6;
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// sqrt(10^6 / 10^8) * 2^64: one A token = one B token, in raw units.
const PEG_SQRT_PRICE: u128 = (1u128 << 64) / 10;
/// One raw share unit (1e-8 swINTC) = 1e-8 of one stock: half in A, half in B, at the peg.
/// L = sqrt(a * b) * 2^64 = sqrt(0.5e8 * 0.5e6) * 2^64 per whole share = 0.5e7 * 2^64.
const LIQUIDITY_PER_SHARE: u128 = (1u128 << 64) / 20;
const ONE_SHARE: u64 = 100_000_000;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    mint_a: Pubkey,
    mint_b: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    share_mint: Pubkey,
    treasury: Pubkey,
    position: Pubkey,
    position_nft_account: Pubkey,
    token_a_vault: Pubkey,
    token_b_vault: Pubkey,
    reserve_a: Pubkey,
    reserve_b: Pubkey,
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}

fn set_mint(svm: &mut LiteSVM, mint: &Pubkey, decimals: u8) {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(Pubkey::new_unique().as_ref());
    data[44] = decimals;
    data[45] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(82);
    svm.set_account(
        *mint,
        Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 },
    )
    .unwrap();
}

fn set_token_account(svm: &mut LiteSVM, address: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(165);
    svm.set_account(
        *address,
        Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 },
    )
    .unwrap();
}

/// Gives `owner` a token account of `mint` holding `amount`, at a fresh address.
fn fund(svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let address = Pubkey::new_unique();
    set_token_account(svm, &address, mint, owner, amount);
    address
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let data = svm.get_account(token_account).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_PROGRAM, &data, vec![])
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all = vec![compute_limit(1_400_000)];
    all.extend_from_slice(ixs);
    let msg = Message::new_with_blockhash(&all, Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let result = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    result
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        stockwoven::id(),
        include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/stockwoven.so")),
    )
    .unwrap();
    svm.add_program(
        cp_amm::ID,
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cp_amm.so")),
    )
    .unwrap();

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();

    let mint_a = Pubkey::new_unique();
    let mint_b = Pubkey::new_unique();
    set_mint(&mut svm, &mint_a, DECIMALS_A);
    set_mint(&mut svm, &mint_b, DECIMALS_B);

    let pool = pda(&[b"cpool", mint_a.max(mint_b).as_ref(), mint_a.min(mint_b).as_ref()], &cp_amm::ID);
    let vault = pda(&[b"vault", pool.as_ref()], &stockwoven::id());
    let share_mint = pda(&[b"shares", vault.as_ref()], &stockwoven::id());

    Env {
        svm,
        mint_a,
        mint_b,
        pool,
        vault,
        share_mint,
        treasury: Pubkey::new_unique(),
        position: Pubkey::default(),
        position_nft_account: Pubkey::default(),
        token_a_vault: pda(&[b"token_vault", mint_a.as_ref(), pool.as_ref()], &cp_amm::ID),
        token_b_vault: pda(&[b"token_vault", mint_b.as_ref(), pool.as_ref()], &cp_amm::ID),
        reserve_a: pda(&[b"reserve", vault.as_ref(), mint_a.as_ref()], &stockwoven::id()),
        reserve_b: pda(&[b"reserve", vault.as_ref(), mint_b.as_ref()], &stockwoven::id()),
        admin,
    }
}

/// Seeds the pool with 10 shares of stock (5 in A, 5 in B) and returns the admin's share account.
fn initialize(env: &mut Env) -> Pubkey {
    let admin = env.admin.pubkey();
    let admin_a = fund(&mut env.svm, &env.mint_a, &admin, 1_000 * 10u64.pow(DECIMALS_A as u32));
    let admin_b = fund(&mut env.svm, &env.mint_b, &admin, 1_000 * 10u64.pow(DECIMALS_B as u32));
    set_token_account(&mut env.svm, &env.treasury, &env.mint_b, &Pubkey::new_unique(), 0);

    let nft_mint = Keypair::new();
    env.position = pda(&[b"position", nft_mint.pubkey().as_ref()], &cp_amm::ID);
    env.position_nft_account = pda(&[b"position_nft_account", nft_mint.pubkey().as_ref()], &cp_amm::ID);
    let admin_shares = ata(&admin, &env.share_mint, &TOKEN_PROGRAM);

    let ix = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::InitializeVault {
            args: InitializeVaultArgs {
                liquidity: 50_000_000u128 << 64,
                sqrt_price: PEG_SQRT_PRICE,
                liquidity_per_share: LIQUIDITY_PER_SHARE,
                trade_fee_bps: 30,
                compounding_fee_bps: 8_000,
            },
        }
        .data(),
        stockwoven::accounts::InitializeVault {
            admin,
            vault: env.vault,
            share_mint: env.share_mint,
            admin_shares,
            reserve_a: env.reserve_a,
            reserve_b: env.reserve_b,
            treasury: env.treasury,
            token_a_mint: env.mint_a,
            token_b_mint: env.mint_b,
            admin_token_a: admin_a,
            admin_token_b: admin_b,
            pool: env.pool,
            position_nft_mint: nft_mint.pubkey(),
            position_nft_account: env.position_nft_account,
            position: env.position,
            token_a_vault: env.token_a_vault,
            token_b_vault: env.token_b_vault,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: TOKEN_PROGRAM,
            token_b_program: TOKEN_PROGRAM,
            share_token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let admin_kp = env.admin.insecure_clone();
    send(&mut env.svm, &[ix], &admin_kp, &[&admin_kp, &nft_mint]).unwrap();
    admin_shares
}

fn deposit_ix(env: &Env, user: &Pubkey, shares_acc: &Pubkey, a: &Pubkey, b: &Pubkey, shares: u64, max_a: u64, max_b: u64) -> Instruction {
    Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::Deposit { shares, max_a, max_b }.data(),
        stockwoven::accounts::Deposit {
            user: *user,
            vault: env.vault,
            share_mint: env.share_mint,
            user_shares: *shares_acc,
            user_token_a: *a,
            user_token_b: *b,
            reserve_a: env.reserve_a,
            reserve_b: env.reserve_b,
            token_a_mint: env.mint_a,
            token_b_mint: env.mint_b,
            pool: env.pool,
            position: env.position,
            position_nft_account: env.position_nft_account,
            token_a_vault: env.token_a_vault,
            token_b_vault: env.token_b_vault,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: TOKEN_PROGRAM,
            token_b_program: TOKEN_PROGRAM,
            share_token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

fn redeem_ix(env: &Env, user: &Pubkey, shares_acc: &Pubkey, a: &Pubkey, b: &Pubkey, shares: u64) -> Instruction {
    Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::Redeem { shares, min_a: 0, min_b: 0 }.data(),
        stockwoven::accounts::Redeem {
            user: *user,
            vault: env.vault,
            share_mint: env.share_mint,
            user_shares: *shares_acc,
            user_token_a: *a,
            user_token_b: *b,
            token_a_mint: env.mint_a,
            token_b_mint: env.mint_b,
            pool: env.pool,
            position: env.position,
            position_nft_account: env.position_nft_account,
            token_a_vault: env.token_a_vault,
            token_b_vault: env.token_b_vault,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: TOKEN_PROGRAM,
            token_b_program: TOKEN_PROGRAM,
            share_token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

fn harvest_ix(env: &Env) -> Instruction {
    Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::Harvest {}.data(),
        stockwoven::accounts::Harvest {
            vault: env.vault,
            reserve_a: env.reserve_a,
            treasury: env.treasury,
            token_a_mint: env.mint_a,
            token_b_mint: env.mint_b,
            pool: env.pool,
            position: env.position,
            position_nft_account: env.position_nft_account,
            token_a_vault: env.token_a_vault,
            token_b_vault: env.token_b_vault,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: TOKEN_PROGRAM,
            token_b_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// A direct cp-amm swap, as Jupiter would route it: the vault program is not involved.
fn swap_ix(env: &Env, trader: &Pubkey, input: &Pubkey, output: &Pubkey, amount_in: u64) -> Instruction {
    let mut data = SWAP_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction {
        program_id: cp_amm::ID,
        accounts: vec![
            AccountMeta::new_readonly(DAMM_POOL_AUTHORITY, false),
            AccountMeta::new(env.pool, false),
            AccountMeta::new(*input, false),
            AccountMeta::new(*output, false),
            AccountMeta::new(env.token_a_vault, false),
            AccountMeta::new(env.token_b_vault, false),
            AccountMeta::new_readonly(env.mint_a, false),
            AccountMeta::new_readonly(env.mint_b, false),
            AccountMeta::new_readonly(*trader, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(cp_amm::ID, false),
            AccountMeta::new_readonly(DAMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(cp_amm::ID, false),
        ],
        data,
    }
}

/// Value of A and B raw amounts in whole shares of stock, at 1 A token = 1 B token.
fn stock_value(a: u64, b: u64) -> f64 {
    a as f64 / 10f64.powi(DECIMALS_A as i32) + b as f64 / 10f64.powi(DECIMALS_B as i32)
}

#[test]
fn deposit_trade_harvest_redeem() {
    let mut env = setup();
    let admin_shares = initialize(&mut env);

    // The seed (10 shares of stock, minus cp-amm's dead liquidity) is minted to the admin.
    let seed = balance(&env.svm, &admin_shares);
    assert_eq!(seed as u128, ((50_000_000u128 << 64) - (100u128 << 64)) / LIQUIDITY_PER_SHARE);
    let vault_data = env.svm.get_account(&env.vault).unwrap().data;
    let vault = Vault::try_deserialize(&mut vault_data.as_slice()).unwrap();
    assert_eq!(vault.pool, env.pool);
    assert_eq!(vault.liquidity_per_share, LIQUIDITY_PER_SHARE);

    // A user deposits 1 swINTC worth of liquidity, offering more than needed of both tokens.
    let user = Keypair::new();
    env.svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();
    let user_a = fund(&mut env.svm, &env.mint_a, &user.pubkey(), 10 * 10u64.pow(DECIMALS_A as u32));
    let user_b = fund(&mut env.svm, &env.mint_b, &user.pubkey(), 10 * 10u64.pow(DECIMALS_B as u32));
    let user_shares = ata(&user.pubkey(), &env.share_mint, &TOKEN_PROGRAM);
    set_token_account(&mut env.svm, &user_shares, &env.share_mint, &user.pubkey(), 0);

    let (a0, b0) = (balance(&env.svm, &user_a), balance(&env.svm, &user_b));
    let ix = deposit_ix(&env, &user.pubkey(), &user_shares, &user_a, &user_b, ONE_SHARE, 60_000_000, 600_000);
    send(&mut env.svm, &[ix], &user, &[&user]).unwrap();
    let (paid_a, paid_b) = (a0 - balance(&env.svm, &user_a), b0 - balance(&env.svm, &user_b));
    assert_eq!(balance(&env.svm, &user_shares), ONE_SHARE);
    // 1 share of stock = 0.5 A + 0.5 B at the peg; the rest was refunded.
    assert!((stock_value(paid_a, paid_b) - 1.0).abs() < 1e-6, "paid {paid_a} A, {paid_b} B");
    assert_eq!(balance(&env.svm, &env.reserve_a), 0);
    assert_eq!(balance(&env.svm, &env.reserve_b), 0);

    // Traders convert between issuers through the pool in both directions.
    let trader = Keypair::new();
    env.svm.airdrop(&trader.pubkey(), 10_000_000_000).unwrap();
    let trader_a = fund(&mut env.svm, &env.mint_a, &trader.pubkey(), 100 * 10u64.pow(DECIMALS_A as u32));
    let trader_b = fund(&mut env.svm, &env.mint_b, &trader.pubkey(), 100 * 10u64.pow(DECIMALS_B as u32));
    for i in 0..20u64 {
        let ix = swap_ix(&env, &trader.pubkey(), &trader_a, &trader_b, 100_000_000 + i);
        send(&mut env.svm, &[ix], &trader, &[&trader]).unwrap();
        let ix = swap_ix(&env, &trader.pubkey(), &trader_b, &trader_a, 1_000_000 + i);
        send(&mut env.svm, &[ix], &trader, &[&trader]).unwrap();
    }

    // The protocol's cut (the non-compounding 20% of the LP fee) is swept to the treasury.
    let ix = harvest_ix(&env);
    send(&mut env.svm, &[ix], &user, &[&user]).unwrap();
    let protocol_cut = balance(&env.svm, &env.treasury);
    assert!(protocol_cut > 0);

    // The user redeems in kind and gets more stock back than deposited.
    let (a1, b1) = (balance(&env.svm, &user_a), balance(&env.svm, &user_b));
    let ix = redeem_ix(&env, &user.pubkey(), &user_shares, &user_a, &user_b, ONE_SHARE);
    send(&mut env.svm, &[ix], &user, &[&user]).unwrap();
    let (got_a, got_b) = (balance(&env.svm, &user_a) - a1, balance(&env.svm, &user_b) - b1);
    assert_eq!(balance(&env.svm, &user_shares), 0);
    let gain = stock_value(got_a, got_b) - stock_value(paid_a, paid_b);
    println!(
        "paid {:.8} shares, redeemed {:.8} shares (+{:.6}), treasury got {} raw B",
        stock_value(paid_a, paid_b),
        stock_value(got_a, got_b),
        gain,
        protocol_cut
    );
    assert!(gain > 0.0);
}

#[test]
fn paused_vault_rejects_deposits_but_allows_redeem() {
    let mut env = setup();
    let admin_shares = initialize(&mut env);
    let admin = env.admin.insecure_clone();

    let pause = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::SetDepositsPaused { paused: true }.data(),
        stockwoven::accounts::AdminOnly { admin: admin.pubkey(), vault: env.vault }.to_account_metas(None),
    );
    send(&mut env.svm, &[pause], &admin, &[&admin]).unwrap();

    let admin_a = fund(&mut env.svm, &env.mint_a, &admin.pubkey(), 10 * 10u64.pow(DECIMALS_A as u32));
    let admin_b = fund(&mut env.svm, &env.mint_b, &admin.pubkey(), 10 * 10u64.pow(DECIMALS_B as u32));
    let ix = deposit_ix(&env, &admin.pubkey(), &admin_shares, &admin_a, &admin_b, ONE_SHARE, 60_000_000, 600_000);
    let err = send(&mut env.svm, &[ix], &admin, &[&admin]).unwrap_err();
    assert!(err.contains("DepositsPaused"), "{err}");

    let ix = redeem_ix(&env, &admin.pubkey(), &admin_shares, &admin_a, &admin_b, ONE_SHARE);
    send(&mut env.svm, &[ix], &admin, &[&admin]).unwrap();

    // Only the admin can pause.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let pause = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::SetDepositsPaused { paused: false }.data(),
        stockwoven::accounts::AdminOnly { admin: stranger.pubkey(), vault: env.vault }.to_account_metas(None),
    );
    assert!(send(&mut env.svm, &[pause], &stranger, &[&stranger]).is_err());
}
