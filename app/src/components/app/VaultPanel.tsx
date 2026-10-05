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
import {
  ROUTE_SLIPPAGE_BPS,
  SOL_ROUTE,
  USDC_ROUTE,
  quoteRoutedDeposit,
  quoteSolDeposit,
  quoteUsdcDeposit,
  routedDepositIxs,
  solDepositIxs,
  usdcDepositIxs,
} from "@/lib/usdcRoute";
import { AmountField, isAmount } from "../AmountField";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { TxStatus } from "../TxStatus";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const SLIPPAGE_BPS = 50n;
const MODES = ["deposit", "redeem"] as const;

type Source = "both" | "a" | "b" | "usdc" | "sol";
const SOURCES: { key: Source; label: string; start: string }[] = [
  { key: "both", label: "Both", start: "1" },
  { key: "a", label: "mINTCx", start: "1" },
  { key: "b", label: "mINTC", start: "1" },
  ...(USDC_ROUTE ? [{ key: "usdc" as const, label: "USDC", start: "20" }] : []),
  ...(SOL_ROUTE ? [{ key: "sol" as const, label: "SOL", start: "0.1" }] : []),
];

/** SOL kept back for the network fee and the token accounts a deposit may open. */
const SOL_RESERVE = 10_000_000n;

/** How a one-token deposit reaches the vault: its own pool, or USDC pools. */
type Route = "vault" | "issuer-via-usdc" | "usdc" | "sol";
const ROUTE_LABEL: Record<Route, string> = {
  vault: "Vault's pool",
  "issuer-via-usdc": "USDC pools",
  usdc: "USDC pools → both tokens",
  sol: "SOL → USDC → both tokens",
};
const ROUTE_FEES: Record<Route, string> = {
  vault: `${(ZAP_FEE_BPS / 100).toFixed(2)}% + conversion fee`,
  "issuer-via-usdc": "2 conversions, no vault fee",
  usdc: "2 conversions, no vault fee",
  sol: "3 conversions, no vault fee",
};

