//! End-to-end tests against the real Meteora DAMM v2 program (dumped from mainnet by
//! `scripts/fetch-fixtures.sh`).
//!
//! The vault is swSPCX. It holds five assets: three issuers' SpaceX tokens with their real
//! decimals (SPCXx 8, Backpack SPCX 6, Ondo SPCXon 9), USDC (6) and SOL (9, a plain mint here),
//! and four pools: SPCXx/SPCX and SPCXon/SPCXx (stock–stock), SPCX/USDC and SPCXx/SOL. The
//! issuer tokens are either plain SPL tokens or Token-2022 tokens with a permanent delegate,
//! like the real ones, which cp-amm only accepts with a token badge.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::AccountMeta, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    stockwoven::{
        cp_amm::{self, types as amm},
        AddPoolArgs, AssetWeights, Basket, BasketParams, Vault, DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY,
    },
};

const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;
const TOKEN_2022_PROGRAM: Pubkey = anchor_spl::token_2022::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const COMPUTE_BUDGET_PROGRAM: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");
const ALT_PROGRAM: Pubkey = anchor_lang::pubkey!("AddressLookupTab1e1111111111111111111111111");
const TOKEN_BADGE_DISCRIMINATOR: [u8; 8] = [116, 219, 204, 229, 249, 116, 255, 150];
/// Token-2022 extension type of a permanent delegate.
const EXTENSION_PERMANENT_DELEGATE: u16 = 12;

const STOCK: [u8; 8] = *b"SPCX\0\0\0\0";
const ONE_SHARE: u64 = 100_000_000;
const SEED_SHARES: u64 = 1_000 * ONE_SHARE;
const ARB_FEE_BPS: u16 = 2_000;

/// Asset indexes, in the order the vault registers them.
const SPCXX: usize = 0;
const SPCX: usize = 1;
const SPCXON: usize = 2;
const USDC: usize = 3;
const SOL: usize = 4;

/// (decimals, USD price, issuer token?) per asset.
const ASSETS: [(u8, f64, bool); 5] = [(8, 168.0, true), (6, 168.0, true), (9, 168.0, true), (6, 1.0, false), (9, 116.0, false)];

/// Vault pools: (token A, token B, whole token A seeded).
const VAULT_POOLS: [(usize, usize, f64); 4] = [(SPCXX, SPCX, 200.0), (SPCXON, SPCXX, 100.0), (SPCX, USDC, 100.0), (SPCXX, SOL, 100.0)];
const P_STOCKS: u8 = 0;
const P_ONDO: u8 = 1;
const P_USDC: u8 = 2;
const P_SOL: u8 = 3;

#[derive(Clone, Copy, PartialEq)]
enum Issuers {
    /// Plain SPL tokens: cp-amm accepts them without a badge.
    Spl,
    /// Token-2022 with a permanent delegate, like xStocks, Backpack and Ondo.
    Token2022,
}

struct AssetKeys {
    mint: Pubkey,
    program: Pubkey,
    decimals: u8,
    price: f64,
    reserve: Pubkey,
    treasury: Pubkey,
}

#[derive(Clone, Copy)]
struct PoolKeys {
    pool: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    a: usize,
    b: usize,
    position: Pubkey,
    nft_account: Pubkey,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    keeper: Keypair,
    trader: User,
    treasury: Pubkey,
    vault: Pubkey,
    share_mint: Pubkey,
    admin_shares: Pubkey,
    assets: Vec<AssetKeys>,
    pools: Vec<PoolKeys>,
}

struct User {
    kp: Keypair,
    tokens: Vec<Pubkey>,
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
    svm.set_account(*mint, Account { lamports, data, owner: *program, executable: false, rent_epoch: 0 }).unwrap();
}

fn set_token_account(svm: &mut LiteSVM, address: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, program: &Pubkey) {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(*address, Account { lamports, data, owner: *program, executable: false, rent_epoch: 0 }).unwrap();
}

fn set_token_badge(svm: &mut LiteSVM, mint: &Pubkey) -> Pubkey {
    let badge = pda(&[b"token_badge", mint.as_ref()], &cp_amm::ID);
    let mut data = TOKEN_BADGE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(&[0u8; 128]);
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(badge, Account { lamports, data, owner: cp_amm::ID, executable: false, rent_epoch: 0 }).unwrap();
    badge
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let data = svm.get_account(token_account).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn u128_at(data: &[u8], offset: usize) -> u128 {
    u128::from_le_bytes(data[offset..offset + 16].try_into().unwrap())
}

fn position_liquidity(svm: &LiteSVM, position: &Pubkey) -> u128 {
    u128_at(&svm.get_account(position).unwrap().data, 152)
}

/// (liquidity, reserve A, reserve B) of a cp-amm pool.
fn pool_state(svm: &LiteSVM, pool: &Pubkey) -> (u128, u64, u64) {
    let d = svm.get_account(pool).unwrap().data;
    (
        u128_at(&d, 360),
        u64::from_le_bytes(d[680..688].try_into().unwrap()),
        u64::from_le_bytes(d[688..696].try_into().unwrap()),
    )
}

fn share_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    u64::from_le_bytes(svm.get_account(mint).unwrap().data[36..44].try_into().unwrap())
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_PROGRAM, &data, vec![])
}

// Compute units of the last transaction `send` landed, for the compute-unit profile, and the
// vault's lookup table: `deposit` and `redeem` touch ~45 accounts, too many for a legacy
// transaction, exactly as on devnet.
thread_local! {
    static LAST_CU: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static LOOKUP_TABLE: std::cell::RefCell<Option<AddressLookupTableAccount>> = const { std::cell::RefCell::new(None) };
}

