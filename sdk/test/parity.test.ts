// The SDK and the devnet app (app/src/lib) must quote the same numbers: the app is what runs on
// devnet today. This guards against the two copies of the math drifting apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as app from "../../app/src/lib/stockwoven.js";
import { DEVNET_SPCX, VaultState, planSingleDeposit, planSingleRedeem, prices, sharesFor, tokensForShares, zapIn, zapOut } from "../src/index.js";

const devnet = JSON.parse(readFileSync(new URL("../../app/src/lib/devnet.json", import.meta.url), "utf8"));
const cfg = DEVNET_SPCX;

test("the devnet preset matches the app's devnet.json", () => {
  const same = (a: { toBase58(): string }, b: string, what: string) => assert.equal(a.toBase58(), b, what);
  same(cfg.program, devnet.program, "program");
  same(cfg.vault, devnet.vault, "vault");
  same(cfg.share.mint, devnet.shareMint, "shareMint");
  same(cfg.treasury, devnet.treasury, "treasury");
  same(cfg.lookupTable, devnet.lookupTable, "lookupTable");
  assert.equal(cfg.arbFeeBps, devnet.arbFeeBps);
  assert.equal(cfg.assets.length, devnet.assets.length);
  cfg.assets.forEach((a, k) => {
    const d = devnet.assets[k];
    assert.equal(a.symbol, d.symbol);
    assert.equal(a.decimals, d.decimals);
    same(a.mint, d.mint, `${a.symbol} mint`);
    same(a.reserve, d.reserve, `${a.symbol} reserve`);
    same(a.program, d.tokenProgram, `${a.symbol} program`);
  });
  for (const [list, json] of [[cfg.pools, devnet.pools], [cfg.marketPools, devnet.marketPools]] as const) {
    assert.equal(list.length, json.length);
    list.forEach((p, i) => {
      const d = json[i];
      same(p.pool, d.pool, p.label);
      same(p.tokenAVault, d.tokenAVault, `${p.label} vault A`);
      same(p.tokenBVault, d.tokenBVault, `${p.label} vault B`);
      assert.equal(p.a, d.a);
      assert.equal(p.b, d.b);
      assert.equal(p.feeBps, d.feeBps);
      if (d.position) {
        same(p.position!, d.position, `${p.label} position`);
        same(p.positionNftAccount!, d.positionNftAccount, `${p.label} nft account`);
      }
    });
  }
});

// Deterministic pseudo-random states around the devnet vault.
function* states(count: number): Generator<VaultState> {
  let seed = 11n;
  const rand = (lo: bigint, hi: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 63n);
    return lo + (seed % (hi - lo));
  };
  const pool = (a: bigint, b: bigint) => {
    const liquidity = rand(10n ** 19n, 10n ** 21n);
    return { liquidity, reserveA: rand(a / 2n, a * 2n), reserveB: rand(b / 2n, b * 2n), position: rand(liquidity / 2n, liquidity) };
  };
  for (let i = 0; i < count; i++) {
    yield {
      slot: i,
      supply: rand(10n ** 10n, 10n ** 11n),
      reserves: [rand(0n, 10n ** 9n), rand(0n, 10n ** 7n), rand(0n, 10n ** 10n), rand(0n, 10n ** 9n), rand(0n, 10n ** 8n)],
      pools: [pool(10n ** 10n, 10n ** 8n), pool(5n * 10n ** 10n, 5n * 10n ** 9n), pool(5n * 10n ** 7n, 84n * 10n ** 8n), pool(34n * 10n ** 6n, 5n * 10n ** 8n)],
      market: [
        { liquidity: 10n ** 20n, reserveA: rand(5n * 10n ** 9n, 2n * 10n ** 10n), reserveB: rand(10n ** 10n, 3n * 10n ** 10n) },
        { liquidity: 10n ** 20n, reserveA: rand(3n * 10n ** 10n, 10n ** 11n), reserveB: rand(5n * 10n ** 9n, 10n ** 10n) },
        { liquidity: 10n ** 20n, reserveA: rand(10n ** 9n, 3n * 10n ** 9n), reserveB: rand(10n ** 8n, 4n * 10n ** 8n) },
      ],
      weights: [4_700, 2_400, 2_400, 0],
      depositsPaused: false,
    };
  }
}

