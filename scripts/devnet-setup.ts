// Sets up the swSPCX vault on devnet:
// - three mock SpaceX tokens with the issuers' real decimals (SPCXx 8, Backpack SPCX 6, Ondo
//   SPCXon 9), minted by the faucet key so the app's faucet can drip them;
// - the vault, its five assets (the three SpaceX tokens, the mock USDC and wSOL) and four pools:
//   SPCXx/SPCX and SPCXon/SPCXx (stock–stock), SPCX/USDC and SPCXx/SOL;
// - two market pools that other people would own on mainnet (SPCXx/USDC and SPCXon/USDC), plus
//   the existing wSOL/USDC pool, which the keeper arbitrages against;
// - the basket: target weights, caps, the dynamic fee and the circuit breaker for single-token
//   deposits and redemptions, with the first prices;
// - the lookup table that fits deposits and redeems (~45 accounts) in one transaction.
//
//   KEYPAIR=//wsl.localhost/Ubuntu/home/pedro/.config/solana/id.json \
//   FAUCET_KEYPAIR=C:/Users/pedro/.stockwoven/faucet-keypair.json npx tsx scripts/devnet-setup.ts
//
// Each step is skipped once devnet.json records it, so the script can be re-run after a failure.

import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createSyncNativeInstruction,
  mintTo,
} from "@solana/spl-token";
import {
  AssetInfo,
  CP_AMM,
  DAMM_EVENT_AUTHORITY,
  DAMM_POOL_AUTHORITY,
  DEVNET_FILES,
  Devnet,
  STOCKWOVEN,
  SHARE_DECIMALS,
  addAssetIx,
  DEFAULT_BASKET,
  addPoolIx,
  admin,
  ata,
  basketAddress,
  basketPrices,
  basketWeights,
  conn,
  createMarketPoolIx,
  hasDevnet,
  initBasketIx,
  initializeVaultIx,
  loadKeypair,
  pk,
  poolAddresses,
  positionAddresses,
  prices,
  readDevnet,
  readState,
  reserveAddress,
  sendV0,
  setPricesIx,
  shareMintAddress,
  sqrtPriceFor,
  vaultAddress,
  writeDevnet,
} from "./sw.ts";

const faucet = loadKeypair(process.env.FAUCET_KEYPAIR ?? "C:/Users/pedro/.stockwoven/faucet-keypair.json");
const TICKER = "SPCX";
const STOCK_USD = Number(process.env.STOCK_USD ?? 168); // SpaceX on Jupiter, Oct 2026
const TRADE_FEE_BPS = 30;
const ARB_FEE_BPS = 2_000;

/** The mock USDC the earlier devnet setup created (mint authority: the faucet key). */
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? "5xzRhDT2jdyJ1WbwnyBdj8Gjb5JbNrD3G3w89b7Qeahz");
/** The existing wSOL/USDC pool (wSOL is token A); it prices SOL for the setup. */
const SOL_USDC_POOL = {
  pool: "3n6nM4mN722rB8oa5RH2c3y75eaGemhveBBK1xu45qYL",
  tokenAVault: "Bn83pTazSyX3agoq2Qidb3nBnGPC9LBwW4sT6aAPNKDr",
  tokenBVault: "FkVY8M4BCmGX2huiYqd31QGeQwJWcg7gAALhwhXWBVY7",
  feeBps: 10,
};

const STOCKS = [
  { symbol: "SPCXx", name: "SpaceX xStock", issuer: "xStocks", decimals: 8 },
  { symbol: "SPCX", name: "SpaceX (Backpack)", issuer: "Backpack", decimals: 6 },
  { symbol: "SPCXon", name: "SpaceX (Ondo Tokenized)", issuer: "Ondo", decimals: 9 },
] as const;

const [SPCXX, SPCX, SPCXON, USDC, SOL] = [0, 1, 2, 3, 4];