/// An address lookup table account whose addresses are all active from slot 0.
fn set_lookup_table(svm: &mut LiteSVM, addresses: Vec<Pubkey>) -> AddressLookupTableAccount {
    let key = Pubkey::new_unique();
    let mut data = vec![0u8; 56];
    data[0..4].copy_from_slice(&1u32.to_le_bytes()); // ProgramState::LookupTable
    data[4..12].copy_from_slice(&u64::MAX.to_le_bytes()); // deactivation slot: never
    data[20] = addresses.len() as u8; // last_extended_slot_start_index: all active at slot 0
    data[21] = 1; // authority: Some
    data[22..54].copy_from_slice(Pubkey::new_unique().as_ref());
    for a in &addresses {
        data.extend_from_slice(a.as_ref());
    }
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(key, Account { lamports, data, owner: ALT_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    AddressLookupTableAccount { key, addresses }
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<u64, String> {
    let mut all = vec![compute_limit(1_400_000)];
    all.extend_from_slice(ixs);
    let msg = match LOOKUP_TABLE.with(|t| t.borrow().clone()) {
        Some(table) => VersionedMessage::V0(v0::Message::try_compile(&payer.pubkey(), &all, &[table], svm.latest_blockhash()).unwrap()),
        None => VersionedMessage::Legacy(Message::new_with_blockhash(&all, Some(&payer.pubkey()), &svm.latest_blockhash())),
    };
    let tx = VersionedTransaction::try_new(msg, signers).unwrap();
    let result = svm
        .send_transaction(tx)
        .map(|meta| {
            LAST_CU.with(|c| c.set(meta.compute_units_consumed));
            meta.compute_units_consumed
        })
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    result
}

fn expect_error(result: Result<u64, String>, needle: &str) {
    let err = result.expect_err("transaction should fail");
    assert!(err.contains(needle), "expected {needle}, got:\n{err}");
}

/// sqrt(raw B per raw A) as Q64.64.
fn sqrt_price(raw_price: f64) -> u128 {
    (raw_price.sqrt() * 2f64.powi(64)) as u128
}

/// A constant fee, Borsh-encoded like the program's `flat_base_fee`.
fn flat_base_fee(trade_fee_bps: u16) -> amm::BaseFeeParameters {
    let mut data = [0u8; 27];
    data[..8].copy_from_slice(&(trade_fee_bps as u64 * 100_000).to_le_bytes());
    amm::BaseFeeParameters { data }
}

impl Env {
    fn new(issuers: Issuers) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(stockwoven::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/stockwoven.so")))
            .unwrap();
        svm.add_program(cp_amm::ID, include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cp_amm.so")))
            .unwrap();

        let (admin, keeper) = (Keypair::new(), Keypair::new());
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&keeper.pubkey(), 10_000_000_000).unwrap();
        let treasury = Pubkey::new_unique();
        let vault = pda(&[b"vault", STOCK.as_ref()], &stockwoven::id());
        let share_mint = pda(&[b"shares", vault.as_ref()], &stockwoven::id());

        let assets = ASSETS
            .iter()
            .map(|&(decimals, price, issuer)| {
                let program = if issuer && issuers == Issuers::Token2022 { TOKEN_2022_PROGRAM } else { TOKEN_PROGRAM };
                let mint = Pubkey::new_unique();
                set_mint(&mut svm, &mint, decimals, &program);
                if program == TOKEN_2022_PROGRAM {
                    set_token_badge(&mut svm, &mint);
                }
                let treasury_account = Pubkey::new_unique();
                set_token_account(&mut svm, &treasury_account, &mint, &treasury, 0, &program);
                AssetKeys {
                    mint,
                    program,
                    decimals,
                    price,
                    reserve: pda(&[b"reserve", vault.as_ref(), mint.as_ref()], &stockwoven::id()),
                    treasury: treasury_account,
                }
            })
            .collect();

        let trader = User { kp: Keypair::new(), tokens: vec![], shares: Pubkey::default() };
        let mut env = Env {
            svm,
            admin,
            keeper,
            trader,
            treasury,
            vault,
            share_mint,
            admin_shares: Pubkey::default(),
            assets,
            pools: vec![],
        };
        LOOKUP_TABLE.with(|t| *t.borrow_mut() = None);
        env.trader = env.user([1_000.0, 1_000.0, 1_000.0, 200_000.0, 2_000.0]);
        env.setup_vault();
        let mut addresses = vec![env.vault, env.basket(), env.share_mint, DAMM_POOL_AUTHORITY, DAMM_EVENT_AUTHORITY, cp_amm::ID, TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
        for a in &env.assets {
            addresses.extend([a.mint, a.reserve, a.treasury]);
        }
        for p in &env.pools {
            addresses.extend([p.pool, p.position, p.nft_account, p.vault_a, p.vault_b]);
        }
        let table = set_lookup_table(&mut env.svm, addresses);
        LOOKUP_TABLE.with(|t| *t.borrow_mut() = Some(table));
        env
    }

    fn raw(&self, asset: usize, whole: f64) -> u64 {
        (whole * 10f64.powi(self.assets[asset].decimals as i32)) as u64
    }

    /// USD value of raw amounts, one per asset.
    fn value(&self, amounts: &[u64]) -> f64 {
        amounts
            .iter()
            .zip(&self.assets)
            .map(|(&x, a)| x as f64 / 10f64.powi(a.decimals as i32) * a.price)
            .sum()
    }

    /// A token account holding `amount`, at a fresh address.
    fn fund(&mut self, asset: usize, owner: &Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        let (mint, program) = (self.assets[asset].mint, self.assets[asset].program);
        set_token_account(&mut self.svm, &address, &mint, owner, amount, &program);
        address
    }

    /// A user holding the given whole amounts of each asset and an empty share account.
    fn user(&mut self, whole: [f64; 5]) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let owner = kp.pubkey();
        let tokens = (0..5).map(|k| self.fund(k, &owner, self.raw(k, whole[k]))).collect();
        let shares = ata(&owner, &self.share_mint, &TOKEN_PROGRAM);
        set_token_account(&mut self.svm, &shares, &self.share_mint, &owner, 0, &TOKEN_PROGRAM);
        User { kp, tokens, shares }
    }

    fn balances(&self, user: &User) -> Vec<u64> {
        user.tokens.iter().map(|t| balance(&self.svm, t)).collect()
    }

    fn admin_send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<u64, String> {
        let admin = self.admin.insecure_clone();
        let mut signers = vec![&admin];
        signers.extend_from_slice(extra);
        send(&mut self.svm, ixs, &admin, &signers)
    }

    fn keeper_send(&mut self, ixs: &[Instruction]) -> Result<u64, String> {
        let keeper = self.keeper.insecure_clone();
        send(&mut self.svm, ixs, &keeper, &[&keeper])
    }

    fn setup_vault(&mut self) {
        let admin = self.admin.pubkey();
        let init = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::InitializeVault {
                stock: STOCK,
                keeper: self.keeper.pubkey(),
                treasury: self.treasury,
                arb_fee_bps: ARB_FEE_BPS,
            }
            .data(),
            stockwoven::accounts::InitializeVault {
                admin,
                vault: self.vault,
                share_mint: self.share_mint,
                share_token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let add_assets: Vec<Instruction> = self
            .assets
            .iter()
            .map(|a| {
                Instruction::new_with_bytes(
                    stockwoven::id(),
                    &stockwoven::instruction::AddAsset {}.data(),
                    stockwoven::accounts::AddAsset {
                        admin,
                        vault: self.vault,
                        mint: a.mint,
                        reserve: a.reserve,
                        token_program: a.program,
                        system_program: system_program::ID,
                    }
                    .to_account_metas(None),
                )
            })
            .collect();
        let mut ixs = vec![init];
        ixs.extend(add_assets);
        self.admin_send(&ixs, &[]).unwrap();

        self.admin_shares = ata(&admin, &self.share_mint, &TOKEN_PROGRAM);
        let (shares, mint) = (self.admin_shares, self.share_mint);
        set_token_account(&mut self.svm, &shares, &mint, &admin, 0, &TOKEN_PROGRAM);
        for (i, &(a, b, whole_a)) in VAULT_POOLS.iter().enumerate() {
            let seed_shares = if i == 0 { SEED_SHARES } else { 0 };
            self.try_add_pool(a, b, whole_a, seed_shares).unwrap();
        }
    }

    /// Raw B per raw A at the assets' USD prices.
    fn raw_price(&self, a: usize, b: usize, premium: f64) -> f64 {
        let (aa, ab) = (&self.assets[a], &self.assets[b]);
        aa.price * premium / ab.price * 10f64.powi(ab.decimals as i32 - aa.decimals as i32)
    }

    fn badges(&mut self, a: usize, b: usize) -> Vec<AccountMeta> {
        [a, b]
            .iter()
            .filter(|&&k| self.assets[k].program == TOKEN_2022_PROGRAM)
            .map(|&k| {
                let mint = self.assets[k].mint;
                AccountMeta::new_readonly(set_token_badge(&mut self.svm, &mint), false)
            })
            .collect()
    }

    fn try_add_pool(&mut self, a: usize, b: usize, whole_a: f64, seed_shares: u64) -> Result<u64, String> {
        let admin = self.admin.pubkey();
        let sqrt = sqrt_price(self.raw_price(a, b, 1.0));
        let liquidity = self.raw(a, whole_a) as u128 * sqrt;
        let admin_a = self.fund(a, &admin, self.raw(a, whole_a * 2.0));
        let admin_b = self.fund(b, &admin, self.raw(b, whole_a * 2.0 * self.assets[a].price / self.assets[b].price));
        let (mint_a, mint_b) = (self.assets[a].mint, self.assets[b].mint);
        let pool = pda(&[b"cpool", mint_a.max(mint_b).as_ref(), mint_a.min(mint_b).as_ref()], &cp_amm::ID);
        let nft = Keypair::new();
        let keys = PoolKeys {
            pool,
            vault_a: pda(&[b"token_vault", mint_a.as_ref(), pool.as_ref()], &cp_amm::ID),
            vault_b: pda(&[b"token_vault", mint_b.as_ref(), pool.as_ref()], &cp_amm::ID),
            a,
            b,
            position: pda(&[b"position", nft.pubkey().as_ref()], &cp_amm::ID),
            nft_account: pda(&[b"position_nft_account", nft.pubkey().as_ref()], &cp_amm::ID),
        };
        let mut accounts = stockwoven::accounts::AddPool {
            admin,
            vault: self.vault,
            share_mint: self.share_mint,
            admin_shares: self.admin_shares,
            token_a_mint: mint_a,
            token_b_mint: mint_b,
            admin_token_a: admin_a,
            admin_token_b: admin_b,
            pool,
            position_nft_mint: nft.pubkey(),
            position_nft_account: keys.nft_account,
            position: keys.position,
            token_a_vault: keys.vault_a,
            token_b_vault: keys.vault_b,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_a_program: self.assets[a].program,
            token_b_program: self.assets[b].program,
            share_token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(self.badges(a, b));
        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::AddPool {
                args: AddPoolArgs {
                    liquidity,
                    sqrt_price: sqrt,
                    trade_fee_bps: 30,
                    compounding_fee_bps: 8_000,
                    seed_shares,
                    target_weight_bps: 2_500,
                },
            }
            .data(),
            accounts,
        );
        let cu = self.admin_send(&[ix], &[&nft])?;
        self.pools.push(keys);
        Ok(cu)
    }

    /// A pool someone else owns, `premium` above the assets' prices (token A priced in token B).
    fn external_pool(&mut self, a: usize, b: usize, premium: f64, whole_a: f64) -> PoolKeys {
        let lp = Keypair::new();
        self.svm.airdrop(&lp.pubkey(), 10_000_000_000).unwrap();
        let sqrt = sqrt_price(self.raw_price(a, b, premium));
        let liquidity = self.raw(a, whole_a) as u128 * sqrt;
        let lp_a = self.fund(a, &lp.pubkey(), self.raw(a, whole_a * 2.0));
        let lp_b = self.fund(b, &lp.pubkey(), self.raw(b, whole_a * 2.0 * premium * self.assets[a].price / self.assets[b].price));
        let (mint_a, mint_b) = (self.assets[a].mint, self.assets[b].mint);
        let pool = pda(&[b"cpool", mint_a.max(mint_b).as_ref(), mint_a.min(mint_b).as_ref()], &cp_amm::ID);
        let nft = Keypair::new();
        let keys = PoolKeys {
            pool,
            vault_a: pda(&[b"token_vault", mint_a.as_ref(), pool.as_ref()], &cp_amm::ID),
            vault_b: pda(&[b"token_vault", mint_b.as_ref(), pool.as_ref()], &cp_amm::ID),
            a,
            b,
            position: pda(&[b"position", nft.pubkey().as_ref()], &cp_amm::ID),
            nft_account: pda(&[b"position_nft_account", nft.pubkey().as_ref()], &cp_amm::ID),
        };
        let mut accounts = cp_amm::client::accounts::InitializeCustomizablePool {
            creator: lp.pubkey(),
            position_nft_mint: nft.pubkey(),
            position_nft_account: keys.nft_account,
            payer: lp.pubkey(),
            pool_authority: DAMM_POOL_AUTHORITY,
            pool,
            position: keys.position,
            token_a_mint: mint_a,
            token_b_mint: mint_b,
            token_a_vault: keys.vault_a,
            token_b_vault: keys.vault_b,
            payer_token_a: lp_a,
            payer_token_b: lp_b,
            token_a_program: self.assets[a].program,
            token_b_program: self.assets[b].program,
            token_2022_program: TOKEN_2022_PROGRAM,
            system_program: system_program::ID,
            event_authority: DAMM_EVENT_AUTHORITY,
            program: cp_amm::ID,
        }
        .to_account_metas(None);
        accounts.extend(self.badges(a, b));
        let params = amm::InitializeCustomizablePoolParameters {
            pool_fees: amm::PoolFeeParameters {
                base_fee: flat_base_fee(30),
                compounding_fee_bps: 8_000,
                padding: 0,
                dynamic_fee: None,
            },
            sqrt_min_price: stockwoven::DAMM_MIN_SQRT_PRICE,
            sqrt_max_price: stockwoven::DAMM_MAX_SQRT_PRICE,
            has_alpha_vault: false,
            liquidity,
            sqrt_price: sqrt,
            activation_type: 1,
            collect_fee_mode: 2,
            activation_point: None,
        };
        let ix = Instruction::new_with_bytes(
            cp_amm::ID,
            &cp_amm::client::args::InitializeCustomizablePool { params }.data(),
            accounts,
        );
        send(&mut self.svm, &[ix], &lp, &[&lp, &nft]).unwrap();
        keys
    }

    /// The trader swaps `whole_in` of the input token directly on cp-amm.
    fn trade(&mut self, p: PoolKeys, a_to_b: bool, whole_in: f64) {
        let (input, output) = if a_to_b { (p.a, p.b) } else { (p.b, p.a) };
        let amount_in = self.raw(input, whole_in);
        let ix = Instruction::new_with_bytes(
            cp_amm::ID,
            &cp_amm::client::args::Swap { _params: amm::SwapParameters { amount_in, minimum_amount_out: 0 } }.data(),
            cp_amm::client::accounts::Swap {
                pool_authority: DAMM_POOL_AUTHORITY,
                pool: p.pool,
                input_token_account: self.trader.tokens[input],
                output_token_account: self.trader.tokens[output],
                token_a_vault: p.vault_a,
                token_b_vault: p.vault_b,
                token_a_mint: self.assets[p.a].mint,
                token_b_mint: self.assets[p.b].mint,
                payer: self.trader.kp.pubkey(),
                token_a_program: self.assets[p.a].program,
                token_b_program: self.assets[p.b].program,
                referral_token_account: None,
                event_authority: DAMM_EVENT_AUTHORITY,
                program: cp_amm::ID,
            }
            .to_account_metas(None),
        );
        let trader = self.trader.kp.insecure_clone();
        send(&mut self.svm, &[ix], &trader, &[&trader]).unwrap();
    }

    /// Fixed accounts of `deposit` / `redeem`, then one group per asset and one per pool.
    fn holder_metas(&self, user: &User) -> Vec<AccountMeta> {
        let mut metas = stockwoven::accounts::Holder {
            user: user.kp.pubkey(),
            vault: self.vault,
            share_mint: self.share_mint,
            user_shares: user.shares,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            share_token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
        for (k, a) in self.assets.iter().enumerate() {
            metas.push(AccountMeta::new(user.tokens[k], false));
            metas.push(AccountMeta::new(a.reserve, false));
            metas.push(AccountMeta::new_readonly(a.mint, false));
        }
        for p in &self.pools {
            metas.push(AccountMeta::new(p.pool, false));
            metas.push(AccountMeta::new(p.position, false));
            metas.push(AccountMeta::new_readonly(p.nft_account, false));
            metas.push(AccountMeta::new(p.vault_a, false));
            metas.push(AccountMeta::new(p.vault_b, false));
        }
        metas
    }

    fn deposit(&mut self, user: &User, shares: u64, max_amounts: Vec<u64>) -> Result<u64, String> {
        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Deposit { shares, max_amounts }.data(),
            self.holder_metas(user),
        );
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp])
    }

    /// Deposits with the user's whole balances as the limits; the vault refunds the rest.
    fn deposit_all(&mut self, user: &User, shares: u64) -> Result<u64, String> {
        let max = self.balances(user);
        self.deposit(user, shares, max)
    }

    fn redeem(&mut self, user: &User, shares: u64, min_amounts: Vec<u64>) -> Result<u64, String> {
        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Redeem { shares, min_amounts }.data(),
            self.holder_metas(user),
        );
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp])
    }

    fn vault_account(&self) -> Vault {
        Vault::try_deserialize(&mut self.svm.get_account(&self.vault).unwrap().data.as_slice()).unwrap()
    }

    /// Amounts behind the vault's positions and idle reserves, per asset.
    fn holdings(&self) -> Vec<u64> {
        let mut amounts: Vec<u64> = self.assets.iter().map(|a| balance(&self.svm, &a.reserve)).collect();
        for p in &self.pools {
            let (liquidity, ra, rb) = pool_state(&self.svm, &p.pool);
            let share = position_liquidity(&self.svm, &p.position) as f64 / liquidity as f64;
            amounts[p.a] += (ra as f64 * share) as u64;
            amounts[p.b] += (rb as f64 * share) as u64;
        }
        amounts
    }

    fn vault_value(&self) -> f64 {
        self.value(&self.holdings())
    }

    fn value_per_share(&self) -> f64 {
        self.vault_value() / share_supply(&self.svm, &self.share_mint) as f64 * ONE_SHARE as f64
    }

    fn vault_pool_ix(&self, index: u8, reserve_b: Option<Pubkey>, data: Vec<u8>, caller: Pubkey) -> Instruction {
        let p = self.pools[index as usize];
        Instruction::new_with_bytes(
            stockwoven::id(),
            &data,
            stockwoven::accounts::VaultPool {
                caller,
                vault: self.vault,
                pool: p.pool,
                position: p.position,
                position_nft_account: p.nft_account,
                token_a_vault: p.vault_a,
                token_b_vault: p.vault_b,
                reserve_a: self.assets[p.a].reserve,
                reserve_b: reserve_b.unwrap_or(self.assets[p.b].reserve),
                mint_a: self.assets[p.a].mint,
                mint_b: self.assets[p.b].mint,
                damm_pool_authority: DAMM_POOL_AUTHORITY,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    fn rebalance_remove(&mut self, index: u8, liquidity: u128) -> Result<u64, String> {
        let data = stockwoven::instruction::RebalanceRemove { index, liquidity, min_a: 0, min_b: 0 }.data();
        let ix = self.vault_pool_ix(index, None, data, self.keeper.pubkey());
        self.keeper_send(&[ix])
    }

    fn rebalance_add_all(&mut self, index: u8) -> Result<u64, String> {
        let data = stockwoven::instruction::RebalanceAdd { index, liquidity: 0, max_a: 0, max_b: 0 }.data();
        let ix = self.vault_pool_ix(index, None, data, self.keeper.pubkey());
        self.keeper_send(&[ix])
    }

    fn harvest(&mut self, index: u8) -> Result<u64, String> {
        let treasury = self.assets[self.pools[index as usize].b].treasury;
        let caller = self.trader.kp.pubkey();
        let ix = self.vault_pool_ix(index, Some(treasury), stockwoven::instruction::Harvest { index }.data(), caller);
        let trader = self.trader.kp.insecure_clone();
        send(&mut self.svm, &[ix], &trader, &[&trader])
    }

    fn vault_swap(&mut self, p: PoolKeys, a_to_b: bool, amount_in: u64) -> Result<u64, String> {
        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::VaultSwap { a_to_b, amount_in, min_out: 0 }.data(),
            stockwoven::accounts::VaultSwap {
                keeper: self.keeper.pubkey(),
                vault: self.vault,
                pool: p.pool,
                token_a_vault: p.vault_a,
                token_b_vault: p.vault_b,
                reserve_a: self.assets[p.a].reserve,
                reserve_b: self.assets[p.b].reserve,
                mint_a: self.assets[p.a].mint,
                mint_b: self.assets[p.b].mint,
                damm_pool_authority: DAMM_POOL_AUTHORITY,
                damm_event_authority: DAMM_EVENT_AUTHORITY,
                damm_program: cp_amm::ID,
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.keeper_send(&[ix])
    }

    fn arbitrage_ix(&self, route: &[(PoolKeys, bool)], amount_in: u64, min_profit: u64, signer: Pubkey) -> Instruction {
        let start = { let (p, a_to_b) = route[0]; if a_to_b { p.a } else { p.b } };
        let mut metas = stockwoven::accounts::Arbitrage {
            keeper: signer,
            vault: self.vault,
            treasury_token: self.assets[start].treasury,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None);
        for (p, _) in route {
            metas.push(AccountMeta::new(p.pool, false));
            metas.push(AccountMeta::new(p.vault_a, false));
            metas.push(AccountMeta::new(p.vault_b, false));
            metas.push(AccountMeta::new_readonly(self.assets[p.a].mint, false));
            metas.push(AccountMeta::new_readonly(self.assets[p.b].mint, false));
            metas.push(AccountMeta::new(self.assets[p.a].reserve, false));
            metas.push(AccountMeta::new(self.assets[p.b].reserve, false));
        }
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::Arbitrage {
                a_to_b: route.iter().map(|&(_, d)| d).collect(),
                amount_in,
                min_profit,
            }
            .data(),
            metas,
        )
    }

    fn arbitrage(&mut self, route: &[(PoolKeys, bool)], amount_in: u64, min_profit: u64) -> Result<u64, String> {
        let ix = self.arbitrage_ix(route, amount_in, min_profit, self.keeper.pubkey());
        self.keeper_send(&[ix])
    }

    fn reserves(&self) -> Vec<u64> {
        self.assets.iter().map(|a| balance(&self.svm, &a.reserve)).collect()
    }

    /// Back-and-forth trades on every vault pool: the prices end where they started and the
    /// pools keep the fees.
    fn churn(&mut self, rounds: usize) {
        for _ in 0..rounds {
            for i in 0..self.pools.len() {
                let p = self.pools[i];
                let whole_a = 2.0;
                let before = balance(&self.svm, &self.trader.tokens[p.b]);
                self.trade(p, true, whole_a);
                let got = balance(&self.svm, &self.trader.tokens[p.b]) - before;
                let whole_b = got as f64 / 10f64.powi(self.assets[p.b].decimals as i32);
                self.trade(p, false, whole_b);
            }
        }
    }
}

fn setup_creates_four_pools(issuers: Issuers) {
    let env = Env::new(issuers);
    let vault = env.vault_account();
    assert_eq!(vault.num_assets, 5);
    assert_eq!(vault.num_pools, 4);
    assert_eq!(share_supply(&env.svm, &env.share_mint), SEED_SHARES);
    assert_eq!(balance(&env.svm, &env.admin_shares), SEED_SHARES);
    for (slot, p) in vault.pools().iter().zip(&env.pools) {
        assert_eq!(slot.pool, p.pool);
        assert_eq!(slot.position, p.position);
        assert!(position_liquidity(&env.svm, &p.position) > 0);
    }
    // $67.2k in SPCXx/SPCX, then $33.6k each in SPCXon/SPCXx, SPCX/USDC and SPCXx/SOL.
    let value = env.vault_value();
    assert!((value - 168.0 * 2.0 * 500.0).abs() / value < 0.01, "{value}");
}

#[test]
fn setup_with_spl_tokens() {
    setup_creates_four_pools(Issuers::Spl);
}

#[test]
fn setup_with_token_2022_issuer_tokens() {
    setup_creates_four_pools(Issuers::Token2022);
}

#[test]
fn later_pools_cannot_mint_shares() {
    let mut env = Env::new(Issuers::Spl);
    // SPCXon/USDC is a fifth pool: seeding it with shares would dilute holders.
    expect_error(env.try_add_pool(SPCXON, USDC, 1.0, ONE_SHARE), "InvalidSeedShares");
    env.try_add_pool(SPCXON, USDC, 1.0, 0).unwrap();
}

fn deposit_and_redeem(issuers: Issuers) {
    let mut env = Env::new(issuers);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let start = env.balances(&user);
    let vault_before = env.vault_value();

    // 10 swSPCX out of 1,000: about 1% of everything the vault holds.
    env.deposit_all(&user, 10 * ONE_SHARE).unwrap();
    assert_eq!(balance(&env.svm, &user.shares), 10 * ONE_SHARE);
    let paid: Vec<u64> = start.iter().zip(env.balances(&user)).map(|(s, e)| s - e).collect();
    let paid_value = env.value(&paid);
    assert!((paid_value / (vault_before / 100.0) - 1.0).abs() < 1e-3, "paid {paid_value}, vault {vault_before}");
    // Every asset the vault holds is paid for.
    assert!(paid.iter().all(|&x| x > 0), "{paid:?}");

    env.redeem(&user, 10 * ONE_SHARE, vec![0; 5]).unwrap();
    assert_eq!(balance(&env.svm, &user.shares), 0);
    let back: Vec<u64> = env.balances(&user).iter().zip(&start).map(|(e, s)| s - e).collect();
    // Rounding only ever favours the vault, and costs next to nothing.
    let lost = env.value(&back);
    assert!(lost >= 0.0 && lost < 0.01, "lost ${lost}");
}

#[test]
fn deposit_and_redeem_spl() {
    deposit_and_redeem(Issuers::Spl);
}

#[test]
fn deposit_and_redeem_token_2022() {
    deposit_and_redeem(Issuers::Token2022);
}

#[test]
fn deposit_limits_bound_what_the_pools_take() {
    let mut env = Env::new(Issuers::Spl);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let mut max = env.balances(&user);
    max[USDC] = 1; // far less USDC than 10 shares need
    // With no idle USDC in the vault, the pool cannot pull what is missing at all.
    expect_error(env.deposit(&user, 10 * ONE_SHARE, max.clone()), "Custom(1)");
    // With idle USDC (holders' money), the pool could take the shortfall from it; the final
    // check on every reserve stops that.
    let l = position_liquidity(&env.svm, &env.pools[P_USDC as usize].position);
    env.rebalance_remove(P_USDC, l / 2).unwrap();
    expect_error(env.deposit(&user, 10 * ONE_SHARE, max), "SlippageExceeded");

    env.deposit_all(&user, 10 * ONE_SHARE).unwrap();
    expect_error(env.redeem(&user, 10 * ONE_SHARE, vec![u64::MAX; 5]), "SlippageExceeded");
}

#[test]
fn fees_from_every_pool_compound_for_holders() {
    let mut env = Env::new(Issuers::Spl);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let start = env.balances(&user);
    env.deposit_all(&user, 10 * ONE_SHARE).unwrap();
    let paid: Vec<u64> = start.iter().zip(env.balances(&user)).map(|(s, e)| s - e).collect();
    let per_share_before = env.value_per_share();

    env.churn(10);
    assert!(env.value_per_share() > per_share_before);

    // The claimable part of each pool's fee is the protocol's cut, in token B.
    for i in 0..4u8 {
        env.harvest(i).unwrap();
    }
    assert!(balance(&env.svm, &env.assets[USDC].treasury) > 0);
    assert!(balance(&env.svm, &env.assets[SOL].treasury) > 0);
    assert!(balance(&env.svm, &env.assets[SPCX].treasury) > 0);

    let before_redeem = env.balances(&user);
    env.redeem(&user, 10 * ONE_SHARE, vec![0; 5]).unwrap();
    let got: Vec<u64> = env.balances(&user).iter().zip(&before_redeem).map(|(e, b)| e - b).collect();
    let (paid, got) = (env.value(&paid), env.value(&got));
    assert!(got > paid, "paid ${paid}, got ${got}");
}

#[test]
fn rebalancing_moves_value_between_pools() {
    let mut env = Env::new(Issuers::Spl);
    let value_before = env.vault_value();
    let sol_pool = env.pools[P_SOL as usize];
    let sol_liquidity = position_liquidity(&env.svm, &sol_pool.position);

    // Take a tenth of SpaceX/SOL out: it sits idle in the reserves and still belongs to holders.
    env.rebalance_remove(P_SOL, sol_liquidity / 10).unwrap();
    assert_eq!(position_liquidity(&env.svm, &sol_pool.position), sol_liquidity - sol_liquidity / 10);
    let idle = env.reserves();
    assert!(idle[SPCXX] > 0 && idle[SOL] > 0);
    assert!((env.vault_value() - value_before).abs() / value_before < 1e-6);

    // A depositor pays for the idle slice too, and a redeemer receives it.
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let start = env.balances(&user);
    env.deposit_all(&user, 10 * ONE_SHARE).unwrap();
    env.redeem(&user, 10 * ONE_SHARE, vec![0; 5]).unwrap();
    let lost: Vec<u64> = start.iter().zip(env.balances(&user)).map(|(s, e)| s - e).collect();
    assert!(env.value(&lost) < 0.01);

    // Turn the idle SOL into SPCX for the stock–stock pool: SOL → SPCXx on SpaceX/SOL, then
    // half of the SPCXx → SPCX on SPCXx/SPCX, then add everything the balances cover.
    let sol_idle = env.reserves()[SOL];
    env.vault_swap(sol_pool, false, sol_idle).unwrap();
    let stocks = env.pools[P_STOCKS as usize];
    let half = env.reserves()[SPCXX] / 2;
    env.vault_swap(stocks, true, half).unwrap();
    let stock_liquidity = position_liquidity(&env.svm, &stocks.position);
    env.rebalance_add_all(P_STOCKS).unwrap();
    assert!(position_liquidity(&env.svm, &stocks.position) > stock_liquidity);

    // Swap fees and price impact are the only cost of moving $3.4k between pools.
    let after = env.vault_value();
    assert!(after < value_before && (value_before - after) / value_before < 0.005, "{value_before} -> {after}");
}

#[test]
fn arbitrage_keeps_the_gap_for_holders() {
    let mut env = Env::new(Issuers::Spl);
    // Outside, SPCXx trades 3% rich against USDC; inside the vault, SPCX = SPCXx = $168.
    let rich = env.external_pool(SPCXX, USDC, 1.03, 1_000.0);
    let (usdc_pool, stocks) = (env.pools[P_USDC as usize], env.pools[P_STOCKS as usize]);
    // Free up some USDC for the keeper to work with.
    let l = position_liquidity(&env.svm, &usdc_pool.position);
    env.rebalance_remove(P_USDC, l / 10).unwrap();

    let value_before = env.vault_value();
    let reserves_before = env.reserves();
    // USDC → SPCX (vault pool), SPCX → SPCXx (vault pool), SPCXx → USDC (outside pool).
    let route = [(usdc_pool, false), (stocks, false), (rich, true)];
    let amount_in = env.raw(USDC, 100.0);
    env.arbitrage(&route, amount_in, 1).unwrap();

    let reserves_after = env.reserves();
    let profit = reserves_after[USDC] - reserves_before[USDC];
    let fee = balance(&env.svm, &env.assets[USDC].treasury);
    assert!(profit > 0 && fee > 0);
    assert_eq!(fee, (profit + fee) * ARB_FEE_BPS as u64 / 10_000);
    for k in [SPCXX, SPCX, SPCXON, SOL] {
        assert_eq!(reserves_after[k], reserves_before[k], "asset {k} moved");
    }
    // The outside pool paid for the gap; the vault as a whole is worth more.
    assert!(env.vault_value() > value_before);

    // The reverse cycle loses money, so it never lands.
    let reverse = [(rich, false), (stocks, true), (usdc_pool, true)];
    expect_error(env.arbitrage(&reverse, amount_in, 1), "NotProfitable");
    // A route has to come back to the token it started from.
    expect_error(env.arbitrage(&route[..2], amount_in, 1), "InvalidRoute");
    // Only the keeper may run it.
    let outsider = env.trader.kp.insecure_clone();
    let ix = env.arbitrage_ix(&route, amount_in, 1, outsider.pubkey());
    expect_error(send(&mut env.svm, &[ix], &outsider, &[&outsider]), "NotKeeper");
}

#[test]
fn arbitrage_can_use_an_ondo_gap() {
    let mut env = Env::new(Issuers::Spl);
    // Ondo's SPCXon sells 3% cheap for USDC outside; the vault's SPCXon/SPCXx pool is at par.
    let cheap_ondo = env.external_pool(SPCXON, USDC, 0.97, 1_000.0);
    let rich = env.external_pool(SPCXX, USDC, 1.0, 1_000.0);
    let ondo = env.pools[P_ONDO as usize];
    let l = position_liquidity(&env.svm, &env.pools[P_USDC as usize].position);
    env.rebalance_remove(P_USDC, l / 10).unwrap();
    let usdc_before = env.reserves()[USDC];
    // USDC → SPCXon (outside, cheap), SPCXon → SPCXx (vault, par), SPCXx → USDC (outside, par).
    let route = [(cheap_ondo, false), (ondo, true), (rich, true)];
    env.arbitrage(&route, env.raw(USDC, 100.0), 1).unwrap();
    assert!(env.reserves()[USDC] > usdc_before);
}

#[test]
fn only_the_keeper_rebalances_and_swaps() {
    let mut env = Env::new(Issuers::Spl);
    let outsider = env.trader.kp.insecure_clone();
    let data = stockwoven::instruction::RebalanceRemove { index: P_SOL, liquidity: 1_000, min_a: 0, min_b: 0 }.data();
    let ix = env.vault_pool_ix(P_SOL, None, data, outsider.pubkey());
    expect_error(send(&mut env.svm, &[ix], &outsider, &[&outsider]), "NotKeeper");

    // Accounts of another pool than the index are rejected.
    let data = stockwoven::instruction::RebalanceRemove { index: P_USDC, liquidity: 1_000, min_a: 0, min_b: 0 }.data();
    let ix = env.vault_pool_ix(P_SOL, None, data, env.keeper.pubkey());
    expect_error(env.keeper_send(&[ix]), "AccountMismatch");

    // Harvest is open to anyone, but only into a treasury account.
    let stranger_usdc = env.trader.tokens[USDC];
    let ix = env.vault_pool_ix(P_USDC, Some(stranger_usdc), stockwoven::instruction::Harvest { index: P_USDC }.data(), outsider.pubkey());
    expect_error(send(&mut env.svm, &[ix], &outsider, &[&outsider]), "NotTreasury");
}

#[test]
fn deposit_rejects_accounts_out_of_order() {
    let mut env = Env::new(Issuers::Spl);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let max = env.balances(&user);
    let mut metas = env.holder_metas(&user);
    // Swap the reserves of SPCXx and SPCX.
    let fixed = metas.len() - 5 * 3 - 4 * 5;
    metas.swap(fixed + 1, fixed + 4);
    let ix = Instruction::new_with_bytes(
        stockwoven::id(),
        &stockwoven::instruction::Deposit { shares: ONE_SHARE, max_amounts: max.clone() }.data(),
        metas,
    );
    expect_error(send(&mut env.svm, &[ix], &user.kp, &[&user.kp]), "AccountMismatch");
    expect_error(env.deposit(&user, ONE_SHARE, max[..4].to_vec()), "WrongAccountCount");
}

#[test]
fn rounding_never_pays_out_more_than_paid_in() {
    let mut env = Env::new(Issuers::Spl);
    let users: Vec<User> = (0..3).map(|_| env.user([100.0, 100.0, 100.0, 50_000.0, 500.0])).collect();
    let starts: Vec<Vec<u64>> = users.iter().map(|u| env.balances(u)).collect();
    let odd = [1u64, 7_777_777, 3 * ONE_SHARE + 1];
    for (u, &s) in users.iter().zip(&odd) {
        env.deposit_all(u, s).unwrap();
    }
    let per_share = env.value_per_share();
    for (u, &s) in users.iter().zip(&odd).rev() {
        env.redeem(u, s, vec![0; 5]).unwrap_or_else(|e| {
            // A single raw share can be too small to take anything out of a pool: cp-amm
            // rejects the zero amount and the holder keeps the share.
            assert!(s == 1 && e.contains("AmountIsZero"), "{e}");
            0
        });
    }
    for (u, start) in users.iter().zip(&starts) {
        let lost: Vec<u64> = start.iter().zip(env.balances(u)).map(|(s, e)| s - e).collect();
        assert!(env.value(&lost) >= 0.0);
    }
    // Rounding dust stays with the remaining holders.
    assert!(env.value_per_share() >= per_share * (1.0 - 1e-12));
}

#[test]
fn paused_vault_rejects_deposits_but_allows_redeem() {
    let mut env = Env::new(Issuers::Spl);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    env.deposit_all(&user, 5 * ONE_SHARE).unwrap();

    let pause = |paused: bool, admin: Pubkey, vault: Pubkey| {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::SetDepositsPaused { paused }.data(),
            stockwoven::accounts::AdminOnly { admin, vault }.to_account_metas(None),
        )
    };
    let outsider = env.trader.kp.insecure_clone();
    expect_error(send(&mut env.svm, &[pause(true, outsider.pubkey(), env.vault)], &outsider, &[&outsider]), "Unauthorized");
    env.admin_send(&[pause(true, env.admin.pubkey(), env.vault)], &[]).unwrap();

    expect_error(env.deposit_all(&user, ONE_SHARE), "DepositsPaused");
    env.redeem(&user, 5 * ONE_SHARE, vec![0; 5]).unwrap();

    env.admin_send(&[pause(false, env.admin.pubkey(), env.vault)], &[]).unwrap();
    env.deposit_all(&user, ONE_SHARE).unwrap();
}

#[test]
fn admin_sets_weights_keeper_and_fee() {
    let mut env = Env::new(Issuers::Spl);
    let (admin, vault) = (env.admin.pubkey(), env.vault);
    let ix = |data: Vec<u8>| {
        Instruction::new_with_bytes(stockwoven::id(), &data, stockwoven::accounts::AdminOnly { admin, vault }.to_account_metas(None))
    };
    env.admin_send(&[ix(stockwoven::instruction::SetPoolWeights { weights: vec![4_000, 2_000, 2_000, 2_000] }.data())], &[])
        .unwrap();
    expect_error(
        env.admin_send(&[ix(stockwoven::instruction::SetPoolWeights { weights: vec![6_000, 6_000, 0, 0] }.data())], &[]),
        "InvalidWeight",
    );
    expect_error(env.admin_send(&[ix(stockwoven::instruction::SetArbFee { arb_fee_bps: 9_000 }.data())], &[]), "InvalidArbFee");
    let new_keeper = Keypair::new();
    env.admin_send(&[ix(stockwoven::instruction::SetKeeper { keeper: new_keeper.pubkey() }.data())], &[]).unwrap();
    let v = env.vault_account();
    assert_eq!(v.keeper, new_keeper.pubkey());
    assert_eq!(v.pools[0].target_weight_bps, 4_000);
    // The old keeper is out.
    expect_error(env.rebalance_remove(P_SOL, 1_000), "NotKeeper");
}

/// Compute units per instruction, printed with `cargo test -- --nocapture cu_profile`.
#[test]
fn cu_profile() {
    let mut env = Env::new(Issuers::Token2022);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let deposit = env.deposit_all(&user, 10 * ONE_SHARE).unwrap();
    let redeem = env.redeem(&user, 5 * ONE_SHARE, vec![0; 5]).unwrap();
    let l = position_liquidity(&env.svm, &env.pools[P_USDC as usize].position);
    let remove = env.rebalance_remove(P_USDC, l / 10).unwrap();
    let add = env.rebalance_add_all(P_USDC).unwrap();
    env.rebalance_remove(P_USDC, l / 10).unwrap();
    let rich = env.external_pool(SPCXX, USDC, 1.03, 1_000.0);
    let route = [(env.pools[P_USDC as usize], false), (env.pools[P_STOCKS as usize], false), (rich, true)];
    let arb = env.arbitrage(&route, env.raw(USDC, 100.0), 1).unwrap();
    let harvest = env.harvest(P_USDC).unwrap();
    for (label, cu) in [("deposit (5 assets, 4 pools)", deposit), ("redeem", redeem), ("rebalance_remove", remove), ("rebalance_add", add), ("arbitrage (3 hops)", arb), ("harvest", harvest)] {
        println!("{label:<30} {cu:>9} CU");
        assert!(cu < 1_400_000, "{label}");
    }
    assert!(LAST_CU.with(|c| c.get()) > 0);
}

// Single-token deposits and redemptions: the basket.

const NOW: i64 = 1_760_000_000;

/// 2% band, 5 bps base fee plus 2 bps per point away from target, at most 1%, at best a 3 bps
/// discount, prices good for ten minutes.
fn basket_params() -> BasketParams {
    BasketParams { band_bps: 200, base_fee_bps: 5, fee_slope_bps: 2, max_fee_bps: 100, max_discount_bps: 3, max_price_age: 600 }
}

/// (issuer token?, target, cap) per asset. The seed leaves SPCXx at its 40% cap, SPCX at 30%
/// (above its 25% target), and SPCXon, USDC and SOL at 10% each (SPCXon well under its 25%).
const WEIGHTS: [(bool, u16, u16); 5] = [(true, 3_000, 4_000), (true, 2_500, 4_000), (true, 2_500, 4_000), (false, 1_000, 10_000), (false, 1_000, 10_000)];

fn weights() -> Vec<AssetWeights> {
    WEIGHTS.iter().map(|&(is_stock, target, cap)| AssetWeights { is_stock, target_weight_bps: target, max_weight_bps: cap }).collect()
}

impl Env {
    fn basket(&self) -> Pubkey {
        pda(&[b"basket", self.vault.as_ref()], &stockwoven::id())
    }

    fn set_clock(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn set_basket_ix(&self, admin: Pubkey, params: BasketParams, weights: Vec<AssetWeights>) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::SetBasket { params, weights }.data(),
            stockwoven::accounts::SetBasket { admin, vault: self.vault, basket: self.basket() }.to_account_metas(None),
        )
    }

    /// The basket with `WEIGHTS`, and the assets' market prices posted at `NOW`.
    fn setup_basket(&mut self) {
        self.set_clock(NOW);
        let ix = Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::InitBasket { params: basket_params(), weights: weights() }.data(),
            stockwoven::accounts::InitBasket {
                admin: self.admin.pubkey(),
                vault: self.vault,
                basket: self.basket(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.admin_send(&[ix], &[]).unwrap();
        let prices = self.market_prices();
        self.set_prices(prices).unwrap();
    }

    /// Nano-shares of SpaceX per whole token, at the assets' USD prices.
    fn market_prices(&self) -> Vec<u64> {
        self.assets.iter().map(|a| (a.price / self.assets[SPCXX].price * 1e9).round() as u64).collect()
    }

    fn set_prices_ix(&self, prices: Vec<u64>, keeper: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            stockwoven::id(),
            &stockwoven::instruction::SetPrices { prices }.data(),
            stockwoven::accounts::SetPrices { keeper, vault: self.vault, basket: self.basket() }.to_account_metas(None),
        )
    }

    fn set_prices(&mut self, prices: Vec<u64>) -> Result<u64, String> {
        let ix = self.set_prices_ix(prices, self.keeper.pubkey());
        self.keeper_send(&[ix])
    }

    fn basket_account(&self) -> Basket {
        Basket::try_deserialize(&mut self.svm.get_account(&self.basket()).unwrap().data.as_slice()).unwrap()
    }

    /// Fixed accounts of `deposit_single` / `redeem_single`, then (reserve, mint) per asset, the
    /// pools, and the optional conversion pool.
    fn single_ix(&self, user: &User, asset: usize, data: Vec<u8>, swap: Option<PoolKeys>) -> Instruction {
        let mut metas = stockwoven::accounts::Single {
            user: user.kp.pubkey(),
            vault: self.vault,
            basket: self.basket(),
            share_mint: self.share_mint,
            user_shares: user.shares,
            user_token: user.tokens[asset],
            mint: self.assets[asset].mint,
            damm_pool_authority: DAMM_POOL_AUTHORITY,
            damm_event_authority: DAMM_EVENT_AUTHORITY,
            damm_program: cp_amm::ID,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            share_token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
        for a in &self.assets {
            metas.push(AccountMeta::new(a.reserve, false));
            metas.push(AccountMeta::new_readonly(a.mint, false));
        }
        for p in &self.pools {
            metas.push(AccountMeta::new(p.pool, false));
            metas.push(AccountMeta::new(p.position, false));
            metas.push(AccountMeta::new_readonly(p.nft_account, false));
            metas.push(AccountMeta::new(p.vault_a, false));
            metas.push(AccountMeta::new(p.vault_b, false));
        }
        if let Some(p) = swap {
            metas.push(AccountMeta::new(p.pool, false));
            metas.push(AccountMeta::new(p.vault_a, false));
            metas.push(AccountMeta::new(p.vault_b, false));
            metas.push(AccountMeta::new_readonly(self.assets[p.a].mint, false));
            metas.push(AccountMeta::new_readonly(self.assets[p.b].mint, false));
        }
        Instruction::new_with_bytes(stockwoven::id(), &data, metas)
    }

    fn deposit_single(&mut self, user: &User, asset: usize, amount_in: u64, swap: Option<PoolKeys>) -> Result<u64, String> {
        let ix = self.single_ix(user, asset, stockwoven::instruction::DepositSingle { amount_in, min_shares: 0 }.data(), swap);
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp])
    }

    fn redeem_single(&mut self, user: &User, asset: usize, shares: u64, min_amount: u64) -> Result<u64, String> {
        let ix = self.single_ix(user, asset, stockwoven::instruction::RedeemSingle { shares, min_amount }.data(), None);
        send(&mut self.svm, &[ix], &user.kp, &[&user.kp])
    }

    fn shares_of(&self, user: &User) -> u64 {
        balance(&self.svm, &user.shares)
    }

    /// Shares a deposit worth `usd` would mint with no fee.
    fn fair_shares(&self, usd: f64) -> f64 {
        usd / self.vault_value() * share_supply(&self.svm, &self.share_mint) as f64
    }

    /// Share of the vault's value in asset `k`, in bps.
    fn weight(&self, k: usize) -> f64 {
        let holdings = self.holdings();
        let mut one = vec![0; holdings.len()];
        one[k] = holdings[k];
        self.value(&one) / self.value(&holdings) * 10_000.0
    }
}

