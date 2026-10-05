"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button, ButtonLink, Mark } from "../ds";
import { Sheet } from "../Sheet";

const NAV = [
  { href: "#product", label: "Product" },
  { href: "#partners", label: "Partners" },
  { href: "/docs/overview", label: "Docs" },
];

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <header className="header">
      <div className="wrap header__bar">
        <Link href="/" className="header__brand" aria-label="Stockwoven home">
          <span className="sw-lockup t-heading-sm">
            <Mark color="black" />
            <span className="header__wordmark">Stockwoven</span>
          </span>
        </Link>
        <nav className="header__nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="t-label">
              {n.label}
            </Link>
          ))}
        </nav>
        <Button variant="ghost" className="menu-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          Menu
        </Button>
        <ButtonLink variant="secondary" href="/app">
          Launch app
        </ButtonLink>
      </div>
      <Sheet dialog={dialog} open={open} onClose={() => setOpen(false)} side labelledBy="landing-menu-title">
        <div className="sheet__head">
          <span id="landing-menu-title" className="t-eyebrow muted">
            Stockwoven
          </span>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
        <nav className="sheet__nav" aria-labelledby="landing-menu-title">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="t-heading-sm" onClick={() => setOpen(false)}>
              {n.label}
            </Link>
          ))}
        </nav>
        <ButtonLink href="/app" block>
          Launch app
        </ButtonLink>
      </Sheet>
    </header>
  );
}