test("prices, pro-rata amounts and shares match the app", () => {
  for (const s of states(25)) {
    assert.deepEqual(prices(cfg, s), app.prices(s));
    for (const shares of [1n, 999_999n, 10n ** 8n]) {
      assert.deepEqual(tokensForShares(cfg, s, shares, true), app.quoteShares(s, shares, true));
      assert.deepEqual(tokensForShares(cfg, s, shares, false), app.quoteShares(s, shares, false));
    }
    const amounts = app.quoteShares(s, 10n ** 8n, true);
    assert.equal(sharesFor(cfg, s, amounts), app.sharesFor(s, amounts));
  }
});

test("one-token deposits and redemptions to USDC match the app", () => {
  const USDC = cfg.assets.findIndex((a) => a.kind === "usdc");
  for (const s of states(15)) {
    for (const [k, amount] of [[USDC, 100_000_000n], [0, 50_000_000n], [1, 500_000n], [2, 500_000_000n], [4, 100_000_000n]] as const) {
      const sdk = zapIn(cfg, s, k, amount, Number(app.ROUTE_SLIPPAGE_BPS));
      const ours = app.quoteZapIn(s, k, amount);
      assert.equal(sdk?.shares ?? null, ours?.shares ?? null, `asset ${k}`);
      assert.deepEqual(sdk?.maxAmounts ?? null, ours?.maxAmounts ?? null);
      assert.deepEqual(sdk?.fromWallet ?? null, ours?.fromWallet ?? null);
      assert.deepEqual(sdk?.swaps.map((x) => [x.pool.pool.toBase58(), x.aToB, x.amountIn, x.minOut]) ?? null, ours?.swaps.map((x) => [x.pool.pool.toBase58(), x.aToB, x.amountIn, x.minOut]) ?? null);
    }
    const out = zapOut(cfg, s, 10n ** 8n, USDC, Number(app.ROUTE_SLIPPAGE_BPS));
    const theirs = app.quoteZapOut(s, 10n ** 8n, USDC);
    assert.equal(out?.out ?? null, theirs?.out ?? null);
    assert.deepEqual(out?.minAmounts ?? null, theirs?.amounts ?? null);
  }
});

test("the basket math is one file, shared byte for byte with the app", () => {
  const sdk = readFileSync(new URL("../src/basket.ts", import.meta.url), "utf8");
  const ours = readFileSync(new URL("../../app/src/lib/basket.ts", import.meta.url), "utf8");
  assert.equal(ours, sdk, "copy sdk/src/basket.ts to app/src/lib/basket.ts");
});

test("single-token deposits and redemptions match the app", () => {
  const now = 1_760_000_000;
  const share = (usd: number) => BigInt(Math.round((usd / 168) * 1e9));
  const v = { decimals: cfg.assets.map((a) => a.decimals), pools: cfg.pools, marketPools: cfg.marketPools };
  let planned = 0;
  for (const s of states(10)) {
    const px = prices(cfg, s);
    const basket = {
      // A band wide enough that the random states, whose pools disagree, pass the breaker.
      params: { bandBps: 9_999, baseFeeBps: 5, feeSlopeBps: 2, maxFeeBps: 100, maxDiscountBps: 3, maxPriceAge: 600 },
      numAssets: 5,
      assets: cfg.assets.map((a, k) => ({ isStock: a.kind === "stock", targetWeightBps: a.kind === "stock" ? 2_500 : 1_250, maxWeightBps: a.kind === "stock" ? 4_000 : 10_000, price: share(px[k] || 1) })),
      pricesUpdatedAt: now - 10,
    };
    const withBasket = { ...s, basket };
    for (const [k, amount] of [[3, 100_000_000n], [0, 50_000_000n], [2, 500_000_000n], [4, 20_000_000n]] as const) {
      const ours = app.quoteSingleDeposit(withBasket, k, amount, now);
      const sdk = planSingleDeposit(v, basket, withBasket, k, amount, now, Number(app.ROUTE_SLIPPAGE_BPS));
      const key = (r: typeof sdk | typeof ours) => ("plan" in r ? [r.plan.into, r.plan.shares, r.plan.minShares, r.plan.feeBps, r.plan.convert?.pool.pool.toBase58() ?? null] : r.refused.kind);
      assert.deepEqual(key(ours), key(sdk), `asset ${k}`);
      if ("plan" in sdk) planned++;
    }
    for (const k of [0, 1, 2]) {
      const ours = app.quoteSingleRedeem(withBasket, 10n ** 8n, k, now);
      const sdk = planSingleRedeem(v, basket, withBasket, 10n ** 8n, k, now);
      assert.deepEqual("plan" in ours ? ours.plan.amount : ours.refused.kind, "plan" in sdk ? sdk.plan.amount : sdk.refused.kind);
    }
  }
  assert.ok(planned >= 10, `only ${planned} of 40 deposits planned`);
});