fn single_deposits_value_issuer_tokens_one_to_one(issuers: Issuers) {
    let mut env = Env::new(issuers);
    env.setup_basket();
    assert!((env.weight(SPCX) - 3_000.0).abs() < 1.0 && (env.weight(SPCXON) - 1_000.0).abs() < 1.0);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let per_share = env.value_per_share();

    // SPCX is overweight (30% against 25%): 5 bps plus 2 bps per point at the midpoint, ~15 bps.
    let fair = env.fair_shares(10.0 * 168.0);
    env.deposit_single(&user, SPCX, env.raw(SPCX, 10.0), None).unwrap();
    let for_spcx = env.shares_of(&user) as f64;
    let fee = 1.0 - for_spcx / fair;
    assert!(fee > 0.0013 && fee < 0.0017, "SPCX fee {fee}");

    // SPCXon is underweight (10% against 25%): the deposit earns the 3 bps discount.
    let fair = env.fair_shares(10.0 * 168.0);
    env.deposit_single(&user, SPCXON, env.raw(SPCXON, 10.0), None).unwrap();
    let for_ondo = env.shares_of(&user) as f64 - for_spcx;
    assert!((for_ondo / fair - 1.0003).abs() < 2e-6, "SPCXon {}", for_ondo / fair);

    // The tokens wait idle for the keeper, and the net fee stays with the holders.
    assert_eq!(env.reserves()[SPCX], env.raw(SPCX, 10.0));
    assert!(env.value_per_share() > per_share);
}

