// The basket's math against the program's own unit tests (programs/stockwoven/src/math.rs), and the
// single-token quotes on an offline state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Basket,
  BasketParams,
  DEVNET_SPCX,
  Stockwoven,
  VaultState,
  afterFee,
  amountForValue,
  basketAddress,
  decodeBasket,
  dynamicFeeBps,
  parseError,
  planSingleDeposit,
  proRata,
  toRaw,
  valueBook,
  valueOf,
  weightBps,
  withinBand,
} from "../src/index.js";

const cfg = DEVNET_SPCX;
const [SPCXX, SPCX, SPCXON, USDC, SOL] = ["SPCXx", "SPCX", "SPCXon", "USDC", "SOL"].map((s) => cfg.assets.findIndex((a) => a.symbol === s));
const params: BasketParams = { bandBps: 200, baseFeeBps: 5, feeSlopeBps: 2, maxFeeBps: 100, maxDiscountBps: 3, maxPriceAge: 600 };

test("dynamic fee: the program's unit-test numbers", () => {
  assert.equal(dynamicFeeBps(3_000, 3_000, 3_000, true, params), 5);
  assert.equal(dynamicFeeBps(3_000, 3_000, 3_000, false, params), 5);
  assert.equal(dynamicFeeBps(3_900, 4_100, 3_000, true, params), 25);
  assert.equal(dynamicFeeBps(1_000, 1_200, 3_000, true, params), -3);
  assert.equal(dynamicFeeBps(1_200, 1_000, 3_000, false, params), 43);
  assert.equal(dynamicFeeBps(4_100, 3_900, 3_000, false, params), -3);
  assert.equal(dynamicFeeBps(10_000, 10_000, 0, true, params), 100);
  // Rust truncates toward zero: −151 points × 2 / 100 is −3, not −4.
  assert.equal(dynamicFeeBps(2_849, 2_849, 3_000, true, { ...params, maxDiscountBps: 100 }), 2);
});

test("values, amounts, pro-rata and bands: the program's unit-test numbers", () => {
  assert.equal(valueOf(1_000_000n, 6, 1_000_000_000n), 1_000_000_000n);
  assert.equal(valueOf(1_000_000_000n, 9, 1_000_000_000n), 1_000_000_000n);
  assert.equal(valueOf(175_000_000n, 6, 5_714_285n), 999_999_875n);
  assert.equal(amountForValue(1_000_000_000n, 8, 1_000_000_000n), 100_000_000n);
  assert.equal(afterFee(10_000n, 25), 9_975n);
  assert.equal(afterFee(10_000n, -3), 10_003n);
  assert.equal(proRata(1_000n, 1n, 4n), 250n);
  const whole = 3n << 100n;
  const max = (1n << 64n) - 1n;
  assert.equal(proRata(max, whole / 3n, whole), max / 3n);
  assert.equal(proRata(7n, 5n, 0n), 0n);
  assert.ok(withinBand(1_000n, 1_020n, 200));
  assert.ok(!withinBand(1_000n, 1_021n, 200));
  assert.equal(weightBps(1n, 3n), 3_333);
});

/** A Basket account as the program writes it. */
function encodeBasket(b: Basket) {
  const data = new Uint8Array(142);
  const view = new DataView(data.buffer);
  data[40] = 255;
  [b.params.bandBps, b.params.baseFeeBps, b.params.feeSlopeBps, b.params.maxFeeBps, b.params.maxDiscountBps].forEach((x, i) => view.setUint16(41 + 2 * i, x, true));
  view.setUint32(51, b.params.maxPriceAge, true);
  data[55] = b.numAssets;
  b.assets.forEach((a, k) => {
    const o = 56 + k * 13;
    data[o] = a.isStock ? 1 : 0;
    view.setUint16(o + 1, a.targetWeightBps, true);
    view.setUint16(o + 3, a.maxWeightBps, true);
    view.setBigUint64(o + 5, a.price, true);
  });
  view.setBigInt64(134, BigInt(b.pricesUpdatedAt), true);
  return data;
}

const now = Math.floor(Date.now() / 1000);
const L = 10n ** 20n;
const pool = (a: bigint, b: bigint, share = 9n) => ({ liquidity: L, reserveA: a, reserveB: b, position: (L * share) / 10n });
const share = (usd: number) => BigInt(Math.round((usd / 168) * 1e9));

/**
 * The devnet vault at SpaceX $168 and SOL $116, every pool at the keeper's prices. SPCXx ends up at
 * ~37.6% of the value (its cap is 37.65%), SPCX ~31% (target 25%), SPCXon ~14% (target 25%).
 */
