"use client";

import { ReactNode, createContext, useContext, useRef, useState } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMounted } from "@/lib/useMounted";
import { Button } from "./ds";
import { Sheet } from "./Sheet";

const PickerContext = createContext<{ open: () => void }>({ open: () => {} });

export const useWalletPicker = () => useContext(PickerContext);

/** Lists the Wallet Standard wallets the browser exposes. Selecting one connects it (autoConnect). */
export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const { wallets, select } = useWallet();
  const [isOpen, setOpen] = useState(false);
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
        {available.length ? (
          <ul className="wallet-list">
            {available.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  className="wallet-option t-label"
                  onClick={() => {
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
