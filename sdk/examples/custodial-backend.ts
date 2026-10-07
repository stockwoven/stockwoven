// A neobank backend that holds its customers' wallets (custody) and sponsors their fees.
// It deposits 20 USDC for one customer into swSPCX on devnet, then shows the position.
//
// Dry run (simulates the first step, sends nothing):
//   CUSTOMER_KEYPAIR=customer.json npm run example:custodial
// Send for real on devnet:
//   CUSTOMER_KEYPAIR=customer.json SPONSOR_KEYPAIR=sponsor.json SEND=1 npm run example:custodial
//
// The customer wallet needs test USDC (the Stockwoven app's faucet gives 2,000) and, without a
// sponsor, a little devnet SOL.

import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { Stockwoven, fromRaw, parseError, toRaw } from "../src/index.js";

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const sw = new Stockwoven({ connection }); // swSPCX on devnet
const customer = load(process.env.CUSTOMER_KEYPAIR ?? "customer.json");
const sponsor = process.env.SPONSOR_KEYPAIR ? load(process.env.SPONSOR_KEYPAIR) : customer;
const share = sw.vault.share;

try {
  // 1. Quote: 20 USDC in, how much swSPCX out. The transaction swaps the USDC into the vault's mix
  //    of SpaceX tokens, USDC and SOL, then deposits it.
  const quote = await sw.quoteDeposit({ pay: "USDC", amount: toRaw("20", 6) });
  console.log(`20 USDC → ${fromRaw(quote.shares, share.decimals)} ${share.symbol} (worth $${quote.valueUsd.toFixed(2)}), ${quote.route} route`);

  // 2. Build: unsigned transactions (two for a one-token deposit: the swaps, then the deposit).
  //    The sponsor pays fees and rent; the customer authorizes the spend.
  const built = await sw.buildDeposit(quote, { owner: customer.publicKey, feePayer: sponsor.publicKey });

  // 3. Send in order, or simulate the first step on a dry run (the second depends on it).
  if (process.env.SEND === "1") {
    const signatures = await sw.sendAll(built, [sponsor, customer]);
    for (const s of signatures) console.log(`confirmed: https://explorer.solana.com/tx/${s}?cluster=devnet`);
  } else {
    const first = built.transactions[0];
    first.sign([sponsor, customer].filter((k, i, all) => all.findIndex((x) => x.publicKey.equals(k.publicKey)) === i));
    const sim = await connection.simulateTransaction(first, { commitment: "confirmed" });
    if (sim.value.err) throw { message: JSON.stringify(sim.value.err), logs: sim.value.logs };
    console.log(`step 1 of ${built.transactions.length} simulates (${sim.value.unitsConsumed} compute units). Set SEND=1 to send.`);
  }
} catch (e) {
  const error = parseError(e);
  console.error(`${error.kind}: ${error.message}`); // e.g. InsufficientFunds: Not enough tokens or SOL to pay for this.
  process.exit(1);
}

// 4. What the customer holds now.
const position = await sw.getPosition(customer.publicKey);
console.log(`${customer.publicKey.toBase58()} holds ${fromRaw(position.shares, share.decimals)} ${share.symbol} ≈ $${position.valueUsd.toFixed(2)}`);
