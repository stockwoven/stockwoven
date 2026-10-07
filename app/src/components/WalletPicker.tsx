"use client";

import { ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMounted } from "@/lib/useMounted";
import { Button } from "./ds";
import { Sheet } from "./Sheet";

const PickerContext = createContext<{ open: () => void }>({ open: () => {} });

/** How long a wallet may stay "connecting" before the app gives up and lets the person try again. */
const CONNECT_TIMEOUT_MS = 15_000;

export const useWalletPicker = () => useContext(PickerContext);

/** Lists the Wallet Standard wallets the browser exposes. Selecting one connects it (autoConnect). */
export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const { wallets, select, wallet, connecting, disconnect } = useWallet();
  const [isOpen, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A wallet that never answers (its popup was closed or blocked, the extension is locked, or the
  // page is not on https or localhost) would leave the app connecting forever. After the timeout,
  // drop the attempt and forget the choice, so the next page load does not retry it either.
  useEffect(() => {
    if (!connecting) return;
    const name = wallet?.adapter.name ?? "The wallet";
    const timer = setTimeout(() => {
      disconnect().catch(() => {});
      select(null);
      setNotice(
        `${name} did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds. Unlock it, check that no popup is waiting, and try again. ` +
          (typeof window !== "undefined" && !window.isSecureContext
            ? "This page is not on https or localhost, and some wallets refuse to connect there: open the app at its https address or on this computer's localhost."
            : "If it keeps happening, reload the page."),
      );
      setOpen(true);
    }, CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [connecting, wallet, disconnect, select]);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useMounted();
  const available = (mounted ? wallets : []).filter(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  return (
    <PickerContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      <Sheet dialog={dialog} open={isOpen} onClose={() => setOpen(false)} labelledBy="wallet-picker-title">
        <div className="sheet__head">
          <h2 id="wallet-picker-title" className="t-heading-sm">
            Connect a wallet.
          </h2>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
        {notice && (
          <p className="t-body body" role="alert">
            {notice}
          </p>
        )}
        {available.length ? (
          <ul className="wallet-list">
            {available.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  className="wallet-option t-label"
                  onClick={() => {
                    setNotice(null);
                    select(w.adapter.name);
                    setOpen(false);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={w.adapter.icon} alt="" />
                  {w.adapter.name}
                  <span className="t-data muted">
                    {w.readyState === WalletReadyState.Installed ? "Detected" : "Available"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-body body">
            No Solana wallet was found in this browser. Install{" "}
            <a href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a>,{" "}
            <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> or{" "}
            <a href="https://backpack.app" target="_blank" rel="noreferrer">Backpack</a>, switch it to devnet, then reload
            this page.
          </p>
        )}
        <p className="t-data muted">This app runs on Solana devnet. Nothing here uses real funds.</p>
      </Sheet>
    </PickerContext.Provider>
  );
}