/** Vault pools: token A, token B, whole token A seeded. SOL is scarce on devnet. */
const VAULT_POOLS = [
  { label: "SPCXx / SPCX", kind: "stock-stock", a: SPCXX, b: SPCX, wholeA: 100 },
  { label: "SPCXon / SPCXx", kind: "stock-stock", a: SPCXON, b: SPCXX, wholeA: 50 },
  { label: "SPCX / USDC", kind: "stock-usdc", a: SPCX, b: USDC, wholeA: 50 },
  { label: "SPCXx / SOL", kind: "stock-sol", a: SPCXX, b: SOL, wholeA: 0 },
] as const;
/** Share of the vault's value the keeper keeps idle to fund arbitrage. */
const IDLE_BUFFER_BPS = 500;
/** SOL put into SPCXx/SOL; its SPCXx side follows from the price. */
const SOL_IN_VAULT_POOL = 0.5;

/** Market pools: other LPs on mainnet; the admin seeds them on devnet. */
const MARKET_POOLS = [
  { label: "SPCXx / USDC (market)", a: SPCXX, b: USDC, wholeA: 100 },
  { label: "SPCXon / USDC (market)", a: SPCXON, b: USDC, wholeA: 50 },
] as const;

function log(...args: unknown[]) {
  console.log(...args);
}

async function send(ixs: TransactionInstruction[], extra: Keypair[] = []) {
  return sendV0(ixs, [admin, ...extra]);
}

async function solUsd() {
  const info = await conn.getAccountInfo(pk(SOL_USDC_POOL.pool));
  if (!info) throw new Error("wSOL/USDC pool not found");
  const d = Buffer.from(info.data);
  return (Number(d.readBigUInt64LE(688)) / 1e6) / (Number(d.readBigUInt64LE(680)) / 1e9);
}

async function mintAndFund(): Promise<AssetInfo[]> {
  const assets: AssetInfo[] = [];
  const vault = vaultAddress(TICKER);
  for (const s of STOCKS) {
    const mint = await createMint(conn, admin, faucet.publicKey, null, s.decimals);
    log(`mock ${s.symbol}`, mint.toBase58());
    assets.push({
      symbol: s.symbol, name: `${s.name} (mock)`, issuer: s.issuer, kind: "stock", mint: mint.toBase58(), decimals: s.decimals,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(), reserve: reserveAddress(vault, mint).toBase58(),
    });
  }
  assets.push({
    symbol: "USDC", name: "USD Coin (mock)", issuer: null, kind: "usdc", mint: USDC_MINT.toBase58(), decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), reserve: reserveAddress(vault, USDC_MINT).toBase58(),
  });
  assets.push({
    symbol: "SOL", name: "Solana", issuer: null, kind: "sol", mint: NATIVE_MINT.toBase58(), decimals: 9,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), reserve: reserveAddress(vault, NATIVE_MINT).toBase58(),
  });
  return assets;
}

/** Mints what the setup needs to the admin, with the faucet key. */
async function fundAdmin(d: Devnet) {
  const need = [400, 300, 250, 60_000];
  const ixs = [0, 1, 2, 3].map((k) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, pk(d.assets[k].mint)), admin.publicKey, pk(d.assets[k].mint)));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, NATIVE_MINT), admin.publicKey, NATIVE_MINT));
  await send(ixs);
  for (const k of [0, 1, 2, 3]) {
    const a = d.assets[k];
    await mintTo(conn, admin, pk(a.mint), ata(admin.publicKey, pk(a.mint)), faucet, BigInt(need[k]) * 10n ** BigInt(a.decimals));
  }
  log("funded the admin with mock SPCXx, SPCX, SPCXon and USDC");
}

/** Wraps SOL until the admin's wSOL account holds `lamports`. */
async function wrapSol(lamports: bigint) {
  const wsol = ata(admin.publicKey, NATIVE_MINT);
  const held = BigInt((await conn.getTokenAccountBalance(wsol)).value.amount);
  if (held < lamports) {
    await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wsol, lamports: lamports - held }), createSyncNativeInstruction(wsol)]);
  }
}

const usdOf = (d: Devnet, k: number) => (d.assets[k].kind === "usdc" ? 1 : d.assets[k].kind === "sol" ? d.launch.solUsd : d.launch.stockUsd);

/** Liquidity that holds `wholeA` of token A at the pool's price: L = amountA * sqrtPrice. */
function seed(d: Devnet, a: number, b: number, wholeA: number) {
  const [da, db] = [d.assets[a].decimals, d.assets[b].decimals];
  const sqrtPrice = sqrtPriceFor(usdOf(d, a), da, usdOf(d, b), db);
  const amountA = BigInt(Math.floor(wholeA * 10 ** da));
  return { sqrtPrice, liquidity: amountA * sqrtPrice };
}

