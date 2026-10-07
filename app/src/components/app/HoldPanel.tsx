"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ASSETS, SHARE_DECIMALS, VAULT, ata, explorer, fromRaw, prices, usd, vaultValue, whole } from "@/lib/stockwoven";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

const TICKER = VAULT.stock;

export function HoldPanel() {
  const { data } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const user = data?.user;
  const state = data?.state;
  const perShare = state ? vaultValue(state).perShare : 0;
  const px = state ? prices(state) : null;
  const shares = user ? Number(user.shares) / 10 ** SHARE_DECIMALS : 0;

  return (
    <section className="tile" aria-labelledby="hold-title">
      <div className="tile__head">
        <h2 id="hold-title" className="t-heading-sm">
          Position.
        </h2>
        {publicKey && (
          <a className="t-data muted" href={explorer(ata(publicKey, VAULT.shareMint))} target="_blank" rel="noreferrer">
            On Explorer ↗
          </a>
        )}
      </div>

      {!publicKey ? (
        <div className="empty">
          <p className="t-body body">
            Connect a wallet to see your <Ticker ticker={TICKER} />.
          </p>
          <Button variant="secondary" onClick={picker.open}>
            Connect wallet
          </Button>
        </div>
      ) : (
        <>
          <div className="balance">
            <span className="t-eyebrow muted">Balance</span>
            <span className="t-data-lg">
              {user ? fromRaw(user.shares, SHARE_DECIMALS, 6) : <span className="skeleton" style={{ width: "6ch" }} />} <Ticker ticker={TICKER} />
            </span>
            <span className="t-data muted">{user && state ? `Worth ${usd(shares * perShare)} at ${usd(perShare)} each` : " "}</span>
          </div>
          <dl className="kv">
            {ASSETS.map((a, k) => (
              <div key={a.symbol}>
                <dt className="t-body">
                  {a.symbol} <span className="muted">· {a.issuer ? `${a.issuer}, mock` : a.kind === "sol" ? "fees and deposits" : "test token"}</span>
                </dt>
                <dd>
                  {user ? (
                    <span className="t-data">
                      {fromRaw(user.balances[k], a.decimals, a.kind === "usdc" ? 2 : 4)} {a.symbol}
                      {px && px[k] > 0 && <span className="muted"> · {usd(whole(user.balances[k], k) * px[k])}</span>}
                    </span>
                  ) : (
                    <span className="skeleton" style={{ width: "7ch" }} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {user && user.shares === 0n ? (
            <div className="actions">
              <Link href="/app#vault-panel" className="sw-btn sw-btn--secondary">
                Deposit
              </Link>
              <Link href="/app/devnet" className="sw-btn sw-btn--ghost">
                Get test tokens
              </Link>
              <LearnMore href="/docs/deposit" />
            </div>
          ) : (
            <p className="microcopy">
              <span className="t-body muted">Value read from the vault&apos;s pools and reserves.</span>{" "}
              <LearnMore href="/docs/hold#how-swspcx-is-valued" />
            </p>
          )}
        </>
      )}
    </section>
  );
}
