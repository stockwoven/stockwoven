// A customer's vault history, read from chain: their latest transactions, with what moved in and
// out of their wallet per token.

import { ConfirmedSignatureInfo, Connection, ParsedTransactionWithMeta, PublicKey, TokenBalance } from "@solana/web3.js";
import { VaultConfig } from "./config.js";

export type ActivityKind = "deposit" | "redeem" | "swap" | "other";

export type Activity = {
  signature: string;
  time: Date | null;
  kind: ActivityKind;
  failed: boolean;
  /** Net change in the owner's wallet per token symbol (decimal amounts; SOL net of the fee they paid). */
  changes: Record<string, number>;
};

function tokenDelta(tx: ParsedTransactionWithMeta, owner: string, mint: string) {
  const sum = (list?: TokenBalance[] | null) =>
    (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((t, b) => t + (b.uiTokenAmount.uiAmount ?? 0), 0);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** The owner's SOL change, including wSOL that was wrapped and unwrapped inside the transaction. */
function solDelta(tx: ParsedTransactionWithMeta, owner: string) {
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
  if (i < 0 || !tx.meta) return 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i] + (i === 0 ? tx.meta.fee : 0)) / 1e9;
}

function toActivity(cfg: VaultConfig, sig: ConfirmedSignatureInfo, owner: string, tx: ParsedTransactionWithMeta | null): Activity {
  const changes: Record<string, number> = {};
  if (tx) {
    for (const t of [cfg.share, ...cfg.assets.filter((a) => a.kind !== "sol")]) {
      const d = tokenDelta(tx, owner, t.mint.toBase58());
      if (Math.abs(d) >= 10 ** -t.decimals) changes[t.symbol] = d;
    }
    const sol = solDelta(tx, owner);
    if (Math.abs(sol) >= 0.0001) changes.SOL = sol;
  }
  const shares = changes[cfg.share.symbol] ?? 0;
  const tokens = Object.entries(changes).filter(([s]) => s !== cfg.share.symbol && s !== "SOL").map(([, v]) => v);
  const logs = tx?.meta?.logMessages ?? [];
  const ran = (name: string) => logs.includes(`Program log: Instruction: ${name}`);
  const kind: ActivityKind =
    shares > 0 || (shares === 0 && ran("Deposit"))
      ? "deposit"
      : shares < 0 || ran("Redeem")
        ? "redeem"
        : (tokens.some((x) => x < 0) && tokens.some((x) => x > 0)) || ran("Swap")
          ? "swap"
          : "other";
  return { signature: sig.signature, time: sig.blockTime ? new Date(sig.blockTime * 1000) : null, kind, failed: !!sig.err, changes };
}

async function parsed(connection: Connection, signature: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      // Public RPCs rate-limit; fetch one at a time and back off.
      if (attempt >= 4 || !/429|too many requests/i.test(String(e))) return null;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

/** The owner's latest transactions, newest first. */
export async function fetchActivity(connection: Connection, cfg: VaultConfig, owner: PublicKey, limit = 20): Promise<Activity[]> {
  const signatures = await connection.getSignaturesForAddress(owner, { limit }, "confirmed");
  const out: Activity[] = [];
  for (const sig of signatures) out.push(toActivity(cfg, sig, owner.toBase58(), await parsed(connection, sig.signature)));
  return out;
}
