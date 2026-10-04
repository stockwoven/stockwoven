// Creates two mock issuer tokens of one stock on devnet, initializes the Stockwoven vault (which
// creates the DAMM v2 compounding pool), deposits, runs a few conversions and harvests.
//
//   KEYPAIR=~/.config/solana/id.json npm run devnet:setup
//
// Writes the addresses to scripts/devnet.json for the app.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const STOCKWOVEN = new PublicKey("H9ZJiWoKXGrje8Y3errCSh2uXUiNpf8mDmjJ7TapZm7b");
const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

const DECIMALS_A = 8; // like xStocks
const DECIMALS_B = 6; // like Backpack
const PEG_SQRT_PRICE = (1n << 64n) / 10n; // sqrt(10^6 / 10^8) in Q64.64
const LIQUIDITY_PER_SHARE = (1n << 64n) / 20n; // 1 swINTC = 1 share of stock at the peg
const SEED_LIQUIDITY = 50_000_000n << 64n; // 10 shares of stock: 5 A + 5 B
const ONE_SHARE = 100_000_000n;

const conn = new Connection(RPC, "confirmed");
const keypairPath = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace("~", homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u128 = (v: bigint) => Buffer.concat([u64(v & ((1n << 64n) - 1n)), u64(v >> 64n)]);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
}

async function main() {
  console.log("payer", payer.publicKey.toBase58(), (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");

  const mintA = await createMint(conn, payer, payer.publicKey, null, DECIMALS_A);
  const mintB = await createMint(conn, payer, payer.publicKey, null, DECIMALS_B);
  const payerA = (await getOrCreateAssociatedTokenAccount(conn, payer, mintA, payer.publicKey)).address;
  const payerB = (await getOrCreateAssociatedTokenAccount(conn, payer, mintB, payer.publicKey)).address;
  await mintTo(conn, payer, mintA, payerA, payer, 1_000n * 10n ** BigInt(DECIMALS_A));
  await mintTo(conn, payer, mintB, payerB, payer, 1_000n * 10n ** BigInt(DECIMALS_B));
  console.log("mock INTCx (A)", mintA.toBase58(), "\nmock INTC  (B)", mintB.toBase58());

  const [hi, lo] = mintA.toBuffer().compare(mintB.toBuffer()) > 0 ? [mintA, mintB] : [mintB, mintA];
  const pool = pda([Buffer.from("cpool"), hi.toBuffer(), lo.toBuffer()], CP_AMM);
  const vault = pda([Buffer.from("vault"), pool.toBuffer()], STOCKWOVEN);
  const shareMint = pda([Buffer.from("shares"), vault.toBuffer()], STOCKWOVEN);
  const reserveA = pda([Buffer.from("reserve"), vault.toBuffer(), mintA.toBuffer()], STOCKWOVEN);
  const reserveB = pda([Buffer.from("reserve"), vault.toBuffer(), mintB.toBuffer()], STOCKWOVEN);
  const tokenAVault = pda([Buffer.from("token_vault"), mintA.toBuffer(), pool.toBuffer()], CP_AMM);
  const tokenBVault = pda([Buffer.from("token_vault"), mintB.toBuffer(), pool.toBuffer()], CP_AMM);
  const nftMint = Keypair.generate();
  const position = pda([Buffer.from("position"), nftMint.publicKey.toBuffer()], CP_AMM);
  const positionNftAccount = pda([Buffer.from("position_nft_account"), nftMint.publicKey.toBuffer()], CP_AMM);
  const payerShares = getAssociatedTokenAddressSync(shareMint, payer.publicKey);
  const treasury = payerB; // the protocol's cut lands in the admin's B account on devnet

  const initData = Buffer.concat([
    disc("initialize_vault"),
    u128(SEED_LIQUIDITY), u128(PEG_SQRT_PRICE), u128(LIQUIDITY_PER_SHARE),
    u16(10), u16(8_000), // 0.10% trading fee, 80% of the LP fee compounds
  ]);
  const initSig = await send([new TransactionInstruction({
    programId: STOCKWOVEN,
    data: initData,
    keys: [
      w(payer.publicKey, true), w(vault), w(shareMint), w(payerShares), w(reserveA), w(reserveB),
      r(treasury), r(mintA), r(mintB), w(payerA), w(payerB),
      w(pool), w(nftMint.publicKey, true), w(positionNftAccount), w(position), w(tokenAVault), w(tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    ],
  })], [nftMint]);
  console.log("vault initialized", initSig);

  const damm = [r(DAMM_EVENT_AUTHORITY), r(CP_AMM)];
  const depositSig = await send([new TransactionInstruction({
    programId: STOCKWOVEN,
    data: Buffer.concat([disc("deposit"), u64(ONE_SHARE), u64(60_000_000n), u64(600_000n)]),
    keys: [
      r(payer.publicKey, true), r(vault), w(shareMint), w(payerShares), w(payerA), w(payerB), w(reserveA), w(reserveB),
      r(mintA), r(mintB), w(pool), w(position), r(positionNftAccount), w(tokenAVault), w(tokenBVault),
      ...damm, r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  })]);
  console.log("deposited 1 swINTC", depositSig);

  // Conversions go straight to the DAMM v2 pool, as a router would send them.
  const swap = (input: PublicKey, output: PublicKey, amountIn: bigint) => new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]), u64(amountIn), u64(0n)]),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(pool), w(input), w(output), w(tokenAVault), w(tokenBVault), r(mintA), r(mintB),
      r(payer.publicKey, true), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
  for (let i = 0n; i < 5n; i++) {
    await send([swap(payerA, payerB, 50_000_000n + i), swap(payerB, payerA, 500_000n + i)]);
  }
  console.log("ran 10 conversions");

  const before = (await getAccount(conn, treasury)).amount;
  const harvestSig = await send([new TransactionInstruction({
    programId: STOCKWOVEN,
    data: disc("harvest"),
    keys: [
      r(vault), w(reserveA), w(treasury), r(mintA), r(mintB), r(pool), w(position), r(positionNftAccount),
      w(tokenAVault), w(tokenBVault), r(DAMM_POOL_AUTHORITY), ...damm, r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  })]);
  console.log("harvested", (await getAccount(conn, treasury)).amount - before, "raw B to treasury", harvestSig);

  const poolData = (await conn.getAccountInfo(pool))!.data;
  const liquidity = poolData.readBigUInt64LE(360) + (poolData.readBigUInt64LE(368) << 64n);
  const reserveAmountA = poolData.readBigUInt64LE(680);
  const reserveAmountB = poolData.readBigUInt64LE(688);
  const perShare = Number(LIQUIDITY_PER_SHARE * ONE_SHARE) / Number(liquidity)
    * (Number(reserveAmountA) / 10 ** DECIMALS_A + Number(reserveAmountB) / 10 ** DECIMALS_B);
  console.log(`1 swINTC = ${perShare.toFixed(8)} shares of stock`);

  const out = {
    cluster: "devnet",
    program: STOCKWOVEN.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), decimalsA: DECIMALS_A, decimalsB: DECIMALS_B,
    pool: pool.toBase58(), vault: vault.toBase58(), shareMint: shareMint.toBase58(),
    position: position.toBase58(), positionNftAccount: positionNftAccount.toBase58(),
    tokenAVault: tokenAVault.toBase58(), tokenBVault: tokenBVault.toBase58(),
    reserveA: reserveA.toBase58(), reserveB: reserveB.toBase58(), treasury: treasury.toBase58(),
    liquidityPerShare: LIQUIDITY_PER_SHARE.toString(),
  };
  writeFileSync(new URL("./devnet.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote scripts/devnet.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
