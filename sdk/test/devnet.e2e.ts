// Builds every kind of transaction against the live devnet vault and simulates it (nothing is
// signed or sent). The owner is the devnet admin wallet, which holds every token involved; a
// different fee payer checks that a partner can sponsor its customer's fees.
//
//   npm run test:devnet                     (OWNER=<pubkey> to use another funded wallet)
//
// With SEND_KEYPAIR=<path to the owner's keypair> it also sends the two-step one-token deposits
// for real, since the deposit step depends on the swaps landing first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Stockwoven, parseError, toRaw, tokenAccount } from "../src/index.js";

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const sw = new Stockwoven({ connection });
const owner = new PublicKey(process.env.OWNER ?? "Dwrba3bghFaRnE6RqGmRHLRKd4QqUr9Bz38Dt8KxQD1D");
const sponsor = new PublicKey(process.env.SPONSOR ?? "mWJyKyW2pjkzxEuc5juarRnKki162CniCHp5XoDVRRC");
const sender = process.env.SEND_KEYPAIR
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SEND_KEYPAIR, "utf8"))))
  : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulates and returns the change in the owner's share balance, or throws the classified error. */
async function simulate(tx: VersionedTransaction) {
  const shares = tokenAccount(owner, sw.vault.share);
  const before = await connection.getTokenAccountBalance(shares).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [shares.toBase58()] },
  });
  if (sim.value.err) throw parseError({ message: JSON.stringify(sim.value.err), logs: sim.value.logs ?? [] });
  const data = sim.value.accounts?.[0]?.data[0];
  const after = data ? Buffer.from(data, "base64").readBigUInt64LE(64) : 0n;
  return { minted: after - before, units: sim.value.unitsConsumed ?? 0, size: tx.serialize().length };
}

test("vault and position read from devnet", async () => {
  const vault = await sw.getVault();
  assert.equal(vault.stock, "SPCX");
  assert.equal(vault.pools.length, 4);
  assert.ok(vault.valuePerShare > 50 && vault.valuePerShare < 500, String(vault.valuePerShare));
  const position = await sw.getPosition(owner);
  assert.ok(position.shares > 0n);
  console.log(`  1 ${vault.share.symbol} = $${vault.valuePerShare.toFixed(2)}; exposure SpaceX ${(vault.exposure.stock * 100).toFixed(1)}%; owner holds $${position.valueUsd.toFixed(2)}`);
});

test("deposit with the vault's mix, fees sponsored", async () => {
  await sleep(1500);
  const quote = await sw.quoteDeposit({ pay: "mix", shares: toRaw("0.1", 8) });
  const built = await sw.buildDeposit(quote, { owner, feePayer: sponsor });
  assert.equal(built.transactions.length, 1);
  assert.deepEqual(built.signers.map(String), [sponsor.toBase58(), owner.toBase58()]);
  const r = await simulate(built.transactions[0]);
  assert.equal(r.minted, quote.shares);
  console.log(`  minted ${r.minted} raw, ${r.units} CU, ${r.size} bytes`);
});

for (const [pay, amount] of [["USDC", "20"], ["SPCXx", "0.1"], ["SPCX", "0.1"], ["SPCXon", "0.1"], ["SOL", "0.02"]] as const) {
  test(`deposit paying with ${amount} ${pay}: two transactions`, async () => {
    await sleep(1500);
    const asset = sw.vault.assets[sw.asset(pay)];
    const quote = await sw.quoteDeposit({ pay, amount: toRaw(amount, asset.decimals) });
    const built = await sw.buildDeposit(quote, { owner });
    assert.equal(built.transactions.length, 2);
    for (const tx of built.transactions) assert.ok(tx.serialize().length <= 1232);
    // The swaps can be simulated alone; the deposit depends on them landing first.
    const swaps = await simulate(built.transactions[0]);
    console.log(`  swaps ${swaps.units} CU, ${swaps.size} bytes; quote ${quote.shares} raw shares for $${quote.costUsd.toFixed(2)}`);
    if (sender) {
      const before = (await sw.getPosition(owner)).shares;
      const sigs = await sw.sendAll(built, [sender]);
      const minted = (await sw.getPosition(owner)).shares - before;
      assert.equal(minted, quote.shares);
      console.log(`  sent: ${sigs.map((s) => s.slice(0, 8)).join(", ")}; minted exactly the quote`);
    }
  });
}

test("redeem in kind and to USDC", async () => {
  await sleep(1500);
  for (const receive of ["kind", "USDC"] as const) {
    const quote = await sw.quoteRedeem(toRaw("0.05", 8), { receive });
    const built = await sw.buildRedeem(quote, { owner });
    assert.equal(built.transactions.length, 1);
    const r = await simulate(built.transactions[0]);
    assert.equal(r.minted, -quote.shares);
    console.log(`  redeem ${receive}: ${r.units} CU, ${r.size} bytes`);
    await sleep(1500);
  }
});

test("harvest is permissionless", async () => {
  await sleep(1500);
  const built = await sw.buildHarvest(sponsor);
  const r = await simulate(built.transactions[0]);
  console.log(`  harvest every pool: ${r.units} CU`);
});
