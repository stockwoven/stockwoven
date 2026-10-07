"use client";

import { useState } from "react";
import { TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useFaucet, useSend } from "@/lib/hooks";
import {
  ALL_POOLS,
  ASSETS,
  POOLS,
  SOL,
  VAULT,
  bestRoute,
  ensureAccountsIxs,
  fromRaw,
  harvestIx,
  treasuryAccountIxs,
  poolSwapIx,
  quoteSwap,
  toRaw,
  unwrapSolIx,
  wrapSolIxs,
} from "@/lib/stockwoven";
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

function TokenPicker({ label, value, onChange, exclude }: { label: string; value: number; onChange: (k: number) => void; exclude: number }) {
  return (
    <div className="field">
      <span className="t-label" id={`pick-${label}`}>
        {label}
      </span>
      <div className="tabs tabs--sources" role="group" aria-labelledby={`pick-${label}`}>
        {ASSETS.map((a, k) => (
          <button key={a.symbol} type="button" className="t-label" aria-pressed={value === k} disabled={k === exclude} onClick={() => onChange(k)}>
            {a.symbol}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Swaps any vault token for any other along the best route of one or two pools. */
export function SwapPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(0);
  const [amount, setAmount] = useState("1");

  const state = data?.state;
  const user = data?.user;
  const amountIn = isAmount(amount) ? toRaw(amount, ASSETS[from].decimals) : 0n;
  const route = state && amountIn > 0n && from !== to ? bestRoute([...state.pools, ...state.market], from, to, amountIn) : null;
  const balance = user?.balances[from];
  const pending = status?.kind === "pending";

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (!state) problem = "Loading the pools…";
  else if (from === to) problem = "Pick two different tokens";
  else if (!route) problem = amountIn > 0n ? "No route for this pair" : "Enter an amount";
  else if (balance !== undefined && balance < amountIn) problem = `Not enough ${ASSETS[from].symbol}`;

  function submit() {
    if (!publicKey || !route || !state) return;
    const ixs: TransactionInstruction[] = ensureAccountsIxs(publicKey, user?.exists);
    if (from === SOL) ixs.push(...wrapSolIxs(publicKey, amountIn));
    // Each hop swaps exactly the previous hop's minimum; anything filled above it stays in the wallet.
    let x = amountIn;
    const states = [...state.pools, ...state.market];
    route.hops.forEach((h, i) => {
      const out = quoteSwap(states[h.index], h.pool.feeBps, h.aToB, x);
      const min = (out * (10_000n - (i === route.hops.length - 1 ? SLIPPAGE_BPS : SLIPPAGE_BPS / 2n))) / 10_000n;
      ixs.push(poolSwapIx(h.pool, publicKey, h.aToB, x, min));
      x = min;
    });
    if (from === SOL || to === SOL) ixs.push(unwrapSolIx(publicKey));
    send("Swap", ixs, VAULT.lookupTable ?? undefined);
  }

  const path = route ? [ASSETS[from].symbol, ...route.hops.map((h) => ASSETS[h.aToB ? h.pool.b : h.pool.a].symbol)].join(" → ") : "—";

  return (
    <section className="tile panel" aria-label="Swap between tokens">
      <div className="panel__body">
        <TokenPicker label="From" value={from} onChange={(k) => { setFrom(k); if (k === to) setTo(from); }} exclude={-1} />
        <TokenPicker label="To" value={to} onChange={setTo} exclude={from} />
        <AmountField
          label={`${ASSETS[from].issuer ? `${ASSETS[from].issuer} ` : ""}${ASSETS[from].symbol} to swap`}
          value={amount}
          onChange={setAmount}
          suffix={ASSETS[from].symbol}
          hint={balance !== undefined && `Balance: ${fromRaw(balance, ASSETS[from].decimals)} ${ASSETS[from].symbol}`}
        />
        <dl className="kv">
          <div>
            <dt className="t-body">You receive about</dt>
            <dd className="t-data">{route ? `${fromRaw(route.out, ASSETS[to].decimals, 6)} ${ASSETS[to].symbol}` : "—"}</dd>
          </div>
          <div>
            <dt className="t-body">Route</dt>
            <dd className="t-data">{path}</dd>
          </div>
          <div>
            <dt className="t-body">Pools</dt>
            <dd className="t-data">{route ? route.hops.map((h) => h.pool.label).join(" · ") : "—"}</dd>
          </div>
          <div>
            <dt className="t-body">Slippage limit</dt>
            <dd className="t-data">{Number(SLIPPAGE_BPS) / 100}%</dd>
          </div>
        </dl>
        <ConnectOr label="Connect wallet to swap">
          <Button block disabled={!!problem || pending} aria-busy={pending} onClick={submit}>
            {pending ? "Waiting for confirmation…" : (problem ?? `Swap to ${ASSETS[to].symbol}`)}
          </Button>
        </ConnectOr>
        <p className="microcopy">
          <span className="t-body muted">
            Swaps go straight to Meteora pools. Fees paid in the vault&apos;s {ALL_POOLS.filter((p) => p.vault).length} own pools are part of sw{VAULT.stock} holders&apos; yield.
          </span>{" "}
          <LearnMore href="/docs/fees#swaps" />
        </p>
        <TxStatus status={status} />
      </div>
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
        <span className="t-data">10 SPCXx</span>, <span className="t-data">10 SPCX</span>, <span className="t-data">10 SPCXon</span>,{" "}
        <span className="t-data">2,000 USDC</span> and devnet SOL. Once a minute.
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
  const { publicKey } = useWallet();
  const { send, status } = useSend(refresh);
  const pending = status?.kind === "pending";
  return (
    <section className="tile">
      <h2 className="t-heading-sm">Harvest the protocol fee.</h2>
      <p className="microcopy">
        <span className="t-body muted">Sends the protocol&apos;s cut of every vault pool&apos;s fees to the treasury.</span>{" "}
        <LearnMore href="/docs/fees#harvest" />
      </p>
      <div style={{ marginTop: "auto" }} className="field">
        <ConnectOr label="Connect wallet">
          <Button
            variant="ghost"
            block
            disabled={pending}
            aria-busy={pending}
            onClick={() => publicKey && send("Harvest", [...treasuryAccountIxs(publicKey), ...POOLS.map((_, i) => harvestIx(publicKey, i))], VAULT.lookupTable ?? undefined)}
          >
            {pending ? "Waiting for confirmation…" : "Harvest protocol fee"}
          </Button>
        </ConnectOr>
        <TxStatus status={status} />
      </div>
    </section>
  );
}
