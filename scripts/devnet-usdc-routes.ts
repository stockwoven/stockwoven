// Creates a mock USDC and the DAMM v2 pools the app routes through on devnet:
// - mINTCx/USDC and mINTC/USDC, so a deposit can buy either issuer's token outside the vault's pool;
// - wSOL/USDC, so a deposit can start from SOL.
// Also keeps the address lookup table the routed deposits need to fit in one transaction.
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
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  createSyncNativeInstruction,
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
const USD_PER_SOL = 150n; // mock SOL price
const SOL_PER_POOL = 2n; // what the admin wallet can spare on devnet
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

/** cp-amm's accounts for a token/USDC pool; the pool PDA sorts the two mints. */
function poolAccounts(token: PublicKey, usdc: PublicKey) {
  const [hi, lo] = token.toBuffer().compare(usdc.toBuffer()) > 0 ? [token, usdc] : [usdc, token];
  const pool = pda([Buffer.from("cpool"), hi.toBuffer(), lo.toBuffer()], CP_AMM);
  return {
    pool,
    tokenVault: pda([Buffer.from("token_vault"), token.toBuffer(), pool.toBuffer()], CP_AMM),
    usdcVault: pda([Buffer.from("token_vault"), usdc.toBuffer(), pool.toBuffer()], CP_AMM),
  };
}

/**
 * A full-range compounding pool of `token` (token A) against USDC (token B), holding `units` whole
 * tokens at `usdPerUnit`, created by the admin.
 */
async function createPool(
  token: PublicKey,
  decimals: number,
  usdc: PublicKey,
  payerToken: PublicKey,
  payerUsdc: PublicKey,
  units: bigint,
  usdPerUnit: bigint,
) {
  const { pool, tokenVault, usdcVault } = poolAccounts(token, usdc);
  const nftMint = Keypair.generate();
  const position = pda([Buffer.from("position"), nftMint.publicKey.toBuffer()], CP_AMM);
  const positionNftAccount = pda([Buffer.from("position_nft_account"), nftMint.publicKey.toBuffer()], CP_AMM);

  // sqrt(raw USDC per raw token unit) in Q64.64, and the liquidity that holds `units` tokens.
  const usdcPerUnit = usdPerUnit * 10n ** BigInt(USDC_DECIMALS);
  const sqrtPrice = isqrt((usdcPerUnit << 128n) / 10n ** BigInt(decimals));
  const liquidity = ((units * usdcPerUnit) << 128n) / sqrtPrice;

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
      r(DAMM_POOL_AUTHORITY), w(pool), w(position), r(token), r(usdc), w(tokenVault), w(usdcVault),
      w(payerToken), w(payerUsdc), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
      r(SystemProgram.programId), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  })], [nftMint]);
  return { pool: pool.toBase58(), tokenVault: tokenVault.toBase58(), usdcVault: usdcVault.toBase58() };
}

const ataOf = async (mint: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)).address;

async function createRoutes() {
  const mintA = new PublicKey(devnet.mintA);
  const mintB = new PublicKey(devnet.mintB);
  const usdc = await createMint(conn, payer, payer.publicKey, null, USDC_DECIMALS);
  const payerUsdc = await ataOf(usdc);
  await mintTo(conn, payer, usdc, payerUsdc, payer, 100_000n * 10n ** BigInt(USDC_DECIMALS));
  console.log("mock USDC", usdc.toBase58());

  const route = async (mint: PublicKey, decimals: number) => {
    const p = await createPool(mint, decimals, usdc, await ataOf(mint), payerUsdc, SHARES_PER_POOL, USD_PER_SHARE);
    return { pool: p.pool, stockVault: p.tokenVault, usdcVault: p.usdcVault };
  };
  const a = await route(mintA, devnet.decimalsA);
  console.log("mINTCx/USDC pool", a.pool);
  const b = await route(mintB, devnet.decimalsB);
  console.log("mINTC/USDC pool", b.pool);
  Object.assign(devnet, { usdcMint: usdc.toBase58(), usdcDecimals: USDC_DECIMALS, usdcRoutes: { a, b } });
  save();
}

/** Wraps SOL until the admin's wSOL account holds `lamports`. */
async function wrapSol(lamports: bigint) {
  const wsol = await ataOf(NATIVE_MINT);
  const held = BigInt((await conn.getTokenAccountBalance(wsol)).value.amount);
  if (held < lamports) {
    await send([
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsol, lamports: lamports - held }),
      createSyncNativeInstruction(wsol),
    ]);
  }
  return wsol;
}

/** wSOL/USDC, seeded with SOL the admin wraps. */
async function createSolRoute() {
  const usdc = new PublicKey(devnet.usdcMint);
  // cp-amm rounds the amounts it pulls up, so wrap a little more than the pool holds.
  const wsol = await wrapSol(SOL_PER_POOL * BigInt(LAMPORTS_PER_SOL) + 10_000_000n);
  const p = await createPool(NATIVE_MINT, 9, usdc, wsol, await ataOf(usdc), SOL_PER_POOL, USD_PER_SOL);
  console.log("wSOL/USDC pool", p.pool);
  devnet.solRoute = { pool: p.pool, solVault: p.tokenVault, usdcVault: p.usdcVault };
  save();
}

/** Every fixed account of a routed deposit, so the transaction carries one byte per account. */
async function ensureLookupTable() {
  const routes = [devnet.usdcRoutes.a, devnet.usdcRoutes.b];
  const wanted = [
    CP_AMM, DAMM_POOL_AUTHORITY, DAMM_EVENT_AUTHORITY, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId, ComputeBudgetProgram.programId,
    ...["program", "vault", "shareMint", "reserveA", "reserveB", "pool", "position", "positionNftAccount",
      "tokenAVault", "tokenBVault", "mintA", "mintB", "usdcMint"].map((k) => new PublicKey(devnet[k])),
    ...routes.flatMap((route) => [route.pool, route.stockVault, route.usdcVault].map((a) => new PublicKey(a))),
    ...(devnet.solRoute
      ? [NATIVE_MINT, ...[devnet.solRoute.pool, devnet.solRoute.solVault, devnet.solRoute.usdcVault].map((a) => new PublicKey(a))]
      : []),
  ];

  if (!devnet.lookupTable) {
    // The recent slot must still be in the SlotHashes sysvar.
    const [createIx, table] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: (await conn.getSlot("confirmed")) - 1,
    });
    await send([createIx]);
    devnet.lookupTable = table.toBase58();
    save();
  }
  const lookupTable = new PublicKey(devnet.lookupTable);
  const current = (await conn.getAddressLookupTable(lookupTable)).value?.state.addresses ?? [];
  const missing = wanted.filter((a) => !current.some((c) => c.equals(a)));
  for (let i = 0; i < missing.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({
      lookupTable,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: missing.slice(i, i + 20),
    })]);
  }
  console.log("lookup table", lookupTable.toBase58(), `(${current.length + missing.length} addresses, ${missing.length} added)`);
}

async function main() {
  console.log("payer", payer.publicKey.toBase58(), (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
  if (!devnet.usdcMint) await createRoutes();
  if (!devnet.solRoute) await createSolRoute();
  await ensureLookupTable();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
