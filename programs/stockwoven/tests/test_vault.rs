//! End-to-end tests against the real Meteora DAMM v2 program (dumped from mainnet by
//! `scripts/fetch-fixtures.sh`). Two mock issuer tokens of the same stock: A has 8 decimals
//! (like xStocks), B has 6 (like Backpack). They are either plain SPL tokens or Token-2022
//! tokens with a permanent delegate, like the real issuer tokens, which cp-amm only accepts
//! with a token badge.

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
const TOKEN_BADGE_DISCRIMINATOR: [u8; 8] = [116, 219, 204, 229, 249, 116, 255, 150];
/// Token-2022 extension type of a permanent delegate.
const EXTENSION_PERMANENT_DELEGATE: u16 = 12;

/// sqrt(10^6 / 10^8) * 2^64: one A token = one B token, in raw units.
const PEG_SQRT_PRICE: u128 = (1u128 << 64) / 10;
/// One raw share unit (1e-8 swINTC) = 1e-8 of one stock: half in A, half in B, at the peg.
/// L = sqrt(a * b) * 2^64 = sqrt(0.5e8 * 0.5e6) * 2^64 per whole share = 0.5e7 * 2^64.
const LIQUIDITY_PER_SHARE: u128 = (1u128 << 64) / 20;
const SEED_LIQUIDITY: u128 = 50_000_000u128 << 64;
const ONE_SHARE: u64 = 100_000_000;
const ONE_A: u64 = 100_000_000;
const ONE_B: u64 = 1_000_000;

