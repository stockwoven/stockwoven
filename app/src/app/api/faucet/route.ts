// Devnet-only faucet: mints mock issuer tokens (the admin holds the mint authority) and tops up
// a little SOL for fees. Reads the admin keypair from FAUCET_SECRET_KEY (JSON array) or
// FAUCET_KEYPAIR_PATH.

import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import devnet from "@/lib/devnet.json";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const TOKENS_PER_DRIP = 10n;
/** Test USDC, for deposits that start from USDC (the admin also holds its mint authority). */
const USDC_PER_DRIP = 100n;
const SOL_TOP_UP = 0.02 * LAMPORTS_PER_SOL;
const recent = new Map<string, number>();

function adminKeypair(): Keypair {
  const raw = process.env.FAUCET_SECRET_KEY
    ?? (process.env.FAUCET_KEYPAIR_PATH && readFileSync(process.env.FAUCET_KEYPAIR_PATH, "utf8"));
  if (!raw) throw new Error("faucet keypair not configured");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export async function POST(req: Request) {
  let owner: PublicKey;
  try {
    owner = new PublicKey((await req.json()).owner);
  } catch {
    return NextResponse.json({ error: "invalid owner" }, { status: 400 });
  }
  const last = recent.get(owner.toBase58()) ?? 0;
  if (Date.now() - last < 60_000) {
    return NextResponse.json({ error: "one drip per minute" }, { status: 429 });
  }

  try {
    const admin = adminKeypair();
    const conn = new Connection(RPC, "confirmed");
    const tx = new Transaction();
    const drips: [string, number, bigint][] = [
      [devnet.mintA, devnet.decimalsA, TOKENS_PER_DRIP],
      [devnet.mintB, devnet.decimalsB, TOKENS_PER_DRIP],
      ...(devnet.usdcMint ? [[devnet.usdcMint, devnet.usdcDecimals, USDC_PER_DRIP] as [string, number, bigint]] : []),
    ];
    for (const [mint, decimals, units] of drips) {
      const mintKey = new PublicKey(mint);
      const account = getAssociatedTokenAddressSync(mintKey, owner);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, account, owner, mintKey),
        createMintToInstruction(mintKey, account, admin.publicKey, units * 10n ** BigInt(decimals)),
      );
    }
    if ((await conn.getBalance(owner)) < SOL_TOP_UP / 2) {
      tx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner, lamports: SOL_TOP_UP }));
    }
    const signature = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    recent.set(owner.toBase58(), Date.now());
    return NextResponse.json({ signature });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
