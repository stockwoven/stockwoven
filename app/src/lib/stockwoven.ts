// Client for the swSPCX vault on devnet: addresses, instruction builders, state reads, prices,
// quotes and the one-token routes. Account orders mirror programs/stockwoven/src/instructions/*.rs.
//
// One swSPCX is a pro-rata claim on everything the vault holds: its liquidity in each of its
// Meteora DAMM v2 pools (stock–stock, stock–USDC, stock–SOL) and the idle balance of each reserve.

import { Buffer } from "buffer";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import devnet from "./devnet.json";
import {
  Basket,
  Refusal,
  basketAddress,
  breaker,
  decodeBasket,
  describeRefusal,
  marginalFeeBps,
  pegged,
  planRedeemTo,
  planSingleDeposit,
  planSingleRedeem,
  valueBook,
} from "./basket";

export const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

export const SHARE_DECIMALS = 8;
/** Share of each pool fee that compounds for holders: 80% of the LP fee, after Meteora's 20%. */
export const HOLDERS_FEE_PCT = 64;
export const PROTOCOL_FEE_PCT = 16;
export const METEORA_FEE_PCT = 20;

export type AssetKind = "stock" | "usdc" | "sol";

export type Asset = {
  symbol: string;
  name: string;
  issuer: string | null;
  kind: AssetKind;
  mint: PublicKey;
  decimals: number;
  tokenProgram: PublicKey;
  reserve: PublicKey;
};

export type PoolKind = "stock-stock" | "stock-usdc" | "stock-sol" | "sol-usdc" | "market";

export type Pool = {
  label: string;
  kind: PoolKind;
  pool: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  /** Indexes into ASSETS. */
  a: number;
  b: number;
  feeBps: number;
  /** Only the vault's own pools have a position. */
  position?: PublicKey;
  positionNftAccount?: PublicKey;
  vault: boolean;
};

const pk = (s: string) => new PublicKey(s);

export const ASSETS: Asset[] = devnet.assets.map((a) => ({
  symbol: a.symbol,
  name: a.name,
  issuer: a.issuer,
  kind: a.kind as AssetKind,
  mint: pk(a.mint),
  decimals: a.decimals,
  tokenProgram: pk(a.tokenProgram),
  reserve: pk(a.reserve),
}));

type PoolJson = (typeof devnet.pools)[number] | (typeof devnet.marketPools)[number];
const toPool = (p: PoolJson, vault: boolean): Pool => ({
  label: p.label,
  kind: p.kind as PoolKind,
  pool: pk(p.pool),
  tokenAVault: pk(p.tokenAVault),
  tokenBVault: pk(p.tokenBVault),
  a: p.a,
  b: p.b,
  feeBps: p.feeBps,
  position: "position" in p && p.position ? pk(p.position) : undefined,
  positionNftAccount: "positionNftAccount" in p && p.positionNftAccount ? pk(p.positionNftAccount) : undefined,
  vault,
});

/** The vault's own pools, in the vault's order. */
export const POOLS: Pool[] = devnet.pools.map((p) => toPool(p, true));
/** Pools other LPs own on mainnet; the keeper arbitrages against them and routes can use them. */
export const MARKET_POOLS: Pool[] = devnet.marketPools.map((p) => toPool(p, false));
export const ALL_POOLS = [...POOLS, ...MARKET_POOLS];

export const VAULT = {
  program: pk(devnet.program),
  stock: devnet.stock,
  vault: pk(devnet.vault),
  shareMint: pk(devnet.shareMint),
  treasury: pk(devnet.treasury),
  keeper: pk(devnet.keeper),
  arbFeeBps: devnet.arbFeeBps,
  lookupTable: devnet.lookupTable ? pk(devnet.lookupTable) : null,
  /** USD value of one swSPCX when the vault launched. */
  launchUsdPerShare: devnet.launch.stockUsd,
};

export const USDC = ASSETS.findIndex((a) => a.kind === "usdc");
export const SOL = ASSETS.findIndex((a) => a.kind === "sol");

// ---- encoding -------------------------------------------------------------------------------

const DISC = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  harvest: [228, 241, 31, 182, 53, 169, 59, 199],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  depositSingle: [116, 81, 213, 110, 17, 83, 209, 188],
  redeemSingle: [99, 237, 186, 22, 18, 172, 251, 95],
};

