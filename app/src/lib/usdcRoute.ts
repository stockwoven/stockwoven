// Routed single-token deposit: sell part of one issuer's token for USDC, buy the other issuer's
// token with it in a second stock/USDC pool, then make a proportional deposit. The vault's pool
// grows in both tokens, and the vault program only sees a normal `deposit`. Built client-side.

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
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
