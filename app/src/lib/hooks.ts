"use client";

import { Buffer } from "buffer";
import { useCallback, useEffect, useState } from "react";
import {
  ComputeBudgetProgram,
  ParsedTransactionWithMeta,
  PublicKey,
  TokenBalance,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PoolState, SHARE_DECIMALS, VAULT, ata, fetchPool } from "./stockwoven";

export type VaultData = {
  pool: PoolState;
  shareSupply: bigint;
  user?: { a: bigint; b: bigint; shares: bigint; sol: number };
};

const tokenAmount = (data?: Buffer | Uint8Array | null) =>
  data && data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n;

/** Pool reserves, share supply and the connected wallet's balances, refreshed every 10 s. */
export function useVaultData() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pool, supply] = await Promise.all([
        fetchPool(connection),
        connection.getTokenSupply(VAULT.shareMint),
      ]);
      let user: VaultData["user"];
      if (publicKey) {
        const [accounts, lamports] = await Promise.all([
          connection.getMultipleAccountsInfo([
            ata(publicKey, VAULT.mintA),
            ata(publicKey, VAULT.mintB),
            ata(publicKey, VAULT.shareMint),
          ]),
          connection.getBalance(publicKey),
        ]);
        user = {
          a: tokenAmount(accounts[0]?.data),
          b: tokenAmount(accounts[1]?.data),
          shares: tokenAmount(accounts[2]?.data),
          sol: lamports / 1e9,
        };
      }
      setData({ pool, shareSupply: BigInt(supply.value.amount), user });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { data, error, refresh };
}

export type TxStatus = { kind: "pending" | "ok" | "err"; text: string; signature?: string } | null;

/** Wallet and RPC errors, rewritten for people. */
export function explainError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  if (/reject|denied|declined/i.test(message)) return "You declined the request in your wallet. Nothing was sent.";
  if (/insufficient (funds|lamports)|0x1\b/i.test(message)) return "Not enough devnet SOL or tokens to pay for this. Get test tokens, then try again.";
  if (/blockhash|expired|block height exceeded/i.test(message)) return "The transaction expired before it confirmed. Try again.";
  if (/DepositsPaused|Deposits are paused|0x1771\b|"Custom":6001\b/i.test(message)) return "Deposits are paused by the vault. Redemptions stay open.";
  if (/InstructionFallbackNotFound|0x65\b|"Custom":101\b/.test(message)) return "The devnet vault program does not support this yet. It needs the latest program upgrade.";
  if (/slippage|0x177a\b|"Custom":6010\b/i.test(message)) return "The pool moved past your slippage limit. Refresh the quote and try again.";
  return message;
}

/**
 * Signs and confirms a transaction with the connected wallet, tracking its status. With a
 * `lookupTable` it sends a v0 transaction, for instructions that touch too many accounts otherwise.
 */
export function useSend(onDone: () => void) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<TxStatus>(null);

  const send = useCallback(
    async (label: string, ixs: TransactionInstruction[], lookupTable?: PublicKey) => {
      if (!publicKey) return;
      try {
        setStatus({ kind: "pending", text: `Approve the ${label.toLowerCase()} in your wallet.` });
        const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs];
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        let tx: Transaction | VersionedTransaction;
        if (lookupTable) {
          const table = (await connection.getAddressLookupTable(lookupTable)).value;
          if (!table) throw new Error("address lookup table not found");
          const message = new TransactionMessage({ payerKey: publicKey, recentBlockhash: blockhash, instructions });
          tx = new VersionedTransaction(message.compileToV0Message([table]));
        } else {
          tx = new Transaction().add(...instructions);
          tx.recentBlockhash = blockhash;
          tx.feePayer = publicKey;
        }
        const signature = await sendTransaction(tx, connection);
        setStatus({ kind: "pending", text: "Sent. Waiting for devnet to confirm it.", signature });
        const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (result.value.err) throw new Error(JSON.stringify(result.value.err));
        setStatus({ kind: "ok", text: `${label} confirmed.`, signature });
        onDone();
      } catch (e) {
        setStatus({ kind: "err", text: explainError(e) });
      }
    },
    [connection, publicKey, sendTransaction, onDone],
  );

  return { send, status, setStatus };
}

