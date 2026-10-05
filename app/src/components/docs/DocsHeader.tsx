"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { SearchEntry } from "@/lib/docs";
import { Button, ButtonLink, Mark } from "../ds";
import { Sheet } from "../Sheet";
import { DocsNav } from "./DocsNav";
import { DocsSearch } from "./DocsSearch";

export function DocsHeader({ index }: { index: SearchEntry[] }) {
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
          <Link href="/docs/overview" className="chip-devnet t-eyebrow">
            Docs
          </Link>
        </span>
        <DocsSearch index={index} />
        <Button variant="ghost" className="docs-menu-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          Menu
        </Button>
        <ButtonLink variant="secondary" href="/app">
          <span className="wallet-label--short">App</span>
          <span className="wallet-label--long">Launch app</span>
        </ButtonLink>
      </div>
      <Sheet dialog={dialog} open={open} onClose={() => setOpen(false)} side labelledBy="docs-menu-title">
        <div className="sheet__head">
          <span id="docs-menu-title" className="t-eyebrow muted">
            Documentation
          </span>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
        <DocsNav onNavigate={() => setOpen(false)} />
      </Sheet>
    </header>
  );
}
