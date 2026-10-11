// Shared by the devnet scripts: keys, instruction builders for the Stockwoven vault and cp-amm,
// pool reads, prices and quotes. Account orders mirror programs/stockwoven/src/instructions/*.rs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const STOCKWOVEN = new PublicKey("H9ZJiWoKXGrje8Y3errCSh2uXUiNpf8mDmjJ7TapZm7b");
export const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
export const INITIALIZE_CUSTOMIZABLE_POOL = Buffer.from([20, 161, 241, 24, 189, 221, 180, 2]);
export const CP_AMM_SWAP = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;
export const SHARE_DECIMALS = 8;

export const conn = new Connection(RPC, "confirmed");

export function loadKeypair(path: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace("~", homedir()), "utf8"))));
}

/** The admin (upgrade authority, vault admin, keeper and treasury on devnet). */
export const admin = loadKeypair(process.env.KEYPAIR ?? "~/.config/solana/id.json");

// ---- devnet.json ----------------------------------------------------------------------------

export type AssetInfo = {
  symbol: string;
  name: string;
  issuer: string | null;
  kind: "stock" | "usdc" | "sol";
  mint: string;
  decimals: number;
  tokenProgram: string;
  reserve: string;
};

export type PoolInfo = {
  label: string;
  kind: "stock-stock" | "stock-usdc" | "stock-sol" | "sol-usdc" | "market";
  pool: string;
  tokenAVault: string;
  tokenBVault: string;
  a: number;
  b: number;
  feeBps: number;
  position?: string;
  positionNftAccount?: string;
};

export type Devnet = {
  cluster: "devnet";
  program: string;
  stock: string;
  vault: string;
  shareMint: string;
  admin: string;
  keeper: string;
  treasury: string;
  arbFeeBps: number;
  assets: AssetInfo[];
  pools: PoolInfo[];
  marketPools: PoolInfo[];
  lookupTable?: string;
  /** Single-token deposits and redemptions: ["basket", vault]. */
  basket?: string;
  launch: { stockUsd: number; solUsd: number; seedShares: string };
};

const here = (file: string) => new URL(file, import.meta.url);
/** Where the addresses live: scripts/devnet.json and the app's copy, or DEVNET_JSON alone (e.g. a local validator run). */
export const DEVNET_FILES: (URL | string)[] = process.env.DEVNET_JSON
  ? [process.env.DEVNET_JSON]
  : [here("./devnet.json"), here("../app/src/lib/devnet.json")];

export function readDevnet(): Devnet {
  return JSON.parse(readFileSync(DEVNET_FILES[0], "utf8"));
}

export function hasDevnet(): boolean {
  if (!existsSync(DEVNET_FILES[0])) return false;
  return "assets" in JSON.parse(readFileSync(DEVNET_FILES[0], "utf8"));
}

export function writeDevnet(d: Devnet) {
  for (const file of DEVNET_FILES) writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}

// ---- encoding -------------------------------------------------------------------------------

export const pk = (s: string) => new PublicKey(s);
export const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const u8 = (v: number) => Buffer.from([v]);
export const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
export const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
export const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
export const u128 = (v: bigint) => Buffer.concat([u64(v & ((1n << 64n) - 1n)), u64(v >> 64n)]);
export const vecU64 = (xs: bigint[]) => Buffer.concat([u32(xs.length), ...xs.map(u64)]);
export const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
export const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

export const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let [x0, x1] = [n / 2n + 1n, (n / 2n + 1n + n / (n / 2n + 1n)) / 2n];
  while (x1 < x0) [x0, x1] = [x1, (x1 + n / x1) / 2n];
  return x0;
};

export const stockSeed = (ticker: string) => Buffer.concat([Buffer.from(ticker), Buffer.alloc(8 - ticker.length)]);
export const vaultAddress = (ticker: string) => pda([Buffer.from("vault"), stockSeed(ticker)], STOCKWOVEN);
export const shareMintAddress = (vault: PublicKey) => pda([Buffer.from("shares"), vault.toBuffer()], STOCKWOVEN);
export const reserveAddress = (vault: PublicKey, mint: PublicKey) => pda([Buffer.from("reserve"), vault.toBuffer(), mint.toBuffer()], STOCKWOVEN);
export const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program);

