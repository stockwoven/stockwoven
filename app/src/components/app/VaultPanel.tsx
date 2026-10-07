"use client";

import { KeyboardEvent, useState } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSend } from "@/lib/hooks";
import {
  ASSETS,
  ROUTE_SLIPPAGE_BPS,
  SHARE_DECIMALS,
  SOL,
  Swap,
  USDC,
  VAULT,
  depositIx,
  ensureAccountsIxs,
  fromRaw,
  poolSwapIx,
  prices,
  quoteShares,
  quoteZapIn,
  quoteZapOut,
  redeemIx,
  toRaw,
  unwrapSolIx,
  usd,
  usdOf,
  vaultValue,
  wrapSolIxs,
} from "@/lib/stockwoven";
import { AmountField, isAmount } from "../AmountField";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { TxStatus } from "../TxStatus";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const SLIPPAGE_BPS = 50n;
const MODES = ["deposit", "redeem"] as const;
const TICKER = VAULT.stock;

/** "mix" pays the vault's current mix of every asset; a number pays with that one asset. */
type Source = "mix" | number;
const SOURCES: { key: Source; label: string; start: string }[] = [
  { key: "mix", label: "Vault mix", start: "0.1" },
  ...ASSETS.map((a, k) => ({ key: k as Source, label: a.symbol, start: a.kind === "usdc" ? "50" : a.kind === "sol" ? "0.01" : "0.2" })),
];
type Payout = "kind" | "usdc";

/** SOL kept back for network fees and the token accounts a transaction may open (~0.002 SOL each). */
const SOL_RESERVE = 15_000_000n;

const plus = (x: bigint, bps: bigint) => (x * (10_000n + bps)) / 10_000n + 1n;
const minus = (x: bigint, bps: bigint) => (x * (10_000n - bps)) / 10_000n;
const swapIxs = (user: PublicKey, swaps: Swap[]) => swaps.map((s) => poolSwapIx(s.pool, user, s.aToB, s.amountIn, s.minOut));

