// The swSPCX keeper. Every tick it:
// 1. arbitrages: finds swap cycles of 2–3 hops across the vault's pools and the market pools that
//    end with more of the token they started from, sizes each one, and runs the best through the
//    program's `arbitrage` (which only lands if the vault ends richer);
// 2. sets target weights from each pool's observed fee yield (`set_pool_weights`), keeping a
//    small idle buffer that funds arbitrage;
// 3. rebalances towards the targets: takes liquidity out of overweight pools, swaps the idle
//    tokens into the pair an underweight pool needs, and adds it there;
// 4. harvests the protocol's cut from every pool once an hour.
//
//   KEYPAIR=//wsl.localhost/Ubuntu/home/pedro/.config/solana/id.json npx tsx scripts/keeper.ts [--once]
//
// The keeper is trusted to choose sizes and prices (it signs with the vault's keeper key), but it
// cannot mint shares or move funds out of the vault, and every arbitrage is checked on-chain.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  Devnet,
  Hop,
  PoolInfo,
  PoolState,
  VaultState,
  admin,
  arbitrageIx,
  ata,
  harvestIx,
  holdings,
  lookupTable,
  pk,
  positionAmounts,
  prices,
  quoteSwap,
  readDevnet,
  readState,
  rebalanceAddIx,
  rebalanceRemoveIx,
  sendV0,
  setPoolWeightsIx,
  valueOf,
  vaultSwapIx,
} from "./sw.ts";

const INTERVAL_SEC = Number(process.env.KEEPER_INTERVAL_SEC ?? 60);
const MIN_ARB_PROFIT_USD = Number(process.env.MIN_ARB_PROFIT_USD ?? 0.01);
/** Share of the vault's value left idle as working capital for arbitrage. */
const IDLE_BUFFER_BPS = 500;
/** A pool is rebalanced once it is this far from its target, relative to the target. */
const REBALANCE_BAND = 0.15;
const MIN_MOVE_USD = 5;
/** No single vault swap takes more than this share of the input side of a pool. */
const MAX_IMPACT = 0.02;
/** Weights move by at most this much per tick. */
const MAX_WEIGHT_STEP_BPS = 500;
const HARVEST_EVERY_SEC = 3_600;
const STATE_FILE = new URL("./keeper-state.json", import.meta.url);

type Snapshot = { ts: number; growth: number[] };
type KeeperState = { snapshots: Snapshot[]; lastHarvest: number };

const loadState = (): KeeperState =>
  existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { snapshots: [], lastHarvest: 0 };
const saveState = (k: KeeperState) => writeFileSync(STATE_FILE, JSON.stringify(k, null, 2) + "\n");

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmt = (usd: number) => `$${usd.toFixed(2)}`;

type Edge = { info: PoolInfo; state: PoolState };

function edges(d: Devnet, s: VaultState): Edge[] {
  return [
    ...d.pools.map((info, i) => ({ info, state: s.pools[i] })),
    ...d.marketPools.map((info, i) => ({ info, state: s.market[i] })),
  ];
}

// ---- 1. arbitrage ---------------------------------------------------------------------------

type Cycle = { hops: { edge: Edge; aToB: boolean }[]; start: number };

/** Simple cycles of 2–3 hops that start and end at `start`. */
function cycles(all: Edge[], start: number): Cycle[] {
  const out: Cycle[] = [];
  const step = (e: Edge, from: number) => (e.info.a === from ? { aToB: true, to: e.info.b } : e.info.b === from ? { aToB: false, to: e.info.a } : null);
  for (const e1 of all) {
    const h1 = step(e1, start);
    if (!h1) continue;
    for (const e2 of all) {
      if (e2 === e1) continue;
      const h2 = step(e2, h1.to);
      if (!h2) continue;
      if (h2.to === start) {
        out.push({ start, hops: [{ edge: e1, aToB: h1.aToB }, { edge: e2, aToB: h2.aToB }] });
        continue;
      }
      for (const e3 of all) {
        if (e3 === e1 || e3 === e2) continue;
        const h3 = step(e3, h2.to);
        if (h3 && h3.to === start) out.push({ start, hops: [{ edge: e1, aToB: h1.aToB }, { edge: e2, aToB: h2.aToB }, { edge: e3, aToB: h3.aToB }] });
      }
    }
  }
  return out;
}

const runCycle = (c: Cycle, amountIn: bigint) =>
  c.hops.reduce((x, h) => (x > 0n ? quoteSwap(h.edge.state, h.edge.info.feeBps, h.aToB, x) : 0n), amountIn);