/** The basket account: weights, caps, fees and the keeper's prices for single-token trades. */
export const BASKET = basketAddress(VAULT.program, VAULT.vault);

const u8 = (v: number) => Buffer.from([v]);
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const vecU64 = (xs: bigint[]) => Buffer.concat([u32(xs.length), ...xs.map(u64)]);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program);
export const assetAccount = (owner: PublicKey, k: number) => ata(owner, ASSETS[k].mint, ASSETS[k].tokenProgram);

/**
 * Creates the wallet's account for every vault asset and for swSPCX. `exists` (one flag per asset,
 * then swSPCX) skips the ones already open, which keeps the transaction small.
 */
export function ensureAccountsIxs(user: PublicKey, exists: boolean[] = []): TransactionInstruction[] {
  const mints = [...ASSETS.map((a) => ({ mint: a.mint, program: a.tokenProgram })), { mint: VAULT.shareMint, program: TOKEN_PROGRAM_ID }];
  return mints
    .filter((_, i) => !exists[i])
    .map(({ mint, program }) => createAssociatedTokenAccountIdempotentInstruction(user, ata(user, mint, program), user, mint, program));
}

/** Fixed accounts of `deposit` / `redeem`, then one group per asset and one per pool. */
function holderKeys(user: PublicKey) {
  return [
    r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)), r(DAMM_POOL_AUTHORITY),
    r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ...ASSETS.flatMap((a, k) => [w(assetAccount(user, k)), w(a.reserve), r(a.mint)]),
    ...POOLS.flatMap((p) => [w(p.pool), w(p.position!), r(p.positionNftAccount!), w(p.tokenAVault), w(p.tokenBVault)]),
  ];
}

export function depositIx(user: PublicKey, shares: bigint, maxAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.deposit), u64(shares), vecU64(maxAmounts)]),
    keys: holderKeys(user),
  });
}

export function redeemIx(user: PublicKey, shares: bigint, minAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.redeem), u64(shares), vecU64(minAmounts)]),
    keys: holderKeys(user),
  });
}

/**
 * Fixed accounts of `deposit_single` / `redeem_single` for asset `k`, then (reserve, mint) per
 * asset, the vault pools, and the optional conversion pool.
 */
function singleKeys(user: PublicKey, k: number, convert?: Pool) {
  const keys = [
    r(user, true), r(VAULT.vault), r(BASKET), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
    w(assetAccount(user, k)), r(ASSETS[k].mint), r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ...ASSETS.flatMap((a) => [w(a.reserve), r(a.mint)]),
    ...POOLS.flatMap((p) => [w(p.pool), w(p.position!), r(p.positionNftAccount!), w(p.tokenAVault), w(p.tokenBVault)]),
  ];
  if (convert) keys.push(w(convert.pool), w(convert.tokenAVault), w(convert.tokenBVault), r(ASSETS[convert.a].mint), r(ASSETS[convert.b].mint));
  return keys;
}

/** Deposits `amountIn` of asset `k` alone; with `convert`, the vault first swaps it on that pool. */
export function depositSingleIx(user: PublicKey, k: number, amountIn: bigint, minShares: bigint, convert?: Pool) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.depositSingle), u64(amountIn), u64(minShares)]),
    keys: singleKeys(user, k, convert),
  });
}

/** Burns `shares` for issuer token `k` alone, paying at least `minAmount`. */
export function redeemSingleIx(user: PublicKey, k: number, shares: bigint, minAmount: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.redeemSingle), u64(shares), u64(minAmount)]),
    keys: singleKeys(user, k),
  });
}

/** Permissionless: sends pool `index`'s claimable fee (the protocol's cut) to the treasury. */
export function harvestIx(caller: PublicKey, index: number) {
  const p = POOLS[index];
  const [a, b] = [ASSETS[p.a], ASSETS[p.b]];
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.harvest), u8(index)]),
    keys: [
      r(caller, true), r(VAULT.vault), w(p.pool), w(p.position!), r(p.positionNftAccount!), w(p.tokenAVault), w(p.tokenBVault),
      w(a.reserve), w(ata(VAULT.treasury, b.mint, b.tokenProgram)), r(a.mint), r(b.mint),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
    ],
  });
}

