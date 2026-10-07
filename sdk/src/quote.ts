// Pure pricing: no RPC, no keys. Every function takes the vault config and a state read, so a
// partner can price many amounts off one read, and the numbers match what the program does.
//
// One share token is a pro-rata claim on everything the vault holds: its liquidity in every pool
// and the idle balance of every reserve.

import { Pool, VaultConfig } from "./config.js";
import { PoolState, VaultState } from "./state.js";

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Basis-point haircut: `applyBps(x, 50)` is x minus 0.5%; a negative bps adds. */
export const applyBps = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n;

const whole = (cfg: VaultConfig, raw: bigint, k: number) => Number(raw) / 10 ** cfg.assets[k].decimals;

/** Market pools after the vault's own, as one list indexed like `allPools(cfg)`. */
export const allPools = (cfg: VaultConfig): Pool[] => [...cfg.pools, ...cfg.marketPools];
const poolStates = (s: VaultState): PoolState[] => [...s.pools, ...s.market];

/**
 * USD per whole token of each asset, read outward from USDC = 1. Each step prices one more asset
 * from the pool, among those pairing it with an already-priced asset, that holds the most USD on
 * its priced side, so a thin pool never sets a price a deep one disagrees with.
 */
export function prices(cfg: VaultConfig, s: VaultState): number[] {
  const pools = allPools(cfg);
  const states = poolStates(s);
  const usd: (number | undefined)[] = cfg.assets.map((a) => (a.kind === "usdc" ? 1 : undefined));
  for (;;) {
    let best: { k: number; price: number; depth: number } | null = null;
    pools.forEach((p, i) => {
      const st = states[i];
      if (st.reserveA === 0n || st.reserveB === 0n) return;
      const [wa, wb] = [whole(cfg, st.reserveA, p.a), whole(cfg, st.reserveB, p.b)];
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

/** USD value of raw amounts, one per asset. */
export const usdValue = (cfg: VaultConfig, amounts: bigint[], px: number[]) =>
  amounts.reduce((sum, x, k) => sum + whole(cfg, x, k) * px[k], 0);

/** Raw amounts behind the vault's position in vault pool `i`. */
export function positionAmounts(s: VaultState, i: number) {
  const p = s.pools[i];
  if (p.liquidity === 0n) return { a: 0n, b: 0n };
  return { a: (p.reserveA * p.position) / p.liquidity, b: (p.reserveB * p.position) / p.liquidity };
}

/** Everything the vault holds, per asset: its positions plus the idle reserves. */
export function holdings(cfg: VaultConfig, s: VaultState) {
  const out = [...s.reserves];
  cfg.pools.forEach((p, i) => {
    const { a, b } = positionAmounts(s, i);
    out[p.a] += a;
    out[p.b] += b;
  });
  return out;
}

/** USD value of the vault's position in vault pool `i`. */
export function poolValue(cfg: VaultConfig, s: VaultState, px: number[], i: number) {
  const { a, b } = positionAmounts(s, i);
  const p = cfg.pools[i];
  return whole(cfg, a, p.a) * px[p.a] + whole(cfg, b, p.b) * px[p.b];
}

/** USD value of the whole vault and of one whole share token. */
export function vaultValue(cfg: VaultConfig, s: VaultState) {
  const px = prices(cfg, s);
  const total = usdValue(cfg, holdings(cfg, s), px);
  const perShare = s.supply > 0n ? (total / Number(s.supply)) * 10 ** cfg.share.decimals : 0;
  return { px, total, perShare };
}

/** Share of the vault's value in stock tokens, USDC and SOL (0–1 each). */
export function exposure(cfg: VaultConfig, s: VaultState) {
  const px = prices(cfg, s);
  const h = holdings(cfg, s);
  const total = usdValue(cfg, h, px) || 1;
  const by = (kind: string) => cfg.assets.reduce((sum, a, k) => sum + (a.kind === kind ? whole(cfg, h[k], k) * px[k] : 0), 0) / total;
  return { stock: by("stock"), usdc: by("usdc"), sol: by("sol") };
}

/**
 * Tokens the program moves for `shares`, per asset, with its rounding: liquidity per share is
 * rounded up on deposit (down on redeem), cp-amm rounds the amounts it pulls up (pays down), and
 * the idle slice rounds the same way.
 */
export function tokensForShares(cfg: VaultConfig, s: VaultState, shares: bigint, deposit: boolean): bigint[] {
  if (s.supply === 0n) return cfg.assets.map(() => 0n);
  const div = deposit ? ceilDiv : (a: bigint, b: bigint) => a / b;
  const out = s.reserves.map((x) => div(shares * x, s.supply));
  cfg.pools.forEach((p, i) => {
    const st = s.pools[i];
    const perShare = deposit ? ceilDiv(st.position, s.supply) : st.position / s.supply;
    const dl = perShare * shares;
    if (dl === 0n || st.liquidity === 0n) return;
    out[p.a] += div(dl * st.reserveA, st.liquidity);
    out[p.b] += div(dl * st.reserveB, st.liquidity);
  });
  return out;
}

/** The most shares the given amounts (one per asset) pay for, at the given state. */
export function sharesFor(cfg: VaultConfig, s: VaultState, amounts: bigint[]) {
  if (s.supply === 0n) return 0n;
  const h = holdings(cfg, s);
  let hi = 0n;
  h.forEach((held, k) => {
    if (held === 0n) return;
    const bound = (amounts[k] * s.supply) / held + 1n;
    hi = hi === 0n || bound < hi ? bound : hi;
  });
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (tokensForShares(cfg, s, mid, true).every((x, k) => x <= amounts[k])) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * x·y = k with the pool's fee, charged in token B: on output for A→B, on input for B→A. The fee
 * rounds up, as cp-amm does, which matters on tiny swaps.
 */
export function swapOut(st: PoolState, feeBps: number, aToB: boolean, amountIn: bigint) {
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
/** One swap of a route, sized: exact `amountIn`, at least `minOut`. */
export type Swap = { pool: Pool; aToB: boolean; amountIn: bigint; minOut: bigint };

/** The best route of one or two hops from asset `from` to asset `to`, across every pool. */
export function bestRoute(cfg: VaultConfig, states: PoolState[], from: number, to: number, amountIn: bigint): Route | null {
  const pools = allPools(cfg);
  const hopsFrom = (k: number) =>
    pools.flatMap((pool, index): Hop[] => (pool.a === k ? [{ pool, index, aToB: true }] : pool.b === k ? [{ pool, index, aToB: false }] : []));
  const target = (h: Hop) => (h.aToB ? h.pool.b : h.pool.a);
  const run = (hops: Hop[]) => hops.reduce((x, h) => swapOut(states[h.index], h.pool.feeBps, h.aToB, x), amountIn);
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

/** Runs `route` on `states`, appending sized swaps; returns what the last hop guarantees. */
function takeRoute(states: PoolState[], route: Route, slippageBps: number, swaps: Swap[]) {
  let x = route.amountIn;
  for (const hop of route.hops) {
    const out = swapOut(states[hop.index], hop.pool.feeBps, hop.aToB, x);
    const min = applyBps(out, slippageBps);
    swaps.push({ pool: hop.pool, aToB: hop.aToB, amountIn: x, minOut: min });
    applySwap(states, hop, x, out);
    x = min;
  }
  return x;
}

/** Slices worth less than this are not swapped: integer rounding makes dust swaps fail their limits. */
export const MIN_SWAP_USD = 0.05;

export type ZapInPlan = {
  input: number;
  amountIn: bigint;
  /** Swaps from the input into each other asset, in order. */
  swaps: Swap[];
  /** The deposit: the most it may take of each asset, and the exact shares it mints. */
  maxAmounts: bigint[];
  /** Slices too small to swap, paid straight from the wallet's own balance (SOL is wrapped). */
  fromWallet: bigint[];
  shares: bigint;
  usdIn: number;
  usdOut: number;
};

/**
 * Pays for a deposit with one asset: splits `amountIn` across the vault's assets by their share of
 * its value, buys each through its best route (simulating each swap's price impact on the pools
 * that follow, the vault's own included), and sizes the deposit on the minimum fills.
 */
export function zapIn(cfg: VaultConfig, s: VaultState, input: number, amountIn: bigint, slippageBps: number): ZapInPlan | null {
  if (amountIn <= 0n || s.supply === 0n) return null;
  const { px, perShare } = vaultValue(cfg, s);
  const values = holdings(cfg, s).map((x, k) => whole(cfg, x, k) * px[k]);
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const states = poolStates(s);
  const swaps: Swap[] = [];
  const amounts = cfg.assets.map(() => 0n);
  const fromWallet = cfg.assets.map(() => 0n);
  let spent = 0n;
  for (let k = 0; k < cfg.assets.length; k++) {
    if (k === input || values[k] === 0) continue;
    const slice = (amountIn * BigInt(Math.floor((values[k] / total) * 1e9))) / 1_000_000_000n;
    const sliceUsd = whole(cfg, slice, input) * px[input];
    if (sliceUsd < MIN_SWAP_USD) {
      // Too small to swap, but the deposit still needs every asset: the wallet pays it, with room.
      if (px[k] > 0) fromWallet[k] = BigInt(Math.ceil(((sliceUsd * 2) / px[k]) * 10 ** cfg.assets[k].decimals)) + 1n;
      amounts[k] = fromWallet[k];
      continue;
    }
    const route = bestRoute(cfg, states, input, k, slice);
    if (!route) return null;
    amounts[k] = takeRoute(states, route, slippageBps, swaps);
    spent += slice;
  }
  amounts[input] = amountIn - spent;

  // The deposit sees the vault pools after the route's swaps.
  const after: VaultState = { ...s, pools: s.pools.map((p, i) => ({ ...p, ...states[i] })), market: states.slice(cfg.pools.length) };
  const shares = sharesFor(cfg, after, amounts);
  if (shares === 0n) return null;
  return {
    input,
    amountIn,
    swaps,
    maxAmounts: amounts,
    fromWallet,
    shares,
    usdIn: whole(cfg, amountIn, input) * px[input] + usdValue(cfg, fromWallet, px),
    usdOut: (Number(shares) / 10 ** cfg.share.decimals) * perShare,
  };
}

export type ZapOutPlan = {
  /** The redemption's minimum payout per asset. */
  minAmounts: bigint[];
  /** Swaps from every other asset into `output`, in order. */
  swaps: Swap[];
  /** The least of `output` the wallet ends with (dust under MIN_SWAP_USD stays as it is). */
  out: bigint;
  usdOut: number;
};

/** Redeems `shares` in kind, then swaps every other asset into `output`. */
export function zapOut(cfg: VaultConfig, s: VaultState, shares: bigint, output: number, slippageBps: number): ZapOutPlan | null {
  if (shares <= 0n || s.supply === 0n) return null;
  const minAmounts = tokensForShares(cfg, s, shares, false).map((x) => applyBps(x, slippageBps));
  // After the redeem the vault pools hold less; the swaps run against the reduced reserves.
  const states = poolStates(s).map((st, i) => {
    if (i >= cfg.pools.length || st.liquidity === 0n) return st;
    const dl = (s.pools[i].position / s.supply) * shares;
    return { liquidity: st.liquidity - dl, reserveA: st.reserveA - (dl * st.reserveA) / st.liquidity, reserveB: st.reserveB - (dl * st.reserveB) / st.liquidity };
  });
  const px = prices(cfg, s);
  const swaps: Swap[] = [];
  let out = minAmounts[output];
  for (let k = 0; k < cfg.assets.length; k++) {
    const amount = minAmounts[k];
    if (k === output || amount === 0n || whole(cfg, amount, k) * px[k] < MIN_SWAP_USD) continue;
    const route = bestRoute(cfg, states, k, output, amount);
    if (!route) continue;
    out += takeRoute(states, route, slippageBps, swaps);
  }
  return { minAmounts, swaps, out, usdOut: whole(cfg, out, output) * px[output] };
}
