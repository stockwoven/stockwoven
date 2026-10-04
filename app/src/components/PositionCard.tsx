"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TxStatus, VaultData, useSend } from "@/lib/hooks";
import { SHARE_DECIMALS, VAULT, explorer, fromRaw, harvestIx, navPerShare } from "@/lib/stockwoven";
import { Status } from "./Status";

export function PositionCard({ data, refresh }: { data: VaultData | null; refresh: () => void }) {
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const [faucet, setFaucet] = useState<TxStatus>(null);
  const user = data?.user;
  const nav = data ? navPerShare(data.pool) : 0;

  async function drip() {
    if (!publicKey) return;
    setFaucet({ kind: "pending", text: "Sending test tokens…" });
    const res = await fetch("/api/faucet", { method: "POST", body: JSON.stringify({ owner: publicKey.toBase58() }) });
    const body = await res.json();
    if (res.ok) {
      setFaucet({ kind: "ok", text: "10 mINTCx and 10 mINTC sent", signature: body.signature });
      refresh();
    } else {
      setFaucet({ kind: "err", text: `Faucet: ${body.error}` });
    }
  }

  return (
    <section className="card">
      <h2>Your position</h2>
      <div className="rows">
        <div className="row">
          swINTC
          <b>{user ? fromRaw(user.shares, SHARE_DECIMALS, 6) : "—"}</b>
        </div>
        <div className="row">
          Worth, in shares of Intel
          <b>{user ? ((Number(user.shares) / 10 ** SHARE_DECIMALS) * nav).toFixed(6) : "—"}</b>
        </div>
        <div className="row">
          mINTCx (mock xStocks)
          <b>{user ? fromRaw(user.a, VAULT.decimalsA) : "—"}</b>
        </div>
        <div className="row">
          mINTC (mock Backpack)
          <b>{user ? fromRaw(user.b, VAULT.decimalsB) : "—"}</b>
        </div>
        <div className="row">
          Devnet SOL
          <b>{user ? user.sol.toFixed(3) : "—"}</b>
        </div>
      </div>
      <button className="btn ghost" disabled={!publicKey || faucet?.kind === "pending"} onClick={drip}>
        Get test tokens
      </button>
      <Status status={faucet} />
      <button className="btn ghost" disabled={!publicKey || status?.kind === "pending"} onClick={() => send("Harvest", [harvestIx()])}>
        Harvest protocol fee
      </button>
      <p className="note">
        Anyone can sweep the non-compounding part of the fee to the{" "}
        <a href={explorer(VAULT.treasury)} target="_blank" rel="noreferrer">
          treasury
        </a>
        . Holders&apos; share never leaves the pool.
      </p>
      <Status status={status} />
    </section>
  );
}
