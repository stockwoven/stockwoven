// The vault's basket: single-token deposits and redemptions with target weights, caps, a dynamic
// fee and a ±band circuit breaker (programs/stockwoven/src/instructions/basket.rs). This file is
// pure and config-agnostic, and the app keeps a byte-identical copy (app/src/lib/basket.ts), so
// both quote exactly what the program does. Edit both, or the parity test fails.
//
// Value is counted in nano-shares of the stock (1e9 = one share). Issuer tokens are worth one share
// each; USDC and SOL are worth the keeper's posted price. A deposit of one token mints shares for
// its value after a fee that depends on how the deposit moves that token's weight against its
// target; a redemption pays one issuer token the same way.

import { PublicKey } from "@solana/web3.js";

export const NANO_SHARES = 1_000_000_000n;

export type BasketParams = {
  /** ±band, in bps, inside which issuer tokens count 1:1 and vault pools must trade around the posted prices. */
  bandBps: number;
  baseFeeBps: number;
  /** Fee added per 100 bps (one point) of weight away from target, in the direction that hurts the vault. */
  feeSlopeBps: number;
  maxFeeBps: number;
  maxDiscountBps: number;
  /** Seconds the keeper's prices stay valid. */
  maxPriceAge: number;
};

export type BasketAsset = {
  /** An issuer's token of the stock (valued 1:1). Otherwise USDC or SOL. */
  isStock: boolean;
  targetWeightBps: number;
  maxWeightBps: number;
  /** The keeper's market price: nano-shares per whole token. */
  price: bigint;
};

export type Basket = {
  params: BasketParams;
  numAssets: number;
  /** One per vault asset (`numAssets` of them). */
  assets: BasketAsset[];
  /** Unix seconds of the keeper's last price update; 0 before the first. */
  pricesUpdatedAt: number;
};

/** The basket account: `["basket", vault]`. */
export const basketAddress = (program: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("basket"), vault.toBytes()], program)[0];

/** Decodes the Basket account (Borsh, after the 8-byte discriminator). */
export function decodeBasket(data: Uint8Array): Basket {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  // vault 8..40, bump 40, params 41..55, num_assets 55, 6 assets of 13 bytes from 56, prices_updated_at 134.
  const numAssets = data[55];
  const assets: BasketAsset[] = [];
  for (let k = 0; k < numAssets; k++) {
    const o = 56 + k * 13;
    assets.push({ isStock: data[o] === 1, targetWeightBps: u16(o + 1), maxWeightBps: u16(o + 3), price: view.getBigUint64(o + 5, true) });
  }
  return {
    params: { bandBps: u16(41), baseFeeBps: u16(43), feeSlopeBps: u16(45), maxFeeBps: u16(47), maxDiscountBps: u16(49), maxPriceAge: view.getUint32(51, true) },
    numAssets,
    assets,
    pricesUpdatedAt: Number(view.getBigInt64(134, true)),
  };
}

// ---- the program's math (math.rs) -----------------------------------------------------------

/** Value in nano-shares of `amount` raw units at `price` nano-shares per whole token. Rounded down. */
export const valueOf = (amount: bigint, decimals: number, price: bigint) => (amount * price) / 10n ** BigInt(decimals);

/** Raw units worth `value` nano-shares at `price`. Rounded down. */
export const amountForValue = (value: bigint, decimals: number, price: bigint) => (price === 0n ? 0n : (value * 10n ** BigInt(decimals)) / price);

/** `floor(amount * part / whole)` with the program's precision: both liquidities shifted until `whole` fits 64 bits. */
export function proRata(amount: bigint, part: bigint, whole: bigint) {
  if (whole === 0n) return 0n;
  const bits = whole.toString(2).length;
  const shift = BigInt(Math.max(0, bits - 64));
  const [p, w] = [part >> shift, whole >> shift];
  if (w === 0n) return 0n;
  return (amount * (p < w ? p : w)) / w;
}

/** `ceil(x * num / den)`. */
export const mulDivCeil = (x: bigint, num: bigint, den: bigint) => (x * num + den - 1n) / den;

/** `part` as a share of `total`, in bps. */
export const weightBps = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10_000n) / total));

/** Whether two values sit within `bandBps` of each other, relative to the larger. */
export function withinBand(a: bigint, b: bigint, bandBps: number) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (hi - lo) * 10_000n <= hi * BigInt(bandBps);
}

