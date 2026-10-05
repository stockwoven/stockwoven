"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { shortAddress } from "@/lib/stockwoven";
import { useMounted } from "@/lib/useMounted";
import { Button } from "./ds";
import { useWalletPicker } from "./WalletPicker";

export function WalletButton() {
  const { publicKey, connecting, disconnect } = useWallet();
  const picker = useWalletPicker();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useMounted();

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    const onClick = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menu]);

  if (!publicKey) {
    return (
      <Button variant="secondary" onClick={picker.open} aria-busy={mounted && connecting}>
        {mounted && connecting ? (
          "Connecting…"
        ) : (
          <>
            <span className="wallet-label--short">Connect</span>
            <span className="wallet-label--long">Connect wallet</span>
          </>
        )}
      </Button>
    );
  }

  const address = publicKey.toBase58();
  return (
    <div className="wallet" ref={root}>
      <Button variant="ghost" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)}>
        <span className="t-data">{shortAddress(address)}</span>
      </Button>
      {menu && (
        <div className="wallet__menu" role="menu" aria-label="Wallet">
          <p className="t-data muted">{address}</p>
          <button
            type="button"
            role="menuitem"
            className="menu-item t-label"
            onClick={async () => {
              await navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item t-label"
            onClick={() => {
              setMenu(false);
              picker.open();
            }}
          >
            Change wallet
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item t-label"
            onClick={() => {
              setMenu(false);
              disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