#[test]
fn single_deposits_value_issuer_tokens_one_to_one_spl() {
    single_deposits_value_issuer_tokens_one_to_one(Issuers::Spl);
}

#[test]
fn single_deposits_value_issuer_tokens_one_to_one_token_2022() {
    single_deposits_value_issuer_tokens_one_to_one(Issuers::Token2022);
}

#[test]
fn caps_refuse_a_token_and_conversion_redirects_it() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);

    // SPCXx already sits at its 40% cap.
    expect_error(env.deposit_single(&user, SPCXX, env.raw(SPCXX, 1.0), None), "AssetAtCap");
    // Routed through the vault's SPCXon/SPCXx pool, it becomes SPCXon, which is underweight.
    let ondo_before = env.reserves()[SPCXON];
    let fair = env.fair_shares(0.5 * 168.0);
    env.deposit_single(&user, SPCXX, env.raw(SPCXX, 0.5), Some(env.pools[P_ONDO as usize])).unwrap();
    assert!(env.reserves()[SPCXON] > ondo_before);
    assert!(env.shares_of(&user) as f64 > fair * 0.98, "{} vs {fair}", env.shares_of(&user));
    // Never into SPCX, which is above its target.
    expect_error(env.deposit_single(&user, SPCXX, env.raw(SPCXX, 0.5), Some(env.pools[P_STOCKS as usize])), "NotUnderweight");
}