/**
 * The dynamic fee in signed bps for moving a token's weight from `w0` to `w1`, measured at the
 * midpoint. A deposit (`inflow`) costs more the more overweight the token is; a redemption costs
 * more the more underweight it leaves it. Negative is a discount. Integer division truncates
 * toward zero, as in Rust.
 */
export function dynamicFeeBps(w0: number, w1: number, target: number, inflow: boolean, p: BasketParams) {
  const mid = Math.trunc((w0 + w1) / 2);
  const deviation = inflow ? mid - target : target - mid;
  const fee = p.baseFeeBps + Math.trunc((deviation * p.feeSlopeBps) / 100);
  return Math.min(Math.max(fee, -p.maxDiscountBps), p.maxFeeBps);
}

/** `value` after a signed fee in bps. Rounded down. */
export const afterFee = (value: bigint, feeBps: number) => (value * BigInt(10_000 - feeBps)) / 10_000n;

const haircut = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** cp-amm x·y = k with the fee in token B, rounded up (the SDK's `swapOut`). */
export function poolSwapOut(st: PoolReserves, feeBps: number, aToB: boolean, amountIn: bigint) {
  if (amountIn <= 0n || st.reserveA === 0n || st.reserveB === 0n) return 0n;
  const fee = (x: bigint) => ceilDiv(x * BigInt(feeBps), 10_000n);
  if (aToB) {
    const gross = (st.reserveB * amountIn) / (st.reserveA + amountIn);
    return gross - fee(gross);
  }
  const net = amountIn - fee(amountIn);
  return (st.reserveA * net) / (st.reserveB + net);
}

// ---- the vault, valued ----------------------------------------------------------------------

export type PoolReserves = { liquidity: bigint; reserveA: bigint; reserveB: bigint };
/** What the basket math needs from a vault state read. */
export type Holdings = { supply: bigint; reserves: bigint[]; pools: (PoolReserves & { position: bigint })[]; market: PoolReserves[] };
export type PoolLike = { a: number; b: number; feeBps: number };
/** The vault's shape: asset decimals, its own pools and the market pools, in the vault's order. */
export type BasketVault<P extends PoolLike> = { decimals: number[]; pools: P[]; marketPools: P[] };

/** Why the program would refuse a single-token deposit or redemption. */
export type Refusal =
  | { kind: "NoBasket" }
  | { kind: "InvalidBasket" }
  | { kind: "PricesStale"; ageSec: number }
  | { kind: "PoolOutOfBand"; pool: number }
  | { kind: "VaultEmpty" }
  | { kind: "NotAStock"; asset: number }
  | { kind: "TokenDepegged"; asset: number }
  | { kind: "AssetAtCap"; asset: number }
  | { kind: "InsufficientLiquidity"; asset: number }
  | { kind: "NoRoute" }
  | { kind: "TooSmall" };

export type Book = {
  /** Raw amounts per asset: idle reserve plus the vault's slice of each pool. */
  amounts: bigint[];
  /** Values in nano-shares: issuer tokens 1:1, USDC and SOL at the posted price. */
  values: bigint[];
  nav: bigint;
  /** Each asset's share of `nav`, in bps. */
  weights: number[];
};

/** Seconds kept in hand before the program's own price deadline, for the time a transaction takes to land. */
export const PRICE_AGE_MARGIN_SEC = 20;

/** The circuit breaker: why the program would stop every single-token trade now, or null. */
export function breaker<P extends PoolLike>(v: BasketVault<P>, basket: Basket | null | undefined, s: Holdings, nowSec: number): Refusal | null {
  if (!basket) return { kind: "NoBasket" };
  if (basket.numAssets !== v.decimals.length) return { kind: "InvalidBasket" };
  const ageSec = nowSec - basket.pricesUpdatedAt;
  if (basket.pricesUpdatedAt <= 0 || ageSec > basket.params.maxPriceAge - PRICE_AGE_MARGIN_SEC) return { kind: "PricesStale", ageSec };
  for (let i = 0; i < v.pools.length; i++) {
    const p = v.pools[i];
    const st = s.pools[i];
    const [pa, pb] = [basket.assets[p.a].price, basket.assets[p.b].price];
    if (!withinBand(valueOf(st.reserveA, v.decimals[p.a], pa), valueOf(st.reserveB, v.decimals[p.b], pb), basket.params.bandBps)) {
      return { kind: "PoolOutOfBand", pool: i };
    }
  }
  return null;
}

/** The vault valued the program's way, without the breaker (null when it holds nothing). */
export function valueBook<P extends PoolLike>(v: BasketVault<P>, basket: Basket, s: Holdings): Book | null {
  const amounts = [...s.reserves];
  v.pools.forEach((p, i) => {
    const st = s.pools[i];
    amounts[p.a] += proRata(st.reserveA, st.position, st.liquidity);
    amounts[p.b] += proRata(st.reserveB, st.position, st.liquidity);
  });
  const values = amounts.map((x, k) => valueOf(x, v.decimals[k], valuationPrice(basket, k)));
  const nav = values.reduce((a, b) => a + b, 0n);
  if (nav === 0n) return null;
  return { amounts, values, nav, weights: values.map((x) => weightBps(x, nav)) };
}

/** The program's `book`: the vault valued, or the breaker that stops single-token trades. */
export function book<P extends PoolLike>(v: BasketVault<P>, basket: Basket | null | undefined, s: Holdings, nowSec: number): { book: Book } | { refused: Refusal } {
  const stop = breaker(v, basket, s, nowSec);
  if (stop) return { refused: stop };
  const b = valueBook(v, basket!, s);
  return b ? { book: b } : { refused: { kind: "VaultEmpty" } };
}

/** One share per issuer token; the keeper's price otherwise. */
export const valuationPrice = (basket: Basket, k: number) => (basket.assets[k].isStock ? NANO_SHARES : basket.assets[k].price);

/** An issuer token whose market price sits inside the 1:1 band. */
export const pegged = (basket: Basket, k: number) =>
  basket.assets[k].isStock && withinBand(basket.assets[k].price, NANO_SHARES, basket.params.bandBps);

/** Where a converted deposit may land: below target, or the most underweight pegged issuer token. */
export function conversionTargets(basket: Basket, b: Book): number[] {
  const gap = (j: number) => b.weights[j] - basket.assets[j].targetWeightBps;
  const candidates = b.values.map((_, j) => j).filter((j) => pegged(basket, j));
  if (candidates.length === 0) return [];
  const most = candidates.reduce((m, j) => (gap(j) < gap(m) ? j : m));
  return candidates.filter((j) => gap(j) < 0 || j === most);
}

/** Fee in signed bps for a deposit (or redemption) worth next to nothing: where the token's weight sits now. */
export function marginalFeeBps(basket: Basket, b: Book, k: number, inflow: boolean) {
  return dynamicFeeBps(b.weights[k], b.weights[k], basket.assets[k].targetWeightBps, inflow, basket.params);
}

type Mint = { into: number; amount: bigint; value: bigint; feeBps: number; shares: bigint };

/** What depositing `amount` of issuer token `j` mints, or why it would be refused. */
function mintFor(basket: Basket, b: Book, supply: bigint, decimals: number[], j: number, amount: bigint): Mint | Refusal {
  const value = valueOf(amount, decimals[j], NANO_SHARES);
  if (value === 0n) return { kind: "TooSmall" };
  const held = b.values[j];
  const w1 = weightBps(held + value, b.nav + value);
  if (w1 > basket.assets[j].maxWeightBps) return { kind: "AssetAtCap", asset: j };
  const feeBps = dynamicFeeBps(b.weights[j], w1, basket.assets[j].targetWeightBps, true, basket.params);
  const shares = (afterFee(value, feeBps) * supply) / b.nav;
  if (shares === 0n) return { kind: "TooSmall" };
  return { into: j, amount, value, feeBps, shares };
}

const isRefusal = (x: Mint | Refusal): x is Refusal => "kind" in x;

/** A client-side swap before the deposit, or after a redemption. */
export type BasketSwap<P> = { pool: P; aToB: boolean; amountIn: bigint; minOut: bigint };

export type SingleDepositPlan<P> = {
  /** The asset the customer pays with, and how much. */
  input: number;
  amountIn: bigint;
  /** A swap the transaction makes first, from the customer's wallet (e.g. SOL → USDC). */
  preSwap: BasketSwap<P> | null;
  /** The asset `deposit_single` takes from the wallet, and how much (after `preSwap`, its minimum). */
  mint: number;
  depositAmount: bigint;
  /** The pool the vault converts it on, inside `deposit_single`; null for a direct deposit. */
  convert: { pool: P; aToB: boolean } | null;
  /** The issuer token the deposit becomes, and about how much of it. */
  into: number;
  intoAmount: bigint;
  /** Its value, in nano-shares. */
  value: bigint;
  /** Signed: negative is a discount. */
  feeBps: number;
  shares: bigint;
  /** What the transaction requires (`min_shares`), after the slippage tolerance. */
  minShares: bigint;
  /** Why the token did not go in as itself: it is USDC or SOL, at its cap, or outside its band. */
  redirect: null | "quote" | "cap" | "depeg";
};

/** Pools (vault first, then market) with their states, indexed together. */
function allPools<P extends PoolLike>(v: BasketVault<P>, s: Holdings) {
  return [...v.pools.map((pool, i) => ({ pool, state: s.pools[i] as PoolReserves, vault: i })), ...v.marketPools.map((pool, i) => ({ pool, state: s.market[i], vault: -1 }))];
}

/** A copy of the state with a swap applied to vault pool `vault` (or nothing for a market pool). */
function afterSwap(s: Holdings, vault: number, aToB: boolean, amountIn: bigint, out: bigint): Holdings {
  if (vault < 0) return s;
  const pools = s.pools.map((p, i) =>
    i !== vault ? p : aToB ? { ...p, reserveA: p.reserveA + amountIn, reserveB: p.reserveB - out } : { ...p, reserveB: p.reserveB + amountIn, reserveA: p.reserveA - out },
  );
  return { ...s, pools };
}

/**
 * Plans a single-token deposit as the program will run it: a pegged issuer token under its cap goes
 * in directly; anything else (USDC, SOL, a token at its cap or off its band) is converted by the
 * vault into an underweight issuer token, through the pool that mints the most, after at most one
 * client-side swap (SOL → USDC, say) when no pool pairs it with one.
 */
export function planSingleDeposit<P extends PoolLike>(
  v: BasketVault<P>,
  basket: Basket | null | undefined,
  s: Holdings,
  input: number,
  amountIn: bigint,
  nowSec: number,
  slippageBps: number,
): { plan: SingleDepositPlan<P> } | { refused: Refusal } {
  if (amountIn <= 0n) return { refused: { kind: "TooSmall" } };
  if (s.supply === 0n) return { refused: { kind: "VaultEmpty" } };
  const first = book(v, basket, s, nowSec);
  if ("refused" in first) return first;
  const bk = basket!;
  const b = first.book;

  const plan = (m: Mint, rest: Omit<SingleDepositPlan<P>, "into" | "intoAmount" | "value" | "feeBps" | "shares" | "minShares" | "input" | "amountIn">) => ({
    input,
    amountIn,
    ...rest,
    into: m.into,
    intoAmount: m.amount,
    value: m.value,
    feeBps: m.feeBps,
    shares: m.shares,
    minShares: haircut(m.shares, slippageBps),
  });

  // 1. As itself.
  let reason: Refusal | null = null;
  if (bk.assets[input].isStock && pegged(bk, input)) {
    const m = mintFor(bk, b, s.supply, v.decimals, input, amountIn);
    if (!isRefusal(m)) return { plan: plan(m, { preSwap: null, mint: input, depositAmount: amountIn, convert: null, redirect: null }) };
    reason = m;
  } else if (bk.assets[input].isStock) {
    reason = { kind: "TokenDepegged", asset: input };
  }
  if (reason?.kind === "TooSmall") return { refused: reason };
  const redirect: SingleDepositPlan<P>["redirect"] = !bk.assets[input].isStock ? "quote" : reason?.kind === "AssetAtCap" ? "cap" : "depeg";

  // 2. Converted by the vault, straight from the input.
  const found: { best: SingleDepositPlan<P> | null } = { best: null };
  const consider = (p: SingleDepositPlan<P>) => {
    if (!found.best || p.shares > found.best.shares) found.best = p;
  };
  const convertFrom = (from: number, amount: bigint, state: Holdings, bookNow: Book, preSwap: BasketSwap<P> | null) => {
    const targets = conversionTargets(bk, bookNow);
    for (const { pool, state: st } of allPools(v, state)) {
      const aToB = pool.a === from;
      if (!aToB && pool.b !== from) continue;
      const to = aToB ? pool.b : pool.a;
      if (to === from || !targets.includes(to)) continue;
      const m = mintFor(bk, bookNow, state.supply, v.decimals, to, poolSwapOut(st, pool.feeBps, aToB, amount));
      if (!isRefusal(m)) consider(plan(m, { preSwap, mint: from, depositAmount: amount, convert: { pool, aToB }, redirect }));
    }
  };
  convertFrom(input, amountIn, s, b, null);

  // 3. One client-side swap first, then direct or converted.
  if (!found.best) {
    for (const { pool, state: st, vault } of allPools(v, s)) {
      const aToB = pool.a === input;
      if (!aToB && pool.b !== input) continue;
      const mid = aToB ? pool.b : pool.a;
      if (mid === input) continue;
      const out = poolSwapOut(st, pool.feeBps, aToB, amountIn);
      const min = haircut(out, slippageBps);
      if (min === 0n) continue;
      const preSwap: BasketSwap<P> = { pool, aToB, amountIn, minOut: min };
      const s2 = afterSwap(s, vault, aToB, amountIn, out);
      const again = book(v, bk, s2, nowSec);
      if ("refused" in again) continue;
      if (pegged(bk, mid)) {
        const m = mintFor(bk, again.book, s2.supply, v.decimals, mid, min);
        if (!isRefusal(m)) consider(plan(m, { preSwap, mint: mid, depositAmount: min, convert: null, redirect }));
      }
      convertFrom(mid, min, s2, again.book, preSwap);
    }
  }
  if (found.best) return { plan: found.best };
  return { refused: reason ?? { kind: "NoRoute" } };
}

export type SingleRedeemPlan = {
  shares: bigint;
  /** The issuer token paid out. */
  asset: number;
  value: bigint;
  feeBps: number;
  /** What the program pays (it pays exactly this at the quoted state). */
  amount: bigint;
  /** The vault pools after the program frees the token from them, for swaps that follow. */
  poolsAfter: (PoolReserves & { position: bigint })[];
};

/** Plans `redeem_single(shares)` into issuer token `k`, as the program runs it. */
export function planSingleRedeem<P extends PoolLike>(
  v: BasketVault<P>,
  basket: Basket | null | undefined,
  s: Holdings,
  shares: bigint,
  k: number,
  nowSec: number,
): { plan: SingleRedeemPlan } | { refused: Refusal } {
  if (shares <= 0n) return { refused: { kind: "TooSmall" } };
  if (s.supply === 0n) return { refused: { kind: "VaultEmpty" } };
  const first = book(v, basket, s, nowSec);
  if ("refused" in first) return first;
  const bk = basket!;
  const b = first.book;
  if (!bk.assets[k].isStock) return { refused: { kind: "NotAStock", asset: k } };
  if (!pegged(bk, k)) return { refused: { kind: "TokenDepegged", asset: k } };

  const value = (shares * b.nav) / s.supply;
  const held = b.values[k];
  const w1 = b.nav > value ? weightBps(held > value ? held - value : 0n, b.nav - value) : 0;
  const feeBps = dynamicFeeBps(b.weights[k], w1, bk.assets[k].targetWeightBps, false, bk.params);
  const amount = amountForValue(afterFee(value, feeBps), v.decimals[k], NANO_SHARES);
  if (amount === 0n) return { refused: { kind: "TooSmall" } };
  if (amount > b.amounts[k]) return { refused: { kind: "InsufficientLiquidity", asset: k } };

  // The program pays from the idle reserve first, then takes liquidity out of each pool holding k.
  const poolsAfter = s.pools.map((p) => ({ ...p }));
  let idle = s.reserves[k];
  for (let i = 0; i < v.pools.length && idle < amount; i++) {
    const p = v.pools[i];
    if (p.a !== k && p.b !== k) continue;
    const st = poolsAfter[i];
    const poolAmount = p.a === k ? st.reserveA : st.reserveB;
    if (st.position === 0n || poolAmount === 0n) continue;
    let delta = mulDivCeil(amount - idle + 1n, st.liquidity, poolAmount);
    if (delta > st.position) delta = st.position;
    const outA = (delta * st.reserveA) / st.liquidity;
    const outB = (delta * st.reserveB) / st.liquidity;
    poolsAfter[i] = { liquidity: st.liquidity - delta, reserveA: st.reserveA - outA, reserveB: st.reserveB - outB, position: st.position - delta };
    idle += p.a === k ? outA : outB;
  }
  if (idle < amount) return { refused: { kind: "InsufficientLiquidity", asset: k } };
  return { plan: { shares, asset: k, value, feeBps, amount, poolsAfter } };
}

export type RedeemToPlan<P> = {
  redeem: SingleRedeemPlan;
  /** `min_amount` of the redemption. */
  minAmount: bigint;
  /** Swaps from the issuer token into the target, sized on `minAmount`. */
  swaps: BasketSwap<P>[];
  /** The least of the target the wallet ends with. */
  out: bigint;
};

/**
 * Redeems into whichever pegged issuer token, sold for `target` (USDC, SOL) through one or two
 * pools, leaves the customer the most: the "SDK sells and delivers the cash" path.
 */
export function planRedeemTo<P extends PoolLike>(
  v: BasketVault<P>,
  basket: Basket | null | undefined,
  s: Holdings,
  shares: bigint,
  target: number,
  nowSec: number,
  slippageBps: number,
): { plan: RedeemToPlan<P> } | { refused: Refusal } {
  const first = book(v, basket, s, nowSec);
  if ("refused" in first) return first;
  let best: RedeemToPlan<P> | null = null;
  let reason: Refusal = { kind: "NoRoute" };
  for (let k = 0; k < v.decimals.length; k++) {
    if (!basket!.assets[k].isStock || k === target) continue;
    const r = planSingleRedeem(v, basket, s, shares, k, nowSec);
    if ("refused" in r) {
      reason = r.refused;
      continue;
    }
    const minAmount = haircut(r.plan.amount, slippageBps);
    const after: Holdings = { ...s, pools: r.plan.poolsAfter };
    const route = bestRoute(v, after, k, target, minAmount);
    if (!route) continue;
    const swaps: BasketSwap<P>[] = [];
    let x = minAmount;
    const states = allPools(v, after).map((p) => p.state);
    for (const hop of route) {
      const out = poolSwapOut(states[hop.index], hop.pool.feeBps, hop.aToB, x);
      const min = haircut(out, slippageBps);
      swaps.push({ pool: hop.pool, aToB: hop.aToB, amountIn: x, minOut: min });
      const st = states[hop.index];
      states[hop.index] = hop.aToB ? { ...st, reserveA: st.reserveA + x, reserveB: st.reserveB - out } : { ...st, reserveB: st.reserveB + x, reserveA: st.reserveA - out };
      x = min;
    }
    if (x > 0n && (!best || x > best.out)) best = { redeem: r.plan, minAmount, swaps, out: x };
  }
  return best ? { plan: best } : { refused: reason };
}

/** The best route of one or two hops from `from` to `to` across every pool. */
function bestRoute<P extends PoolLike>(v: BasketVault<P>, s: Holdings, from: number, to: number, amountIn: bigint) {
  const pools = allPools(v, s);
  type Hop = { pool: P; index: number; aToB: boolean };
  const hopsFrom = (k: number) => pools.flatMap(({ pool }, index): Hop[] => (pool.a === k ? [{ pool, index, aToB: true }] : pool.b === k ? [{ pool, index, aToB: false }] : []));
  const end = (h: Hop) => (h.aToB ? h.pool.b : h.pool.a);
  const run = (hops: Hop[]) => hops.reduce((x, h) => poolSwapOut(pools[h.index].state, h.pool.feeBps, h.aToB, x), amountIn);
  let best: { hops: Hop[]; out: bigint } | null = null;
  for (const h1 of hopsFrom(from)) {
    const mid = end(h1);
    const candidates = mid === to ? [[h1]] : hopsFrom(mid).filter((h2) => h2.index !== h1.index && end(h2) === to).map((h2) => [h1, h2]);
    for (const hops of candidates) {
      const out = run(hops);
      if (out > 0n && (!best || out > best.out)) best = { hops, out };
    }
  }
  return best?.hops ?? null;
}

/** A sentence for a refusal, for customer-facing copy. `symbol(k)` names an asset. */
export function describeRefusal(r: Refusal, symbol: (k: number) => string, poolLabel: (i: number) => string = (i) => `pool ${i}`): string {
  switch (r.kind) {
    case "NoBasket":
      return "This vault does not take single-token deposits yet.";
    case "InvalidBasket":
      return "The vault's basket settings do not cover every asset yet.";
    case "PricesStale":
      return "The keeper's prices are out of date, so single-token trades are paused for now.";
    case "PoolOutOfBand":
      return `The ${poolLabel(r.pool)} pool trades more than the band away from the keeper's prices, so single-token trades are paused for now.`;
    case "VaultEmpty":
      return "The vault has no shares yet.";
    case "NotAStock":
      return `${symbol(r.asset)} is not an issuer token of the stock.`;
    case "TokenDepegged":
      return `${symbol(r.asset)} trades outside its 1:1 band, so the vault is not taking or paying it out alone.`;
    case "AssetAtCap":
      return `${symbol(r.asset)} is at its cap in the vault.`;
    case "InsufficientLiquidity":
      return `The vault does not hold enough ${symbol(r.asset)}.`;
    case "NoRoute":
      return "No pool converts this token into one the vault needs.";
    case "TooSmall":
      return "The amount is too small.";
  }
}
