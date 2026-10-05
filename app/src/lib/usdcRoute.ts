// Deposits routed through USDC pools, built client-side; the vault program only sees a normal
// `deposit`, and the vault's pool grows in both tokens:
// - one issuer's token: sell part of it for USDC and buy the other issuer's token with it;
// - USDC: buy both issuers' tokens;
// - SOL: swap it for USDC first.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import devnet from "./devnet.json";
import { DammPool, PoolState, VAULT, ata, depositIx, poolSwapIx, quoteSwap, sharesFor } from "./stockwoven";

/** Each leg keeps this much below its quote, so a slightly worse fill fails cleanly instead of short-filling the deposit. */
export const ROUTE_SLIPPAGE_BPS = 10n;
const buffered = (x: bigint) => (x * (10_000n - ROUTE_SLIPPAGE_BPS)) / 10_000n;

const usdcMint = devnet.usdcMint ? new PublicKey(devnet.usdcMint) : null;
const routePool = (route: { pool: string; stockVault: string; usdcVault: string }, stock: PublicKey): DammPool => ({
  pool: new PublicKey(route.pool),
  tokenAVault: new PublicKey(route.stockVault),
  tokenBVault: new PublicKey(route.usdcVault),
  mintA: stock,
  mintB: usdcMint!,
});

/** Stock/USDC pools on devnet (stock is token A, USDC token B), and the lookup table that fits the transaction. */
export const USDC_ROUTE =
  usdcMint && devnet.usdcRoutes && devnet.lookupTable
    ? {
        usdc: usdcMint,
        a: routePool(devnet.usdcRoutes.a, VAULT.mintA),
        b: routePool(devnet.usdcRoutes.b, VAULT.mintB),
        lookupTable: new PublicKey(devnet.lookupTable),
      }
    : null;

export type RoutedQuote = {
  inputIsA: boolean;
  /** Input sold for USDC, the USDC spent on the other token, and the least of it the deposit relies on. */
  sold: bigint;
  usdcIn: bigint;
  minBought: bigint;
  /** The deposit: shares minted and the most of each token it may take. */
  shares: bigint;
  maxA: bigint;
  maxB: bigint;
};

/**
 * Splits `amountIn` so what is kept and what is bought sit at the vault pool's ratio. Keeping
 * less lowers the shares the kept side covers and raises the bought side's, so it bisects for
 * the split where they cross.
 */
export function quoteRoutedDeposit(pool: PoolState, supply: bigint, inputIsA: boolean, amountIn: bigint): RoutedQuote | null {
  if (!USDC_ROUTE || !pool.routes || amountIn <= 0n) return null;
  const [sellPool, buyPool] = inputIsA ? [pool.routes.a, pool.routes.b] : [pool.routes.b, pool.routes.a];
  const [keptReserve, boughtReserve] = inputIsA ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA];

  const legs = (sold: bigint) => {
    const usdcIn = buffered(quoteSwap(sellPool, true, sold));
    const minBought = buffered(quoteSwap(buyPool, false, usdcIn));
    return { sold, usdcIn, minBought, kept: amountIn - sold };
  };
  let [lo, hi] = [0n, amountIn];
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const { kept, minBought } = legs(mid);
    // Compare the liquidity each side covers: kept / keptReserve against bought / boughtReserve.
    if (kept * boughtReserve > minBought * keptReserve) lo = mid;
    else hi = mid;
  }
  const best = [legs(lo), legs(hi)]
    .map((l) => {
      const [a, b] = inputIsA ? [l.kept, l.minBought] : [l.minBought, l.kept];
      return { ...l, maxA: a, maxB: b, shares: sharesFor(pool, supply, a, b) };
    })
    .reduce((x, y) => (y.shares > x.shares ? y : x));
  if (best.shares <= 0n || best.usdcIn <= 0n) return null;
  return {
    inputIsA,
    sold: best.sold,
    usdcIn: best.usdcIn,
    minBought: best.minBought,
    shares: best.shares,
    maxA: best.maxA,
    maxB: best.maxB,
  };
}

/** Sell for USDC, buy the other issuer's token, deposit both. Anything the deposit doesn't take stays in the wallet. */
export function routedDepositIxs(user: PublicKey, q: RoutedQuote): TransactionInstruction[] {
  if (!USDC_ROUTE) return [];
  const usdc = ata(user, USDC_ROUTE.usdc);
  const [sell, buy] = q.inputIsA ? [USDC_ROUTE.a, USDC_ROUTE.b] : [USDC_ROUTE.b, USDC_ROUTE.a];
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, usdc, user, USDC_ROUTE.usdc),
    poolSwapIx(sell, user, ata(user, sell.mintA), usdc, q.sold, q.usdcIn),
    poolSwapIx(buy, user, usdc, ata(user, buy.mintA), q.usdcIn, q.minBought),
    depositIx(user, q.shares, q.maxA, q.maxB),
  ];
}

