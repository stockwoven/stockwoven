"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchEntry } from "@/lib/docs";
import { Button } from "../ds";
import { Sheet } from "../Sheet";

/** Client-side search over the headings and prose of every docs page. "/" opens it. */
export function DocsSearch({ index }: { index: SearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const inputId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return index
      .map((e) => {
        const title = `${e.page} ${e.heading ?? ""}`.toLowerCase();
        const body = e.text.toLowerCase();
        if (!words.every((w) => title.includes(w) || body.includes(w))) return null;
        return { e, score: words.filter((w) => title.includes(w)).length };
      })
      .filter((r): r is { e: SearchEntry; score: number } => !!r)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((r) => r.e);
  }, [index, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <Button variant="ghost" className="docs-search-trigger" onClick={() => setOpen(true)} aria-keyshortcuts="/">
        Search <span className="t-data muted docs-search-key">/</span>
      </Button>
      <Sheet dialog={dialog} open={open} onClose={close} labelledBy={inputId}>
        <div className="sheet__head">
          <label id={inputId} htmlFor={`${inputId}-input`} className="t-heading-sm">
            Search the docs.
          </label>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        </div>
        <div className="field__box">
          <input
            id={`${inputId}-input`}
            type="search"
            className="t-body"
            placeholder="Deposit, fees, oracle…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <ul className="search-results" aria-live="polite">
          {query && !results.length && <li className="t-body muted">No page mentions “{query}”.</li>}
          {results.map((r) => (
            <li key={`${r.slug}-${r.anchor ?? ""}`}>
              <Link href={`/docs/${r.slug}${r.anchor ? `#${r.anchor}` : ""}`} onClick={close}>
                <span className="t-label">{r.heading ?? r.page}</span>
                <span className="t-data muted">{r.heading ? r.page : "Page"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}
