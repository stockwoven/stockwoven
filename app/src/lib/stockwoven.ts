// Client for the Stockwoven vault on devnet: instruction builders, pool reads and quotes.
// Account order mirrors programs/stockwoven/src/instructions/*.rs.

import { Buffer } from "buffer";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import devnet from "./devnet.json";

export const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

export const SHARE_DECIMALS = 8;
export const TRADE_FEE_BPS = 10;
export const COMPOUNDING_FEE_BPS = 8_000;
/** Vault fee on single-token deposits (ZAP_FEE_BPS): kept in the position, no shares minted for it. */
export const ZAP_FEE_BPS = 5;

export const VAULT = {
  program: new PublicKey(devnet.program),
  mintA: new PublicKey(devnet.mintA),
  mintB: new PublicKey(devnet.mintB),
  decimalsA: devnet.decimalsA,
  decimalsB: devnet.decimalsB,
  pool: new PublicKey(devnet.pool),
  vault: new PublicKey(devnet.vault),
  shareMint: new PublicKey(devnet.shareMint),
  position: new PublicKey(devnet.position),
  positionNftAccount: new PublicKey(devnet.positionNftAccount),
  tokenAVault: new PublicKey(devnet.tokenAVault),
  tokenBVault: new PublicKey(devnet.tokenBVault),
  reserveA: new PublicKey(devnet.reserveA),
  reserveB: new PublicKey(devnet.reserveB),
  treasury: new PublicKey(devnet.treasury),
  liquidityPerShare: BigInt(devnet.liquidityPerShare),
};

const DISC = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  depositSingle: [116, 81, 213, 110, 17, 83, 209, 188],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  harvest: [228, 241, 31, 182, 53, 169, 59, 199],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
};

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const data = (disc: number[], ...args: bigint[]) => Buffer.concat([Buffer.from(disc), ...args.map(u64)]);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner);

/** Creates the user's A, B and share accounts if they don't exist yet. */
export function ensureAccountsIxs(user: PublicKey): TransactionInstruction[] {
  return [VAULT.mintA, VAULT.mintB, VAULT.shareMint].map((mint) =>
    createAssociatedTokenAccountIdempotentInstruction(user, ata(user, mint), user, mint),
  );
}