/**
 * Opens the treasury's account for each pool's fee token where it is missing; `payer` pays the
 * rent. Harvest pays into them, and a wSOL account closes whenever its owner unwraps.
 */
export function treasuryAccountIxs(payer: PublicKey): TransactionInstruction[] {
  return [...new Set(POOLS.map((p) => p.b))].map((k) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(VAULT.treasury, ASSETS[k].mint, ASSETS[k].tokenProgram), VAULT.treasury, ASSETS[k].mint, ASSETS[k].tokenProgram),
  );
}

/** A swap on any cp-amm pool, between the wallet's two token accounts. */
export function poolSwapIx(p: Pool, user: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [ua, ub] = [assetAccount(user, p.a), assetAccount(user, p.b)];
  const [input, output] = aToB ? [ua, ub] : [ub, ua];
  return new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([Buffer.from(DISC.swap), u64(amountIn), u64(minOut)]),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(p.pool), w(input), w(output), w(p.tokenAVault), w(p.tokenBVault),
      r(ASSETS[p.a].mint), r(ASSETS[p.b].mint), r(user, true), r(ASSETS[p.a].tokenProgram), r(ASSETS[p.b].tokenProgram),
      r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

/** Wraps `lamports` of SOL into the wallet's wSOL account. */
export function wrapSolIxs(user: PublicKey, lamports: bigint) {
  const wsol = ata(user, NATIVE_MINT);
  return [SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports }), createSyncNativeInstruction(wsol)];
}

/** Closes the wallet's wSOL account, returning every wSOL in it (and its rent) as SOL. */
export const unwrapSolIx = (user: PublicKey) => createCloseAccountInstruction(ata(user, NATIVE_MINT), user, user);

// ---- state ----------------------------------------------------------------------------------

export type PoolState = { liquidity: bigint; reserveA: bigint; reserveB: bigint };

export type VaultState = {
  supply: bigint;
  /** Idle balance of each reserve, per asset. */
  reserves: bigint[];
  /** The vault's pools, with the vault's position liquidity. */
  pools: (PoolState & { position: bigint })[];
  market: PoolState[];
  /** Target weight per vault pool, in basis points. */
  weights: number[];
  depositsPaused: boolean;
  /** Weights, caps, fees and the keeper's prices for single-token trades; null before the vault has a basket. */
  basket?: Basket | null;
};

const u128 = (d: Buffer, offset: number) => d.readBigUInt64LE(offset) + (d.readBigUInt64LE(offset + 8) << 64n);
const poolOf = (d: Buffer): PoolState => ({ liquidity: u128(d, 360), reserveA: d.readBigUInt64LE(680), reserveB: d.readBigUInt64LE(688) });

// Vault account layout: 8-byte discriminator, admin/keeper/treasury, stock, share mint,
// arb_fee_bps, deposits_paused, bump, num_assets, 6 assets of 97 bytes, num_pools, 6 pools of 164.
const PAUSED_OFFSET = 8 + 96 + 8 + 32 + 2;
const POOLS_OFFSET = PAUSED_OFFSET + 1 + 1 + 1 + 6 * 97 + 1;

/** Reads the vault, its share mint, reserves, pools and positions, and the market pools in one call. */
export async function fetchVaultState(conn: Connection): Promise<VaultState> {
  const keys = [
    VAULT.vault, VAULT.shareMint,
    ...ASSETS.map((a) => a.reserve),
    ...POOLS.flatMap((p) => [p.pool, p.position!]),
    ...MARKET_POOLS.map((p) => p.pool),
    BASKET,
  ];
  const infos = await conn.getMultipleAccountsInfo(keys);
  const data = infos.map((i) => (i ? Buffer.from(i.data) : null));
  if (!data[0] || !data[1]) throw new Error("vault not found");
  let k = 2;
  const reserves = ASSETS.map(() => data[k++]?.readBigUInt64LE(64) ?? 0n);
  const pools = POOLS.map(() => {
    const pool = data[k++];
    const position = data[k++];
    if (!pool || !position) throw new Error("vault pool not found");
    return { ...poolOf(pool), position: u128(position, 152) };
  });
  const market = MARKET_POOLS.map(() => {
    const d = data[k++];
    return d ? poolOf(d) : { liquidity: 0n, reserveA: 0n, reserveB: 0n };
  });
  const basket = data[k++];
  return {
    basket: basket ? decodeBasket(basket) : null,
    supply: data[1].readBigUInt64LE(36),
    reserves,
    pools,
    market,
    weights: POOLS.map((_, i) => data[0]!.readUInt16LE(POOLS_OFFSET + i * 164 + 162)),
    depositsPaused: data[0][PAUSED_OFFSET] === 1,
  };
}

