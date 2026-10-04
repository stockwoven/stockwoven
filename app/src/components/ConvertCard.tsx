"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VaultData, useSend } from "@/lib/hooks";
import { TRADE_FEE_BPS, VAULT, ensureAccountsIxs, fromRaw, quoteSwap, swapIx, toRaw } from "@/lib/stockwoven";
import { Status } from "./Status";

const SLIPPAGE_BPS = 100n;

export function ConvertCard({ data, refresh }: { data: VaultData | null; refresh: () => void }) {
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const [aToB, setAToB] = useState(true);
  const [amount, setAmount] = useState("1");

  const [from, to] = aToB ? ["mINTCx", "mINTC"] : ["mINTC", "mINTCx"];
  const [inDecimals, outDecimals] = aToB ? [VAULT.decimalsA, VAULT.decimalsB] : [VAULT.decimalsB, VAULT.decimalsA];
  const amountIn = toRaw(amount, inDecimals);
  const out = data && amountIn > 0n ? quoteSwap(data.pool, aToB, amountIn) : null;
  const balance = data?.user ? (aToB ? data.user.a : data.user.b) : undefined;

  let problem: string | null = null;
  if (!publicKey) problem = "Connect a wallet";
  else if (!out) problem = "Enter an amount";
  else if (balance !== undefined && balance < amountIn) problem = `Not enough ${from}`;

  function submit() {
    if (!publicKey || !out) return;
    const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    send("Convert", [...ensureAccountsIxs(publicKey), swapIx(publicKey, aToB, amountIn, minOut)]);
  }

  return (
    <section className="card">
      <h2>Convert between issuers</h2>
      <div className="flow">
        <b>{from}</b>
        <button className="pill accent" style={{ cursor: "pointer", background: "none" }} onClick={() => setAToB(!aToB)} aria-label="Switch direction">
          ⇄ switch
        </button>
        <b>{to}</b>
      </div>
      <label className="field">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${from} amount`} />
        <span className="mono">{from}</span>
      </label>
      <div className="rows">
        <div className="row">
          You receive
          <b>{out !== null ? `${fromRaw(out, outDecimals, 6)} ${to}` : "—"}</b>
        </div>
        <div className="row">
          Fee
          <b>{TRADE_FEE_BPS / 100}%</b>
        </div>
      </div>
      <button className="btn" disabled={!!problem || status?.kind === "pending"} onClick={submit}>
        {problem ?? "Convert"}
      </button>
      <p className="note">
        A direct swap on the Meteora DAMM v2 pool, the same route Jupiter would take. Most of the fee stays in the pool and
        raises the value of every swINTC.
      </p>
      <Status status={status} />
    </section>
  );
}