/** Asks the devnet faucet route for test tokens and a little SOL. */
export function useFaucet(onDone: () => void) {
  const { publicKey } = useWallet();
  const [status, setStatus] = useState<TxStatus>(null);

  const drip = useCallback(async () => {
    if (!publicKey) return;
    setStatus({ kind: "pending", text: "Sending 10 mINTCx, 10 mINTC and devnet SOL for fees." });
    try {
      const res = await fetch("/api/faucet", { method: "POST", body: JSON.stringify({ owner: publicKey.toBase58() }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus({ kind: "ok", text: "10 mINTCx and 10 mINTC are in your wallet.", signature: body.signature });
        onDone();
      } else if (res.status === 429) {
        setStatus({ kind: "err", text: "The faucet sends once a minute per wallet. Try again in a minute." });
      } else {
        setStatus({ kind: "err", text: `The faucet could not send: ${body.error ?? res.statusText}.` });
      }
    } catch (e) {
      setStatus({ kind: "err", text: explainError(e) });
    }
  }, [publicKey, onDone]);

  return { drip, status };
}

export type ActivityKind = "Deposit" | "Redeem" | "Convert" | "Test tokens" | "Other";

export type Activity = {
  signature: string;
  time: Date | null;
  kind: ActivityKind;
  failed: boolean;
  changes: { symbol: string; amount: number }[];
};

const SYMBOLS: [PublicKey, string][] = [
  [VAULT.shareMint, "swINTC"],
  [VAULT.mintA, "mINTCx"],
  [VAULT.mintB, "mINTC"],
];

function delta(tx: ParsedTransactionWithMeta, owner: string, mint: PublicKey) {
  const sum = (list?: TokenBalance[] | null) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint.toBase58())
      .reduce((total, b) => total + (b.uiTokenAmount.uiAmount ?? 0), 0);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

function classify(changes: Map<string, number>): ActivityKind {
  const [shares, a, b] = [changes.get("swINTC") ?? 0, changes.get("mINTCx") ?? 0, changes.get("mINTC") ?? 0];
  if (shares > 0) return "Deposit";
  if (shares < 0) return "Redeem";
  if ((a < 0 && b > 0) || (a > 0 && b < 0)) return "Convert";
  if (a > 0 && b > 0) return "Test tokens";
  return "Other";
}

/**
 * The connected wallet's latest vault activity. Every deposit, redeem, conversion and faucet drip
 * touches the wallet's mINTCx account, so its signatures are the history.
 */
export function useActivity(limit = 10) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!publicKey) {
      setItems(null);
      return;
    }
    setLoading(true);
    try {
      const signatures = await connection.getSignaturesForAddress(ata(publicKey, VAULT.mintA), { limit });
      const txs = signatures.length
        ? await connection.getParsedTransactions(
            signatures.map((s) => s.signature),
            { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
          )
        : [];
      const owner = publicKey.toBase58();
      setItems(
        signatures.map((s, i) => {
          const tx = txs[i];
          const changes = new Map<string, number>();
          if (tx) for (const [mint, symbol] of SYMBOLS) {
            const d = delta(tx, owner, mint);
            if (Math.abs(d) >= 10 ** -SHARE_DECIMALS) changes.set(symbol, d);
          }
          return {
            signature: s.signature,
            time: s.blockTime ? new Date(s.blockTime * 1000) : null,
            kind: classify(changes),
            failed: !!s.err,
            changes: [...changes].map(([symbol, amount]) => ({ symbol, amount })),
          };
        }),
      );
      setError(null);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, limit]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, error, loading, reload: load };
}
