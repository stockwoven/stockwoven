// Creates a mock USDC and one DAMM v2 pool per issuer token against it (mINTCx/USDC, mINTC/USDC),
// so a single-token deposit can buy the other issuer's token outside the vault's pool. Also
// creates the address lookup table the app's routed deposit needs to fit in one transaction.
//
//   KEYPAIR=~/.config/solana/id.json npx tsx scripts/devnet-usdc-routes.ts
//
// Run after devnet-setup.ts; each step is skipped once devnet.json lists its result. Adds the new
// addresses to scripts/devnet.json and app/src/lib/devnet.json.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AddressLookupTableProgram,
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
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
const INITIALIZE_CUSTOMIZABLE_POOL = [20, 161, 241, 24, 189, 221, 180, 2];

const USDC_DECIMALS = 6;
const USD_PER_SHARE = 20n; // mock stock price
const SHARES_PER_POOL = 200n; // deeper than the vault's pool, so routing through them is cheap
const TRADE_FEE_BPS = 10;
const MIN_SQRT_PRICE = 4_295_048_016n;
const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;

const here = (file: string) => new URL(file, import.meta.url);
const devnet = JSON.parse(readFileSync(here("./devnet.json"), "utf8"));

const conn = new Connection(RPC, "confirmed");
const keypairPath = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace("~", homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u128 = (v: bigint) => Buffer.concat([u64(v & ((1n << 64n) - 1n)), u64(v >> 64n)]);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let [x0, x1] = [n / 2n + 1n, (n / 2n + 1n + n / (n / 2n + 1n)) / 2n];
  while (x1 < x0) [x0, x1] = [x1, (x1 + n / x1) / 2n];
  return x0;
};

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
}

function save() {
  for (const file of ["./devnet.json", "../app/src/lib/devnet.json"]) {
    writeFileSync(here(file), JSON.stringify(devnet, null, 2) + "\n");
  }
  console.log("wrote scripts/devnet.json and app/src/lib/devnet.json");
}

/** cp-amm's accounts for a stock/USDC pool; the pool PDA sorts the two mints. */
function poolAccounts(stock: PublicKey, usdc: PublicKey) {
  const [hi, lo] = stock.toBuffer().compare(usdc.toBuffer()) > 0 ? [stock, usdc] : [usdc, stock];
  const pool = pda([Buffer.from("cpool"), hi.toBuffer(), lo.toBuffer()], CP_AMM);
  return {
    pool,
    stockVault: pda([Buffer.from("token_vault"), stock.toBuffer(), pool.toBuffer()], CP_AMM),
    usdcVault: pda([Buffer.from("token_vault"), usdc.toBuffer(), pool.toBuffer()], CP_AMM),
  };
}

/** A full-range compounding pool of `stock` (token A) against USDC (token B) at USD_PER_SHARE. */
async function createPool(stock: PublicKey, decimals: number, usdc: PublicKey, payerStock: PublicKey, payerUsdc: PublicKey) {
  const { pool, stockVault, usdcVault } = poolAccounts(stock, usdc);
  const nftMint = Keypair.generate();
  const position = pda([Buffer.from("position"), nftMint.publicKey.toBuffer()], CP_AMM);
  const positionNftAccount = pda([Buffer.from("position_nft_account"), nftMint.publicKey.toBuffer()], CP_AMM);

  // sqrt(raw USDC per raw stock unit) in Q64.64, and the liquidity that holds SHARES_PER_POOL.
  const usdcPerShare = USD_PER_SHARE * 10n ** BigInt(USDC_DECIMALS);
  const sqrtPrice = isqrt((usdcPerShare << 128n) / 10n ** BigInt(decimals));
  const liquidity = ((SHARES_PER_POOL * usdcPerShare) << 128n) / sqrtPrice;

  const baseFee = Buffer.alloc(27);
  baseFee.writeBigUInt64LE(BigInt(TRADE_FEE_BPS) * 100_000n);
  const params = Buffer.concat([
    baseFee, u16(8_000), Buffer.from([0]), Buffer.from([0]), // compounding_fee_bps, padding, no dynamic fee
    u128(MIN_SQRT_PRICE), u128(MAX_SQRT_PRICE), Buffer.from([0]), // no alpha vault
    u128(liquidity), u128(sqrtPrice),
    Buffer.from([1, 2, 0]), // activation by timestamp, compounding fees, active now
  ]);
  await send([new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([Buffer.from(INITIALIZE_CUSTOMIZABLE_POOL), params]),
    keys: [
      r(payer.publicKey), w(nftMint.publicKey, true), w(positionNftAccount), w(payer.publicKey, true),
      r(DAMM_POOL_AUTHORITY), w(pool), w(position), r(stock), r(usdc), w(stockVault), w(usdcVault),
      w(payerStock), w(payerUsdc), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
      r(SystemProgram.programId), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  })], [nftMint]);
  return { pool: pool.toBase58(), stockVault: stockVault.toBase58(), usdcVault: usdcVault.toBase58() };
}

async function createRoutes() {
  const mintA = new PublicKey(devnet.mintA);
  const mintB = new PublicKey(devnet.mintB);
  const ataOf = async (mint: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)).address;

  const usdc = await createMint(conn, payer, payer.publicKey, null, USDC_DECIMALS);
  const payerUsdc = await ataOf(usdc);
  await mintTo(conn, payer, usdc, payerUsdc, payer, 100_000n * 10n ** BigInt(USDC_DECIMALS));
  console.log("mock USDC", usdc.toBase58());

  const a = await createPool(mintA, devnet.decimalsA, usdc, await ataOf(mintA), payerUsdc);
  console.log("mINTCx/USDC pool", a.pool);
  const b = await createPool(mintB, devnet.decimalsB, usdc, await ataOf(mintB), payerUsdc);
  console.log("mINTC/USDC pool", b.pool);
  Object.assign(devnet, { usdcMint: usdc.toBase58(), usdcDecimals: USDC_DECIMALS, usdcRoutes: { a, b } });
  save();
}

/** Every fixed account of a routed deposit, so the transaction carries one byte per account. */
async function createLookupTable() {
  const routes = [devnet.usdcRoutes.a, devnet.usdcRoutes.b];
  const addresses = [
    CP_AMM, DAMM_POOL_AUTHORITY, DAMM_EVENT_AUTHORITY, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId, ComputeBudgetProgram.programId,
    ...["program", "vault", "shareMint", "reserveA", "reserveB", "pool", "position", "positionNftAccount",
      "tokenAVault", "tokenBVault", "mintA", "mintB", "usdcMint"].map((k) => new PublicKey(devnet[k])),
    ...routes.flatMap((route) => [route.pool, route.stockVault, route.usdcVault].map((a) => new PublicKey(a))),
  ];
  // The recent slot must still be in the SlotHashes sysvar.
  const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: (await conn.getSlot("confirmed")) - 1,
  });
  await send([createIx]);
  for (let i = 0; i < addresses.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({
      lookupTable,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: addresses.slice(i, i + 20),
    })]);
  }
  console.log("lookup table", lookupTable.toBase58(), `(${addresses.length} addresses)`);
  devnet.lookupTable = lookupTable.toBase58();
  save();
}

async function main() {
  console.log("payer", payer.publicKey.toBase58(), (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
  if (!devnet.usdcMint) await createRoutes();
  if (!devnet.lookupTable) await createLookupTable();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