/** USD each vault pool is seeded with. */
const seededUsd = (solUsdPrice: number) =>
  VAULT_POOLS.map((p) => (p.kind === "stock-sol" ? 2 * SOL_IN_VAULT_POOL * solUsdPrice : 2 * p.wholeA * STOCK_USD));

/** Starting target weights: each pool's seeded share of the vault, leaving the idle buffer. The keeper moves them by yield. */
function launchWeights(solUsdPrice: number) {
  const usd = seededUsd(solUsdPrice);
  const total = usd.reduce((a, b) => a + b, 0);
  return usd.map((v) => Math.floor((v / total) * (10_000 - IDLE_BUFFER_BPS)));
}

async function addVaultPools(d: Devnet) {
  const vault = pk(d.vault);
  const shareMint = pk(d.shareMint);
  await send([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, shareMint), admin.publicKey, shareMint)]);
  const solPoolStock = (SOL_IN_VAULT_POOL * d.launch.solUsd) / d.launch.stockUsd;
  const weights = launchWeights(d.launch.solUsd);
  for (const [i, spec] of VAULT_POOLS.entries()) {
    if (d.pools[i]) continue;
    const wholeA = spec.kind === "stock-sol" ? solPoolStock : spec.wholeA;
    if (spec.b === SOL) await wrapSol(BigInt(Math.ceil(SOL_IN_VAULT_POOL * 1.02 * LAMPORTS_PER_SOL)));
    const { sqrtPrice, liquidity } = seed(d, spec.a, spec.b, wholeA);
    const [A, B] = [d.assets[spec.a], d.assets[spec.b]];
    const nft = Keypair.generate();
    await send([addPoolIx(
      vault, pk(A.mint), pk(A.tokenProgram), ata(admin.publicKey, pk(A.mint)),
      pk(B.mint), pk(B.tokenProgram), ata(admin.publicKey, pk(B.mint)), nft.publicKey,
      {
        liquidity, sqrtPrice, tradeFeeBps: TRADE_FEE_BPS, compoundingFeeBps: 8_000,
        seedShares: i === 0 ? BigInt(d.launch.seedShares) : 0n, targetWeightBps: weights[i],
      },
    )], [nft]);
    const addr = poolAddresses(pk(A.mint), pk(B.mint));
    const pos = positionAddresses(nft.publicKey);
    d.pools[i] = {
      label: spec.label, kind: spec.kind, pool: addr.pool.toBase58(), tokenAVault: addr.tokenAVault.toBase58(),
      tokenBVault: addr.tokenBVault.toBase58(), a: spec.a, b: spec.b, feeBps: TRADE_FEE_BPS,
      position: pos.position.toBase58(), positionNftAccount: pos.positionNftAccount.toBase58(),
    };
    writeDevnet(d);
    log(`vault pool ${spec.label}`, addr.pool.toBase58());
  }
}

async function addMarketPools(d: Devnet) {
  for (const [i, spec] of MARKET_POOLS.entries()) {
    if (d.marketPools[i]) continue;
    const { sqrtPrice, liquidity } = seed(d, spec.a, spec.b, spec.wholeA);
    const [A, B] = [d.assets[spec.a], d.assets[spec.b]];
    const nft = Keypair.generate();
    await send([createMarketPoolIx(
      admin.publicKey, pk(A.mint), pk(A.tokenProgram), ata(admin.publicKey, pk(A.mint)),
      pk(B.mint), pk(B.tokenProgram), ata(admin.publicKey, pk(B.mint)), nft.publicKey, liquidity, sqrtPrice, TRADE_FEE_BPS,
    )], [nft]);
    const addr = poolAddresses(pk(A.mint), pk(B.mint));
    d.marketPools[i] = {
      label: spec.label, kind: "market", pool: addr.pool.toBase58(), tokenAVault: addr.tokenAVault.toBase58(),
      tokenBVault: addr.tokenBVault.toBase58(), a: spec.a, b: spec.b, feeBps: TRADE_FEE_BPS,
    };
    writeDevnet(d);
    log(`market pool ${spec.label}`, addr.pool.toBase58());
  }
  if (!d.marketPools.some((p) => p.pool === SOL_USDC_POOL.pool)) {
    d.marketPools.push({ label: "SOL / USDC (market)", kind: "market", ...SOL_USDC_POOL, a: SOL, b: USDC });
    writeDevnet(d);
  }
}

