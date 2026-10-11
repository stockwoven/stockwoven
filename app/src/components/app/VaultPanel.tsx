"use client";

import { CSSProperties, KeyboardEvent, useState } from "react";
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
  depositSingleIx,
  ensureAccountsIxs,
  explainRefusal,
  feeText,
  fromRaw,
  poolSwapIx,
  prices,
  quoteRedeemTo,
  quoteShares,
  quoteSingleDeposit,
  quoteSingleRedeem,
  quoteZapIn,
  quoteZapOut,
  redeemIx,
  redeemSingleIx,
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
/** "kind" pays a slice of every asset (the default); a number pays that one asset: USDC or an issuer token. */
type Payout = "kind" | number;
const PAYOUTS: { key: Payout; label: string }[] = [
  { key: "kind", label: "In kind" },
  ...ASSETS.flatMap((a, k) => (a.kind === "usdc" || a.kind === "stock" ? [{ key: k as Payout, label: a.symbol }] : [])),
];

/** SOL kept back for network fees and the token accounts a transaction may open (~0.002 SOL each). */
const SOL_RESERVE = 15_000_000n;

const plus = (x: bigint, bps: bigint) => (x * (10_000n + bps)) / 10_000n + 1n;
const minus = (x: bigint, bps: bigint) => (x * (10_000n - bps)) / 10_000n;
const swapIxs = (user: PublicKey, swaps: Swap[]) => swaps.map((s) => poolSwapIx(s.pool, user, s.aToB, s.amountIn, s.minOut));
const percent = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

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
  const output = !deposit && payout !== "kind" ? (payout as number) : null;
  const decimals = input ? input.decimals : SHARE_DECIMALS;
  const raw = isAmount(amount) ? toRaw(amount, decimals) : 0n;
  const px = state ? prices(state) : null;
  const perShare = state ? vaultValue(state).perShare : 0;
  const hasBasket = !!state?.basket;

  // Deposit with the mix, or redeem in kind: the program's own pro-rata amounts.
  const mixQuote = state && raw > 0n && !oneToken && (deposit || output === null) ? quoteShares(state, raw, deposit) : null;

  // One token in: alone through the basket (one transaction), else swapped into the mix (two).
  const singleIn = state && oneToken && raw > 0n ? quoteSingleDeposit(state, source as number, raw) : null;
  const single = singleIn && "plan" in singleIn ? singleIn.plan : null;
  const zapIn = state && oneToken && raw > 0n && !single ? quoteZapIn(state, source as number, raw) : null;
  const inFallback = hasBasket && singleIn && "refused" in singleIn && singleIn.refused.kind !== "TooSmall" ? explainRefusal(singleIn.refused) : null;

  // One token out: the vault pays an issuer token alone (sold for USDC in the same transaction),
  // else everything comes out in kind and is swapped into it.
  const singleOut =
    state && output !== null && raw > 0n
      ? ASSETS[output].kind === "stock"
        ? quoteSingleRedeem(state, raw, output)
        : quoteRedeemTo(state, raw, output)
      : null;
  const outPlan =
    singleOut && "plan" in singleOut
      ? "redeem" in singleOut.plan
        ? { asset: singleOut.plan.redeem.asset, feeBps: singleOut.plan.redeem.feeBps, minAmount: singleOut.plan.minAmount, swaps: singleOut.plan.swaps, out: singleOut.plan.out }
        : { asset: output!, feeBps: singleOut.plan.feeBps, minAmount: minus(singleOut.plan.amount, SLIPPAGE_BPS), swaps: [] as Swap[], out: minus(singleOut.plan.amount, SLIPPAGE_BPS) }
      : null;
  const zapOut = state && output !== null && raw > 0n && !outPlan ? quoteZapOut(state, raw, output) : null;
  const outFallback = hasBasket && singleOut && "refused" in singleOut && singleOut.refused.kind !== "TooSmall" ? explainRefusal(singleOut.refused) : null;

  let problem: string | null = null;
  if (!isAmount(amount)) problem = "Enter a valid amount";
  else if (!state) problem = "Loading the vault…";
  else if (raw === 0n) problem = "Enter an amount";
  else if (deposit && state.depositsPaused) problem = "Deposits are paused";
  else if (oneToken && !single && !zapIn) problem = "Amount too small";
  else if (output !== null && !outPlan && !zapOut) problem = "Amount too small";
  else if (user && oneToken && source === SOL && user.balances[SOL] < raw + SOL_RESERVE) problem = "Keep 0.015 SOL for fees";
  else if (user && oneToken && user.balances[source as number] < raw) problem = `Not enough ${input!.symbol}`;
  else if (user && zapIn?.fromWallet.some((x, k) => x > 0n && user.balances[k] < x + (k === source ? raw : 0n))) {
    const k = zapIn.fromWallet.findIndex((x, i) => x > 0n && user.balances[i] < x);
    problem = `Needs a little ${ASSETS[k].symbol} in the wallet`;
  } else if (user && !oneToken && deposit && mixQuote?.some((x, k) => user.balances[k] < x)) {
    const k = mixQuote.findIndex((x, i) => user.balances[i] < x);
    problem = `Not enough ${ASSETS[k].symbol}`;
  } else if (user && !deposit && user.shares < raw) problem = `Not enough sw${TICKER}`;

  /** Opens only the token accounts a single-token trade touches (the others stay as they are), plus swSPCX. */
  const accountsFor = (needed: number[]) =>
    ensureAccountsIxs(publicKey!, [...ASSETS.map((_, k) => !needed.includes(k) || !!user?.exists[k]), !!user?.exists[ASSETS.length]]);

  function submit() {
    if (!publicKey || !state) return;
    if (deposit && single) {
      // One transaction: the vault takes the token alone, converting it on-chain if it must.
      const ixs = accountsFor([single.input, single.mint]);
      const usesSol = single.input === SOL || single.mint === SOL;
      const wrap = single.input === SOL ? single.amountIn - (user?.wsol ?? 0n) : 0n;
      if (wrap > 0n) ixs.push(...wrapSolIxs(publicKey, wrap));
      if (single.preSwap) ixs.push(poolSwapIx(single.preSwap.pool, publicKey, single.preSwap.aToB, single.preSwap.amountIn, single.preSwap.minOut));
      ixs.push(depositSingleIx(publicKey, single.mint, single.depositAmount, single.minShares, single.convert?.pool));
      if (usesSol) ixs.push(unwrapSolIx(publicKey));
      send("Deposit", ixs, VAULT.lookupTable ?? undefined);
      return;
    }
    if (output !== null && outPlan) {
      const ixs = accountsFor([outPlan.asset, output, ...outPlan.swaps.flatMap((s) => [s.pool.a, s.pool.b])]);
      ixs.push(redeemSingleIx(publicKey, outPlan.asset, raw, outPlan.minAmount), ...swapIxs(publicKey, outPlan.swaps));
      send("Redemption", ixs, VAULT.lookupTable ?? undefined);
      return;
    }
    const ixs: TransactionInstruction[] = ensureAccountsIxs(publicKey, user?.exists);
    if (deposit && oneToken && zapIn) {
      // Two transactions signed together: the swaps, then the deposit. In one they would pass the
      // runtime's limit of 64 instructions and inner calls.
      const wrap = (source === SOL ? raw : 0n) + zapIn.fromWallet[SOL];
      if (SOL >= 0 && wrap > 0n) ixs.push(...wrapSolIxs(publicKey, wrap));
      ixs.push(...swapIxs(publicKey, zapIn.swaps));
      const second = [depositIx(publicKey, zapIn.shares, zapIn.maxAmounts)];
      if (SOL >= 0) second.push(unwrapSolIx(publicKey));
      send("Deposit", [ixs, second], VAULT.lookupTable ?? undefined);
      return;
    } else if (deposit && mixQuote) {
      const max = mixQuote.map((x) => plus(x, SLIPPAGE_BPS));
      // The SOL slice is paid from wSOL: wrap what the wallet does not hold as wSOL yet.
      const wrap = max[SOL] - (user?.wsol ?? 0n);
      if (SOL >= 0 && wrap > 0n) ixs.push(...wrapSolIxs(publicKey, wrap));
      ixs.push(depositIx(publicKey, raw, max));
    } else if (output !== null && zapOut) {
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

  const tokenFigure = (x: bigint, k: number) => `${fromRaw(x, ASSETS[k].decimals, ASSETS[k].kind === "usdc" ? 2 : 6)} ${ASSETS[k].symbol}`;

  /** Why a one-token deposit goes in as another token, in a sentence. */
  function depositNote() {
    if (!input) return "";
    if (single) {
      const into = ASSETS[single.into].symbol;
      const cap = state?.basket?.assets[source as number]?.maxWeightBps ?? 0;
      const band = state?.basket?.params.bandBps ?? 0;
      if (single.redirect === "quote") return `The vault converts ${input.symbol} into ${into}, an issuer token below its target weight, and counts it 1:1 as SpaceX.`;
      if (single.redirect === "cap") return `${input.symbol} is at its ${percent(cap)} cap, so it goes in as ${into}.`;
      if (single.redirect === "depeg") return `${input.symbol} trades outside its ${percent(band)} band, so it goes in as ${into}.`;
      return `${input.symbol} goes in alone, counted 1:1 as SpaceX. The fee depends on how far ${input.symbol} sits from its target weight in the vault.`;
    }
    const route = `${input.symbol} is swapped into each token the vault holds, in the vault's proportions, then deposited.`;
    // The fallback reason is its own sentence; the route follows it without rewriting either.
    return inFallback ? `${inFallback} This deposit takes the longer route: ${route}` : route;
  }

  function redeemNote() {
    if (output === null) return "Your slice of every pool and reserve, in kind. Always open.";
    if (outPlan) {
      const paid = ASSETS[outPlan.asset].symbol;
      const sold = outPlan.asset !== output ? ` The same transaction sells it for ${ASSETS[output].symbol}.` : "";
      return `The vault pays your share of its value in ${paid}, less a fee that is higher when ${paid} sits below its target weight.${sold} In kind stays open whatever happens.`;
    }
    const route = `every pool and reserve pays out your slice, then each token is swapped to ${ASSETS[output].symbol}.`;
    return outFallback ? `${outFallback} This redemption takes the longer route: ${route}` : `In kind first: ${route}`;
  }

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
          <div
            className="tabs tabs--sources"
            role="group"
            aria-labelledby="choice"
            style={{ "--options": deposit ? SOURCES.length : PAYOUTS.length } as CSSProperties}
          >
            {deposit
              ? SOURCES.map((s) => (
                  <button key={String(s.key)} type="button" className="t-label" aria-pressed={source === s.key} onClick={() => pickSource(s.key)}>
                    {s.label}
                  </button>
                ))
              : PAYOUTS.map((p) => (
                  <button key={String(p.key)} type="button" className="t-label" aria-pressed={payout === p.key} onClick={() => setPayout(p.key)}>
                    {p.label}
                  </button>
                ))}
          </div>
        </div>

        {oneToken ? (
          <AmountField
            label={`${input!.issuer ? `${input!.issuer} ` : ""}${input!.symbol} to deposit`}
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
          {oneToken && single ? (
            <>
              <div>
                <dt className="t-body">You receive about</dt>
                <dd className="t-data">{shareFigure(single.shares)}</dd>
              </div>
              <div>
                <dt className="t-body">Goes in as</dt>
                <dd className="t-data">{tokenFigure(single.intoAmount, single.into)}</dd>
              </div>
              <div>
                <dt className="t-body">Vault fee</dt>
                <dd className="t-data">{feeText(single.feeBps)}, kept by the vault</dd>
              </div>
              <div>
                <dt className="t-body">Route</dt>
                <dd className="t-data">
                  {single.preSwap
                    ? `Swap to ${ASSETS[single.mint].symbol}, then the vault converts it (1 transaction)`
                    : single.convert
                      ? `The vault converts it on ${single.convert.pool.label} (1 transaction)`
                      : "Straight into the vault (1 transaction)"}
                </dd>
              </div>
            </>
          ) : oneToken ? (
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
                <dd className="t-data">{zapIn ? `${zapIn.swaps.length} swaps into the vault's mix, then the deposit (2 transactions, one approval)` : "—"}</dd>
              </div>
            </>
          ) : output !== null && outPlan ? (
            <>
              <div>
                <dt className="t-body">You receive at least</dt>
                <dd className="t-data">{tokenFigure(outPlan.out, output)}</dd>
              </div>
              <div>
                <dt className="t-body">Vault fee</dt>
                <dd className="t-data">{feeText(outPlan.feeBps)}, kept by the vault</dd>
              </div>
              <div>
                <dt className="t-body">Route</dt>
                <dd className="t-data">
                  {outPlan.asset === output
                    ? `The vault pays ${ASSETS[output].symbol} alone (1 transaction)`
                    : `The vault pays ${ASSETS[outPlan.asset].symbol}, sold for ${ASSETS[output].symbol} (1 transaction)`}
                </dd>
              </div>
            </>
          ) : output !== null ? (
            <>
              <div>
                <dt className="t-body">You receive at least</dt>
                <dd className="t-data">{zapOut ? tokenFigure(zapOut.out, output) : "—"}</dd>
              </div>
              <div>
                <dt className="t-body">Route</dt>
                <dd className="t-data">{zapOut ? `Redeem in kind, then ${zapOut.swaps.length} swaps to ${ASSETS[output].symbol}` : "—"}</dd>
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
              {oneToken || output !== null ? `${Number(ROUTE_SLIPPAGE_BPS) / 100}%${single || outPlan ? "" : " per swap"}` : `${Number(SLIPPAGE_BPS) / 100}%`}
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
          <span className="t-body muted">{!deposit ? redeemNote() : oneToken ? depositNote() : "Every token goes in at the vault's current mix across its pools and reserves."}</span>{" "}
          <LearnMore
            href={
              !deposit
                ? output !== null
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