export function VaultPanel() {
  const { data, refresh } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const { send, status } = useSend(refresh);
  const [mode, setMode] = useState<(typeof MODES)[number]>("deposit");
  const [source, setSource] = useState<Source>("mix");
  const [payout, setPayout] = useState<Payout>("kind");
  const [amount, setAmount] = useState("0.1");

  const state = data?.state;
  const user = data?.user;
  const pending = status?.kind === "pending";
  const deposit = mode === "deposit";
  const oneToken = deposit && source !== "mix";
  const input = oneToken ? ASSETS[source as number] : null;
  const decimals = input ? input.decimals : SHARE_DECIMALS;
  const raw = isAmount(amount) ? toRaw(amount, decimals) : 0n;
  const px = state ? prices(state) : null;
  const perShare = state ? vaultValue(state).perShare : 0;

  // Deposit with the mix, or redeem in kind: the program's own pro-rata amounts.
  const mixQuote = state && raw > 0n && !oneToken && (deposit || payout === "kind") ? quoteShares(state, raw, deposit) : null;
  const zapIn = state && oneToken && raw > 0n ? quoteZapIn(state, source as number, raw) : null;
  const zapOut = state && !deposit && payout === "usdc" && raw > 0n ? quoteZapOut(state, raw, USDC) : null;

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (!state) problem = "Loading the vault…";
  else if (raw === 0n) problem = "Enter an amount";
  else if (deposit && state.depositsPaused) problem = "Deposits are paused";
  else if (oneToken && !zapIn) problem = "Amount too small";
  else if (!deposit && payout === "usdc" && !zapOut) problem = "Amount too small";
  else if (user && oneToken && source === SOL && user.balances[SOL] < raw + SOL_RESERVE) problem = "Keep 0.015 SOL for fees";
  else if (user && oneToken && user.balances[source as number] < raw) problem = `Not enough ${input!.symbol}`;
  else if (user && !oneToken && deposit && mixQuote?.some((x, k) => user.balances[k] < x)) {
    const k = mixQuote.findIndex((x, i) => user.balances[i] < x);
    problem = `Not enough ${ASSETS[k].symbol}`;
  } else if (user && !deposit && user.shares < raw) problem = `Not enough sw${TICKER}`;

  function submit() {
    if (!publicKey || !state) return;
    const ixs: TransactionInstruction[] = ensureAccountsIxs(publicKey, user?.exists);
    if (deposit && oneToken && zapIn) {
      if (source === SOL) ixs.push(...wrapSolIxs(publicKey, raw));
      ixs.push(...swapIxs(publicKey, zapIn.swaps), depositIx(publicKey, zapIn.shares, zapIn.maxAmounts));
    } else if (deposit && mixQuote) {
      const max = mixQuote.map((x) => plus(x, SLIPPAGE_BPS));
      // The SOL slice is paid from wSOL: wrap what the wallet does not hold as wSOL yet.
      const wrap = max[SOL] - (user?.wsol ?? 0n);
      if (SOL >= 0 && wrap > 0n) ixs.push(...wrapSolIxs(publicKey, wrap));
      ixs.push(depositIx(publicKey, raw, max));
    } else if (!deposit && payout === "usdc" && zapOut) {
      ixs.push(redeemIx(publicKey, raw, zapOut.amounts), ...swapIxs(publicKey, zapOut.swaps));
    } else if (!deposit && mixQuote) {
      ixs.push(redeemIx(publicKey, raw, mixQuote.map((x) => minus(x, SLIPPAGE_BPS))));
    } else {
      return;
    }
    // Whatever wSOL is left (refunds, the SOL slice of a redemption) goes back to the wallet as SOL.
    if (SOL >= 0) ixs.push(unwrapSolIx(publicKey));
    send(deposit ? "Deposit" : "Redemption", ixs, VAULT.lookupTable ?? undefined);
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = deposit ? "redeem" : "deposit";
    setMode(next);
    setAmount("0.1");
    document.getElementById(`tab-${next}`)?.focus();
  }

  function pickSource(next: Source) {
    setSource(next);
    setAmount(SOURCES.find((s) => s.key === next)?.start ?? "1");
  }

  const maxButton = (value: bigint, d: number) => (
    <button type="button" className="field__max t-label" onClick={() => setAmount(fromRaw(value, d, d).replace(/,/g, ""))}>
      Max
    </button>
  );
  const balance = oneToken && user ? user.balances[source as number] - (source === SOL ? SOL_RESERVE : 0n) : undefined;

  const amountsList = (amounts: bigint[]) => (
    <dd className="amounts">
      {amounts.map((x, k) =>
        x > 0n ? (
          <span key={k} className="t-data">
            {fromRaw(x, ASSETS[k].decimals, ASSETS[k].kind === "usdc" ? 2 : 6)} {ASSETS[k].symbol}
          </span>
        ) : null,
      )}
    </dd>
  );

  const shareFigure = (shares: bigint | null | undefined) =>
    shares ? (
      <>
        {fromRaw(shares, SHARE_DECIMALS, 6)} <Ticker ticker={TICKER} />
      </>
    ) : (
      "—"
    );

  return (
    <section className="tile panel" id="vault-panel" aria-label={`Deposit or redeem sw${TICKER}`}>
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
            onClick={() => {
              setMode(m);
              setAmount(m === "deposit" ? (SOURCES.find((s) => s.key === source)?.start ?? "0.1") : "0.1");
            }}
          >
            {m === "deposit" ? "Deposit" : "Redeem"}
          </button>
        ))}
      </div>

      <div id="vault-tabpanel" role="tabpanel" aria-labelledby={`tab-${mode}`} className="panel__body">
        <div className="field">
          <span className="t-label" id="choice">
            {deposit ? "Pay with" : "Receive"}
          </span>
          <div className="tabs tabs--sources" role="group" aria-labelledby="choice">
            {deposit
              ? SOURCES.map((s) => (
                  <button key={String(s.key)} type="button" className="t-label" aria-pressed={source === s.key} onClick={() => pickSource(s.key)}>
                    {s.label}
                  </button>
                ))
              : (["kind", "usdc"] as const).map((p) => (
                  <button key={p} type="button" className="t-label" aria-pressed={payout === p} onClick={() => setPayout(p)}>
                    {p === "kind" ? "In kind" : "USDC"}
                  </button>
                ))}
          </div>
        </div>

        {oneToken ? (
          <AmountField
            label={`${input!.symbol} to deposit`}
            value={amount}
            onChange={setAmount}
            suffix={input!.symbol}
            hint={user && `Balance: ${fromRaw(user.balances[source as number], input!.decimals)} ${input!.symbol}`}
            action={balance !== undefined && balance > 0n && maxButton(balance, input!.decimals)}
          />
        ) : (
          <AmountField
            label={
              <>
                <Ticker ticker={TICKER} /> to {deposit ? "receive" : "redeem"}
              </>
            }
            value={amount}
            onChange={setAmount}
            suffix={<Ticker ticker={TICKER} />}
            hint={
              user &&
              (deposit ? (
                `Paid in all ${ASSETS.length} tokens at the vault's mix`
              ) : (
                <>
                  {fromRaw(user.shares, SHARE_DECIMALS, 6)} <Ticker ticker={TICKER} />
                </>
              ))
            }
            action={!deposit && user && user.shares > 0n && maxButton(user.shares, SHARE_DECIMALS)}
          />
        )}

        <dl className="kv">
          {oneToken ? (
            <>
              <div>
                <dt className="t-body">You receive about</dt>
                <dd className="t-data">{shareFigure(zapIn?.shares)}</dd>
              </div>
              <div>
                <dt className="t-body">Worth</dt>
                <dd className="t-data">{zapIn ? `${usd(zapIn.usdOut)} for ${usd(zapIn.usdIn)} in` : "—"}</dd>
              </div>
              <div>
                <dt className="t-body">Route</dt>
                <dd className="t-data">{zapIn ? `${zapIn.swaps.length} swaps into the vault's mix, then one deposit` : "—"}</dd>
              </div>
            </>
          ) : !deposit && payout === "usdc" ? (
            <>
              <div>
                <dt className="t-body">You receive at least</dt>
                <dd className="t-data">{zapOut ? `${fromRaw(zapOut.out, ASSETS[USDC].decimals, 2)} USDC` : "—"}</dd>
              </div>
              <div>
                <dt className="t-body">Route</dt>
                <dd className="t-data">{zapOut ? `Redeem in kind, then ${zapOut.swaps.length} swaps to USDC` : "—"}</dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt className="t-body">{deposit ? "You pay" : "You receive"}</dt>
                {mixQuote ? amountsList(mixQuote) : <dd className="t-data muted">—</dd>}
              </div>
              <div>
                <dt className="t-body">Worth</dt>
                <dd className="t-data">{mixQuote && px ? usd(usdOf(mixQuote, px)) : "—"}</dd>
              </div>
            </>
          )}
          <div>
            <dt className="t-body">
              1 <Ticker ticker={TICKER} />
            </dt>
            <dd className="t-data">{state ? usd(perShare) : "—"}</dd>
          </div>
          <div>
            <dt className="t-body">Slippage limit</dt>
            <dd className="t-data">
              {oneToken || (!deposit && payout === "usdc") ? `${Number(ROUTE_SLIPPAGE_BPS) / 100}% per swap` : `${Number(SLIPPAGE_BPS) / 100}%`}
            </dd>
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
          <span className="t-body muted">
            {!deposit
              ? payout === "usdc"
                ? "Your slice of every pool and reserve comes out, then each token is swapped to USDC. Always open."
                : "Your slice of every pool and reserve, in kind. Always open."
              : oneToken
                ? `${input!.symbol} is swapped into each token the vault holds, in the vault's proportions, then deposited.`
                : "Every token goes in at the vault's current mix across its pools and reserves."}
          </span>{" "}
          <LearnMore
            href={
              !deposit
                ? payout === "usdc"
                  ? "/docs/redeem#receive-usdc"
                  : "/docs/redeem#how-a-redemption-works"
                : oneToken
                  ? "/docs/deposit#deposit-with-one-token"
                  : "/docs/deposit#how-a-deposit-is-priced"
            }
          />
        </p>
        <TxStatus status={status} />
      </div>
    </section>
  );
}
