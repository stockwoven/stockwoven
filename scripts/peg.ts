// Devnet peg: keeps the three mock SpaceX tokens at 1:1, like the issuers' mint-and-redeem
// arbitrage does on mainnet. Nothing else anchors them on devnet: traffic random-walks every pool
// and the keeper only aligns pools with each other, so the tokens drift apart until the vault's
// circuit breaker (±2%) closes single-token deposits.
//
// Every tick it reads each pool's price, and where an issuer token is more than PEG_TOLERANCE_BPS
// from one share (the median of the three) or from the USDC and SOL prices, it trades the pool
// back, minting the mock tokens it sells with the faucet key. It never sells SOL, which it can't
// mint; the keeper's arbitrage realigns the SOL pools.
//
//   KEYPAIR=//wsl.localhost/Ubuntu/home/pedro/.config/solana/id.json \
//   FAUCET_KEYPAIR=C:/Users/pedro/.stockwoven/faucet-keypair.json npx tsx scripts/peg.ts [--once] [--dry]

import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import { Devnet, PoolInfo, PoolState, admin, ata, envKeypair, isqrt, pk, poolSwapIx, prices, readDevnet, readState, sendV0, stockUsd } from "./sw.ts";

const faucet = envKeypair("FAUCET_KEYPAIR", "C:/Users/pedro/.stockwoven/faucet-keypair.json");
const INTERVAL_SEC = Number(process.env.PEG_INTERVAL_SEC ?? 60);
/** Pools within this distance of their fair price are left alone. */
const PEG_TOLERANCE_BPS = Number(process.env.PEG_TOLERANCE_BPS ?? 30);

const DRY = process.argv.includes("--dry");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * The trade that moves an x·y = k pool to `target` raw B per raw A: the side to sell and how much.
 * With the reserves at sqrt(k / p) and sqrt(k · p); the fee is added on top of an input in B.
 */
function tradeTo(p: PoolState, target: number, feeBps: number) {
  const k = p.reserveA * p.reserveB;
  const scale = 1_000_000_000_000n;
  const t = BigInt(Math.round(target * Number(scale)));
  const a1 = isqrt((k * scale) / t);
  if (a1 > p.reserveA) return { aToB: true, amountIn: a1 - p.reserveA };
  const b1 = isqrt((k * t) / scale);
  return { aToB: false, amountIn: ((b1 - p.reserveB) * 10_000n) / BigInt(10_000 - feeBps) };
}

async function pegPool(d: Devnet, info: PoolInfo, state: PoolState, fair: number[]) {
  const [a, b] = [d.assets[info.a], d.assets[info.b]];
  if (state.reserveA === 0n || state.reserveB === 0n || (a.kind !== "stock" && b.kind !== "stock")) return;
  const target = (fair[info.a] / fair[info.b]) * 10 ** (b.decimals - a.decimals);
  const now = Number(state.reserveB) / Number(state.reserveA);
  const gap = now / target - 1;
  if (Math.abs(gap) * 10_000 <= PEG_TOLERANCE_BPS) return;
  const { aToB, amountIn } = tradeTo(state, target, info.feeBps);
  const input = aToB ? a : b;
  if (input.kind === "sol" || amountIn <= 0n) return log(`${info.label}: ${(gap * 100).toFixed(2)}% off, needs SOL; left to the keeper`);
  const whole = Number(amountIn) / 10 ** input.decimals;
  if (DRY) return log(`${info.label}: ${(gap * 100).toFixed(2)}% off, would sell ${whole.toFixed(4)} ${input.symbol}`);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, pk(a.mint)), admin.publicKey, pk(a.mint)),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, pk(b.mint)), admin.publicKey, pk(b.mint)),
    createMintToInstruction(pk(input.mint), ata(admin.publicKey, pk(input.mint)), faucet.publicKey, amountIn),
    poolSwapIx(d, info, admin.publicKey, aToB, amountIn, 0n),
  ];
  const sig = await sendV0(ixs, [admin, faucet], [], 200_000);
  log(`${info.label}: ${(gap * 100).toFixed(2)}% off, sold ${whole.toFixed(4)} ${input.symbol}`, sig);
}

async function tick() {
  const d = readDevnet();
  const s = await readState(d);
  const px = prices(d, s);
  // Fair USD prices: one share for every issuer token, the pools' own prices for USDC and SOL.
  const share = stockUsd(d, px);
  const fair = d.assets.map((a, k) => (a.kind === "stock" ? share : px[k]));
  const pools = [...d.pools.map((info, i) => ({ info, state: s.pools[i] })), ...d.marketPools.map((info, i) => ({ info, state: s.market[i] }))];
  for (const { info, state } of pools) {
    try {
      await pegPool(d, info, state, fair);
    } catch (e) {
      log(`${info.label}: peg trade failed:`, String(e).slice(0, 200));
    }
  }
}

async function main() {
  log("peg", admin.publicKey.toBase58(), "faucet", faucet.publicKey.toBase58());
  await tick();
  if (DRY || process.argv.includes("--once")) return;
  setInterval(tick, INTERVAL_SEC * 1000);
}

main();
