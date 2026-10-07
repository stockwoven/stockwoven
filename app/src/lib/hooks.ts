"use client";

import { Buffer } from "buffer";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ComputeBudgetProgram,
  ConfirmedSignatureInfo,
  Connection,
  ParsedTransactionWithMeta,
  PublicKey,
  TokenBalance,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ASSETS, SHARE_DECIMALS, SOL, VAULT, VaultState, assetAccount, ata, fetchVaultState } from "./stockwoven";

export type VaultData = {
  state: VaultState;
  /**
   * Raw wallet balances per vault asset. For SOL it is what the wallet can put in: its SOL plus
   * any wSOL it already holds. `lamports` is the native SOL alone.
   */
  user?: { balances: bigint[]; shares: bigint; lamports: bigint; wsol: bigint; exists: boolean[] };
};

const tokenAmount = (data?: Buffer | Uint8Array | null) =>
  data && data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n;

/** The vault's pools, reserves and supply, and the connected wallet's balances, refreshed every 10 s. */
export function useVaultData() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await fetchVaultState(connection);
      let user: VaultData["user"];
      if (publicKey) {
        const [accounts, lamports] = await Promise.all([
          connection.getMultipleAccountsInfo([...ASSETS.map((_, k) => assetAccount(publicKey, k)), ata(publicKey, VAULT.shareMint)]),
          connection.getBalance(publicKey),
        ]);
        const balances = ASSETS.map((_, k) => tokenAmount(accounts[k]?.data));
        const wsol = SOL >= 0 ? balances[SOL] : 0n;
        if (SOL >= 0) balances[SOL] = wsol + BigInt(lamports);
        const exists = accounts.map((a) => !!a);
        user = { balances, shares: tokenAmount(accounts[ASSETS.length]?.data), lamports: BigInt(lamports), wsol, exists };
      }
      setData({ state, user });
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
  // Program error codes: DepositsPaused = 6002, SlippageExceeded = 6022 (programs/stockwoven/src/error.rs).
  if (/DepositsPaused|Deposits are paused|0x1772\b|"Custom":6002\b/i.test(message)) return "Deposits are paused by the vault. Redemptions stay open.";
  if (/InstructionFallbackNotFound|0x65\b|"Custom":101\b/.test(message)) return "The devnet vault program does not support this yet. It needs the latest program upgrade.";
  if (/slippage|0x1786\b|"Custom":6022\b/i.test(message)) return "The pools moved past your slippage limit. Refresh the quote and try again.";
  return message;
}

/**
 * Signs and confirms transactions with the connected wallet, tracking their status. With a
 * `lookupTable` they are v0 transactions, for instructions that touch too many accounts otherwise.
 *
 * `ixs` can be several steps (an array of instruction lists): each becomes its own transaction,
 * all signed in one wallet prompt where the wallet supports it, then sent and confirmed in order.
 * A one-token deposit needs this: its swaps and the deposit together exceed the runtime's limit
 * of 64 instructions and inner calls per transaction.
 */
export function useSend(onDone: () => void) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signAllTransactions } = useWallet();
  const [status, setStatus] = useState<TxStatus>(null);

  const send = useCallback(
    async (label: string, ixs: TransactionInstruction[] | TransactionInstruction[][], lookupTable?: PublicKey) => {
      if (!publicKey) return;
      const steps = (Array.isArray(ixs[0]) ? ixs : [ixs]) as TransactionInstruction[][];
      try {
        setStatus({ kind: "pending", text: `Approve the ${label.toLowerCase()} in your wallet.` });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const table = lookupTable ? (await connection.getAddressLookupTable(lookupTable)).value : null;
        if (lookupTable && !table) throw new Error("address lookup table not found");
        const txs = steps.map((step) => {
          const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...step];
          if (table) {
            const message = new TransactionMessage({ payerKey: publicKey, recentBlockhash: blockhash, instructions });
            return new VersionedTransaction(message.compileToV0Message([table]));
          }
          const tx = new Transaction().add(...instructions);
          tx.recentBlockhash = blockhash;
          tx.feePayer = publicKey;
          return tx;
        });

        const confirm = async (signature: string, i: number) => {
          const of = txs.length > 1 ? ` (${i + 1} of ${txs.length})` : "";
          setStatus({ kind: "pending", text: `Sent${of}. Waiting for devnet to confirm it.`, signature });
          const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
          if (result.value.err) throw new Error(JSON.stringify(result.value.err));
          return signature;
        };

        let last = "";
        if (txs.length > 1 && signAllTransactions) {
          const signed = await signAllTransactions(txs);
          for (const [i, tx] of signed.entries()) {
            last = await confirm(await connection.sendRawTransaction(tx.serialize()), i);
          }
        } else {
          for (const [i, tx] of txs.entries()) last = await confirm(await sendTransaction(tx, connection), i);
        }
        setStatus({ kind: "ok", text: `${label} confirmed.`, signature: last });
        onDone();
      } catch (e) {
        setStatus({ kind: "err", text: explainError(e) });
      }
    },
    [connection, publicKey, sendTransaction, signAllTransactions, onDone],
  );

  return { send, status, setStatus };
}