const poolStates = (s: VaultState): PoolState[] => [...s.pools, ...s.market];

// ---- prices and value -----------------------------------------------------------------------

/**
 * USD per whole token of each asset, read outward from USDC = 1. Each step prices one more asset
 * from the pool, among those pairing it with an already-priced asset, that holds the most USD on
 * its priced side, so thin pools never set a price a deep one disagrees with.
 */
export function prices(s: VaultState): number[] {
  const states = poolStates(s);
  const usd: (number | undefined)[] = ASSETS.map((a) => (a.kind === "usdc" ? 1 : undefined));
  for (;;) {
    let best: { k: number; price: number; depth: number } | null = null;
    ALL_POOLS.forEach((p, i) => {
      const st = states[i];
      if (st.reserveA === 0n || st.reserveB === 0n) return;
      const [wa, wb] = [whole(st.reserveA, p.a), whole(st.reserveB, p.b)];
      if (usd[p.a] === undefined && usd[p.b] !== undefined && (!best || wb * usd[p.b]! > best.depth)) {
        best = { k: p.a, price: (wb / wa) * usd[p.b]!, depth: wb * usd[p.b]! };
      }
      if (usd[p.b] === undefined && usd[p.a] !== undefined && (!best || wa * usd[p.a]! > best.depth)) {
        best = { k: p.b, price: (wa / wb) * usd[p.a]!, depth: wa * usd[p.a]! };
      }
    });
    if (!best) break;
    const found: { k: number; price: number } = best;
    usd[found.k] = found.price;
  }
  return usd.map((x) => x ?? 0);
}

export const whole = (raw: bigint, k: number) => Number(raw) / 10 ** ASSETS[k].decimals;
export const usdOf = (amounts: bigint[], px: number[]) => amounts.reduce((sum, x, k) => sum + whole(x, k) * px[k], 0);

/** Raw amounts behind the vault's position in pool `i`. */
export function positionAmounts(s: VaultState, i: number) {
  const p = s.pools[i];
  if (p.liquidity === 0n) return { a: 0n, b: 0n };
  return { a: (p.reserveA * p.position) / p.liquidity, b: (p.reserveB * p.position) / p.liquidity };
}

/** Everything the vault holds, per asset: its positions plus the idle reserves. */
export function holdings(s: VaultState) {
  const out = [...s.reserves];
  POOLS.forEach((p, i) => {
    const { a, b } = positionAmounts(s, i);
    out[p.a] += a;
    out[p.b] += b;
  });
  return out;
}

export function poolValue(s: VaultState, px: number[], i: number) {
  const { a, b } = positionAmounts(s, i);
  return whole(a, POOLS[i].a) * px[POOLS[i].a] + whole(b, POOLS[i].b) * px[POOLS[i].b];
}

/** USD value of the whole vault and of one swSPCX. */
export function vaultValue(s: VaultState) {
  const px = prices(s);
  const total = usdOf(holdings(s), px);
  const perShare = s.supply > 0n ? (total / Number(s.supply)) * 10 ** SHARE_DECIMALS : 0;
  return { px, total, perShare };
}

/** Share of the vault's value in SpaceX tokens, USDC and SOL. */
export function exposure(s: VaultState) {
  const px = prices(s);
  const h = holdings(s);
  const total = usdOf(h, px) || 1;
  const by = (kind: AssetKind) => ASSETS.reduce((sum, a, k) => sum + (a.kind === kind ? whole(h[k], k) * px[k] : 0), 0) / total;
  return { stock: by("stock"), usdc: by("usdc"), sol: by("sol") };
}

// ---- quotes ---------------------------------------------------------------------------------

/**
 * Tokens the program moves for `shares`, per asset, with its rounding: liquidity per share is
 * rounded up on deposit (down on redeem), cp-amm rounds the amounts it pulls up (pays down), and
 * the idle slice is rounded the same way.
 */
