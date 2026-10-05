import { ReactNode } from "react";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { DocsNav } from "@/components/docs/DocsNav";
import { Toc } from "@/components/docs/Toc";
import { searchIndex } from "@/lib/docs-index";
import "./docs.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link sw-btn sw-btn--secondary">
        Skip to content
      </a>
      <DocsHeader index={searchIndex()} />
      <div className="wrap wrap--wide docs-shell">
        <aside className="docs-sidebar">
          <DocsNav />
        </aside>
        <main id="main" className="docs-main">
          {children}
        </main>
        <aside className="docs-aside">
          <Toc />
        </aside>
      </div>
    </>
  );
}
