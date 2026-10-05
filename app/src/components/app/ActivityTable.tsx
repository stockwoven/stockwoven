"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Activity } from "@/lib/hooks";
import { explorer, shortAddress, signed } from "@/lib/stockwoven";
import Link from "next/link";
import { Button, WithTickers } from "../ds";
import { LearnMore } from "../LearnMore";
import { useWalletPicker } from "../WalletPicker";

const when = (d: Date | null) =>
  d ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function ActivityTable({
  items,
  error,
  loading,
  reload,
}: {
  items: Activity[] | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}) {
  const { publicKey } = useWallet();
  const picker = useWalletPicker();

  return (
    <section className="tile" aria-labelledby="activity-title">
      <div className="tile__head">
        <h2 id="activity-title" className="t-heading-sm">
          Activity.
        </h2>
        {publicKey && !error && items?.length !== 0 && (
          <span className="tile__tools">
            <span className="t-data muted" aria-live="polite">
              {loading || !items ? "Loading…" : `Last ${items.length}`}
            </span>
            <Button variant="ghost" onClick={reload} disabled={loading}>
              Refresh
            </Button>
          </span>
        )}
      </div>
      <div>
          {!publicKey ? (
            <div className="empty">
              <p className="t-body body">Connect a wallet to see its vault transactions.</p>
              <Button variant="secondary" onClick={picker.open}>
                Connect wallet
              </Button>
            </div>
          ) : error ? (
            <div className="banner" role="alert" style={{ marginTop: 0 }}>
              <div>
                <p className="t-label">Could not load this wallet&apos;s activity.</p>
                <p className="t-data">{error}</p>
              </div>
              <Button variant="ghost" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : items && items.length === 0 ? (
            <div className="empty">
              <p className="t-body body">No vault activity from this wallet yet.</p>
              <div className="actions">
                <Link className="sw-btn sw-btn--secondary" href="/app/devnet">
                  Get test tokens
                </Link>
                <LearnMore href="/docs/deposit" />
              </div>
            </div>
          ) : (
            <>
              <table className="table">
                <caption className="sr-only">Recent vault activity for {shortAddress(publicKey)}</caption>
                <thead>
                  <tr className="t-eyebrow">
                    <th scope="col">Action</th>
                    <th scope="col">Change</th>
                    <th scope="col">Time</th>
                    <th scope="col" className="num">
                      Transaction
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {!items
                    ? [0, 1, 2].map((i) => (
                        <tr key={i} aria-hidden="true">
                          {[10, 18, 10, 8].map((w, j) => (
                            <td key={j}>
                              <span className="skeleton" style={{ width: `${w}ch` }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    : items.map((item) => (
                        <tr key={item.signature}>
                          <td>
                            <span className="td-label t-eyebrow">Action</span>
                            <span className="t-label">
                              {item.kind}
                              {item.failed && <span className="t-eyebrow muted"> · Failed</span>}
                            </span>
                          </td>
                          <td>
                            <span className="td-label t-eyebrow">Change</span>
                            <span className="amounts" style={{ alignItems: "inherit" }}>
                              {item.changes.length ? (
                                item.changes.map((c) => (
                                  <span key={c.symbol} className="t-data nowrap">
                                    {signed(c.amount)} <WithTickers>{c.symbol}</WithTickers>
                                  </span>
                                ))
                              ) : (
                                <span className="t-data muted">No balance change</span>
                              )}
                            </span>
                          </td>
                          <td>
                            <span className="td-label t-eyebrow">Time</span>
                            <span className="t-data">{when(item.time)}</span>
                          </td>
                          <td className="num">
                            <span className="td-label t-eyebrow">Transaction</span>
                            <a className="t-data" href={explorer(item.signature, "tx")} target="_blank" rel="noreferrer">
                              {shortAddress(item.signature)}
                              <span className="sr-only"> on Explorer</span>
                            </a>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </>
          )}
      </div>
    </section>
  );
}