/** Asks the devnet faucet route for test tokens and a little SOL. */
export function useFaucet(onDone: () => void) {
  const { publicKey } = useWallet();
  const [status, setStatus] = useState<TxStatus>(null);

  const drip = useCallback(async () => {
    if (!publicKey) return;
    setStatus({ kind: "pending", text: "Sending 10 of each mock SpaceX token, 2,000 test USDC and devnet SOL for fees." });
    try {
      const res = await fetch("/api/faucet", { method: "POST", body: JSON.stringify({ owner: publicKey.toBase58() }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus({ kind: "ok", text: "10 SPCXx, 10 SPCX, 10 SPCXon and 2,000 test USDC are in your wallet.", signature: body.signature });
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

export type ActivityKind = "Deposit" | "Redeem" | "Swap" | "Test tokens" | "Other";

export type Activity = {
  signature: string;
  time: Date | null;
  kind: ActivityKind;
  failed: boolean;
  changes: { symbol: string; amount: number }[];
  /** "loading" while the details are on their way, "unavailable" when the RPC would not return them. */
  details: "ok" | "loading" | "unavailable";
};

const SHARE_SYMBOL = `sw${VAULT.stock}`;
/** Token balances the activity list follows. SOL is read from the wallet's lamports instead of wSOL. */
const SYMBOLS: [PublicKey, string][] = [
  [VAULT.shareMint, SHARE_SYMBOL],
  ...ASSETS.filter((a) => a.kind !== "sol").map((a): [PublicKey, string] => [a.mint, a.symbol]),
];

function delta(tx: ParsedTransactionWithMeta, owner: string, mint: PublicKey) {
  const sum = (list?: TokenBalance[] | null) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint.toBase58())
      .reduce((total, b) => total + (b.uiTokenAmount.uiAmount ?? 0), 0);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** The wallet's SOL change, leaving out the network fee it paid. */
function solDelta(tx: ParsedTransactionWithMeta, owner: string) {
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
  if (i < 0 || !tx.meta) return 0;
  const fee = i === 0 ? tx.meta.fee : 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i] + fee) / 1e9;
}

function classify(changes: Map<string, number>, logs: string[]): ActivityKind {
  const shares = changes.get(SHARE_SYMBOL) ?? 0;
  if (shares > 0) return "Deposit";
  if (shares < 0) return "Redeem";
  const tokens = [...changes].filter(([symbol]) => symbol !== SHARE_SYMBOL && symbol !== "SOL").map(([, amount]) => amount);
  if (tokens.some((x) => x < 0) && tokens.some((x) => x > 0)) return "Swap";
  if (tokens.length > 1 && tokens.every((x) => x > 0)) return "Test tokens";
  // No balance moved, e.g. a failed transaction: name it after the instruction it ran.
  const ran = (name: string) => logs.includes(`Program log: Instruction: ${name}`);
  if (ran("Deposit")) return "Deposit";
  if (ran("Redeem")) return "Redeem";
  if (ran("Swap")) return "Swap";
  return "Other";
}

function toActivity(sig: ConfirmedSignatureInfo, owner: string, tx: ParsedTransactionWithMeta | null | undefined): Activity {
  const base = { signature: sig.signature, time: sig.blockTime ? new Date(sig.blockTime * 1000) : null, failed: !!sig.err };
  if (!tx) return { ...base, kind: "Other", changes: [], details: tx === undefined ? "loading" : "unavailable" };
  const changes = new Map<string, number>();
  for (const [mint, symbol] of SYMBOLS) {
    const d = delta(tx, owner, mint);
    if (Math.abs(d) >= 10 ** -SHARE_DECIMALS) changes.set(symbol, d);
  }
  const sol = solDelta(tx, owner);
  if (Math.abs(sol) >= 0.0001) changes.set("SOL", sol);
  return {
    ...base,
    kind: classify(changes, tx.meta?.logMessages ?? []),
    changes: [...changes].map(([symbol, amount]) => ({ symbol, amount })),
    details: "ok",
  };
}

/** Confirmed transactions never change, so each is fetched once per page load. */
const parsed = new Map<string, ParsedTransactionWithMeta>();

/** One transaction at a time, because public RPCs rate-limit batches. Retries a 429 with backoff. */
async function fetchParsed(connection: Connection, signature: string) {
  const cached = parsed.get(signature);
  if (cached) return cached;
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (tx) parsed.set(signature, tx);
      return tx;
    } catch (e) {
      if (attempt >= 4 || !/429|too many requests/i.test(String(e))) return null;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

/**
 * A wallet's latest activity. The wallet signs or receives every deposit, redeem, swap and faucet
 * drip, so its own signatures are the history. `onRows` gets the rows as soon as
 * the signatures arrive, then again as each transaction's details load; it stops once `stale()`.
 */
export async function loadActivity(
  connection: Connection,
  wallet: PublicKey,
  limit: number,
  onRows: (rows: Activity[]) => void,
  stale: () => boolean = () => false,
) {
  const owner = wallet.toBase58();
  const signatures = await connection.getSignaturesForAddress(wallet, { limit }, "confirmed");
  const rows = signatures.map((s) => toActivity(s, owner, parsed.get(s.signature)));
  if (stale()) return;
  onRows([...rows]);
  for (const [i, s] of signatures.entries()) {
    if (rows[i].details === "ok") continue;
    const tx = await fetchParsed(connection, s.signature);
    if (stale()) return;
    rows[i] = toActivity(s, owner, tx);
    onRows([...rows]);
  }
}

/** The connected wallet's activity, for the portfolio. */
export function useActivity(limit = 10) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A newer load (wallet switch, refresh) makes an older one stop updating the list.
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    if (!publicKey) {
      setItems(null);
      return;
    }
    setLoading(true);
    try {
      await loadActivity(
        connection,
        publicKey,
        limit,
        (rows) => {
          setItems(rows);
          setError(null);
        },
        () => id !== run.current,
      );
    } catch (e) {
      if (id === run.current) setError(explainError(e));
    } finally {
      if (id === run.current) setLoading(false);
    }
  }, [connection, publicKey, limit]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, error, loading, reload: load };
}