const basket: Basket = {
  params,
  numAssets: 5,
  assets: [
    { isStock: true, targetWeightBps: 3_000, maxWeightBps: 3_765, price: share(168) },
    { isStock: true, targetWeightBps: 2_500, maxWeightBps: 4_000, price: share(168) },
    { isStock: true, targetWeightBps: 2_500, maxWeightBps: 4_000, price: share(168) },
    { isStock: false, targetWeightBps: 1_000, maxWeightBps: 10_000, price: share(1) },
    { isStock: false, targetWeightBps: 1_000, maxWeightBps: 10_000, price: share(116) },
  ],
  pricesUpdatedAt: now - 30,
};
const state: VaultState = {
  slot: 1,
  supply: 400n * 10n ** 8n,
  reserves: [10n ** 8n, 0n, 0n, 100n * 10n ** 6n, 0n],
  pools: [
    pool(100n * 10n ** 8n, 100n * 10n ** 6n), // SPCXx / SPCX
    pool(50n * 10n ** 9n, 50n * 10n ** 8n), // SPCXon / SPCXx
    pool(50n * 10n ** 6n, 8_400n * 10n ** 6n), // SPCX / USDC
    pool(34_500_000n, 500_000_000n), // SPCXx / SOL
  ],
  market: [
    { liquidity: L, reserveA: 100n * 10n ** 8n, reserveB: 16_800n * 10n ** 6n }, // SPCXx / USDC
    { liquidity: L, reserveA: 50n * 10n ** 9n, reserveB: 8_400n * 10n ** 6n }, // SPCXon / USDC
    { liquidity: L, reserveA: 2n * 10n ** 9n, reserveB: 232n * 10n ** 6n }, // SOL / USDC
  ],
  weights: [4_700, 2_400, 2_400, 0],
  depositsPaused: false,
  basket,
};
const vault = { decimals: cfg.assets.map((a) => a.decimals), pools: cfg.pools, marketPools: cfg.marketPools };
const offline = new Stockwoven({ connection: new Connection("http://127.0.0.1:1") });
const owner = new PublicKey("Dwrba3bghFaRnE6RqGmRHLRKd4QqUr9Bz38Dt8KxQD1D");

test("the basket account decodes and lives at [basket, vault]", () => {
  assert.deepEqual(decodeBasket(encodeBasket(basket)), basket);
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("basket"), cfg.vault.toBuffer()], cfg.program);
  assert.ok(basketAddress(cfg.program, cfg.vault).equals(expected));
});

test("the fixture's weights", () => {
  const b = valueBook(vault, basket, state)!;
  assert.ok(b.weights[SPCXX] > 3_600 && b.weights[SPCXX] < 3_765, `SPCXx ${b.weights[SPCXX]}`);
  assert.ok(b.weights[SPCX] > b.weights[SPCXON], `SPCX ${b.weights[SPCX]}, SPCXon ${b.weights[SPCXON]}`);
  assert.ok(b.weights[SPCXON] < 2_500);
});

test("an underweight issuer token goes in alone, 1:1, at a discount", async () => {
  const q = await offline.quoteDeposit({ pay: "SPCXon", amount: toRaw("1", 9) }, state);
  assert.equal(q.route, "single");
  assert.equal(q.into?.symbol, "SPCXon");
  assert.equal(q.feeBps, -3);
  assert.equal(q.redirect, undefined);
  const p = q.plan.route === "single" ? q.plan.single : null;
  assert.ok(p && !p.convert && !p.preSwap);
  // One share in, a bit over one share's worth of swSPCX out (the discount), at the vault's NAV.
  assert.ok(q.minShares < q.shares && q.minShares > (q.shares * 99n) / 100n);
  const steps = offline.depositSteps(q, owner);
  assert.equal(steps.length, 1, "one transaction");
  const deposit = steps[0].find((ix) => ix.programId.equals(cfg.program))!;
  assert.deepEqual([...deposit.data.subarray(0, 8)], [116, 81, 213, 110, 17, 83, 209, 188]);
  assert.equal(deposit.keys.length, 13 + 5 * 2 + 4 * 5);
});

test("a token at its cap is converted by the vault into an underweight one", async () => {
  // Half an SPCXx would take it past its cap.
  const q = await offline.quoteDeposit({ pay: "SPCXx", amount: toRaw("0.5", 8) }, state);
  assert.equal(q.route, "single");
  assert.equal(q.redirect, "cap");
  assert.notEqual(q.into?.symbol, "SPCXx");
  const p = q.plan.route === "single" ? q.plan.single : null;
  assert.ok(p?.convert, "converted on-chain");
  assert.equal(p!.mint, SPCXX);
  const deposit = offline.depositSteps(q, owner)[0].find((ix) => ix.programId.equals(cfg.program))!;
  assert.equal(deposit.keys.length, 13 + 5 * 2 + 4 * 5 + 5);
});

