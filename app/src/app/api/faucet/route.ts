// Devnet-only faucet: mints the three mock SpaceX tokens and test USDC (the faucet key holds their
// mint authority) and tops up a little SOL for fees. Reads the faucet keypair from
// FAUCET_SECRET_KEY (JSON array) or FAUCET_KEYPAIR_PATH.
//
// Anyone can call it with any wallet, and a script can make wallets for free, so the per-wallet
// limit alone would let one person drain the faucet's SOL (every new wallet costs it four token
// accounts' rent plus the top-up). It therefore also has a budget for the whole server per hour,
// keeps a SOL reserve it never spends, and only tops up wallets that hold no SOL at all. nginx adds
// a per-IP limit in front (deploy/nginx/stockwoven.conf).

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
const STOCK_PER_DRIP = 10n;
/** Test USDC, for deposits and swaps that start from USDC. */
const USDC_PER_DRIP = 2_000n;
const SOL_TOP_UP = 0.05 * LAMPORTS_PER_SOL;
/** One drip per wallet per minute. */
const WALLET_COOLDOWN_MS = 60_000;
/** Drips the whole server sends per hour, and how many of them may include the SOL top-up. */
const DRIPS_PER_HOUR = Number(process.env.FAUCET_DRIPS_PER_HOUR ?? 120);
const SOL_TOP_UPS_PER_HOUR = Number(process.env.FAUCET_SOL_TOP_UPS_PER_HOUR ?? 20);
/** SOL the faucet keeps for its own fees and token-account rent; top-ups stop below it. */
const SOL_RESERVE = 0.3 * LAMPORTS_PER_SOL;
const HOUR_MS = 3_600_000;

const lastDrip = new Map<string, number>();
const drips: number[] = [];
const topUps: number[] = [];

function adminKeypair(): Keypair {
  const raw = process.env.FAUCET_SECRET_KEY
    ?? (process.env.FAUCET_KEYPAIR_PATH && readFileSync(process.env.FAUCET_KEYPAIR_PATH, "utf8"));
  if (!raw) throw new Error("faucet keypair not configured");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/** Drops timestamps older than an hour and wallet cooldowns that have ended. */
function prune(now: number) {
  while (drips.length && now - drips[0] > HOUR_MS) drips.shift();
  while (topUps.length && now - topUps[0] > HOUR_MS) topUps.shift();
  if (lastDrip.size > 10_000) {
    for (const [k, t] of lastDrip) if (now - t > WALLET_COOLDOWN_MS) lastDrip.delete(k);
  }
}

const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return refuse("expected JSON", 415);
  // Refused before reading, so a huge body never reaches memory (nginx also caps it at 4 KB).
  if (Number(req.headers.get("content-length") ?? 0) > 1_024) return refuse("request too large", 413);
  const body = await req.text();
  if (body.length > 1_024) return refuse("request too large", 413);

  let owner: PublicKey;
  try {
    owner = new PublicKey(JSON.parse(body).owner);
  } catch {
    return refuse("invalid owner", 400);
  }
  // A wallet, not a program address: token accounts for off-curve owners would just fail.
  if (!PublicKey.isOnCurve(owner.toBytes())) return refuse("invalid owner", 400);

  const now = Date.now();
  prune(now);
  const key = owner.toBase58();
  if (now - (lastDrip.get(key) ?? 0) < WALLET_COOLDOWN_MS) return refuse("one drip per minute", 429);
  if (drips.length >= DRIPS_PER_HOUR) return refuse("the faucet is busy; try again later", 429);
  // Claimed before the transaction, so parallel requests for one wallet can't all pass.
  lastDrip.set(key, now);
  drips.push(now);

  try {
    const admin = adminKeypair();
    const conn = new Connection(RPC, "confirmed");
    const tx = new Transaction();
    const tokens: [string, number, bigint][] = devnet.assets
      .filter((a) => a.kind !== "sol")
      .map((a) => [a.mint, a.decimals, a.kind === "usdc" ? USDC_PER_DRIP : STOCK_PER_DRIP]);
    for (const [mint, decimals, units] of tokens) {
      const mintKey = new PublicKey(mint);
      const account = getAssociatedTokenAddressSync(mintKey, owner);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, account, owner, mintKey),
        createMintToInstruction(mintKey, account, admin.publicKey, units * 10n ** BigInt(decimals)),
      );
    }
    const [ownerSol, faucetSol] = await Promise.all([conn.getBalance(owner), conn.getBalance(admin.publicKey)]);
    if (ownerSol < SOL_TOP_UP / 2 && topUps.length < SOL_TOP_UPS_PER_HOUR && faucetSol - SOL_TOP_UP > SOL_RESERVE) {
      tx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner, lamports: SOL_TOP_UP }));
      topUps.push(now);
    }
    const signature = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    return NextResponse.json({ signature });
  } catch (e) {
    // The details stay in the server log; the caller only learns that it failed.
    console.error("faucet:", e);
    return refuse("the faucet could not send right now; try again in a minute", 502);
  }
}