#[test]
fn usdc_is_converted_into_an_underweight_issuer_token() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let usdc = env.raw(USDC, 1_680.0);

    // The vault never takes USDC at its own valuation: it has to be converted.
    expect_error(env.deposit_single(&user, USDC, usdc, None), "NotAStock");
    // The vault's SPCX/USDC pool would turn it into SPCX, which is overweight.
    expect_error(env.deposit_single(&user, USDC, usdc, Some(env.pools[P_USDC as usize])), "NotUnderweight");

    // A market SPCXon/USDC pool turns it into Ondo's token, the most underweight.
    let market = env.external_pool(SPCXON, USDC, 1.0, 1_000.0);
    let ondo_before = env.reserves()[SPCXON];
    let per_share = env.value_per_share();
    env.deposit_single(&user, USDC, usdc, Some(market)).unwrap();
    assert!(env.reserves()[SPCXON] > ondo_before);
    assert_eq!(env.reserves()[USDC], 0);
    // $1,680 less the market pool's 0.3% fee and ~1% price impact, plus the vault's discount.
    let got = env.shares_of(&user) as f64 / ONE_SHARE as f64 * per_share;
    assert!(got > 1_680.0 * 0.98 && got < 1_680.0, "${got}");
}

#[test]
fn circuit_breaker_stops_a_token_that_leaves_the_band() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    env.deposit_all(&user, 10 * ONE_SHARE).unwrap();

    // Someone dumps SPCXon into the vault's SPCXon/SPCXx pool: it now trades ~3% under SPCXx.
    let ondo = env.pools[P_ONDO as usize];
    env.trade(ondo, true, 1.5);
    // The keeper's prices still say 1:1, so that pool is outside the band and every single-token
    // trade stops, whichever token it is in.
    expect_error(env.deposit_single(&user, SPCX, env.raw(SPCX, 1.0), None), "PoolOutOfBand");
    expect_error(env.redeem_single(&user, SPCXX, ONE_SHARE, 0), "PoolOutOfBand");

    // The keeper posts the market: SPCXon at the pool's price, outside the 2% band.
    let (_, ra, rb) = pool_state(&env.svm, &ondo.pool);
    let mut prices = env.market_prices();
    prices[SPCXON] = ((rb as f64 / 1e8) / (ra as f64 / 1e9) * 1e9) as u64;
    assert!(prices[SPCXON] < 980_000_000, "{}", prices[SPCXON]);
    env.set_prices(prices).unwrap();

    // The vault stops taking or paying out SPCXon alone...
    expect_error(env.deposit_single(&user, SPCXON, env.raw(SPCXON, 1.0), None), "TokenDepegged");
    expect_error(env.redeem_single(&user, SPCXON, ONE_SHARE, 0), "TokenDepegged");
    // ...and never converts into it.
    let market = env.external_pool(SPCXON, USDC, 1.0, 1_000.0);
    expect_error(env.deposit_single(&user, USDC, env.raw(USDC, 168.0), Some(market)), "TokenDepegged");
    // The other issuers carry on, and in-kind redemption never needs a price.
    env.deposit_single(&user, SPCX, env.raw(SPCX, 1.0), None).unwrap();
    env.redeem_single(&user, SPCX, ONE_SHARE, 0).unwrap();
    env.redeem(&user, ONE_SHARE, vec![0; 5]).unwrap();
}

