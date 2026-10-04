"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VaultData, useSend } from "@/lib/hooks";
import {
  SHARE_DECIMALS,
  VAULT,
  depositIx,
  ensureAccountsIxs,
  fromRaw,
  quoteShares,
  redeemIx,
  stockValue,
  toRaw,
} from "@/lib/stockwoven";
import { Status } from "./Status";

const SLIPPAGE_BPS = 50n;

export function VaultCard({ data, refresh }: { data: VaultData | null; refresh: () => void }) {
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const [mode, setMode] = useState<"deposit" | "redeem">("deposit");
  const [amount, setAmount] = useState("1");

  const shares = toRaw(amount, SHARE_DECIMALS);
  const quote = data && shares > 0n ? quoteShares(data.pool, shares, mode === "deposit") : null;
  const user = data?.user;

  let problem: string | null = null;
  if (!publicKey) problem = "Connect a wallet";
  else if (!quote) problem = "Enter an amount";
  else if (mode === "deposit" && user && (user.a < quote.a || user.b < quote.b)) problem = "Not enough test tokens";
  else if (mode === "redeem" && user && user.shares < shares) problem = "Not enough swINTC";

  function submit() {
    if (!publicKey || !quote) return;
    if (mode === "deposit") {
      const maxA = (quote.a * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      const maxB = (quote.b * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      send("Deposit", [...ensureAccountsIxs(publicKey), depositIx(publicKey, shares, maxA, maxB)]);
    } else {
      const minA = (quote.a * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const minB = (quote.b * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Redeem", [...ensureAccountsIxs(publicKey), redeemIx(publicKey, shares, minA, minB)]);
    }
  }

  return (
    <section className="card">
      <h2>The vault</h2>
      <div className="tabs" role="tablist">
        {(["deposit", "redeem"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "deposit" ? "Deposit" : "Redeem"}
          </button>
        ))}
      </div>
      <label className="field">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="swINTC amount" />
        <span className="mono">swINTC</span>
        {mode === "redeem" && user && (
          <button className="pill" style={{ cursor: "pointer", background: "none" }} onClick={() => setAmount(fromRaw(user.shares, SHARE_DECIMALS, 8).replace(/,/g, ""))}>
            max
          </button>
        )}
      </label>
      <div className="rows">
        <div className="row">
          {mode === "deposit" ? "You pay" : "You receive"}
          <b>
            {quote ? `${fromRaw(quote.a, VAULT.decimalsA)} mINTCx + ${fromRaw(quote.b, VAULT.decimalsB)} mINTC` : "—"}
          </b>
        </div>
        <div className="row">
          In shares of Intel
          <b>{quote ? stockValue(quote.a, quote.b).toFixed(6) : "—"}</b>
        </div>
      </div>
      <button className="btn" disabled={!!problem || status?.kind === "pending"} onClick={submit}>
        {problem ?? (mode === "deposit" ? "Deposit" : "Redeem")}
      </button>
      <p className="note">
        {mode === "deposit"
          ? "Both issuers' tokens go in at the pool's current mix. No price oracle: you add liquidity at the same ratio as everyone else."
          : "Always open. You take your share of both tokens straight from the Meteora pool."}
      </p>
      <Status status={status} />
    </section>
  );
}
