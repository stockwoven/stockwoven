"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { SHARE_DECIMALS, VAULT, ata, explorer, fromRaw, navPerShare } from "@/lib/stockwoven";
import { Button, Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { useWalletPicker } from "../WalletPicker";
import { useVault } from "./VaultData";

export function HoldPanel() {
  const { data } = useVault();
  const { publicKey } = useWallet();
  const picker = useWalletPicker();
  const user = data?.user;
  const nav = data ? navPerShare(data.pool, data.shareSupply) : 0;
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
            Connect a wallet to see your <Ticker ticker="INTC" />.
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
              {user ? fromRaw(user.shares, SHARE_DECIMALS, 6) : <span className="skeleton" style={{ width: "6ch" }} />}{" "}
              <Ticker ticker="INTC" />
            </span>
            <span className="t-data muted">{user ? `Backed by ${(shares * nav).toFixed(6)} INTC` : " "}</span>
          </div>
          <dl className="kv">
            {[
              ["mINTCx", "xStocks, mock", user && `${fromRaw(user.a, VAULT.decimalsA)} mINTCx`],
              ["mINTC", "Backpack, mock", user && `${fromRaw(user.b, VAULT.decimalsB)} mINTC`],
              ["USDC", "test token", user && `${fromRaw(user.usdc, 6, 2)} USDC`],
              ["SOL", "fees and deposits", user && `${user.sol.toFixed(3)} SOL`],
            ].map(([name, note, value]) => (
              <div key={name}>
                <dt className="t-body">
                  {name} <span className="muted">· {note}</span>
                </dt>
                <dd>{value ? <span className="t-data">{value}</span> : <span className="skeleton" style={{ width: "7ch" }} />}</dd>
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
              <span className="t-body muted">Value read from the pool account.</span> <LearnMore href="/docs/hold#how-swintc-is-valued" />
            </p>
          )}
        </>
      )}
    </section>
  );
}
