"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useFaucet, useSend } from "@/lib/hooks";
import { TRADE_FEE_BPS, VAULT, ensureAccountsIxs, fromRaw, harvestIx, quoteSwap, swapIx, toRaw } from "@/lib/stockwoven";
import { AmountField, isAmount } from "../AmountField";
import { Button } from "../ds";
import { LearnMore } from "../LearnMore";
import { TxStatus } from "../TxStatus";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const SLIPPAGE_BPS = 100n;

function ConnectOr({ children, label }: { children: React.ReactNode; label: string }) {
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  if (publicKey) return <>{children}</>;
  return (
    <Button variant="secondary" block onClick={picker.open}>
      {label}
    </Button>
  );
}

export function ConvertPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const [aToB, setAToB] = useState(true);
  const [amount, setAmount] = useState("1");

  const [from, to] = aToB ? ["mINTCx", "mINTC"] : ["mINTC", "mINTCx"];
  const [inDecimals, outDecimals] = aToB ? [VAULT.decimalsA, VAULT.decimalsB] : [VAULT.decimalsB, VAULT.decimalsA];
  const amountIn = isAmount(amount) ? toRaw(amount, inDecimals) : 0n;
  const out = data && amountIn > 0n ? quoteSwap(data.pool, aToB, amountIn) : null;
  const balance = data?.user ? (aToB ? data.user.a : data.user.b) : undefined;
  const pending = status?.kind === "pending";

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (!out) problem = data ? "Enter an amount" : "Loading the pool…";
  else if (balance !== undefined && balance < amountIn) problem = `Not enough ${from}`;

  function submit() {
    if (!publicKey || !out) return;
    const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    send("Conversion", [...ensureAccountsIxs(publicKey), swapIx(publicKey, aToB, amountIn, minOut)]);
  }

  return (
    <section className="tile panel" aria-label="Convert between issuers">
      <div className="switch">
        <span className="t-data">{from}</span>
        <span className="t-data muted">to</span>
        <span className="t-data">{to}</span>
        <Button variant="ghost" onClick={() => setAToB(!aToB)}>
          Switch direction
        </Button>
      </div>
      <AmountField
        label={`${from} to convert`}
        value={amount}
        onChange={setAmount}
        suffix={from}
        hint={balance !== undefined && `Balance: ${fromRaw(balance, inDecimals)} ${from}`}
      />
      <dl className="kv">
        <div>
          <dt className="t-body">You receive</dt>
          <dd className="t-data">{out !== null ? `${fromRaw(out, outDecimals, 6)} ${to}` : "—"}</dd>
        </div>
        <div>
          <dt className="t-body">Fee</dt>
          <dd className="t-data">{(TRADE_FEE_BPS / 100).toFixed(2)}%</dd>
        </div>
        <div>
          <dt className="t-body">Slippage limit</dt>
          <dd className="t-data">{Number(SLIPPAGE_BPS) / 100}%</dd>
        </div>
      </dl>
      <ConnectOr label="Connect wallet to convert">
        <Button block disabled={!!problem || pending} aria-busy={pending} onClick={submit}>
          {pending ? "Waiting for confirmation…" : (problem ?? `Convert to ${to}`)}
        </Button>
      </ConnectOr>
      <p className="microcopy">
        <span className="t-body muted">Direct swap on the Meteora pool.</span> <LearnMore href="/docs/fees#conversions" />
      </p>
      <TxStatus status={status} />
    </section>
  );
}

export function FaucetPanel() {
  const { refresh } = useVault();
  const { drip, status } = useFaucet(refresh);
  const pending = status?.kind === "pending";
  return (
    <section className="tile">
      <h2 className="t-heading-sm">Get test tokens.</h2>
      <p className="t-body muted">
        <span className="t-data">10 mINTCx</span>, <span className="t-data">10 mINTC</span>, <span className="t-data">100 USDC</span> and devnet SOL. Once a minute.
      </p>
      <div style={{ marginTop: "auto" }} className="field">
        <ConnectOr label="Connect wallet">
          <Button variant="secondary" block disabled={pending} aria-busy={pending} onClick={drip}>
            {pending ? "Sending…" : "Get test tokens"}
          </Button>
        </ConnectOr>
        <TxStatus status={status} />
      </div>
    </section>
  );
}

export function HarvestPanel() {
  const { refresh } = useVault();
  const { send, status } = useSend(refresh);
  const pending = status?.kind === "pending";
  return (
    <section className="tile">
      <h2 className="t-heading-sm">Harvest the protocol fee.</h2>
      <p className="microcopy">
        <span className="t-body muted">Sends the protocol&apos;s cut to the treasury.</span> <LearnMore href="/docs/fees#harvest" />
      </p>
      <div style={{ marginTop: "auto" }} className="field">
        <ConnectOr label="Connect wallet">
          <Button variant="ghost" block disabled={pending} aria-busy={pending} onClick={() => send("Harvest", [harvestIx()])}>
            {pending ? "Waiting for confirmation…" : "Harvest protocol fee"}
          </Button>
        </ConnectOr>
        <TxStatus status={status} />
      </div>
    </section>
  );
}
