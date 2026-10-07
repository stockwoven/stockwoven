import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DEVNET_SPCX,
  Stockwoven,
  VaultState,
  fromRaw,
  parseError,
  prices,
  sharesFor,
  swTicker,
  swapOut,
  toRaw,
  tokensForShares,
  vaultValue,
  zapIn,
  zapOut,
} from "../src/index.js";

const cfg = DEVNET_SPCX;
const [SPCXX, SPCX, SPCXON, USDC, SOL] = ["SPCXx", "SPCX", "SPCXon", "USDC", "SOL"].map((s) => cfg.assets.findIndex((a) => a.symbol === s));
const L = 10n ** 20n;
const pool = (a: bigint, b: bigint, share = 9n) => ({ liquidity: L, reserveA: a, reserveB: b, position: (L * share) / 10n });

/** The devnet vault at SpaceX $168 and SOL $116: about $67k across four pools, 400 swSPCX. */
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
};

const offline = new Stockwoven({ connection: new Connection("http://127.0.0.1:1") });

test("units: exact decimal round trip", () => {
  assert.equal(toRaw("12.5", 6), 12_500_000n);
  assert.equal(toRaw("0.000000001", 9), 1n);
  assert.equal(fromRaw(12_500_000n, 6), "12.5");
  assert.equal(fromRaw(1n, 8), "0.00000001");
  assert.throws(() => toRaw("1.234", 2));
  assert.throws(() => toRaw("-1", 2));
  assert.equal(swTicker("spcx"), "swSPCX");
});

test("the devnet preset holds the three issuers' SpaceX tokens with their real decimals", () => {
  assert.deepEqual(
    cfg.assets.map((a) => [a.symbol, a.issuer, a.decimals]),
    [["SPCXx", "xStocks", 8], ["SPCX", "Backpack", 6], ["SPCXon", "Ondo", 9], ["USDC", null, 6], ["SOL", null, 9]],
  );
  assert.equal(cfg.pools.length, 4);
  assert.deepEqual(cfg.pools.map((p) => p.kind), ["stock-stock", "stock-stock", "stock-usdc", "stock-sol"]);
});

test("prices read outward from USDC through the deepest pools", () => {
  const px = prices(cfg, state);
  assert.equal(px[USDC], 1);
  for (const k of [SPCXX, SPCX, SPCXON]) assert.ok(Math.abs(px[k] - 168) < 0.5, `${cfg.assets[k].symbol} ${px[k]}`);
  assert.ok(Math.abs(px[SOL] - 116) < 0.5, `SOL ${px[SOL]}`);
  const { total, perShare } = vaultValue(cfg, state);
  assert.ok(total > 60_000 && total < 70_000, String(total));
  assert.ok(Math.abs(perShare - total / 400) < 1e-6);
});

test("deposits round up, redemptions round down, and paying a quote covers its shares", () => {
  for (const shares of [1n, 12_345n, 10n ** 8n, 777_777_777n]) {
    const paid = tokensForShares(cfg, state, shares, true);
    const got = tokensForShares(cfg, state, shares, false);
    assert.ok(paid.every((x, k) => x >= got[k]), `shares ${shares}`);
    assert.ok(sharesFor(cfg, state, paid) >= shares, `shares ${shares}`);
  }
});

test("swap fees round up like cp-amm, which matters on dust", () => {
  const p = state.pools[0];
  // 133 raw SPCX in: the 0.3% fee is 0.4 raw units and rounds up to 1.
  const out = swapOut(p, 30, false, 133n);
  const exactNet = (p.reserveA * 132n) / (p.reserveB + 132n);
  assert.equal(out, exactNet);
});

test("one-token deposits buy every asset and lose only fees and slippage", () => {
  for (const [k, amount] of [[USDC, toRaw("100", 6)], [SPCX, toRaw("1", 6)], [SPCXON, toRaw("0.5", 9)], [SOL, toRaw("0.02", 9)]] as const) {
    const zap = zapIn(cfg, state, k, amount, 50)!;
    assert.ok(zap, cfg.assets[k].symbol);
    assert.ok(zap.shares > 0n);
    assert.ok(zap.maxAmounts.every((x) => x > 0n), `${cfg.assets[k].symbol}: ${zap.maxAmounts}`);
    assert.ok(zap.usdOut <= zap.usdIn && zap.usdOut > zap.usdIn * 0.95, `${cfg.assets[k].symbol}: ${zap.usdIn} → ${zap.usdOut}`);
  }
});

