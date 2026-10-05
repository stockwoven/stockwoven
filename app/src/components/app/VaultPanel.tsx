"use client";

import { KeyboardEvent, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSend } from "@/lib/hooks";
import { SHARE_DECIMALS, VAULT, depositIx, ensureAccountsIxs, fromRaw, quoteShares, redeemIx, stockValue, toRaw } from "@/lib/stockwoven";
import { AmountField, isAmount } from "../AmountField";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { TxStatus } from "../TxStatus";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const SLIPPAGE_BPS = 50n;
const MODES = ["deposit", "redeem"] as const;

export function VaultPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const { send, status } = useSend(refresh);
  const [mode, setMode] = useState<(typeof MODES)[number]>("deposit");
  const [amount, setAmount] = useState("1");

  const shares = isAmount(amount) ? toRaw(amount, SHARE_DECIMALS) : 0n;
  const quote = data && shares > 0n ? quoteShares(data.pool, shares, mode === "deposit") : null;
  const user = data?.user;
  const pending = status?.kind === "pending";
  const deposit = mode === "deposit";

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (!quote) problem = data ? "Enter an amount" : "Loading the pool…";
  else if (deposit && user && (user.a < quote.a || user.b < quote.b)) problem = "Not enough test tokens";
  else if (!deposit && user && user.shares < shares) problem = "Not enough swINTC";

  function submit() {
    if (!publicKey || !quote) return;
    if (deposit) {
      const maxA = (quote.a * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      const maxB = (quote.b * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      send("Deposit", [...ensureAccountsIxs(publicKey), depositIx(publicKey, shares, maxA, maxB)]);
    } else {
      const minA = (quote.a * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const minB = (quote.b * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Redeem", [...ensureAccountsIxs(publicKey), redeemIx(publicKey, shares, minA, minB)]);
    }
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = deposit ? "redeem" : "deposit";
    setMode(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  return (
    <section className="tile panel" id="vault-panel" aria-label="Deposit or redeem swINTC">
      <div className="tabs tabs--block" role="tablist" aria-label="Vault action" onKeyDown={onTabKey}>
        {MODES.map((m) => (
          <button
            key={m}
            id={`tab-${m}`}
            type="button"
            role="tab"
            className="t-label"
            aria-selected={mode === m}
            aria-controls="vault-tabpanel"
            tabIndex={mode === m ? 0 : -1}
            onClick={() => setMode(m)}
          >
            {m === "deposit" ? "Deposit" : "Redeem"}
          </button>
        ))}
      </div>

      <div id="vault-tabpanel" role="tabpanel" aria-labelledby={`tab-${mode}`} className="panel__body">
        <AmountField
          label={
            <>
              <Ticker ticker="INTC" /> to {deposit ? "receive" : "redeem"}
            </>
          }
          value={amount}
          onChange={setAmount}
          suffix={<Ticker ticker="INTC" />}
          hint={
            user &&
            (deposit ? (
              `${fromRaw(user.a, VAULT.decimalsA)} mINTCx · ${fromRaw(user.b, VAULT.decimalsB)} mINTC`
            ) : (
              <>
                {fromRaw(user.shares, SHARE_DECIMALS, 6)} <Ticker ticker="INTC" />
              </>
            ))
          }
          action={
            !deposit &&
            user &&
            user.shares > 0n && (
              <button
                type="button"
                className="field__max t-label"
                onClick={() => setAmount(fromRaw(user.shares, SHARE_DECIMALS, 8).replace(/,/g, ""))}
              >
                Max
              </button>
            )
          }
        />

        <dl className="kv">
          <div>
            <dt className="t-body">{deposit ? "You pay" : "You receive"}</dt>
            <dd className="amounts">
              {quote ? (
                <>
                  <span className="t-data">{fromRaw(quote.a, VAULT.decimalsA)} mINTCx</span>
                  <span className="t-data">{fromRaw(quote.b, VAULT.decimalsB)} mINTC</span>
                </>
              ) : (
                <span className="t-data muted">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="t-body">Worth</dt>
            <dd className="t-data">{quote ? `${stockValue(quote.a, quote.b).toFixed(6)} INTC` : "—"}</dd>
          </div>
          <div>
            <dt className="t-body">Slippage limit</dt>
            <dd className="t-data">{Number(SLIPPAGE_BPS) / 100}%</dd>
          </div>
        </dl>

        {publicKey ? (
          <Button block disabled={!!problem || pending} aria-busy={pending} onClick={submit}>
            {pending ? "Waiting for confirmation…" : (problem ?? (deposit ? "Deposit" : "Redeem"))}
          </Button>
        ) : (
          <Button block onClick={picker.open}>
            Connect wallet to {deposit ? "deposit" : "redeem"}
          </Button>
        )}

        <p className="microcopy">
          <span className="t-body muted">{deposit ? "Both issuers' tokens go in at the pool's current mix." : "Always open."}</span>{" "}
          <LearnMore href={deposit ? "/docs/deposit#how-a-deposit-is-priced" : "/docs/redeem#how-a-redemption-works"} />
        </p>
        <TxStatus status={status} />
      </div>
    </section>
  );
}
