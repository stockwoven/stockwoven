"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** "On this page": the current article's h2s, with the one in view marked. */
export function Toc() {
  const pathname = usePathname();
  const [items, setItems] = useState<{ id: string; text: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const headings = [...document.querySelectorAll<HTMLElement>(".doc-article h2[id]")];
    setItems(headings.map((h) => ({ id: h.id, text: h.textContent ?? "" })));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [pathname]);

  if (!items.length) return null;
  return (
    <nav className="docs-toc" aria-labelledby="toc-title">
      <p id="toc-title" className="t-eyebrow muted">
        On this page
      </p>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className="t-body" aria-current={active === i.id ? "location" : undefined}>
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