/** The amount in (≤ `cap`) that maximizes profit; profit is concave in the amount for x·y = k pools. */
function bestSize(c: Cycle, cap: bigint) {
  let [lo, hi] = [0n, cap];
  while (hi - lo > 2n) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    if (runCycle(c, m1) - m1 < runCycle(c, m2) - m2) lo = m1;
    else hi = m2;
  }
  const x = (lo + hi) / 2n;
  return { amountIn: x, profit: runCycle(c, x) - x };
}

function findArbitrage(d: Devnet, s: VaultState, px: number[]) {
  const all = edges(d, s);
  let best: { cycle: Cycle; amountIn: bigint; profit: bigint; usd: number } | null = null;
  d.assets.forEach((asset, k) => {
    const idle = s.reserves[k];
    if (idle === 0n || px[k] === 0) return;
    for (const c of cycles(all, k)) {
      // Keep each hop within the impact cap of its first pool.
      const first = c.hops[0];
      const depth = first.aToB ? first.edge.state.reserveA : first.edge.state.reserveB;
      const cap = idle < (depth * 2n) / 100n ? idle : (depth * 2n) / 100n;
      const { amountIn, profit } = bestSize(c, cap);
      const usd = (Number(profit) / 10 ** asset.decimals) * px[k];
      if (profit > 0n && (!best || usd > best.usd)) best = { cycle: c, amountIn, profit, usd };
    }
  });
  return best as { cycle: Cycle; amountIn: bigint; profit: bigint; usd: number } | null;
}

async function arbitrage(d: Devnet) {
  const tables = await lookupTable(d);
  for (let round = 0; round < 3; round++) {
    const s = await readState(d);
    const px = prices(d, s);
    const found = findArbitrage(d, s, px);
    if (!found || found.usd < MIN_ARB_PROFIT_USD) {
      if (round === 0) log("arbitrage: no cycle above", fmt(MIN_ARB_PROFIT_USD));
      return;
    }
    const route: Hop[] = found.cycle.hops.map((h) => ({ pool: h.edge.info, aToB: h.aToB }));
    const path = [d.assets[found.cycle.start].symbol, ...found.cycle.hops.map((h) => d.assets[h.aToB ? h.edge.info.b : h.edge.info.a].symbol)].join(" → ");
    try {
      // Ask for half the quoted profit: the program rejects the cycle if it earns less.
      const sig = await sendV0([arbitrageIx(d, route, found.amountIn, found.profit / 2n || 1n)], [admin], tables, 600_000);
      log(`arbitrage ${path}: ~${fmt(found.usd)} profit`, sig);
    } catch (e) {
      log(`arbitrage ${path} failed:`, String(e).slice(0, 200));
      return;
    }
  }
}

// ---- 2. target weights from observed yield --------------------------------------------------

/**
 * Fee growth of a full-range pool: sqrt(reserveA · reserveB) / liquidity. Price moves leave it
 * unchanged on x·y = k, and compounded fees raise it, so its growth rate is the pool's fee yield.
 */
const growthIndex = (p: PoolState) => Math.sqrt(Number(p.reserveA) * Number(p.reserveB)) / Number(p.liquidity);

function observedYields(k: KeeperState, s: VaultState): number[] | null {
  const now = Date.now() / 1000;
  const growth = s.pools.map(growthIndex);
  k.snapshots.push({ ts: now, growth });
  k.snapshots = k.snapshots.filter((x) => now - x.ts < 86_400);
  const oldest = k.snapshots[0];
  const dt = now - oldest.ts;
  if (dt < 600) return null; // need ten minutes of history
  return growth.map((g, i) => Math.max(0, (g / oldest.growth[i] - 1) * (365 * 86_400) / dt));
}

async function updateWeights(d: Devnet, k: KeeperState) {
  const s = await readState(d);
  const yields = observedYields(k, s);
  if (!yields) return log("weights: collecting yield history");
  const total = yields.reduce((a, b) => a + b, 0);
  if (total === 0) return log("weights: no fees yet");
  const budget = 10_000 - IDLE_BUFFER_BPS;
  const ideal = yields.map((y) => (y / total) * budget);
  const next = s.weights.map((w, i) => Math.round(w + Math.max(-MAX_WEIGHT_STEP_BPS, Math.min(MAX_WEIGHT_STEP_BPS, ideal[i] - w))));
  // Keep the sum within the budget after rounding and step limits.
  const over = next.reduce((a, b) => a + b, 0) - budget;
  if (over > 0) next[next.indexOf(Math.max(...next))] -= over;
  const yieldsText = yields.map((y, i) => `${d.pools[i].label} ${(y * 100).toFixed(1)}%`).join(", ");
  if (next.every((w, i) => Math.abs(w - s.weights[i]) < 100)) return log("weights unchanged; yields:", yieldsText);
  const sig = await sendV0([setPoolWeightsIx(d, next)], [admin]);
  log("weights", next.join("/"), "from yields:", yieldsText, sig);
}