test("USDC goes into the most underweight issuer token; SOL is swapped to USDC first if it must", async () => {
  const usdc = await offline.quoteDeposit({ pay: "USDC", amount: toRaw("100", 6) }, state);
  assert.equal(usdc.route, "single");
  assert.equal(usdc.redirect, "quote");
  assert.equal(usdc.into?.symbol, "SPCXon");
  assert.ok(usdc.valueUsd > 100 * 0.98 && usdc.valueUsd < 100.5, String(usdc.valueUsd));

  const sol = await offline.quoteDeposit({ pay: "SOL", amount: toRaw("0.02", 9) }, state);
  assert.equal(sol.route, "single");
  const p = sol.plan.route === "single" ? sol.plan.single : null;
  assert.ok(p && (p.preSwap || p.convert));
  const ixs = offline.depositSteps(sol, owner)[0];
  assert.ok(ixs.some((ix) => ix.programId.equals(cfg.program)));
});

test("the breaker falls back to swapping into the mix, and says why", async () => {
  const stale = { ...state, basket: { ...basket, pricesUpdatedAt: now - 3_600 } };
  const q = await offline.quoteDeposit({ pay: "SPCXon", amount: toRaw("0.2", 9) }, stale);
  assert.equal(q.route, "swap");
  assert.match(q.fallbackReason!, /out of date/);

  // SPCXon 3% under SPCXx: its vault pool now sits off the keeper's 1:1 prices.
  const offBand = { ...basket, assets: basket.assets.map((a, k) => (k === SPCXON ? { ...a, price: share(168 * 0.97) } : a)) };
  const r = planSingleDeposit(vault, offBand, state, SPCX, toRaw("1", 6), now, 50);
  assert.ok("refused" in r && r.refused.kind === "PoolOutOfBand");
  // With the pool moved there too, only SPCXon is refused.
  const moved = { ...state, pools: state.pools.map((p, i) => (i === 1 ? { ...p, reserveA: (p.reserveA * 100n) / 97n } : p)) };
  const ondo = planSingleDeposit(vault, offBand, moved, SPCXON, toRaw("1", 9), now, 50);
  assert.ok("plan" in ondo, "converted elsewhere");
  assert.notEqual("plan" in ondo && ondo.plan.into, SPCXON);
  assert.ok("plan" in planSingleDeposit(vault, offBand, moved, SPCX, toRaw("1", 6), now, 50));

  const none = await offline.quoteDeposit({ pay: "SPCXon", amount: toRaw("0.2", 9) }, { ...state, basket: null });
  assert.equal(none.route, "swap");
});

test("redemptions: one issuer token alone, or sold for USDC in the same transaction", async () => {
  const x = await offline.quoteRedeem(10n ** 8n, { receive: "SPCXx" }, state);
  assert.equal(x.plan.route, "single");
  assert.ok(x.feeBps! < 5, "SPCXx is overweight: redeeming it costs less than the base fee");
  const on = await offline.quoteRedeem(10n ** 8n, { receive: "SPCXon" }, state);
  assert.ok(on.feeBps! > x.feeBps!, "SPCXon is underweight: it costs more");

  const cash = await offline.quoteRedeem(10n ** 8n, { receive: "USDC" }, state);
  assert.equal(cash.plan.route, "single");
  assert.ok(cash.via?.kind === "stock");
  assert.ok(cash.plan.route === "single" && cash.plan.swaps.length >= 1);
  assert.ok(Number(cash.payout[0].min) / 1e6 > cash.valueUsd * 0.97, `${cash.payout[0].min} for ${cash.valueUsd}`);
  const steps = offline.redeemSteps(cash, owner);
  assert.equal(steps.length, 1);
  const redeem = steps[0].find((ix) => ix.programId.equals(cfg.program))!;
  assert.deepEqual([...redeem.data.subarray(0, 8)], [99, 237, 186, 22, 18, 172, 251, 95]);

  const kind = await offline.quoteRedeem(10n ** 8n, {}, state);
  assert.equal(kind.plan.route, "kind");
});

test("getVault reports the basket", async () => {
  const v = await offline.getVault(state);
  assert.equal(v.basket?.status, "open");
  const ondo = v.basket!.assets[SPCXON];
  assert.equal(ondo.depositFeeBps, -3);
  assert.equal(ondo.pegged, true);
  assert.equal(v.basket!.assets[USDC].isStock, false);
  assert.equal((await offline.getVault({ ...state, basket: null })).basket, null);
  const stale = await offline.getVault({ ...state, basket: { ...basket, pricesUpdatedAt: now - 3_600 } });
  assert.equal(stale.basket?.status, "stale");
  void SOL;
});

test("the basket's errors", () => {
  assert.equal(parseError({ message: '{"InstructionError":[3,{"Custom":6025}]}' }).kind, "InvalidBasket");
  assert.equal(parseError({ message: "Error Code: TokenDepegged." }).kind, "TokenDepegged");
  assert.equal(parseError({ message: '{"InstructionError":[3,{"Custom":6032}]}' }).kind, "InsufficientLiquidity");
});
