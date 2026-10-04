"use client";

import { Buffer } from "buffer";
import { useCallback, useEffect, useState } from "react";
import { ComputeBudgetProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PoolState, VAULT, ata, fetchPool } from "./stockwoven";

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

/** Signs and confirms a transaction with the connected wallet, tracking its status. */
export function useSend(onDone: () => void) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<TxStatus>(null);

  const send = useCallback(
    async (label: string, ixs: TransactionInstruction[]) => {
      if (!publicKey) return;
      try {
        setStatus({ kind: "pending", text: `${label}: approve in your wallet…` });
        const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        const signature = await sendTransaction(tx, connection);
        setStatus({ kind: "pending", text: `${label}: confirming…`, signature });
        const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (result.value.err) throw new Error(JSON.stringify(result.value.err));
        setStatus({ kind: "ok", text: `${label}: confirmed`, signature });
        onDone();
      } catch (e) {
        setStatus({ kind: "err", text: `${label} failed: ${(e as Error).message}` });
      }
    },
    [connection, publicKey, sendTransaction, onDone],
  );

  return { send, status, setStatus };
}