// ---- 3. rebalance ---------------------------------------------------------------------------

const poolValue = (d: Devnet, s: VaultState, px: number[], i: number) => {
  const { a, b } = positionAmounts(s, i);
  const p = d.pools[i];
  return (Number(a) / 10 ** d.assets[p.a].decimals) * px[p.a] + (Number(b) / 10 ** d.assets[p.b].decimals) * px[p.b];
};

const raw = (d: Devnet, k: number, usd: number, px: number[]) => BigInt(Math.floor((usd / px[k]) * 10 ** d.assets[k].decimals));
const capped = (x: bigint, depth: bigint) => (x < (depth * BigInt(MAX_IMPACT * 1000)) / 1000n ? x : (depth * BigInt(MAX_IMPACT * 1000)) / 1000n);

async function rebalance(d: Devnet) {
  const tables = await lookupTable(d);
  let s = await readState(d);
  let px = prices(d, s);
  const total = valueOf(d, px, holdings(d, s));
  const target = s.weights.map((w) => (w / 10_000) * total);

  // What the underweight pools can take this tick: each balancing swap is capped at MAX_IMPACT of
  // the pool, so a pool absorbs about twice that share of its own value, plus idle tokens.
  const values = d.pools.map((_, i) => poolValue(d, s, px, i));
  const absorbable =
    d.pools.reduce((sum, _, i) => {
      const deficit = target[i] - values[i];
      return deficit > MIN_MOVE_USD && values[i] < target[i] * (1 - REBALANCE_BAND) ? sum + Math.min(deficit, 2 * MAX_IMPACT * values[i]) : sum;
    }, 0) - valueOf(d, px, s.reserves);
  const excess = d.pools.reduce((sum, _, i) => sum + Math.max(0, values[i] - target[i]), 0);
  // Take out only what can be placed, in proportion to each pool's excess.
  const scale = excess > 0 ? Math.max(0, Math.min(1, absorbable / excess)) : 0;

  // Overweight pools: move that part of the excess to the reserves.
  const removes: TransactionInstruction[] = [];
  // Keep the idle buffer that funds arbitrage: below half of it, refill it from every pool pro rata.
  const idleNow = valueOf(d, px, s.reserves);
  const buffer = (IDLE_BUFFER_BPS / 10_000) * total;
  if (idleNow < buffer / 2 && scale === 0) {
    const share = (buffer - idleNow) / (total - idleNow);
    d.pools.forEach((_, i) => {
      if (values[i] * share > MIN_MOVE_USD) removes.push(rebalanceRemoveIx(d, i, (s.pools[i].position * BigInt(Math.floor(share * 1e6))) / 1_000_000n));
    });
    log(`rebalance: refilling the idle buffer to ${fmt(buffer)} for arbitrage`);
  }
  d.pools.forEach((p, i) => {
    const v = values[i];
    const move = (v - target[i]) * scale;
    if (v > target[i] * (1 + REBALANCE_BAND) && move > MIN_MOVE_USD) {
      removes.push(rebalanceRemoveIx(d, i, (s.pools[i].position * BigInt(Math.floor((move / v) * 1e6))) / 1_000_000n));
      log(`rebalance: ${p.label} ${fmt(v)} (target ${fmt(target[i])}), taking ${fmt(move)} out`);
    }
  });
  if (removes.length) await sendV0(removes, [admin], tables);

  // Underweight pools: swap idle tokens into each pool's pair, balance the pair, add it.
  s = await readState(d);
  px = prices(d, s);
  const all = edges(d, s);
  for (const [i, p] of d.pools.entries()) {
    const v = poolValue(d, s, px, i);
    const deficit = target[i] - v;
    if (deficit < MIN_MOVE_USD || v > target[i] * (1 - REBALANCE_BAND)) continue;
    const ixs: TransactionInstruction[] = [];
    const idle = [...s.reserves];
    let budget = deficit;
    // 1. Convert idle tokens outside the pair through a direct pool into one side of the pair.
    for (const [k, amount] of idle.entries()) {
      if (k === p.a || k === p.b || amount === 0n || budget <= 0) continue;
      const route = all.find((e) => (e.info.a === k && (e.info.b === p.a || e.info.b === p.b)) || (e.info.b === k && (e.info.a === p.a || e.info.a === p.b)));
      if (!route) continue;
      const aToB = route.info.a === k;
      const depth = aToB ? route.state.reserveA : route.state.reserveB;
      const want = raw(d, k, budget, px);
      const amountIn = capped(want < amount ? want : amount, depth);
      if (amountIn === 0n) continue;
      const out = quoteSwap(route.state, route.info.feeBps, aToB, amountIn);
      ixs.push(vaultSwapIx(d, route.info, aToB, amountIn, (out * 99n) / 100n));
      idle[k] -= amountIn;
      idle[aToB ? route.info.b : route.info.a] += (out * 99n) / 100n;
      budget -= (Number(amountIn) / 10 ** d.assets[k].decimals) * px[k];
    }
    // 2. Even out the pair's two sides by value with a swap on the pool itself.
    const pool = s.pools[i];
    const va = (Number(idle[p.a]) / 10 ** d.assets[p.a].decimals) * px[p.a];
    const vb = (Number(idle[p.b]) / 10 ** d.assets[p.b].decimals) * px[p.b];
    if (Math.abs(va - vb) > 1) {
      const aToB = va > vb;
      const k = aToB ? p.a : p.b;
      const amountIn = capped(raw(d, k, Math.abs(va - vb) / 2, px), aToB ? pool.reserveA : pool.reserveB);
      if (amountIn > 0n) ixs.push(vaultSwapIx(d, p, aToB, amountIn, (quoteSwap(pool, p.feeBps, aToB, amountIn) * 99n) / 100n));
    }
    // 3. Add everything both sides cover.
    ixs.push(rebalanceAddIx(d, i));
    try {
      const sig = await sendV0(ixs, [admin], tables);
      log(`rebalance: added to ${p.label} (deficit ${fmt(deficit)})`, sig);
    } catch (e) {
      log(`rebalance into ${p.label} failed:`, String(e).slice(0, 200));
    }
    s = await readState(d);
  }

  // Whatever could not be placed goes back into the pools it covers, down to the idle buffer.
  // Adding and removing liquidity is free, so this costs nothing but the transaction.
  px = prices(d, s);
  const idleUsd = valueOf(d, px, s.reserves);
  if (idleUsd > ((IDLE_BUFFER_BPS * 2) / 10_000) * total) {
    const ixs = d.pools.flatMap((p, i) => {
      const st = s.pools[i];
      const coverable = st.reserveA > 0n && st.reserveB > 0n && (s.reserves[p.a] * st.liquidity) / st.reserveA > 0n && (s.reserves[p.b] * st.liquidity) / st.reserveB > 0n;
      return coverable ? [rebalanceAddIx(d, i)] : [];
    });
    if (ixs.length) {
      try {
        const sig = await sendV0(ixs, [admin], tables);
        log(`rebalance: put ${fmt(idleUsd)} of idle tokens back into the pools they cover`, sig);
      } catch (e) {
        log("returning idle tokens failed:", String(e).slice(0, 200));
      }
    }
  }
}