export function depositIx(user: PublicKey, shares: bigint, maxA: bigint, maxB: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: data(DISC.deposit, shares, maxA, maxB),
    keys: [
      r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
      w(ata(user, VAULT.mintA)), w(ata(user, VAULT.mintB)), w(VAULT.reserveA), w(VAULT.reserveB),
      r(VAULT.mintA), r(VAULT.mintB), w(VAULT.pool), w(VAULT.position), r(VAULT.positionNftAccount),
      w(VAULT.tokenAVault), w(VAULT.tokenBVault), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

/** Deposits one issuer's token: the vault swaps the right part of it and adds both as liquidity. */
export function depositSingleIx(user: PublicKey, inputIsA: boolean, amountIn: bigint, minShares: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.concat([Buffer.from(DISC.depositSingle), Buffer.from([inputIsA ? 1 : 0]), u64(amountIn), u64(minShares)]),
    keys: [
      r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
      w(ata(user, VAULT.mintA)), w(ata(user, VAULT.mintB)), w(VAULT.reserveA), w(VAULT.reserveB),
      r(VAULT.mintA), r(VAULT.mintB), w(VAULT.pool), w(VAULT.position), r(VAULT.positionNftAccount),
      w(VAULT.tokenAVault), w(VAULT.tokenBVault), r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

export function redeemIx(user: PublicKey, shares: bigint, minA: bigint, minB: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: data(DISC.redeem, shares, minA, minB),
    keys: [
      r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
      w(ata(user, VAULT.mintA)), w(ata(user, VAULT.mintB)), r(VAULT.mintA), r(VAULT.mintB),
      w(VAULT.pool), w(VAULT.position), r(VAULT.positionNftAccount), w(VAULT.tokenAVault), w(VAULT.tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

export function harvestIx() {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.from(DISC.harvest),
    keys: [
      r(VAULT.vault), w(VAULT.reserveA), w(VAULT.treasury), r(VAULT.mintA), r(VAULT.mintB), r(VAULT.pool),
      w(VAULT.position), r(VAULT.positionNftAccount), w(VAULT.tokenAVault), w(VAULT.tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

/** The accounts of any cp-amm pool a swap goes through. */
export type DammPool = { pool: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey; mintA: PublicKey; mintB: PublicKey };

/** A swap on any cp-amm pool, from the user's `input` token account to `output`. */
export function poolSwapIx(p: DammPool, user: PublicKey, input: PublicKey, output: PublicKey, amountIn: bigint, minOut: bigint) {
  return new TransactionInstruction({
    programId: CP_AMM,
    data: data(DISC.swap, amountIn, minOut),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(p.pool), w(input), w(output), w(p.tokenAVault), w(p.tokenBVault),
      r(p.mintA), r(p.mintB), r(user, true), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
      r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

/** A direct DAMM v2 swap between the two issuers' tokens; the vault program is not involved. */
export function swapIx(user: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [input, output] = aToB
    ? [ata(user, VAULT.mintA), ata(user, VAULT.mintB)]
    : [ata(user, VAULT.mintB), ata(user, VAULT.mintA)];
  return poolSwapIx(VAULT, user, input, output, amountIn, minOut);
}

export type Reserves = { reserveA: bigint; reserveB: bigint };

/**
 * `vaultLiquidity` is the vault position's liquidity: every swINTC is a pro-rata claim on it.
 * `routes` holds the stock/USDC pools of the routed single-token deposit, when they exist.
 */
export type PoolState = Reserves & {
  liquidity: bigint;
  vaultLiquidity: bigint;
  routes?: { a: Reserves; b: Reserves; sol?: Reserves };
};

const u128 = (d: Buffer, offset: number) => d.readBigUInt64LE(offset) + (d.readBigUInt64LE(offset + 8) << 64n);
const reserves = (d: Buffer): Reserves => ({ reserveA: d.readBigUInt64LE(680), reserveB: d.readBigUInt64LE(688) });

/** Reads cp-amm's Pool, the vault's Position and any route pools (offsets include the 8-byte discriminator). */
export async function fetchPool(conn: Connection): Promise<PoolState> {
  const routePools = [devnet.usdcRoutes?.a.pool, devnet.usdcRoutes?.b.pool, devnet.solRoute?.pool]
    .filter((k): k is string => !!k)
    .map((k) => new PublicKey(k));
  const [pool, position, routeA, routeB, routeSol] = await conn.getMultipleAccountsInfo([VAULT.pool, VAULT.position, ...routePools]);
  if (!pool || !position) throw new Error("pool not found");
  const d = Buffer.from(pool.data);
  const read = (info: typeof pool) => reserves(Buffer.from(info.data));
  return {
    liquidity: u128(d, 360),
    ...reserves(d),
    vaultLiquidity: u128(Buffer.from(position.data), 152),
    routes: routeA && routeB ? { a: read(routeA), b: read(routeB), sol: routeSol ? read(routeSol) : undefined } : undefined,
  };
}

/** Liquidity behind one raw share unit, rounded as the program does. An empty vault uses the launch ratio. */
function liquidityPerShare(pool: PoolState, supply: bigint, roundUp: boolean) {
  if (supply === 0n) return VAULT.liquidityPerShare;
  return roundUp ? ceilDiv(pool.vaultLiquidity, supply) : pool.vaultLiquidity / supply;
}

/** One token of either issuer counts as one share of stock. */
export const stockValue = (a: bigint, b: bigint) =>
  Number(a) / 10 ** VAULT.decimalsA + Number(b) / 10 ** VAULT.decimalsB;

/** Shares of stock behind one whole swINTC. */
export function navPerShare(pool: PoolState, supply: bigint) {
  const l = Number(liquidityPerShare(pool, supply, false) * 10n ** BigInt(SHARE_DECIMALS)) / Number(pool.liquidity);
  return l * stockValue(pool.reserveA, pool.reserveB);
}

/** Tokens cp-amm will take for `shares` (it rounds up on deposit, down on redeem). */
export function quoteShares(pool: PoolState, supply: bigint, shares: bigint, roundUp: boolean) {
  const dl = shares * liquidityPerShare(pool, supply, roundUp);
  const div = roundUp ? ceilDiv : (a: bigint, b: bigint) => a / b;
  return { a: div(dl * pool.reserveA, pool.liquidity), b: div(dl * pool.reserveB, pool.liquidity) };
}

/** Most shares a deposit of at most `a` and `b` covers, at the vault pool's current reserves. */
export function sharesFor(pool: PoolState, supply: bigint, a: bigint, b: bigint) {
  const dlA = (a * pool.liquidity) / pool.reserveA;
  const dlB = (b * pool.liquidity) / pool.reserveB;
  return (dlA < dlB ? dlA : dlB) / liquidityPerShare(pool, supply, true);
}

/**
 * x·y = k quote on any compounding cp-amm pool with TRADE_FEE_BPS. The fee is charged in token B:
 * on output for A→B, on input for B→A.
 */
export function quoteSwap(pool: Reserves, aToB: boolean, amountIn: bigint) {
  const fee = (x: bigint) => (x * BigInt(TRADE_FEE_BPS)) / 10_000n;
  if (aToB) {
    const gross = (pool.reserveB * amountIn) / (pool.reserveA + amountIn);
    return gross - fee(gross);
  }
  const net = amountIn - fee(amountIn);
  return (pool.reserveA * net) / (pool.reserveB + net);
}

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x0 = n / 2n + 1n;
  let x1 = (x0 + n / x0) / 2n;
  while (x1 < x0) [x0, x1] = [x1, (x1 + n / x1) / 2n];
  return x0;
};

/**
 * Mirrors deposit_single: swap `sqrt(r · (r + a)) − r` of the input, add the most liquidity both
 * balances cover, and mint shares for all but the vault fee. The post-swap reserves leave out the
 * compounded part of the swap fee, so the quote reads very slightly low.
 */
export function quoteDepositSingle(pool: PoolState, supply: bigint, inputIsA: boolean, amountIn: bigint) {
  const reserveIn = inputIsA ? pool.reserveA : pool.reserveB;
  const swapped = isqrt(reserveIn * (reserveIn + amountIn)) - reserveIn;
  const out = swapped > 0n ? quoteSwap(pool, inputIsA, swapped) : 0n;
  const [a, b] = inputIsA ? [amountIn - swapped, out] : [out, amountIn - swapped];
  const reserveA = inputIsA ? pool.reserveA + swapped : pool.reserveA - out;
  const reserveB = inputIsA ? pool.reserveB - out : pool.reserveB + swapped;
  if (reserveA <= 0n || reserveB <= 0n) return null;
  const dlA = (a * pool.liquidity) / reserveA;
  const dlB = (b * pool.liquidity) / reserveB;
  const forHolder = ((dlA < dlB ? dlA : dlB) * BigInt(10_000 - ZAP_FEE_BPS)) / 10_000n;
  return forHolder / liquidityPerShare(pool, supply, true);
}

export function toRaw(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const fromRaw = (raw: bigint, decimals: number, digits = 4) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: digits });

export const explorer = (address: PublicKey | string, kind: "address" | "tx" = "address") =>
  `https://explorer.solana.com/${kind}/${address.toString()}?cluster=devnet`;

export const shortAddress = (address: PublicKey | string) => {
  const s = address.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** Signed figure with a true minus sign, for balance changes. */
export const signed = (value: number, digits = 4) =>
  `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: digits })}`;