/** cp-amm's customizable-pool accounts for two mints. */
export function poolAddresses(mintA: PublicKey, mintB: PublicKey) {
  const [hi, lo] = mintA.toBuffer().compare(mintB.toBuffer()) > 0 ? [mintA, mintB] : [mintB, mintA];
  const pool = pda([Buffer.from("cpool"), hi.toBuffer(), lo.toBuffer()], CP_AMM);
  return {
    pool,
    tokenAVault: pda([Buffer.from("token_vault"), mintA.toBuffer(), pool.toBuffer()], CP_AMM),
    tokenBVault: pda([Buffer.from("token_vault"), mintB.toBuffer(), pool.toBuffer()], CP_AMM),
  };
}

export function positionAddresses(nftMint: PublicKey) {
  return {
    position: pda([Buffer.from("position"), nftMint.toBuffer()], CP_AMM),
    positionNftAccount: pda([Buffer.from("position_nft_account"), nftMint.toBuffer()], CP_AMM),
  };
}

/** sqrt(raw B per raw A) in Q64.64 for whole-token prices in USD. */
export function sqrtPriceFor(usdA: number, decimalsA: number, usdB: number, decimalsB: number) {
  const raw = (usdA / usdB) * 10 ** (decimalsB - decimalsA);
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 64));
}

// ---- transactions ---------------------------------------------------------------------------

export async function lookupTable(d: Devnet): Promise<AddressLookupTableAccount[]> {
  if (!d.lookupTable) return [];
  const t = (await conn.getAddressLookupTable(pk(d.lookupTable))).value;
  return t ? [t] : [];
}