// ---- 4. harvest -----------------------------------------------------------------------------

async function harvest(d: Devnet, k: KeeperState) {
  if (Date.now() / 1000 - k.lastHarvest < HARVEST_EVERY_SEC) return;
  // Harvest pays each pool's fee token into the treasury's account for it; open any that is missing.
  const feeTokens = [...new Set(d.pools.map((p) => d.assets[p.b]))];
  const open = feeTokens.map((a) =>
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(pk(d.treasury), pk(a.mint), pk(a.tokenProgram)), pk(d.treasury), pk(a.mint), pk(a.tokenProgram)),
  );
  const sig = await sendV0([...open, ...d.pools.map((_, i) => harvestIx(d, i, admin.publicKey))], [admin], await lookupTable(d));
  k.lastHarvest = Date.now() / 1000;
  log("harvested every pool's protocol fee to the treasury", sig);
}

async function report(d: Devnet) {
  const s = await readState(d);
  const px = prices(d, s);
  const total = valueOf(d, px, holdings(d, s));
  const perShare = (total / Number(s.supply)) * 1e8;
  const pools = d.pools.map((p, i) => `${p.label} ${fmt(poolValue(d, s, px, i))} (target ${(s.weights[i] / 100).toFixed(0)}%)`).join(", ");
  const idle = valueOf(d, px, s.reserves);
  log(`vault ${fmt(total)} · 1 swSPCX = ${fmt(perShare)} · ${pools} · idle ${fmt(idle)}`);
}

async function tick() {
  const d = readDevnet();
  const k = loadState();
  try {
    await arbitrage(d);
    await updateWeights(d, k);
    await rebalance(d);
    await harvest(d, k);
    await report(d);
  } catch (e) {
    log("tick failed:", String(e).slice(0, 300));
  } finally {
    saveState(k);
  }
}

async function main() {
  log("keeper", admin.publicKey.toBase58());
  await tick();
  if (process.argv.includes("--once")) return;
  setInterval(tick, INTERVAL_SEC * 1000);
}

main();
