// Devnet traffic: random trades on the vault's pools and the market pools, like the swaps routers
// would send on mainnet. They pay the pools' fees (the vault's yield) and push prices apart
// between pools (what the keeper's arbitrage closes).
//
//   KEYPAIR=//wsl.localhost/Ubuntu/home/pedro/.config/solana/id.json npx tsx scripts/traffic.ts [--once]
//
// Trades from the admin wallet, sized at 0.2–1.5% of the input side of the pool. SOL pools trade
// smaller amounts so the wallet's devnet SOL lasts.

import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { admin, ata, conn, pk, poolSwapIx, readDevnet, readState, sendV0 } from "./sw.ts";

const INTERVAL_SEC = Number(process.env.TRAFFIC_INTERVAL_SEC ?? 20);
const TRADES_PER_TICK = Number(process.env.TRADES_PER_TICK ?? 3);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function tick() {
  const d = readDevnet();
  const s = await readState(d);
  const pools = [...d.pools.map((info, i) => ({ info, state: s.pools[i] })), ...d.marketPools.map((info, i) => ({ info, state: s.market[i] }))];
  for (let t = 0; t < TRADES_PER_TICK; t++) {
    const { info, state } = pools[Math.floor(Math.random() * pools.length)];
    const aToB = Math.random() < 0.5;
    const input = d.assets[aToB ? info.a : info.b];
    const depth = aToB ? state.reserveA : state.reserveB;
    const fraction = 0.002 + Math.random() * 0.013;
    const amountIn = BigInt(Math.floor(Number(depth) * fraction));
    const held = await balance(ata(admin.publicKey, pk(input.mint)));
    if (amountIn === 0n || held < amountIn) continue;
    try {
      const sig = await sendV0([
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, pk(d.assets[info.a].mint)), admin.publicKey, pk(d.assets[info.a].mint)),
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(admin.publicKey, pk(d.assets[info.b].mint)), admin.publicKey, pk(d.assets[info.b].mint)),
        poolSwapIx(d, info, admin.publicKey, aToB, amountIn, 0n),
      ], [admin], [], 200_000);
      const whole = Number(amountIn) / 10 ** input.decimals;
      log(`${info.label}: sold ${whole.toFixed(4)} ${input.symbol}`, sig);
    } catch (e) {
      log(`${info.label} trade failed:`, String(e).slice(0, 160));
    }
  }
}

async function balance(account: ReturnType<typeof ata>) {
  try {
    return BigInt((await conn.getTokenAccountBalance(account)).value.amount);
  } catch {
    return 0n;
  }
}

async function main() {
  await tick();
  if (process.argv.includes("--once")) return;
  setInterval(tick, INTERVAL_SEC * 1000);
}

main();
