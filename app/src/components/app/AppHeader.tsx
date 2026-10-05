"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { Button, Mark } from "../ds";
import { Sheet } from "../Sheet";
import { WalletButton } from "../WalletButton";

export const TABS = [
  { href: "/app", label: "Vaults" },
  { href: "/app/portfolio", label: "Portfolio" },
  { href: "/app/convert", label: "Convert" },
  { href: "/app/devnet", label: "Devnet" },
];

export function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <header className="header">
      <div className="wrap wrap--wide header__bar">
        <span className="header__brand">
          <Link href="/" className="sw-lockup t-heading-sm" aria-label="Stockwoven home">
            <Mark color="black" />
            <span className="header__wordmark">Stockwoven</span>
          </Link>
          <span className="chip-devnet t-eyebrow">Devnet</span>
        </span>
        <nav className="header__nav" aria-label="App">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className="t-label" aria-current={pathname === t.href ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
          <Link href="/docs/overview" className="t-label">
            Docs ↗
          </Link>
        </nav>
        <Button variant="ghost" className="menu-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          Menu
        </Button>
        <WalletButton />
      </div>

      <Sheet dialog={dialog} open={open} onClose={() => setOpen(false)} side labelledBy="app-menu-title">
        <div className="sheet__head">
          <span id="app-menu-title" className="t-eyebrow muted">
            Stockwoven app
          </span>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
        <nav className="sheet__nav" aria-labelledby="app-menu-title">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="t-heading-sm"
              aria-current={pathname === t.href ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {t.label}
            </Link>
          ))}
          <Link href="/docs/overview" className="t-heading-sm" onClick={() => setOpen(false)}>
            Docs ↗
          </Link>
        </nav>
        <p className="t-body muted">Solana devnet. Test tokens only.</p>
      </Sheet>
    </header>
  );
}