#[test]
fn stale_prices_halt_single_token_trades_only() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    env.deposit_all(&user, 5 * ONE_SHARE).unwrap();

    env.set_clock(NOW + 601);
    expect_error(env.deposit_single(&user, SPCX, env.raw(SPCX, 1.0), None), "PricesStale");
    expect_error(env.redeem_single(&user, SPCXX, ONE_SHARE, 0), "PricesStale");
    env.deposit_all(&user, ONE_SHARE).unwrap();
    env.redeem(&user, ONE_SHARE, vec![0; 5]).unwrap();

    let prices = env.market_prices();
    env.set_prices(prices).unwrap();
    assert_eq!(env.basket_account().prices_updated_at, NOW + 601);
    env.deposit_single(&user, SPCX, env.raw(SPCX, 1.0), None).unwrap();
}

#[test]
fn redeem_single_pays_one_token_with_the_dynamic_fee() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    env.deposit_all(&user, 50 * ONE_SHARE).unwrap();
    let per_share = env.value_per_share();
    let fair = 20.0 * per_share;
    // Nothing idle: every token paid out comes out of the pools.
    assert!(env.reserves().iter().all(|&r| r < 10));

    // SPCXx is overweight (40% against 30%): taking it out rebalances the vault, at a discount.
    let before = env.balances(&user)[SPCXX];
    env.redeem_single(&user, SPCXX, 20 * ONE_SHARE, 0).unwrap();
    let got = (env.balances(&user)[SPCXX] - before) as f64 / 1e8 * 168.0;
    assert!((got / fair - 1.0003).abs() < 1e-5, "SPCXx {}", got / fair);

    // SPCXon is underweight (10% against 25%): taking it out costs more, ~36 bps.
    let before = env.balances(&user)[SPCXON];
    env.redeem_single(&user, SPCXON, 20 * ONE_SHARE, 0).unwrap();
    let got = (env.balances(&user)[SPCXON] - before) as f64 / 1e9 * 168.0;
    let fee = 1.0 - got / fair;
    assert!(fee > 0.0030 && fee < 0.0040, "SPCXon fee {fee}");

    // The other side of the liquidity taken out stays in the vault, idle, for the keeper.
    assert!(env.reserves()[SPCX] > 0);
    // Holders end up ahead: the fees outweigh the discount.
    assert!(env.value_per_share() > per_share);
    expect_error(env.redeem_single(&user, SPCXX, ONE_SHARE, u64::MAX), "SlippageExceeded");
    // Only issuer tokens are paid out alone.
    expect_error(env.redeem_single(&user, USDC, ONE_SHARE, 0), "NotAStock");
}