export function VaultPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const { send, status } = useSend(refresh);
  const [mode, setMode] = useState<(typeof MODES)[number]>("deposit");
  const [source, setSource] = useState<Source>("both");
  const [amount, setAmount] = useState("1");

  const user = data?.user;
  const pending = status?.kind === "pending";
  const deposit = mode === "deposit";
  const oneToken = deposit && source !== "both";
  const inputIsA = source === "a";
  const input = {
    a: { symbol: "mINTCx", decimals: VAULT.decimalsA, balance: user?.a },
    b: { symbol: "mINTC", decimals: VAULT.decimalsB, balance: user?.b },
    usdc: { symbol: "USDC", decimals: 6, balance: user?.usdc },
    sol: { symbol: "SOL", decimals: 9, balance: user?.lamports },
    both: { symbol: "", decimals: SHARE_DECIMALS, balance: undefined },
  }[source];

  const raw = isAmount(amount) ? toRaw(amount, oneToken ? input.decimals : SHARE_DECIMALS) : 0n;
  const ready = !!data && raw > 0n && deposit;
  const quote = data && !oneToken && raw > 0n ? quoteShares(data.pool, data.shareSupply, raw, deposit) : null;

  // One issuer's token: the vault's own pool or the USDC pools, whichever mints more swINTC.
  const issuer = ready && (source === "a" || source === "b");
  const inPoolShares = issuer ? quoteDepositSingle(data.pool, data.shareSupply, inputIsA, raw) : null;
  const routed = issuer ? quoteRoutedDeposit(data.pool, data.shareSupply, inputIsA, raw) : null;
  const viaUsdc = !!routed && (inPoolShares === null || routed.shares >= inPoolShares);
  // USDC or SOL: always through the USDC pools.
  const usdcQuote = ready && source === "usdc" ? quoteUsdcDeposit(data.pool, data.shareSupply, raw) : null;
  const solQuote = ready && source === "sol" ? quoteSolDeposit(data.pool, data.shareSupply, raw) : null;

  const route: Route = source === "usdc" ? "usdc" : source === "sol" ? "sol" : viaUsdc ? "issuer-via-usdc" : "vault";
  const outShares =
    source === "usdc" ? (usdcQuote?.shares ?? null)
    : source === "sol" ? (solQuote?.usdc.shares ?? null)
    : viaUsdc ? routed.shares
    : inPoolShares;
  const otherSymbol = inputIsA ? "mINTC" : "mINTCx";

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (oneToken ? outShares === null : !quote) problem = data ? "Enter an amount" : "Loading the pool…";
  else if (oneToken && outShares === 0n) problem = "Amount too small";
  else if (source === "sol" && deposit && user && user.lamports < raw) problem = "Not enough SOL";
  else if (source === "sol" && deposit && user && user.lamports < raw + SOL_RESERVE) problem = "Keep 0.01 SOL for fees";
  else if (oneToken && input.balance !== undefined && input.balance < raw) problem = `Not enough ${input.symbol}`;
  else if (!oneToken && deposit && user && quote && (user.a < quote.a || user.b < quote.b)) problem = "Not enough test tokens";
  else if (!deposit && user && user.shares < raw) problem = "Not enough swINTC";

  function submit() {
    if (!publicKey) return;
    const accounts = ensureAccountsIxs(publicKey);
    if (source === "usdc" && deposit && usdcQuote && USDC_ROUTE) {
      send("Deposit", [...accounts, ...usdcDepositIxs(publicKey, usdcQuote)], USDC_ROUTE.lookupTable);
    } else if (source === "sol" && deposit && solQuote && USDC_ROUTE) {
      send("Deposit", [...accounts, ...solDepositIxs(publicKey, solQuote)], USDC_ROUTE.lookupTable);
    } else if (issuer && viaUsdc && USDC_ROUTE) {
      send("Deposit", [...accounts, ...routedDepositIxs(publicKey, routed)], USDC_ROUTE.lookupTable);
    } else if (issuer) {
      if (!inPoolShares) return;
      const minShares = (inPoolShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Deposit", [...accounts, depositSingleIx(publicKey, inputIsA, raw, minShares)]);
    } else if (!quote) {
      return;
    } else if (deposit) {
      const maxA = (quote.a * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      const maxB = (quote.b * (10_000n + SLIPPAGE_BPS)) / 10_000n + 1n;
      send("Deposit", [...accounts, depositIx(publicKey, raw, maxA, maxB)]);
    } else {
      const minA = (quote.a * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const minB = (quote.b * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      send("Redeem", [...accounts, redeemIx(publicKey, raw, minA, minB)]);
    }
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = deposit ? "redeem" : "deposit";
    setMode(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  function pickSource(next: Source) {
    setSource(next);
    setAmount(SOURCES.find((s) => s.key === next)?.start ?? "1");
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
  // For SOL, Max leaves the fee reserve in the wallet.
  const spendable = source === "sol" && input.balance !== undefined ? input.balance - SOL_RESERVE : input.balance;

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
            <div className="tabs tabs--sources" role="group" aria-labelledby="pay-with">
              {SOURCES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="t-label"
                  aria-pressed={source === s.key}
                  onClick={() => pickSource(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {oneToken ? (
          <AmountField
            label={`${input.symbol} to deposit`}
            value={amount}
            onChange={setAmount}
            suffix={input.symbol}
            hint={input.balance !== undefined && `Balance: ${fromRaw(input.balance, input.decimals)} ${input.symbol}`}
            action={spendable !== undefined && spendable > 0n && maxButton(spendable, input.decimals)}
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

        {oneToken ? (
          <dl className="kv">
            <div>
              <dt className="t-body">{route === "vault" ? "You receive about" : "You receive"}</dt>
              <dd className="t-data">
                {outShares ? (
                  <>
                    {fromRaw(outShares, SHARE_DECIMALS, 6)} <Ticker ticker="INTC" />
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="t-body">Worth</dt>
              <dd className="t-data">
                {outShares && data
                  ? `${((Number(outShares) / 10 ** SHARE_DECIMALS) * navPerShare(data.pool, data.shareSupply)).toFixed(6)} INTC`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="t-body">Route</dt>
              <dd className="t-data">
                {route === "issuer-via-usdc" ? `${ROUTE_LABEL[route]} → ${otherSymbol}` : ROUTE_LABEL[route]}
              </dd>
            </div>
            <div>
              <dt className="t-body">Fees</dt>
              <dd className="t-data">{ROUTE_FEES[route]}</dd>
            </div>
            <div>
              <dt className="t-body">Slippage limit</dt>
              <dd className="t-data">
                {route === "vault" ? `${Number(SLIPPAGE_BPS) / 100}%` : `${Number(ROUTE_SLIPPAGE_BPS) / 100}% per conversion`}
              </dd>
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
              : route === "usdc" && oneToken
                ? "USDC buys both issuers' tokens at the pool's mix, then both go in."
                : route === "sol" && oneToken
                  ? "SOL becomes USDC, which buys both issuers' tokens for the deposit."
                  : route === "issuer-via-usdc" && oneToken
                    ? `Part of it buys ${otherSymbol} through USDC, then both go in at the pool's mix.`
                    : oneToken
                      ? "The vault converts part of it on the pool, then deposits both."
                      : "Both issuers' tokens go in at the pool's current mix."}
          </span>{" "}
          <LearnMore
            href={
              !deposit
                ? "/docs/redeem#how-a-redemption-works"
                : source === "usdc" || source === "sol"
                  ? "/docs/deposit#deposit-with-usdc-or-sol"
                  : oneToken
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