/** Sends a v0 transaction with the vault's lookup table. */
export async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], tables: AddressLookupTableAccount[] = [], units = 1_000_000) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs],
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${sig}: ${JSON.stringify(res.value.err)}`);
  return sig;
}

// ---- Stockwoven instructions ----------------------------------------------------------------

export function initializeVaultIx(ticker: string, keeper: PublicKey, treasury: PublicKey, arbFeeBps: number) {
  const vault = vaultAddress(ticker);
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("initialize_vault"), stockSeed(ticker), keeper.toBuffer(), treasury.toBuffer(), u16(arbFeeBps)]),
    keys: [w(admin.publicKey, true), w(vault), w(shareMintAddress(vault)), r(TOKEN_PROGRAM_ID), r(SystemProgram.programId)],
  });
}

export function addAssetIx(vault: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: disc("add_asset"),
    keys: [w(admin.publicKey, true), w(vault), r(mint), w(reserveAddress(vault, mint)), r(tokenProgram), r(SystemProgram.programId)],
  });
}

export type AddPoolArgs = {
  liquidity: bigint;
  sqrtPrice: bigint;
  tradeFeeBps: number;
  compoundingFeeBps: number;
  seedShares: bigint;
  targetWeightBps: number;
};

export function addPoolIx(
  vault: PublicKey,
  mintA: PublicKey, programA: PublicKey, adminA: PublicKey,
  mintB: PublicKey, programB: PublicKey, adminB: PublicKey,
  nftMint: PublicKey,
  args: AddPoolArgs,
  badges: PublicKey[] = [],
) {
  const shareMint = shareMintAddress(vault);
  const { pool, tokenAVault, tokenBVault } = poolAddresses(mintA, mintB);
  const { position, positionNftAccount } = positionAddresses(nftMint);
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([
      disc("add_pool"), u128(args.liquidity), u128(args.sqrtPrice), u16(args.tradeFeeBps), u16(args.compoundingFeeBps),
      u64(args.seedShares), u16(args.targetWeightBps),
    ]),
    keys: [
      w(admin.publicKey, true), w(vault), w(shareMint), w(ata(admin.publicKey, shareMint)), r(mintA), r(mintB), w(adminA), w(adminB),
      w(pool), w(nftMint, true), w(positionNftAccount), w(position), w(tokenAVault), w(tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(programA), r(programB), r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId), ...badges.map((b) => r(b)),
    ],
  });
}

/** Fixed accounts of `deposit` / `redeem`, then one group per asset and one per pool. */
function holderKeys(d: Devnet, user: PublicKey, userTokens: PublicKey[]) {
  const shareMint = pk(d.shareMint);
  return [
    r(user, true), r(pk(d.vault)), w(shareMint), w(ata(user, shareMint)), r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY),
    r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ...d.assets.flatMap((a, k) => [w(userTokens[k]), w(pk(a.reserve)), r(pk(a.mint))]),
    ...d.pools.flatMap((p) => [w(pk(p.pool)), w(pk(p.position!)), r(pk(p.positionNftAccount!)), w(pk(p.tokenAVault)), w(pk(p.tokenBVault))]),
  ];
}

export const userTokenAccounts = (d: Devnet, user: PublicKey) => d.assets.map((a) => ata(user, pk(a.mint), pk(a.tokenProgram)));

export function depositIx(d: Devnet, user: PublicKey, shares: bigint, maxAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("deposit"), u64(shares), vecU64(maxAmounts)]),
    keys: holderKeys(d, user, userTokenAccounts(d, user)),
  });
}

export function redeemIx(d: Devnet, user: PublicKey, shares: bigint, minAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("redeem"), u64(shares), vecU64(minAmounts)]),
    keys: holderKeys(d, user, userTokenAccounts(d, user)),
  });
}

/** `rebalance_remove`, `rebalance_add` or `harvest` on vault pool `index`. */
function vaultPoolIx(d: Devnet, index: number, caller: PublicKey, data: Buffer, reserveB?: PublicKey) {
  const p = d.pools[index];
  const [a, b] = [d.assets[p.a], d.assets[p.b]];
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data,
    keys: [
      r(caller, true), r(pk(d.vault)), w(pk(p.pool)), w(pk(p.position!)), r(pk(p.positionNftAccount!)), w(pk(p.tokenAVault)),
      w(pk(p.tokenBVault)), w(pk(a.reserve)), w(reserveB ?? pk(b.reserve)), r(pk(a.mint)), r(pk(b.mint)),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
    ],
  });
}

export const rebalanceRemoveIx = (d: Devnet, index: number, liquidity: bigint, minA = 0n, minB = 0n) =>
  vaultPoolIx(d, index, admin.publicKey, Buffer.concat([disc("rebalance_remove"), u8(index), u128(liquidity), u64(minA), u64(minB)]));

export const rebalanceAddIx = (d: Devnet, index: number, liquidity = 0n, maxA = 0n, maxB = 0n) =>
  vaultPoolIx(d, index, admin.publicKey, Buffer.concat([disc("rebalance_add"), u8(index), u128(liquidity), u64(maxA), u64(maxB)]));

export function harvestIx(d: Devnet, index: number, caller: PublicKey) {
  const b = d.assets[d.pools[index].b];
  const treasuryToken = ata(pk(d.treasury), pk(b.mint), pk(b.tokenProgram));
  return vaultPoolIx(d, index, caller, Buffer.concat([disc("harvest"), u8(index)]), treasuryToken);
}

export function vaultSwapIx(d: Devnet, p: PoolInfo, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [a, b] = [d.assets[p.a], d.assets[p.b]];
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("vault_swap"), u8(aToB ? 1 : 0), u64(amountIn), u64(minOut)]),
    keys: [
      r(admin.publicKey, true), r(pk(d.vault)), w(pk(p.pool)), w(pk(p.tokenAVault)), w(pk(p.tokenBVault)), w(pk(a.reserve)),
      w(pk(b.reserve)), r(pk(a.mint)), r(pk(b.mint)), r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
    ],
  });
}

export type Hop = { pool: PoolInfo; aToB: boolean };

export function arbitrageIx(d: Devnet, route: Hop[], amountIn: bigint, minProfit: bigint) {
  const start = d.assets[route[0].aToB ? route[0].pool.a : route[0].pool.b];
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("arbitrage"), u32(route.length), ...route.map((h) => u8(h.aToB ? 1 : 0)), u64(amountIn), u64(minProfit)]),
    keys: [
      r(admin.publicKey, true), r(pk(d.vault)), w(ata(pk(d.treasury), pk(start.mint), pk(start.tokenProgram))),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
      ...route.flatMap(({ pool: p }) => [
        w(pk(p.pool)), w(pk(p.tokenAVault)), w(pk(p.tokenBVault)), r(pk(d.assets[p.a].mint)), r(pk(d.assets[p.b].mint)),
        w(pk(d.assets[p.a].reserve)), w(pk(d.assets[p.b].reserve)),
      ]),
    ],
  });
}

export function setPoolWeightsIx(d: Devnet, weights: number[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("set_pool_weights"), u32(weights.length), ...weights.map(u16)]),
    keys: [r(admin.publicKey, true), w(pk(d.vault))],
  });
}

// ---- basket: single-token deposits and redemptions ------------------------------------------

export const basketAddress = (vault: PublicKey) => pda([Buffer.from("basket"), vault.toBuffer()], STOCKWOVEN);

/** One share of the stock, in the basket's value unit. */
export const NANO_SHARES = 1_000_000_000n;

export type BasketParams = {
  bandBps: number;
  baseFeeBps: number;
  feeSlopeBps: number;
  maxFeeBps: number;
  maxDiscountBps: number;
  maxPriceAge: number;
};

export type AssetWeights = { isStock: boolean; targetBps: number; maxBps: number };

export type BasketState = {
  params: BasketParams;
  assets: (AssetWeights & { price: bigint })[];
  pricesUpdatedAt: number;
};

/** 2% band, 5 bps plus 2 bps per point away from target, at most 1%, at best a 3 bps discount. */
export const DEFAULT_BASKET: BasketParams = { bandBps: 200, baseFeeBps: 5, feeSlopeBps: 2, maxFeeBps: 100, maxDiscountBps: 3, maxPriceAge: 600 };

const basketArgs = (p: BasketParams, weights: AssetWeights[]) =>
  Buffer.concat([
    u16(p.bandBps), u16(p.baseFeeBps), u16(p.feeSlopeBps), u16(p.maxFeeBps), u16(p.maxDiscountBps), u32(p.maxPriceAge),
    u32(weights.length), ...weights.map((x) => Buffer.concat([u8(x.isStock ? 1 : 0), u16(x.targetBps), u16(x.maxBps)])),
  ]);

export function initBasketIx(d: Devnet, params: BasketParams, weights: AssetWeights[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("init_basket"), basketArgs(params, weights)]),
    keys: [w(admin.publicKey, true), r(pk(d.vault)), w(basketAddress(pk(d.vault))), r(SystemProgram.programId)],
  });
}

export function setBasketIx(d: Devnet, params: BasketParams, weights: AssetWeights[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("set_basket"), basketArgs(params, weights)]),
    keys: [r(admin.publicKey, true), r(pk(d.vault)), w(basketAddress(pk(d.vault)))],
  });
}

/** Keeper: nano-shares of the stock per whole token, one per asset. */
export function setPricesIx(d: Devnet, prices: bigint[]) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("set_prices"), vecU64(prices)]),
    keys: [r(admin.publicKey, true), r(pk(d.vault)), w(basketAddress(pk(d.vault)))],
  });
}

/** Basket account: 8 discriminator, vault 32, bump 1, params 14, num_assets 1, 6 × 13 per asset, updated_at 8. */
export function decodeBasket(data: Buffer, numAssets: number): BasketState {
  const params: BasketParams = {
    bandBps: data.readUInt16LE(41),
    baseFeeBps: data.readUInt16LE(43),
    feeSlopeBps: data.readUInt16LE(45),
    maxFeeBps: data.readUInt16LE(47),
    maxDiscountBps: data.readUInt16LE(49),
    maxPriceAge: data.readUInt32LE(51),
  };
  const assets = Array.from({ length: numAssets }, (_, k) => {
    const o = 56 + k * 13;
    return { isStock: data[o] === 1, targetBps: data.readUInt16LE(o + 1), maxBps: data.readUInt16LE(o + 3), price: data.readBigUInt64LE(o + 5) };
  });
  return { params, assets, pricesUpdatedAt: Number(data.readBigInt64LE(56 + 6 * 13)) };
}

export async function readBasket(d: Devnet): Promise<BasketState | null> {
  const info = await conn.getAccountInfo(basketAddress(pk(d.vault)));
  return info ? decodeBasket(Buffer.from(info.data), d.assets.length) : null;
}

/** Cap per issuer token: no issuer above 40% of the vault. USDC and SOL are uncapped. */
export const ISSUER_CAP_BPS = 4_000;

/**
 * Per-asset targets implied by the pools' target weights: a full-range pool holds half its value
 * in each token. Keeping the basket's targets in line with the pools stops the dynamic fee from
 * pulling against the keeper's rebalancing. A target is never above its token's cap.
 */
export function basketWeights(d: Devnet, poolWeights: number[]): AssetWeights[] {
  const targets = d.assets.map(() => 0);
  d.pools.forEach((p, i) => {
    targets[p.a] += poolWeights[i] / 2;
    targets[p.b] += poolWeights[i] / 2;
  });
  return d.assets.map((a, k) => {
    const maxBps = a.kind === "stock" ? ISSUER_CAP_BPS : 10_000;
    return { isStock: a.kind === "stock", targetBps: Math.min(Math.floor(targets[k]), maxBps), maxBps };
  });
}

/** USD per one share of the stock: the median of the issuer tokens' USD prices. */
export function stockUsd(d: Devnet, px: number[]) {
  const stocks = d.assets.map((a, k) => (a.kind === "stock" ? px[k] : 0)).filter((x) => x > 0).sort((a, b) => a - b);
  return stocks.length ? stocks[Math.floor((stocks.length - 1) / 2)] : 0;
}

/** The keeper's prices for `set_prices`: each asset's USD price in nano-shares of the stock. */
export function basketPrices(d: Devnet, px: number[]): bigint[] {
  const share = stockUsd(d, px);
  return px.map((usd) => BigInt(Math.max(1, Math.round((usd / share) * 1e9))));
}

/** Fixed accounts of `deposit_single` / `redeem_single`, then (reserve, mint) per asset, the pools, and an optional conversion pool. */
function singleKeys(d: Devnet, user: PublicKey, asset: number, convert?: PoolInfo) {
  const shareMint = pk(d.shareMint);
  const a = d.assets[asset];
  return [
    r(user, true), r(pk(d.vault)), r(basketAddress(pk(d.vault))), w(shareMint), w(ata(user, shareMint)),
    w(ata(user, pk(a.mint), pk(a.tokenProgram))), r(pk(a.mint)), r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ...d.assets.flatMap((x) => [w(pk(x.reserve)), r(pk(x.mint))]),
    ...d.pools.flatMap((p) => [w(pk(p.pool)), w(pk(p.position!)), r(pk(p.positionNftAccount!)), w(pk(p.tokenAVault)), w(pk(p.tokenBVault))]),
    ...(convert
      ? [w(pk(convert.pool)), w(pk(convert.tokenAVault)), w(pk(convert.tokenBVault)), r(pk(d.assets[convert.a].mint)), r(pk(d.assets[convert.b].mint))]
      : []),
  ];
}

/** Deposits `amountIn` of one asset; with `convert`, the vault first swaps it on that pool into an underweight issuer token. */
export function depositSingleIx(d: Devnet, user: PublicKey, asset: number, amountIn: bigint, minShares: bigint, convert?: PoolInfo) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("deposit_single"), u64(amountIn), u64(minShares)]),
    keys: singleKeys(d, user, asset, convert),
  });
}

export function redeemSingleIx(d: Devnet, user: PublicKey, asset: number, shares: bigint, minAmount: bigint) {
  return new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("redeem_single"), u64(shares), u64(minAmount)]),
    keys: singleKeys(d, user, asset),
  });
}

// ---- cp-amm ---------------------------------------------------------------------------------

/** A full-range compounding pool created directly on cp-amm by `creator` (a market pool). */
export function createMarketPoolIx(
  creator: PublicKey,
  mintA: PublicKey, programA: PublicKey, payerA: PublicKey,
  mintB: PublicKey, programB: PublicKey, payerB: PublicKey,
  nftMint: PublicKey,
  liquidity: bigint, sqrtPrice: bigint, tradeFeeBps: number,
) {
  const { pool, tokenAVault, tokenBVault } = poolAddresses(mintA, mintB);
  const { position, positionNftAccount } = positionAddresses(nftMint);
  const baseFee = Buffer.alloc(27);
  baseFee.writeBigUInt64LE(BigInt(tradeFeeBps) * 100_000n);
  const params = Buffer.concat([
    baseFee, u16(8_000), u8(0), u8(0), u128(MIN_SQRT_PRICE), u128(MAX_SQRT_PRICE), u8(0),
    u128(liquidity), u128(sqrtPrice), Buffer.from([1, 2, 0]),
  ]);
  return new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([INITIALIZE_CUSTOMIZABLE_POOL, params]),
    keys: [
      r(creator), w(nftMint, true), w(positionNftAccount), w(creator, true), r(DAMM_POOL_AUTHORITY), w(pool), w(position),
      r(mintA), r(mintB), w(tokenAVault), w(tokenBVault), w(payerA), w(payerB), r(programA), r(programB),
      r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

/** A direct swap on any cp-amm pool, from `input` to `output` token accounts of `user`. */
export function poolSwapIx(d: Devnet, p: PoolInfo, user: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [a, b] = [d.assets[p.a], d.assets[p.b]];
  const [ua, ub] = [ata(user, pk(a.mint), pk(a.tokenProgram)), ata(user, pk(b.mint), pk(b.tokenProgram))];
  const [input, output] = aToB ? [ua, ub] : [ub, ua];
  return new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([CP_AMM_SWAP, u64(amountIn), u64(minOut)]),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(pk(p.pool)), w(input), w(output), w(pk(p.tokenAVault)), w(pk(p.tokenBVault)),
      r(pk(a.mint)), r(pk(b.mint)), r(user, true), r(pk(a.tokenProgram)), r(pk(b.tokenProgram)),
      r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

// ---- state ----------------------------------------------------------------------------------

export type PoolState = { liquidity: bigint; reserveA: bigint; reserveB: bigint };

const readU128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export type VaultState = {
  supply: bigint;
  reserves: bigint[];
  pools: (PoolState & { position: bigint })[];
  market: PoolState[];
  weights: number[];
};

/** Vault weights live in the Vault account: 8 discriminator + fixed fields, then the arrays. */
function vaultWeights(data: Buffer, numPools: number) {
  // admin, keeper, treasury (96) + stock (8) + share_mint (32) + arb_fee (2) + paused (1) + bump (1)
  const assetsStart = 8 + 96 + 8 + 32 + 2 + 1 + 1 + 1;
  const poolsStart = assetsStart + 6 * 97 + 1;
  const weights: number[] = [];
  for (let i = 0; i < numPools; i++) weights.push(data.readUInt16LE(poolsStart + i * 164 + 162));
  return weights;
}

export async function readState(d: Devnet): Promise<VaultState> {
  const keys = [
    pk(d.vault), pk(d.shareMint),
    ...d.assets.map((a) => pk(a.reserve)),
    ...d.pools.flatMap((p) => [pk(p.pool), pk(p.position!)]),
    ...d.marketPools.map((p) => pk(p.pool)),
  ];
  const infos = await conn.getMultipleAccountsInfo(keys);
  const data = infos.map((i) => (i ? Buffer.from(i.data) : null));
  let k = 0;
  const vault = data[k++]!;
  const supply = data[k++]!.readBigUInt64LE(36);
  const reserves = d.assets.map(() => data[k++]!.readBigUInt64LE(64));
  const poolOf = (b: Buffer): PoolState => ({ liquidity: readU128(b, 360), reserveA: b.readBigUInt64LE(680), reserveB: b.readBigUInt64LE(688) });
  const pools = d.pools.map(() => {
    const p = poolOf(data[k++]!);
    return { ...p, position: readU128(data[k++]!, 152) };
  });
  const market = d.marketPools.map(() => poolOf(data[k++]!));
  return { supply, reserves, pools, market, weights: vaultWeights(vault, d.pools.length) };
}

/** x·y = k with the pool's fee, charged in token B: on output for A→B, on input for B→A. */
export function quoteSwap(p: PoolState, feeBps: number, aToB: boolean, amountIn: bigint) {
  const fee = (x: bigint) => (x * BigInt(feeBps)) / 10_000n;
  if (aToB) {
    const gross = (p.reserveB * amountIn) / (p.reserveA + amountIn);
    return gross - fee(gross);
  }
  const net = amountIn - fee(amountIn);
  return (p.reserveA * net) / (p.reserveB + net);
}

/**
 * USD per whole token of each asset, read outward from USDC = 1. Each step prices one more asset
 * from the pool, among those pairing it with an already-priced asset, that holds the most USD on
 * its priced side, so thin pools never set a price a deep one disagrees with.
 */
export function prices(d: Devnet, s: VaultState): number[] {
  const all = [...d.pools.map((p, i) => ({ info: p, state: s.pools[i] })), ...d.marketPools.map((p, i) => ({ info: p, state: s.market[i] }))];
  const usd: (number | undefined)[] = d.assets.map((a) => (a.kind === "usdc" ? 1 : undefined));
  for (;;) {
    let best: { k: number; price: number; depth: number } | null = null;
    for (const { info, state } of all) {
      if (state.reserveA === 0n || state.reserveB === 0n) continue;
      const [wa, wb] = [Number(state.reserveA) / 10 ** d.assets[info.a].decimals, Number(state.reserveB) / 10 ** d.assets[info.b].decimals];
      if (usd[info.a] === undefined && usd[info.b] !== undefined) {
        const depth = wb * usd[info.b]!;
        if (!best || depth > best.depth) best = { k: info.a, price: (wb / wa) * usd[info.b]!, depth };
      }
      if (usd[info.b] === undefined && usd[info.a] !== undefined) {
        const depth = wa * usd[info.a]!;
        if (!best || depth > best.depth) best = { k: info.b, price: (wa / wb) * usd[info.a]!, depth };
      }
    }
    if (!best) break;
    usd[best.k] = best.price;
  }
  return usd.map((x) => x ?? 0);
}

/** USD value of raw amounts per asset. */
export const valueOf = (d: Devnet, px: number[], amounts: bigint[]) =>
  amounts.reduce((sum, x, k) => sum + (Number(x) / 10 ** d.assets[k].decimals) * px[k], 0);

/** Raw amounts behind the vault's position in each pool. */
export function positionAmounts(s: VaultState, i: number) {
  const p = s.pools[i];
  return { a: (p.reserveA * p.position) / p.liquidity, b: (p.reserveB * p.position) / p.liquidity };
}

/** Everything the vault holds, per asset: positions plus idle reserves. */
export function holdings(d: Devnet, s: VaultState) {
  const out = [...s.reserves];
  d.pools.forEach((p, i) => {
    const { a, b } = positionAmounts(s, i);
    out[p.a] += a;
    out[p.b] += b;
  });
  return out;
}