#[test]
fn a_single_token_round_trip_never_profits() {
    let mut env = Env::new(Issuers::Spl);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let start = env.balances(&user)[SPCXON];
    // In with the discount...
    env.deposit_single(&user, SPCXON, env.raw(SPCXON, 10.0), None).unwrap();
    // ...and straight back out, which pays for the imbalance it now leaves.
    let shares = env.shares_of(&user);
    env.redeem_single(&user, SPCXON, shares, 0).unwrap();
    let end = env.balances(&user)[SPCXON];
    assert!(end < start, "{start} -> {end}");
}

#[test]
fn only_the_admin_sets_the_basket_and_only_the_keeper_posts_prices() {
    let mut env = Env::new(Issuers::Spl);
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    // No basket, no single-token deposits.
    expect_error(env.deposit_single(&user, SPCX, env.raw(SPCX, 1.0), None), "AccountNotInitialized");
    env.setup_basket();

    let outsider = env.trader.kp.insecure_clone();
    let ix = env.set_prices_ix(env.market_prices(), outsider.pubkey());
    expect_error(send(&mut env.svm, &[ix], &outsider, &[&outsider]), "NotKeeper");
    let ix = env.set_basket_ix(outsider.pubkey(), basket_params(), weights());
    expect_error(send(&mut env.svm, &[ix], &outsider, &[&outsider]), "Unauthorized");

    let admin = env.admin.pubkey();
    let mut too_heavy = weights();
    too_heavy[USDC].target_weight_bps = 5_000;
    expect_error(env.admin_send(&[env.set_basket_ix(admin, basket_params(), too_heavy)], &[]), "InvalidWeight");
    let mut above_cap = weights();
    above_cap[SPCX].target_weight_bps = 4_500;
    expect_error(env.admin_send(&[env.set_basket_ix(admin, basket_params(), above_cap)], &[]), "InvalidWeight");
    let wide = BasketParams { band_bps: 2_000, ..basket_params() };
    expect_error(env.admin_send(&[env.set_basket_ix(admin, wide, weights())], &[]), "InvalidBasket");
    expect_error(env.admin_send(&[env.set_basket_ix(admin, basket_params(), weights()[..4].to_vec())], &[]), "WrongAccountCount");

    // Capping Ondo at 10%, where it already sits, closes it to deposits.
    let mut capped = weights();
    capped[SPCXON] = AssetWeights { is_stock: true, target_weight_bps: 1_000, max_weight_bps: 1_000 };
    env.admin_send(&[env.set_basket_ix(admin, basket_params(), capped)], &[]).unwrap();
    assert_eq!(env.basket_account().assets[SPCXON].weights.max_weight_bps, 1_000);
    expect_error(env.deposit_single(&user, SPCXON, env.raw(SPCXON, 1.0), None), "AssetAtCap");
}

/// Compute units of the single-token instructions, printed with `--nocapture cu_profile_single`.
#[test]
fn cu_profile_single() {
    let mut env = Env::new(Issuers::Token2022);
    env.setup_basket();
    let user = env.user([100.0, 100.0, 100.0, 50_000.0, 500.0]);
    let market = env.external_pool(SPCXON, USDC, 1.0, 1_000.0);
    let direct = env.deposit_single(&user, SPCXON, env.raw(SPCXON, 1.0), None).unwrap();
    let converted = env.deposit_single(&user, USDC, env.raw(USDC, 168.0), Some(market)).unwrap();
    let out = env.redeem_single(&user, SPCXX, ONE_SHARE, 0).unwrap();
    for (label, cu) in [("deposit_single", direct), ("deposit_single (USDC, converted)", converted), ("redeem_single (from pools)", out)] {
        println!("{label:<34} {cu:>9} CU");
        assert!(cu < 1_400_000, "{label}");
    }
}
