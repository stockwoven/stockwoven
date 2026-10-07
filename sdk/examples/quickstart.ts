// A first look at the SDK, with no wallet and no keys: reads the swSPCX vault on devnet and
// prices a few deposits and a redemption. Nothing is signed or sent.
//
//   npm run example:quickstart
//   OWNER=<wallet address> npm run example:quickstart    (also shows that wallet's position)

import { Connection, PublicKey } from "@solana/web3.js";
import { Stockwoven, fromRaw, toRaw } from "../src/index.js";

const sw = new Stockwoven({ connection: new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed") });
const share = sw.vault.share;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// One read of the chain, reused by every quote below.
const state = await sw.getState();
const vault = await sw.getVault(state);

console.log(`\n${share.symbol} vault on devnet`);
console.log(`  1 ${share.symbol} = $${vault.valuePerShare.toFixed(2)}   vault value $${vault.totalValue.toFixed(0)}   supply ${fromRaw(vault.supply, share.decimals)}`);
console.log(`  exposure: SpaceX ${pct(vault.exposure.stock)} · USDC ${pct(vault.exposure.usdc)} · SOL ${pct(vault.exposure.sol)}`);
for (const p of vault.pools) console.log(`  pool ${p.label.padEnd(16)} $${p.valueUsd.toFixed(0).padStart(7)}   target ${(p.targetWeightBps / 100).toFixed(0)}%`);
console.log(`  prices: ${Object.entries(vault.prices).map(([s, v]) => `${s} $${v.toFixed(2)}`).join(" · ")}`);

console.log("\nDeposit quotes");
const mix = await sw.quoteDeposit({ pay: "mix", shares: toRaw("0.1", share.decimals) }, state);
console.log(`  0.1 ${share.symbol} with the vault's mix (1 transaction), paying at most:`);
for (const { token, amount } of mix.maxSpend) console.log(`    ${fromRaw(amount, token.decimals).padStart(14)} ${token.symbol}${token.issuer ? ` (${token.issuer})` : ""}`);

for (const [pay, amount] of [["USDC", "20"], ["SPCXx", "0.1"], ["SPCX", "0.1"], ["SPCXon", "0.1"], ["SOL", "0.02"]] as const) {
  const token = sw.vault.assets[sw.asset(pay)];
  try {
    const q = await sw.quoteDeposit({ pay, amount: toRaw(amount, token.decimals) }, state);
    const swaps = q.plan.route === "swap" ? q.plan.zap.swaps.length : 0;
    console.log(`  ${amount} ${pay.padEnd(6)} → ${fromRaw(q.shares, share.decimals).padStart(11)} ${share.symbol}   $${q.costUsd.toFixed(2)} in, $${q.valueUsd.toFixed(2)} out   ${swaps} swaps, 2 transactions`);
  } catch (e) {
    console.log(`  ${amount} ${pay.padEnd(6)} → refused: ${(e as Error).message}`);
  }
}

console.log("\nRedeem quotes");
const kind = await sw.quoteRedeem(toRaw("0.1", share.decimals), {}, state);
console.log(`  0.1 ${share.symbol} in kind, at least: ${kind.payout.map(({ token, min }) => `${fromRaw(min, token.decimals)} ${token.symbol}`).join(" · ")}`);
const usdc = await sw.quoteRedeem(toRaw("0.1", share.decimals), { receive: "USDC" }, state);
console.log(`  0.1 ${share.symbol} to USDC, at least: ${fromRaw(usdc.payout[0].min, 6)} USDC`);

if (process.env.OWNER) {
  const owner = new PublicKey(process.env.OWNER);
  const position = await sw.getPosition(owner, state);
  console.log(`\n${owner.toBase58()} holds ${fromRaw(position.shares, share.decimals)} ${share.symbol} ≈ $${position.valueUsd.toFixed(2)}`);
}
console.log("");