test("quotes refuse swaps that would lose more than maxLossBps", async () => {
  // 0.5 SOL against pools holding 2 and 0.5 SOL loses about 30% to price impact.
  await assert.rejects(offline.quoteDeposit({ pay: "SOL", amount: toRaw("0.5", 9) }, state), /lose \d+\.\d% of the value/);
  const small = await offline.quoteDeposit({ pay: "SOL", amount: toRaw("0.02", 9) }, state);
  assert.ok(small.valueUsd > small.costUsd * 0.97, `${small.costUsd} → ${small.valueUsd}`);
  const lenient = new Stockwoven({ connection: new Connection("http://127.0.0.1:1"), maxLossBps: 5_000 });
  assert.ok((await lenient.quoteDeposit({ pay: "SOL", amount: toRaw("0.5", 9) }, state)).shares > 0n);
});

test("redeeming to one asset swaps the rest into it", () => {
  const z = zapOut(cfg, state, 10n ** 8n, USDC, 50)!;
  assert.ok(z.swaps.length >= 3);
  const px = prices(cfg, state);
  const usd = Number(z.out) / 1e6;
  assert.ok(usd > vaultValue(cfg, state).perShare * 0.95, String(usd));
  assert.ok(px[USDC] === 1);
});

test("the client quotes and plans steps offline from a state", async () => {
  const owner = new PublicKey("Dwrba3bghFaRnE6RqGmRHLRKd4QqUr9Bz38Dt8KxQD1D");
  const mix = await offline.quoteDeposit({ pay: "mix", shares: toRaw("0.5", 8) }, state);
  assert.equal(mix.route, "mix");
  assert.equal(offline.depositSteps(mix, owner).length, 1);
  const usdc = await offline.quoteDeposit({ pay: "USDC", amount: toRaw("100", 6) }, state);
  assert.equal(usdc.route, "swap");
  const steps = offline.depositSteps(usdc, owner);
  assert.equal(steps.length, 2, "the swaps, then the deposit");
  const out = await offline.quoteRedeem(10n ** 8n, { receive: "USDC" }, state);
  assert.equal(out.payout.length, 1);
  await assert.rejects(offline.quoteDeposit({ pay: "DOGE", amount: 1n }, state), /not an asset/);
  await assert.rejects(offline.quoteDeposit({ pay: "USDC", amount: 1n }, { ...state, depositsPaused: true }), /paused/);
  const vault = await offline.getVault(state);
  assert.ok(Math.abs(vault.exposure.stock + vault.exposure.usdc + vault.exposure.sol - 1) < 1e-9);
  assert.equal(vault.pools.length, 4);
});

test("errors: vault codes, cp-amm codes and runtime limits", () => {
  assert.equal(parseError({ message: '{"InstructionError":[3,{"Custom":6002}]}', logs: ["Program H9ZJiWoKXGrje8Y3errCSh2uXUiNpf8mDmjJ7TapZm7b failed: custom program error: 0x1772"] }).kind, "DepositsPaused");
  // cp-amm's ExceededSlippage is also 6002; it must not read as the vault's DepositsPaused.
  const amm = parseError({ message: '{"InstructionError":[8,{"Custom":6002}]}', logs: ["Error Code: ExceededSlippage.", "Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG failed: custom program error: 0x1772"] });
  assert.equal(amm.kind, "Slippage");
  assert.equal(parseError({ message: '{"InstructionError":[5,{"Custom":6022}]}' }).kind, "SlippageExceeded");
  assert.equal(parseError({ message: '{"InstructionError":[10,"MaxInstructionTraceLengthExceeded"]}' }).kind, "TooManyInstructions");
  assert.equal(parseError({ message: '{"InstructionError":[4,{"Custom":1}]}' }).kind, "InsufficientFunds");
  assert.equal(parseError(new Error("User rejected the request")).kind, "Rejected");
});
