// Instruction builders. Account orders mirror programs/stockwoven/src/instructions/*.rs; cp-amm's
// mirror its IDL (idls/cp_amm.json).

import { Buffer } from "buffer";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CP_AMM, DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, Pool, VaultConfig } from "./config.js";

/** Anchor discriminators: sha256("global:<name>")[..8]. */
const DISC = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  harvest: [228, 241, 31, 182, 53, 169, 59, 199],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
};

const u8 = (v: number) => Buffer.from([v]);
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const vecU64 = (xs: bigint[]) => Buffer.concat([u32(xs.length), ...xs.map(u64)]);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

type TokenRef = { mint: PublicKey; program: PublicKey };

/** The owner's associated token account for a token. */
export const tokenAccount = (owner: PublicKey, token: TokenRef) => getAssociatedTokenAddressSync(token.mint, owner, true, token.program);

/** Creates the owner's token account if it is missing (idempotent); `payer` pays the rent. */
export const createTokenAccountIx = (payer: PublicKey, owner: PublicKey, token: TokenRef) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, tokenAccount(owner, token), owner, token.mint, token.program);

/** Fixed accounts of `deposit` / `redeem`, then one group per asset and one per vault pool. */
function holderKeys(cfg: VaultConfig, owner: PublicKey) {
  return [
    r(owner, true), r(cfg.vault), w(cfg.share.mint), w(tokenAccount(owner, cfg.share)), r(DAMM_POOL_AUTHORITY),
    r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(cfg.share.program),
    ...cfg.assets.flatMap((a) => [w(tokenAccount(owner, a)), w(a.reserve), r(a.mint)]),
    ...cfg.pools.flatMap((p) => [w(p.pool), w(p.position!), r(p.positionNftAccount!), w(p.tokenAVault), w(p.tokenBVault)]),
  ];
}

/** Mints exactly `shares`, paying at most `maxAmounts[k]` of each asset (the rest is refunded). */
export function depositIx(cfg: VaultConfig, owner: PublicKey, shares: bigint, maxAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: cfg.program,
    data: Buffer.concat([Buffer.from(DISC.deposit), u64(shares), vecU64(maxAmounts)]),
    keys: holderKeys(cfg, owner),
  });
}

/** Burns `shares` and pays their slice of every asset, failing below `minAmounts[k]`. */
export function redeemIx(cfg: VaultConfig, owner: PublicKey, shares: bigint, minAmounts: bigint[]) {
  return new TransactionInstruction({
    programId: cfg.program,
    data: Buffer.concat([Buffer.from(DISC.redeem), u64(shares), vecU64(minAmounts)]),
    keys: holderKeys(cfg, owner),
  });
}

/** Permissionless: sends vault pool `index`'s claimable fee (the protocol's cut) to the treasury. */
export function harvestIx(cfg: VaultConfig, caller: PublicKey, index: number) {
  const p = cfg.pools[index];
  const [a, b] = [cfg.assets[p.a], cfg.assets[p.b]];
  return new TransactionInstruction({
    programId: cfg.program,
    data: Buffer.concat([Buffer.from(DISC.harvest), u8(index)]),
    keys: [
      r(caller, true), r(cfg.vault), w(p.pool), w(p.position!), r(p.positionNftAccount!), w(p.tokenAVault), w(p.tokenBVault),
      w(a.reserve), w(tokenAccount(cfg.treasury, b)), r(a.mint), r(b.mint),
      r(DAMM_POOL_AUTHORITY), r(DAMM_EVENT_AUTHORITY), r(CP_AMM), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID),
    ],
  });
}

/** A direct swap on a cp-amm pool between the owner's two token accounts. */
export function swapIx(cfg: VaultConfig, p: Pool, owner: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint) {
  const [a, b] = [cfg.assets[p.a], cfg.assets[p.b]];
  const [ua, ub] = [tokenAccount(owner, a), tokenAccount(owner, b)];
  const [input, output] = aToB ? [ua, ub] : [ub, ua];
  return new TransactionInstruction({
    programId: CP_AMM,
    data: Buffer.concat([Buffer.from(DISC.swap), u64(amountIn), u64(minOut)]),
    keys: [
      r(DAMM_POOL_AUTHORITY), w(p.pool), w(input), w(output), w(p.tokenAVault), w(p.tokenBVault),
      r(a.mint), r(b.mint), r(owner, true), r(a.program), r(b.program), r(CP_AMM), r(DAMM_EVENT_AUTHORITY), r(CP_AMM),
    ],
  });
}

/** Moves `lamports` of the owner's SOL into their wSOL account. */
export function wrapSolIxs(owner: PublicKey, lamports: bigint) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  return [SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports }), createSyncNativeInstruction(wsol)];
}

/** Closes the owner's wSOL account, returning all of it (and its rent) to the owner as SOL. */
export const unwrapSolIx = (owner: PublicKey) =>
  createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, owner, true), owner, owner);
