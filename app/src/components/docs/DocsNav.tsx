"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS } from "@/lib/docs";

export function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="docs-nav">
      <ul>
        {DOCS.map((d) => {
          const href = `/docs/${d.slug}`;
          return (
            <li key={d.slug}>
              <Link href={href} className="t-label" aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}>
                {d.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