#[derive(Clone, Copy, PartialEq)]
enum Issuers {
    /// Plain SPL tokens: cp-amm accepts them without a badge.
    Spl,
    /// Token-2022 with a permanent delegate, like xStocks and Backpack.
    Token2022 { badges: bool },
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    issuers: Issuers,
    program_a: Pubkey,
    program_b: Pubkey,
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

struct User {
    kp: Keypair,
    a: Pubkey,
    b: Pubkey,
    shares: Pubkey,
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}

fn set_mint(svm: &mut LiteSVM, mint: &Pubkey, decimals: u8, program: &Pubkey) {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(Pubkey::new_unique().as_ref());
    data[44] = decimals;
    data[45] = 1;
    if *program == TOKEN_2022_PROGRAM {
        // Base mint padded to the account size, the account-type byte, then one TLV entry.
        data.resize(165, 0);
        data.push(1);
        data.extend_from_slice(&EXTENSION_PERMANENT_DELEGATE.to_le_bytes());
        data.extend_from_slice(&32u16.to_le_bytes());
        data.extend_from_slice(Pubkey::new_unique().as_ref());
    }
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(*mint, Account { lamports, data, owner: *program, executable: false, rent_epoch: 0 })
        .unwrap();
}

fn set_token_account(svm: &mut LiteSVM, address: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, program: &Pubkey) {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(165);
    svm.set_account(*address, Account { lamports, data, owner: *program, executable: false, rent_epoch: 0 })
        .unwrap();
}

fn set_token_badge(svm: &mut LiteSVM, mint: &Pubkey) -> Pubkey {
    let badge = pda(&[b"token_badge", mint.as_ref()], &cp_amm::ID);
    let mut data = TOKEN_BADGE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(&[0u8; 128]);
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(badge, Account { lamports, data, owner: cp_amm::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    badge
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let data = svm.get_account(token_account).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn position_liquidity(svm: &LiteSVM, position: &Pubkey) -> u128 {
    let data = svm.get_account(position).unwrap().data;
    u128::from_le_bytes(data[152..168].try_into().unwrap())
}

fn share_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let data = svm.get_account(mint).unwrap().data;
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_PROGRAM, &data, vec![])
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<u64, String> {
    let mut all = vec![compute_limit(1_400_000)];
    all.extend_from_slice(ixs);
    let msg = Message::new_with_blockhash(&all, Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let result = svm
        .send_transaction(tx)
        .map(|meta| meta.compute_units_consumed)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    result
}

/// Value of A and B raw amounts in whole shares of stock, at 1 A token = 1 B token.
fn stock_value(a: u64, b: u64) -> f64 {
    a as f64 / ONE_A as f64 + b as f64 / ONE_B as f64
}

impl Env {
    fn new(issuers: Issuers) -> Self {
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

        let program = if issuers == Issuers::Spl { TOKEN_PROGRAM } else { TOKEN_2022_PROGRAM };
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        set_mint(&mut svm, &mint_a, DECIMALS_A, &program);
        set_mint(&mut svm, &mint_b, DECIMALS_B, &program);

        let pool = pda(&[b"cpool", mint_a.max(mint_b).as_ref(), mint_a.min(mint_b).as_ref()], &cp_amm::ID);
        let vault = pda(&[b"vault", pool.as_ref()], &stockwoven::id());
        Env {
            svm,
            admin,
            issuers,
            program_a: program,
            program_b: program,
            mint_a,
            mint_b,
            pool,
            vault,
            share_mint: pda(&[b"shares", vault.as_ref()], &stockwoven::id()),
            treasury: Pubkey::new_unique(),
            position: Pubkey::default(),
            position_nft_account: Pubkey::default(),
            token_a_vault: pda(&[b"token_vault", mint_a.as_ref(), pool.as_ref()], &cp_amm::ID),
            token_b_vault: pda(&[b"token_vault", mint_b.as_ref(), pool.as_ref()], &cp_amm::ID),
            reserve_a: pda(&[b"reserve", vault.as_ref(), mint_a.as_ref()], &stockwoven::id()),
            reserve_b: pda(&[b"reserve", vault.as_ref(), mint_b.as_ref()], &stockwoven::id()),
        }
    }

    /// A token account of the given issuer token holding `amount`, at a fresh address.
    fn fund(&mut self, is_a: bool, owner: &Pubkey, amount: u64) -> Pubkey {
        let (mint, program) = if is_a { (self.mint_a, self.program_a) } else { (self.mint_b, self.program_b) };
        let address = Pubkey::new_unique();
        set_token_account(&mut self.svm, &address, &mint, owner, amount, &program);
        address
    }

    fn user(&mut self, a: u64, b: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let owner = kp.pubkey();
        let shares = ata(&owner, &self.share_mint, &TOKEN_PROGRAM);
        set_token_account(&mut self.svm, &shares, &self.share_mint, &owner, 0, &TOKEN_PROGRAM);
        User { a: self.fund(true, &owner, a), b: self.fund(false, &owner, b), shares, kp }
    }

    /// Seeds the pool with 10 shares of stock (5 in A, 5 in B). Returns the admin's share account.
    fn try_initialize(&mut self) -> Result<Pubkey, String> {
        let admin = self.admin.pubkey();
        let admin_a = self.fund(true, &admin, 1_000 * ONE_A);
        let admin_b = self.fund(false, &admin, 1_000 * ONE_B);
        set_token_account(&mut self.svm, &self.treasury.clone(), &self.mint_b.clone(), &Pubkey::new_unique(), 0, &self.program_b.clone());

        let nft_mint = Keypair::new();
        self.position = pda(&[b"position", nft_mint.pubkey().as_ref()], &cp_amm::ID);
        self.position_nft_account = pda(&[b"position_nft_account", nft_mint.pubkey().as_ref()], &cp_amm::ID);
        let admin_shares = ata(&admin, &self.share_mint, &TOKEN_PROGRAM);

        let mut accounts = stockwoven::accounts::InitializeVault {
            admin,
            vault: self.vault,
            share_mint: self.share_mint,
            admin_shares,
            reserve_a: self.reserve_a,
            reserve_b: self.reserve_b,
            treasury: self.treasury,
            token_a_mint: self.mint_a,
            token_b_mint: self.mint_b,
            admin_token_a: admin_a,
            admin_token_b: admin_b,
            pool: self.pool,
            position_nft_mint: nft_mint.pubkey(),
            position_nft_account: self.position_nft_account,
            position: self.position,
            token_a_vault: self.token_a_vault,
            token_b_vault: self.token_b_vault,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: self.program_a,
            token_b_program: self.program_b,
            share_token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        if self.issuers == (Issuers::Token2022 { badges: true }) {
            let (mint_a, mint_b) = (self.mint_a, self.mint_b);
            accounts.push(AccountMeta::new_readonly(set_token_badge(&mut self.svm, &mint_a), false));
            accounts.push(AccountMeta::new_readonly(set_token_badge(&mut self.svm, &mint_b), false));
        }

        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::InitializeVault {
                args: InitializeVaultArgs {
                    liquidity: SEED_LIQUIDITY,
                    sqrt_price: PEG_SQRT_PRICE,
                    liquidity_per_share: LIQUIDITY_PER_SHARE,
                    trade_fee_bps: 30,
                    compounding_fee_bps: 8_000,
                },
            }
            .data(),
            accounts,
        );
        let admin_kp = self.admin.insecure_clone();
        send(&mut self.svm, &[ix], &admin_kp, &[&admin_kp, &nft_mint])?;
        Ok(admin_shares)
    }

    fn initialize(&mut self) -> Pubkey {
        self.try_initialize().unwrap()
    }

    fn deposit_ix(&self, user: &User, shares: u64, max_a: u64, max_b: u64) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Deposit { shares, max_a, max_b }.data(),
            stockwoven::accounts::Deposit {
                user: user.kp.pubkey(),
                vault: self.vault,
                share_mint: self.share_mint,
                user_shares: user.shares,
                user_token_a: user.a,
                user_token_b: user.b,
                reserve_a: self.reserve_a,
                reserve_b: self.reserve_b,
                token_a_mint: self.mint_a,
                token_b_mint: self.mint_b,
                pool: self.pool,
                position: self.position,
                position_nft_account: self.position_nft_account,
                token_a_vault: self.token_a_vault,
                token_b_vault: self.token_b_vault,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_a_program: self.program_a,
                token_b_program: self.program_b,
                share_token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    fn deposit_single_ix(&self, user: &User, input_is_a: bool, amount_in: u64, min_shares: u64) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::DepositSingle { input_is_a, amount_in, min_shares }.data(),
            stockwoven::accounts::DepositSingle {
                user: user.kp.pubkey(),
                vault: self.vault,
                share_mint: self.share_mint,
                user_shares: user.shares,
                user_token_a: user.a,
                user_token_b: user.b,
                reserve_a: self.reserve_a,
                reserve_b: self.reserve_b,
                token_a_mint: self.mint_a,
                token_b_mint: self.mint_b,
                pool: self.pool,
                position: self.position,
                position_nft_account: self.position_nft_account,
                token_a_vault: self.token_a_vault,
                token_b_vault: self.token_b_vault,
                damm_pool_authority: DAMM_POOL_AUTHORITY,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_a_program: self.program_a,
                token_b_program: self.program_b,
                share_token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    fn redeem_ix(&self, owner: &Pubkey, shares_acc: &Pubkey, a: &Pubkey, b: &Pubkey, shares: u64) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Redeem { shares, min_a: 0, min_b: 0 }.data(),
            stockwoven::accounts::Redeem {
                user: *owner,
                vault: self.vault,
                share_mint: self.share_mint,
                user_shares: *shares_acc,
                user_token_a: *a,
                user_token_b: *b,
                token_a_mint: self.mint_a,
                token_b_mint: self.mint_b,
                pool: self.pool,
                position: self.position,
                position_nft_account: self.position_nft_account,
                token_a_vault: self.token_a_vault,
                token_b_vault: self.token_b_vault,
                damm_pool_authority: DAMM_POOL_AUTHORITY,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_a_program: self.program_a,
                token_b_program: self.program_b,
                share_token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    fn harvest_ix(&self) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Harvest {}.data(),
            stockwoven::accounts::Harvest {
                vault: self.vault,
                reserve_a: self.reserve_a,
                treasury: self.treasury,
                token_a_mint: self.mint_a,
                token_b_mint: self.mint_b,
                pool: self.pool,
                position: self.position,
                position_nft_account: self.position_nft_account,
                token_a_vault: self.token_a_vault,
                token_b_vault: self.token_b_vault,
                damm_pool_authority: DAMM_POOL_AUTHORITY,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_a_program: self.program_a,
                token_b_program: self.program_b,
            }
            .to_account_metas(None),
        )
    }

    /// A direct cp-amm swap, as Jupiter would route it: the vault program is not involved.
    fn swap_ix(&self, trader: &Pubkey, input: &Pubkey, output: &Pubkey, amount_in: u64) -> Instruction {
        let mut data = SWAP_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        Instruction {
            program_id: cp_amm::ID,
            accounts: vec![
                AccountMeta::new_readonly(DAMM_POOL_AUTHORITY, false),
                AccountMeta::new(self.pool, false),
                AccountMeta::new(*input, false),
                AccountMeta::new(*output, false),
                AccountMeta::new(self.token_a_vault, false),
                AccountMeta::new(self.token_b_vault, false),
                AccountMeta::new_readonly(self.mint_a, false),
                AccountMeta::new_readonly(self.mint_b, false),
                AccountMeta::new_readonly(*trader, true),
                AccountMeta::new_readonly(self.program_a, false),
                AccountMeta::new_readonly(self.program_b, false),
                AccountMeta::new_readonly(cp_amm::ID, false),
                AccountMeta::new_readonly(DAMM_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(cp_amm::ID, false),
            ],
            data,
        }
    }

    /// Traders convert between issuers in both directions, `rounds` times.
    fn trade(&mut self, rounds: u64) {
        let trader = self.user(100 * ONE_A, 100 * ONE_B);
        for i in 0..rounds {
            let ix = self.swap_ix(&trader.kp.pubkey(), &trader.a, &trader.b, ONE_A + i);
            send(&mut self.svm, &[ix], &trader.kp, &[&trader.kp]).unwrap();
            let ix = self.swap_ix(&trader.kp.pubkey(), &trader.b, &trader.a, ONE_B + i);
            send(&mut self.svm, &[ix], &trader.kp, &[&trader.kp]).unwrap();
        }
    }

    fn deposit(&mut self, user: &User, shares: u64) -> (u64, u64) {
        let (a0, b0) = (balance(&self.svm, &user.a), balance(&self.svm, &user.b));
        let ix = self.deposit_ix(user, shares, 2 * ONE_A, 2 * ONE_B);
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp]).unwrap();
        (a0 - balance(&self.svm, &user.a), b0 - balance(&self.svm, &user.b))
    }

    fn redeem(&mut self, user: &User, shares: u64) -> (u64, u64) {
        let (a0, b0) = (balance(&self.svm, &user.a), balance(&self.svm, &user.b));
        let ix = self.redeem_ix(&user.kp.pubkey(), &user.shares, &user.a, &user.b, shares);
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp]).unwrap();
        (balance(&self.svm, &user.a) - a0, balance(&self.svm, &user.b) - b0)
    }

    /// Liquidity behind one raw share unit: what every holder owns, per share.
    fn liquidity_per_share(&self) -> f64 {
        position_liquidity(&self.svm, &self.position) as f64 / share_supply(&self.svm, &self.share_mint) as f64
    }
}

/// Deposit, conversions, harvest and redeem: a holder gets more stock back than deposited.
fn full_cycle(issuers: Issuers) {
    let mut env = Env::new(issuers);
    let admin_shares = env.initialize();

    // The seed (10 shares of stock, minus cp-amm's dead liquidity) is minted to the admin.
    let seed = balance(&env.svm, &admin_shares);
    assert_eq!(seed as u128, (SEED_LIQUIDITY - (100u128 << 64)) / LIQUIDITY_PER_SHARE);
    let vault_data = env.svm.get_account(&env.vault).unwrap().data;
    let vault = Vault::try_deserialize(&mut vault_data.as_slice()).unwrap();
    assert_eq!(vault.pool, env.pool);

    // A user deposits 1 swINTC worth of liquidity, offering more than needed of both tokens.
    let user = env.user(10 * ONE_A, 10 * ONE_B);
    let (paid_a, paid_b) = env.deposit(&user, ONE_SHARE);
    assert_eq!(balance(&env.svm, &user.shares), ONE_SHARE);
    // 1 share of stock = 0.5 A + 0.5 B at the peg (plus a raw unit of rounding up); the rest
    // was refunded.
    assert!((stock_value(paid_a, paid_b) - 1.0).abs() < 2e-6, "paid {paid_a} A, {paid_b} B");
    assert_eq!(balance(&env.svm, &env.reserve_a), 0);
    assert_eq!(balance(&env.svm, &env.reserve_b), 0);

    env.trade(20);

    // The protocol's cut (the non-compounding 20% of the LP fee) is swept to the treasury.
    let ix = env.harvest_ix();
    send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap();
    let protocol_cut = balance(&env.svm, &env.treasury);
    assert!(protocol_cut > 0);

    // The user redeems in kind and gets more stock back than deposited.
    let (got_a, got_b) = env.redeem(&user, ONE_SHARE);
    assert_eq!(balance(&env.svm, &user.shares), 0);
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
fn deposit_trade_harvest_redeem() {
    full_cycle(Issuers::Spl);
}

#[test]
fn token_2022_issuer_tokens_with_badges() {
    full_cycle(Issuers::Token2022 { badges: true });
}

#[test]
fn token_2022_issuer_tokens_need_badges() {
    let mut env = Env::new(Issuers::Token2022 { badges: false });
    let err = env.try_initialize().unwrap_err();
    assert!(err.contains("InvalidTokenBadge") || err.contains("Invalid token badge"), "{err}");
}

/// A deposit of one issuer's token: the vault swaps part of it, deposits both, refunds dust and
/// keeps its fee in the position, which raises the value of everyone else's shares.
fn deposit_single_cycle(issuers: Issuers, input_is_a: bool) {
    let mut env = Env::new(issuers);
    env.initialize();
    let before = env.liquidity_per_share();

    // 0.01 of a share of stock into a 10-share pool, so price impact stays small next to fees.
    let amount_in = if input_is_a { ONE_A / 100 } else { ONE_B / 100 };
    let deposited = 0.01;
    let user = if input_is_a { env.user(amount_in, 0) } else { env.user(0, amount_in) };
    let ix = env.deposit_single_ix(&user, input_is_a, amount_in, 1);
    let cu = send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap();

    let shares = balance(&env.svm, &user.shares);
    let refunded = stock_value(balance(&env.svm, &user.a), balance(&env.svm, &user.b));
    // Shares worth just under what went in: the swap fee on about half of it, a little price
    // impact, and the vault's 0.05%.
    let share_value = shares as f64 / ONE_SHARE as f64 / deposited;
    assert!(share_value > 0.994 && share_value < 1.0, "shares {share_value}");
    assert!(refunded / deposited < 0.003, "refunded {refunded}");
    assert_eq!(balance(&env.svm, &env.reserve_a), 0);
    assert_eq!(balance(&env.svm, &env.reserve_b), 0);

    // The vault fee went to existing holders: liquidity per share rose.
    let after = env.liquidity_per_share();
    assert!(after > before, "{before} -> {after}");

    // Redeeming right away returns about what went in, never more.
    let (got_a, got_b) = env.redeem(&user, shares);
    let out = (stock_value(got_a, got_b) + refunded) / deposited;
    println!("zap {} in: {shares} shares, {cu} CU, {out:.6} of the deposit back after redeem", if input_is_a { "A" } else { "B" });
    assert!(out < 1.0 && out > 0.99, "out {out}");
}

#[test]
fn deposit_single_from_issuer_a() {
    deposit_single_cycle(Issuers::Spl, true);
}

#[test]
fn deposit_single_from_issuer_b() {
    deposit_single_cycle(Issuers::Spl, false);
}

#[test]
fn deposit_single_with_token_2022() {
    deposit_single_cycle(Issuers::Token2022 { badges: true }, true);
}

#[test]
fn deposit_single_respects_min_shares() {
    let mut env = Env::new(Issuers::Spl);
    env.initialize();
    let user = env.user(ONE_A, 0);
    let ix = env.deposit_single_ix(&user, true, ONE_A, ONE_SHARE);
    let err = send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap_err();
    assert!(err.contains("SlippageExceeded"), "{err}");
    assert_eq!(balance(&env.svm, &user.a), ONE_A);
}

/// Many deposits and redemptions in different orders: nobody leaves with more stock than they
/// brought, and the last holder can always exit.
#[test]
fn rounding_never_pays_out_more_than_paid_in() {
    let mut env = Env::new(Issuers::Spl);
    let admin_shares = env.initialize();
    let users: Vec<User> = (0..3).map(|_| env.user(10 * ONE_A, 10 * ONE_B)).collect();
    let amounts = [1_000u64, 1_234_567, ONE_SHARE];

    for (user, &shares) in users.iter().zip(&amounts) {
        let (paid_a, paid_b) = env.deposit(user, shares);
        let (got_a, got_b) = env.redeem(user, shares);
        assert!(got_a <= paid_a && got_b <= paid_b, "{shares}: paid {paid_a}/{paid_b}, got {got_a}/{got_b}");
    }

    // The admin redeems the whole seed; the vault keeps only rounding dust.
    let admin = env.admin.insecure_clone();
    let admin_a = env.fund(true, &admin.pubkey(), 0);
    let admin_b = env.fund(false, &admin.pubkey(), 0);
    let seed = balance(&env.svm, &admin_shares);
    let ix = env.redeem_ix(&admin.pubkey(), &admin_shares, &admin_a, &admin_b, seed);
    send(&mut env.svm, &[ix], &admin, &[&admin]).unwrap();
    assert_eq!(share_supply(&env.svm, &env.share_mint), 0);
    assert!(position_liquidity(&env.svm, &env.position) < LIQUIDITY_PER_SHARE);
}

/// Dust: depositing one raw share unit costs at least one raw unit of each token, and redeeming
/// it would pay out zero of a token, which cp-amm rejects. The holder keeps the share.
#[test]
fn dust_redeem_is_rejected_not_lost() {
    let mut env = Env::new(Issuers::Spl);
    env.initialize();
    let user = env.user(10 * ONE_A, 10 * ONE_B);
    let (paid_a, paid_b) = env.deposit(&user, 1);
    assert!(paid_a >= 1 && paid_b >= 1);
    let ix = env.redeem_ix(&user.kp.pubkey(), &user.shares, &user.a, &user.b, 1);
    let err = send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap_err();
    assert!(err.contains("AmountIsZero"), "{err}");
    assert_eq!(balance(&env.svm, &user.shares), 1);
}

#[test]
fn paused_vault_rejects_deposits_but_allows_redeem() {
    let mut env = Env::new(Issuers::Spl);
    let admin_shares = env.initialize();
    let admin = env.admin.insecure_clone();

    let pause = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::SetDepositsPaused { paused: true }.data(),
        stockwoven::accounts::AdminOnly { admin: admin.pubkey(), vault: env.vault }.to_account_metas(None),
    );
    send(&mut env.svm, &[pause], &admin, &[&admin]).unwrap();

    let user = env.user(10 * ONE_A, 10 * ONE_B);
    let ix = env.deposit_ix(&user, ONE_SHARE, 2 * ONE_A, 2 * ONE_B);
    let err = send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap_err();
    assert!(err.contains("DepositsPaused"), "{err}");
    let ix = env.deposit_single_ix(&user, true, ONE_A, 1);
    let err = send(&mut env.svm, &[ix], &user.kp, &[&user.kp]).unwrap_err();
    assert!(err.contains("DepositsPaused"), "{err}");

    let admin_a = env.fund(true, &admin.pubkey(), 0);
    let admin_b = env.fund(false, &admin.pubkey(), 0);
    let ix = env.redeem_ix(&admin.pubkey(), &admin_shares, &admin_a, &admin_b, ONE_SHARE);
    send(&mut env.svm, &[ix], &admin, &[&admin]).unwrap();

    // Only the admin can pause.
    let stranger = env.user(0, 0);
    let pause = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::SetDepositsPaused { paused: false }.data(),
        stockwoven::accounts::AdminOnly { admin: stranger.kp.pubkey(), vault: env.vault }.to_account_metas(None),
    );
    assert!(send(&mut env.svm, &[pause], &stranger.kp, &[&stranger.kp]).is_err());
}
