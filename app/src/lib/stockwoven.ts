// Client for the Stockwoven vault on devnet: instruction builders, pool reads and quotes.
// Account order mirrors programs/stockwoven/src/instructions/*.rs.

import { Buffer } from "buffer";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import devnet from "./devnet.json";

export const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

export const SHARE_DECIMALS = 8;
export const TRADE_FEE_BPS = 10;
export const COMPOUNDING_FEE_BPS = 8_000;

export const VAULT = {
  program: new PublicKey(devnet.program),
  mintA: new PublicKey(devnet.mintA),
  mintB: new PublicKey(devnet.mintB),
  decimalsA: devnet.decimalsA,
  decimalsB: devnet.decimalsB,
  pool: new PublicKey(devnet.pool),
  vault: new PublicKey(devnet.vault),
  shareMint: new PublicKey(devnet.shareMint),
  position: new PublicKey(devnet.position),
  positionNftAccount: new PublicKey(devnet.positionNftAccount),
  tokenAVault: new PublicKey(devnet.tokenAVault),
  tokenBVault: new PublicKey(devnet.tokenBVault),
  reserveA: new PublicKey(devnet.reserveA),
  reserveB: new PublicKey(devnet.reserveB),
  treasury: new PublicKey(devnet.treasury),
  liquidityPerShare: BigInt(devnet.liquidityPerShare),
};

const DISC = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  harvest: [228, 241, 31, 182, 53, 169, 59, 199],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
};

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const data = (disc: number[], ...args: bigint[]) => Buffer.concat([Buffer.from(disc), ...args.map(u64)]);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner);

/** Creates the user's A, B and share accounts if they don't exist yet. */
export function ensureAccountsIxs(user: PublicKey): TransactionInstruction[] {
  return [VAULT.mintA, VAULT.mintB, VAULT.shareMint].map((mint) =>
    createAssociatedTokenAccountIdempotentInstruction(user, ata(user, mint), user, mint),
  );
}

export function depositIx(user: PublicKey, shares: bigint, maxA: bigint, maxB: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: data(DISC.deposit, shares, maxA, maxB),
    keys: [
      r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
      w(ata(user, VAULT.mintA)), w(ata(user, VAULT.mintB)), w(VAULT.reserveA), w(VAULT.reserveB),
      r(VAULT.mintA), r(VAULT.mintB), w(VAULT.pool), w(VAULT.position), r(VAULT.positionNftAccount),
      w(VAULT.tokenAVault), w(VAULT.tokenBVault), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

export function redeemIx(user: PublicKey, shares: bigint, minA: bigint, minB: bigint) {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: data(DISC.redeem, shares, minA, minB),
    keys: [
      r(user, true), r(VAULT.vault), w(VAULT.shareMint), w(ata(user, VAULT.shareMint)),
      w(ata(user, VAULT.mintA)), w(ata(user, VAULT.mintB)), r(VAULT.mintA), r(VAULT.mintB),
      w(VAULT.pool), w(VAULT.position), r(VAULT.positionNftAccount), w(VAULT.tokenAVault), w(VAULT.tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
      r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

export function harvestIx() {
  return new TransactionInstruction({
    programId: VAULT.program,
    data: Buffer.from(DISC.harvest),
    keys: [
      r(VAULT.vault), w(VAULT.reserveA), w(VAULT.treasury), r(VAULT.mintA), r(VAULT.mintB), r(VAULT.pool),
      w(VAULT.position), r(VAULT.positionNftAccount), w(VAULT.tokenAVault), w(VAULT.tokenBVault),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
    ],
  });
}

/** A direct DAMM v2 swap between the two issuers' tokens; the vault program is not involved. */
export function swapIx(user: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [input, output] = aToB
    ? [ata(user, VAULT.mintA), ata(user, VAULT.mintB)]
    : [ata(user, VAULT.mintB), ata(user, VAULT.mintA)];
  return new TransactionInstruction({
    programId: CP_AMM,
    data: data(DISC.swap, amountIn, minOut),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(VAULT.pool), w(input), w(output), w(VAULT.tokenAVault), w(VAULT.tokenBVault),
      r(VAULT.mintA), r(VAULT.mintB), r(user, true), r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID),
      r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

export type PoolState = { liquidity: bigint; reserveA: bigint; reserveB: bigint };

/** Reads cp-amm's Pool account (offsets include the 8-byte discriminator). */
export async function fetchPool(conn: Connection): Promise<PoolState> {
  const info = await conn.getAccountInfo(VAULT.pool);
  if (!info) throw new Error("pool not found");
  const d = Buffer.from(info.data);
  return {
    liquidity: d.readBigUInt64LE(360) + (d.readBigUInt64LE(368) << 64n),
    reserveA: d.readBigUInt64LE(680),
    reserveB: d.readBigUInt64LE(688),
  };
}

/** One token of either issuer counts as one share of stock. */
export const stockValue = (a: bigint, b: bigint) =>
  Number(a) / 10 ** VAULT.decimalsA + Number(b) / 10 ** VAULT.decimalsB;

/** Shares of stock behind one whole swINTC. */
export function navPerShare(pool: PoolState) {
  const l = Number(VAULT.liquidityPerShare * 10n ** BigInt(SHARE_DECIMALS)) / Number(pool.liquidity);
  return l * stockValue(pool.reserveA, pool.reserveB);
}

/** Tokens cp-amm will take for `shares` (it rounds up on deposit, down on redeem). */
export function quoteShares(pool: PoolState, shares: bigint, roundUp: boolean) {
  const dl = shares * VAULT.liquidityPerShare;
  const div = roundUp ? ceilDiv : (a: bigint, b: bigint) => a / b;
  return { a: div(dl * pool.reserveA, pool.liquidity), b: div(dl * pool.reserveB, pool.liquidity) };
}

/** x·y = k quote. Compounding pools charge the fee in token B: on output for A→B, on input for B→A. */
export function quoteSwap(pool: PoolState, aToB: boolean, amountIn: bigint) {
  const fee = (x: bigint) => (x * BigInt(TRADE_FEE_BPS)) / 10_000n;
  if (aToB) {
    const gross = (pool.reserveB * amountIn) / (pool.reserveA + amountIn);
    return gross - fee(gross);
  }
  const net = amountIn - fee(amountIn);
  return (pool.reserveA * net) / (pool.reserveB + net);
}

export function toRaw(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const fromRaw = (raw: bigint, decimals: number, digits = 4) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: digits });

export const explorer = (address: PublicKey | string, kind: "address" | "tx" = "address") =>
  `https://explorer.solana.com/${kind}/${address.toString()}?cluster=devnet`;

export const shortAddress = (address: PublicKey | string) => {
  const s = address.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** Signed figure with a true minus sign, for balance changes. */
export const signed = (value: number, digits = 4) =>
  `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: digits })}`;