export function quoteShares(s: VaultState, shares: bigint, deposit: boolean): bigint[] {
  if (s.supply === 0n) return ASSETS.map(() => 0n);
  const div = deposit ? ceilDiv : (a: bigint, b: bigint) => a / b;
  const out = s.reserves.map((x) => div(shares * x, s.supply));
  POOLS.forEach((p, i) => {
    const st = s.pools[i];
    const perShare = deposit ? ceilDiv(st.position, s.supply) : st.position / s.supply;
    const dl = perShare * shares;
    if (dl === 0n || st.liquidity === 0n) return;
    out[p.a] += div(dl * st.reserveA, st.liquidity);
    out[p.b] += div(dl * st.reserveB, st.liquidity);
  });
  return out;
}

/** The most shares the given amounts pay for, at the given state. */
export function sharesFor(s: VaultState, amounts: bigint[]) {
  if (s.supply === 0n) return 0n;
  const h = holdings(s);
  let hi = 0n;
  ASSETS.forEach((_, k) => {
    if (h[k] === 0n) return;
    const bound = (amounts[k] * s.supply) / h[k] + 1n;
    hi = hi === 0n || bound < hi ? bound : hi;
  });
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const need = quoteShares(s, mid, true);
    if (need.every((x, k) => x <= amounts[k])) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * x·y = k with the pool's fee, charged in token B: on output for A→B, on input for B→A. The fee
 * rounds up, as cp-amm does, which matters on tiny swaps.
 */
export function quoteSwap(st: PoolState, feeBps: number, aToB: boolean, amountIn: bigint) {
  if (amountIn <= 0n || st.reserveA === 0n || st.reserveB === 0n) return 0n;
  const fee = (x: bigint) => ceilDiv(x * BigInt(feeBps), 10_000n);
  if (aToB) {
    const gross = (st.reserveB * amountIn) / (st.reserveA + amountIn);
    return gross - fee(gross);
  }
  const net = amountIn - fee(amountIn);
  return (st.reserveA * net) / (st.reserveB + net);
}

export type Hop = { pool: Pool; index: number; aToB: boolean };
export type Route = { hops: Hop[]; amountIn: bigint; out: bigint };

/** Applies a swap to a copy of the pool states, so later quotes see its price impact. */
function applySwap(states: PoolState[], hop: Hop, amountIn: bigint, out: bigint) {
  const st = { ...states[hop.index] };
  if (hop.aToB) {
    st.reserveA += amountIn;
    st.reserveB -= out;
  } else {
    st.reserveB += amountIn;
    st.reserveA -= out;
  }
  states[hop.index] = st;
}

/** The best route of 1 or 2 hops from asset `from` to asset `to` across every pool. */
export function bestRoute(states: PoolState[], from: number, to: number, amountIn: bigint): Route | null {
  const hopsFrom = (k: number) =>
    ALL_POOLS.flatMap((pool, index): Hop[] => (pool.a === k ? [{ pool, index, aToB: true }] : pool.b === k ? [{ pool, index, aToB: false }] : []));
  const target = (h: Hop) => (h.aToB ? h.pool.b : h.pool.a);
  const run = (hops: Hop[]) => hops.reduce((x, h) => quoteSwap(states[h.index], h.pool.feeBps, h.aToB, x), amountIn);
  let best: Route | null = null;
  for (const h1 of hopsFrom(from)) {
    const mid = target(h1);
    const candidates = mid === to ? [[h1]] : hopsFrom(mid).filter((h2) => h2.index !== h1.index && target(h2) === to).map((h2) => [h1, h2]);
    for (const hops of candidates) {
      const out = run(hops);
      if (out > 0n && (!best || out > best.out)) best = { hops, amountIn, out };
    }
  }
  return best;
}

/** Each swap in a one-token route keeps this much below its quote; the deposit is sized on the minimums. */
export const ROUTE_SLIPPAGE_BPS = 50n;
/** Slices worth less than this are not swapped: integer rounding makes dust swaps fail their limits. */
const MIN_SWAP_USD = 0.05;
const minOf = (x: bigint) => (x * (10_000n - ROUTE_SLIPPAGE_BPS)) / 10_000n;

export type Swap = { pool: Pool; aToB: boolean; amountIn: bigint; minOut: bigint };

export type ZapQuote = {
  input: number;
  amountIn: bigint;
  /** Swaps from the input into each other asset, in order. */
  swaps: Swap[];
  /** The deposit: the most it may take of each asset, and the shares it mints. */
  maxAmounts: bigint[];
  /**
   * Slices too small to swap, which the wallet pays directly from what it already holds (for SOL,
   * the app wraps it). Zero for the rest.
   */
  fromWallet: bigint[];
  shares: bigint;
  /** USD value of the input and of the shares at the vault's value per share. */
  usdIn: number;
  usdOut: number;
};

/**
 * Pays for a deposit with one asset: splits `amountIn` across the vault's assets by their share
 * of its value, buys each through its best route (simulating each swap's price impact on the
 * pools that follow, including the vault's own), and sizes the deposit on the minimum fills.
 */
export function quoteZapIn(s: VaultState, input: number, amountIn: bigint): ZapQuote | null {
  if (amountIn <= 0n || s.supply === 0n) return null;
  const { px, perShare } = vaultValue(s);
  const h = holdings(s);
  const values = h.map((x, k) => whole(x, k) * px[k]);
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const states = poolStates(s);
  const swaps: Swap[] = [];
  const amounts = ASSETS.map(() => 0n);
  const fromWallet = ASSETS.map(() => 0n);
  let spent = 0n;
  ASSETS.forEach((_, k) => {
    if (k === input || values[k] === 0) return;
    const slice = (amountIn * BigInt(Math.floor((values[k] / total) * 1e9))) / 1_000_000_000n;
    const sliceUsd = whole(slice, input) * px[input];
    if (sliceUsd < MIN_SWAP_USD) {
      // Too small to swap, but the deposit still needs every asset: the wallet pays it, with room.
      if (px[k] > 0) fromWallet[k] = BigInt(Math.ceil(((sliceUsd * 2) / px[k]) * 10 ** ASSETS[k].decimals)) + 1n;
      amounts[k] = fromWallet[k];
      return;
    }
    const route = bestRoute(states, input, k, slice);
    if (!route) return;
    let x = slice;
    for (const hop of route.hops) {
      const out = quoteSwap(states[hop.index], hop.pool.feeBps, hop.aToB, x);
      const min = minOf(out);
      swaps.push({ pool: hop.pool, aToB: hop.aToB, amountIn: x, minOut: min });
      applySwap(states, hop, x, out);
      x = min;
    }
    amounts[k] = x;
    spent += slice;
  });
  amounts[input] = amountIn - spent;

  // The deposit sees the vault pools after the route's swaps.
  const after: VaultState = { ...s, pools: s.pools.map((p, i) => ({ ...p, ...states[i] })), market: states.slice(POOLS.length) };
  const shares = sharesFor(after, amounts);
  if (shares === 0n) return null;
  return {
    input,
    amountIn,
    swaps,
    maxAmounts: amounts,
    fromWallet,
    shares,
    usdIn: whole(amountIn, input) * px[input] + usdOf(fromWallet, px),
    usdOut: (Number(shares) / 10 ** SHARE_DECIMALS) * perShare,
  };
}

export type ZapOutQuote = { amounts: bigint[]; swaps: Swap[]; out: bigint; usdOut: number };

/** Redeems `shares` in kind, then swaps every asset other than `output` into it. */
export function quoteZapOut(s: VaultState, shares: bigint, output: number): ZapOutQuote | null {
  if (shares <= 0n || s.supply === 0n) return null;
  const amounts = quoteShares(s, shares, false).map(minOf);
  // After the redeem, the vault pools hold less; swaps run against the reduced reserves.
  const states = poolStates(s).map((st, i) => {
    if (i >= POOLS.length) return st;
    const dl = (s.pools[i].position / s.supply) * shares;
    return { liquidity: st.liquidity - dl, reserveA: st.reserveA - (dl * st.reserveA) / st.liquidity, reserveB: st.reserveB - (dl * st.reserveB) / st.liquidity };
  });
  const swaps: Swap[] = [];
  let out = amounts[output];
  const px = prices(s);
  amounts.forEach((amount, k) => {
    // Dust stays in the wallet as it is.
    if (k === output || amount === 0n || whole(amount, k) * px[k] < MIN_SWAP_USD) return;
    const route = bestRoute(states, k, output, amount);
    if (!route) return;
    let x = amount;
    for (const hop of route.hops) {
      const o = quoteSwap(states[hop.index], hop.pool.feeBps, hop.aToB, x);
      swaps.push({ pool: hop.pool, aToB: hop.aToB, amountIn: x, minOut: minOf(o) });
      applySwap(states, hop, x, o);
      x = minOf(o);
    }
    out += x;
  });
  return { amounts, swaps, out, usdOut: whole(out, output) * px[output] };
}

// ---- the basket: one token in or out --------------------------------------------------------

/** The vault's shape for the basket math (lib/basket.ts, shared byte for byte with the SDK). */
const BASKET_VAULT = { decimals: ASSETS.map((a) => a.decimals), pools: POOLS, marketPools: MARKET_POOLS };
const nowSec = () => Math.floor(Date.now() / 1000);

/** A one-token deposit the vault takes alone (`deposit_single`), in one transaction, or why it can't. */
export const quoteSingleDeposit = (s: VaultState, input: number, amountIn: bigint, now = nowSec()) =>
  planSingleDeposit(BASKET_VAULT, s.basket, s, input, amountIn, now, Number(ROUTE_SLIPPAGE_BPS));

/** `redeem_single` into issuer token `k`, or why the vault can't pay it alone. */
export const quoteSingleRedeem = (s: VaultState, shares: bigint, k: number, now = nowSec()) => planSingleRedeem(BASKET_VAULT, s.basket, s, shares, k, now);

/** `redeem_single` into the issuer token that sells for the most `target` (USDC), and the swaps that sell it. */
export const quoteRedeemTo = (s: VaultState, shares: bigint, target: number, now = nowSec()) =>
  planRedeemTo(BASKET_VAULT, s.basket, s, shares, target, now, Number(ROUTE_SLIPPAGE_BPS));

/** A sentence for why the vault won't take or pay one token alone. */
export const explainRefusal = (r: Refusal) => describeRefusal(r, (k) => ASSETS[k].symbol, (i) => POOLS[i].label);

export type BasketView = {
  /** Null when single-token trades work; otherwise what stops them. */
  stopped: string | null;
  bandBps: number;
  assets: { weightBps: number; targetWeightBps: number; maxWeightBps: number; isStock: boolean; pegged: boolean; depositFeeBps: number | null; redeemFeeBps: number | null }[];
};

/** The basket at a glance: each asset's weight against its target and cap, its fee, and the breaker. */
export function basketView(s: VaultState): BasketView | null {
  const basket = s.basket;
  if (!basket || basket.numAssets !== ASSETS.length) return null;
  const stop = breaker(BASKET_VAULT, basket, s, nowSec());
  const book = valueBook(BASKET_VAULT, basket, s);
  return {
    stopped: stop ? explainRefusal(stop) : null,
    bandBps: basket.params.bandBps,
    assets: ASSETS.map((_, k) => {
      const a = basket.assets[k];
      const open = !stop && !!book && pegged(basket, k);
      return {
        weightBps: book?.weights[k] ?? 0,
        targetWeightBps: a.targetWeightBps,
        maxWeightBps: a.maxWeightBps,
        isStock: a.isStock,
        pegged: pegged(basket, k),
        depositFeeBps: open && book!.weights[k] < a.maxWeightBps ? marginalFeeBps(basket, book!, k, true) : null,
        redeemFeeBps: open ? marginalFeeBps(basket, book!, k, false) : null,
      };
    }),
  };
}

// ---- formatting -----------------------------------------------------------------------------

export function toRaw(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const fromRaw = (raw: bigint, decimals: number, digits = 4) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: digits });

export const usd = (v: number, digits = 2) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** A signed fee in basis points, for people: "0.15% fee", "0.03% discount", "No fee". */
export const feeText = (bps: number) =>
  bps === 0 ? "No fee" : `${(Math.abs(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% ${bps > 0 ? "fee" : "discount"}`;

export const explorer = (address: PublicKey | string, kind: "address" | "tx" = "address") =>
  `https://explorer.solana.com/${kind}/${address.toString()}?cluster=devnet`;

export const shortAddress = (address: PublicKey | string) => {
  const s = address.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** Signed figure with a true minus sign, for balance changes. */
export const signed = (value: number, digits = 4) =>
  `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: digits })}`;