/** The basket, with targets that match the pools' weights and the keeper's first prices. */
async function ensureBasket(d: Devnet) {
  const basket = basketAddress(pk(d.vault));
  if (!(await conn.getAccountInfo(basket))) {
    const s = await readState(d);
    await send([initBasketIx(d, DEFAULT_BASKET, basketWeights(d, s.weights)), setPricesIx(d, basketPrices(d, prices(d, s)))]);
    log("basket", basket.toBase58());
  }
  d.basket = basket.toBase58();
  writeDevnet(d);
}

/** Every vault-owned and fixed account, so deposits and redeems carry one byte per account. */
async function ensureLookupTable(d: Devnet) {
  const wanted = [
    STOCKWOVEN, CP_AMM, DAMM_POOL_AUTHORITY, DAMM_EVENT_AUTHORITY, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId,
    pk(d.vault), basketAddress(pk(d.vault)), pk(d.shareMint),
    ...d.assets.flatMap((a) => [pk(a.mint), pk(a.reserve), ata(pk(d.treasury), pk(a.mint))]),
    ...d.pools.flatMap((p) => [p.pool, p.position!, p.positionNftAccount!, p.tokenAVault, p.tokenBVault].map(pk)),
    ...d.marketPools.flatMap((p) => [p.pool, p.tokenAVault, p.tokenBVault].map(pk)),
  ];
  if (!d.lookupTable) {
    // The recent slot must still be in the SlotHashes sysvar.
    const [createIx, table] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey,
      payer: admin.publicKey,
      recentSlot: (await conn.getSlot("confirmed")) - 1,
    });
    await send([createIx]);
    d.lookupTable = table.toBase58();
    writeDevnet(d);
  }
  const table = pk(d.lookupTable);
  const current = (await conn.getAddressLookupTable(table)).value?.state.addresses ?? [];
  const missing = wanted.filter((a) => !current.some((c) => c.equals(a)));
  for (let i = 0; i < missing.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: admin.publicKey, payer: admin.publicKey, addresses: missing.slice(i, i + 20) })]);
  }
  log("lookup table", table.toBase58(), `(${current.length + missing.length} addresses, ${missing.length} added)`);
}

async function main() {
  log("admin", admin.publicKey.toBase58(), (await conn.getBalance(admin.publicKey)) / 1e9, "SOL");
  log("faucet", faucet.publicKey.toBase58(), (await conn.getBalance(faucet.publicKey)) / 1e9, "SOL");

  let d: Devnet;
  if (hasDevnet()) {
    d = readDevnet();
  } else {
    const vault = vaultAddress(TICKER);
    const solPrice = await solUsd();
    // One swSPCX ≈ one SpaceX share at launch: the seed shares match the vault's planned value.
    const planned = seededUsd(solPrice).reduce((a, b) => a + b, 0);
    d = {
      cluster: "devnet", program: STOCKWOVEN.toBase58(), stock: TICKER, vault: vault.toBase58(),
      shareMint: shareMintAddress(vault).toBase58(), admin: admin.publicKey.toBase58(), keeper: admin.publicKey.toBase58(),
      treasury: admin.publicKey.toBase58(), arbFeeBps: ARB_FEE_BPS, assets: await mintAndFund(), pools: [], marketPools: [],
      launch: { stockUsd: STOCK_USD, solUsd: solPrice, seedShares: BigInt(Math.floor((planned / STOCK_USD) * 10 ** SHARE_DECIMALS)).toString() },
    };
    writeDevnet(d);
    await fundAdmin(d);
  }

  if (!(await conn.getAccountInfo(pk(d.vault)))) {
    await send([initializeVaultIx(TICKER, pk(d.keeper), pk(d.treasury), ARB_FEE_BPS), ...d.assets.map((a) => addAssetIx(pk(d.vault), pk(a.mint), pk(a.tokenProgram)))]);
    log("vault", d.vault, "with", d.assets.length, "assets");
  }
  await addVaultPools(d);
  await addMarketPools(d);
  await ensureBasket(d);
  await ensureLookupTable(d);
  log("done. wrote", DEVNET_FILES.map(String).join(" and "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