/** The wSOL/USDC pool (wSOL is token A), for deposits that start from SOL. */
export const SOL_ROUTE =
  USDC_ROUTE && devnet.solRoute
    ? {
        pool: new PublicKey(devnet.solRoute.pool),
        tokenAVault: new PublicKey(devnet.solRoute.solVault),
        tokenBVault: new PublicKey(devnet.solRoute.usdcVault),
        mintA: NATIVE_MINT,
        mintB: USDC_ROUTE.usdc,
      }
    : null;

export type UsdcQuote = {
  /** USDC spent on each issuer's token, and the least of each the deposit relies on. */
  usdcA: bigint;
  usdcB: bigint;
  minA: bigint;
  minB: bigint;
  shares: bigint;
};

/**
 * Splits `usdcIn` between the two issuers' tokens so what is bought sits at the vault pool's
 * ratio: more USDC on A raises the A side's coverage and lowers B's, so it bisects for the cross.
 */
export function quoteUsdcDeposit(pool: PoolState, supply: bigint, usdcIn: bigint): UsdcQuote | null {
  if (!USDC_ROUTE || !pool.routes || usdcIn <= 0n) return null;
  const { a: poolA, b: poolB } = pool.routes;
  const legs = (usdcA: bigint) => ({
    usdcA,
    usdcB: usdcIn - usdcA,
    minA: buffered(quoteSwap(poolA, false, usdcA)),
    minB: buffered(quoteSwap(poolB, false, usdcIn - usdcA)),
  });
  let [lo, hi] = [0n, usdcIn];
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const { minA, minB } = legs(mid);
    // Compare the liquidity each side covers: a / reserveA against b / reserveB.
    if (minA * pool.reserveB < minB * pool.reserveA) lo = mid;
    else hi = mid;
  }
  const best = [legs(lo), legs(hi)]
    .map((l) => ({ ...l, shares: sharesFor(pool, supply, l.minA, l.minB) }))
    .reduce((x, y) => (y.shares > x.shares ? y : x));
  return best.shares > 0n && best.usdcA > 0n && best.usdcB > 0n ? best : null;
}

/** SOL becomes USDC in the wSOL/USDC pool first; the rest is a USDC deposit. */
export function quoteSolDeposit(pool: PoolState, supply: bigint, lamports: bigint) {
  if (!SOL_ROUTE || !pool.routes?.sol || lamports <= 0n) return null;
  const usdcIn = buffered(quoteSwap(pool.routes.sol, true, lamports));
  const usdc = quoteUsdcDeposit(pool, supply, usdcIn);
  return usdc && { lamports, usdcIn, usdc };
}

/** Buy both issuers' tokens with USDC from the wallet's USDC account, then deposit them. */
function buyBothAndDepositIxs(user: PublicKey, q: UsdcQuote): TransactionInstruction[] {
  if (!USDC_ROUTE) return [];
  const usdc = ata(user, USDC_ROUTE.usdc);
  return [
    poolSwapIx(USDC_ROUTE.a, user, usdc, ata(user, VAULT.mintA), q.usdcA, q.minA),
    poolSwapIx(USDC_ROUTE.b, user, usdc, ata(user, VAULT.mintB), q.usdcB, q.minB),
    depositIx(user, q.shares, q.minA, q.minB),
  ];
}

/** A USDC deposit. Anything the deposit doesn't take stays in the wallet. */
export function usdcDepositIxs(user: PublicKey, q: UsdcQuote): TransactionInstruction[] {
  if (!USDC_ROUTE) return [];
  return [usdcAccountIx(user), ...buyBothAndDepositIxs(user, q)];
}

const usdcAccountIx = (user: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(user, ata(user, USDC_ROUTE!.usdc), user, USDC_ROUTE!.usdc);

/**
 * Wrap SOL, swap it for USDC, then a USDC deposit. Closing the wSOL account at the end returns
 * its rent (and any wSOL the wallet already held there) as SOL.
 */
export function solDepositIxs(user: PublicKey, q: NonNullable<ReturnType<typeof quoteSolDeposit>>): TransactionInstruction[] {
  if (!SOL_ROUTE || !USDC_ROUTE) return [];
  const wsol = ata(user, NATIVE_MINT);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: q.lamports }),
    createSyncNativeInstruction(wsol),
    usdcAccountIx(user),
    poolSwapIx(SOL_ROUTE, user, wsol, ata(user, USDC_ROUTE.usdc), q.lamports, q.usdcIn),
    ...buyBothAndDepositIxs(user, q.usdc),
    createCloseAccountInstruction(wsol, user, user),
  ];
}
