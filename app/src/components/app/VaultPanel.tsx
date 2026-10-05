"use client";

import { KeyboardEvent, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSend } from "@/lib/hooks";
import {
  SHARE_DECIMALS,
  VAULT,
  ZAP_FEE_BPS,
  depositIx,
  depositSingleIx,
  ensureAccountsIxs,
  fromRaw,
  navPerShare,
  quoteDepositSingle,
  quoteShares,
  redeemIx,
  stockValue,
  toRaw,
} from "@/lib/stockwoven";
import { ROUTE_SLIPPAGE_BPS, USDC_ROUTE, quoteRoutedDeposit, routedDepositIxs } from "@/lib/usdcRoute";
import { AmountField, isAmount } from "../AmountField";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { TxStatus } from "../TxStatus";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const SLIPPAGE_BPS = 50n;
const MODES = ["deposit", "redeem"] as const;
const SOURCES = [
  { key: "both", label: "Both" },
  { key: "a", label: "mINTCx" },
  { key: "b", label: "mINTC" },
] as const;

export function VaultPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const { send, status } = useSend(refresh);
  const [mode, setMode] = useState<(typeof MODES)[number]>("deposit");
  const [source, setSource] = useState<(typeof SOURCES)[number]["key"]>("both");
  const [amount, setAmount] = useState("1");

  const user = data?.user;
  const pending = status?.kind === "pending";
  const deposit = mode === "deposit";
  const single = deposit && source !== "both";
  const inputIsA = source === "a";
  const [inSymbol, inDecimals, inBalance] = inputIsA
    ? ["mINTCx", VAULT.decimalsA, user?.a]
    : ["mINTC", VAULT.decimalsB, user?.b];

  const raw = isAmount(amount) ? toRaw(amount, single ? inDecimals : SHARE_DECIMALS) : 0n;
  const quote = data && !single && raw > 0n ? quoteShares(data.pool, data.shareSupply, raw, deposit) : null;
  const inPoolShares = data && single && raw > 0n ? quoteDepositSingle(data.pool, data.shareSupply, inputIsA, raw) : null;
  const routed = data && single && raw > 0n ? quoteRoutedDeposit(data.pool, data.shareSupply, inputIsA, raw) : null;
  // Whichever route mints more swINTC. Through the USDC pools, the vault's pool grows in both tokens.
  const viaUsdc = !!routed && (inPoolShares === null || routed.shares >= inPoolShares);
  const singleShares = viaUsdc ? routed.shares : inPoolShares;
  const otherSymbol = inputIsA ? "mINTC" : "mINTCx";

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (single ? singleShares === null : !quote) problem = data ? "Enter an amount" : "Loading the pool…";
  else if (single && singleShares === 0n) problem = "Amount too small";
  else if (single && inBalance !== undefined && inBalance < raw) problem = `Not enough ${inSymbol}`;
  else if (!single && deposit && user && quote && (user.a < quote.a || user.b < quote.b)) problem = "Not enough test tokens";
  else if (!deposit && user && user.shares < raw) problem = "Not enough swINTC";

  function submit() {
    if (!publicKey) return;
    if (single && viaUsdc && USDC_ROUTE) {
      send("Deposit", [...ensureAccountsIxs(publicKey), ...routedDepositIxs(publicKey, routed)], USDC_ROUTE.lookupTable);
    } else if (single) {
      if (!singleShares) return;
      const minShares = (singleShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Deposit", [...ensureAccountsIxs(publicKey), depositSingleIx(publicKey, inputIsA, raw, minShares)]);
    } else if (!quote) {
      return;
    } else if (deposit) {
      const maxA = (quote.a * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      const maxB = (quote.b * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      send("Deposit", [...ensureAccountsIxs(publicKey), depositIx(publicKey, raw, maxA, maxB)]);
    } else {
      const minA = (quote.a * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const minB = (quote.b * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Redeem", [...ensureAccountsIxs(publicKey), redeemIx(publicKey, raw, minA, minB)]);
    }
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = deposit ? "redeem" : "deposit";
    setMode(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  const maxButton = (value: bigint, decimals: number) => (
    <button
      type="button"
      className="field__max t-label"
      onClick={() => setAmount(fromRaw(value, decimals, decimals).replace(/,/g, ""))}
    >
      Max
    </button>
  );

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
        {deposit && (
          <div className="field">
            <span className="t-label" id="pay-with">
              Pay with
            </span>
            <div className="tabs tabs--three" role="group" aria-labelledby="pay-with">
              {SOURCES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="t-label"
                  aria-pressed={source === s.key}
                  onClick={() => setSource(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {single ? (
          <AmountField
            label={`${inSymbol} to deposit`}
            value={amount}
            onChange={setAmount}
            suffix={inSymbol}
            hint={inBalance !== undefined && `Balance: ${fromRaw(inBalance, inDecimals)} ${inSymbol}`}
            action={inBalance !== undefined && inBalance > 0n && maxButton(inBalance, inDecimals)}
          />
        ) : (
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
            action={!deposit && user && user.shares > 0n && maxButton(user.shares, SHARE_DECIMALS)}
          />
        )}

        {single ? (
          <dl className="kv">
            <div>
              <dt className="t-body">{viaUsdc ? "You receive" : "You receive about"}</dt>
              <dd className="t-data">
                {singleShares ? (
                  <>
                    {fromRaw(singleShares, SHARE_DECIMALS, 6)} <Ticker ticker="INTC" />
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="t-body">Worth</dt>
              <dd className="t-data">
                {singleShares && data
                  ? `${((Number(singleShares) / 10 ** SHARE_DECIMALS) * navPerShare(data.pool, data.shareSupply)).toFixed(6)} INTC`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="t-body">Route</dt>
              <dd className="t-data">{viaUsdc ? `USDC pools → ${otherSymbol}` : "Vault's pool"}</dd>
            </div>
            <div>
              <dt className="t-body">Fees</dt>
              <dd className="t-data">
                {viaUsdc ? "2 conversions, no vault fee" : `${(ZAP_FEE_BPS / 100).toFixed(2)}% + conversion fee`}
              </dd>
            </div>
            <div>
              <dt className="t-body">Slippage limit</dt>
              <dd className="t-data">{Number(viaUsdc ? ROUTE_SLIPPAGE_BPS : SLIPPAGE_BPS) / 100}%</dd>
            </div>
          </dl>
        ) : (
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
        )}

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
          <span className="t-body muted">
            {!deposit
              ? "Always open."
              : single && viaUsdc
                ? `Part of it buys ${otherSymbol} through USDC, then both go in at the pool's mix.`
                : single
                ? "The vault converts part of it on the pool, then deposits both."
                : "Both issuers' tokens go in at the pool's current mix."}
          </span>{" "}
          <LearnMore
            href={
              !deposit
                ? "/docs/redeem#how-a-redemption-works"
                : single
                  ? "/docs/deposit#single-token-deposits"
                  : "/docs/deposit#how-a-deposit-is-priced"
            }
          />
        </p>
        <TxStatus status={status} />
      </div>
    </section>
  );
}
